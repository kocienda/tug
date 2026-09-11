//! digest_bridge — the live wiring around the session digester.
//!
//! Topology:
//!
//! ```text
//!   CODE_OUTPUT  ──allowlist + replay mute──┐
//!   CODE_INPUT (submissions) ───────────────┼──▶ SessionDigester ──▶ per-session
//!   SHELL_OUTPUT (exchanges) ───────────────┘                        rolling deque
//!                                                                          │
//!                                                DIGEST broadcast ◀─────────┘
//! ```
//!
//! The digester is **shared**, not owned: this task is its only writer, and a
//! reader that only looks at the deque holds the same handle rather than
//! taking a tap of its own. The Observer keeps a separate window, because a
//! wake *takes* its buffer and clears it — but it runs the same digester type
//! over the same vocabulary, so what every reader sees is one spelling of each
//! event, which is what [P01]'s one tap means in practice.
//!
//! This replaces a bridge that spawned and supervised a bun-compiled
//! narration subprocess: a spawner trait, a respawn throttle, a stdout reader
//! task, a `--seed` reseed contract, and a second language on the wire. The
//! digester is in-process now, so all of that is gone and what remains is
//! three subscriptions, a clock, and an emission throttle.
//!
//! **The digester is pure and this module holds everything impure.** Time
//! enters `session_digest` as a parameter; the wall clock, the throttle's
//! deadlines and the broadcast all live here. That split is what lets the
//! fixture drift test drive the same digester the strip does.
//!
//! Three properties are worth stating because each one was a defect somewhere
//! before it was a rule:
//!
//! - **The throttle is not uniform.** A turn end, a cancel, a compaction, an
//!   ask and the permission-wait pair bypass it. See [`Emission`].
//! - **A throttled line is deferred, not dropped.** The retired daemon had a
//!   flush loop for this reason: a line skipped inside its window and never
//!   re-offered leaves the strip frozen on an older beat, which is exactly what
//!   happens during a long tool call when nothing else arrives.
//! - **There is no kill switch here.** The beat is deterministic and costs
//!   nothing to produce, so gating it would be a display preference nobody
//!   asked for; the subsystem's one switch is `dev.tugapp.overview/enabled`
//!   and it gates the Observer's wakes, which are its only model cost ([P10]).
//!
//! One-way isolation, unchanged: nothing here writes toward any work session.
//! The only outputs are the DIGEST broadcast and tracing.

use std::collections::HashMap;
use std::collections::HashSet;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde_json::json;
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use tugcast_core::{FeedId, Frame, StreamFeed};

use super::session_digest::{
    DigestLine, Emission, SharedDigester, VOICE_THROTTLE_MS, forwardable_session, lock_digester,
};

/// How many lines per session the deck's mount-time tail read asks for.
///
/// The deque the read answers from is capped by the digester itself (Spec
/// S03); this is what a reconnecting card wants to see above the live feed,
/// and it is deliberately shorter than the deque.
pub const DIGEST_TAIL_LEN: usize = 20;

/// How often the deferred-line flush wakes when something is actually pending.
///
/// This is a rate limiter's release clock, not a poll: the bridge selects on the
/// earliest pending scope's deadline and sleeps indefinitely when nothing is
/// pending, so a quiet process has no timer at all. What it paces is emission,
/// and what it watches is still the broadcast.
const FLUSH_IDLE: Duration = Duration::from_secs(3_600);

/// Everything the bridge task needs.
///
/// The DIGEST broadcast sender is not part of it — the bridge is a
/// [`StreamFeed`], so the router hands it the channel at `run`.
pub struct DigestBridgeConfig {
    /// The shared CODE_OUTPUT broadcast — the bridge subscribes inside its task
    /// (receivers cannot be cloned) and taps every frame.
    pub code_tx: broadcast::Sender<Frame>,
    /// The CODE_INPUT submission broadcast: what the human actually asked.
    /// Inherently live — replay never rides CODE_INPUT — so it needs no mute
    /// set of its own.
    pub submission_tx: broadcast::Sender<Frame>,
    /// SHELL_OUTPUT exchange frames. Also inherently live.
    pub shell_tx: broadcast::Sender<Frame>,
    /// The one digester, shared with every reader of it. The bridge is the
    /// only writer: it holds the three subscriptions, and the standing
    /// sentence reads the deque this fills rather than taking a tap of its
    /// own.
    pub digester: SharedDigester,
}

/// The DIGEST feed: a [`StreamFeed`] wrapping the digester. The router creates
/// the (small) broadcast channel, records the `Warn` lag policy, and spawns the
/// bridge loop, which lives until `cancel` fires.
pub struct DigestBridge {
    config: DigestBridgeConfig,
}

impl DigestBridge {
    pub fn new(config: DigestBridgeConfig) -> Self {
        Self { config }
    }
}

#[async_trait]
impl StreamFeed for DigestBridge {
    fn feed_id(&self) -> FeedId {
        FeedId::DIGEST
    }

    fn name(&self) -> &str {
        "digest"
    }

    /// Beats are small and bursty; the tail a reconnecting deck needs comes
    /// from the `list_digest_lines` CONTROL read, not feed replay — so the
    /// default `Warn` lag policy and a small channel.
    fn channel_capacity(&self) -> usize {
        64
    }

    async fn run(self: Box<Self>, tx: broadcast::Sender<Frame>, cancel: CancellationToken) {
        digest_bridge_task(self.config, tx, cancel).await;
    }
}

/// One scope's emission state: when it last spoke, what it last said, and the
/// line it is holding until its window opens.
#[derive(Default)]
struct ScopeEmission {
    last_emit: Option<Instant>,
    shown_text: Option<String>,
    pending: Option<DigestLine>,
}

impl ScopeEmission {
    /// When this scope's throttle window opens, given that it is holding a line.
    fn due_at(&self) -> Option<Instant> {
        let pending = self.pending.as_ref()?;
        let _ = pending;
        Some(match self.last_emit {
            Some(last) => last + Duration::from_millis(VOICE_THROTTLE_MS),
            // Nothing has been emitted for this scope yet, so it is due now.
            None => Instant::now(),
        })
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The CODE_INPUT relay: the router's registered sink feeds `relay_rx`; every
/// frame is published to the submission broadcast, then forwarded verbatim to
/// the supervisor's dispatcher. Publish before forward, so the digester's copy
/// never trails the supervisor's by more than the broadcast hop; a lagged or
/// absent subscriber drops frames on the broadcast side and can never delay
/// dispatch. Ends when either side closes — the sink closing and the
/// dispatcher going away are the same shutdown.
///
/// It lives here because the submission wire is the digester's: what the human
/// asked is a digest line, and this tee is what puts it on a broadcast the
/// digester can subscribe to.
pub async fn relay_code_input(
    mut relay_rx: mpsc::Receiver<Frame>,
    submission_tx: broadcast::Sender<Frame>,
    forward_tx: mpsc::Sender<Frame>,
) {
    while let Some(frame) = relay_rx.recv().await {
        let _ = submission_tx.send(frame.clone());
        if forward_tx.send(frame).await.is_err() {
            return;
        }
    }
}

async fn digest_bridge_task(
    config: DigestBridgeConfig,
    digest_tx: broadcast::Sender<Frame>,
    cancel: CancellationToken,
) {
    let mut code_rx = config.code_tx.subscribe();
    let mut submission_rx = config.submission_tx.subscribe();
    let mut shell_rx = config.shell_tx.subscribe();
    let mut code_closed = false;
    let mut submission_closed = false;
    let mut shell_closed = false;

    let digester = config.digester.clone();
    // Sessions inside a replay bracket — their frames are history being
    // re-emitted, not live work. Mute state tracks the wire, not the toggle.
    let mut muted: HashSet<String> = HashSet::new();
    let mut emission: HashMap<String, ScopeEmission> = HashMap::new();
    let mut sweep_at = Instant::now();

    loop {
        // The only timer is the earliest deferred line's deadline, recomputed
        // each pass. With nothing pending there is nothing to wake for.
        let next_due = emission
            .values()
            .filter_map(ScopeEmission::due_at)
            .min()
            .unwrap_or_else(|| Instant::now() + FLUSH_IDLE);

        tokio::select! {
            _ = cancel.cancelled() => {
                info!("digest bridge: cancelled");
                return;
            }
            _ = tokio::time::sleep_until(next_due.into()) => {
                flush_pending(&digest_tx, &mut emission);
                // The idle sweep rides the same wake rather than a clock of its
                // own: a scope silent for half an hour is not urgent.
                if sweep_at.elapsed() >= Duration::from_secs(600) {
                    sweep_at = Instant::now();
                    for scope in lock_digester(&digester).sweep_inactive(now_ms()) {
                        emission.remove(&scope);
                    }
                }
            }
            recv = code_rx.recv(), if !code_closed => {
                let Some(frame) = take_frame(recv, "code", &mut code_closed) else {
                    continue;
                };
                // The classifier runs on every frame, toggle or no toggle, so
                // the mute set stays true to the wire.
                let Some(scope) = forwardable_session(&frame.payload, &mut muted) else {
                    continue;
                };
                let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&frame.payload) else {
                    continue;
                };
                let digested = lock_digester(&digester).on_code_frame(&scope, &payload, now_ms());
                if let Some(digested) = digested {
                    offer(&digest_tx, &mut emission, &scope, digested.line, digested.emission);
                }
            }
            recv = submission_rx.recv(), if !submission_closed => {
                let Some(frame) = take_frame(recv, "submission", &mut submission_closed) else {
                    continue;
                };
                let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&frame.payload) else {
                    continue;
                };
                let submitted = lock_digester(&digester).on_submission(&payload, now_ms());
                if let Some((scope, digested)) = submitted {
                    offer(&digest_tx, &mut emission, &scope, digested.line, digested.emission);
                }
            }
            recv = shell_rx.recv(), if !shell_closed => {
                let Some(frame) = take_frame(recv, "shell", &mut shell_closed) else {
                    continue;
                };
                let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&frame.payload) else {
                    continue;
                };
                let Some(scope) = payload
                    .get("tug_session_id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                else {
                    continue;
                };
                let digested = lock_digester(&digester).on_shell_frame(&scope, &payload, now_ms());
                if let Some(digested) = digested {
                    offer(&digest_tx, &mut emission, &scope, digested.line, digested.emission);
                }
            }
        }
    }
}

/// One broadcast receive, with the two error arms every tap here shares.
/// Beats never backpressure work: a lagging receiver skips and moves on.
fn take_frame(
    recv: Result<Frame, broadcast::error::RecvError>,
    wire: &str,
    closed: &mut bool,
) -> Option<Frame> {
    match recv {
        Ok(frame) => Some(frame),
        Err(broadcast::error::RecvError::Lagged(skipped)) => {
            warn!(
                skipped,
                wire, "digest bridge: broadcast lagged; frames dropped"
            );
            None
        }
        Err(broadcast::error::RecvError::Closed) => {
            info!(wire, "digest bridge: broadcast closed");
            *closed = true;
            None
        }
    }
}

/// Offer a line for emission: now, or held until the scope's window opens.
///
/// The digest has already recorded it — this decides only what reaches the
/// strip. A held line replaces whatever the scope was holding, so the newest
/// text wins when the window finally opens; that is the daemon's flush-loop
/// behavior, which read a single overwritten field rather than a queue.
fn offer(
    digest_tx: &broadcast::Sender<Frame>,
    emission: &mut HashMap<String, ScopeEmission>,
    scope: &str,
    line: DigestLine,
    class: Emission,
) {
    let state = emission.entry(scope.to_string()).or_default();
    match class {
        Emission::Now => {
            // A turn end, a cancel, a compaction, an ask, a permission wait.
            // Whatever was held describes the stretch this line just ended.
            state.pending = None;
            emit(digest_tx, state, scope, &line);
        }
        Emission::Throttled => {
            let window_open = state
                .last_emit
                .is_none_or(|last| last.elapsed() >= Duration::from_millis(VOICE_THROTTLE_MS));
            if window_open {
                state.pending = None;
                emit(digest_tx, state, scope, &line);
            } else {
                state.pending = Some(line);
            }
        }
    }
}

/// Release every held line whose window has opened.
fn flush_pending(
    digest_tx: &broadcast::Sender<Frame>,
    emission: &mut HashMap<String, ScopeEmission>,
) {
    for (scope, state) in emission.iter_mut() {
        let due = state
            .last_emit
            .is_none_or(|last| last.elapsed() >= Duration::from_millis(VOICE_THROTTLE_MS));
        if !due {
            continue;
        }
        if let Some(line) = state.pending.take() {
            let scope = scope.clone();
            emit(digest_tx, state, &scope, &line);
        }
    }
}

/// Persist and broadcast one line.
///
/// The payload carries the line's `kind` where the retired daemon's carried a
/// pinned `intent` ([D187]). The swap is what lets the deck tell an Ask line
/// from a tool line — which is rung (2) of the masthead's ladder, and a
/// distinction the old payload could not express at all.
fn emit(
    digest_tx: &broadcast::Sender<Frame>,
    state: &mut ScopeEmission,
    scope: &str,
    line: &DigestLine,
) {
    if line.text.is_empty() {
        return;
    }
    // `shownText`'s rule: a line identical to what the strip already shows is
    // not news.
    if state.shown_text.as_deref() == Some(line.text.as_str()) {
        return;
    }
    state.shown_text = Some(line.text.clone());
    state.last_emit = Some(Instant::now());

    let scopes = vec![scope.to_string()];
    let at_ms = line.at_ms as i64;
    let beat = line.beat as i64;

    let payload = json!({
        "type": "digest",
        "text": line.text,
        "kind": line.kind.as_str(),
        "scopes": scopes,
        "beat": beat,
        "at": at_ms,
    });
    let Ok(bytes) = serde_json::to_vec(&payload) else {
        return;
    };
    let _ = digest_tx.send(Frame::new(FeedId::DIGEST, bytes));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    struct Harness {
        code_tx: broadcast::Sender<Frame>,
        submission_tx: broadcast::Sender<Frame>,
        shell_tx: broadcast::Sender<Frame>,
        digest_rx: broadcast::Receiver<Frame>,
        cancel: CancellationToken,
        /// The one digester, so a test can read the deque the other readers
        /// read rather than only the strip's side of it.
        digester: SharedDigester,
        /// A tapped channel stays open only while something holds a receiver;
        /// the bridge takes its own inside its task, so the harness holds these
        /// to keep a send from failing before the task has started.
        _keep: (
            broadcast::Receiver<Frame>,
            broadcast::Receiver<Frame>,
            broadcast::Receiver<Frame>,
        ),
    }

    impl Harness {
        /// Start the bridge and wait until it has actually subscribed.
        ///
        /// A `broadcast::Sender::send` only reaches receivers that exist at the
        /// moment of the send, and the bridge takes its three subscriptions
        /// inside its own task — so a harness that sends the instant after
        /// `tokio::spawn` loses every frame to a task that has not been polled
        /// yet, and every test here reads as "nothing was emitted".
        async fn start() -> Self {
            let (code_tx, code_keep) = broadcast::channel::<Frame>(64);
            let (submission_tx, submission_keep) = broadcast::channel::<Frame>(64);
            let (shell_tx, shell_keep) = broadcast::channel::<Frame>(64);
            let (digest_tx, digest_rx) = broadcast::channel::<Frame>(64);
            let cancel = CancellationToken::new();

            let digester: SharedDigester = Default::default();
            let bridge = DigestBridge::new(DigestBridgeConfig {
                code_tx: code_tx.clone(),
                submission_tx: submission_tx.clone(),
                shell_tx: shell_tx.clone(),
                digester: digester.clone(),
            });
            tokio::spawn(Box::new(bridge).run(digest_tx, cancel.clone()));

            // Each channel holds the harness's own keepalive receiver plus the
            // bridge's, so two is the count that says the task is listening.
            while code_tx.receiver_count() < 2
                || submission_tx.receiver_count() < 2
                || shell_tx.receiver_count() < 2
            {
                tokio::task::yield_now().await;
            }

            Self {
                code_tx,
                submission_tx,
                shell_tx,
                digest_rx,
                cancel,
                digester,
                _keep: (code_keep, submission_keep, shell_keep),
            }
        }

        fn send_code(&self, payload: Value) {
            let bytes = serde_json::to_vec(&payload).expect("payload");
            let _ = self.code_tx.send(Frame::new(FeedId::CODE_OUTPUT, bytes));
        }

        fn send_submission(&self, payload: Value) {
            let bytes = serde_json::to_vec(&payload).expect("payload");
            let _ = self
                .submission_tx
                .send(Frame::new(FeedId::CODE_INPUT, bytes));
        }

        fn send_shell(&self, payload: Value) {
            let bytes = serde_json::to_vec(&payload).expect("payload");
            let _ = self.shell_tx.send(Frame::new(FeedId::SHELL_OUTPUT, bytes));
        }

        /// The next beat, or `None` once nothing arrives inside the window.
        async fn next_beat(&mut self) -> Option<Value> {
            let frame = tokio::time::timeout(Duration::from_millis(500), self.digest_rx.recv())
                .await
                .ok()?
                .ok()?;
            Some(serde_json::from_slice(&frame.payload).expect("a digest payload"))
        }

        async fn next_text(&mut self) -> Option<String> {
            let beat = self.next_beat().await?;
            Some(beat["text"].as_str().unwrap_or_default().to_string())
        }

        /// Everything emitted until the wire goes quiet.
        async fn drain(&mut self) -> Vec<String> {
            let mut out = Vec::new();
            while let Some(text) = self.next_text().await {
                out.push(text);
            }
            out
        }
    }

    fn user_message_frame(session: &str, text: &str) -> Frame {
        let body = json!({
            "tug_session_id": session,
            "type": "user_message",
            "content": [{ "type": "text", "text": text }],
        });
        Frame::new(FeedId::CODE_INPUT, serde_json::to_vec(&body).unwrap())
    }

    /// The relay is a tee, not a transform: everything sent into the relayed
    /// sink reaches the supervisor-side receiver unchanged and in order, with
    /// the submission broadcast fed first — and a vanished subscriber costs
    /// the broadcast copy, never the forward.
    #[tokio::test]
    async fn the_relay_forwards_frames_unchanged_and_in_order() {
        use tokio::sync::mpsc;

        let (relay_tx, relay_rx) = mpsc::channel(8);
        let (submission_tx, mut submission_rx) = broadcast::channel(8);
        let (forward_tx, mut forward_rx) = mpsc::channel(8);
        tokio::spawn(relay_code_input(relay_rx, submission_tx, forward_tx));

        let frames: Vec<Frame> = ["first ask", "second ask", "third ask"]
            .iter()
            .enumerate()
            .map(|(i, text)| user_message_frame(&format!("s{i}"), text))
            .collect();
        for frame in &frames {
            relay_tx.send(frame.clone()).await.unwrap();
        }
        for frame in &frames {
            assert_eq!(&forward_rx.recv().await.unwrap(), frame);
            assert_eq!(&submission_rx.recv().await.unwrap(), frame);
        }

        drop(submission_rx);
        let extra = user_message_frame("s9", "no one is listening");
        relay_tx.send(extra.clone()).await.unwrap();
        assert_eq!(forward_rx.recv().await.unwrap(), extra);
    }

    fn said(session: &str, msg: &str, text: &str) -> Value {
        json!({
            "type": "assistant_text",
            "tug_session_id": session,
            "msg_id": msg,
            "block_index": 0,
            "is_partial": false,
            "text": text,
        })
    }

    #[tokio::test]
    async fn an_allowlisted_code_frame_becomes_a_beat() {
        let mut h = Harness::start().await;
        h.send_code(said("s1", "m1", "Reading the allowlists first."));
        let beat = h.next_beat().await.expect("a beat");
        assert_eq!(beat["type"], "digest");
        assert_eq!(beat["text"], "Reading the allowlists first.");
        assert_eq!(beat["scopes"], json!(["s1"]));
        assert!(beat["beat"].as_i64().is_some());
        assert!(beat["at"].as_i64().is_some());
        // The kind rides every payload, so the deck can tell what it is
        // looking at — the field the pinned `intent` gave up its place to.
        assert_eq!(beat["kind"], "said");
        h.cancel.cancel();
    }

    #[tokio::test]
    async fn a_submission_becomes_the_ask_line_the_beat_never_had() {
        let mut h = Harness::start().await;
        h.send_submission(json!({
            "type": "user_message",
            "tug_session_id": "s1",
            "content": [{"type": "text", "text": "Consolidate the three taps."}],
        }));
        assert_eq!(
            h.next_text().await.as_deref(),
            Some("asked: Consolidate the three taps.")
        );
        h.cancel.cancel();
    }

    #[tokio::test]
    async fn a_shell_exchange_becomes_a_beat() {
        let mut h = Harness::start().await;
        h.send_shell(json!({
            "type": "exchange_started",
            "tug_session_id": "s1",
            "exchange_id": "e1",
            "command": "cargo nextest run",
        }));
        assert_eq!(h.next_text().await.as_deref(), Some("$ cargo nextest run"));
        h.cancel.cancel();
    }

    #[tokio::test]
    async fn replay_brackets_mute_one_session_without_blocking_another() {
        let mut h = Harness::start().await;
        h.send_code(json!({"type": "replay_started", "tug_session_id": "s1"}));
        h.send_code(said("s1", "m0", "This sentence is history."));
        h.send_code(said("s2", "m0", "This sentence is live work."));
        h.send_code(json!({"type": "replay_complete", "tug_session_id": "s1"}));
        h.send_code(said("s1", "m1", "And this sentence is live too."));

        let texts = h.drain().await;
        assert!(
            !texts.iter().any(|t| t.contains("history")),
            "a replayed frame was narrated: {texts:?}"
        );
        assert!(texts.iter().any(|t| t.contains("live work")));
        assert!(texts.iter().any(|t| t.contains("live too")));
        h.cancel.cancel();
    }

    #[tokio::test]
    async fn two_lines_inside_the_throttle_window_emit_once_and_the_newer_wins() {
        let mut h = Harness::start().await;
        h.send_code(said("s1", "m1", "The first settled thought."));
        assert_eq!(
            h.next_text().await.as_deref(),
            Some("The first settled thought.")
        );
        // Both land inside the window the first emit opened.
        h.send_code(said("s1", "m2", "A second thought, superseded."));
        h.send_code(said("s1", "m3", "The third thought, which wins."));

        // Nothing yet: the window is still closed.
        assert_eq!(h.next_text().await, None);
        // Past the window the held line is released — deferred, not dropped,
        // which is the whole reason the daemon had a flush loop.
        tokio::time::sleep(Duration::from_millis(VOICE_THROTTLE_MS)).await;
        assert_eq!(
            h.next_text().await.as_deref(),
            Some("The third thought, which wins.")
        );
        h.cancel.cancel();
    }

    #[tokio::test]
    async fn a_compaction_and_the_turn_end_that_follows_it_both_emit() {
        // The exact case a uniform throttle silently loses: on a manual
        // `/compact` the boundary is followed within a frame or two by
        // `turn_complete`, which resets the scope, so a throttled boundary is
        // swallowed and the run reads as if it never happened.
        let mut h = Harness::start().await;
        h.send_code(said("s1", "m1", "Working through the reducer tests."));
        assert!(h.next_text().await.is_some());

        h.send_code(json!({
            "type": "compact_boundary",
            "tug_session_id": "s1",
            "trigger": "manual",
        }));
        h.send_code(json!({"type": "turn_complete", "tug_session_id": "s1"}));

        let texts = h.drain().await;
        assert_eq!(
            texts,
            vec!["Compacted context".to_string(), "Done".to_string()],
            "both bypass the throttle, in order"
        );
        h.cancel.cancel();
    }

    #[tokio::test]
    async fn the_deque_records_what_was_broadcast() {
        let mut h = Harness::start().await;
        h.send_code(said(
            "s1",
            "m1",
            "Folding the composer and the transcript on one clock.",
        ));
        let beat = h.next_beat().await.expect("a beat");

        // The deque is what `list_digest_lines` answers from, and the tail read
        // is the whole of what a reconnecting deck gets — so what the strip was
        // told and what the deque holds have to be the same line.
        let rows = lock_digester(&h.digester)
            .digest("s1")
            .expect("a scope")
            .tail(DIGEST_TAIL_LEN);
        let row = rows.last().expect("one row").clone();
        assert_eq!(row.text, beat["text"].as_str().unwrap());
        assert_eq!(row.beat as i64, beat["beat"].as_i64().unwrap());
        assert_eq!(row.at_ms as i64, beat["at"].as_i64().unwrap());
        h.cancel.cancel();
    }

    /// The deque is the one account of the session, and the bridge is its only
    /// writer: a reader that holds the same handle sees every line, in order,
    /// whatever the strip's own throttle did with them — which is the property
    /// the Observer's window and the deck's tail read both rest on.
    #[tokio::test]
    async fn the_deque_every_reader_reads_is_the_one_the_bridge_fills() {
        let mut h = Harness::start().await;
        h.send_submission(json!({
            "type": "user_message",
            "tug_session_id": "s1",
            "content": [{"type": "text", "text": "Consolidate the three taps."}],
        }));
        assert!(h.next_text().await.is_some());
        h.send_code(said("s1", "m1", "Reading the allowlists first."));
        // Held back from the strip by the throttle the ask just armed — and
        // in the deque all the same.
        assert_eq!(h.next_text().await, None);

        let texts: Vec<String> = lock_digester(&h.digester)
            .digest("s1")
            .expect("the session's deque")
            .since(0)
            .map(|line| line.text.clone())
            .collect();
        assert_eq!(
            texts,
            vec![
                "asked: Consolidate the three taps.".to_string(),
                "Reading the allowlists first.".to_string(),
            ]
        );
        h.cancel.cancel();
    }

    #[tokio::test]
    async fn an_ask_is_spelled_as_an_ask_on_the_wire() {
        let mut h = Harness::start().await;
        // Rung (2) of the masthead's ladder rests on this one distinction: an
        // ask and a tool line differ only by their kind, so a payload that
        // could not say which is a ladder with no source ([D187]).
        h.send_submission(json!({
            "type": "user_message",
            "tug_session_id": "s1",
            "content": [{"type": "text", "text": "Consolidate the three taps."}],
        }));
        let beat = h.next_beat().await.expect("a beat");
        assert_eq!(beat["kind"], "ask");
        assert_eq!(beat["text"], "asked: Consolidate the three taps.");
        h.cancel.cancel();
    }

    #[tokio::test]
    async fn a_line_identical_to_what_the_strip_shows_is_not_news() {
        let mut h = Harness::start().await;
        h.send_code(said("s1", "m1", "The same thought, twice."));
        assert_eq!(
            h.next_text().await.as_deref(),
            Some("The same thought, twice.")
        );
        tokio::time::sleep(Duration::from_millis(VOICE_THROTTLE_MS)).await;
        h.send_code(said("s1", "m2", "The same thought, twice."));
        assert_eq!(h.next_text().await, None);
        h.cancel.cancel();
    }

    #[tokio::test]
    async fn the_permission_wait_reaches_the_strip_at_once() {
        // A strip that freezes says nothing, which is why the wait pair is in
        // the emit-now class.
        let mut h = Harness::start().await;
        h.send_code(json!({
            "type": "tool_input_progress",
            "tug_session_id": "s1",
            "msg_id": "m1",
            "block_index": 0,
            "tool_use_id": "toolu_1",
            "tool_name": "Write",
            "file_path": "tugdeck/src/deck-manager.ts",
            "content_lines": 12,
        }));
        assert_eq!(
            h.next_text().await.as_deref(),
            Some("Writing tugdeck/src/deck-manager.ts — 12 lines")
        );
        // Inside the window a throttled line would have been held. This is not.
        h.send_code(json!({
            "type": "control_request_forward",
            "tug_session_id": "s1",
            "request_id": "req_1",
            "tool_use_id": "toolu_2",
            "tool_name": "Bash",
            "input": {"command": "rm -rf build"},
            "is_question": false,
        }));
        assert_eq!(
            h.next_text().await.as_deref(),
            Some("Waiting for permission: Running rm -rf build")
        );
        h.cancel.cancel();
    }
}
