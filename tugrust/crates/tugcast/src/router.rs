//! Feed router and WebSocket handler
//!
//! Implements the per-client BOOTSTRAP/LIVE state machine for WebSocket connections.
//! Each client gets snapshot data on connect, then transitions to live streaming.
//!
//! Lag recovery varies by feed:
//! - `LagPolicy::Bootstrap` — re-enter BOOTSTRAP state (terminal: `capture_pane`)
//! - `LagPolicy::Replay` — replay from a shared ring buffer (code output)
//! - `LagPolicy::Warn` — log warning, continue (non-critical feeds)
//!
//! Input dispatch enforces single-writer-per-FeedId: the first client to send
//! on an input FeedId claims it; subsequent clients receive an error frame.

use std::collections::{HashMap, HashSet};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures::Stream;
use tokio::sync::{broadcast, mpsc, watch};
use tokio::time;
use tokio_stream::StreamMap;
use tokio_stream::wrappers::BroadcastStream;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

use tugcast_core::{
    CLOSE_BAD_HANDSHAKE, CLOSE_HANDSHAKE_TIMEOUT, CLOSE_VERSION_MISMATCH, FeedId, Frame,
    HANDSHAKE_TIMEOUT, PROTOCOL_NAME, PROTOCOL_VERSION, TugSessionId,
};

use crate::auth::{self, SharedAuthState};
use crate::feeds::agent_supervisor::{AgentSupervisor, ControlError, ControlOutcome};
use crate::feeds::code::parse_tug_session_id;
use crate::feeds::terminal;

/// Broadcast channel capacity for stream feeds (re-exported so existing
/// `crate::router::BROADCAST_CAPACITY` callers keep working — the constant
/// itself lives with the feed traits in tugcast-core).
pub use tugcast_core::DEFAULT_BROADCAST_CAPACITY as BROADCAST_CAPACITY;
/// Lag policy + replay buffer live in tugcast-core so the `StreamFeed` trait
/// can self-describe its recovery behavior; re-exported here for the
/// router-side callers that consume them.
pub use tugcast_core::{LagPolicy, ReplayBuffer};

/// Heartbeat interval (send heartbeat every 15 seconds)
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

/// How long a client may go without sending us *anything* before we
/// treat the wire as dead and close it.
///
/// Two properties of this timeout are easy to get wrong:
///
/// 1. **Any inbound frame refreshes liveness, not just `HEARTBEAT`.** A
///    client actively sending CONTROL and CODE_INPUT is provably alive;
///    closing it because one specific frame type stopped arriving was
///    indefensible. The refresh happens as soon as a frame decodes,
///    ahead of the feed-id dispatch.
/// 2. **The check runs only on the `HEARTBEAT_INTERVAL` tick**, so the
///    effective window is 180–195 s, not a precise 180 s. Do not read
///    this constant as a sharp deadline.
///
/// The window is wide because the client is a WKWebView whose timers
/// stop entirely when the machine sleeps: a quiet, perfectly healthy
/// page must not be hung up on. Twelve missed heartbeats is still
/// unambiguous evidence of a dead wire.
///
/// This is *not* paired with the deck's `HEARTBEAT_TIMEOUT_MS`. That
/// one measures server→client silence; this one measures
/// client→server silence. They are independent.
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(180);

/// When a client last proved it was alive.
///
/// Split out of `handle_client`'s select loop so the liveness rule is
/// one named thing that can be driven directly, rather than a pair of
/// statements 140 lines apart. `now` is a parameter rather than an
/// internal `Instant::now()` so the rule can be exercised across a
/// window measured in minutes without spending them.
struct ClientLiveness {
    last_frame: Instant,
}

impl ClientLiveness {
    fn new(now: Instant) -> Self {
        Self { last_frame: now }
    }

    /// Record proof of life. Every decoded inbound frame qualifies —
    /// the frame's feed id is deliberately not consulted.
    fn record_frame(&mut self, now: Instant) {
        self.last_frame = now;
    }

    /// Whether the client has been silent long enough to be presumed
    /// dead. Only ever consulted on the `HEARTBEAT_INTERVAL` tick, so
    /// the window this implements is 180–195 s in practice.
    fn is_stale(&self, now: Instant) -> bool {
        now.duration_since(self.last_frame) > HEARTBEAT_TIMEOUT
    }
}

// ---------------------------------------------------------------------------
// InputOwnership — single-writer-per-(FeedId, tug_session_id) enforcement (P5)
// ---------------------------------------------------------------------------

/// Shared map tracking which client (by ID) owns each `(FeedId,
/// Option<TugSessionId>)` key. Non-session-scoped inputs (TERMINAL_INPUT,
/// FILETREE_QUERY, ...) use `None`; CODE_INPUT uses `Some(tug_session_id)`
/// so distinct sessions can coexist under multiple writers, one per session.
/// A non-zero value is the owning client's ID. Per [D08].
type InputOwnership = Arc<Mutex<HashMap<(FeedId, Option<TugSessionId>), u64>>>;

// ---------------------------------------------------------------------------
// Per-client state machine
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum ClientState {
    /// Client is receiving bootstrap data for the feed that lagged.
    Bootstrap { feed_id: FeedId, buffer: Vec<Frame> },
    /// Client is receiving live output directly.
    Live,
}

// ---------------------------------------------------------------------------
// FeedRouter
// ---------------------------------------------------------------------------

/// Feed router for managing WebSocket connections.
///
/// Constructed in `main.rs` via `new()` + `register_stream()` / `register_input()`
/// / `add_snapshot_watches()`. Passed to axum as shared state.
#[derive(Clone)]
pub struct FeedRouter {
    /// FeedId → (broadcast::Sender, LagPolicy) for stream feeds (server → client).
    pub(crate) stream_outputs: HashMap<FeedId, (broadcast::Sender<Frame>, LagPolicy)>,
    /// FeedId → mpsc::Sender for input feeds (client → server).
    input_sinks: HashMap<FeedId, mpsc::Sender<Frame>>,
    /// Snapshot watch receivers (delivered to every client on connect).
    snapshot_watches: Vec<watch::Receiver<Frame>>,
    /// Multi-producer broadcast senders. Each client clones the FeedRouter
    /// and at `ClientState::Live` calls `subscribe()` on every entry here
    /// to get its own receiver, then spawns a forwarder that `recv()`s
    /// frames and pushes them to the socket. Unlike `snapshot_watches`
    /// (which carry "latest value" with collision risk under concurrent
    /// producers), this list holds event streams safe to fan in from
    /// many producers. Used by the FILETREE multi-workspace response
    /// path per `dash/dev-atoms.md#step-pre-4`.
    snapshot_broadcast_senders: Vec<broadcast::Sender<Frame>>,

    /// Tracks which client owns each `(input FeedId, tug_session_id?)` key
    /// (P5 single-writer guard, relaxed per [D08]).
    input_ownership: InputOwnership,
    /// Counter for assigning unique client IDs.
    client_id_counter: Arc<AtomicU64>,

    /// Multi-session supervisor. `None` until Step 8 wires it in `main.rs`.
    /// When present, the router cross-checks CODE_INPUT frames against
    /// `supervisor.client_sessions[client_id]` before admitting them — a
    /// client can only send CODE_INPUT for a `tug_session_id` it has
    /// registered via `spawn_session`.
    pub(crate) supervisor: Option<Arc<AgentSupervisor>>,

    session: String,
    auth: SharedAuthState,
    pub(crate) shutdown_tx: mpsc::Sender<u8>,
    pub(crate) dev_state: crate::dev::SharedDevState,
    /// Pending eval requests awaiting browser responses.
    pub(crate) pending_evals: PendingEvals,
    /// Pending ask requests awaiting a human answer in the deck.
    pub(crate) pending_asks: PendingAsks,
    /// The Haiku `SharedAgent`, once `main` has built one.
    pub(crate) shared_agent: crate::shared_agent::SharedAgentHandle,
    /// The wheel's pending-rotation and hand-back registries, once `main`
    /// has built them. `POST /api/session` parks into these; the drain task
    /// spawned beside the arc engine empties them on the turn-end tick.
    pub(crate) wheel: Option<Arc<crate::wheel::WheelState>>,
}

/// Pending eval requests awaiting responses from the browser.
pub(crate) type PendingEvals =
    Arc<std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>>>;

/// Pending ask requests awaiting a human answer in the deck.
///
/// Same shape as [`PendingEvals`], but the waits are long: an eval resolves in
/// milliseconds, an ask sits until someone reads a dialog and clicks. The two
/// maps are kept separate so a slow human can never occupy a slot that
/// diagnostics tooling expects to turn over quickly.
pub(crate) type PendingAsks =
    Arc<std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<String>>>>;

impl FeedRouter {
    /// Create a new feed router with shared infrastructure channels.
    pub(crate) fn new(
        session: String,
        auth: SharedAuthState,
        shutdown_tx: mpsc::Sender<u8>,
        dev_state: crate::dev::SharedDevState,
    ) -> Self {
        Self {
            stream_outputs: HashMap::new(),
            input_sinks: HashMap::new(),
            snapshot_watches: Vec::new(),
            snapshot_broadcast_senders: Vec::new(),
            input_ownership: Arc::new(Mutex::new(HashMap::new())),
            client_id_counter: Arc::new(AtomicU64::new(1)),
            supervisor: None,
            session,
            auth,
            shutdown_tx,
            dev_state,
            pending_evals: Arc::new(std::sync::Mutex::new(HashMap::new())),
            pending_asks: Arc::new(std::sync::Mutex::new(HashMap::new())),
            shared_agent: None,
            wheel: None,
        }
    }

    /// Borrow the router state `dispatch_action` needs.
    pub(crate) fn action_context(&self) -> crate::actions::ActionContext<'_> {
        crate::actions::ActionContext {
            shutdown_tx: &self.shutdown_tx,
            stream_outputs: &self.stream_outputs,
            dev_state: &self.dev_state,
            pending_evals: &self.pending_evals,
            pending_asks: &self.pending_asks,
            shared_agent: &self.shared_agent,
        }
    }

    /// Register a stream output (broadcast feed, server → client).
    pub(crate) fn register_stream(
        &mut self,
        feed_id: FeedId,
        tx: broadcast::Sender<Frame>,
        lag_policy: LagPolicy,
    ) {
        self.stream_outputs.insert(feed_id, (tx, lag_policy));
    }

    /// Register **and spawn** a stream feed — the trait-mediated path.
    ///
    /// The feed self-describes its registration: the router creates the
    /// broadcast channel at the feed's declared capacity, records the feed's
    /// own lag policy, and spawns `run` with the channel's sender. Returns a
    /// sender clone for producers that also publish onto the feed's channel
    /// from outside the feed task (most callers ignore it).
    pub(crate) fn register_stream_feed(
        &mut self,
        feed: Box<dyn tugcast_core::StreamFeed>,
        cancel: CancellationToken,
    ) -> broadcast::Sender<Frame> {
        let (tx, _) = broadcast::channel(feed.channel_capacity());
        self.stream_outputs
            .insert(feed.feed_id(), (tx.clone(), feed.lag_policy()));
        let run_tx = tx.clone();
        tokio::spawn(async move { feed.run(run_tx, cancel).await });
        tx
    }

    /// Register a session-scoped stream feed: the feed's own channel and
    /// lag policy enter client delivery; producers publish through their
    /// `SessionScopedFeed` clones (splice-on-emit lives there, not here).
    pub(crate) fn register_session_feed(
        &mut self,
        feed: &crate::feeds::session_scoped::SessionScopedFeed,
    ) {
        self.stream_outputs
            .insert(feed.feed_id(), (feed.sender(), feed.lag_policy()));
    }

    /// Register an input sink (client → server backend).
    pub(crate) fn register_input(&mut self, feed_id: FeedId, tx: mpsc::Sender<Frame>) {
        self.input_sinks.insert(feed_id, tx);
    }

    /// Attach the multi-session supervisor. Called from `main.rs` after the
    /// supervisor is constructed. Once set, `handle_client` routes session
    /// lifecycle CONTROL frames through `AgentSupervisor::handle_control`
    /// and enforces the P5 authorization cross-check on CODE_INPUT.
    pub(crate) fn set_supervisor(&mut self, supervisor: Arc<AgentSupervisor>) {
        self.supervisor = Some(supervisor);
    }

    /// Add snapshot watches (delivered on connect + forwarded on change).
    pub(crate) fn add_snapshot_watches(&mut self, watches: Vec<watch::Receiver<Frame>>) {
        self.snapshot_watches.extend(watches);
    }

    /// Add multi-producer broadcast senders. Each connected client
    /// subscribes a fresh receiver from every sender in this list and
    /// spawns a forwarder task at `ClientState::Live`. Unlike
    /// `add_snapshot_watches` there is no "deliver on connect" pass —
    /// broadcast streams are event-only (no retained latest value), so
    /// clients only see frames published *after* their forwarder
    /// subscribes. Used for the FILETREE multi-workspace response fan-in.
    pub(crate) fn add_broadcast_senders(&mut self, senders: Vec<broadcast::Sender<Frame>>) {
        self.snapshot_broadcast_senders.extend(senders);
    }

    /// Assign a unique client ID.
    fn next_client_id(&self) -> u64 {
        self.client_id_counter.fetch_add(1, Ordering::Relaxed)
    }
}

/// WebSocket upgrade handler
///
/// Validates session and origin before upgrading the connection.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(router): State<FeedRouter>,
) -> Response {
    if !auth::validate_request_session(&headers, &router.auth) {
        debug!("WebSocket upgrade rejected: invalid session");
        return (StatusCode::FORBIDDEN, "Invalid or expired session").into_response();
    }
    if !auth::check_request_origin(&headers, &router.auth) {
        debug!("WebSocket upgrade rejected: invalid origin");
        return (StatusCode::FORBIDDEN, "Invalid origin").into_response();
    }
    info!("WebSocket upgrade accepted");
    ws.on_upgrade(move |socket| handle_client(socket, router))
}

// ---------------------------------------------------------------------------
// Protocol handshake
// ---------------------------------------------------------------------------

/// The host's macOS product version (e.g. `"15.7.7"`), read once from the
/// kernel via `sysctl kern.osproductversion` — no subprocess. Returns an empty
/// string if the read fails (e.g. a non-macOS host); the frontend treats an
/// empty/absent version as "unknown" and never blocks on it ([P06], Spec S03).
#[cfg(target_os = "macos")]
fn host_os_version() -> String {
    let name = match std::ffi::CString::new("kern.osproductversion") {
        Ok(n) => n,
        Err(_) => return String::new(),
    };
    let mut size: libc::size_t = 0;
    // SAFETY: standard two-call sysctlbyname idiom — first call sizes the
    // buffer, second fills it. All pointers are valid for the lengths passed.
    unsafe {
        if libc::sysctlbyname(
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        ) != 0
            || size == 0
        {
            return String::new();
        }
        let mut buf = vec![0u8; size];
        if libc::sysctlbyname(
            name.as_ptr(),
            buf.as_mut_ptr() as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        ) != 0
        {
            return String::new();
        }
        // `size` now reflects the bytes written, including the trailing NUL.
        buf.truncate(size);
        if buf.last() == Some(&0) {
            buf.pop();
        }
        String::from_utf8_lossy(&buf).into_owned()
    }
}

/// Non-macOS fallback: there is no `kern.osproductversion` to read, so the
/// version is "unknown". The frontend treats an empty version as such and never
/// blocks on it ([P06], Spec S03).
#[cfg(not(target_os = "macos"))]
fn host_os_version() -> String {
    String::new()
}

/// Build the handshake response sent to the client at connection open. Carries
/// the protocol identity plus an additive `host` object (`{os, version}`) so
/// the frontend can gate on the macOS version from the drop, before any card
/// ([P06], Spec S03). Additive and back-compatible: older clients ignore it.
fn build_handshake_response() -> serde_json::Value {
    serde_json::json!({
        "protocol": PROTOCOL_NAME,
        "version": PROTOCOL_VERSION,
        "capabilities": [],
        "host": { "os": "macos", "version": host_os_version() },
    })
}

/// Perform the protocol handshake at WebSocket connection open.
async fn perform_handshake(socket: &mut WebSocket) -> bool {
    let hello = tokio::time::timeout(HANDSHAKE_TIMEOUT, socket.recv()).await;

    let hello_text = match hello {
        Ok(Some(Ok(Message::Text(text)))) => text,
        Ok(Some(Ok(_))) => {
            warn!("Handshake failed: expected text frame, got binary/other");
            let _ = socket
                .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code: CLOSE_BAD_HANDSHAKE,
                    reason: "expected text handshake frame".into(),
                })))
                .await;
            return false;
        }
        Ok(Some(Err(e))) => {
            warn!("Handshake failed: WebSocket error: {}", e);
            return false;
        }
        Ok(None) => {
            info!("Client disconnected before handshake");
            return false;
        }
        Err(_) => {
            warn!("Handshake timed out");
            let _ = socket
                .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code: CLOSE_HANDSHAKE_TIMEOUT,
                    reason: "handshake timeout".into(),
                })))
                .await;
            return false;
        }
    };

    let hello_json: serde_json::Value = match serde_json::from_str(&hello_text) {
        Ok(v) => v,
        Err(_) => {
            warn!("Handshake failed: invalid JSON: {}", hello_text);
            let _ = socket
                .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code: CLOSE_BAD_HANDSHAKE,
                    reason: "invalid handshake JSON".into(),
                })))
                .await;
            return false;
        }
    };

    let protocol = hello_json
        .get("protocol")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if protocol != PROTOCOL_NAME {
        warn!("Handshake failed: unknown protocol '{}'", protocol);
        let _ = socket
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: CLOSE_BAD_HANDSHAKE,
                reason: format!("unknown protocol: {protocol}").into(),
            })))
            .await;
        return false;
    }

    let version = hello_json
        .get("version")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    if version != PROTOCOL_VERSION {
        warn!(
            "Handshake failed: version mismatch (client={}, server={})",
            version, PROTOCOL_VERSION
        );
        let _ = socket
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: CLOSE_VERSION_MISMATCH,
                reason: format!(
                    "version mismatch: server={}, client={}",
                    PROTOCOL_VERSION, version
                )
                .into(),
            })))
            .await;
        return false;
    }

    let response = build_handshake_response();
    if socket
        .send(Message::Text(response.to_string().into()))
        .await
        .is_err()
    {
        info!("Client disconnected during handshake response");
        return false;
    }

    info!("Protocol handshake complete (v{})", PROTOCOL_VERSION);
    true
}

// ---------------------------------------------------------------------------
// StreamMap helpers
// ---------------------------------------------------------------------------

type PinnedBroadcastStream = Pin<
    Box<
        dyn Stream<Item = Result<Frame, tokio_stream::wrappers::errors::BroadcastStreamRecvError>>
            + Send,
    >,
>;

fn build_stream_map(
    stream_outputs: &HashMap<FeedId, (broadcast::Sender<Frame>, LagPolicy)>,
) -> (
    StreamMap<FeedId, PinnedBroadcastStream>,
    HashMap<FeedId, LagPolicy>,
) {
    let mut map = StreamMap::new();
    let mut policies = HashMap::new();
    for (&feed_id, (tx, policy)) in stream_outputs {
        let rx = tx.subscribe();
        let stream: PinnedBroadcastStream = Box::pin(BroadcastStream::new(rx));
        map.insert(feed_id, stream);
        policies.insert(feed_id, policy.clone());
    }
    (map, policies)
}

// ---------------------------------------------------------------------------
// Helpers: send control frames to client
// ---------------------------------------------------------------------------

/// Send a JSON control frame (flags=CONTROL) to the client.
/// Returns false if the client disconnected.
async fn send_control_json(
    socket: &mut WebSocket,
    feed_id: FeedId,
    json: &serde_json::Value,
) -> bool {
    let payload = serde_json::to_vec(json).unwrap_or_default();
    let frame = Frame::control(feed_id, payload);
    socket
        .send(Message::Binary(frame.encode().into()))
        .await
        .is_ok()
}

// ---------------------------------------------------------------------------
// Input ownership helpers (P5)
// ---------------------------------------------------------------------------

/// Try to claim an input `(FeedId, tug_session_id?)` key for the given
/// client. Returns `Ok(())` if the client owns it (or just claimed it),
/// or `Err(owner_id)` if another client owns it.
///
/// The `tug_session_id` argument is `None` for all non-CODE_INPUT feeds
/// (TERMINAL_INPUT, FILETREE_QUERY, TERMINAL_RESIZE) and
/// `Some(tug_session_id)` for CODE_INPUT. This enables one distinct writer
/// per session on CODE_INPUT per [D08].
fn try_claim_input(
    ownership: &InputOwnership,
    feed_id: FeedId,
    tug_session_id: Option<TugSessionId>,
    client_id: u64,
) -> Result<(), u64> {
    let mut map = ownership.lock().unwrap();
    let key = (feed_id, tug_session_id);
    match map.get(&key).copied() {
        None | Some(0) => {
            map.insert(key, client_id);
            Ok(())
        }
        Some(owner) if owner == client_id => Ok(()),
        Some(owner) => Err(owner),
    }
}

/// Release all input keys owned by the given client.
fn release_inputs(ownership: &InputOwnership, client_id: u64) {
    let mut map = ownership.lock().unwrap();
    map.retain(|_, owner| *owner != client_id);
}

/// Combined client teardown: release input ownership AND notify the
/// supervisor (if wired). Every path in `handle_client` that exits on
/// disconnect or error must route through this helper so per-client
/// supervisor state (`client_sessions`) cannot leak across reconnects.
async fn teardown_client(router: &FeedRouter, client_id: u64) {
    release_inputs(&router.input_ownership, client_id);
    if let Some(sup) = router.supervisor.as_ref() {
        sup.on_client_disconnect(client_id).await;
    }
}

/// Outcome of the CONTROL-frame session-action intercept, driving
/// `handle_client`'s response. Extracted so unit tests can exercise the
/// routing logic without a live WebSocket.
#[derive(Debug)]
enum ControlIntercept {
    /// Action was a session-lifecycle action and the supervisor handled
    /// it successfully. Caller should not fall through to `dispatch_action`.
    Handled,
    /// Action was a session-lifecycle action but the supervisor rejected
    /// the payload. Caller should emit a CONTROL error frame with the
    /// paired `detail` string and not fall through.
    HandledError { detail: &'static str },
    /// Action is not a session-lifecycle action. Caller should fall
    /// through to `dispatch_action` as before.
    PassThrough,
}

/// Intercept session-lifecycle CONTROL actions and route them to the
/// supervisor ([D09]). Non-session actions return `PassThrough` so the
/// caller can fall through to the legacy `dispatch_action` (relaunch,
/// dev-mode toggles, etc.). When the supervisor is not wired (interim
/// during router-unit tests that omit it), all actions `PassThrough`.
///
/// **Single source of truth**: [`AgentSupervisor::handle_control`]'s
/// match arms decide which actions the supervisor owns. This function
/// just translates [`ControlOutcome`] into the wire-side
/// [`ControlIntercept`] shape. Adding a new action to the supervisor
/// is a one-place change — there is no separate router-side allowlist
/// that has to be kept in sync.
async fn intercept_session_control(
    supervisor: Option<&Arc<AgentSupervisor>>,
    action: &str,
    payload: &[u8],
    client_id: u64,
) -> ControlIntercept {
    let Some(sup) = supervisor else {
        return ControlIntercept::PassThrough;
    };
    match sup.handle_control(action, payload, client_id).await {
        ControlOutcome::Handled => ControlIntercept::Handled,
        ControlOutcome::PassThrough => ControlIntercept::PassThrough,
        ControlOutcome::Error(ControlError::MissingCardId) => ControlIntercept::HandledError {
            detail: "missing_card_id",
        },
        ControlOutcome::Error(ControlError::MissingSessionId) => ControlIntercept::HandledError {
            detail: "missing_tug_session_id",
        },
        ControlOutcome::Error(ControlError::Malformed) => ControlIntercept::HandledError {
            detail: "malformed_payload",
        },
        ControlOutcome::Error(ControlError::InvalidProjectDir { reason }) => {
            ControlIntercept::HandledError { detail: reason }
        }
        ControlOutcome::Error(ControlError::CapExceeded { reason }) => {
            ControlIntercept::HandledError { detail: reason }
        }
    }
}

/// Per-client session affinity map (a handle to
/// [`AgentSupervisor::client_sessions`]). Passed as `Option` to
/// [`authorize_and_claim_input`] so the helper can be unit-tested without
/// constructing a full supervisor, and so the check is a no-op during
/// Step 7's interim where `FeedRouter::supervisor` is still `None`.
type ClientSessionAffinity = Arc<tokio::sync::Mutex<HashMap<u64, HashSet<TugSessionId>>>>;

/// Decision produced by [`authorize_and_claim_input`], driving the
/// socket-side response in `handle_client`. Carried through a separate
/// type (rather than inlined in the handler) so the admission logic is
/// unit-testable without a real WebSocket or a full `AgentSupervisor`.
#[derive(Debug, PartialEq, Eq)]
enum InputDecision {
    /// Frame passes all checks — forward to the input sink.
    Forward,
    /// CODE_INPUT payload has no `tug_session_id` field — reject with
    /// `send_control_json(missing_tug_session_id)`.
    MissingSession,
    /// Client has not registered this `tug_session_id` via `spawn_session`
    /// — reject with `send_control_json(session_not_owned)`.
    ///
    /// Carries the session the write was FOR. The rejection is the only
    /// notice the deck ever gets that this write died, and without the id
    /// on the frame no card can tell whether the rejection is its own: the
    /// deck is reduced to guessing from phase, and a card whose turn is
    /// past that guess is stranded live forever with no event left to end
    /// it. Stamping the id makes the frame addressed, which is what lets
    /// exactly one card own it.
    NotOwned(TugSessionId),
    /// Another client owns this `(feed_id, tug_session_id?)` key — reject
    /// with `send_control_json(input_claimed)` carrying the owner id.
    Claimed(u64),
}

/// Admit or reject an inbound input frame. Pure in its effect on external
/// state (no I/O) except for the ownership mutation on a successful
/// `Forward` decision; the caller is responsible for forwarding the frame
/// and/or emitting the appropriate CONTROL error frame.
///
/// Behavior summary:
///
/// 1. Non-CODE_INPUT feeds: no session parsing, no authorization check, key
///    is `(feed_id, None)`.
/// 2. CODE_INPUT with no `tug_session_id` in payload: `MissingSession`. No
///    ownership mutation. (Hard reject per Step 7's wedge acknowledgement —
///    tugdeck `encodeCodeInput` must inject the field.)
/// 3. CODE_INPUT with a `tug_session_id` the client never registered via
///    `spawn_session`: `NotOwned`. No ownership mutation. Closes the
///    authorization gap where a client that learned another client's UUID
///    could race the legitimate owner to claim the key. Skipped when
///    `client_sessions` is `None` (Step 7 interim before main.rs wiring).
/// 4. Otherwise, attempt [`try_claim_input`] under the relaxed
///    `(FeedId, Option<TugSessionId>)` key and translate the result.
async fn authorize_and_claim_input(
    ownership: &InputOwnership,
    client_sessions: Option<&ClientSessionAffinity>,
    feed_id: FeedId,
    payload: &[u8],
    client_id: u64,
) -> InputDecision {
    let tug_session_id: Option<TugSessionId> = if feed_id == FeedId::CODE_INPUT {
        match parse_tug_session_id(payload) {
            Some(s) => Some(TugSessionId::new(s)),
            None => return InputDecision::MissingSession,
        }
    } else {
        None
    };

    if let (Some(sessions), Some(session)) = (client_sessions, &tug_session_id) {
        let cs = sessions.lock().await;
        if !cs.get(&client_id).is_some_and(|set| set.contains(session)) {
            return InputDecision::NotOwned(session.clone());
        }
    }

    match try_claim_input(ownership, feed_id, tug_session_id, client_id) {
        Ok(()) => InputDecision::Forward,
        Err(owner) => InputDecision::Claimed(owner),
    }
}

// ---------------------------------------------------------------------------
// handle_client
// ---------------------------------------------------------------------------

/// Handle a WebSocket client connection
async fn handle_client(mut socket: WebSocket, mut router: FeedRouter) {
    let client_id = router.next_client_id();
    info!(client_id, "Client connected");

    // --- Protocol handshake (v1) ---
    if !perform_handshake(&mut socket).await {
        return;
    }

    // Build the StreamMap for output fan-in
    let (mut stream_map, lag_policies) = build_stream_map(&router.stream_outputs);

    let mut state = ClientState::Live;

    loop {
        match &mut state {
            ClientState::Bootstrap { feed_id, buffer } => {
                let lagged_feed = *feed_id;
                info!(client_id, %lagged_feed, "Client re-entering BOOTSTRAP state");

                // Send lag_detected control frame
                let _ = send_control_json(
                    &mut socket,
                    lagged_feed,
                    &serde_json::json!({
                        "type": "lag_detected",
                        "feed_id": lagged_feed.as_byte()
                    }),
                )
                .await;

                // Dispatch bootstrap based on feed
                if lagged_feed == FeedId::TERMINAL_OUTPUT {
                    // Terminal: capture tmux pane
                    match terminal::capture_pane(&router.session).await {
                        Ok(snapshot) => {
                            let frame = Frame::new(FeedId::TERMINAL_OUTPUT, snapshot);
                            if socket
                                .send(Message::Binary(frame.encode().into()))
                                .await
                                .is_err()
                            {
                                info!(client_id, "Client disconnected during snapshot send");
                                teardown_client(&router, client_id).await;
                                return;
                            }
                            debug!(client_id, "Terminal snapshot sent");
                        }
                        Err(e) => {
                            error!("Failed to capture pane: {}", e);
                        }
                    }
                } else {
                    // Other feeds: no bootstrap available yet
                    let _ = send_control_json(
                        &mut socket,
                        lagged_feed,
                        &serde_json::json!({
                            "type": "bootstrap_unavailable",
                            "feed_id": lagged_feed.as_byte()
                        }),
                    )
                    .await;
                }

                // Drain any buffered frames from the stream map
                use tokio_stream::StreamExt;
                while let Some((_fid, result)) =
                    futures::FutureExt::now_or_never(stream_map.next()).flatten()
                {
                    if let Ok(frame) = result {
                        buffer.push(frame);
                    }
                }

                // Flush buffer to client
                for frame in buffer.drain(..) {
                    if socket
                        .send(Message::Binary(frame.encode().into()))
                        .await
                        .is_err()
                    {
                        info!(client_id, "Client disconnected during buffer flush");
                        teardown_client(&router, client_id).await;
                        return;
                    }
                }

                debug!(client_id, "Buffer flushed, transitioning to LIVE");
                state = ClientState::Live;
            }

            ClientState::Live => {
                info!(client_id, "Client in LIVE state");

                // Create a channel for merged snapshot updates
                let (snap_tx, mut snap_rx) = mpsc::channel::<Frame>(16);

                let snapshot_watches = std::mem::take(&mut router.snapshot_watches);
                for mut watch_rx in snapshot_watches {
                    let frame = watch_rx.borrow_and_update().clone();
                    if !frame.payload.is_empty()
                        && socket
                            .send(Message::Binary(frame.encode().into()))
                            .await
                            .is_err()
                    {
                        info!(
                            client_id,
                            "Client disconnected during initial snapshot send"
                        );
                        teardown_client(&router, client_id).await;
                        return;
                    }
                    let snap_tx_clone = snap_tx.clone();
                    tokio::spawn(async move {
                        while watch_rx.changed().await.is_ok() {
                            let frame = watch_rx.borrow_and_update().clone();
                            if snap_tx_clone.send(frame).await.is_err() {
                                break;
                            }
                        }
                    });
                }

                // Broadcast streams: subscribe a fresh receiver per sender
                // and forward into the same merged snapshot channel. No
                // "initial value" delivery — broadcast carries only
                // future frames. Lagged errors (slow client falling
                // behind the buffer) log and continue.
                let snapshot_broadcasts = std::mem::take(&mut router.snapshot_broadcast_senders);
                for tx in snapshot_broadcasts {
                    let mut bcast_rx = tx.subscribe();
                    let snap_tx_clone = snap_tx.clone();
                    tokio::spawn(async move {
                        loop {
                            match bcast_rx.recv().await {
                                Ok(frame) => {
                                    if snap_tx_clone.send(frame).await.is_err() {
                                        break;
                                    }
                                }
                                Err(broadcast::error::RecvError::Lagged(n)) => {
                                    warn!(skipped = n, "broadcast snapshot stream lagged");
                                }
                                Err(broadcast::error::RecvError::Closed) => break,
                            }
                        }
                    });
                }

                drop(snap_tx);

                let mut heartbeat_interval = time::interval(HEARTBEAT_INTERVAL);
                let mut liveness = ClientLiveness::new(Instant::now());

                use tokio_stream::StreamExt;

                loop {
                    tokio::select! {
                        Some(frame) = snap_rx.recv() => {
                            if socket.send(Message::Binary(frame.encode().into())).await.is_err() {
                                info!(client_id, "Client disconnected");
                                teardown_client(&router, client_id).await;
                                return;
                            }
                        }

                        Some((feed_id, result)) = stream_map.next() => {
                            match result {
                                Ok(frame) => {
                                    if socket.send(Message::Binary(frame.encode().into())).await.is_err() {
                                        info!(client_id, "Client disconnected");
                                        teardown_client(&router, client_id).await;
                                        return;
                                    }
                                }
                                Err(lagged) => {
                                    // `Lagged(n)` is the only variant — `n` is how many
                                    // frames this client's receiver fell behind (skipped).
                                    let tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(
                                        skipped,
                                    ) = lagged;
                                    // Session-lifecycle drop sensor: lag on a per-client
                                    // stream is the one place CODE_OUTPUT frames can be
                                    // lost (the bridge→merger hop is awaited mpsc). The
                                    // Replay policy recovers from its buffer; Warn does
                                    // not. Either way the count lands in the waterfall
                                    // grep stream.
                                    tracing::warn!(
                                        target: "dev::session-lifecycle",
                                        event = "perf.frames_lagged",
                                        client_id,
                                        feed_id = %feed_id,
                                        skipped,
                                    );
                                    let policy = lag_policies.get(&feed_id).cloned().unwrap_or(LagPolicy::Warn);
                                    match policy {
                                        LagPolicy::Bootstrap => {
                                            warn!(client_id, %feed_id, skipped, "Stream lagged, re-entering BOOTSTRAP");
                                            state = ClientState::Bootstrap {
                                                feed_id,
                                                buffer: Vec::new(),
                                            };
                                            break;
                                        }
                                        LagPolicy::Replay(replay_buf) => {
                                            warn!(client_id, %feed_id, skipped, "Stream lagged, replaying from buffer");
                                            // Send lag_recovery control frame
                                            if !send_control_json(&mut socket, feed_id, &serde_json::json!({
                                                "type": "lag_recovery",
                                                "feed_id": feed_id.as_byte()
                                            })).await {
                                                teardown_client(&router, client_id).await;
                                                return;
                                            }
                                            // Replay buffered frames
                                            for frame in replay_buf.snapshot() {
                                                if socket.send(Message::Binary(frame.encode().into())).await.is_err() {
                                                    info!(client_id, "Client disconnected during replay");
                                                    teardown_client(&router, client_id).await;
                                                    return;
                                                }
                                            }
                                            // Send lag_recovery_complete
                                            if !send_control_json(&mut socket, feed_id, &serde_json::json!({
                                                "type": "lag_recovery_complete",
                                                "feed_id": feed_id.as_byte()
                                            })).await {
                                                teardown_client(&router, client_id).await;
                                                return;
                                            }
                                            // Continue live streaming
                                        }
                                        LagPolicy::Warn => {
                                            warn!(client_id, %feed_id, skipped, "Stream lagged, frames lost");
                                        }
                                    }
                                }
                            }
                        }

                        msg = socket.recv() => {
                            match msg {
                                Some(Ok(Message::Binary(data))) => {
                                    if let Ok((frame, _)) = Frame::decode(&data) {
                                        let fid = frame.feed_id;

                                        // Any frame that decodes is proof the client
                                        // is alive, whatever it carries. Liveness is
                                        // refreshed here, ahead of the feed-id
                                        // dispatch, so a busy client sending CONTROL
                                        // and CODE_INPUT is never closed for the want
                                        // of a HEARTBEAT.
                                        liveness.record_frame(Instant::now());

                                        // Router-internal: Heartbeat
                                        if fid == FeedId::HEARTBEAT {
                                            debug!("Heartbeat received from client");
                                        }
                                        // Router-internal: Control. Session-lifecycle
                                        // actions (`spawn_session` / `close_session` /
                                        // `reset_session`) are intercepted and routed
                                        // to the supervisor per [D09]; all other
                                        // actions fall through to `dispatch_action`.
                                        else if fid == FeedId::CONTROL {
                                            if let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&frame.payload) {
                                                if let Some(action) = payload.get("action").and_then(|a| a.as_str()) {
                                                    match intercept_session_control(
                                                        router.supervisor.as_ref(),
                                                        action,
                                                        &frame.payload,
                                                        client_id,
                                                    ).await {
                                                        ControlIntercept::Handled => {}
                                                        ControlIntercept::HandledError { detail } => {
                                                            warn!(client_id, action, detail, "session control rejected");
                                                            // Echo the rejected payload's identifying
                                                            // fields so the client can route the error
                                                            // to the originating card. A `spawn_session`
                                                            // rejection, in particular, must reach that
                                                            // card's spawn-error banner — without
                                                            // `card_id` the client cannot tell which
                                                            // unbound card the failed spawn belonged to.
                                                            let mut err = serde_json::json!({
                                                                "type": "error",
                                                                "detail": detail,
                                                            });
                                                            if let Some(obj) = err.as_object_mut() {
                                                                if action == "spawn_session" {
                                                                    obj.insert(
                                                                        "action".into(),
                                                                        "spawn_session_error".into(),
                                                                    );
                                                                }
                                                                if let Some(cid) = payload
                                                                    .get("card_id")
                                                                    .and_then(|v| v.as_str())
                                                                {
                                                                    obj.insert("card_id".into(), cid.into());
                                                                }
                                                                if let Some(sid) = payload
                                                                    .get("tug_session_id")
                                                                    .and_then(|v| v.as_str())
                                                                {
                                                                    obj.insert(
                                                                        "tug_session_id".into(),
                                                                        sid.into(),
                                                                    );
                                                                }
                                                            }
                                                            let _ = send_control_json(&mut socket, FeedId::CONTROL, &err).await;
                                                        }
                                                        ControlIntercept::PassThrough => {
                                                            crate::actions::dispatch_action(
                                                                action,
                                                                &frame.payload,
                                                                &router.action_context(),
                                                            ).await;
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        // Dynamic dispatch: look up input sink, then
                                        // run the session-aware admission check via
                                        // `authorize_and_claim_input`. Socket I/O is
                                        // driven off the returned `InputDecision`.
                                        else if router.input_sinks.contains_key(&fid) {
                                            let decision = authorize_and_claim_input(
                                                &router.input_ownership,
                                                router.supervisor.as_ref().map(|s| &s.client_sessions),
                                                fid,
                                                &frame.payload,
                                                client_id,
                                            ).await;
                                            match decision {
                                                InputDecision::Forward => {
                                                    let tx = router.input_sinks.get(&fid).unwrap();
                                                    let _ = tx.send(frame).await;
                                                }
                                                InputDecision::MissingSession => {
                                                    warn!(
                                                        client_id,
                                                        "CODE_INPUT missing tug_session_id, rejecting"
                                                    );
                                                    let _ = send_control_json(&mut socket, fid, &serde_json::json!({
                                                        "type": "error",
                                                        "detail": "missing_tug_session_id",
                                                    })).await;
                                                }
                                                InputDecision::NotOwned(session) => {
                                                    warn!(
                                                        client_id,
                                                        %fid,
                                                        tug_session_id = session.as_str(),
                                                        "CODE_INPUT for session not owned by client"
                                                    );
                                                    let _ = send_control_json(&mut socket, fid, &serde_json::json!({
                                                        "type": "error",
                                                        "detail": "session_not_owned",
                                                        "tug_session_id": session.as_str(),
                                                    })).await;
                                                }
                                                InputDecision::Claimed(owner) => {
                                                    warn!(client_id, %fid, owner, "Input claimed by another client");
                                                    let _ = send_control_json(&mut socket, fid, &serde_json::json!({
                                                        "type": "input_claimed",
                                                        "feed_id": fid.as_byte(),
                                                        "owner": owner
                                                    })).await;
                                                }
                                            }
                                        }
                                    }
                                }
                                Some(Ok(Message::Close(_))) | None => {
                                    info!(client_id, "Client disconnected");
                                    teardown_client(&router, client_id).await;
                                    return;
                                }
                                Some(Ok(_)) => {}
                                Some(Err(e)) => {
                                    error!(client_id, "WebSocket error: {}", e);
                                    teardown_client(&router, client_id).await;
                                    return;
                                }
                            }
                        }

                        _ = heartbeat_interval.tick() => {
                            let hb = Frame::heartbeat();
                            if socket.send(Message::Binary(hb.encode().into())).await.is_err() {
                                info!(client_id, "Client disconnected during heartbeat send");
                                teardown_client(&router, client_id).await;
                                return;
                            }
                            if liveness.is_stale(Instant::now()) {
                                warn!(client_id, "Heartbeat timeout, closing connection");
                                teardown_client(&router, client_id).await;
                                return;
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Extract SharedAuthState from FeedRouter for axum State
impl axum::extract::FromRef<FeedRouter> for SharedAuthState {
    fn from_ref(router: &FeedRouter) -> Self {
        router.auth.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Handshake response ----

    #[test]
    fn handshake_response_carries_well_formed_host() {
        let r = build_handshake_response();

        // Additive host object present and well-formed (Spec S03).
        let host = r.get("host").expect("handshake response has a host field");
        assert_eq!(
            host.get("os").and_then(|v| v.as_str()),
            Some("macos"),
            "host.os is \"macos\""
        );
        let version = host
            .get("version")
            .and_then(|v| v.as_str())
            .expect("host.version is a string");
        // On a macOS host this is a dotted version like "15.7.7"; tolerate an
        // empty string on a non-macOS test host (the frontend treats empty as
        // unknown and does not block).
        if !version.is_empty() {
            assert!(
                version
                    .split('.')
                    .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())),
                "host.version is dotted digits: {version}"
            );
        }

        // Protocol identity preserved — the host field is purely additive.
        assert_eq!(
            r.get("protocol").and_then(|v| v.as_str()),
            Some(PROTOCOL_NAME)
        );
        assert_eq!(
            r.get("version").and_then(|v| v.as_u64()),
            Some(PROTOCOL_VERSION as u64)
        );
    }

    // ---- ReplayBuffer ----

    #[test]
    fn test_replay_buffer_push_and_snapshot() {
        let buf = ReplayBuffer::new(3);
        buf.push(Frame::new(FeedId::CODE_OUTPUT, b"a".to_vec()));
        buf.push(Frame::new(FeedId::CODE_OUTPUT, b"b".to_vec()));
        let snap = buf.snapshot();
        assert_eq!(snap.len(), 2);
        assert_eq!(snap[0].payload, b"a");
        assert_eq!(snap[1].payload, b"b");
    }

    #[test]
    fn test_replay_buffer_eviction() {
        let buf = ReplayBuffer::new(2);
        buf.push(Frame::new(FeedId::CODE_OUTPUT, b"a".to_vec()));
        buf.push(Frame::new(FeedId::CODE_OUTPUT, b"b".to_vec()));
        buf.push(Frame::new(FeedId::CODE_OUTPUT, b"c".to_vec()));
        let snap = buf.snapshot();
        assert_eq!(snap.len(), 2);
        assert_eq!(snap[0].payload, b"b");
        assert_eq!(snap[1].payload, b"c");
    }

    #[test]
    fn test_replay_buffer_empty_snapshot() {
        let buf = ReplayBuffer::new(10);
        assert!(buf.snapshot().is_empty());
        assert_eq!(buf.len(), 0);
    }

    #[test]
    fn test_replay_buffer_clone_is_shared() {
        let buf = ReplayBuffer::new(10);
        let buf2 = buf.clone();
        buf.push(Frame::new(FeedId::CODE_OUTPUT, b"x".to_vec()));
        assert_eq!(buf2.len(), 1);
    }

    // ---- LagPolicy ----

    #[test]
    fn test_lag_policy_equality() {
        assert_eq!(LagPolicy::Bootstrap, LagPolicy::Bootstrap);
        assert_eq!(LagPolicy::Warn, LagPolicy::Warn);
        let r1 = LagPolicy::Replay(ReplayBuffer::new(10));
        let r2 = LagPolicy::Replay(ReplayBuffer::new(20));
        assert_eq!(r1, r2); // Replay == Replay regardless of buffer
        assert_ne!(LagPolicy::Bootstrap, LagPolicy::Warn);
        assert_ne!(LagPolicy::Bootstrap, r1);
    }

    // ---- Session-feed registration ----

    /// The lag-recovery contract, pinned at the layer `handle_client`'s
    /// replay path reads: registering a Replay-policy session feed puts
    /// the SAME buffer behind the router's stream entry, and frames
    /// published through the handle land in it — a lagging client's
    /// `snapshot()` replays real frames, not an empty buffer.
    #[test]
    fn register_session_feed_shares_replay_buffer_with_publisher() {
        use crate::feeds::session_scoped::SessionScopedFeed;

        let buffer = ReplayBuffer::new(8);
        let feed =
            SessionScopedFeed::new(FeedId::CODE_OUTPUT, 8, LagPolicy::Replay(buffer.clone()));
        let (shutdown_tx, _shutdown_rx) = mpsc::channel(1);
        let mut router = FeedRouter::new(
            "test".to_string(),
            crate::auth::new_shared_auth_state(0),
            shutdown_tx,
            crate::dev::new_shared_dev_state(),
        );
        router.register_session_feed(&feed);

        feed.publish("session-a", br#"{"type":"assistant_text"}"#);
        feed.publish("session-b", br#"{"type":"tool_use"}"#);

        let (_, policy) = router.stream_outputs.get(&FeedId::CODE_OUTPUT).unwrap();
        let LagPolicy::Replay(routed_buffer) = policy else {
            panic!("CODE_OUTPUT must register with a Replay policy");
        };
        let frames = routed_buffer.snapshot();
        assert_eq!(frames.len(), 2, "published frames feed lag recovery");
        assert!(
            frames[0]
                .payload
                .starts_with(br#"{"tug_session_id":"session-a","#)
        );
    }

    // ---- InputOwnership (P5) ----

    #[test]
    fn test_input_claim_unclaimed() {
        let ownership: InputOwnership = Arc::new(Mutex::new(HashMap::new()));
        assert!(try_claim_input(&ownership, FeedId::TERMINAL_INPUT, None, 1).is_ok());
    }

    #[test]
    fn test_input_claim_same_client() {
        let ownership: InputOwnership = Arc::new(Mutex::new(HashMap::new()));
        try_claim_input(&ownership, FeedId::TERMINAL_INPUT, None, 1).unwrap();
        // Same client can re-claim
        assert!(try_claim_input(&ownership, FeedId::TERMINAL_INPUT, None, 1).is_ok());
    }

    #[test]
    fn test_input_claim_different_client_rejected() {
        let ownership: InputOwnership = Arc::new(Mutex::new(HashMap::new()));
        try_claim_input(&ownership, FeedId::TERMINAL_INPUT, None, 1).unwrap();
        // Different client is rejected
        let result = try_claim_input(&ownership, FeedId::TERMINAL_INPUT, None, 2);
        assert_eq!(result, Err(1));
    }

    #[test]
    fn test_input_release() {
        let ownership: InputOwnership = Arc::new(Mutex::new(HashMap::new()));
        try_claim_input(&ownership, FeedId::TERMINAL_INPUT, None, 1).unwrap();
        try_claim_input(
            &ownership,
            FeedId::CODE_INPUT,
            Some(TugSessionId::new("sess-a")),
            1,
        )
        .unwrap();
        release_inputs(&ownership, 1);
        // After release, another client can claim
        assert!(try_claim_input(&ownership, FeedId::TERMINAL_INPUT, None, 2).is_ok());
        assert!(
            try_claim_input(
                &ownership,
                FeedId::CODE_INPUT,
                Some(TugSessionId::new("sess-a")),
                2
            )
            .is_ok()
        );
    }

    #[test]
    fn test_input_release_only_own_feeds() {
        let ownership: InputOwnership = Arc::new(Mutex::new(HashMap::new()));
        try_claim_input(&ownership, FeedId::TERMINAL_INPUT, None, 1).unwrap();
        try_claim_input(
            &ownership,
            FeedId::CODE_INPUT,
            Some(TugSessionId::new("sess-a")),
            2,
        )
        .unwrap();
        // Release client 1 — should not affect client 2's ownership
        release_inputs(&ownership, 1);
        assert!(try_claim_input(&ownership, FeedId::TERMINAL_INPUT, None, 3).is_ok());
        assert_eq!(
            try_claim_input(
                &ownership,
                FeedId::CODE_INPUT,
                Some(TugSessionId::new("sess-a")),
                3
            ),
            Err(2)
        );
    }

    // ---- Step 7: P5 relaxation ([D08],) ----

    #[test]
    fn test_p5_relaxation_distinct_sessions() {
        // Two clients each claim CODE_INPUT with distinct `tug_session_id`s.
        // Both should succeed: the relaxed ownership key
        // `(FeedId, Option<TugSessionId>)` scopes the single-writer
        // guarantee per session, not per feed.
        let ownership: InputOwnership = Arc::new(Mutex::new(HashMap::new()));
        let sess_a = Some(TugSessionId::new("sess-a"));
        let sess_b = Some(TugSessionId::new("sess-b"));

        assert!(try_claim_input(&ownership, FeedId::CODE_INPUT, sess_a.clone(), 1).is_ok());
        assert!(try_claim_input(&ownership, FeedId::CODE_INPUT, sess_b.clone(), 2).is_ok());
    }

    #[test]
    fn test_p5_relaxation_duplicate_rejected() {
        // Two clients trying to claim CODE_INPUT for the SAME
        // `tug_session_id`: the second is rejected with the first
        // client's id (the standard input_claimed path).
        let ownership: InputOwnership = Arc::new(Mutex::new(HashMap::new()));
        let sess_a = Some(TugSessionId::new("sess-a"));

        assert!(try_claim_input(&ownership, FeedId::CODE_INPUT, sess_a.clone(), 1).is_ok());
        assert_eq!(
            try_claim_input(&ownership, FeedId::CODE_INPUT, sess_a, 2),
            Err(1)
        );
    }

    #[tokio::test]
    async fn test_p5_code_input_missing_session_id_rejected() {
        // CODE_INPUT with no `tug_session_id` in the payload is rejected
        // with `MissingSession`, and the ownership map is NOT mutated —
        // Step 7 promotes missing-session to a hard reject so a future
        // tugdeck regression that forgets to inject the field can't
        // silently succeed.
        let ownership: InputOwnership = Arc::new(Mutex::new(HashMap::new()));
        let payload = br#"{"type":"user_message","text":"hi"}"#;

        let decision =
            authorize_and_claim_input(&ownership, None, FeedId::CODE_INPUT, payload, 42).await;

        assert_eq!(decision, InputDecision::MissingSession);
        assert!(
            ownership.lock().unwrap().is_empty(),
            "rejected frame must not mutate the ownership map"
        );
    }

    #[tokio::test]
    async fn test_p5_code_input_rejects_unowned_session() {
        // A client that has not registered a `tug_session_id` via
        // `spawn_session` cannot claim `(CODE_INPUT, tug_session_id)`
        // ownership. This pins the supervisor cross-check added in Step 7.
        // After the client registers the session in `client_sessions`, a
        // follow-up claim for the same session succeeds.
        let ownership: InputOwnership = Arc::new(Mutex::new(HashMap::new()));
        let client_sessions: ClientSessionAffinity =
            Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let payload = br#"{"tug_session_id":"sess-x","type":"user_message"}"#;

        // Client 1 has no registered session — reject.
        let decision = authorize_and_claim_input(
            &ownership,
            Some(&client_sessions),
            FeedId::CODE_INPUT,
            payload,
            1,
        )
        .await;
        // The rejection names the session it was for, so the deck can route
        // it to exactly the card whose write died.
        assert_eq!(
            decision,
            InputDecision::NotOwned(TugSessionId::new("sess-x"))
        );
        assert!(
            ownership.lock().unwrap().is_empty(),
            "unowned session must not mutate the ownership map"
        );

        // Register client 1 → sess-x, mirroring what
        // `AgentSupervisor::handle_control("spawn_session", ...)` would
        // write. Now the same CODE_INPUT is admitted.
        {
            let mut cs = client_sessions.lock().await;
            cs.entry(1).or_default().insert(TugSessionId::new("sess-x"));
        }

        let decision = authorize_and_claim_input(
            &ownership,
            Some(&client_sessions),
            FeedId::CODE_INPUT,
            payload,
            1,
        )
        .await;
        assert_eq!(decision, InputDecision::Forward);
        assert_eq!(
            ownership.lock().unwrap().len(),
            1,
            "successful claim writes exactly one entry to the ownership map"
        );
    }

    #[test]
    fn test_p5_release_drops_all_entries_for_client() {
        // A client that owns both `(CODE_INPUT, sess-a)` and
        // `(TERMINAL_INPUT, None)` has both entries dropped on release.
        // Another client's entry (`(CODE_INPUT, sess-b)`) is untouched.
        let ownership: InputOwnership = Arc::new(Mutex::new(HashMap::new()));
        let sess_a = Some(TugSessionId::new("sess-a"));
        let sess_b = Some(TugSessionId::new("sess-b"));

        try_claim_input(&ownership, FeedId::CODE_INPUT, sess_a.clone(), 1).unwrap();
        try_claim_input(&ownership, FeedId::TERMINAL_INPUT, None, 1).unwrap();
        try_claim_input(&ownership, FeedId::CODE_INPUT, sess_b.clone(), 2).unwrap();

        release_inputs(&ownership, 1);

        // Client 1's both entries are gone; client 3 can claim freely.
        assert!(try_claim_input(&ownership, FeedId::CODE_INPUT, sess_a, 3).is_ok());
        assert!(try_claim_input(&ownership, FeedId::TERMINAL_INPUT, None, 3).is_ok());
        // Client 2's entry is still there.
        assert_eq!(
            try_claim_input(&ownership, FeedId::CODE_INPUT, sess_b, 3),
            Err(2)
        );
    }

    // ---- ClientState ----

    #[test]
    fn test_client_state_bootstrap_carries_feed_id() {
        let state = ClientState::Bootstrap {
            feed_id: FeedId::TERMINAL_OUTPUT,
            buffer: Vec::new(),
        };
        match state {
            ClientState::Bootstrap { feed_id, .. } => {
                assert_eq!(feed_id, FeedId::TERMINAL_OUTPUT);
            }
            ClientState::Live => panic!("Expected Bootstrap state"),
        }
    }

    // ---- Step 8: CONTROL interception + disconnect hook + metadata broadcast ----

    use crate::feeds::agent_supervisor::{install_live_session_for_tests, test_minimal_supervisor};
    use crate::feeds::session_metadata::is_system_metadata;
    use crate::feeds::workspace_registry::WorkspaceKey;
    use std::path::PathBuf;
    use tokio_util::sync::CancellationToken;
    use tugcast_core::TugSessionId;

    fn spawn_session_control_payload(card_id: &str, tug_session_id: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "action": "spawn_session",
            "card_id": card_id,
            "tug_session_id": tug_session_id,
            // project_dir is required on the wire. Use the
            // crate manifest dir as a valid fixture path for router tests.
            "project_dir": env!("CARGO_MANIFEST_DIR"),
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn test_control_frame_interception_routes_to_supervisor() {
        // A CONTROL frame with `action: "spawn_session"` intercepted via
        // `intercept_session_control` must be handled by the supervisor:
        // the ledger gains a pending entry and the client's session set
        // is updated in `client_sessions`. Non-session actions (e.g.
        // `relaunch`) must `PassThrough`.
        let (sup, mut register_rx) = test_minimal_supervisor();
        // Drain the merger register so spawn paths don't block on it.
        tokio::spawn(async move { while register_rx.recv().await.is_some() {} });

        let client_id = 42u64;
        let payload = spawn_session_control_payload("card-1", "sess-1");
        let outcome =
            intercept_session_control(Some(&sup), "spawn_session", &payload, client_id).await;
        assert!(matches!(outcome, ControlIntercept::Handled));

        let tug_id = TugSessionId::new("sess-1");
        assert!(sup.ledger.lock().await.contains_key(&tug_id));
        let cs = sup.client_sessions.lock().await;
        assert!(cs.get(&client_id).unwrap().contains(&tug_id));
        drop(cs);

        // Non-session actions pass through — even with a supervisor wired,
        // `relaunch` is `dispatch_action`'s business.
        let other = intercept_session_control(Some(&sup), "relaunch", b"{}", client_id).await;
        assert!(matches!(other, ControlIntercept::PassThrough));
    }

    /// Phase A-R1 / Step R1b regression: the `request_replay` verb must
    /// reach the supervisor through the same wire ingress production
    /// uses (websocket → router → `intercept_session_control` →
    /// `handle_control`). The original R1b implementation only tested
    /// `handle_control` directly; the router maintained a separate
    /// allowlist that did NOT include `request_replay`, so production
    /// wire frames fell through to `dispatch_action`'s catch-all and
    /// the supervisor never saw them. Smoke A/B failed: tugdeck waited
    /// 12s for replay events that never arrived.
    ///
    /// This test rides the wire path: build a Live ledger entry with a
    /// captured `input_tx`, push a CONTROL `request_replay` payload
    /// through `intercept_session_control`, and assert both that the
    /// outcome is `Handled` (the router actually routed it) and that
    /// the supervisor forwarded `{"type":"request_replay"}` to the
    /// captured channel (the supervisor actually executed it).
    ///
    /// What this test does NOT cover (and cannot, at a unit-level): the
    /// subprocess pipeline — agent_bridge writing the forwarded frame
    /// to tugcode's stdin, tugcode's IPC loop dispatching to
    /// `runReplay`, replay events flowing back through CODE_OUTPUT to
    /// tugdeck's `CodeSessionStore`. That two-language, two-process
    /// integration lives in the manual smoke beat (Phase A-R2 of
    /// `tugplan-dev-transcript-resume.md`).
    #[tokio::test]
    async fn test_request_replay_reaches_supervisor_through_router() {
        let (sup, mut register_rx) = test_minimal_supervisor();
        tokio::spawn(async move { while register_rx.recv().await.is_some() {} });

        let tug_id = TugSessionId::new("sess-r1b-router");
        let workspace_key = WorkspaceKey::from_test_str(env!("CARGO_MANIFEST_DIR"));
        let project_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let mut input_rx =
            install_live_session_for_tests(&sup, &tug_id, workspace_key, project_dir).await;

        // Build the wire-shape payload tugdeck's `encodeRequestReplay`
        // emits: `{"action":"request_replay","tug_session_id":"<id>"}`.
        let payload = serde_json::to_vec(&serde_json::json!({
            "action": "request_replay",
            "tug_session_id": "sess-r1b-router",
        }))
        .unwrap();

        // The production ingress entry point. If
        // `intercept_session_control` returns `PassThrough` here, the
        // verb falls through to `dispatch_action` and the supervisor
        // never runs — that's the bug Smoke A/B exposed.
        let outcome = intercept_session_control(Some(&sup), "request_replay", &payload, 1).await;
        assert!(
            matches!(outcome, ControlIntercept::Handled),
            "intercept_session_control must route request_replay to the supervisor, got {outcome:?}",
        );

        // Wire-side proof of correctness: the supervisor's
        // `do_request_replay` forwarded a CODE_INPUT frame with the
        // request_replay JSON payload to the per-session input_tx. That
        // is the exact byte sequence agent_bridge will write to
        // tugcode's stdin in production.
        let frame = input_rx
            .try_recv()
            .expect("request_replay payload reached input_tx");
        assert_eq!(frame.feed_id, FeedId::CODE_INPUT);
        let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(body["type"], "request_replay");
    }

    #[tokio::test]
    async fn test_control_frame_missing_card_id_sends_error_frame() {
        // `spawn_session` with no `card_id` in the payload results in a
        // `HandledError` with `detail = "missing_card_id"`. The supervisor
        // must not have a new ledger entry and `client_sessions` must not
        // have been touched.
        let (sup, mut register_rx) = test_minimal_supervisor();
        tokio::spawn(async move { while register_rx.recv().await.is_some() {} });

        let payload = serde_json::to_vec(&serde_json::json!({
            "action": "spawn_session",
            "tug_session_id": "sess-1",
        }))
        .unwrap();

        let outcome = intercept_session_control(Some(&sup), "spawn_session", &payload, 7).await;
        match outcome {
            ControlIntercept::HandledError { detail } => {
                assert_eq!(detail, "missing_card_id");
            }
            other => panic!("expected HandledError(missing_card_id), got {other:?}"),
        }

        assert!(sup.ledger.lock().await.is_empty());
        assert!(sup.client_sessions.lock().await.is_empty());
    }

    #[tokio::test]
    async fn test_control_frame_invalid_project_dir_sends_reason_detail() {
        // the supervisor returns
        // `ControlError::InvalidProjectDir { reason }` for spawn_session
        // payloads whose `project_dir` is missing, nonexistent, not a
        // directory, etc. `intercept_session_control` must map each
        // variant to a `HandledError` whose `detail` is the exact reason
        // string so tugdeck can surface a precise error per.
        let (sup, mut register_rx) = test_minimal_supervisor();
        tokio::spawn(async move { while register_rx.recv().await.is_some() {} });

        // Case A: missing project_dir entirely.
        let missing = serde_json::to_vec(&serde_json::json!({
            "action": "spawn_session",
            "card_id": "card-1",
            "tug_session_id": "sess-1",
        }))
        .unwrap();
        let outcome = intercept_session_control(Some(&sup), "spawn_session", &missing, 7).await;
        match outcome {
            ControlIntercept::HandledError { detail } => {
                assert_eq!(detail, "missing_project_dir");
            }
            other => panic!("expected HandledError(missing_project_dir), got {other:?}"),
        }

        // Case B: path that does not exist on disk.
        let nonexistent = serde_json::to_vec(&serde_json::json!({
            "action": "spawn_session",
            "card_id": "card-1",
            "tug_session_id": "sess-1",
            "project_dir": "/nonexistent/router-invalid-path-test-xyz",
        }))
        .unwrap();
        let outcome = intercept_session_control(Some(&sup), "spawn_session", &nonexistent, 7).await;
        match outcome {
            ControlIntercept::HandledError { detail } => {
                assert_eq!(detail, "does_not_exist");
            }
            other => panic!("expected HandledError(does_not_exist), got {other:?}"),
        }

        // Invalid paths never touch the ledger or client affinity map.
        assert!(sup.ledger.lock().await.is_empty());
        assert!(sup.client_sessions.lock().await.is_empty());
    }

    #[tokio::test]
    async fn test_session_metadata_fed_by_supervisor_broadcast() {
        // Pins [D14]'s broadcast-not-watch migration at the router layer.
        // A `system_metadata` frame injected into the supervisor's merger
        // must reach a `broadcast::Receiver<Frame>` — the same
        // shape that `register_stream(FeedId::SESSION_SIDEBAND, ...)` in
        // `main.rs` produces — and must NOT rely on any `watch::Receiver`.
        // This test constructs a supervisor with its own SESSION_SIDEBAND
        // broadcast sender, subscribes a receiver, spawns `merger_task`,
        // registers a per-session stream, pushes a `system_metadata`
        // frame, and asserts the broadcast subscriber receives it.
        use crate::feeds::agent_supervisor::{
            AgentSupervisor, AgentSupervisorConfig, NoopSessionsRecorder, SessionsRecorder,
            SpawnerFactory,
        };
        use crate::feeds::session_scoped::SessionScopedFeed;
        use crate::feeds::workspace_registry::WorkspaceRegistry;
        use tokio::sync::mpsc;

        let (state_tx, _) = broadcast::channel(16);
        let (session_sideband_tx, mut meta_rx) = broadcast::channel::<Frame>(16);
        let (code_tx, _) = broadcast::channel(16);
        let (control_tx, _) = broadcast::channel(16);
        let factory: SpawnerFactory = Arc::new(|| unreachable!("no spawner"));
        let recorder: Arc<dyn SessionsRecorder> = Arc::new(NoopSessionsRecorder);
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        let router_cancel = CancellationToken::new();
        let (sup, register_rx) = AgentSupervisor::new(
            SessionScopedFeed::from_sender(FeedId::SESSION_STATE, state_tx, LagPolicy::Warn),
            SessionScopedFeed::from_sender(
                FeedId::SESSION_SIDEBAND,
                session_sideband_tx,
                LagPolicy::Warn,
            ),
            SessionScopedFeed::from_sender(FeedId::CODE_OUTPUT, code_tx, LagPolicy::Warn),
            SessionScopedFeed::new(FeedId::ACTIVITY, 64, LagPolicy::Warn),
            control_tx,
            recorder,
            factory,
            AgentSupervisorConfig::default(),
            registry,
            router_cancel,
        );
        let sup = Arc::new(sup);
        let cancel = CancellationToken::new();
        let merger_handle = tokio::spawn(Arc::clone(&sup).merger_task(register_rx, cancel.clone()));

        let id = TugSessionId::new("sess-1");
        let (tx, rx) = mpsc::channel::<Frame>(4);
        sup.merger_register_tx.send((id.clone(), rx)).await.unwrap();

        let meta_payload =
            br#"{"tug_session_id":"sess-1","type":"system_metadata","model":"opus"}"#.to_vec();
        // Sanity-check the needle-scan helper sees the payload as
        // system_metadata — the merger relies on it.
        assert!(is_system_metadata(&meta_payload));
        let meta_frame = Frame::new(FeedId::CODE_OUTPUT, meta_payload.clone());
        tx.send(meta_frame).await.unwrap();

        let received = tokio::time::timeout(Duration::from_millis(500), meta_rx.recv())
            .await
            .expect("broadcast subscriber received metadata")
            .expect("recv err");
        // The merger MUST rewrap the payload as `FeedId::SESSION_SIDEBAND`
        // before publishing. `Frame::encode` serializes `Frame.feed_id` as
        // the first wire byte, so a client subscribing to SESSION_SIDEBAND
        // (via `register_stream(FeedId::SESSION_SIDEBAND, ...)`) would
        // otherwise receive a frame tagged CODE_OUTPUT and route it to the
        // wrong store. This test is the router-layer pin for that rewrap.
        assert_eq!(received.feed_id, FeedId::SESSION_SIDEBAND);
        assert_eq!(received.payload, meta_payload);

        cancel.cancel();
        let _ = merger_handle.await;
    }

    #[tokio::test]
    async fn test_handle_client_disconnect_clears_client_sessions() {
        // `teardown_client` must call `AgentSupervisor::on_client_disconnect`
        // (in addition to `release_inputs`) so a disconnected client's
        // `client_sessions` entry is removed and does not leak across
        // reconnects. This is the `handle_client` teardown hook in
        // compact form: build a supervisor, populate `client_sessions`,
        // build a FeedRouter with the supervisor attached, call
        // `teardown_client`, then assert.
        let (sup, mut register_rx) = test_minimal_supervisor();
        tokio::spawn(async move { while register_rx.recv().await.is_some() {} });

        // Populate client_sessions with an entry for client 11.
        {
            let mut cs = sup.client_sessions.lock().await;
            cs.entry(11)
                .or_default()
                .insert(TugSessionId::new("sess-x"));
        }
        assert!(sup.client_sessions.lock().await.contains_key(&11));

        let (shutdown_tx, _) = mpsc::channel(1);
        let auth = crate::auth::new_shared_auth_state(0);
        let dev_state = crate::dev::new_shared_dev_state();
        let mut router = FeedRouter::new("test".into(), auth, shutdown_tx, dev_state);
        router.set_supervisor(Arc::clone(&sup));

        teardown_client(&router, 11).await;

        assert!(!sup.client_sessions.lock().await.contains_key(&11));
    }

    // ---- FeedRouter registration ----

    #[test]
    fn test_broadcast_capacity() {
        assert_eq!(BROADCAST_CAPACITY, 4096);
    }

    #[test]
    fn test_heartbeat_constants() {
        assert_eq!(HEARTBEAT_INTERVAL, Duration::from_secs(15));
        assert_eq!(HEARTBEAT_TIMEOUT, Duration::from_secs(180));
    }

    /// A client that never sends a HEARTBEAT but is otherwise chatty is
    /// alive, and must never be closed. This was the entire busy-session
    /// class of spurious closes: liveness used to be refreshed only by
    /// `FeedId::HEARTBEAT`, so a client streaming CONTROL and CODE_INPUT
    /// got hung up on for the want of one specific frame type.
    #[test]
    fn control_only_traffic_keeps_a_client_alive() {
        let t0 = Instant::now();
        let mut liveness = ClientLiveness::new(t0);

        // Ten minutes of CONTROL traffic at 30 s intervals — well past
        // the 180 s window, with not one HEARTBEAT among them. The
        // staleness check runs on every 15 s tick throughout.
        for step in 1..=20u32 {
            let frame_at = t0 + Duration::from_secs(30 * u64::from(step));
            liveness.record_frame(frame_at);
            for tick in 1..=2u32 {
                let tick_at = frame_at + Duration::from_secs(15 * u64::from(tick));
                assert!(
                    !liveness.is_stale(tick_at),
                    "a client sending a frame every 30 s was declared stale",
                );
            }
        }
    }

    /// The other half of the rule: silence still ends the connection.
    #[test]
    fn silence_past_the_window_is_stale() {
        let t0 = Instant::now();
        let liveness = ClientLiveness::new(t0);

        assert!(!liveness.is_stale(t0 + Duration::from_secs(179)));
        assert!(!liveness.is_stale(t0 + HEARTBEAT_TIMEOUT));
        assert!(liveness.is_stale(t0 + HEARTBEAT_TIMEOUT + Duration::from_secs(1)));
    }

    /// A single frame arriving late in the window resets the clock
    /// rather than merely postponing the tick that reads it.
    #[test]
    fn a_late_frame_resets_the_whole_window() {
        let t0 = Instant::now();
        let mut liveness = ClientLiveness::new(t0);

        let frame_at = t0 + Duration::from_secs(170);
        liveness.record_frame(frame_at);

        // 175 s after the frame: 345 s since the connection opened, but
        // only 175 s of actual silence.
        assert!(!liveness.is_stale(frame_at + Duration::from_secs(175)));
        assert!(liveness.is_stale(frame_at + Duration::from_secs(181)));
    }

    #[test]
    fn test_register_stream() {
        let (shutdown_tx, _) = mpsc::channel(1);
        let auth = crate::auth::new_shared_auth_state(0);
        let dev_state = crate::dev::new_shared_dev_state();
        let mut router = FeedRouter::new("test".into(), auth, shutdown_tx, dev_state);

        let (tx, _) = broadcast::channel(16);
        router.register_stream(FeedId::TERMINAL_OUTPUT, tx, LagPolicy::Bootstrap);

        assert!(router.stream_outputs.contains_key(&FeedId::TERMINAL_OUTPUT));
        let (_, policy) = &router.stream_outputs[&FeedId::TERMINAL_OUTPUT];
        assert_eq!(*policy, LagPolicy::Bootstrap);
    }

    #[test]
    fn test_register_stream_with_replay() {
        let (shutdown_tx, _) = mpsc::channel(1);
        let auth = crate::auth::new_shared_auth_state(0);
        let dev_state = crate::dev::new_shared_dev_state();
        let mut router = FeedRouter::new("test".into(), auth, shutdown_tx, dev_state);

        let (tx, _) = broadcast::channel(16);
        let replay = ReplayBuffer::new(100);
        router.register_stream(FeedId::CODE_OUTPUT, tx, LagPolicy::Replay(replay));

        let (_, policy) = &router.stream_outputs[&FeedId::CODE_OUTPUT];
        assert_eq!(*policy, LagPolicy::Replay(ReplayBuffer::new(0)));
    }

    #[test]
    fn test_register_input() {
        let (shutdown_tx, _) = mpsc::channel(1);
        let auth = crate::auth::new_shared_auth_state(0);
        let dev_state = crate::dev::new_shared_dev_state();
        let mut router = FeedRouter::new("test".into(), auth, shutdown_tx, dev_state);

        let (tx, _rx) = mpsc::channel(16);
        router.register_input(FeedId::TERMINAL_INPUT, tx.clone());
        router.register_input(FeedId::TERMINAL_RESIZE, tx);

        assert!(router.input_sinks.contains_key(&FeedId::TERMINAL_INPUT));
        assert!(router.input_sinks.contains_key(&FeedId::TERMINAL_RESIZE));
    }

    #[test]
    fn test_many_to_one_input() {
        let (shutdown_tx, _) = mpsc::channel(1);
        let auth = crate::auth::new_shared_auth_state(0);
        let dev_state = crate::dev::new_shared_dev_state();
        let mut router = FeedRouter::new("test".into(), auth, shutdown_tx, dev_state);

        let (tx, mut rx) = mpsc::channel(16);
        router.register_input(FeedId::TERMINAL_INPUT, tx.clone());
        router.register_input(FeedId::TERMINAL_RESIZE, tx);

        let input_tx = router.input_sinks.get(&FeedId::TERMINAL_INPUT).unwrap();
        input_tx
            .try_send(Frame::new(FeedId::TERMINAL_INPUT, b"key".to_vec()))
            .unwrap();

        let resize_tx = router.input_sinks.get(&FeedId::TERMINAL_RESIZE).unwrap();
        resize_tx
            .try_send(Frame::new(FeedId::TERMINAL_RESIZE, b"resize".to_vec()))
            .unwrap();

        let f1 = rx.try_recv().unwrap();
        let f2 = rx.try_recv().unwrap();
        assert_eq!(f1.feed_id, FeedId::TERMINAL_INPUT);
        assert_eq!(f2.feed_id, FeedId::TERMINAL_RESIZE);
    }

    #[test]
    fn test_client_id_counter() {
        let (shutdown_tx, _) = mpsc::channel(1);
        let auth = crate::auth::new_shared_auth_state(0);
        let dev_state = crate::dev::new_shared_dev_state();
        let router = FeedRouter::new("test".into(), auth, shutdown_tx, dev_state);

        assert_eq!(router.next_client_id(), 1);
        assert_eq!(router.next_client_id(), 2);
        assert_eq!(router.next_client_id(), 3);
    }
}
