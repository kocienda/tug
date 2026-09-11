//! observer — the live OVERVIEW bridge: taps the wires a session's work
//! travels on, decides when to wake the Observer, and turns what the model
//! answers into a ledger row and a broadcast frame.
//!
//! Topology:
//!
//!   CODE_OUTPUT ──allowlist tap──┐
//!   CODE_INPUT submissions ──────┼▶ session_digest ──▶ per-session window ─┐
//!   SESSION_STATE ───────────────────▶ session-end wake ───────────────────┼─ wake ──▶ observer-post
//!                                                                          │              │
//!                                                    silence ◀── envelope ─────────────────┤
//!                                                                                         ▼
//!                                              overview_posts row + OVERVIEW broadcast
//!
//! The window holds **digest lines** — the one account of a session's work
//! ([P01]), the same lines the beat shows — rather than the raw payload JSON it
//! held while there were three accounts. Refs are still validated against the
//! window's rendered text verbatim, so what the digest never spelled can never
//! be linked.
//!
//! Everything about *what* a wake means lives in [`super::observer_wake`],
//! which the offline replay harness drives too — that shared core is why the
//! cadence tuned against real transcripts is the cadence that ships. This
//! module is the tokio half: subscriptions, timers, the pool call, the ledger,
//! and the wire.
//!
//! ## Two failures that must not look alike
//!
//! A wake can end in silence for two entirely different reasons. The model can
//! read the window and decide there is nothing worth telling — that is the
//! channel working, and the frames are spent. Or the job can fail: a dead
//! worker, a timeout, no `claude` on the machine. Then nobody read the window
//! at all, and dropping it would silently lose a stretch of real work. So a
//! failed job puts its window back at the front of the session's buffer
//! (bounded by the same caps) and logs a distinct warning. The two are
//! separated again at the parse: an envelope that would not parse is not the
//! model choosing silence either, and it says so in the log.
//!
//! One-way isolation ([P12]): nothing here writes toward any work session, and
//! the Overview's own frames travel on `OVERVIEW`, a feed this module never
//! subscribes to — a post can therefore never become evidence for the next
//! post.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use tokio::sync::{broadcast, mpsc};
use tokio::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};
use tugcast_core::{FeedId, Frame, OverviewAuthor, OverviewPost, StreamFeed};

use crate::feeds::draft_engine::SessionResolver;
use crate::session_ledger::SessionLedger;
use crate::shared_agent::SharedAgentPool;

use super::observer_wake::{
    FactLine, OBSERVER_PROSE_GRACE, OBSERVER_PROSE_LIMIT, PriorPost, WakeReason, clamp_post_body,
    compose_observer_input, counts_as_assistant_activity, parse_envelope, prose_len,
    render_facts_section, synopsis_register_report, validate_refs,
};
use super::overview_agent::DEFAULT_CARD_ROWS;
use super::payload_inspector::InspectedPayload;
use super::session_digest::{SessionDigest, SessionDigester, forwardable_session};

/// How many posts the card's CONTROL tail read answers with when it asks for
/// no particular number. Matches the opening request `card_rows` sizes, so a
/// deck that has not yet read that default off the DEFAULTS feed still fills
/// its first screen exactly once.
pub const OVERVIEW_TAIL_LEN: usize = DEFAULT_CARD_ROWS;

/// The job the Observer's wake runs.
const OBSERVER_POST_JOB: &str = "observer-post";

/// How long a raw answer may be in the log line that reports it unparseable.
/// Enough to see what shape the model produced, short enough not to dump a
/// whole digest into tracing on every failure.
const RAW_LOG_CHARS: usize = 400;

/// How many facts a wake reads before the section's own caps narrow them.
/// A little wider than [`render_facts_section`]'s ceiling so the section is
/// choosing among the newest facts rather than among whatever the read happened
/// to return first.
const FACTS_FETCH_LIMIT: usize = 64;

// MARK: - Configuration

/// Everything the bridge task needs.
///
/// Every knob is a closure rather than a value: each is read at the moment it
/// is used, so turning one in tugbank applies to the next wake with no restart
/// — the `scribe_model` posture, and the reason the cadence is tunable
/// against lived experience rather than only against replayed transcripts.
pub struct ObserverBridgeConfig {
    /// The shared CODE_OUTPUT broadcast — subscribed inside the task.
    pub code_tx: broadcast::Sender<Frame>,
    /// The CODE_INPUT submission broadcast: what the human actually asked.
    /// Inherently live (replay never rides CODE_INPUT), so it needs no mute
    /// set of its own.
    pub submission_tx: broadcast::Sender<Frame>,
    /// SESSION_STATE, watched for the frame that says a session ended.
    pub session_state_tx: broadcast::Sender<Frame>,
    /// Where posts are persisted and where a wake reads its own prior posts.
    /// Absent in a build with no ledger, which reads as "post nothing".
    pub ledger: Option<Arc<SessionLedger>>,
    /// The CONTROL broadcast, for the `session_updated` push that carries a
    /// revised standing sentence to every surface showing that session. Absent
    /// in tests and in a ledger-less build; the ledger write still lands, and
    /// the next listing picks it up.
    pub control_tx: Option<broadcast::Sender<Frame>>,
    /// Tug session id → the ledger row the session's sentence belongs to.
    ///
    /// Rows are keyed by **claude's** session id, which is the tug id for a
    /// plain fresh spawn and something else after a rewind fork or an id
    /// rotation. There is deliberately no fallback to the tug id: the resolver
    /// returns `None` both for a session it has no entry for and for a
    /// momentarily contended lock, and those two are indistinguishable here.
    /// Guessing the tug id would, for a fork, name the *parent's* row —
    /// writing one session's sentence onto another's, which is the
    /// confidently-wrong outcome [D132] ranks below saying nothing.
    pub resolver: SessionResolver,
    /// The Overview's Sonnet pool. Absent means no model, and no wake ever runs.
    pub agent: Option<Arc<SharedAgentPool>>,
    /// The subsystem's one kill switch, `dev.tugapp.overview/enabled`
    /// ([P10]). Read at every wake, so a flip is live with no restart.
    ///
    /// It gates the wakes and nothing else: the digest keeps filling, the beat
    /// keeps moving, and the masthead's upper line falls through to the turn's
    /// ask. What it switches off is the only model cost in the subsystem.
    pub enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    pub sitrep_secs: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub last_k_posts: Arc<dyn Fn() -> usize + Send + Sync>,
    pub token_wake_tokens: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub buffer_max_frames: Arc<dyn Fn() -> usize + Send + Sync>,
}

/// The OVERVIEW feed. A [`StreamFeed`] like `DigestBridge`: the router creates
/// the channel, records the `Warn` lag policy, and spawns the loop.
pub struct ObserverBridge {
    config: ObserverBridgeConfig,
}

impl ObserverBridge {
    pub fn new(config: ObserverBridgeConfig) -> Self {
        Self { config }
    }
}

#[async_trait]
impl StreamFeed for ObserverBridge {
    fn feed_id(&self) -> FeedId {
        FeedId::OVERVIEW
    }

    fn name(&self) -> &str {
        "overview"
    }

    /// Posts are rare and small; the tail a reconnecting deck needs comes from
    /// the `list_overview_posts` CONTROL read rather than feed replay, so a
    /// small channel and the default `Warn` policy are right.
    fn channel_capacity(&self) -> usize {
        64
    }

    async fn run(self: Box<Self>, tx: broadcast::Sender<Frame>, cancel: CancellationToken) {
        observer_bridge_task(self.config, tx, cancel).await;
    }
}

// MARK: - Per-session state

/// One session's window between wakes.
struct SessionWindow {
    /// The digest lines this session produced since its last wake.
    buffer: SessionDigest,
    /// When the buffer stopped being empty. The sitrep deadline is measured
    /// from here, so an idle session has no deadline at all rather than one
    /// that fires over nothing.
    armed_at: Option<Instant>,
    /// Tokens the session has spent since its last post, for the threshold
    /// wake. Zeroed when a wake takes the window.
    tokens: i64,
    /// Whether anything the assistant did is in this window.
    ///
    /// A local command — `/model`, `/compact` — opens and closes a turn with
    /// nothing in between, and the offline sweep showed those turn ends
    /// spending a model call to be told nothing happened. A turn-end wake over
    /// a window holding only the prompt and the turn's own bookends is
    /// therefore skipped. The timer is unaffected: if such a window later
    /// grows real work, the sitrep still finds it.
    assistant_activity: bool,
    /// The window a running job is holding, kept so a failure can give it
    /// back. `Some` is also what makes a session's wakes serial — a second
    /// wake while one is in flight would race two posts about overlapping work
    /// into the channel in either order.
    in_flight: Option<SessionDigest>,
    /// The facts section the in-flight wake was shown, verbatim — the second
    /// ref-validation corpus ([P10]). Kept beside the window because a sha the
    /// post cites may appear only here: a `commit` fact carries it, while the
    /// frame that mentioned it may have aged out of the buffer or never rode
    /// the wire at all. Rebuilding it at settle time would be a second
    /// rendering of the same facts, which is the drift this plan forbids.
    in_flight_facts: Option<String>,
}

impl SessionWindow {
    fn new(max_frames: usize) -> Self {
        Self {
            buffer: SessionDigest::new(max_frames, super::overview_agent::BUFFER_MAX_BYTES),
            armed_at: None,
            tokens: 0,
            assistant_activity: false,
            in_flight: None,
            in_flight_facts: None,
        }
    }
}

/// What a finished job reports back to the loop.
struct WakeOutcome {
    session_id: String,
    reason: WakeReason,
    result: Result<String, String>,
    /// How long the wake job ran, clocked around the agent turn itself.
    elapsed_ms: i64,
}

// MARK: - The loop

async fn observer_bridge_task(
    config: ObserverBridgeConfig,
    overview_tx: broadcast::Sender<Frame>,
    cancel: CancellationToken,
) {
    let mut code_rx = config.code_tx.subscribe();
    let mut submission_rx = config.submission_tx.subscribe();
    let mut state_rx = config.session_state_tx.subscribe();
    let (outcome_tx, mut outcome_rx) = mpsc::channel::<WakeOutcome>(16);

    let mut sessions: HashMap<String, SessionWindow> = HashMap::new();
    // The one digester ([P01]). It turns each frame into the line the beat
    // shows; the windows above are what the Observer keeps of them, which is
    // why this reads through `line_for_*` and keeps no deque of its own.
    let mut digester = SessionDigester::new();
    // Sessions inside a replay bracket. Mute state tracks the wire: a
    // session that entered replay does not get that replay narrated.
    let mut muted: HashSet<String> = HashSet::new();

    loop {
        // The only timer is the earliest armed sitrep deadline. Recomputed
        // each pass, so a knob turned between frames lands on the next arm.
        let sitrep = Duration::from_secs(sitrep_secs(&config).max(0) as u64);
        let next_deadline = if sitrep.is_zero() {
            None
        } else {
            sessions
                .values()
                .filter(|w| w.in_flight.is_none())
                .filter_map(|w| w.armed_at)
                .map(|armed| armed + sitrep)
                .min()
        };

        tokio::select! {
            _ = cancel.cancelled() => {
                info!("overview observer: cancelled");
                return;
            }
            recv = code_rx.recv() => {
                let frame = match recv {
                    Ok(frame) => frame,
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        // Narration never backpressures work.
                        warn!(skipped, "overview observer: code broadcast lagged");
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        info!("overview observer: code broadcast closed");
                        return;
                    }
                };
                handle_code_frame(&config, &mut sessions, &mut digester, &mut muted, &frame, &outcome_tx);
            }
            recv = submission_rx.recv() => {
                let frame = match recv {
                    Ok(frame) => frame,
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        warn!(skipped, "overview observer: submission broadcast lagged");
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => continue,
                };
                handle_submission_frame(&config, &mut sessions, &mut digester, &frame);
            }
            recv = state_rx.recv() => {
                let frame = match recv {
                    Ok(frame) => frame,
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        warn!(skipped, "overview observer: session-state broadcast lagged");
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => continue,
                };
                if let Some(session_id) = ended_session(&frame.payload) {
                    wake(&config, &mut sessions, &session_id, WakeReason::SessionEnd, &outcome_tx);
                }
            }
            Some(outcome) = outcome_rx.recv() => {
                settle(&config, &overview_tx, &mut sessions, outcome);
            }
            _ = sleep_until_opt(next_deadline) => {
                let now = Instant::now();
                let due: Vec<String> = sessions
                    .iter()
                    .filter(|(_, w)| w.in_flight.is_none())
                    .filter(|(_, w)| w.armed_at.is_some_and(|a| now >= a + sitrep))
                    .map(|(id, _)| id.clone())
                    .collect();
                for session_id in due {
                    wake(&config, &mut sessions, &session_id, WakeReason::SitrepTimer, &outcome_tx);
                }
            }
        }
    }
}

/// Await a deadline, or nothing at all when there is none. `select!` needs a
/// branch it can poll either way, and a pending future is how "no timer" is
/// spelled without inventing an arbitrary far-future instant.
async fn sleep_until_opt(deadline: Option<Instant>) {
    match deadline {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

// MARK: - The taps

fn handle_code_frame(
    config: &ObserverBridgeConfig,
    sessions: &mut HashMap<String, SessionWindow>,
    digester: &mut SessionDigester,
    muted: &mut HashSet<String>,
    frame: &Frame,
    outcome_tx: &mpsc::Sender<WakeOutcome>,
) {
    // The meter runs whether or not the frame is narratable ink: a
    // `cost_update` is what a turn actually spent, and it is the only live
    // frame that carries usage at all. It never enters the buffer — a
    // threshold reading is not something to write a post *about*.
    if let Some((session_id, spent)) = turn_cost(&frame.payload) {
        let window = window_for(config, sessions, &session_id);
        window.tokens += spent;
    }

    let Some(session_id) = forwardable_session(&frame.payload, muted) else {
        return;
    };
    let msg_type = InspectedPayload::from_slice(&frame.payload)
        .and_then(|p| p.msg_type)
        .unwrap_or_default();
    let turn_ended = matches!(msg_type.as_str(), "turn_complete" | "turn_cancelled");
    // One frame, one line — or none: several allowlisted types the daemon
    // never narrated produce nothing, and a window is the lines rather than
    // the frames.
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&frame.payload) else {
        return;
    };
    let digested = digester.line_for_code_frame(&session_id, &value, now_ms() as u64);

    let threshold = (config.token_wake_tokens)();
    let (assistant_activity, tokens) = {
        let window = window_for(config, sessions, &session_id);
        // The predicate reads the FRAME's type rather than the line's kind:
        // an `error` or a `task_started` produces no line at all, and a turn
        // whose only content was one of those still held work. The wake count
        // is the one number the replay harness reports, so it is the one thing
        // this port must not move.
        if counts_as_assistant_activity(&msg_type) {
            window.assistant_activity = true;
        }
        if let Some(digested) = digested
            && digested.record
        {
            push(window, digested.line);
        }
        (window.assistant_activity, window.tokens)
    };

    if turn_ended {
        if assistant_activity {
            wake(
                config,
                sessions,
                &session_id,
                WakeReason::TurnEnd,
                outcome_tx,
            );
        } else {
            debug!(
                session_id,
                "overview observer: turn ended with no assistant activity; not waking"
            );
        }
        return;
    }
    if threshold > 0 && tokens >= threshold {
        wake(
            config,
            sessions,
            &session_id,
            WakeReason::TokenThreshold,
            outcome_tx,
        );
    }
}

/// A user prompt joins the same buffer: half of what makes a post readable is
/// what the person asked for. It is not assistant activity, so a turn that
/// holds only a prompt still counts as empty for the turn-end skip.
fn handle_submission_frame(
    config: &ObserverBridgeConfig,
    sessions: &mut HashMap<String, SessionWindow>,
    digester: &mut SessionDigester,
    frame: &Frame,
) {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&frame.payload) else {
        return;
    };
    // The digester reads the type, the session and the prompt's own budget —
    // `submission_beat` is what says a frame is a `user_message` at all.
    let Some((session_id, digested)) = digester.line_for_submission(&value, now_ms() as u64) else {
        return;
    };
    let window = window_for(config, sessions, &session_id);
    push(window, digested.line);
}

fn window_for<'a>(
    config: &ObserverBridgeConfig,
    sessions: &'a mut HashMap<String, SessionWindow>,
    session_id: &str,
) -> &'a mut SessionWindow {
    sessions
        .entry(session_id.to_string())
        .or_insert_with(|| SessionWindow::new((config.buffer_max_frames)()))
}

/// Append one line and arm the session's sitrep if this is what ended its
/// idleness.
fn push(window: &mut SessionWindow, line: crate::feeds::session_digest::DigestLine) {
    if window.buffer.is_empty() {
        window.armed_at = Some(Instant::now());
    }
    window.buffer.push(line);
}

/// The session id on a SESSION_STATE frame that reports an ended session.
///
/// `errored` counts alongside `closed`: a session that died mid-work is
/// exactly the thing someone wants to be told about, and the wrap-up the
/// Observer writes for it is the record of how far it got.
fn ended_session(payload: &[u8]) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_slice(payload).ok()?;
    let state = parsed.get("state")?.as_str()?;
    if !matches!(state, "closed" | "errored") {
        return None;
    }
    parsed.get("tug_session_id")?.as_str().map(str::to_string)
}

/// A turn's cost, as the only live frame that carries usage reports it.
///
/// `cost_update` carries the turn's last tool-loop iteration — input, output,
/// and both cache figures — which is what the turn cost to run. Summing that
/// across turns is "what this session has spent since I last posted", which is
/// exactly the question the threshold wake asks.
fn turn_cost(payload: &[u8]) -> Option<(String, i64)> {
    let parsed: serde_json::Value = serde_json::from_slice(payload).ok()?;
    if parsed.get("type")?.as_str()? != "cost_update" {
        return None;
    }
    let session_id = parsed.get("tug_session_id")?.as_str()?.to_string();
    let usage = parsed.get("usage")?.as_object()?;
    let total: i64 = [
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ]
    .iter()
    .filter_map(|k| usage.get(*k).and_then(serde_json::Value::as_i64))
    .sum();
    Some((session_id, total))
}

fn sitrep_secs(config: &ObserverBridgeConfig) -> i64 {
    (config.sitrep_secs)()
}

// MARK: - Waking

/// Take a session's window and run the job off-thread.
///
/// Off-thread is load-bearing: a `observer-post` may hold a worker for its
/// full two-minute ceiling, and the tap loop cannot stop reading the wire for
/// that long without lagging its own subscriptions.
fn wake(
    config: &ObserverBridgeConfig,
    sessions: &mut HashMap<String, SessionWindow>,
    session_id: &str,
    reason: WakeReason,
    outcome_tx: &mpsc::Sender<WakeOutcome>,
) {
    let Some(agent) = config.agent.clone() else {
        return;
    };
    // The kill switch, read beside the privacy flag and for the same reason:
    // once per wake, on the wake path, never on the frame path. A wake that
    // does not run leaves the window standing, so flipping the switch back on
    // resumes from the work that accumulated rather than from nothing.
    if !(config.enabled)() {
        return;
    }
    let Some(window) = sessions.get_mut(session_id) else {
        return;
    };
    if window.in_flight.is_some() {
        return;
    }
    // Silence is not news. An idle session's timer fires over nothing, and
    // the right answer is no wake at all rather than a wake the model then
    // declines.
    if window.buffer.is_empty() {
        window.armed_at = None;
        return;
    }

    // Wake-time privacy ([P05]). Read once per wake — wakes are rare, and the
    // alternative is a DB read on the frame path. The window is taken and
    // dropped rather than left standing: a session made public again narrates
    // from that moment on, not from everything that accumulated while it was
    // hidden.
    let private = config
        .ledger
        .as_ref()
        .map(|ledger| {
            ledger.is_session_private(session_id).unwrap_or_else(|err| {
                // An unreadable flag is not a licence to narrate: a failed read
                // reads as private, because the cost of being wrong the other
                // way is publishing what the user asked to keep out.
                warn!(error = %err, "overview observer: privacy read failed; treating as private");
                true
            })
        })
        .unwrap_or(false);
    if private {
        window.buffer.take();
        window.armed_at = None;
        window.tokens = 0;
        window.assistant_activity = false;
        return;
    }

    let taken = window.buffer.take();
    window.armed_at = None;
    window.tokens = 0;
    window.assistant_activity = false;

    let priors = config
        .ledger
        .as_ref()
        .map(|ledger| {
            ledger
                .list_overview_posts_for_session(session_id, (config.last_k_posts)())
                .unwrap_or_else(|err| {
                    warn!(error = %err, "overview observer: prior-post read failed");
                    Vec::new()
                })
        })
        .unwrap_or_default()
        .into_iter()
        .map(|post| PriorPost {
            at_ms: post.at_ms,
            body: post.body,
        })
        .collect::<Vec<_>>();

    // Facts newer than the newest prior post — everything the library holds
    // when there are no priors. A failed read warns and composes `(none)`: a
    // facts read must never cost a wake.
    let facts = config
        .ledger
        .as_ref()
        .map(|ledger| {
            let since = priors.last().map(|post| post.at_ms);
            ledger
                .list_facts_for_session_since(session_id, None, since, FACTS_FETCH_LIMIT)
                .unwrap_or_else(|err| {
                    warn!(error = %err, "overview observer: facts read failed");
                    Vec::new()
                })
        })
        .unwrap_or_default()
        .into_iter()
        .map(|row| FactLine {
            at_ms: row.at_ms,
            text: row.text,
        })
        .collect::<Vec<_>>();
    let facts_section = render_facts_section(&facts);

    let input = compose_observer_input(reason, session_id, &taken, &priors, &facts);
    window.in_flight = Some(taken);
    window.in_flight_facts = Some(facts_section);

    let outcome_tx = outcome_tx.clone();
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        let started = Instant::now();
        let result = agent.run(OBSERVER_POST_JOB, input).await;
        let _ = outcome_tx
            .send(WakeOutcome {
                session_id,
                reason,
                result,
                elapsed_ms: started.elapsed().as_millis() as i64,
            })
            .await;
    });
}

/// Turn a finished job into a post, a silence, or a returned window.
fn settle(
    config: &ObserverBridgeConfig,
    overview_tx: &broadcast::Sender<Frame>,
    sessions: &mut HashMap<String, SessionWindow>,
    outcome: WakeOutcome,
) {
    let WakeOutcome {
        session_id,
        reason,
        result,
        elapsed_ms,
    } = outcome;
    let Some(window) = sessions.get_mut(&session_id) else {
        return;
    };
    let Some(sent) = window.in_flight.take() else {
        return;
    };
    // The facts the job was shown. Taken with the window: the two are one
    // wake's input, and the second corpus for its refs.
    let facts_shown = window.in_flight_facts.take().unwrap_or_default();

    let raw = match result {
        Ok(raw) => raw,
        Err(err) => {
            // Nobody read the window. Give it back, ahead of whatever arrived
            // while the job ran, and re-arm so it is not stranded waiting for
            // a frame that may never come.
            warn!(
                session_id,
                reason = reason.as_str(),
                error = %err,
                "overview observer: wake job failed; window returned to the buffer",
            );
            window.buffer.restore_front(sent);
            if !window.buffer.is_empty() && window.armed_at.is_none() {
                window.armed_at = Some(Instant::now());
            }
            return;
        }
    };

    let Some(envelope) = parse_envelope(&raw) else {
        // Not the model choosing silence — the model answering something the
        // contract cannot read. Logged apart from a real no-post so a rising
        // rate is visible rather than looking like a quiet channel.
        warn!(
            session_id,
            reason = reason.as_str(),
            raw = %raw.chars().take(RAW_LOG_CHARS).collect::<String>(),
            "overview observer: unparseable envelope; posting nothing",
        );
        return;
    };
    // The standing sentence, written independently of the post ([P08]). A
    // wake may revise the sentence and post nothing, post and leave the
    // sentence alone, do both, or do neither — so this runs before the post
    // branch's early return, not after it.
    write_synopsis(config, &session_id, envelope.synopsis.as_deref());

    let Some(post) = envelope.post else {
        debug!(
            session_id,
            reason = reason.as_str(),
            "overview observer: nothing worth posting"
        );
        return;
    };

    // Two corpora, never concatenated ([P10]): a sha the post cites may live
    // only in the facts section, and a path only in the activity window.
    let rendered = sent.rendered();
    let validated = validate_refs(post.refs, &[&rendered, facts_shown.as_str()]);
    if !validated.dropped.is_empty() {
        warn!(
            session_id,
            dropped = validated.dropped.len(),
            targets = ?validated.dropped.iter().map(|r| r.target.as_str()).collect::<Vec<_>>(),
            "overview observer: refs dropped — target in neither the window nor the facts verbatim",
        );
    }

    // The prose budget's backstop: the instructions state the limit, and a
    // body that ignored it is cut here so what persists and what broadcasts
    // are the same clamped text. Logged because a rising clamp rate means the
    // prompt has stopped binding — and an overshoot the grace absorbed says
    // that too, so it is logged rather than passing silently.
    let body = clamp_post_body(&post.body, OBSERVER_PROSE_LIMIT, OBSERVER_PROSE_GRACE);
    if body != post.body {
        warn!(
            session_id,
            reason = reason.as_str(),
            chars = post.body.chars().count(),
            prose = prose_len(&post.body),
            "overview observer: body over the prose budget; clamped",
        );
    } else if prose_len(&body) > OBSERVER_PROSE_LIMIT {
        debug!(
            session_id,
            reason = reason.as_str(),
            prose = prose_len(&body),
            "overview observer: body over the prose budget; within grace, kept whole",
        );
    }

    // The narrated session's project dir, from the ledger's session row —
    // the root the refs were spelled under, so the deck can resolve them.
    // A session the ledger does not know leaves it `None`, and those refs
    // render inert rather than against a guessed root.
    let project_dir = config
        .ledger
        .as_ref()
        .and_then(|ledger| ledger.get(&session_id).ok().flatten())
        .map(|row| row.project_dir);

    let mut record = OverviewPost {
        id: None,
        at_ms: now_ms(),
        author: OverviewAuthor::Observer,
        session_id: Some(session_id.clone()),
        wake_reason: Some(reason.as_str().to_string()),
        body,
        refs: validated.kept,
        elapsed_ms: Some(elapsed_ms),
        project_dir,
        // The Observer narrates in words.
        attachments: Vec::new(),
        request_id: None,
        transient: false,
    };
    if let Some(ledger) = config.ledger.as_ref() {
        match ledger.record_overview_post(&record) {
            Ok(id) => record.id = Some(id),
            Err(err) => {
                warn!(error = %err, "overview observer: ledger write failed");
            }
        }
    }
    match serde_json::to_vec(&record) {
        Ok(bytes) => {
            let _ = overview_tx.send(Frame::new(FeedId::OVERVIEW, bytes));
        }
        Err(err) => warn!(error = %err, "overview observer: post did not serialize"),
    }
}

/// Write the wake's standing sentence, or leave the one that stands alone.
///
/// Silence is the safe failure mode here exactly as it is for the post, and
/// there are four ways to take it ([P08]): the model answered `null`, the
/// answer normalized to nothing under the register, the session's row cannot
/// be identified, or the row already says this. A sentence that blanks on a
/// bad turn is worse than one that is a minute stale, so nothing on this path
/// ever clears `sessions.synopsis` — it only ever replaces it with words
/// somebody wrote.
fn write_synopsis(config: &ObserverBridgeConfig, session_id: &str, raw: Option<&str>) {
    let Some(raw) = raw else {
        return;
    };
    let Some(ledger) = config.ledger.as_ref() else {
        return;
    };
    let report = synopsis_register_report(raw);
    if report.text.is_empty() {
        debug!(
            session_id,
            raw, "overview observer: synopsis normalized to nothing; the sentence stands"
        );
        return;
    }
    // See `ObserverBridgeConfig::resolver`: no fallback to the tug id.
    let Some(row_id) = (config.resolver)(session_id) else {
        return;
    };
    match ledger.record_synopsis(&row_id, &report.text) {
        Ok(true) => {
            info!(
                session_id,
                row = %row_id,
                synopsis = %report.text,
                normalized = report.normalized,
                clipped = report.clipped,
                "overview observer: standing sentence written",
            );
            if let (Some(tx), Ok(Some(row))) = (config.control_tx.as_ref(), ledger.get(&row_id)) {
                // Every push carries the scan pair, this one included — see
                // `build_session_updated_frame`, and the usage beside it.
                let metrics = ledger.scan_metrics_for(&row_id).unwrap_or(None);
                let usage = ledger.usage_for(&row_id).unwrap_or(None);
                let _ = tx.send(crate::feeds::agent_supervisor::build_session_updated_frame(
                    &row, metrics, usage,
                ));
            }
        }
        // The row already says exactly this.
        Ok(false) => {}
        Err(error) => {
            warn!(%error, session_id, "overview observer: synopsis write failed");
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared_agent::test_support::FakeSpawner;
    use crate::shared_agent::{AgentSpec, AgentWorkerSpawner};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

    /// A pool answering a script, on the real job table so timeouts and
    /// instructions are the shipped ones.
    fn pool(spawner: Arc<dyn AgentWorkerSpawner>) -> Arc<SharedAgentPool> {
        SharedAgentPool::new(
            AgentSpec {
                name: "overview",
                model: Arc::new(|| "sonnet".to_string()),
                jobs: super::super::overview_agent::OVERVIEW_AGENT_JOBS,
                max_workers: 3,
            },
            spawner,
        )
    }

    struct Harness {
        code_tx: broadcast::Sender<Frame>,
        submission_tx: broadcast::Sender<Frame>,
        state_tx: broadcast::Sender<Frame>,
        overview_rx: broadcast::Receiver<Frame>,
        control_rx: broadcast::Receiver<Frame>,
        ledger: Arc<SessionLedger>,
        cancel: CancellationToken,
        sitrep: Arc<AtomicI64>,
        /// `dev.tugapp.overview/enabled`, as the wake path reads it.
        enabled: Arc<AtomicBool>,
        /// The tapped channels stay open only while something holds a
        /// receiver; the bridge's own are taken inside its task, so the
        /// harness holds these to keep a send from failing before it starts.
        _keep: (
            broadcast::Receiver<Frame>,
            broadcast::Receiver<Frame>,
            broadcast::Receiver<Frame>,
        ),
    }

    async fn start(spawner: Arc<dyn AgentWorkerSpawner>, sitrep_secs: i64) -> Harness {
        start_with(
            spawner,
            sitrep_secs,
            Arc::new(|id: &str| Some(id.to_string())),
        )
        .await
    }

    /// A harness whose resolver never answers — a session the supervisor has
    /// no entry for, or a contended lock, which are indistinguishable here.
    async fn start_unresolvable(spawner: Arc<dyn AgentWorkerSpawner>) -> Harness {
        start_with(spawner, 90, Arc::new(|_| None)).await
    }

    async fn start_with(
        spawner: Arc<dyn AgentWorkerSpawner>,
        sitrep_secs: i64,
        resolver: SessionResolver,
    ) -> Harness {
        let (code_tx, keep_code) = broadcast::channel(64);
        let (submission_tx, keep_sub) = broadcast::channel(64);
        let (state_tx, keep_state) = broadcast::channel(64);
        let (overview_tx, overview_rx) = broadcast::channel(64);
        let (control_tx, control_rx) = broadcast::channel(64);
        let ledger = Arc::new(SessionLedger::open_in_memory().expect("in-memory ledger"));
        let cancel = CancellationToken::new();
        let sitrep = Arc::new(AtomicI64::new(sitrep_secs));
        let enabled = Arc::new(AtomicBool::new(true));

        let bridge = ObserverBridge::new(ObserverBridgeConfig {
            code_tx: code_tx.clone(),
            submission_tx: submission_tx.clone(),
            session_state_tx: state_tx.clone(),
            ledger: Some(Arc::clone(&ledger)),
            control_tx: Some(control_tx),
            resolver,
            agent: Some(pool(spawner)),
            enabled: {
                let enabled = Arc::clone(&enabled);
                Arc::new(move || enabled.load(Ordering::SeqCst))
            },
            sitrep_secs: {
                let sitrep = Arc::clone(&sitrep);
                Arc::new(move || sitrep.load(Ordering::SeqCst))
            },
            last_k_posts: Arc::new(|| 5),
            token_wake_tokens: Arc::new(|| 0),
            buffer_max_frames: Arc::new(|| 256),
        });
        // The loop's own subscriptions are taken inside `run`, so nothing sent
        // before the task first polls would reach it.
        tokio::spawn(Box::new(bridge).run(overview_tx, cancel.clone()));
        tokio::time::sleep(Duration::from_millis(50)).await;

        Harness {
            code_tx,
            submission_tx,
            state_tx,
            overview_rx,
            control_rx,
            ledger,
            cancel,
            sitrep,
            enabled,
            _keep: (keep_code, keep_sub, keep_state),
        }
    }

    fn code_frame(json: serde_json::Value) -> Frame {
        Frame::new(FeedId::CODE_OUTPUT, json.to_string().into_bytes())
    }

    fn assistant_text(session: &str, text: &str) -> Frame {
        code_frame(serde_json::json!({
            "tug_session_id": session,
            "type": "assistant_text",
            "text": text,
        }))
    }

    /// A file tool as the wire actually carries it: the streaming progress
    /// frame is what narrates a Read or a Write, and the settled `tool_use`
    /// that follows defers to it.
    fn tool_progress(session: &str, id: &str, tool: &str, file_path: &str) -> Frame {
        code_frame(serde_json::json!({
            "tug_session_id": session,
            "type": "tool_input_progress",
            "msg_id": "m1",
            "block_index": 0,
            "seq": 1,
            "tool_use_id": id,
            "tool_name": tool,
            "bytes": 64,
            "content_lines": 0,
            "file_path": file_path,
        }))
    }

    fn turn_complete(session: &str) -> Frame {
        code_frame(serde_json::json!({
            "tug_session_id": session,
            "type": "turn_complete",
            "msg_id": "m1",
            "seq": 1,
            "result": "ok",
        }))
    }

    fn envelope(body: &str) -> String {
        serde_json::json!({ "post": { "body": body } }).to_string()
    }

    async fn next_post(rx: &mut broadcast::Receiver<Frame>) -> OverviewPost {
        let frame = tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .expect("a OVERVIEW frame arrived in time")
            .expect("frame");
        assert_eq!(frame.feed_id, FeedId::OVERVIEW);
        serde_json::from_slice(&frame.payload).expect("a OverviewPost on the wire")
    }

    async fn expect_no_post(rx: &mut broadcast::Receiver<Frame>) {
        assert!(
            tokio::time::timeout(Duration::from_millis(400), rx.recv())
                .await
                .is_err(),
            "the channel should have stayed silent",
        );
    }

    /// The standing sentence carried by the next `session_updated` push, or
    /// `None` if none arrives promptly.
    async fn next_written_synopsis(rx: &mut broadcast::Receiver<Frame>) -> Option<String> {
        loop {
            let frame = tokio::time::timeout(Duration::from_millis(800), rx.recv())
                .await
                .ok()?
                .ok()?;
            let Ok(body) = serde_json::from_slice::<serde_json::Value>(&frame.payload) else {
                continue;
            };
            if body["action"] != "session_updated" {
                continue;
            }
            return body["fields"]["synopsis"].as_str().map(str::to_string);
        }
    }

    /// A wake answers with both, and the sentence lands on the session's row
    /// and on the CONTROL push every surface showing that session reads.
    #[tokio::test]
    async fn a_wake_writes_the_standing_sentence_and_pushes_it() {
        let spawner = FakeSpawner::always(Ok(serde_json::json!({
            "post": { "body": "Vendored the light faces." },
            "synopsis": "Rework how a session names itself",
        })
        .to_string()));
        let mut h = start(spawner, 90).await;
        h.ledger
            .record_spawn("s1", "ws", "/proj", "card-1", 1_000, "s1", None)
            .expect("spawn");

        h.code_tx
            .send(assistant_text("s1", "Wiring the bridge into the feed."))
            .unwrap();
        h.code_tx.send(turn_complete("s1")).unwrap();

        let post = next_post(&mut h.overview_rx).await;
        assert_eq!(post.body, "Vendored the light faces.");
        assert_eq!(
            h.ledger.get("s1").unwrap().unwrap().synopsis.as_deref(),
            Some("Rework how a session names itself"),
        );
        assert_eq!(
            next_written_synopsis(&mut h.control_rx).await.as_deref(),
            Some("Rework how a session names itself"),
        );

        h.cancel.cancel();
    }

    /// The sentence and the post are independent answers ([P08]). A wake that
    /// says nothing worth posting may still revise the sentence.
    #[tokio::test]
    async fn a_sentence_lands_even_when_the_wake_posts_nothing() {
        let spawner = FakeSpawner::always(Ok(serde_json::json!({
            "post": null,
            "synopsis": "Chase the wedge in the download resume path",
        })
        .to_string()));
        let mut h = start(spawner, 90).await;
        h.ledger
            .record_spawn("s1", "ws", "/proj", "card-1", 1_000, "s1", None)
            .expect("spawn");

        h.code_tx
            .send(assistant_text("s1", "Reading the resume path first."))
            .unwrap();
        h.code_tx.send(turn_complete("s1")).unwrap();

        assert_eq!(
            next_written_synopsis(&mut h.control_rx).await.as_deref(),
            Some("Chase the wedge in the download resume path"),
        );
        expect_no_post(&mut h.overview_rx).await;

        h.cancel.cancel();
    }

    /// Every way of saying nothing about the sentence leaves the one that
    /// stands alone ([P08]). A sentence that blanks on a bad turn is worse
    /// than one that is a minute stale, so nothing here ever clears the row.
    #[tokio::test]
    async fn nothing_usable_leaves_the_standing_sentence_alone() {
        for answer in [
            serde_json::json!({ "post": null, "synopsis": null }),
            // Normalizes to nothing: whitespace, and empty quotes.
            serde_json::json!({ "post": null, "synopsis": "   " }),
            serde_json::json!({ "post": null, "synopsis": "\"\"" }),
        ] {
            let spawner = FakeSpawner::always(Ok(answer.to_string()));
            let mut h = start(spawner, 90).await;
            h.ledger
                .record_spawn("s1", "ws", "/proj", "card-1", 1_000, "s1", None)
                .expect("spawn");
            h.ledger
                .record_synopsis("s1", "Rework how a session names itself")
                .expect("a sentence already stands");

            h.code_tx
                .send(assistant_text("s1", "Reading the resume path first."))
                .unwrap();
            h.code_tx.send(turn_complete("s1")).unwrap();
            expect_no_post(&mut h.overview_rx).await;

            assert_eq!(
                h.ledger.get("s1").unwrap().unwrap().synopsis.as_deref(),
                Some("Rework how a session names itself"),
                "answer {answer} moved the sentence",
            );
            h.cancel.cancel();
        }
    }

    /// A session whose row cannot be identified is not "written and failed",
    /// it is not written at all — there is no fallback to the tug id, because
    /// for a fork that would name the parent's row.
    #[tokio::test]
    async fn an_unresolvable_session_writes_no_sentence() {
        let spawner = FakeSpawner::always(Ok(serde_json::json!({
            "post": null,
            "synopsis": "Rework how a session names itself",
        })
        .to_string()));
        let mut h = start_unresolvable(spawner).await;
        h.ledger
            .record_spawn("s1", "ws", "/proj", "card-1", 1_000, "s1", None)
            .expect("spawn");

        h.code_tx
            .send(assistant_text("s1", "Reading the resume path first."))
            .unwrap();
        h.code_tx.send(turn_complete("s1")).unwrap();
        expect_no_post(&mut h.overview_rx).await;

        assert!(h.ledger.get("s1").unwrap().unwrap().synopsis.is_none());
        h.cancel.cancel();
    }

    /// The whole happy path: work arrives, a turn ends, the model writes, the
    /// post is persisted and on the wire.
    #[tokio::test]
    async fn a_turn_end_wake_posts_persists_and_broadcasts() {
        let spawner = FakeSpawner::always(Ok(envelope("Vendored the light faces.")));
        let mut h = start(spawner, 90).await;

        h.code_tx
            .send(assistant_text("s1", "Wiring the bridge into the feed."))
            .unwrap();
        h.code_tx.send(turn_complete("s1")).unwrap();

        let post = next_post(&mut h.overview_rx).await;
        assert_eq!(post.author, OverviewAuthor::Observer);
        assert_eq!(post.session_id.as_deref(), Some("s1"));
        assert_eq!(post.wake_reason.as_deref(), Some("turn-end"));
        assert_eq!(post.body, "Vendored the light faces.");
        assert!(post.id.is_some(), "a persisted post carries its rowid");
        assert!(!post.transient);

        let stored = h.ledger.list_overview_posts_tail(10).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].body, "Vendored the light faces.");

        h.cancel.cancel();
    }

    /// `{"post": null}` is the model reading the work and judging it not worth
    /// telling. Nothing is written and nothing goes on the wire.
    #[tokio::test]
    async fn an_editorial_no_post_writes_nothing() {
        let spawner = FakeSpawner::always(Ok(r#"{"post": null}"#.to_string()));
        let mut h = start(spawner, 90).await;

        h.code_tx
            .send(assistant_text("s1", "Doing some work on the router."))
            .unwrap();
        h.code_tx.send(turn_complete("s1")).unwrap();

        expect_no_post(&mut h.overview_rx).await;
        assert!(h.ledger.list_overview_posts_tail(10).unwrap().is_empty());
        h.cancel.cancel();
    }

    /// The sitrep timer is the dominant wake, and it measures from the moment
    /// the session stopped being idle.
    #[tokio::test]
    async fn the_sitrep_timer_wakes_a_session_that_never_finishes_a_turn() {
        let spawner = FakeSpawner::always(Ok(envelope("Still cooking.")));
        // One second, so the test waits about as long as it takes to notice.
        let mut h = start(spawner, 1).await;

        h.code_tx
            .send(assistant_text(
                "s1",
                "Running a long tool loop over the crate.",
            ))
            .unwrap();

        let post = next_post(&mut h.overview_rx).await;
        assert_eq!(post.wake_reason.as_deref(), Some("sitrep-timer"));
        h.cancel.cancel();
    }

    /// Silence is not news: a session with an empty buffer has no deadline at
    /// all, so nothing fires over it.
    #[tokio::test]
    async fn an_idle_session_never_wakes() {
        let spawner = FakeSpawner::always(Ok(envelope("should never be asked for")));
        let mut h = start(spawner, 1).await;

        // Nothing narratable ever arrives — only a frame type the tap drops.
        h.code_tx
            .send(code_frame(serde_json::json!({
                "tug_session_id": "s1",
                "type": "system_metadata",
            })))
            .unwrap();
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        expect_no_post(&mut h.overview_rx).await;
        h.cancel.cancel();
    }

    /// The subsystem's one switch ([P10]). It gates the wakes and nothing
    /// else, and a wake that does not run leaves the window standing — so
    /// turning it back on narrates the work that accumulated while it was off
    /// rather than starting from nothing. Absent reads as ENABLED, which is
    /// what every other test here exercises.
    #[tokio::test]
    async fn the_overview_switch_gates_the_wake_and_nothing_else() {
        let spawner = FakeSpawner::always(Ok(envelope("A post the switch decides about")));
        // Timer off: only the turn end could wake.
        let mut h = start(spawner, 0).await;
        h.enabled.store(false, Ordering::SeqCst);

        h.code_tx
            .send(assistant_text("s1", "Work done while the switch is off."))
            .unwrap();
        h.code_tx.send(turn_complete("s1")).unwrap();
        expect_no_post(&mut h.overview_rx).await;
        assert!(h.ledger.list_overview_posts_tail(10).unwrap().is_empty());

        // On again, with no restart. The stretch above is still in the window,
        // so the first wake after the flip narrates it.
        h.enabled.store(true, Ordering::SeqCst);
        h.code_tx
            .send(assistant_text("s1", "And more work after it came back."))
            .unwrap();
        h.code_tx.send(turn_complete("s1")).unwrap();
        let post = next_post(&mut h.overview_rx).await;
        assert_eq!(post.body, "A post the switch decides about");
        h.cancel.cancel();
    }

    /// A `/model` or `/compact` opens and closes a turn with nothing in it.
    /// Waking there spends a model call to be told nothing happened.
    #[tokio::test]
    async fn a_turn_holding_no_assistant_activity_does_not_wake() {
        let spawner = FakeSpawner::always(Ok(envelope("should never be asked for")));
        // Timer off: only the turn end could wake.
        let mut h = start(spawner, 0).await;

        h.submission_tx
            .send(Frame::new(
                FeedId::CODE_INPUT,
                serde_json::json!({
                    "tug_session_id": "s1",
                    "type": "user_message",
                    "content": [{ "type": "text", "text": "/model opus" }],
                })
                .to_string()
                .into_bytes(),
            ))
            .unwrap();
        // The prompt and the turn's end travel on different wires; let the
        // prompt land first, so what is being asserted is the emptiness of the
        // turn rather than the emptiness of the buffer.
        tokio::time::sleep(Duration::from_millis(100)).await;
        h.code_tx.send(turn_complete("s1")).unwrap();

        expect_no_post(&mut h.overview_rx).await;

        // The window is not lost — the moment real work lands, the next turn
        // end narrates both it and the prompt that asked for it.
        h.code_tx
            .send(assistant_text("s1", "Doing the real work of the turn."))
            .unwrap();
        h.code_tx.send(turn_complete("s1")).unwrap();
        let post = next_post(&mut h.overview_rx).await;
        assert_eq!(post.wake_reason.as_deref(), Some("turn-end"));
        h.cancel.cancel();
    }

    /// [P10]: the wake reads the facts library and hands the Observer the facts
    /// recorded since its newest prior post — and a sha carried only by a fact
    /// survives ref validation, which is the whole point of the second corpus.
    ///
    /// The ref target is the sha as the FACT SPELLS IT — `SHA_TEXT_LEN`
    /// characters, not the whole stored hash. That is the only spelling the
    /// model was shown, and copying exactly what you were shown is the rule
    /// validation enforces.
    #[tokio::test]
    async fn a_wake_carries_the_facts_recorded_since_the_last_post() {
        let spawner = FakeSpawner::always(Ok(r#"{"post": {"body": "A commit landed.", "refs": [
                {"kind": "commit", "target": "03fcaa08"}
            ]}}"#
            .to_string()));
        let fake = Arc::clone(&spawner);
        let mut h = start(spawner, 0).await;
        h.ledger
            .record_spawn("s1", "ws", "/proj", "card-1", 1_000, "s1", None)
            .expect("spawn");
        h.ledger
            .record_fact(&crate::feeds::facts_library::commit_fact(
                2_000,
                Some("s1"),
                "03fcaa087",
                "private sessions",
                &["tugdeck/src/protocol.ts".to_string()],
                None,
            ))
            .expect("fact recorded");

        h.code_tx
            .send(assistant_text("s1", "Landed it on the branch."))
            .unwrap();
        h.code_tx.send(turn_complete("s1")).unwrap();
        let post = next_post(&mut h.overview_rx).await;

        let input = fake
            .turns_seen()
            .last()
            .cloned()
            .expect("the pool saw a turn");
        assert!(input.contains(crate::feeds::observer_wake::FACTS_SECTION_HEADER));
        assert!(
            input.contains("03fcaa08"),
            "the commit fact reached the wake input: {input}"
        );
        // The sha appears in no frame — only in the fact — and is kept anyway.
        assert_eq!(post.refs.len(), 1);
        assert_eq!(post.refs[0].target, "03fcaa08");
        h.cancel.cancel();
    }

    /// [P05]: a private session is out of the channel. The wake takes its
    /// window and drops it — no job, no post — and the frames it holds do not
    /// come back when the session is public again: narration resumes from that
    /// moment, which is what from-now-on privacy means.
    #[tokio::test]
    async fn a_private_sessions_wake_takes_its_window_and_posts_nothing() {
        let spawner = FakeSpawner::always(Ok(envelope("should never be asked for")));
        let mut h = start(spawner, 0).await;
        h.ledger
            .record_spawn("s1", "ws", "/proj", "card-1", 1_000, "s1", None)
            .expect("spawn");
        h.ledger
            .set_session_private("s1", true)
            .expect("marked private");

        h.code_tx
            .send(assistant_text(
                "s1",
                "Doing private work nobody may narrate.",
            ))
            .unwrap();
        h.code_tx.send(turn_complete("s1")).unwrap();
        expect_no_post(&mut h.overview_rx).await;
        assert!(h.ledger.list_overview_posts_tail(10).unwrap().is_empty());

        // Public again: the dropped window is gone, but the next turn narrates.
        h.ledger
            .set_session_private("s1", false)
            .expect("marked public");
        h.code_tx
            .send(assistant_text(
                "s1",
                "Doing public work, which may be narrated.",
            ))
            .unwrap();
        h.code_tx.send(turn_complete("s1")).unwrap();
        let post = next_post(&mut h.overview_rx).await;
        assert_eq!(post.session_id.as_deref(), Some("s1"));
        h.cancel.cancel();
    }

    /// A reconnect replays a session's whole history onto CODE_OUTPUT. None of
    /// it is news, and narrating it would post a week of work as if it had
    /// just happened.
    #[tokio::test]
    async fn replay_bracketed_frames_produce_nothing() {
        let spawner = FakeSpawner::always(Ok(envelope("should never be asked for")));
        let mut h = start(spawner, 0).await;

        h.code_tx
            .send(code_frame(serde_json::json!({
                "tug_session_id": "s1", "type": "replay_started",
            })))
            .unwrap();
        h.code_tx
            .send(assistant_text("s1", "Replayed history, which is not news."))
            .unwrap();
        h.code_tx.send(turn_complete("s1")).unwrap();
        expect_no_post(&mut h.overview_rx).await;
        h.cancel.cancel();
    }

    /// [P12]: the Overview's own posts travel on OVERVIEW, a feed this bridge
    /// never subscribes to. A post can never become evidence for the next
    /// post, and there is no wire on which it could.
    #[tokio::test]
    async fn a_overview_frame_never_enters_the_buffer() {
        let spawner = FakeSpawner::always(Ok(envelope("should never be asked for")));
        let mut h = start(spawner, 0).await;

        // Even smuggled onto the tapped wire, a OVERVIEW-shaped payload is not
        // an allowlisted frame type and cannot reach a buffer.
        h.code_tx
            .send(code_frame(serde_json::json!({
                "tug_session_id": "s1",
                "type": "overview_post",
                "body": "an earlier post",
            })))
            .unwrap();
        h.code_tx.send(turn_complete("s1")).unwrap();
        expect_no_post(&mut h.overview_rx).await;
        h.cancel.cancel();
    }

    /// [P14]: a failed job means nobody read the window, which is not the same
    /// as the model choosing silence. The frames come back and reach the next
    /// wake's composed input.
    ///
    /// The clock is paused because a failed turn is a dead worker as far as
    /// the pool is concerned, and a dead worker's class waits out a respawn
    /// debounce before the next one comes up. That debounce is right — a
    /// `claude` that dies on every spawn must not be respawned in a hot loop —
    /// and waiting it out in real seconds would be the slowest test in the
    /// crate for no added truth.
    #[tokio::test(start_paused = true)]
    async fn a_failing_job_returns_its_window_to_the_next_wake() {
        /// Fails the first turn asked of the pool and answers every one after,
        /// counted across workers rather than per worker — the second wake is
        /// served by the replacement the first one's death brought up.
        struct OnceFailing {
            turns: Arc<AtomicI64>,
            seen: Arc<Mutex<Vec<String>>>,
        }
        impl AgentWorkerSpawner for OnceFailing {
            fn spawn(
                &self,
                _model: String,
            ) -> Result<mpsc::Sender<crate::shared_agent::TurnRequest>, String> {
                let (tx, mut rx) = mpsc::channel::<crate::shared_agent::TurnRequest>(8);
                let seen = Arc::clone(&self.seen);
                let turns = Arc::clone(&self.turns);
                tokio::spawn(async move {
                    while let Some(crate::shared_agent::TurnRequest { turn, reply }) =
                        rx.recv().await
                    {
                        seen.lock().unwrap().push(turn.text);
                        let answer = if turns.fetch_add(1, Ordering::SeqCst) == 0 {
                            Err("worker died".to_string())
                        } else {
                            Ok(serde_json::json!({ "post": { "body": "Caught up." } }).to_string())
                        };
                        let _ = reply.send(answer);
                    }
                });
                Ok(tx)
            }
        }
        let seen = Arc::new(Mutex::new(Vec::new()));
        let spawner = Arc::new(OnceFailing {
            turns: Arc::new(AtomicI64::new(0)),
            seen: Arc::clone(&seen),
        });
        let mut h = start(spawner, 0).await;

        h.code_tx
            .send(assistant_text("s1", "The work the failed job never read."))
            .unwrap();
        h.code_tx.send(turn_complete("s1")).unwrap();
        expect_no_post(&mut h.overview_rx).await;
        assert!(
            h.ledger.list_overview_posts_tail(10).unwrap().is_empty(),
            "a failure is not a post",
        );

        // Past the pool's respawn debounce, the next turn's wake carries both
        // windows.
        tokio::time::sleep(Duration::from_secs(6)).await;
        h.code_tx
            .send(assistant_text("s1", "And what came after the failure."))
            .unwrap();
        h.code_tx.send(turn_complete("s1")).unwrap();
        let post = next_post(&mut h.overview_rx).await;
        assert_eq!(post.body, "Caught up.");

        let turns = seen.lock().unwrap().clone();
        let composed = turns.last().expect("a second turn was asked");
        assert!(
            composed.contains("The work the failed job never read."),
            "the returned window rode the next wake",
        );
        assert!(composed.contains("And what came after the failure."));
        let first = composed
            .find("The work the failed job never read.")
            .expect("restored");
        let second = composed
            .find("And what came after the failure.")
            .expect("kept");
        assert!(first < second, "chronology survives the restore");

        h.cancel.cancel();
    }

    /// Refs the model was never shown cannot be linked, so they are dropped
    /// and the body stands on its own.
    #[tokio::test]
    async fn refs_are_validated_against_the_window_the_model_saw() {
        let answer = serde_json::json!({
            "post": {
                "body": "A commit landed.",
                "refs": [
                    { "kind": "commit", "target": "9a9051001" },
                    { "kind": "file", "target": "tugrust/crates/tugcast/src/feeds/observer.rs" },
                    { "kind": "file", "target": "never/shown.rs" },
                ],
            }
        })
        .to_string();
        let spawner = FakeSpawner::always(Ok(answer));
        let mut h = start(spawner, 0).await;

        h.code_tx
            .send(assistant_text(
                "s1",
                "HEAD is now 9a9051001 on the arc branch.",
            ))
            .unwrap();
        // The tool line is the ref surface now ([P04]): a path the digest
        // spelled can be linked, and a path it never spelled cannot.
        h.code_tx
            .send(tool_progress(
                "s1",
                "toolu_1",
                "Read",
                "tugrust/crates/tugcast/src/feeds/observer.rs",
            ))
            .unwrap();
        h.code_tx.send(turn_complete("s1")).unwrap();

        let post = next_post(&mut h.overview_rx).await;
        let kept: Vec<&str> = post.refs.iter().map(|r| r.target.as_str()).collect();
        assert_eq!(
            kept,
            vec!["9a9051001", "tugrust/crates/tugcast/src/feeds/observer.rs"],
            "what the window spelled is linkable; what it never spelled is dropped",
        );
        h.cancel.cancel();
    }

    /// [P04]: the window the model reads is digest lines — the same sentences
    /// the beat shows — rather than the wire's JSON. A wake input carrying a
    /// payload would mean the Observer and the strip had gone back to
    /// describing the same work two different ways.
    #[tokio::test]
    async fn a_wake_input_carries_digest_lines_rather_than_payloads() {
        let spawner = FakeSpawner::always(Ok(envelope("Read a file.")));
        let mut h = start(Arc::clone(&spawner) as Arc<dyn AgentWorkerSpawner>, 0).await;

        h.code_tx
            .send(assistant_text("s1", "Reading the allowlists first."))
            .unwrap();
        h.code_tx
            .send(tool_progress(
                "s1",
                "toolu_1",
                "Read",
                "tugrust/crates/tugcast/src/main.rs",
            ))
            .unwrap();
        h.code_tx.send(turn_complete("s1")).unwrap();
        let _ = next_post(&mut h.overview_rx).await;

        let shown = spawner.turns_seen().last().cloned().expect("a turn ran");
        // The LAST occurrence: the instructions name the heading too, and the
        // composed section is what this test is about.
        let activity = shown
            .rsplit("SESSION ACTIVITY SINCE THEN:")
            .next()
            .expect("the activity section")
            .to_string();
        assert!(
            activity.contains("Reading the allowlists first."),
            "the monologue is the line the strip shows: {activity}"
        );
        assert!(
            activity.contains("Read tugrust/crates/tugcast/src/main.rs…"),
            "a tool call is narrated, not spelled as JSON: {activity}"
        );
        assert!(
            !activity.contains("\"type\":\"tool_input_progress\""),
            "no payload survives into the window: {activity}"
        );
        h.cancel.cancel();
    }

    /// A session ending is its own wake, and the reason rides the post so the
    /// model can write a wrap-up rather than a progress note.
    #[tokio::test]
    async fn a_session_ending_wakes_with_its_own_reason() {
        let spawner = FakeSpawner::always(Ok(envelope("That session is done.")));
        let mut h = start(spawner, 0).await;

        h.code_tx
            .send(assistant_text(
                "s1",
                "The last thing it did before the end.",
            ))
            .unwrap();
        // Two wires, one loop: let the work land before the end arrives, or
        // the wake finds an empty window and correctly declines it.
        tokio::time::sleep(Duration::from_millis(100)).await;
        h.state_tx
            .send(Frame::new(
                FeedId::SESSION_STATE,
                serde_json::json!({
                    "tug_session_id": "s1", "state": "closed", "detail": null,
                })
                .to_string()
                .into_bytes(),
            ))
            .unwrap();

        let post = next_post(&mut h.overview_rx).await;
        assert_eq!(post.wake_reason.as_deref(), Some("session-end"));
        h.cancel.cancel();
    }

    /// The cadence knob is read per pass, so turning it in tugbank reaches the
    /// next arm without a restart.
    #[tokio::test]
    async fn the_cadence_knob_is_read_live() {
        let spawner = FakeSpawner::always(Ok(envelope("Progress.")));
        // Start effectively never-firing, then turn it down mid-run.
        let mut h = start(spawner, 86_400).await;

        h.code_tx
            .send(assistant_text("s1", "Doing some work on the router."))
            .unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        expect_no_post(&mut h.overview_rx).await;

        h.sitrep.store(1, Ordering::SeqCst);
        // A frame nudges the loop so the new deadline is computed.
        h.code_tx
            .send(assistant_text(
                "s1",
                "Doing more work after the first stretch.",
            ))
            .unwrap();
        let post = next_post(&mut h.overview_rx).await;
        assert_eq!(post.wake_reason.as_deref(), Some("sitrep-timer"));
        h.cancel.cancel();
    }

    #[test]
    fn only_a_terminal_session_state_is_an_end() {
        let frame =
            |state: &str| serde_json::json!({ "tug_session_id": "s1", "state": state }).to_string();
        assert_eq!(
            ended_session(frame("closed").as_bytes()),
            Some("s1".to_string())
        );
        assert_eq!(
            ended_session(frame("errored").as_bytes()),
            Some("s1".to_string()),
            "a session that died mid-work still wants its wrap-up",
        );
        assert_eq!(ended_session(frame("live").as_bytes()), None);
        assert_eq!(ended_session(frame("spawning").as_bytes()), None);
        assert_eq!(ended_session(b"not json"), None);
    }

    #[test]
    fn a_turns_cost_is_every_token_it_touched() {
        let payload = serde_json::json!({
            "tug_session_id": "s1",
            "type": "cost_update",
            "usage": {
                "input_tokens": 10,
                "output_tokens": 5,
                "cache_creation_input_tokens": 100,
                "cache_read_input_tokens": 1_000,
            },
        })
        .to_string();
        assert_eq!(
            turn_cost(payload.as_bytes()),
            Some(("s1".to_string(), 1_115))
        );
        // Any other frame is not a meter reading.
        assert_eq!(
            turn_cost(br#"{"tug_session_id":"s1","type":"turn_complete"}"#),
            None
        );
    }
}
