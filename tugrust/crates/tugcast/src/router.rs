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

use parking_lot::Mutex;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
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

use tugcast_core::{BusFrom, BusOutbound, BusRole, BusTarget};
use tugcast_core::{
    CLOSE_BAD_HANDSHAKE, CLOSE_HANDSHAKE_TIMEOUT, CLOSE_VERSION_MISMATCH, ControlAction, FeedId,
    Frame, HANDSHAKE_TIMEOUT, PROTOCOL_NAME, PROTOCOL_VERSION, PageIdentity, PageRole,
    TugSessionId, parse_page_hello,
};

use crate::auth::{self, SharedAuthState};
use crate::feeds::agent_supervisor::{AgentSupervisor, ControlError, ControlOutcome};
use crate::feeds::code::parse_tug_session_id;
use crate::feeds::terminal;
use crate::pages::{AddressedFrame, ClientFrame, PageRegistry, PageTarget, SessionSubscription};

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

    /// The tick's question, with the host's word in it: a body the host has
    /// declared dormant is quiet on purpose ([B05]), so its silence is not
    /// evidence of a dead wire. The declaration is taken as proof of life, so
    /// the window starts fresh from the tick the declaration is withdrawn
    /// rather than from a frame sent before the body went quiet.
    fn is_stale_unless_vouched(&mut self, now: Instant, vouched: bool) -> bool {
        if vouched {
            self.record_frame(now);
            return false;
        }
        self.is_stale(now)
    }
}

// ---------------------------------------------------------------------------
// InputOwnership — single-writer-per-(FeedId, tug_session_id) enforcement (P5)
// ---------------------------------------------------------------------------

/// Shared map tracking which page owns each `(FeedId, Option<TugSessionId>)`
/// key. Non-session-scoped single-writer inputs (TERMINAL_INPUT,
/// TERMINAL_RESIZE) use `None`; CODE_INPUT uses `Some(tug_session_id)` so
/// distinct sessions can coexist under multiple writers, one per session.
/// An owner whose `client_id` is 0 holds nothing. Per [D08].
type InputOwnership = Arc<Mutex<HashMap<(FeedId, Option<TugSessionId>), InputOwner>>>;

/// The page that owns an input key: its connection, and the card it renders
/// when it is a body page.
#[derive(Debug, Clone, PartialEq, Eq)]
struct InputOwner {
    client_id: u64,
    card_id: Option<String>,
}

impl From<u64> for InputOwner {
    /// A page that renders no card.
    fn from(client_id: u64) -> Self {
        Self {
            client_id,
            card_id: None,
        }
    }
}

/// Whether a card seats a session — the supervisor's answer in production,
/// a fixed one in the admission tests.
#[async_trait::async_trait]
trait CardSeats: Send + Sync {
    async fn card_seats_session(&self, card_id: &str, session: &TugSessionId) -> bool;
}

#[async_trait::async_trait]
impl CardSeats for AgentSupervisor {
    async fn card_seats_session(&self, card_id: &str, session: &TugSessionId) -> bool {
        AgentSupervisor::card_seats_session(self, card_id, session).await
    }
}

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

/// One client's forwarder for one broadcast sender: every frame into the
/// merged snapshot channel, and on a lag the sender's own lag frame.
///
/// Split out of the client loop so the lag path can be driven directly — an
/// overflow needs a receiver that nobody is reading, which is awkward to
/// arrange through a whole websocket handshake and trivial to arrange here.
async fn forward_broadcast(
    mut bcast_rx: broadcast::Receiver<Frame>,
    snap_tx: mpsc::Sender<Frame>,
    lag_frame: Option<Frame>,
) {
    loop {
        match bcast_rx.recv().await {
            Ok(frame) => {
                if snap_tx.send(frame).await.is_err() {
                    break;
                }
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                warn!(skipped = n, "broadcast snapshot stream lagged");
                // Tell the client it missed frames, in this feed's own
                // vocabulary. A silent lag leaves a client rendering a state
                // it may have missed the correction to.
                if let Some(frame) = lag_frame.clone() {
                    if snap_tx.send(frame).await.is_err() {
                        break;
                    }
                }
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

/// One client's forwarder for one addressed lane: the frames whose delivery
/// names this client into the merged snapshot channel, and on a lag the
/// lane's own lag frame. Every connection reads every lane and keeps what is
/// its own; the address rides beside the frame, so the frame is forwarded as
/// it was published.
async fn forward_addressed(
    mut rx: broadcast::Receiver<AddressedFrame>,
    snap_tx: mpsc::Sender<Frame>,
    lag_frame: Option<Frame>,
    client_id: u64,
) {
    loop {
        match rx.recv().await {
            Ok(addressed) => {
                if addressed.to.admits(client_id) && snap_tx.send(addressed.frame).await.is_err() {
                    break;
                }
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                warn!(client_id, skipped = n, "addressed lane lagged");
                if let Some(frame) = lag_frame.clone() {
                    if snap_tx.send(frame).await.is_err() {
                        break;
                    }
                }
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
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
    /// The feeds registered through `register_session_feed`, whose frames
    /// carry a `tug_session_id` and are filtered by each page's session
    /// subscription ([P08]).
    session_feeds: Arc<HashSet<FeedId>>,
    /// FeedId → the backend each input feed (client → server) is sent to.
    input_sinks: HashMap<FeedId, InputSink>,
    /// Snapshot watch receivers, keyed by the feed each carries (delivered
    /// to every client on connect, and re-delivered when a subscription
    /// later adds that feed).
    snapshot_watches: Vec<(FeedId, watch::Receiver<Frame>)>,
    /// Multi-producer broadcast senders. Each client clones the FeedRouter
    /// and at `ClientState::Live` calls `subscribe()` on every entry here
    /// to get its own receiver, then spawns a forwarder that `recv()`s
    /// frames and pushes them to the socket. Unlike `snapshot_watches`
    /// (which carry "latest value" with collision risk under concurrent
    /// producers), this list holds event streams safe to fan in from
    /// many producers. Used by the FILETREE multi-workspace response
    /// path per `arc/dev-atoms.md#step-pre-4`.
    /// Each entry carries an optional LAG FRAME: what to hand the client
    /// when its own forwarder falls behind and the buffer drops frames.
    /// Without one, a client that missed frames is told nothing and goes on
    /// rendering a state it may have missed the correction to.
    snapshot_broadcast_senders: Vec<(broadcast::Sender<Frame>, Option<Frame>)>,
    /// Addressed lanes: each connection subscribes every one at
    /// `ClientState::Live` and forwards only the frames addressed to it,
    /// with the lane's lag frame when its receiver falls behind.
    addressed_senders: Vec<(broadcast::Sender<AddressedFrame>, Option<Frame>)>,
    /// The page lane: every tell, eval, ask and `ask-rescind` addressed to a
    /// page. One FIFO lane, so a frame published after another arrives after
    /// it at every connection both are addressed to. tugcast's own CONTROL
    /// broadcasts stay on the CONTROL stream.
    pub(crate) page_lane: broadcast::Sender<AddressedFrame>,

    /// Tracks which client owns each `(input FeedId, tug_session_id?)` key
    /// (P5 single-writer guard, relaxed per [D08]).
    input_ownership: InputOwnership,
    /// Counter for assigning unique client IDs.
    client_id_counter: Arc<AtomicU64>,
    /// Process-global per-feed counters. `FeedRouter` is `Clone` and cloned
    /// per connection, so the `Arc` is shared rather than duplicated.
    feed_counters: Arc<GlobalFeedCounters>,

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
    /// The request/reply line to the host app, for `/api/host/state`.
    pub(crate) host_link: crate::control::HostLink,
    /// The Haiku `SharedAgent`, once `main` has built one.
    pub(crate) shared_agent: crate::shared_agent::SharedAgentHandle,
    /// The wheel's pending-rotation and hand-back registries, once `main`
    /// has built them. `POST /api/session` parks into these; the drain task
    /// spawned beside the arc engine empties them on the turn-end tick.
    pub(crate) wheel: Option<Arc<crate::wheel::WheelState>>,
    /// Which page is on each connection. `boot` replaces the default with
    /// the one registry it shares with every per-page service.
    pub(crate) pages: Arc<PageRegistry>,
}

/// Pending eval requests awaiting responses from the browser.
pub(crate) type PendingEvals =
    Arc<parking_lot::Mutex<HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>>>;

/// Pending ask requests awaiting a human answer in the deck.
///
/// Same shape as [`PendingEvals`], but the waits are long: an eval resolves in
/// milliseconds, an ask sits until someone reads a dialog and clicks. The two
/// maps are kept separate so a slow human can never occupy a slot that
/// diagnostics tooling expects to turn over quickly.
pub(crate) type PendingAsks =
    Arc<parking_lot::Mutex<HashMap<String, tokio::sync::oneshot::Sender<String>>>>;

impl FeedRouter {
    /// Create a new feed router with shared infrastructure channels.
    pub(crate) fn new(
        session: String,
        auth: SharedAuthState,
        shutdown_tx: mpsc::Sender<u8>,
        dev_state: crate::dev::SharedDevState,
    ) -> Self {
        let (page_lane, _) = broadcast::channel(BROADCAST_CAPACITY);
        let lane_lag = Frame::control(
            FeedId::CONTROL,
            serde_json::to_vec(&serde_json::json!({"type": "lag_detected", "lane": "page"}))
                .expect("a json! value serializes"),
        );
        Self {
            stream_outputs: HashMap::new(),
            session_feeds: Arc::new(HashSet::new()),
            input_sinks: HashMap::new(),
            snapshot_watches: Vec::new(),
            snapshot_broadcast_senders: Vec::new(),
            addressed_senders: vec![(page_lane.clone(), Some(lane_lag))],
            page_lane,
            input_ownership: Arc::new(Mutex::new(HashMap::new())),
            client_id_counter: Arc::new(AtomicU64::new(1)),
            feed_counters: Arc::new(GlobalFeedCounters::default()),
            supervisor: None,
            session,
            auth,
            shutdown_tx,
            dev_state,
            pending_evals: Arc::new(parking_lot::Mutex::new(HashMap::new())),
            pending_asks: Arc::new(parking_lot::Mutex::new(HashMap::new())),
            host_link: crate::control::HostLink::default(),
            shared_agent: None,
            wheel: None,
            pages: Arc::new(PageRegistry::new()),
        }
    }

    /// Borrow the router state `dispatch_action` needs.
    ///
    /// `default_to` is where a tell with no `to` of its own goes: every
    /// connection for one client reaching the others over the WebSocket, the
    /// shell for a host or HTTP tell.
    pub(crate) fn action_context(
        &self,
        default_to: PageTarget,
    ) -> crate::actions::ActionContext<'_> {
        crate::actions::ActionContext {
            shutdown_tx: &self.shutdown_tx,
            stream_outputs: &self.stream_outputs,
            dev_state: &self.dev_state,
            pending_evals: &self.pending_evals,
            pending_asks: &self.pending_asks,
            shared_agent: &self.shared_agent,
            page_lane: &self.page_lane,
            pages: &self.pages,
            default_to,
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
    /// The feed id is recorded as session-scoped, so each connection's
    /// session subscription filters it.
    pub(crate) fn register_session_feed(
        &mut self,
        feed: &crate::feeds::session_scoped::SessionScopedFeed,
    ) {
        self.stream_outputs
            .insert(feed.feed_id(), (feed.sender(), feed.lag_policy()));
        Arc::make_mut(&mut self.session_feeds).insert(feed.feed_id());
    }

    /// Register an input sink (client → server backend).
    pub(crate) fn register_input(&mut self, feed_id: FeedId, tx: mpsc::Sender<Frame>) {
        self.input_sinks.insert(feed_id, InputSink::Plain(tx));
    }

    /// Register an input whose backend answers the page that asked: each
    /// frame is sent with the sender's `client_id`, which the router sets
    /// and a page cannot forge.
    pub(crate) fn register_addressed_input(
        &mut self,
        feed_id: FeedId,
        tx: mpsc::Sender<ClientFrame>,
    ) {
        self.input_sinks.insert(feed_id, InputSink::Addressed(tx));
    }

    /// Attach the multi-session supervisor. Called from `main.rs` after the
    /// supervisor is constructed. Once set, `handle_client` routes session
    /// lifecycle CONTROL frames through `AgentSupervisor::handle_control`
    /// and enforces the P5 authorization cross-check on CODE_INPUT.
    pub(crate) fn set_supervisor(&mut self, supervisor: Arc<AgentSupervisor>) {
        self.supervisor = Some(supervisor);
    }

    /// Add snapshot watches (delivered on connect + forwarded on change).
    ///
    /// Each watch's key is derived from its own current value: every
    /// registered watch is seeded with a frame carrying its feed id, so no
    /// call site has to name it and this signature can stand.
    pub(crate) fn add_snapshot_watches(&mut self, watches: Vec<watch::Receiver<Frame>>) {
        self.snapshot_watches.extend(watches.into_iter().map(|rx| {
            let feed_id = rx.borrow().feed_id;
            (feed_id, rx)
        }));
    }

    /// Add multi-producer broadcast senders. Each connected client
    /// subscribes a fresh receiver from every sender in this list and
    /// spawns a forwarder task at `ClientState::Live`. Unlike
    /// `add_snapshot_watches` there is no "deliver on connect" pass —
    /// broadcast streams are event-only (no retained latest value), so
    /// clients only see frames published *after* their forwarder
    /// subscribes. Used for the FILETREE multi-workspace response fan-in.
    pub(crate) fn add_broadcast_senders(&mut self, senders: Vec<broadcast::Sender<Frame>>) {
        self.snapshot_broadcast_senders
            .extend(senders.into_iter().map(|tx| (tx, None)));
    }

    /// Add one broadcast sender together with the frame to forward when a
    /// client's forwarder lags.
    ///
    /// A lag is a silent hole in an event stream, and the only honest answer
    /// is to say so: the frame goes into the merged channel in the dropped
    /// frames' place, and the client re-asks for what it holds rather than
    /// trusting it.
    pub(crate) fn add_broadcast_sender_with_lag_frame(
        &mut self,
        sender: broadcast::Sender<Frame>,
        lag_frame: Frame,
    ) {
        self.snapshot_broadcast_senders
            .push((sender, Some(lag_frame)));
    }

    /// Register an addressed lane. Each connection forwards only the frames
    /// whose delivery names it, and `lag_frame` in their place when its
    /// receiver falls behind. The page lane is registered in `new`; the
    /// per-page reply lanes are the callers this is for.
    pub(crate) fn register_addressed_stream(
        &mut self,
        sender: broadcast::Sender<AddressedFrame>,
        lag_frame: Option<Frame>,
    ) {
        self.addressed_senders.push((sender, lag_frame));
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
    // The connection keeps the session it opened with alive: the deck's
    // `/api/*` requests ride the same cookie, and a deck left open but idle
    // must not find it expired.
    let session_id = auth::extract_session_cookie(&headers);
    ws.on_upgrade(move |socket| handle_client(socket, router, session_id))
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
/// It also tells the connection its own `client_id` and echoes the page
/// identity the hello stated, so a page can see what tugcast took it for.
///
/// And it names this tugcast process: `server_id` is minted once per process
/// start ([`server_id`]), so a page that reconnects can tell the server it
/// left from a restarted one by comparing the id it held with the one it gets.
fn build_handshake_response(client_id: u64, identity: &PageIdentity) -> serde_json::Value {
    serde_json::json!({
        "protocol": PROTOCOL_NAME,
        "version": PROTOCOL_VERSION,
        "capabilities": [],
        "host": { "os": "macos", "version": host_os_version() },
        "client_id": client_id,
        "page": identity,
        "server_id": server_id(),
    })
}

/// This tugcast process's identity on the wire: a fresh UUID minted the first
/// time it is read and the same for every connection after, until the process
/// exits. It is a fact about the process, not about any session, so it rides
/// the connection-level handshake rather than a session frame.
pub(crate) fn server_id() -> &'static str {
    static SERVER_ID: std::sync::LazyLock<String> =
        std::sync::LazyLock::new(|| uuid::Uuid::new_v4().to_string());
    &SERVER_ID
}

/// Perform the protocol handshake at WebSocket connection open.
///
/// Returns the page identity the hello stated (a tool when it stated none),
/// or `None` when the handshake failed and the socket is done.
///
/// The page is registered BEFORE the reply is sent: the reply is the page's
/// licence to act as connected, so by the time it can read it the page must
/// already be listed and addressable. Registering after the send left a
/// window where a page holding its reply was absent from `/api/pages` and
/// unreachable by anything addressed to it. A reply that fails to send
/// departs the page again.
async fn perform_handshake(
    socket: &mut WebSocket,
    client_id: u64,
    pages: &PageRegistry,
) -> Option<PageIdentity> {
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
            return None;
        }
        Ok(Some(Err(e))) => {
            warn!("Handshake failed: WebSocket error: {}", e);
            return None;
        }
        Ok(None) => {
            info!("Client disconnected before handshake");
            return None;
        }
        Err(_) => {
            warn!("Handshake timed out");
            let _ = socket
                .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code: CLOSE_HANDSHAKE_TIMEOUT,
                    reason: "handshake timeout".into(),
                })))
                .await;
            return None;
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
            return None;
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
        return None;
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
        return None;
    }

    let identity = match parse_page_hello(&hello_json) {
        Ok(identity) => identity,
        Err(reason) => {
            warn!("Handshake failed: bad page identity: {}", reason);
            let _ = socket
                .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code: CLOSE_BAD_HANDSHAKE,
                    reason: format!("bad page identity: {reason}").into(),
                })))
                .await;
            return None;
        }
    };

    let response = build_handshake_response(client_id, &identity);
    pages.register(client_id, &identity);
    if socket
        .send(Message::Text(response.to_string().into()))
        .await
        .is_err()
    {
        info!("Client disconnected during handshake response");
        pages.depart(client_id);
        return None;
    }

    info!(
        client_id,
        role = identity.role.as_str(),
        "Protocol handshake complete (v{})",
        PROTOCOL_VERSION
    );
    Some(identity)
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
// Per-feed counters
// ---------------------------------------------------------------------------

/// The per-connection counter table, owned by the [`ClientSink`].
///
/// The feed-id namespace is a `u8`, so 256 rows is exhaustive by
/// construction: an unknown feed id is counted rather than dropped from the
/// accounting. Single-task ownership is what lets these be plain `u64` with
/// no synchronization at all.
struct FeedCounters {
    frames: [u64; 256],
    bytes: [u64; 256],
    dropped: [u64; 256],
}

impl FeedCounters {
    fn new() -> Self {
        Self {
            frames: [0; 256],
            bytes: [0; 256],
            dropped: [0; 256],
        }
    }

    fn record_sent(&mut self, feed: FeedId, byte_len: usize) {
        let i = feed.as_byte() as usize;
        self.frames[i] += 1;
        self.bytes[i] += byte_len as u64;
    }

    /// A dropped frame increments this column *instead of* frames/bytes,
    /// never both.
    fn record_dropped(&mut self, feed: FeedId) {
        self.dropped[feed.as_byte() as usize] += 1;
    }
}

/// The process-global counter table, held on [`FeedRouter`] behind an `Arc`
/// and shared by every connection.
///
/// A fixed 256-wide atomic array has no map lookup, no lock, and no
/// allocation, so counting can never gate a frame. Relaxed ordering is
/// correct because nothing reads these counters to establish a happens-before
/// relationship; they are telemetry.
struct GlobalFeedCounters {
    frames: [AtomicU64; 256],
    bytes: [AtomicU64; 256],
    dropped: [AtomicU64; 256],
}

impl Default for GlobalFeedCounters {
    fn default() -> Self {
        Self {
            frames: std::array::from_fn(|_| AtomicU64::new(0)),
            bytes: std::array::from_fn(|_| AtomicU64::new(0)),
            dropped: std::array::from_fn(|_| AtomicU64::new(0)),
        }
    }
}

impl GlobalFeedCounters {
    fn record_sent(&self, feed: FeedId, byte_len: usize) {
        let i = feed.as_byte() as usize;
        self.frames[i].fetch_add(1, Ordering::Relaxed);
        self.bytes[i].fetch_add(byte_len as u64, Ordering::Relaxed);
    }

    fn record_dropped(&self, feed: FeedId) {
        self.dropped[feed.as_byte() as usize].fetch_add(1, Ordering::Relaxed);
    }
}

/// Does this connection's subscription admit a frame on `feed_id`? ([P04])
///
/// `CONTROL` and `HEARTBEAT` are the control and liveness planes and are
/// always admitted — a client that could unsubscribe its own liveness could
/// hang itself. `DECK_BUS` is admitted too: a bus frame reaches only the
/// pages it was addressed to, so addressing already scopes it. A `None`
/// subscription means everything, which is the state of every connection
/// that has said nothing, and is what makes the filter wire-compatible on
/// the day it ships.
fn admits(subscription: Option<&HashSet<FeedId>>, feed_id: FeedId) -> bool {
    if feed_id == FeedId::CONTROL || feed_id == FeedId::HEARTBEAT || feed_id == FeedId::DECK_BUS {
        return true;
    }
    match subscription {
        None => true,
        Some(set) => set.contains(&feed_id),
    }
}

/// Carry one `DECK_BUS` frame from a page to the pages it names (Spec S06).
///
/// tugcast reads the envelope's `to` and `kind` and carries every other
/// field through verbatim. The sender is stamped from `from`, the identity
/// its hello registered, so a `from` in the envelope is dropped. A tool is
/// refused, an envelope with no target or an unknown kind is malformed, and
/// a target no live page answers is undeliverable; each refusal is the
/// CONTROL error the sender gets back.
/// A delivery rides the page lane, so it is ordered with every tell.
fn route_bus(
    pages: &PageRegistry,
    page_lane: &broadcast::Sender<AddressedFrame>,
    from: &PageIdentity,
    payload: &[u8],
) -> Result<(), serde_json::Value> {
    let error = |detail: &str| serde_json::json!({ "type": "error", "detail": detail });
    let role = match from.role {
        PageRole::Shell => BusRole::Shell,
        PageRole::Body => BusRole::Body,
        PageRole::Tool => return Err(error("bus_refused")),
    };
    let Ok(outbound) = serde_json::from_slice::<BusOutbound>(payload) else {
        return Err(error("bus_malformed"));
    };
    let target = match &outbound.to {
        BusTarget::Role(BusRole::Shell) => PageTarget::Shell,
        BusTarget::Role(BusRole::Body) => PageTarget::Bodies,
        BusTarget::Card { card } => PageTarget::Card(card.clone()),
        BusTarget::Page { page } => PageTarget::Page(page.clone()),
    };
    let Some(to) = pages.resolve(&target) else {
        let mut refusal = error("bus_undeliverable");
        refusal["to"] = serde_json::to_value(&outbound.to).unwrap_or_default();
        return Err(refusal);
    };
    let delivered = outbound.deliver(BusFrom {
        page_id: from.page_id.clone().unwrap_or_default(),
        role,
        card_id: from.card_id.clone(),
    });
    let Ok(bytes) = serde_json::to_vec(&delivered) else {
        return Err(error("bus_malformed"));
    };
    // A send with no receiver means no connection is live to take it.
    let _ = page_lane.send(AddressedFrame {
        to,
        frame: Frame::new(FeedId::DECK_BUS, bytes),
    });
    Ok(())
}

/// Answer a `page_bind`: a spare body page taking its card.
///
/// On acceptance the registry's record and both of the connection's own
/// copies of its card take the new id — `identity`, which stamps the bus's
/// `from` and `feed_stats`, and `page_card`, which is what
/// `authorize_and_claim_input` reads to let a body write the session its card
/// seats; a bound spare left holding its old card could never write its own
/// session. The reply is `page_bound` or `page_bind_refused`, and a refusal
/// changes nothing.
fn apply_page_bind(
    pages: &PageRegistry,
    client_id: u64,
    identity: &mut PageIdentity,
    page_card: &mut Option<String>,
    payload: &serde_json::Value,
) -> serde_json::Value {
    let card = payload
        .get("card_id")
        .and_then(|c| c.as_str())
        .unwrap_or("");
    match pages.bind_card(client_id, card) {
        Ok(()) => {
            identity.card_id = Some(card.to_owned());
            *page_card = Some(card.to_owned());
            serde_json::json!({ "action": "page_bound", "card_id": card })
        }
        Err(refusal) => serde_json::json!({
            "action": "page_bind_refused",
            "detail": refusal.detail(),
        }),
    }
}

/// Parse a `subscribe_feeds` payload into a full replacement set (Spec S01).
///
/// `None` means the message was malformed — a missing or non-array `feeds`
/// field — and the caller leaves the connection's subscription untouched.
/// Resetting to "everything" on a malformed message would be a silent way to
/// lose a filter. Values that do not coerce to a `u8` are skipped rather than
/// rejected, so one bad entry does not discard the whole set; an empty array
/// is legal and means "nothing but the exemptions".
fn parse_subscribe_feeds(payload: &serde_json::Value) -> Option<HashSet<FeedId>> {
    let feeds = payload.get("feeds")?.as_array()?;
    Some(
        feeds
            .iter()
            .filter_map(|v| v.as_u64())
            .filter_map(|n| u8::try_from(n).ok())
            .map(FeedId)
            .collect(),
    )
}

/// Parse the session half of a `subscribe_feeds` payload (Spec S04).
///
/// An absent `sessions`, or `"all"`, is every session: the message is a
/// full replacement, so saying nothing resets a narrowed filter. An array
/// of strings is exactly those ids, and `[]` is none. Anything else is
/// malformed and answers `None`, which leaves both sets alone. Unlike the
/// feed list, one non-string entry refuses the whole set, because an id the
/// page meant and the router skipped is a session the page silently loses.
fn parse_subscribe_sessions(payload: &serde_json::Value) -> Option<SessionSubscription> {
    match payload.get("sessions") {
        None => Some(SessionSubscription::All),
        Some(serde_json::Value::String(s)) if s == "all" => Some(SessionSubscription::All),
        Some(serde_json::Value::Array(ids)) => ids
            .iter()
            .map(|v| v.as_str().map(str::to_string))
            .collect::<Option<HashSet<String>>>()
            .map(SessionSubscription::Only),
        Some(_) => None,
    }
}

/// The `tug_session_id` a session-scoped frame carries ([P08]).
///
/// The hot path reads the leading `{"tug_session_id":"…"` that
/// `splice_tug_session_id` writes, without a parse. A frame whose id is not
/// first (`build_session_state_frame` serializes with sorted keys), or whose
/// id carries an escape, falls back to a full parse. `None` means the frame
/// names no session, and the caller admits it.
fn session_of(payload: &[u8]) -> Option<Cow<'_, str>> {
    const PREFIX: &[u8] = b"{\"tug_session_id\":\"";
    let start = payload.iter().position(|b| !b.is_ascii_whitespace())?;
    if let Some(rest) = payload[start..].strip_prefix(PREFIX) {
        if let Some(end) = rest.iter().position(|b| *b == b'"' || *b == b'\\') {
            if rest[end] == b'"' {
                if let Ok(id) = std::str::from_utf8(&rest[..end]) {
                    return Some(Cow::Borrowed(id));
                }
            }
        }
    }
    parse_tug_session_id(payload).map(Cow::Owned)
}

/// Does a connection's session subscription admit `frame`? ([P08])
///
/// Only a frame on a session-scoped feed that names a session can be
/// refused, and a connection taking every session never reads the payload.
fn admits_session(
    sessions: &SessionSubscription,
    session_feeds: &HashSet<FeedId>,
    frame: &Frame,
) -> bool {
    if matches!(sessions, SessionSubscription::All) || !session_feeds.contains(&frame.feed_id) {
        return true;
    }
    session_of(&frame.payload).is_none_or(|id| sessions.admits(&id))
}

/// Does a body the host has declared dormant take `frame`? ([B05])
///
/// A dormant body hears nothing of any session — the subscription its own
/// dormancy would empty, emptied by the host's word, which a page whose
/// JavaScript WebKit has suspended cannot race. A frame that names no
/// session, or is on a feed that is not session-scoped, still passes, as it
/// does for a page scoped to no session.
fn admits_while_dormant(session_feeds: &HashSet<FeedId>, frame: &Frame) -> bool {
    !session_feeds.contains(&frame.feed_id) || session_of(&frame.payload).is_none()
}

/// The card a `request_replay` wakes: a body's own catch-up ask (`reason:
/// "catch-up"`), which it sends only on its reveal ([B05]). Any other ask, or
/// one from a page that is not a body with a card, wakes nothing.
fn catch_up_wakes_card<'a>(
    identity: &'a PageIdentity,
    payload: &serde_json::Value,
) -> Option<&'a str> {
    if identity.role != PageRole::Body
        || payload.get("reason").and_then(|r| r.as_str()) != Some("catch-up")
    {
        return None;
    }
    identity.card_id.as_deref()
}

/// Build the `feed_stats` CONTROL response (Spec S02).
///
/// Pure over its arguments so it is unit-testable without a socket. Rows
/// whose three counters are all zero are omitted, which is what keeps the
/// response short rather than 256 rows long.
fn build_feed_stats_json(
    client_id: u64,
    page: &PageIdentity,
    subscribed: Option<&HashSet<FeedId>>,
    sessions: &SessionSubscription,
    conn: &FeedCounters,
    global: &GlobalFeedCounters,
) -> serde_json::Value {
    fn row(feed: u8, frames: u64, bytes: u64, dropped: u64) -> Option<serde_json::Value> {
        if frames == 0 && bytes == 0 && dropped == 0 {
            return None;
        }
        let mut obj = serde_json::json!({
            "feed": feed,
            "frames": frames,
            "bytes": bytes,
            "dropped": dropped,
        });
        if let Some(name) = FeedId(feed).name() {
            obj.as_object_mut()
                .expect("json! object")
                .insert("name".into(), name.into());
        }
        Some(obj)
    }

    let connection: Vec<serde_json::Value> = (0..=u8::MAX)
        .filter_map(|b| {
            let i = b as usize;
            row(b, conn.frames[i], conn.bytes[i], conn.dropped[i])
        })
        .collect();

    let global_rows: Vec<serde_json::Value> = (0..=u8::MAX)
        .filter_map(|b| {
            let i = b as usize;
            row(
                b,
                global.frames[i].load(Ordering::Relaxed),
                global.bytes[i].load(Ordering::Relaxed),
                global.dropped[i].load(Ordering::Relaxed),
            )
        })
        .collect();

    // `null` for a connection that has sent no `subscribe_feeds`, which is
    // deliberately distinguishable from `[]`. Sorted so the response is
    // deterministic across runs.
    let subscribed = match subscribed {
        None => serde_json::Value::Null,
        Some(set) => {
            let mut bytes: Vec<u8> = set.iter().map(|f| f.as_byte()).collect();
            bytes.sort_unstable();
            serde_json::Value::from(bytes)
        }
    };

    serde_json::json!({
        "type": "feed_stats",
        "client_id": client_id,
        "page": page,
        "subscribed": subscribed,
        "sessions": sessions,
        "connection": connection,
        "global": global_rows,
    })
}

// ---------------------------------------------------------------------------
// ClientSink: the single server-to-client gate
// ---------------------------------------------------------------------------

/// What became of a frame handed to [`ClientSink::send_frame`].
///
/// `Dropped` is what the subscription filter will answer once a connection
/// can name the feeds it wants. Nothing constructs it yet; the variant is
/// here so every call site is written once against its final shape. A
/// dropped frame is **not** a disconnect and must never trigger teardown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SendOutcome {
    Sent,
    Dropped,
    Disconnected,
}

impl SendOutcome {
    fn is_disconnected(self) -> bool {
        matches!(self, SendOutcome::Disconnected)
    }
}

/// The one thing in `handle_client` that holds the socket.
///
/// Every server-to-client frame is emitted by [`ClientSink::send_frame`],
/// which is what makes completeness structural rather than a review habit:
/// nothing else owns a `WebSocket`, so a ninth send site cannot be written
/// without reaching through the sink. The per-feed counters, the
/// subscription set, and the retained snapshot receivers land on this
/// struct in later steps.
struct ClientSink {
    socket: WebSocket,
    client_id: u64,
    /// The page identity this connection's hello stated.
    identity: PageIdentity,
    /// The feeds this connection asked for, or `None` if it has never asked.
    /// `None` is not "no feeds" — it is "everything", which is why an
    /// existing client that never learns the verb is unaffected.
    subscription: Option<HashSet<FeedId>>,
    /// The sessions this connection takes session-scoped frames for.
    sessions: SessionSubscription,
    /// The router's session-scoped feeds, shared by every connection.
    session_feeds: Arc<HashSet<FeedId>>,
    /// The cards whose body the host has declared dormant, from the page
    /// registry; read only when this connection is a body.
    dormant_cards: watch::Receiver<HashSet<String>>,
    /// This connection's own table. Plain `u64`s: the client task is its
    /// only writer.
    counters: FeedCounters,
    /// The process-global table, shared with every other connection.
    global_counters: Arc<GlobalFeedCounters>,
    /// One keyed clone per snapshot feed this connection was given at
    /// `ClientState::Live`, held so a later subscription can re-deliver a
    /// retained latest value. Stream feeds are deliberately absent: a
    /// broadcast has no retained value, so there is nothing to re-deliver.
    retained_watches: Vec<(FeedId, watch::Receiver<Frame>)>,
}

impl ClientSink {
    fn new(
        socket: WebSocket,
        client_id: u64,
        identity: PageIdentity,
        global_counters: Arc<GlobalFeedCounters>,
        session_feeds: Arc<HashSet<FeedId>>,
        dormant_cards: watch::Receiver<HashSet<String>>,
    ) -> Self {
        Self {
            socket,
            client_id,
            identity,
            subscription: None,
            sessions: SessionSubscription::All,
            session_feeds,
            dormant_cards,
            counters: FeedCounters::new(),
            global_counters,
            retained_watches: Vec::new(),
        }
    }

    /// The single gate: filter, encode once, count, send.
    ///
    /// A refused frame is dropped here and counted in the drop column — never
    /// queued and never drained, because there is no per-connection queue and
    /// an unsubscribe whose effect is deferred is worse than one that is
    /// exact. It costs no encode at all.
    ///
    /// A frame on a session-scoped feed is also refused when it names a
    /// session outside this connection's session subscription. Replay needs
    /// no rule of its own: lag-recovery replay and tugcode's replay frames
    /// pass through here on `CODE_OUTPUT` and are filtered the same way.
    async fn send_frame(&mut self, frame: Frame) -> SendOutcome {
        let feed_id = frame.feed_id;
        if !admits(self.subscription.as_ref(), feed_id)
            || !admits_session(&self.sessions, &self.session_feeds, &frame)
            || (self.declared_dormant() && !admits_while_dormant(&self.session_feeds, &frame))
        {
            self.counters.record_dropped(feed_id);
            self.global_counters.record_dropped(feed_id);
            return SendOutcome::Dropped;
        }
        let bytes = frame.encode();
        let byte_len = bytes.len();
        if self
            .socket
            .send(Message::Binary(bytes.into()))
            .await
            .is_ok()
        {
            self.counters.record_sent(feed_id, byte_len);
            self.global_counters.record_sent(feed_id, byte_len);
            SendOutcome::Sent
        } else {
            SendOutcome::Disconnected
        }
    }

    /// Whether this connection is a body whose card the host has declared
    /// dormant. Read per frame from the registry's watch, so a declaration
    /// takes effect on the next frame and survives the body's reconnects.
    fn declared_dormant(&self) -> bool {
        self.identity.role == PageRole::Body
            && self
                .identity
                .card_id
                .as_deref()
                .is_some_and(|card| self.dormant_cards.borrow().contains(card))
    }

    /// Send a JSON control frame (flags=CONTROL) to the client.
    /// Returns false if the client disconnected.
    async fn send_control_json(&mut self, feed_id: FeedId, json: &serde_json::Value) -> bool {
        let payload = serde_json::to_vec(json).unwrap_or_default();
        !self
            .send_frame(Frame::control(feed_id, payload))
            .await
            .is_disconnected()
    }
}

// ---------------------------------------------------------------------------
// Input ownership helpers (P5)
// ---------------------------------------------------------------------------

/// Try to claim an input `(FeedId, tug_session_id?)` key for the given
/// page. Returns `Ok(())` if the page owns it (or just claimed it), or
/// `Err(owner_id)` if another client owns it.
///
/// The `tug_session_id` argument is `None` for all non-CODE_INPUT feeds
/// (TERMINAL_INPUT, FILETREE_QUERY, TERMINAL_RESIZE) and
/// `Some(tug_session_id)` for CODE_INPUT. This enables one distinct writer
/// per session on CODE_INPUT per [D08].
fn try_claim_input(
    ownership: &InputOwnership,
    feed_id: FeedId,
    tug_session_id: Option<TugSessionId>,
    owner: impl Into<InputOwner>,
) -> Result<(), u64> {
    let owner = owner.into();
    let mut map = ownership.lock();
    let key = (feed_id, tug_session_id);
    match map.get(&key).map(|held| held.client_id) {
        None | Some(0) => {
            map.insert(key, owner);
            Ok(())
        }
        Some(held) if held == owner.client_id => Ok(()),
        Some(held) => Err(held),
    }
}

/// Hand an input key to `owner`, whoever held it. Returns the owner it
/// replaced.
fn take_over_input(
    ownership: &InputOwnership,
    feed_id: FeedId,
    tug_session_id: Option<TugSessionId>,
    owner: InputOwner,
) -> Option<InputOwner> {
    ownership.lock().insert((feed_id, tug_session_id), owner)
}

/// Where an input feed's frames go.
#[derive(Clone)]
pub(crate) enum InputSink {
    /// The frame alone: a backend that answers on a session-scoped or
    /// shared feed and keeps no per-page state.
    Plain(mpsc::Sender<Frame>),
    /// The frame and its sender, for a backend that answers the page that
    /// asked or keeps state per page.
    Addressed(mpsc::Sender<ClientFrame>),
}

impl InputSink {
    async fn send(&self, client_id: u64, frame: Frame) {
        // A backend that has gone away drops the frame, as it always has.
        let _ = match self {
            InputSink::Plain(tx) => tx.send(frame).await.map_err(|_| ()),
            InputSink::Addressed(tx) => tx
                .send(ClientFrame { client_id, frame })
                .await
                .map_err(|_| ()),
        };
    }
}

/// The inputs every page owns for itself: no page is ever refused
/// `input_claimed` on one of these, because each page's requests are its own
/// and their answers go back to it. The terminal pair stays single-writer —
/// there is one tmux pane — and `CODE_INPUT` stays single-writer per
/// session. An input listed nowhere is single-writer until it is added here.
pub(crate) const PER_PAGE_INPUTS: &[FeedId] = &[
    FeedId::SHELL_INPUT,
    FeedId::REFS_INPUT,
    FeedId::OVERVIEW_INPUT,
    FeedId::FILETREE_QUERY,
    FeedId::FILE_WATCH_QUERY,
    FeedId::GIT_DIFF_QUERY,
    FeedId::GIT_LOG_QUERY,
    FeedId::GIT_COMMIT_FILES_QUERY,
    FeedId::USAGE_QUERY,
    FeedId::RENDER_INPUT,
];

/// Release all input keys owned by the given client.
fn release_inputs(ownership: &InputOwnership, client_id: u64) {
    let mut map = ownership.lock();
    map.retain(|_, owner| owner.client_id != client_id);
}

/// Combined client teardown: release input ownership AND notify the
/// supervisor (if wired). Every path in `handle_client` that exits on
/// disconnect or error must route through this helper so per-client
/// supervisor state (`client_sessions`) cannot leak across reconnects.
async fn teardown_client(router: &FeedRouter, client_id: u64) {
    release_inputs(&router.input_ownership, client_id);
    router.pages.depart(client_id);
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
        // `HandledWith` carries a reply body for the HTTP tell bridge; the
        // WebSocket clients already received it as a CONTROL broadcast.
        ControlOutcome::Handled | ControlOutcome::HandledWith(_) => ControlIntercept::Handled,
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
        ControlOutcome::Error(ControlError::MissingLineId) => ControlIntercept::HandledError {
            detail: "missing_line_id",
        },
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
/// 0. A feed in [`PER_PAGE_INPUTS`]: `Forward`, always. Nothing is claimed.
/// 1. Other non-CODE_INPUT feeds: no session parsing, no authorization
///    check, key is `(feed_id, None)`.
/// 2. CODE_INPUT with no `tug_session_id` in payload: `MissingSession`. No
///    ownership mutation. (Hard reject per Step 7's wedge acknowledgement —
///    tugdeck `encodeCodeInput` must inject the field.)
/// 3. CODE_INPUT with a `tug_session_id` the client never registered via
///    `spawn_session`, from a page whose card does not seat it: `NotOwned`.
///    No ownership mutation. Closes the authorization gap where a client
///    that learned another client's UUID could race the legitimate owner
///    to claim the key. Skipped when `client_sessions` is `None` (Step 7
///    interim before main.rs wiring).
/// 4. Otherwise, attempt [`try_claim_input`] under the relaxed
///    `(FeedId, Option<TugSessionId>)` key and translate the result. A
///    body page whose card seats the session takes a claim another page
///    holds — a reloaded body is a new connection for the same card, and a
///    shell that spawned the session hands it to the card's own page.
///
/// `card` is the writing page's card and what can say whether that card
/// seats a session; `None` for a page that renders no card.
async fn authorize_and_claim_input(
    ownership: &InputOwnership,
    client_sessions: Option<&ClientSessionAffinity>,
    card: Option<(&str, &dyn CardSeats)>,
    feed_id: FeedId,
    payload: &[u8],
    client_id: u64,
) -> InputDecision {
    if PER_PAGE_INPUTS.contains(&feed_id) {
        return InputDecision::Forward;
    }
    let tug_session_id: Option<TugSessionId> = if feed_id == FeedId::CODE_INPUT {
        match parse_tug_session_id(payload) {
            Some(s) => Some(TugSessionId::new(s)),
            None => return InputDecision::MissingSession,
        }
    } else {
        None
    };

    // Whether the writing page's card seats the session. Asked at most
    // once, and only when a client-held rule has already said no.
    let mut seated: Option<bool> = None;
    let mut card_seats = async |session: &TugSessionId| -> bool {
        if let Some(known) = seated {
            return known;
        }
        let answer = match card {
            Some((card_id, seats)) => seats.card_seats_session(card_id, session).await,
            None => false,
        };
        seated = Some(answer);
        answer
    };

    if let (Some(sessions), Some(session)) = (client_sessions, &tug_session_id) {
        let registered = {
            let cs = sessions.lock().await;
            cs.get(&client_id).is_some_and(|set| set.contains(session))
        };
        if !registered && !card_seats(session).await {
            return InputDecision::NotOwned(session.clone());
        }
    }

    let owner = InputOwner {
        client_id,
        card_id: card.map(|(card_id, _)| card_id.to_owned()),
    };
    match try_claim_input(ownership, feed_id, tug_session_id.clone(), owner.clone()) {
        Ok(()) => InputDecision::Forward,
        Err(held) => match &tug_session_id {
            Some(session) if card_seats(session).await => {
                let previous = take_over_input(ownership, feed_id, tug_session_id.clone(), owner);
                info!(
                    client_id,
                    tug_session_id = session.as_str(),
                    from_client = held,
                    from_card = ?previous.and_then(|p| p.card_id),
                    "CODE_INPUT taken over by the page whose card seats the session"
                );
                InputDecision::Forward
            }
            _ => InputDecision::Claimed(held),
        },
    }
}

// ---------------------------------------------------------------------------
// handle_client
// ---------------------------------------------------------------------------

/// Handle a WebSocket client connection
async fn handle_client(mut socket: WebSocket, mut router: FeedRouter, session_id: Option<String>) {
    let client_id = router.next_client_id();
    info!(client_id, "Client connected");

    // --- Protocol handshake (v1) ---
    let Some(identity) = perform_handshake(&mut socket, client_id, &router.pages).await else {
        return;
    };
    // A body page's card: what lets it write the session its card seats. A
    // spare's changes once, at `page_bind`.
    let mut page_card = identity.card_id.clone();

    // Every open card re-announces its session from here; a bridge still in
    // nobody's set once that has settled is an orphan ([B07]). Armed only
    // once the registry knows the page, so a failed handshake arms nothing.
    if let Some(sup) = router.supervisor.as_ref() {
        sup.on_client_connect(client_id);
    }

    // From here on nothing holds the raw socket: every server-to-client
    // frame goes through the sink.
    let mut sink = ClientSink::new(
        socket,
        client_id,
        identity,
        Arc::clone(&router.feed_counters),
        Arc::clone(&router.session_feeds),
        router.pages.dormant_cards(),
    );

    // Build the StreamMap for output fan-in
    let (mut stream_map, lag_policies) = build_stream_map(&router.stream_outputs);

    let mut state = ClientState::Live;

    loop {
        match &mut state {
            ClientState::Bootstrap { feed_id, buffer } => {
                let lagged_feed = *feed_id;
                info!(client_id, %lagged_feed, "Client re-entering BOOTSTRAP state");

                // Send lag_detected control frame
                let _ = sink
                    .send_control_json(
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
                            if sink.send_frame(frame).await.is_disconnected() {
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
                    let _ = sink
                        .send_control_json(
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
                    if sink.send_frame(frame).await.is_disconnected() {
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
                for (feed_id, mut watch_rx) in snapshot_watches {
                    // Retain a keyed clone so a later `subscribe_feeds` that
                    // adds this feed can re-deliver its latest value ([P05]).
                    // The deck's own replay cache cannot cover that case: it
                    // is filled from frames that arrive, and under a
                    // subscription the frame never arrived.
                    sink.retained_watches.push((feed_id, watch_rx.clone()));
                    let frame = watch_rx.borrow_and_update().clone();
                    if !frame.payload.is_empty() && sink.send_frame(frame).await.is_disconnected() {
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
                for (tx, lag_frame) in snapshot_broadcasts {
                    let bcast_rx = tx.subscribe();
                    let snap_tx_clone = snap_tx.clone();
                    tokio::spawn(forward_broadcast(bcast_rx, snap_tx_clone, lag_frame));
                }

                // Addressed lanes: every connection reads every lane and
                // forwards what is addressed to it.
                for (tx, lag_frame) in std::mem::take(&mut router.addressed_senders) {
                    tokio::spawn(forward_addressed(
                        tx.subscribe(),
                        snap_tx.clone(),
                        lag_frame,
                        client_id,
                    ));
                }

                drop(snap_tx);

                let mut heartbeat_interval = time::interval(HEARTBEAT_INTERVAL);
                let mut liveness = ClientLiveness::new(Instant::now());

                use tokio_stream::StreamExt;

                loop {
                    tokio::select! {
                        Some(frame) = snap_rx.recv() => {
                            if sink.send_frame(frame).await.is_disconnected() {
                                info!(client_id, "Client disconnected");
                                teardown_client(&router, client_id).await;
                                return;
                            }
                        }

                        Some((feed_id, result)) = stream_map.next() => {
                            match result {
                                Ok(frame) => {
                                    if sink.send_frame(frame).await.is_disconnected() {
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
                                    // [P06]: a feed this connection did not
                                    // ask for can still lag, because every
                                    // client subscribes a receiver to every
                                    // stream feed. Recovering it would run a
                                    // tmux capture-pane, or push a whole
                                    // replay buffer at a gate that discards
                                    // every frame of it. The telemetry above
                                    // still fires, so the waterfall keeps no
                                    // blind spot.
                                    if !admits(sink.subscription.as_ref(), feed_id) {
                                        continue;
                                    }
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
                                            if !sink.send_control_json(feed_id, &serde_json::json!({
                                                "type": "lag_recovery",
                                                "feed_id": feed_id.as_byte()
                                            })).await {
                                                teardown_client(&router, client_id).await;
                                                return;
                                            }
                                            // Replay buffered frames
                                            for frame in replay_buf.snapshot() {
                                                if sink.send_frame(frame).await.is_disconnected() {
                                                    info!(client_id, "Client disconnected during replay");
                                                    teardown_client(&router, client_id).await;
                                                    return;
                                                }
                                            }
                                            // Send lag_recovery_complete
                                            if !sink.send_control_json(feed_id, &serde_json::json!({
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

                        msg = sink.socket.recv() => {
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
                                                    // Router-internal telemetry read. Matched
                                                    // ahead of the interceptor so it never
                                                    // reaches the supervisor or dispatch_action.
                                                    // The subscription argument is None until
                                                    // the connection can name its feeds.
                                                    let parsed = action.parse::<ControlAction>().ok();
                                                    // A body's catch-up ask is its reveal, said on
                                                    // the wire its answer rides: the card is shown,
                                                    // and the host's word to that effect, on another
                                                    // channel, may not have landed yet ([B05]).
                                                    if parsed == Some(ControlAction::RequestReplay) {
                                                        if let Some(card) = catch_up_wakes_card(&sink.identity, &payload) {
                                                            if router.pages.set_card_dormant(card, false) {
                                                                info!(client_id, card, "a body's catch-up withdrew its dormancy");
                                                            }
                                                        }
                                                    }
                                                    if parsed == Some(ControlAction::FeedStats) {
                                                        let stats = build_feed_stats_json(
                                                            sink.client_id,
                                                            &sink.identity,
                                                            sink.subscription.as_ref(),
                                                            &sink.sessions,
                                                            &sink.counters,
                                                            &sink.global_counters,
                                                        );
                                                        let _ = sink.send_control_json(FeedId::CONTROL, &stats).await;
                                                    } else if parsed == Some(ControlAction::PageBind) {
                                                        let reply = apply_page_bind(
                                                            &router.pages,
                                                            client_id,
                                                            &mut sink.identity,
                                                            &mut page_card,
                                                            &payload,
                                                        );
                                                        info!(client_id, reply = %reply, "page_bind answered");
                                                        let _ = sink.send_control_json(FeedId::CONTROL, &reply).await;
                                                    } else if parsed == Some(ControlAction::SubscribeFeeds) {
                                                        // A full replacement set (Spec S01).
                                                        // Idempotent, no delta form, no
                                                        // unsubscribe verb, no acknowledgement
                                                        // frame — the effect is observable in
                                                        // feed_stats and in what arrives.
                                                        // Both sets are parsed before
                                                        // either is applied, so a malformed
                                                        // half leaves the whole filter as it
                                                        // was (Spec S04).
                                                        match parse_subscribe_feeds(&payload).zip(parse_subscribe_sessions(&payload)) {
                                                            Some((set, sessions)) => {
                                                                // The add-set is a difference, not
                                                                // the whole set: a previous None
                                                                // already had everything, so a
                                                                // first subscribe_feeds adds
                                                                // nothing and re-delivers nothing.
                                                                let added: Vec<FeedId> = match &sink.subscription {
                                                                    None => Vec::new(),
                                                                    Some(prev) => set.difference(prev).copied().collect(),
                                                                };
                                                                debug!(client_id, feeds = set.len(), added = added.len(), "subscribe_feeds applied");
                                                                sink.subscription = Some(set);
                                                                router.pages.set_sessions(client_id, sessions.clone());
                                                                sink.sessions = sessions;
                                                                // Re-deliver each newly added
                                                                // snapshot feed's retained latest
                                                                // value. A feed with no retained
                                                                // watch — every stream feed — is
                                                                // skipped, which matches broadcast
                                                                // semantics exactly: there is no
                                                                // latest value to send.
                                                                for feed_id in added {
                                                                    let retained = sink
                                                                        .retained_watches
                                                                        .iter()
                                                                        .find(|(id, _)| *id == feed_id)
                                                                        .map(|(_, rx)| rx.borrow().clone());
                                                                    let Some(frame) = retained else { continue };
                                                                    if frame.payload.is_empty() {
                                                                        continue;
                                                                    }
                                                                    if sink.send_frame(frame).await.is_disconnected() {
                                                                        info!(client_id, "Client disconnected during subscription re-delivery");
                                                                        teardown_client(&router, client_id).await;
                                                                        return;
                                                                    }
                                                                }
                                                            }
                                                            None => {
                                                                warn!(client_id, "subscribe_feeds carried no feeds array or a malformed sessions field; subscription left unchanged");
                                                            }
                                                        }
                                                    } else {
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
                                                                    if parsed == Some(ControlAction::SpawnSession) {
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
                                                                let _ = sink.send_control_json(FeedId::CONTROL, &err).await;
                                                            }
                                                            ControlIntercept::PassThrough => {
                                                                crate::actions::dispatch_action(
                                                                    action,
                                                                    &frame.payload,
                                                                    &router.action_context(PageTarget::All),
                                                                ).await;
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        // Router-internal: the deck bus (Spec S06).
                                        // Answered on this socket loop, so a
                                        // refusal arrives before any later reply.
                                        else if fid == FeedId::DECK_BUS {
                                            if let Err(refusal) = route_bus(
                                                &router.pages,
                                                &router.page_lane,
                                                &sink.identity,
                                                &frame.payload,
                                            ) {
                                                warn!(client_id, detail = %refusal["detail"], "bus frame refused");
                                                let _ = sink.send_control_json(FeedId::CONTROL, &refusal).await;
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
                                                page_card.as_deref().zip(
                                                    router.supervisor.as_deref().map(|s| s as &dyn CardSeats),
                                                ),
                                                fid,
                                                &frame.payload,
                                                client_id,
                                            ).await;
                                            match decision {
                                                InputDecision::Forward => {
                                                    let sink = router.input_sinks.get(&fid).unwrap();
                                                    sink.send(client_id, frame).await;
                                                }
                                                InputDecision::MissingSession => {
                                                    warn!(
                                                        client_id,
                                                        "CODE_INPUT missing tug_session_id, rejecting"
                                                    );
                                                    let _ = sink.send_control_json(fid, &serde_json::json!({
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
                                                    let _ = sink.send_control_json(fid, &serde_json::json!({
                                                        "type": "error",
                                                        "detail": "session_not_owned",
                                                        "tug_session_id": session.as_str(),
                                                    })).await;
                                                }
                                                InputDecision::Claimed(owner) => {
                                                    warn!(client_id, %fid, owner, "Input claimed by another client");
                                                    let _ = sink.send_control_json(fid, &serde_json::json!({
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
                            if sink.send_frame(hb).await.is_disconnected() {
                                info!(client_id, "Client disconnected during heartbeat send");
                                teardown_client(&router, client_id).await;
                                return;
                            }
                            if liveness.is_stale_unless_vouched(Instant::now(), sink.declared_dormant()) {
                                warn!(client_id, "Heartbeat timeout, closing connection");
                                teardown_client(&router, client_id).await;
                                return;
                            }
                            if let Some(session_id) = &session_id {
                                router.auth.lock().validate_session(session_id);
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

    // ---- Broadcast forwarding and the lag frame ----

    /// A client that falls behind is TOLD, in the registering feed's own
    /// words. Registered without a lag frame it is told nothing, which is
    /// the behaviour every other broadcast feed still relies on.
    #[tokio::test]
    async fn a_lagged_forwarder_delivers_the_lag_frame() {
        // Capacity 1: two sends with nobody reading overflow the receiver.
        let (bcast_tx, _) = broadcast::channel::<Frame>(1);
        let (snap_tx, mut snap_rx) = mpsc::channel::<Frame>(16);
        let lag = Frame::new(FeedId::FILESYSTEM, b"{\"resync\":true}".to_vec());
        let rx = bcast_tx.subscribe();

        for i in 0..4u8 {
            let _ = bcast_tx.send(Frame::new(FeedId::FILESYSTEM, vec![i]));
        }
        tokio::spawn(forward_broadcast(rx, snap_tx, Some(lag.clone())));

        let frame = tokio::time::timeout(Duration::from_secs(2), snap_rx.recv())
            .await
            .expect("the lag frame arrives")
            .expect("the forwarder is live");
        assert_eq!(frame.payload, lag.payload);
    }

    #[tokio::test]
    async fn a_forwarder_with_no_lag_frame_says_nothing() {
        let (bcast_tx, _) = broadcast::channel::<Frame>(1);
        let (snap_tx, mut snap_rx) = mpsc::channel::<Frame>(16);
        let rx = bcast_tx.subscribe();

        for i in 0..4u8 {
            let _ = bcast_tx.send(Frame::new(FeedId::FILESYSTEM, vec![i]));
        }
        tokio::spawn(forward_broadcast(rx, snap_tx, None));

        // The last frame still in the buffer is the only thing forwarded —
        // no synthetic frame in the dropped ones' place.
        let frame = tokio::time::timeout(Duration::from_secs(2), snap_rx.recv())
            .await
            .expect("the surviving frame arrives")
            .expect("the forwarder is live");
        assert_eq!(frame.payload, vec![3u8]);
    }

    /// Ordinary traffic is forwarded verbatim, in order.
    #[tokio::test]
    async fn every_frame_reaches_the_merged_channel() {
        let (bcast_tx, _) = broadcast::channel::<Frame>(64);
        let (snap_tx, mut snap_rx) = mpsc::channel::<Frame>(64);
        tokio::spawn(forward_broadcast(bcast_tx.subscribe(), snap_tx, None));

        for i in 0..10u8 {
            let _ = bcast_tx.send(Frame::new(FeedId::FILESYSTEM, vec![i]));
        }
        for i in 0..10u8 {
            let frame = tokio::time::timeout(Duration::from_secs(2), snap_rx.recv())
                .await
                .expect("ten frames")
                .expect("the forwarder is live");
            assert_eq!(frame.payload, vec![i]);
        }
    }

    // ---- Handshake response ----

    #[test]
    fn handshake_response_carries_well_formed_host() {
        let r = build_handshake_response(7, &PageIdentity::tool());

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

    #[test]
    fn handshake_response_carries_client_id_and_page() {
        let identity = PageIdentity {
            role: tugcast_core::PageRole::Body,
            page_id: Some("p1".into()),
            card_id: Some("c1".into()),
        };
        let r = build_handshake_response(42, &identity);
        assert_eq!(r["client_id"], 42);
        assert_eq!(
            r["page"],
            serde_json::json!({"role": "body", "page_id": "p1", "card_id": "c1"})
        );

        let tool = build_handshake_response(3, &PageIdentity::tool());
        assert_eq!(
            tool["page"],
            serde_json::json!({"role": "tool", "page_id": null, "card_id": null})
        );
    }

    #[test]
    fn handshake_response_names_the_process_with_one_server_id() {
        // Every connection to this process hears the same id: a page that
        // reconnects and hears it again is talking to the server it left.
        let first = build_handshake_response(1, &PageIdentity::tool());
        let second = build_handshake_response(2, &PageIdentity::tool());
        let id = first["server_id"].as_str().expect("server_id is a string");
        assert!(
            uuid::Uuid::parse_str(id).is_ok(),
            "server_id is a uuid: {id}"
        );
        assert_eq!(second["server_id"], first["server_id"]);
        assert_eq!(id, server_id());
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
        assert!(
            router.session_feeds.contains(&FeedId::CODE_OUTPUT),
            "a session feed is recorded for the session filter"
        );
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
    async fn every_per_page_input_forwards_a_second_page_without_a_claim() {
        let ownership: InputOwnership = Arc::new(Mutex::new(HashMap::new()));
        for &feed in PER_PAGE_INPUTS {
            for client in [1, 2] {
                assert_eq!(
                    authorize_and_claim_input(&ownership, None, None, feed, b"{}", client).await,
                    InputDecision::Forward,
                    "page {client} owns its own requests on {feed:?}"
                );
            }
        }
        assert!(
            ownership.lock().is_empty(),
            "a per-page input claims nothing"
        );
    }

    #[tokio::test]
    async fn the_terminal_stays_single_writer() {
        let ownership: InputOwnership = Arc::new(Mutex::new(HashMap::new()));
        for feed in [FeedId::TERMINAL_INPUT, FeedId::TERMINAL_RESIZE] {
            assert_eq!(
                authorize_and_claim_input(&ownership, None, None, feed, b"x", 1).await,
                InputDecision::Forward
            );
            assert_eq!(
                authorize_and_claim_input(&ownership, None, None, feed, b"x", 2).await,
                InputDecision::Claimed(1),
                "one tmux pane, one writer"
            );
        }
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
            authorize_and_claim_input(&ownership, None, None, FeedId::CODE_INPUT, payload, 42)
                .await;

        assert_eq!(decision, InputDecision::MissingSession);
        assert!(
            ownership.lock().is_empty(),
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
            None,
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
            ownership.lock().is_empty(),
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
            None,
            FeedId::CODE_INPUT,
            payload,
            1,
        )
        .await;
        assert_eq!(decision, InputDecision::Forward);
        assert_eq!(
            ownership.lock().len(),
            1,
            "successful claim writes exactly one entry to the ownership map"
        );
    }

    /// Fixed (card, session) seatings, standing in for the supervisor.
    struct FixedSeats(HashSet<(&'static str, &'static str)>);

    #[async_trait::async_trait]
    impl CardSeats for FixedSeats {
        async fn card_seats_session(&self, card_id: &str, session: &TugSessionId) -> bool {
            self.0
                .iter()
                .any(|(c, s)| *c == card_id && *s == session.as_str())
        }
    }

    /// `CODE_INPUT` follows the card's seating: a body page whose card
    /// seats the session is admitted with no `client_sessions` row and
    /// takes the claim over from the page that held it; a page whose card
    /// does not seat it is refused, and a second page with no card is still
    /// a second writer.
    #[tokio::test]
    async fn code_input_follows_the_cards_seating() {
        const SHELL: u64 = 1;
        const BODY: u64 = 2;
        const OTHER_BODY: u64 = 3;
        const SECOND_SHELL: u64 = 4;
        let ownership: InputOwnership = Arc::new(Mutex::new(HashMap::new()));
        let client_sessions: ClientSessionAffinity =
            Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        client_sessions
            .lock()
            .await
            .insert(SHELL, [TugSessionId::new("sess-s")].into());
        let seats = FixedSeats([("card-x", "sess-s")].into());
        let payload = br#"{"tug_session_id":"sess-s","type":"user_message"}"#;
        let write = async |client: u64, card: Option<&str>| {
            authorize_and_claim_input(
                &ownership,
                Some(&client_sessions),
                card.map(|c| (c, &seats as &dyn CardSeats)),
                FeedId::CODE_INPUT,
                payload,
                client,
            )
            .await
        };

        // The shell spawned the session and writes it first.
        assert_eq!(write(SHELL, None).await, InputDecision::Forward);
        // A body whose card does not seat it is not owned.
        assert_eq!(
            write(OTHER_BODY, Some("card-z")).await,
            InputDecision::NotOwned(TugSessionId::new("sess-s"))
        );
        // The card's own body, with no client_sessions row, takes it over.
        assert_eq!(write(BODY, Some("card-x")).await, InputDecision::Forward);
        let key = (FeedId::CODE_INPUT, Some(TugSessionId::new("sess-s")));
        assert_eq!(
            ownership.lock().get(&key),
            Some(&InputOwner {
                client_id: BODY,
                card_id: Some("card-x".into())
            })
        );
        // The shell is now a second writer.
        assert_eq!(write(SHELL, None).await, InputDecision::Claimed(BODY));
        // And so is another shell-role page that registered the session.
        client_sessions
            .lock()
            .await
            .insert(SECOND_SHELL, [TugSessionId::new("sess-s")].into());
        assert_eq!(
            write(SECOND_SHELL, None).await,
            InputDecision::Claimed(BODY)
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
    use crate::pages::Delivery;
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
            // A `mode=new` spawn births a line ([P03]).
            "line_id": "line-router-test",
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

    /// `request_inflight` rides the same ingress as `request_replay` and
    /// reaches the live tugcode as `{"type":"request_inflight"}` alone — no
    /// window, no lineage, nothing the JSONL path reads. A session that is
    /// not live is not asked.
    #[tokio::test]
    async fn test_request_inflight_reaches_a_live_tugcode_through_router() {
        let (sup, mut register_rx) = test_minimal_supervisor();
        tokio::spawn(async move { while register_rx.recv().await.is_some() {} });

        let tug_id = TugSessionId::new("sess-inflight-router");
        let workspace_key = WorkspaceKey::from_test_str(env!("CARGO_MANIFEST_DIR"));
        let project_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let mut input_rx =
            install_live_session_for_tests(&sup, &tug_id, workspace_key, project_dir).await;

        let payload = serde_json::to_vec(&serde_json::json!({
            "action": "request_inflight",
            "tug_session_id": "sess-inflight-router",
        }))
        .unwrap();
        let outcome = intercept_session_control(Some(&sup), "request_inflight", &payload, 1).await;
        assert!(
            matches!(outcome, ControlIntercept::Handled),
            "request_inflight must route to the supervisor, got {outcome:?}",
        );
        let frame = input_rx
            .try_recv()
            .expect("request_inflight reached input_tx");
        assert_eq!(frame.feed_id, FeedId::CODE_INPUT);
        let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(body, serde_json::json!({"type": "request_inflight"}));

        let unknown = serde_json::to_vec(&serde_json::json!({
            "action": "request_inflight",
            "tug_session_id": "sess-not-in-the-ledger",
        }))
        .unwrap();
        let outcome = intercept_session_control(Some(&sup), "request_inflight", &unknown, 1).await;
        assert!(matches!(outcome, ControlIntercept::Handled));
        assert!(
            input_rx.try_recv().is_err(),
            "a session that is not live is not asked"
        );
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
            "line_id": "line-router-test",
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
            crate::feeds::agent_supervisor::SupervisorDeps::default(),
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

    /// A body the host has declared dormant is quiet on purpose ([B05]): no
    /// silence cuts it while the declaration stands, and when it is withdrawn
    /// the window runs from the last tick that read it, never from the frame
    /// the body sent before it went quiet.
    #[test]
    fn a_declared_dormant_body_is_never_cut_for_silence() {
        let t0 = Instant::now();
        let mut liveness = ClientLiveness::new(t0);

        // Twenty minutes of silence, ticked through under the declaration.
        let mut tick = t0;
        while tick < t0 + Duration::from_secs(20 * 60) {
            tick += HEARTBEAT_INTERVAL;
            assert!(
                !liveness.is_stale_unless_vouched(tick, true),
                "a declared-dormant body was cut for silence"
            );
        }

        // Shown again: the declaration is withdrawn, and the next tick does
        // not read twenty minutes of silence.
        let next = tick + HEARTBEAT_INTERVAL;
        assert!(!liveness.is_stale_unless_vouched(next, false));
        // A body shown and still silent past the window is cut as before.
        assert!(
            liveness
                .is_stale_unless_vouched(tick + HEARTBEAT_TIMEOUT + Duration::from_secs(1), false)
        );
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

    #[tokio::test]
    async fn test_many_to_one_input() {
        let (shutdown_tx, _) = mpsc::channel(1);
        let auth = crate::auth::new_shared_auth_state(0);
        let dev_state = crate::dev::new_shared_dev_state();
        let mut router = FeedRouter::new("test".into(), auth, shutdown_tx, dev_state);

        let (tx, mut rx) = mpsc::channel(16);
        router.register_input(FeedId::TERMINAL_INPUT, tx.clone());
        router.register_input(FeedId::TERMINAL_RESIZE, tx);

        let input_tx = router.input_sinks.get(&FeedId::TERMINAL_INPUT).unwrap();
        input_tx
            .send(1, Frame::new(FeedId::TERMINAL_INPUT, b"key".to_vec()))
            .await;

        let resize_tx = router.input_sinks.get(&FeedId::TERMINAL_RESIZE).unwrap();
        resize_tx
            .send(1, Frame::new(FeedId::TERMINAL_RESIZE, b"resize".to_vec()))
            .await;

        let f1 = rx.try_recv().unwrap();
        let f2 = rx.try_recv().unwrap();
        assert_eq!(f1.feed_id, FeedId::TERMINAL_INPUT);
        assert_eq!(f2.feed_id, FeedId::TERMINAL_RESIZE);
    }

    #[tokio::test]
    async fn an_addressed_input_carries_its_senders_client_id() {
        let (shutdown_tx, _) = mpsc::channel(1);
        let auth = crate::auth::new_shared_auth_state(0);
        let dev_state = crate::dev::new_shared_dev_state();
        let mut router = FeedRouter::new("test".into(), auth, shutdown_tx, dev_state);
        let (tx, mut rx) = mpsc::channel(16);
        router.register_addressed_input(FeedId::GIT_LOG_QUERY, tx);

        let sink = router.input_sinks.get(&FeedId::GIT_LOG_QUERY).unwrap();
        sink.send(7, Frame::new(FeedId::GIT_LOG_QUERY, b"{}".to_vec()))
            .await;

        let received = rx.try_recv().unwrap();
        assert_eq!(received.client_id, 7);
        assert_eq!(received.frame.feed_id, FeedId::GIT_LOG_QUERY);
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

    // ---- Per-feed counters ----

    /// Find the row for `feed` in one of the response's two tables.
    fn stats_row(table: &serde_json::Value, feed: u8) -> Option<&serde_json::Value> {
        table
            .as_array()
            .expect("table is an array")
            .iter()
            .find(|r| r["feed"] == feed)
    }

    #[test]
    fn record_sent_accumulates_on_its_own_index_only() {
        let mut c = FeedCounters::new();
        c.record_sent(FeedId::CODE_OUTPUT, 100);
        c.record_sent(FeedId::CODE_OUTPUT, 40);

        let i = FeedId::CODE_OUTPUT.as_byte() as usize;
        assert_eq!(c.frames[i], 2);
        assert_eq!(c.bytes[i], 140);
        assert_eq!(c.dropped[i], 0);

        // The neighbours on either side are untouched — an off-by-one in the
        // index would land on one of them.
        assert_eq!(c.frames[i - 1], 0);
        assert_eq!(c.bytes[i - 1], 0);
        assert_eq!(c.frames[i + 1], 0);
        assert_eq!(c.bytes[i + 1], 0);
    }

    #[test]
    fn record_dropped_touches_only_the_drop_column() {
        let mut c = FeedCounters::new();
        c.record_dropped(FeedId::DIGEST);

        let i = FeedId::DIGEST.as_byte() as usize;
        assert_eq!(c.dropped[i], 1);
        assert_eq!(
            (c.frames[i], c.bytes[i]),
            (0, 0),
            "a drop is counted instead of a send, never as well as one"
        );
    }

    #[test]
    fn feed_stats_omits_all_zero_rows() {
        let mut conn = FeedCounters::new();
        conn.record_sent(FeedId::JOTS, 512);
        let global = GlobalFeedCounters::default();
        global.record_sent(FeedId::JOTS, 512);

        let v = build_feed_stats_json(
            7,
            &PageIdentity::tool(),
            None,
            &SessionSubscription::All,
            &conn,
            &global,
        );

        assert_eq!(v["type"], "feed_stats");
        assert_eq!(v["client_id"], 7);
        assert_eq!(v["page"]["role"], "tool");
        assert_eq!(
            v["connection"].as_array().unwrap().len(),
            1,
            "one feed moved, so one row — not 256 (got {v:#})"
        );
        let row = stats_row(&v["connection"], FeedId::JOTS.as_byte()).expect("the JOTS row");
        assert_eq!(row["frames"], 1);
        assert_eq!(row["bytes"], 512);
        assert_eq!(row["dropped"], 0);
    }

    #[test]
    fn feed_stats_row_survives_on_the_drop_column_alone() {
        // A feed that was only ever refused has zero frames and zero bytes;
        // dropping its row would hide exactly what the counter is for.
        let mut conn = FeedCounters::new();
        conn.record_dropped(FeedId::CODE_OUTPUT);
        let global = GlobalFeedCounters::default();

        let v = build_feed_stats_json(
            1,
            &PageIdentity::tool(),
            None,
            &SessionSubscription::All,
            &conn,
            &global,
        );

        let row = stats_row(&v["connection"], FeedId::CODE_OUTPUT.as_byte())
            .expect("a drop-only row is still a row");
        assert_eq!(row["frames"], 0);
        assert_eq!(row["bytes"], 0);
        assert_eq!(row["dropped"], 1);
        assert!(
            v["global"].as_array().unwrap().is_empty(),
            "the global table saw nothing at all"
        );
    }

    #[test]
    fn feed_stats_distinguishes_no_subscription_from_an_empty_one() {
        let conn = FeedCounters::new();
        let global = GlobalFeedCounters::default();

        let none = build_feed_stats_json(
            1,
            &PageIdentity::tool(),
            None,
            &SessionSubscription::All,
            &conn,
            &global,
        );
        assert!(
            none["subscribed"].is_null(),
            "a connection that never sent subscribe_feeds is null, not []"
        );

        let empty = HashSet::new();
        let empty = build_feed_stats_json(
            1,
            &PageIdentity::tool(),
            Some(&empty),
            &SessionSubscription::All,
            &conn,
            &global,
        );
        assert_eq!(
            empty["subscribed"],
            serde_json::json!([]),
            "an explicit empty subscription is [], not null"
        );

        let set: HashSet<FeedId> = [FeedId::JOTS, FeedId::CONTROL, FeedId::CODE_OUTPUT]
            .into_iter()
            .collect();
        let named = build_feed_stats_json(
            1,
            &PageIdentity::tool(),
            Some(&set),
            &SessionSubscription::All,
            &conn,
            &global,
        );
        assert_eq!(
            named["subscribed"],
            serde_json::json!([0x40, 0xA0, 0xC0]),
            "the bytes come back sorted, so the response is deterministic"
        );
    }

    #[test]
    fn feed_stats_names_known_feeds_and_leaves_unknown_ones_bare() {
        let mut conn = FeedCounters::new();
        conn.record_sent(FeedId::CODE_OUTPUT, 10);
        // 0x7F is in no feed table on either side of the wire.
        conn.record_sent(FeedId(0x7F), 10);
        let global = GlobalFeedCounters::default();

        let v = build_feed_stats_json(
            1,
            &PageIdentity::tool(),
            None,
            &SessionSubscription::All,
            &conn,
            &global,
        );

        let known = stats_row(&v["connection"], 0x40).expect("the CODE_OUTPUT row");
        assert_eq!(known["name"], "CodeOutput");

        let unknown = stats_row(&v["connection"], 0x7F).expect("the unknown feed is still counted");
        assert!(
            unknown.get("name").is_none(),
            "an unknown byte carries no name field at all (got {unknown:#})"
        );
    }

    // ---- The subscription filter ----

    #[test]
    fn admits_everything_when_the_connection_has_never_asked() {
        // The None state is what every existing client is in, so this is the
        // property that makes the filter wire-compatible on the day it ships.
        for feed in [
            FeedId::CODE_OUTPUT,
            FeedId::JOTS,
            FeedId::TERMINAL_OUTPUT,
            FeedId(0x7F),
        ] {
            assert!(admits(None, feed), "{feed:?} must pass a None subscription");
        }
    }

    #[test]
    fn admits_the_control_and_liveness_planes_against_an_empty_set() {
        // A client that could unsubscribe its own heartbeat could hang itself,
        // and one that could unsubscribe CONTROL could not ask for anything
        // back.
        let empty = HashSet::new();
        assert!(admits(Some(&empty), FeedId::CONTROL));
        assert!(admits(Some(&empty), FeedId::HEARTBEAT));
        assert!(admits(Some(&empty), FeedId::DECK_BUS));
        assert!(
            !admits(Some(&empty), FeedId::CODE_OUTPUT),
            "an empty set means nothing but the exemptions"
        );
    }

    #[test]
    fn admits_is_membership_for_everything_else() {
        let set: HashSet<FeedId> = [FeedId::JOTS, FeedId::DEFAULTS].into_iter().collect();
        assert!(admits(Some(&set), FeedId::JOTS));
        assert!(admits(Some(&set), FeedId::DEFAULTS));
        assert!(!admits(Some(&set), FeedId::CODE_OUTPUT));
        assert!(!admits(Some(&set), FeedId::FILETREE));
    }

    // ---- The deck bus ----

    fn page(role: PageRole, page: &str, card: Option<&str>) -> PageIdentity {
        PageIdentity {
            role,
            page_id: Some(page.into()),
            card_id: card.map(Into::into),
        }
    }

    /// Shell 1, bodies 2 (`c1`) and 3 (`c2`), tool 4, and the page lane.
    fn bus_pages() -> (PageRegistry, broadcast::Sender<AddressedFrame>) {
        let pages = PageRegistry::new();
        pages.register(1, &page(PageRole::Shell, "s", None));
        pages.register(2, &page(PageRole::Body, "b1", Some("c1")));
        pages.register(3, &page(PageRole::Body, "b2", Some("c2")));
        pages.register(4, &PageIdentity::tool());
        let (lane, _) = broadcast::channel(16);
        (pages, lane)
    }

    fn delivered(rx: &mut broadcast::Receiver<AddressedFrame>) -> (Delivery, serde_json::Value) {
        let addressed = rx.try_recv().expect("a delivery on the page lane");
        assert_eq!(addressed.frame.feed_id, FeedId::DECK_BUS);
        let body = serde_json::from_slice(&addressed.frame.payload).expect("JSON");
        (addressed.to, body)
    }

    #[test]
    fn resolving_the_bodies_never_reaches_a_tool() {
        let pages = PageRegistry::new();
        pages.register(1, &PageIdentity::tool());
        pages.register(2, &page(PageRole::Body, "b1", Some("c1")));
        pages.register(3, &page(PageRole::Body, "b2", Some("c2")));
        assert_eq!(
            pages.resolve(&PageTarget::Bodies),
            Some(Delivery::Clients(vec![2, 3].into()))
        );
    }

    #[test]
    fn a_bus_message_carries_its_sender_as_registered() {
        let (pages, lane) = bus_pages();
        let mut rx = lane.subscribe();
        let sent = serde_json::json!({
            "from": {"pageId": "forged", "role": "shell", "cardId": null},
            "to": "shell",
            "kind": "state",
            "key": "card.holds",
            "card": "c1",
            "version": 2,
            "payload": {"guarded": true},
        });
        let from = page(PageRole::Body, "b1", Some("c1"));
        route_bus(&pages, &lane, &from, sent.to_string().as_bytes()).expect("delivered");
        let (to, body) = delivered(&mut rx);
        assert_eq!(to, Delivery::Client(1));
        assert_eq!(
            body["from"],
            serde_json::json!({"pageId": "b1", "role": "body", "cardId": "c1"})
        );
        assert_eq!(body["payload"]["guarded"], true);
        assert_eq!(body["version"], 2);
    }

    #[test]
    fn a_bus_message_reaches_the_pages_its_target_names() {
        let (pages, lane) = bus_pages();
        let mut rx = lane.subscribe();
        let shell = page(PageRole::Shell, "s", None);
        let to_bodies = serde_json::json!({
            "to": "body",
            "kind": "state",
            "key": "deck.facts",
            "version": 1,
            "payload": {"theme": "ironclad"},
        });
        route_bus(&pages, &lane, &shell, to_bodies.to_string().as_bytes()).expect("delivered");
        assert_eq!(delivered(&mut rx).0, Delivery::Clients(vec![2, 3].into()));
        let to_card = serde_json::json!({"to": {"card": "c2"}, "kind": "action", "key": "command", "payload": {"id": "interrupt"}});
        route_bus(&pages, &lane, &shell, to_card.to_string().as_bytes()).expect("delivered");
        assert_eq!(delivered(&mut rx).0, Delivery::Client(3));
        let to_page = serde_json::json!({"to": {"page": "b1"}, "kind": "reply", "key": "miniature.zones", "requestId": "r1", "payload": {"ok": true, "value": null}});
        route_bus(&pages, &lane, &shell, to_page.to_string().as_bytes()).expect("delivered");
        assert_eq!(delivered(&mut rx).0, Delivery::Client(2));
    }

    /// A field no declaration names arrives instead of being stripped in
    /// transit, inside the payload and beside it.
    #[test]
    fn an_envelope_keeps_a_field_no_declaration_names() {
        let (pages, lane) = bus_pages();
        let mut rx = lane.subscribe();
        let sent = serde_json::json!({
            "to": "shell",
            "kind": "state",
            "key": "card.facts",
            "card": "c1",
            "version": 1,
            "payload": {"title": "Dev", "masthead": null, "activity": null, "telemetry": {}, "binding": {"tugSessionId": "s1"}},
            "extra": [1, 2],
        });
        let from = page(PageRole::Body, "b1", Some("c1"));
        route_bus(&pages, &lane, &from, sent.to_string().as_bytes()).expect("delivered");
        let (_, body) = delivered(&mut rx);
        assert_eq!(
            body["payload"]["binding"],
            serde_json::json!({"tugSessionId": "s1"})
        );
        assert_eq!(body["extra"], serde_json::json!([1, 2]));
    }

    #[test]
    fn the_bus_refuses_a_tool_a_stranger_kind_and_a_target_nobody_answers() {
        let (pages, lane) = bus_pages();
        let mut rx = lane.subscribe();
        let ok = serde_json::json!({"to": "shell", "kind": "action", "key": "card.close", "payload": {}});
        let refused = route_bus(
            &pages,
            &lane,
            &PageIdentity::tool(),
            ok.to_string().as_bytes(),
        );
        assert_eq!(refused.unwrap_err()["detail"], "bus_refused");

        let body = page(PageRole::Body, "b1", Some("c1"));
        let stranger = serde_json::json!({"to": "shell", "kind": "card-gossip", "payload": {}});
        let malformed = route_bus(&pages, &lane, &body, stranger.to_string().as_bytes());
        assert_eq!(malformed.unwrap_err()["detail"], "bus_malformed");
        let not_json = route_bus(&pages, &lane, &body, b"not json");
        assert_eq!(not_json.unwrap_err()["detail"], "bus_malformed");

        let nobody = serde_json::json!({"to": {"card": "nobody"}, "kind": "hello", "payload": {"role": "shell", "answer": true}});
        let no_target = serde_json::json!({"kind": "state", "payload": {}});
        let untargeted = route_bus(&pages, &lane, &body, no_target.to_string().as_bytes());
        assert_eq!(untargeted.unwrap_err()["detail"], "bus_malformed");
        let undeliverable =
            route_bus(&pages, &lane, &body, nobody.to_string().as_bytes()).unwrap_err();
        assert_eq!(undeliverable["detail"], "bus_undeliverable");
        assert_eq!(undeliverable["to"], serde_json::json!({"card": "nobody"}));

        assert!(rx.try_recv().is_err(), "no refusal reaches the page lane");
    }

    /// A spare body binds to its card: it is answered `page_bound`, a bus
    /// message to the card reaches it, and the session its new card seats
    /// is one it may write. A second bind is refused and changes nothing.
    #[tokio::test]
    async fn a_spare_that_binds_is_addressed_and_writes_as_its_card() {
        const SPARE: u64 = 5;
        let (pages, lane) = bus_pages();
        let mut identity = page(PageRole::Body, "b-spare", Some("spare:7e1d"));
        pages.register(SPARE, &identity);
        let mut page_card = identity.card_id.clone();

        let reply = apply_page_bind(
            &pages,
            SPARE,
            &mut identity,
            &mut page_card,
            &serde_json::json!({"action": "page_bind", "card_id": "c9"}),
        );
        assert_eq!(
            reply,
            serde_json::json!({"action": "page_bound", "card_id": "c9"})
        );
        assert_eq!(identity.card_id.as_deref(), Some("c9"));
        assert_eq!(page_card.as_deref(), Some("c9"));

        // A bus message to the card reaches the bound spare, and its own
        // messages now carry the card.
        let mut rx = lane.subscribe();
        let shell = page(PageRole::Shell, "s", None);
        let to_card = serde_json::json!({"to": {"card": "c9"}, "kind": "hello", "payload": {"role": "shell", "answer": true}});
        route_bus(&pages, &lane, &shell, to_card.to_string().as_bytes()).expect("delivered");
        assert_eq!(delivered(&mut rx).0, Delivery::Client(SPARE));
        let hello = serde_json::json!({"to": "shell", "kind": "hello", "payload": {"role": "body", "cardId": "c9", "componentId": "jots"}});
        route_bus(&pages, &lane, &identity, hello.to_string().as_bytes()).expect("delivered");
        assert_eq!(delivered(&mut rx).1["from"]["cardId"], "c9");

        // CODE_INPUT for the session the new card seats is forwarded.
        let ownership: InputOwnership = Arc::new(Mutex::new(HashMap::new()));
        let client_sessions: ClientSessionAffinity =
            Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let seats = FixedSeats([("c9", "sess-9")].into());
        let decision = authorize_and_claim_input(
            &ownership,
            Some(&client_sessions),
            page_card.as_deref().map(|c| (c, &seats as &dyn CardSeats)),
            FeedId::CODE_INPUT,
            br#"{"tug_session_id":"sess-9","type":"user_message"}"#,
            SPARE,
        )
        .await;
        assert_eq!(decision, InputDecision::Forward);

        // A second bind is refused, and the page keeps its card.
        let again = apply_page_bind(
            &pages,
            SPARE,
            &mut identity,
            &mut page_card,
            &serde_json::json!({"action": "page_bind", "card_id": "c10"}),
        );
        assert_eq!(
            again,
            serde_json::json!({"action": "page_bind_refused", "detail": "already_bound"})
        );
        assert_eq!(page_card.as_deref(), Some("c9"));
    }

    #[test]
    fn page_bind_from_a_carded_body_or_with_no_card_is_refused() {
        let (pages, _lane) = bus_pages();
        let mut identity = page(PageRole::Body, "b1", Some("c1"));
        let mut page_card = identity.card_id.clone();
        let reply = apply_page_bind(
            &pages,
            2,
            &mut identity,
            &mut page_card,
            &serde_json::json!({"action": "page_bind", "card_id": "c9"}),
        );
        assert_eq!(reply["detail"], "not_spare");
        assert_eq!(page_card.as_deref(), Some("c1"));

        pages.register(6, &page(PageRole::Body, "b6", Some("spare:x")));
        let mut spare = page(PageRole::Body, "b6", Some("spare:x"));
        let mut spare_card = spare.card_id.clone();
        let reply = apply_page_bind(
            &pages,
            6,
            &mut spare,
            &mut spare_card,
            &serde_json::json!({"action": "page_bind"}),
        );
        assert_eq!(reply["detail"], "bad_card_id");
        assert_eq!(spare_card.as_deref(), Some("spare:x"));
    }

    #[test]
    fn parse_subscribe_feeds_reads_a_well_formed_array() {
        let v = serde_json::json!({ "action": "subscribe_feeds", "feeds": [64, 65, 160] });
        let set = parse_subscribe_feeds(&v).expect("a well-formed array parses");
        assert_eq!(
            set,
            [FeedId::CODE_OUTPUT, FeedId::CODE_INPUT, FeedId::JOTS]
                .into_iter()
                .collect::<HashSet<_>>()
        );
    }

    #[test]
    fn parse_subscribe_feeds_accepts_an_empty_array_as_a_real_answer() {
        let v = serde_json::json!({ "action": "subscribe_feeds", "feeds": [] });
        let set = parse_subscribe_feeds(&v).expect("an empty array is legal");
        assert!(
            set.is_empty(),
            "an empty set means nothing but the exemptions, which is not the \
             same as never having asked"
        );
    }

    #[test]
    fn parse_subscribe_feeds_refuses_a_malformed_message_rather_than_emptying_it() {
        // None is the caller's signal to leave the subscription alone.
        // Returning Some(empty) here would silently narrow a connection to the
        // exemptions; returning "everything" would silently lose a filter.
        assert!(
            parse_subscribe_feeds(&serde_json::json!({ "action": "subscribe_feeds" })).is_none(),
            "a missing feeds key is malformed"
        );
        assert!(
            parse_subscribe_feeds(&serde_json::json!({ "feeds": 64 })).is_none(),
            "a non-array feeds field is malformed"
        );
        assert!(
            parse_subscribe_feeds(&serde_json::json!({ "feeds": "64,65" })).is_none(),
            "a string is not an array"
        );
        assert!(
            parse_subscribe_feeds(&serde_json::json!({ "feeds": null })).is_none(),
            "an explicit null is not an array"
        );
    }

    #[test]
    fn parse_subscribe_feeds_skips_junk_entries_without_discarding_the_set() {
        // One bad entry must not cost the client its whole subscription.
        let v = serde_json::json!({
            "feeds": [64, 256, -1, "160", 1.5, null, 160]
        });
        let set = parse_subscribe_feeds(&v).expect("the array itself is well formed");
        assert_eq!(
            set,
            [FeedId::CODE_OUTPUT, FeedId::JOTS]
                .into_iter()
                .collect::<HashSet<_>>(),
            "256 is out of range, -1 is not a u64, \"160\" is a string, 1.5 is \
             not an integer, and null is nothing — the two real bytes survive"
        );
    }

    #[test]
    fn parse_subscribe_feeds_folds_duplicates() {
        let v = serde_json::json!({ "feeds": [160, 160, 160] });
        let set = parse_subscribe_feeds(&v).expect("parses");
        assert_eq!(
            set.len(),
            1,
            "a set, so duplicates are free rather than an error"
        );
    }

    // ---- The session filter ----

    fn only(ids: &[&str]) -> SessionSubscription {
        SessionSubscription::Only(ids.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn parse_subscribe_sessions_reads_every_well_formed_shape() {
        let parse = |v: serde_json::Value| parse_subscribe_sessions(&v);
        assert_eq!(
            parse(serde_json::json!({ "feeds": [] })),
            Some(SessionSubscription::All),
            "an absent sessions field resets to all"
        );
        assert_eq!(
            parse(serde_json::json!({ "feeds": [], "sessions": "all" })),
            Some(SessionSubscription::All)
        );
        assert_eq!(
            parse(serde_json::json!({ "feeds": [], "sessions": [] })),
            Some(only(&[])),
            "[] is none, not all"
        );
        assert_eq!(
            parse(serde_json::json!({ "feeds": [], "sessions": ["s-a", "s-b"] })),
            Some(only(&["s-a", "s-b"]))
        );
    }

    #[test]
    fn parse_subscribe_sessions_refuses_a_malformed_field() {
        for bad in [
            serde_json::json!({ "feeds": [], "sessions": 5 }),
            serde_json::json!({ "feeds": [], "sessions": [1] }),
            serde_json::json!({ "feeds": [], "sessions": ["s-a", null] }),
            serde_json::json!({ "feeds": [], "sessions": "some" }),
        ] {
            assert_eq!(parse_subscribe_sessions(&bad), None, "{bad} is malformed");
        }
    }

    #[test]
    fn session_of_reads_the_spliced_prefix_without_a_parse() {
        let payload =
            crate::feeds::code::splice_tug_session_id(br#"{"type":"assistant_text"}"#, "s-1");
        assert!(
            matches!(session_of(&payload), Some(Cow::Borrowed("s-1"))),
            "the hot path borrows the id from the payload"
        );
    }

    #[test]
    fn session_of_falls_back_to_a_parse_when_the_id_is_not_first() {
        let payload = br#"{"detail":null,"state":"pending","tug_session_id":"s"}"#;
        assert_eq!(session_of(payload).as_deref(), Some("s"));
    }

    #[test]
    fn session_of_answers_none_for_a_frame_that_names_no_session() {
        assert_eq!(session_of(b"not json at all").as_deref(), None);
        assert_eq!(session_of(br#"{"type":"x"}"#).as_deref(), None);
        assert_eq!(session_of(b"").as_deref(), None);
    }

    #[test]
    fn the_session_filter_drops_only_a_named_session_outside_the_set() {
        let feeds: HashSet<FeedId> = [FeedId::CODE_OUTPUT, FeedId::SESSION_STATE].into();
        let scoped = |s: &str| {
            Frame::new(
                FeedId::CODE_OUTPUT,
                crate::feeds::code::splice_tug_session_id(br#"{"type":"x"}"#, s),
            )
        };
        let unscoped = Frame::new(FeedId::CODE_OUTPUT, br#"{"type":"x"}"#.to_vec());

        assert!(admits_session(
            &SessionSubscription::All,
            &feeds,
            &scoped("s-a")
        ));
        assert!(admits_session(&only(&["s-b"]), &feeds, &scoped("s-b")));
        assert!(
            !admits_session(&only(&["s-b"]), &feeds, &scoped("s-a")),
            "a session outside the set is dropped"
        );
        assert!(
            !admits_session(&only(&[]), &feeds, &scoped("s-a")),
            "[] admits no session"
        );
        assert!(
            admits_session(&only(&[]), &feeds, &unscoped),
            "a frame naming no session is admitted"
        );
        let other = Frame::new(
            FeedId::JOTS,
            crate::feeds::code::splice_tug_session_id(br#"{"type":"x"}"#, "s-a"),
        );
        assert!(
            admits_session(&only(&[]), &feeds, &other),
            "a frame on a feed that is not session-scoped is never session-filtered"
        );
    }

    /// A declared-dormant body hears nothing of any session, whatever its own
    /// subscription says ([B05]); what names no session still reaches it.
    #[test]
    fn a_declared_dormant_body_takes_no_session_scoped_frame() {
        let feeds: HashSet<FeedId> = [FeedId::CODE_OUTPUT, FeedId::SESSION_STATE].into();
        let scoped = Frame::new(
            FeedId::CODE_OUTPUT,
            crate::feeds::code::splice_tug_session_id(br#"{"type":"x"}"#, "s-a"),
        );
        let unscoped = Frame::new(FeedId::CODE_OUTPUT, br#"{"type":"x"}"#.to_vec());
        let other = Frame::new(
            FeedId::JOTS,
            crate::feeds::code::splice_tug_session_id(br#"{"type":"x"}"#, "s-a"),
        );

        assert!(
            !admits_while_dormant(&feeds, &scoped),
            "its own session is dropped"
        );
        assert!(admits_while_dormant(&feeds, &unscoped));
        assert!(admits_while_dormant(&feeds, &other));
    }

    /// The reveal's catch-up ask withdraws the host's declaration in band, so
    /// its answer is not refused on a wire still marked dormant; nothing else
    /// a body asks, and nothing a shell asks, does.
    #[test]
    fn only_a_bodys_catch_up_ask_wakes_its_card() {
        let body = PageIdentity {
            role: PageRole::Body,
            page_id: Some("p".into()),
            card_id: Some("c1".into()),
        };
        let shell = PageIdentity {
            role: PageRole::Shell,
            page_id: Some("s".into()),
            card_id: None,
        };
        let catch_up = serde_json::json!({ "action": "request_replay", "reason": "catch-up", "tug_session_id": "x" });
        let launch = serde_json::json!({ "action": "request_replay", "reason": "launch", "tug_session_id": "x" });
        assert_eq!(catch_up_wakes_card(&body, &catch_up), Some("c1"));
        assert_eq!(catch_up_wakes_card(&body, &launch), None);
        assert_eq!(catch_up_wakes_card(&shell, &catch_up), None);
    }

    #[test]
    fn feed_stats_reports_the_session_subscription() {
        let conn = FeedCounters::new();
        let global = GlobalFeedCounters::default();
        let all = build_feed_stats_json(
            1,
            &PageIdentity::tool(),
            None,
            &SessionSubscription::All,
            &conn,
            &global,
        );
        assert!(all["sessions"].is_null(), "all sessions is null");
        let some = build_feed_stats_json(
            1,
            &PageIdentity::tool(),
            None,
            &only(&["s-b", "s-a"]),
            &conn,
            &global,
        );
        assert_eq!(some["sessions"], serde_json::json!(["s-a", "s-b"]));
    }

    #[test]
    fn a_client_may_name_the_exempt_feeds_harmlessly() {
        // 192 and 255 in a feeds array are accepted; the exemption fires first
        // either way, so naming them changes nothing.
        let v = serde_json::json!({ "feeds": [192, 255] });
        let set = parse_subscribe_feeds(&v).expect("parses");
        assert!(admits(Some(&set), FeedId::CONTROL));
        assert!(admits(Some(&set), FeedId::HEARTBEAT));
        assert!(!admits(Some(&set), FeedId::JOTS));
    }
}
