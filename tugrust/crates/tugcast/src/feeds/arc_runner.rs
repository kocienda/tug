//! The arc runner — the act half of the arc.
//!
//! [`super::arc::arc_action`] decides; this gathers the facts it decides
//! over, performs what it returns, and records the result in the arc log. The
//! split is `join_pilot`'s, for `join_pilot`'s reason: a decision made on one
//! scheduling hop and acted on the next is a time-of-check/time-of-use window,
//! so the act re-reads under a guard and the decision stays pure.
//!
//! # What wakes it
//!
//! A stage finishes by finishing a turn, and that is the moment its documents
//! have just changed. The supervisor already recognizes the transition — a
//! non-wake frame arriving with no replay bracket open flips `turn_active` off
//! — and this engine is a second consumer of that one edge, beside
//! `base_motion`'s. The changeset recompute is the floor, for a stage
//! that died without ever ending a turn, and a sweep at startup is the level
//! read an edge cannot give.
//!
//! # The in-flight guard is load-bearing
//!
//! A rotation's `arc-stage` line is written by the *bridge*, when claude
//! announces the new session id, not by the dispatch that asked for it — the
//! record names a claude session id and nobody knows one until claude says it.
//! So between `drive_stage` returning and that line landing, the newest
//! `arc-stage` line still names the session that just died, which is exactly
//! what "a stage that died" looks like. The guard is what tells those two
//! apart, and it is why the arc log is re-read immediately before every
//! rotation.
//!
//! # Every refusal is recorded
//!
//! A rotation tugcode refuses, a stage that exits red, a document that
//! vanished: each writes `arc-stop <stage> <reason>` and hands the card back on
//! the deck's own model. An arc that quietly stopped advancing would be the
//! silent early return [L31] exists to forbid.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{Mutex, mpsc, watch};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};
use tugarc_core::arc::{
    ArcRecord, ArcStage, ArcStopReason, append_arc_continue, append_arc_dispatch, append_arc_done,
    append_arc_note, append_arc_owner, append_arc_plan, append_arc_resume, append_arc_stop,
    read_arc, stage_model,
};
use tugarc_core::log::append_arc_log;
use tugcast_core::protocol::{FeedId, Frame, TugSessionId};
use tugtool_core::config::{ArcConfig, Config};
use tugtool_core::plan;

use super::agent_supervisor::{AgentSupervisor, SpawnState, TurnOpener};
use super::arc::{
    ArcAction, ArcFacts, PromptKind, PromptWhy, QUIET_TURN_HORIZON, Rotation, StepLedgerFacts,
    arc_action, step_range,
};
use super::arc_ownership;
use crate::wheel::{self, RotationRequest};

use crate::session_ledger::SessionLedger;

/// What the engine needs to run.
pub struct ArcContext {
    pub supervisor: Arc<AgentSupervisor>,
    pub session_ledger: Arc<SessionLedger>,
    /// The wheel's registries — an ending arms a hand-back here rather
    /// than sending one, because the stage may be mid-turn.
    pub wheel: Arc<wheel::WheelState>,
    pub cancel: CancellationToken,
    /// Is the instance that seated an arc still running?
    ///
    /// Production passes [`tugcore::instance::instance_tmux_live`], which asks
    /// the owner's own `tug-<token>` tmux server whether its session exists.
    /// It is a field rather than a direct call so the runner's own tests can
    /// drive both foreign verdicts without a real second instance — the same
    /// injection [`crate::feeds::arc_ownership::verdict`] takes, lifted one
    /// level to where the runner reaches for it.
    pub live_owner: fn(&str) -> bool,
    /// Where the settle's armed re-sweep lands ([P01]).
    ///
    /// An unsettled idle reading acts on nothing and arms one task that sleeps
    /// the settle and sends the arc's session id here; `run_arc_engine` reads
    /// it on a fourth `select!` arm and sweeps. Without it a reading that goes
    /// unspent would wait for whatever wakes the loop next — a changeset
    /// recompute, or the minute clock — which is the wrong latency for a
    /// stage sitting at a step boundary.
    ///
    /// `None` in the test harness, which drives `sweep` directly and ages the
    /// clock through `quiet_since` rather than sleeping. Arming nothing is
    /// then the correct behaviour rather than a stub.
    pub settle: Option<mpsc::Sender<String>>,
}

/// Per-arc memory the documents cannot hold.
#[derive(Debug, Default, Clone)]
pub(crate) struct ArcState {
    /// How many `arc-stage` lines the record held when a rotation was
    /// dispatched, while that rotation's own line has not landed yet.
    ///
    /// A count rather than a flag, because the thing being waited for is the
    /// bridge writing one more line — and the bridge is the only writer that
    /// can, since the line names a claude session id nobody knows until claude
    /// announces it. Cleared by the record growing past the count, never by
    /// the dispatch returning: `drive_stage` returning `Sent` means the frames
    /// reached stdin, not that a session started.
    in_flight_at: Option<usize>,
    /// How many ledger rows read `done` at the previous tick — the only way to
    /// know a step *just* went done, which is what makes a rotation a step
    /// boundary rather than a mid-step interruption.
    last_done_count: Option<usize>,
    /// A compaction was sent on the seated session and no idle reading since
    /// has fallen to or below the compaction threshold.
    ///
    /// It is what makes a rotation the *second* answer to an oversized context:
    /// the first crossing compacts, and only a context a compaction failed to
    /// bring down costs a fresh session. Cleared by a reading at or below the
    /// threshold, and by a compact turn that ended in an API error or a user
    /// cancel — a compaction that did not happen is never remembered as one,
    /// and the context only grows, so a latched flag would compact exactly
    /// once, having compacted not at all.
    compacted_since_below: bool,
    /// A prompt the runner sent whose turn has not been read back yet.
    pending: Option<PendingPrompt>,
    /// How many turns the seated stage has ended in a row without closing a
    /// step. Cleared by a close and by a rotation; a compact turn neither
    /// clears it nor adds to it.
    quiet_turns: u32,
    /// The seated session's **asked** turn count as the previous tick read it
    /// — what makes "a turn ended since we last looked" answerable at all, for
    /// the horizon, which counts answers. `None` until the first tick, which
    /// seeds it without counting: a stage tugcast inherited across a restart
    /// has ended turns nobody here watched, and they are not this horizon's to
    /// hold against it.
    prompt_turns_seen: Option<u32>,
    /// The seated session's turn count of *every* opener, as the previous tick
    /// read it — the clock's comparison point ([P02]).
    ///
    /// The horizon and the clock read different counts because they are asking
    /// different questions. A wake-opened turn ending is not the stage
    /// answering, so the horizon must not count it; but it is unambiguously
    /// the arc *moving*, so the clock must. The incident is what happens when
    /// one count serves both: six wakes read as six unanswered asks.
    all_turns_seen: Option<u32>,
    /// When this arc last moved: a turn of the seated stage ending, a step
    /// closing, the seated session's context growing, or the runner itself
    /// acting. `None` until the first tick, which seeds it — the clock
    /// measures silence it has actually watched, never silence it merely
    /// inherited.
    ///
    /// The one wall-clock fact in the machine, and it answers **a turn that
    /// never ends** ([P06]). Everything else the arc decides is decided on an
    /// edge, and a hung turn is the shape that produces none: `session_idle`
    /// never becomes true, so every arm below the clock is unreachable. A
    /// stage that ends one turn and then stops working is *not* this field's
    /// to answer any more — that reading is idle, it has an edge, and the
    /// quiet-turn horizon answers it in one turn rather than in a deadline.
    /// The stamp is kept current on every tick regardless, because the next
    /// mid-turn tick is what reads it.
    last_motion_at: Option<Instant>,
    /// The seated session's context size as the previous tick read it.
    ///
    /// **The clock's within-turn signal, and the reason its deadline can be
    /// short enough to be useful.** A turn that is genuinely working reports
    /// usage as it goes, so the number climbs; a turn that is hung reports
    /// nothing and it stands still. Without this the only motion the clock
    /// could see is a turn *ending*, and the deadline would have to outlast
    /// the longest legitimate turn — a stage running a full test sweep — which
    /// is long enough that the wedge would sit for most of a working day
    /// before anyone was told.
    ///
    /// A number that does not move is not proof of a hang, and it does not
    /// have to be: it only has to stop the clock being *reset* by a turn that
    /// is producing nothing.
    tokens_seen: Option<u64>,
    /// What the arc looked like at the moment it stopped, and the only field
    /// a stop leaves behind.
    ///
    /// Everything else in this struct is memory of a *running* arc, and after
    /// a stop every one of it is wrong: the clock would go on measuring a
    /// silence the stop already accounted for, and the quiet count would go on
    /// holding turns against a stage that is no longer being asked for any.
    /// The incident's morning was exactly that — an overnight-stale
    /// `last_motion_at` re-stopping the arc within 160 ms of each Resume
    /// press. So `finish` evicts the entry and puts back only this.
    ///
    /// `Some` means "this arc stopped and nothing has run since". Step 7 reads
    /// it to tell life on a stopped stage from the stop's own echo.
    stop_marks: Option<StopMarks>,
    /// When the reading now being settled was first taken, or `None` when the
    /// last reading was not idle ([P01]).
    quiet_since: Option<Instant>,
    /// The facts that reading was made of. The settle holds only if *these*
    /// have not moved — a wake, a turn, or a job opening inside the window is
    /// a different session, and the window starts again over it.
    quiet_marks: Option<QuietMarks>,
}

/// The facts an idle reading is made of, compared against themselves one
/// settle later ([P01]).
///
/// Idleness is a claim about an instant, and the runner spends it on something
/// irreversible. A turn ending and the wake that answers it are ~120 ms apart,
/// and the session is genuinely idle in between — the arc stopped on the night
/// of 2026-09-03 was stopped inside one of those gaps, six wakes into work that
/// was going fine. So the reading is taken twice, and these are what "the same
/// reading" means: every count a turn or a job could move.
///
/// `turns_ended` as well as its two halves, because a fourth opener the wire
/// grows later would move the total and neither half, and the settle should
/// notice it without waiting for anyone to teach it the new word.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct QuietMarks {
    turns_ended: u32,
    prompt_turns_ended: u32,
    wake_turns_ended: u32,
    open_jobs: usize,
    turn_active: bool,
}

impl QuietMarks {
    fn of(session: &SessionSnapshot) -> Self {
        Self {
            turns_ended: session.turns_ended,
            prompt_turns_ended: session.prompt_turns_ended,
            wake_turns_ended: session.wake_turns_ended,
            open_jobs: session.open_jobs,
            turn_active: session.turn_active,
        }
    }
}

/// The baseline a stop leaves for whatever notices life after it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct StopMarks {
    /// The seated session's wake-opened turn count at the stop — the baseline
    /// a later wake is legible against, so life on a stopped stage can be told
    /// from the stop's own reading seen a second time.
    pub(crate) wake_turns_ended: u32,
    /// How many ledger rows read `done` at the stop — so a step closing
    /// afterwards is legible as motion rather than as the stop's own reading
    /// seen a second time.
    pub(crate) done_count: usize,
}

/// The runner's memory, keyed by [`arc_key_for`].
///
/// Held on the wheel rather than as a local of `run_arc_engine`, because the
/// runner is not the only thing that stops an arc: a user stop performed from
/// a CONTROL frame has to evict this memory exactly as the wheel's own stops
/// do ([P11]), and it reaches the wheel, not the engine's stack.
pub(crate) type ArcMemory = Arc<Mutex<HashMap<String, ArcState>>>;

/// A prompt already delivered, remembered until the turn it opened ends.
#[derive(Debug, Clone)]
struct PendingPrompt {
    kind: PromptKind,
    /// The session's **asked** turn count at the moment the prompt went out.
    /// The turn this prompt opened has ended once the count has moved past it
    /// — and only an asked turn can be that one, which is why the comparison
    /// is against the prompt count rather than every opener's ([P02]).
    turns_ended_at: u32,
}

/// One arc the sweep found: a bound arc, and the card it runs on.
struct BoundArc {
    project: PathBuf,
    name: String,
    session: TugSessionId,
}

/// Run the engine until `cancel` fires.
///
/// `tick_rx` carries a tug session id each time a turn closes; `recompute_rx`
/// is a clone of the aggregate changeset watch, the slower floor.
pub async fn run_arc_engine(
    ctx: ArcContext,
    mut tick_rx: mpsc::Receiver<String>,
    mut recompute_rx: watch::Receiver<Frame>,
) {
    // The wheel's, so a stop performed outside this loop can evict from it.
    let state: ArcMemory = Arc::clone(&ctx.wheel.arc_memory);

    // The settle's own return path ([P01]). An idle reading the runner
    // declines to spend arms one task that sleeps and sends the arc's session
    // here; without it the re-read would wait on whatever wakes the loop next,
    // which for a stage sitting still is the minute clock.
    let mut ctx = ctx;
    let (settle_tx, mut settle_rx) = mpsc::channel::<String>(64);
    ctx.settle = Some(settle_tx);

    // The level read the edge cannot give: an arc mid-stage when tugcast
    // restarted has no turn left to end, and would otherwise wait forever.
    sweep(&ctx, &state).await;

    // The clock's own wake. Every other thing that wakes this loop is an edge
    // the work produced — a turn ending, a changeset recomputing — and the
    // whole point of the clock is to be consulted when the work has produced
    // nothing at all. `MissedTickBehavior::Delay` because a sweep that ran
    // long should push the next wake out rather than fire a burst of catch-up
    // sweeps that would each re-read every arc's documents.
    let mut clock = tokio::time::interval(CLOCK_POLL);
    clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    clock.tick().await; // the first tick of an interval is immediate

    loop {
        tokio::select! {
            _ = ctx.cancel.cancelled() => {
                debug!("arc engine shutting down");
                return;
            }
            _ = clock.tick() => {}
            tick = tick_rx.recv() => {
                if tick.is_none() {
                    return;
                }
            }
            changed = recompute_rx.changed() => {
                if changed.is_err() {
                    return;
                }
            }
            // A settle elapsed. It carries the arc's session, but the sweep
            // re-reads every arc anyway — the id is what the arming task had
            // to hand, not a filter.
            Some(_) = settle_rx.recv() => {}
        }
        sweep(&ctx, &state).await;
    }
}

/// Evaluate every arc a live session is bound to.
async fn sweep(ctx: &ArcContext, state: &Arc<Mutex<HashMap<String, ArcState>>>) {
    for arc in bound_arcs(ctx).await {
        evaluate(ctx, state, &arc).await;
    }
}

/// Every arc with a live card behind it.
///
/// Bound-ness is the arc binding and nothing else: the arc record
/// names no session, so "whose card is this arc on" is answered by the ledger
/// the Bind control already writes. `bound_session_by_arc` filters to live
/// rows, so a card that closed takes its arc out of the sweep.
///
/// **The session it hands back is the card's, not the row's**, and that
/// distinction is the whole of `at0505`'s finding. The ledger row a binding
/// sits on is a *segment* — after a rotation, the fresh one `seat_line_binding`
/// moved the arc onto — while the supervisor's map is keyed by the **tug
/// session id**, which is the card's address and never moves. Handing the
/// segment on meant `session_snapshot` looked up an id no entry wears, answered
/// `None`, and the arc ran factless from its first rotation onward: no
/// predicate, no decision, no clock. That is the shape W6 watched for ninety
/// seconds and read as a consequence of the kill; the kill had nothing to do
/// with it.
async fn bound_arcs(ctx: &ArcContext) -> Vec<BoundArc> {
    let Ok(by_arc) = ctx.session_ledger.bound_session_by_arc() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for session in by_arc.values() {
        let Ok(Some(row)) = ctx.session_ledger.get(session) else {
            continue;
        };
        let Some(name) = row.arc_name.clone() else {
            continue;
        };
        out.push(BoundArc {
            project: PathBuf::from(&row.project_dir),
            name,
            session: card_session_for_segment(ctx, session).await,
        });
    }
    out
}

/// The card's own session id for a segment the ledger says is bound.
///
/// The supervisor's map is keyed by the **tug session id** — the card's
/// address, minted at spawn and never moved, because every frame the card sends
/// is stamped with it and its whole services bag is built around it. A rotation
/// mints a *segment*, records a row under claude's own id, and moves the arc
/// binding onto it; from then on the ledger's answer to "which session is on
/// this arc" is an id no supervisor entry wears.
///
/// So the walk is by `claude_session_id`, which is the entry's own record of
/// which segment it is currently running — the direct key first, since before
/// any rotation the two are one string and every existing test lives there.
/// Falling back to the segment itself is what keeps a card tugcast has no entry
/// for (one rebound from tugbank, one already closed) reaching
/// [`session_snapshot`]'s own `None` rather than being silently dropped from
/// the sweep.
///
/// `try_lock` on the entries, deliberately: this holds the map lock, and an
/// entry another task is mid-write on would otherwise be a lock-order
/// inversion. A busy entry is skipped for this tick and found on the next —
/// the sweep runs at least once a minute, and a wrong answer here costs an arc
/// its whole run.
async fn card_session_for_segment(ctx: &ArcContext, segment: &str) -> TugSessionId {
    let direct = TugSessionId::new(segment.to_string());
    let map = ctx.supervisor.ledger.lock().await;
    if map.contains_key(&direct) {
        return direct;
    }
    for (key, entry) in map.iter() {
        let Ok(entry) = entry.try_lock() else {
            continue;
        };
        if entry.claude_session_id.as_deref() == Some(segment) {
            return key.clone();
        }
    }
    direct
}

/// A key that separates two arcs of the same name in different projects.
fn arc_key(arc: &BoundArc) -> String {
    arc_key_for(&arc.project, &arc.name)
}

/// The runner's key for one arc: `"{project}\0{name}"`. One spelling, so a
/// stop performed outside the runner evicts the entry the runner wrote rather
/// than a lookalike.
pub(crate) fn arc_key_for(project: &Path, name: &str) -> String {
    format!("{}\u{0}{}", project.display(), name)
}

/// Evict a stopped arc's memory and put back only the stop's own marks.
///
/// Every other field described a stage that is no longer being asked for
/// turns, and each would go on being read: the clock against a
/// `last_motion_at` that only gets staler, the horizon against a quiet count
/// that can only grow, a `pending` prompt against a turn that will never end.
/// The incident's morning was that memory outliving the stop it recorded
/// ([B06]).
///
/// One body for both stoppers ([P11]): the wheel's own stop in `finish`,
/// which has a reading to seed the marks from, and the user stop performed
/// from a CONTROL frame, which has no reading and seeds `None` where it could
/// not read one — the "a stop this process did not watch" case `evaluate`
/// already declines to invent a baseline for.
pub(crate) async fn evict_for_stop(state: &ArcMemory, key: &str, marks: Option<StopMarks>) {
    let mut map = state.lock().await;
    map.remove(key);
    map.insert(
        key.to_string(),
        ArcState {
            stop_marks: marks,
            ..Default::default()
        },
    );
}

/// How many ledger rows read closed for `name`'s arc right now, read from the
/// ledger the implement stage walks. `None` when the arc has no ledger or it
/// does not parse — the user stop seeds no marks rather than a wrong count.
pub(crate) fn done_count_for(project: &Path, name: &str) -> Option<usize> {
    let ledger_abs = tugarc_core::ledger_file(project, name)?;
    let source = std::fs::read_to_string(ledger_abs).ok()?;
    plan::parse(&source).ok().map(|doc| count_closed(&doc))
}

/// Closed, not finished: a withdrawn step ended, so it counts here and a
/// withdrawal is a rotation boundary exactly as a completion is.
fn count_closed(doc: &plan::PlanDoc) -> usize {
    doc.ledger_rows
        .iter()
        .filter(|row| row.status == "done" || row.status == "withdrawn")
        .count()
}

/// How often the engine wakes with nothing having happened, so the clock can
/// be consulted.
///
/// A minute, and the granularity of the stall deadline is therefore also a
/// minute — which is the right coarseness for a deadline whose default is
/// half an hour. A shorter poll would re-read every bound arc's documents and
/// run its scoped git read for no gain; a longer one would make a lowered
/// `arc_stall_secs` untestable.
const CLOCK_POLL: Duration = Duration::from_secs(60);

/// How long a card may hold no tugcode child before the arc reads it as gone.
///
/// Not a clock in the [`clock_ran_out`] sense and deliberately far shorter than
/// one. The stall deadline measures *silence* — a session that is alive and not
/// working — and half an hour is the right order for that, because a stage
/// running a test sweep is legitimately silent. This measures **absence**: no
/// process at all, which no working stage ever has. A crash-retry closes the
/// gap in about a second (`DEFAULT_RETRY_DELAY`, plus a spawn), so thirty
/// seconds is an order of magnitude of headroom over the only legitimate case
/// and still turns the wedge `at0505` found from *forever* into *late*.
pub(crate) const CHILD_GONE_GRACE: Duration = Duration::from_secs(30);

/// Whether the arc's clock has run out.
///
/// Pure, and taking its `now`, so the hang it exists to catch can be
/// synthesized in a test rather than waited out. `None` for `last_motion_at`
/// is *not* stalled: it means this arc has not been observed yet, and the tick
/// that observes it seeds the stamp. `None` for `timeout` is the clock turned
/// off — `[tugtool.arc].arc_stall_secs = 0`.
fn clock_ran_out(last_motion_at: Option<Instant>, now: Instant, timeout: Option<Duration>) -> bool {
    let (Some(last), Some(timeout)) = (last_motion_at, timeout) else {
        return false;
    };
    now.saturating_duration_since(last) >= timeout
}

async fn evaluate(ctx: &ArcContext, state: &Arc<Mutex<HashMap<String, ArcState>>>, arc: &BoundArc) {
    let key = arc_key(arc);
    let Some(session) = session_snapshot(ctx, &arc.session).await else {
        // No snapshot is no facts, and no facts used to be no clock: the arc
        // sat, and every tick returned here having decided nothing and having
        // recorded nothing about how long that had been true. W6's stage-kill
        // probe watched exactly this for ninety seconds. The clock is the
        // floor under it — the same principle as the busy latch's, that a
        // class the machine cannot classify must degrade to *late* rather than
        // to *forever*.
        watch_the_clock_unseated(ctx, state, arc, &key).await;
        return;
    };
    // Read the memory before the blocking read, because the blocking read is
    // what carries it to the predicate. The in-flight guard below runs after
    // that read and so cannot be what gates this — the *writes* are what the
    // guard protects, and they happen there.
    let memory = {
        let map = state.lock().await;
        match map.get(&key) {
            Some(entry) => TickMemory {
                last_done_count: entry.last_done_count,
                compacted_since_below: entry.compacted_since_below,
                compact_turn_just_ended: entry.pending.as_ref().is_some_and(|pending| {
                    pending.kind == PromptKind::Compact
                        && session.prompt_turns_ended > pending.turns_ended_at
                }),
                // The re-ask's own read of the same memory, and the inverse
                // comparison: the compaction is interesting once its turn has
                // ended, the re-ask once it has *not*. `matches!` rather than
                // `==` because the variant carries the steps it named.
                reask_pending: entry.pending.as_ref().is_some_and(|pending| {
                    matches!(pending.kind, PromptKind::StillOpen { .. })
                        && session.prompt_turns_ended <= pending.turns_ended_at
                }),
            },
            None => TickMemory::default(),
        }
    };
    // A compaction the session never performed — an API error, a user's cancel
    // — is retired here as well as written away below, because the predicate
    // reads this value: left standing it would cost a rotation for a turn
    // nobody took.
    let compaction_never_happened =
        memory.compact_turn_just_ended && (session.api_error || session.turn_cancelled);
    let memory = TickMemory {
        compacted_since_below: memory.compacted_since_below && !compaction_never_happened,
        ..memory
    };

    let project = arc.project.clone();
    let name = arc.name.clone();
    // The read is blocking and takes the snapshot by value, so it takes a
    // clone: the settle's marks, the reversal's comparison and the tick line's
    // `opener` all read the same facts on this side of it, and a snapshot that
    // ended at the `spawn_blocking` would leave each of them threading a field
    // of its own onto `ArcReading`.
    let snapshot = session.clone();
    let Ok(Some(reading)) =
        tokio::task::spawn_blocking(move || read(&project, &name, &snapshot, memory)).await
    else {
        return;
    };
    let mut reading = reading;

    // The same ownership gate as `watch_the_clock_unseated`'s, and for the same
    // reason — placed here rather than at this function's top, which has no
    // record to read: the record arrives from the blocking read just above, as
    // `reading.record`. It goes before the `state.lock()` below, which is where
    // the turn counts, `quiet_turns` and `last_motion_at` are updated: stand down
    // before touching the state map, never after.
    //
    // In practice this arm should be unreachable. `session_snapshot` returning
    // `Some` already implies this process's supervisor holds the session, so a
    // foreign-owned arc reaches the unseated path instead. It is gated anyway,
    // because a structural guarantee is worth more than an argument about which
    // path a foreign runner can reach.
    let verdict = arc_ownership::verdict(
        reading.record.owner.as_deref(),
        tugcore::instance::instance_id().as_deref(),
        ctx.live_owner,
    );
    if verdict.stands_down() {
        info!(
            target: "dev::session-lifecycle",
            event = "arc.foreign",
            arc = %arc.name,
            session = %arc.session,
            owner = reading.record.owner.as_deref().unwrap_or("-"),
            stage = reading
                .record
                .current_stage()
                .map(|stage| stage.as_str())
                .unwrap_or("-"),
            verdict = verdict.as_str(),
            seated = true,
        );
        return;
    }

    // **A stopped record is read for one thing only: life on the stage that
    // was stopped** ([P05]).
    //
    // It is clocked by nothing and counts nothing — every field the block
    // below would update describes a stage still being asked for turns, and
    // `last_motion_at` in particular would go on ageing over a record whose
    // silence the stop already accounted for. That is the wedge the incident's
    // morning fell into: the clock ran all night over a stopped arc and
    // outranked both Resume presses.
    //
    // But a stop for silence is a *claim*, and the session it was made about
    // is the one thing entitled to contradict it. Step 4 of the incident's arc
    // closed ninety-six seconds after the stop that said the stage had gone
    // idle, on the stage's own session, and nothing read it. So this path
    // computes what moved since the stop, hands it to the predicate, and acts
    // on the one answer the predicate may give here.
    if reading.record.stopped.is_some() {
        let stop_marks = {
            let map = state.lock().await;
            map.get(&key).and_then(|entry| entry.stop_marks)
        };
        // No marks is a stop this process did not watch — a tugcast restart,
        // or an arc stopped by the verb rather than by the runner. There is no
        // baseline to compare against, so nothing can be said to have moved,
        // and inventing one would reverse on the stop's own reading.
        reading.facts.stopped_stage_moved = stop_marks.is_some_and(|marks| {
            session.wake_turns_ended > marks.wake_turns_ended
                || (session.turn_active && session.turn_opener == Some(TurnOpener::Wake))
                || reading.done_count > marks.done_count
        });
        let action = arc_action(&reading.record, &reading.facts);
        info!(
            target: "dev::session-lifecycle",
            event = "arc.tick",
            arc = %arc.name,
            stage = reading
                .record
                .current_stage()
                .map(|stage| stage.as_str())
                .unwrap_or("-"),
            stopped = true,
            moved = reading.facts.stopped_stage_moved,
            wake_turns = session.wake_turns_ended,
            done_count = reading.done_count,
            action = %describe_action(action.as_ref()),
        );
        if let Some(ArcAction::Reverse { stage }) = action {
            reverse(ctx, state, arc, &key, &reading, stage).await;
        }
        return;
    }

    let quiet_turns;
    let stalled;
    {
        let mut map = state.lock().await;
        let entry = map.entry(key.clone()).or_default();
        // Count the turn that just ended, before anything else reads the
        // memory. A tick fires on a changeset recompute as well as on a turn
        // end, so the count is over *turns* — the unit the stage acts in —
        // rather than over ticks, which fire for reasons the stage had no
        // part in.
        let previously_seen = entry.prompt_turns_seen.replace(reading.turns_ended);
        let a_turn_ended = previously_seen.is_some_and(|seen| reading.turns_ended > seen);
        // The clock's own comparison, over turns of every opener: a wake-opened
        // turn ending is not an answer, but it is the arc moving ([P02]).
        let previously_seen_all = entry.all_turns_seen.replace(reading.all_turns_ended);
        let any_turn_ended = previously_seen_all.is_some_and(|seen| reading.all_turns_ended > seen);
        if reading.facts.ledger.step_just_done {
            entry.quiet_turns = 0;
        } else if a_turn_ended && !reading.facts.compact_turn_just_ended {
            entry.quiet_turns = entry.quiet_turns.saturating_add(1);
        }
        quiet_turns = entry.quiet_turns;
        // Motion, and the clock read against it. A turn ending, a step
        // closing, or the seated context growing is the arc moving under its
        // own power; the runner acting is stamped where the act happens,
        // below. The seed on the first tick is what keeps the clock honest
        // across a restart: silence tugcast did not watch is not silence it
        // may hold against the stage.
        let context_grew = {
            let previous = entry.tokens_seen;
            entry.tokens_seen = reading.facts.context_tokens.or(previous);
            match (previous, reading.facts.context_tokens) {
                (Some(before), Some(now)) => now != before,
                // Nothing to compare against yet — the seed below covers it.
                _ => false,
            }
        };
        if any_turn_ended
            || reading.facts.ledger.step_just_done
            || context_grew
            || entry.last_motion_at.is_none()
        {
            entry.last_motion_at = Some(Instant::now());
        }
        // **The clock is read against a turn that never ends, and nothing
        // else** ([P06]). An idle session has an edge to be judged on, and the
        // horizon judges it in one turn; letting the clock answer it too meant
        // a stage that ended one quiet turn and then genuinely went quiet was
        // answered thirty minutes later by the wrong sentence. `false` on an
        // idle reading rather than an unread clock: the stamp above is still
        // kept current, because the very next mid-turn tick reads it.
        stalled = !reading.facts.session_idle
            && clock_ran_out(
                entry.last_motion_at,
                Instant::now(),
                reading.config.stall_timeout(),
            );
        // A dispatched rotation whose `arc-stage` line has not landed yet: the
        // newest line still names the session that just ended, which is
        // indistinguishable from a stage that died. Wait for the line.
        if let Some(dispatched_at) = entry.in_flight_at {
            // The wait is not unbounded. A dispatch whose session never
            // announces leaves this latched, and every future tick returned
            // early — the arc's second silent wedge, self-healing only if the
            // entry happened to read `Errored` later. The quiet-turn horizon
            // retires it: the card is ending turns and the line the latch is
            // waiting for is not coming, so let the tick through and let the
            // predicate say what the record actually shows.
            //
            // The clock retires it too, and on the shape the horizon cannot
            // reach: a dispatch whose card then goes entirely silent ends no
            // turns, so the count never advances and the latch would hold
            // forever.
            if reading.record.stages.len() <= dispatched_at
                && entry.quiet_turns < QUIET_TURN_HORIZON
                && !stalled
            {
                return;
            }
            entry.in_flight_at = None;
        }
        entry.last_done_count = retain_done_count(
            entry.last_done_count,
            reading.done_count,
            reading.facts.session_idle,
        );
        // The re-ask is retired on the tick that reads the count past it — the
        // same rule, on the turn that answered it. Left standing it would
        // suppress the next quiet turn's re-ask as well.
        //
        // This one *is* retired above the gate, unlike the compaction's record
        // below it, and the difference is what each is read against. The
        // re-ask is compared against a turn count that only moves forward, so
        // a withheld tick leaves the comparison saying exactly what it said
        // before; the compaction's record is *derived from* — spending it
        // erases the fact a withheld decision was made from.
        if entry.pending.as_ref().is_some_and(|pending| {
            matches!(pending.kind, PromptKind::StillOpen { .. })
                && session.prompt_turns_ended > pending.turns_ended_at
        }) {
            entry.pending = None;
        }
        // A compaction is remembered only while it is still the answer that
        // was tried. A reading back at or below the threshold retires it, and
        // so does a compact turn that never happened — an API error or a user
        // cancel — because the next boundary should compact again rather than
        // fall straight through to the rotation threshold.
        let came_down = reading.facts.session_idle
            && reading
                .facts
                .context_tokens
                .is_some_and(|tokens| tokens <= reading.facts.compact_tokens);
        if came_down || compaction_never_happened {
            entry.compacted_since_below = false;
        }
    }
    reading.facts.quiet_turns = quiet_turns;
    reading.facts.stalled = stalled;

    let mut action = arc_action(&reading.record, &reading.facts);

    // **The settle** ([P01]). An idle reading is a claim about an instant, and
    // everything below spends one on something irreversible — a rotation, a
    // prompt, a stop. A turn ending and the wake that answers it are ~120 ms
    // apart and the session is genuinely idle in between; the arc stopped on
    // the night of 2026-09-03 was stopped inside one of those gaps, six wakes
    // into work that was going fine. So the same reading has to still be true
    // a settle later, with no turn, wake or job in between, before it is worth
    // anything.
    //
    // Above the act and below the bookkeeping, deliberately: `quiet_turns` and
    // `last_motion_at` are counts of what happened, and what happened does not
    // depend on whether the runner chose to act on it.
    //
    // What the predicate returned is read off *before* the gate, because the
    // gate withholds by clearing the action: after it, an `action=none` line
    // cannot say whether nothing was decided or something was held. That
    // ambiguity is what made the 2026-09-04 wedge take a cross-log
    // reconstruction to place — the decision had to be inferred from
    // `quiet_for="0"` — so the line carries both words now.
    let decided = describe_action(action.as_ref());
    // …and whether it returned anything at all, which is what the word alone
    // cannot say once the gate has run. `action=none` after the gate has two
    // meanings — a decision held, and no decision reached — and the record
    // below has to tell them apart.
    let decided_something = action.is_some();
    let settled = settle_gate(
        ctx,
        state,
        &key,
        arc,
        &session,
        &reading,
        memory,
        &mut action,
    )
    .await;

    // **A pending prompt survives exactly one thing: the gate withholding the
    // decision it was made from.** It is read back once — the tick that
    // derived `compact_turn_just_ended` from it is the tick that consumes it —
    // but "the tick that derived it" and "the tick that judged it" were the
    // same tick only until the settle gate landed between them. A withheld
    // reading is also an unspent one: consuming this above the gate left the
    // settle's own re-sweep with nothing to re-derive, so a compaction whose
    // turn ended inside a window wedged its arc silently and forever
    // (2026-09-04). The gate says the same thing about `last_done_count` by
    // restoring it; this says it by waiting.
    //
    // Withheld, and **nothing else**. An idle tick that reached no decision at
    // all has judged the compaction's end just as surely — the judgement being
    // that the ledger names no next step to prompt on — and there is no
    // re-sweep coming to re-derive anything, because the gate arms one only
    // over an action. Kept for that case the record latches, and a standing
    // `compact_turn_just_ended` suppresses the quiet-turn count on every tick
    // after it, so the horizon that exists to end this exact silence never
    // reaches its own threshold: the same wedge under a narrower door.
    //
    // A reading that is not idle is not a judgement either way, and leaves it
    // standing: a wake turn landing inside the settle must not spend the
    // compaction's end on nobody's behalf.
    //
    // Above the dispatch, because a delivered prompt writes a record of its
    // own and this would erase it.
    let judged_nothing = reading.facts.session_idle && !decided_something;
    if memory.compact_turn_just_ended && (settled.settled || judged_nothing) {
        let mut map = state.lock().await;
        if let Some(entry) = map.get_mut(&key) {
            entry.pending = None;
        }
    }

    // Every tick says what it read and what it decided, including the ticks
    // that decided nothing. An arc that advances silently is an arc whose
    // divergence from the predicate can only be found by guessing.
    info!(
        target: "dev::session-lifecycle",
        event = "arc.tick",
        arc = %arc.name,
        stage = reading
            .record
            .current_stage()
            .map(|stage| stage.as_str())
            .unwrap_or("-"),
        tokens = reading
            .facts
            .context_tokens
            .map(|t| t.to_string())
            .unwrap_or_else(|| "-".to_string()),
        done_count = reading.done_count,
        last_done_count = ?memory.last_done_count,
        idle = reading.facts.session_idle,
        turn_active = session.turn_active,
        open_jobs = session.open_jobs,
        opener = describe_opener(session.turn_opener),
        step_just_done = reading.facts.ledger.step_just_done,
        quiet_turns = reading.facts.quiet_turns,
        prompt_turns = session.prompt_turns_ended,
        wake_turns = session.wake_turns_ended,
        settled = settled.settled,
        quiet_for = settled
            .quiet_for
            .map(|d| d.as_millis().to_string())
            .unwrap_or_else(|| "-".to_string()),
        stalled = reading.facts.stalled,
        compacted_since_below = reading.facts.compacted_since_below,
        compact_turn_just_ended = reading.facts.compact_turn_just_ended,
        decided = %decided,
        action = %describe_action(action.as_ref()),
    );

    let Some(action) = action else { return };

    match action {
        ArcAction::Rotate(rotation) => rotate(ctx, state, arc, &key, &reading, &rotation).await,
        ArcAction::Prompt { kind, why } => {
            deliver_prompt(ctx, state, arc, &key, &reading, &kind, &why).await
        }
        ArcAction::Done => finish(ctx, state, arc, &key, &reading, None).await,
        ArcAction::Stop { stage, reason } => {
            finish(ctx, state, arc, &key, &reading, Some((stage, reason))).await
        }
        ArcAction::Continue { stage, steps } => {
            continue_stage(ctx, state, arc, &key, &reading, stage, steps).await
        }
        // Only reachable on a stopped record, which returned above.
        ArcAction::Reverse { .. } => {}
    }
}

/// The clock over an arc whose session hands back no snapshot at all.
///
/// [`session_snapshot`] answers `None` for an entry that is not there and for
/// one parked `Idle` with nothing of this process's own to say about it — a
/// card rebound from tugbank that no deck has spawned yet. Reading that as a
/// death would stop every in-flight arc on every relaunch, so it is a **wait**,
/// and the wait is right. What was wrong is that it was unbounded: the arc
/// produced no facts, so the predicate never ran, so nothing clocked it, so
/// the wait had no end and no receipt. A card that never comes back leaves an
/// arc running on disk forever with nobody told.
///
/// So the wait is timed by the same clock every other silence is. `None` is
/// not motion and is never stamped as any — the first tick seeds the stamp
/// (silence tugcast did not watch is not silence it may hold against a stage,
/// exactly as in [`evaluate`]) and every tick after it only reads. When the
/// deadline passes the arc stops as [`ArcStopReason::Stalled`], through the
/// same receipt-bearing path as every other stop, with the hand-back **armed**
/// rather than sent: there is no live session to hand a model back to, and the
/// card's next spawn is where the arm lands.
///
/// An arc already stopped or done is left alone — the record is terminal and a
/// second `arc-stop` line would be the machine talking about a run that ended.
async fn watch_the_clock_unseated(
    ctx: &ArcContext,
    state: &Arc<Mutex<HashMap<String, ArcState>>>,
    arc: &BoundArc,
    key: &str,
) {
    let project = arc.project.clone();
    let name = arc.name.clone();
    let Ok(Some((record, config))) = tokio::task::spawn_blocking(move || {
        let record = read_arc(&project, &name)?;
        let config = Config::load_from_project(&project)
            .unwrap_or_default()
            .tugtool
            .arc
            .clone();
        Some((record, config))
    })
    .await
    else {
        return;
    };
    // `stopping` beside the two: this path never consults `arc_action`, so
    // its stand-down arm does not cover it — it reads the record itself and
    // calls `stop_arc_for_session` directly. Without this a stopping arc whose
    // card has no snapshot can be stopped a *second* time, as `Stalled`, while
    // the protocol is still in flight, and the `arc-stop` that stop writes
    // clears the mark and races the protocol's own ([F09]).
    //
    // `resume` beside them ([B09]): a resume on a card this process never saw
    // live is waiting for the deck to spawn one, and that wait is the deck's
    // own act rather than silence. Clocking it stops the arc as `stalled` on
    // the tick after the press — the resume the user asked for answered by a
    // second stop.
    if record.done
        || record.stopped.is_some()
        || record.stopping.is_some()
        || record.resume.is_some()
    {
        return;
    }
    // **Whose arc is this?** The arc log is shared across every instance over
    // one checkout, so this runner reads arcs it did not seat — and cannot get
    // a session snapshot for a seat living in another tugcast's process, which
    // is exactly why this path was reached. Before the owner marker that
    // blindness had one reading, *gone silent*, and a debug instance spent it
    // on a healthy arc twenty-seven minutes into an audit.
    //
    // The stand-down returns **before** the state map is touched below.
    // Seeding `last_motion_at` here would start a clock this runner must never
    // read, and would backdate the deadline if ownership later changed hands.
    // Leaving it unseeded is what makes the stand-down total.
    let verdict = arc_ownership::verdict(
        record.owner.as_deref(),
        tugcore::instance::instance_id().as_deref(),
        ctx.live_owner,
    );
    if verdict.stands_down() {
        info!(
            target: "dev::session-lifecycle",
            event = "arc.foreign",
            arc = %arc.name,
            session = %arc.session,
            owner = record.owner.as_deref().unwrap_or("-"),
            stage = record
                .current_stage()
                .map(|stage| stage.as_str())
                .unwrap_or("-"),
            verdict = verdict.as_str(),
        );
        return;
    }
    let stalled = {
        let mut map = state.lock().await;
        let entry = map.entry(key.to_owned()).or_default();
        if entry.last_motion_at.is_none() {
            entry.last_motion_at = Some(Instant::now());
        }
        clock_ran_out(entry.last_motion_at, Instant::now(), config.stall_timeout())
    };
    // Said on every tick, decision or not, for the same reason `arc.tick` is:
    // an arc waiting silently is an arc whose wait can only be found by
    // guessing. This is the line W6 went looking for and did not find.
    info!(
        target: "dev::session-lifecycle",
        event = "arc.unseated",
        arc = %arc.name,
        session = %arc.session,
        stage = record
            .current_stage()
            .map(|stage| stage.as_str())
            .unwrap_or("-"),
        // The absence of exactly this field is what made the false stop take a
        // cross-log investigation to root-cause.
        owner = record.owner.as_deref().unwrap_or("-"),
        stalled,
    );
    if !stalled {
        return;
    }
    let stage = record.current_stage().unwrap_or(ArcStage::Implement);
    stop_arc_for_session(
        &ctx.supervisor,
        &ctx.wheel,
        &arc.session,
        &arc.project,
        &arc.name,
        stage,
        ArcStopReason::Stalled,
        StopDelivery {
            hand_back: HandBack::Arm,
            record: true,
        },
    )
    .await;
    state.lock().await.remove(key);
}

/// What the settle decided this tick, for the `arc.tick` line (Table T02).
struct SettleVerdict {
    /// True when this tick's action passed the gate; false when it was
    /// withheld, and false when no action was decided at all.
    settled: bool,
    /// How long the current reading has been standing, or `None` when nothing
    /// is being settled.
    quiet_for: Option<Duration>,
}

/// Hold an idle reading for `idle_settle` before anything irreversible is done
/// with it ([P01]), clearing `action` when the wait is not over.
///
/// The window is over the reading's own facts rather than over wall time
/// alone: a wake, a turn, or a job opening inside it means the second reading
/// is of a different session, so the window starts again over the new one. It
/// is what makes the gap between a turn ending and its wake unspendable, which
/// is the gap the incident was decided in.
///
/// Two stops go through ungated. `SessionGone` and `Stalled` are decided above
/// the predicate's own idle gate, so they are reachable on a reading that is
/// not idle at all — and neither is a claim about an instant: a session with no
/// child is gone whenever it is looked at, and the clock has already waited
/// half an hour.
///
/// **A withheld reading is also an unspent one**, and `last_done_count` is the
/// one piece of memory that says so. It advances on any idle reading, which is
/// how a boundary is retired once it has been answered — so a tick that
/// declined to answer one and advanced it anyway would swallow the boundary:
/// the settled sweep behind it reads `step_just_done: false` and the stage
/// waits forever for a prompt nobody will send now. The other bookkeeping above
/// the predicate is left alone on purpose, because it records what *happened* —
/// a turn ended, the context grew — and that is true whether or not the runner
/// chose to act on it.
///
/// Eight parameters, and each is a different reader's fact rather than a
/// bundle waiting to be found: the context and the state map are the runner's
/// own, the key and the arc address one entry, the snapshot and the reading
/// are the two halves of what this tick saw, the memory is what the previous
/// tick left, and the action is the thing being held — taken by `&mut`
/// because withholding it is the whole job.
#[allow(clippy::too_many_arguments)]
async fn settle_gate(
    ctx: &ArcContext,
    state: &Arc<Mutex<HashMap<String, ArcState>>>,
    key: &str,
    arc: &BoundArc,
    session: &SessionSnapshot,
    reading: &ArcReading,
    memory: TickMemory,
    action: &mut Option<ArcAction>,
) -> SettleVerdict {
    let unheld = SettleVerdict {
        settled: action.is_some(),
        quiet_for: None,
    };
    if !reading.facts.session_idle {
        // A reading that is not idle settles nothing, and whatever window was
        // open described a session that has since moved.
        let mut map = state.lock().await;
        if let Some(entry) = map.get_mut(key) {
            entry.quiet_since = None;
            entry.quiet_marks = None;
        }
        return unheld;
    }
    if matches!(
        action,
        Some(ArcAction::Stop {
            reason: ArcStopReason::SessionGone | ArcStopReason::Stalled,
            ..
        })
    ) {
        return unheld;
    }
    let Some(settle) = reading.config.idle_settle() else {
        return unheld;
    };
    if action.is_none() {
        // Nothing to hold. The window is left standing rather than cleared:
        // the reading is still idle, and a tick that decided nothing is not
        // evidence the session moved.
        let map = state.lock().await;
        return SettleVerdict {
            settled: false,
            quiet_for: map
                .get(key)
                .and_then(|entry| entry.quiet_since)
                .map(|since| since.elapsed()),
        };
    }

    let marks = QuietMarks::of(session);
    let arm = {
        let mut map = state.lock().await;
        let entry = map.entry(key.to_string()).or_default();
        match (entry.quiet_marks, entry.quiet_since) {
            // The same session, standing still long enough to be worth
            // spending. This is the only path that acts.
            (Some(seen), Some(since)) if seen == marks && since.elapsed() >= settle => {
                return SettleVerdict {
                    settled: true,
                    quiet_for: Some(since.elapsed()),
                };
            }
            // The same session, but not for long enough yet — a changeset tick
            // landing early inside a window somebody already armed. The armed
            // re-sweep is still coming, so arming a second would only mean two
            // sweeps for one window.
            (Some(seen), Some(since)) if seen == marks => {
                entry.last_done_count = memory.last_done_count;
                *action = None;
                return SettleVerdict {
                    settled: false,
                    quiet_for: Some(since.elapsed()),
                };
            }
            // A different reading, or the first one. Start the window over it.
            _ => {
                entry.last_done_count = memory.last_done_count;
                entry.quiet_marks = Some(marks);
                entry.quiet_since = Some(Instant::now());
                true
            }
        }
    };

    if arm && let Some(tx) = ctx.settle.clone() {
        let session_id = arc.session.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(settle).await;
            let _ = tx.send(session_id).await;
        });
    }
    *action = None;
    SettleVerdict {
        settled: false,
        quiet_for: Some(Duration::ZERO),
    }
}

/// The `opener` word on an `arc.tick` line (Table T02) — what opened the turn
/// the seated session is in, or `-` between turns.
///
/// The two counts beside it say how the arc got here; this says what it is in
/// the middle of, which is the difference between a stage that has gone quiet
/// and one the harness has just woken.
fn describe_opener(opener: Option<TurnOpener>) -> &'static str {
    match opener {
        Some(TurnOpener::Prompt) => "prompt",
        Some(TurnOpener::Wake) => "wake",
        None => "-",
    }
}

/// The `decided` and `action` words on an `arc.tick` line — one token per
/// decision, so the log can be grepped for what the arc did at a boundary.
///
/// Both fields are this function's output over the same value at two moments:
/// `decided` is what the predicate returned, `action` what survived the settle
/// gate. They differ exactly when a reading was held, which is the state no
/// single field could express.
fn describe_action(action: Option<&ArcAction>) -> String {
    match action {
        None => "none".to_string(),
        Some(ArcAction::Rotate(rotation)) => format!("rotate:{}", rotation.stage.as_str()),
        Some(ArcAction::Prompt {
            kind: PromptKind::Compact,
            ..
        }) => "prompt:compact".to_string(),
        Some(ArcAction::Prompt {
            kind: PromptKind::Continue { .. },
            ..
        }) => "prompt:continue".to_string(),
        Some(ArcAction::Prompt {
            kind: PromptKind::StillOpen { .. },
            ..
        }) => "prompt:still-open".to_string(),
        Some(ArcAction::Done) => "done".to_string(),
        Some(ArcAction::Stop { reason, .. }) => format!("stop:{}", reason.as_str()),
        Some(ArcAction::Reverse { stage }) => format!("reverse:{}", stage.as_str()),
        Some(ArcAction::Continue { stage, .. }) => format!("continue:{}", stage.as_str()),
    }
}

/// The done-count the next tick compares against.
///
/// Only an idle reading may move it. The changeset recompute fires mid-turn —
/// a round committing is exactly what fires it — and if that sweep recorded
/// the count, the "a step just went done" edge would be consumed before the
/// turn-end tick could see it, and an implement stage would never rotate.
fn retain_done_count(previous: Option<usize>, current: usize, idle: bool) -> Option<usize> {
    if idle { Some(current) } else { previous }
}

/// What one card is doing right now, read from the supervisor's live ledger.
///
/// `Clone` because `evaluate` hands one to the blocking read and every reader
/// after that read — the settle's marks, the reversal's comparison, the tick
/// line's `opener` — needs the same facts on this side of it. One clone at the
/// call rather than fields threaded onto `ArcReading` one at a time.
#[derive(Clone)]
struct SessionSnapshot {
    live: bool,
    idle: bool,
    /// A turn is in flight on the seated claude session.
    turn_active: bool,
    /// What opened the turn now in flight, or `None` between turns.
    turn_opener: Option<TurnOpener>,
    /// The seated claude session has ended at least one turn **it was asked
    /// for** ([P02]). A wake-opened turn ending is not a stage answering.
    turn_ended: bool,
    /// Its most recent turn ended in an API error rather than a response.
    api_error: bool,
    /// Its most recent turn was cancelled by the user.
    turn_cancelled: bool,
    /// How many turns the seated claude session has ended, of every opener —
    /// the clock's motion signal, and never the horizon's.
    turns_ended: u32,
    /// How many of those a prompt opened. The count, not the flag, because a
    /// pending prompt is read back by comparing against the count at the
    /// moment it was sent — and only an asked turn can be the answer to one.
    prompt_turns_ended: u32,
    /// How many of those a wake opened ([P02]).
    wake_turns_ended: u32,
    /// How many background jobs the session holds open — the other half of
    /// `idle`, carried so a reader past the blocking read can say *why* a
    /// session was busy.
    open_jobs: usize,
    /// The claude session running on the card carries a `stage_label` — a
    /// rotation seated it.
    stage_seated: bool,
    claude_session_id: Option<String>,
    context_window: Option<i64>,
}

async fn session_snapshot(ctx: &ArcContext, id: &TugSessionId) -> Option<SessionSnapshot> {
    let entry_arc = {
        let ledger = ctx.supervisor.ledger.lock().await;
        ledger.get(id).cloned()
    };
    // No entry, or one parked `Idle`, is a card that has not spawned since
    // tugcast started — the startup sweep runs before any deck reconnects, and
    // a rebound entry sits `Idle` until the deck's first frame. That is a wait,
    // not a death: the ledger row the sweep found is still `live`, and the arc
    // picks up on the card's first idle after it spawns. Reading it as gone
    // would stop every in-flight arc on every restart. `Errored` and `Closed`
    // are the states with nothing left to advance — and so, since W7, is an
    // `Idle` this process watched go `Live` first.
    let entry_arc = entry_arc?;
    let (
        live,
        idle,
        turn_active,
        turn_opener,
        turns_ended,
        prompt_turns_ended,
        wake_turns_ended,
        open_jobs,
        api_error,
        turn_cancelled,
        claude_session_id,
        context_window,
    ) = {
        let entry = entry_arc.lock().await;
        let live = match entry.spawn_state {
            // **The two `Idle`s.** A card parked `Idle` used to be
            // indistinguishable from a card whose tugcast had just restarted,
            // so every one of them was read as a wait — which is why killing a
            // stage's claude reached no decision at all, and W6 could not write
            // the stage-kill test (`at0503`'s docblock recorded it as
            // behaviour). `ever_live_here` is the fact that tells them apart:
            // an entry this process watched reach `Live` and then found back at
            // `Idle` has lost the child it was running. That is a death, and
            // the arc stops as `SessionGone` at the sweep that reads it.
            //
            // The other `Idle` is unchanged and still a wait: an entry rebound
            // from tugbank that no deck has spawned yet. It never reached
            // `Live` here, so it never sets the flag.
            //
            // `reset_session` — the `/clear` gesture — clears the flag as part
            // of making the entry fresh, so a `/new` still costs the taken-card
            // arm its immediacy and lands its stop at the user's next prompt,
            // which is the trade this arm was written for and is a better
            // receipt than "its session ended".
            SpawnState::Idle if entry.ever_live_here => false,
            SpawnState::Idle => return None,
            // **A card with no child is not live, whatever the bridge
            // believes.** `spawn_state` is the bridge's own account of itself,
            // and a bridge whose child crashed is retrying — so it goes on
            // saying `Live`, correctly, for the second the respawn takes. What
            // it has no way to say is that the retry never came back, and
            // `at0505` drives exactly that: the stage's tugcode is killed,
            // tugcast holds no child for the card, nothing replaces it, and the
            // entry reads `Live` indefinitely. The arc then had a live session
            // producing nothing — no reason to stop, and nothing to move.
            //
            // `child_gone_at` is the absence, and the grace is what keeps an
            // ordinary retry from being read as a death.
            SpawnState::Spawning | SpawnState::Live => entry
                .child_gone_at
                .is_none_or(|gone| gone.elapsed() < CHILD_GONE_GRACE),
            SpawnState::Errored | SpawnState::Closed => false,
        };
        (
            live,
            // Idle means finished, not merely between frames: a stage that
            // backgrounded a test sweep has not decided anything yet, and a
            // rotation on that reading would advance the arc past work still
            // running.
            entry.is_quiet(),
            entry.turn_active,
            entry.turn_opener,
            entry.turns_ended,
            entry.prompt_turns_ended,
            entry.wake_turns_ended,
            entry.open_jobs.len(),
            entry.turn_api_error,
            entry.turn_cancelled,
            entry.claude_session_id.clone(),
            entry.context_window_tokens,
        )
    };
    // Only a rotation writes a `stage_label`, at the `session_init` that
    // follows its announcement, so the label is the durable fact that this
    // session was seated by the wheel rather than reached by the deck.
    let stage_seated = claude_session_id
        .as_deref()
        .is_some_and(|id| ctx.session_ledger.stage_provenance(id).is_some());
    Some(SessionSnapshot {
        live,
        idle,
        turn_active,
        turn_opener,
        turn_ended: prompt_turns_ended > 0,
        turns_ended,
        prompt_turns_ended,
        wake_turns_ended,
        open_jobs,
        api_error,
        turn_cancelled,
        stage_seated,
        claude_session_id,
        context_window,
    })
}

/// Everything one tick read, kept together so the act does not read it again.
struct ArcReading {
    /// The arc this reading is of — how every stage after devise is asked.
    name: String,
    record: ArcRecord,
    facts: ArcFacts,
    /// How many ledger rows read `done` — the next tick's comparison point.
    done_count: usize,
    /// How a stage's prompt names the plan: the arc's name ([P10]). `None`
    /// when there is no plan yet, which is what a devise stage means.
    plan_for_prompt: Option<String>,
    /// Where the devise stage should write its plan, repo-relative.
    devise_target: Option<String>,
    /// The repo-relative paths the document cites.
    cited_paths: Vec<String>,
    /// What moved in those paths since the document was last written.
    commits_since: Vec<String>,
    /// How many turns the seated session had ended when this tick read it —
    /// counting only the turns it was *asked* for, which is the mark a
    /// delivered prompt's own turn is later recognized against: a wake cannot
    /// be the answer to a prompt.
    turns_ended: u32,
    /// The same, of every opener — the clock's motion signal.
    all_turns_ended: u32,
    /// How many of the seated session's turns a wake opened ([P02]). Carried
    /// here as well as on the snapshot because `finish` takes a `&ArcReading`
    /// and no snapshot, and the marks a stop leaves behind are read from it.
    wake_turns_ended: u32,
    config: ArcConfig,
}

/// The runner's per-arc memory as one tick reads it — the facts no document
/// can hold, gathered before the blocking read so they reach the predicate.
#[derive(Debug, Clone, Copy, Default)]
struct TickMemory {
    last_done_count: Option<usize>,
    compacted_since_below: bool,
    compact_turn_just_ended: bool,
    /// A re-ask is out and the turn it opened has not ended yet ([P06]).
    reask_pending: bool,
}

/// Gather the facts. Blocking: file reads and, for an implement stage, one
/// scoped git read.
fn read(
    project: &Path,
    name: &str,
    session: &SessionSnapshot,
    memory: TickMemory,
) -> Option<ArcReading> {
    let record = read_arc(project, name)?;
    let project_config = Config::load_from_project(project).unwrap_or_default();
    let config = project_config.tugtool.arc.clone();

    let document_abs = record.document.as_ref().map(|doc| project.join(doc));
    let document_exists = document_abs.as_ref().is_some_and(|p| p.is_file());
    let document_source = document_abs
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok());
    let input_is_plan = document_source.as_deref().is_some_and(lints_as_plan);

    // What a stage is handed beyond its ask: the paths the
    // document itself cites, and what git says moved in them since the
    // document was written. Both gathered here, inside the pass that is
    // blocking by construction, and both total — a document citing nothing and
    // a repo git has never seen simply contribute no clause.
    let cited_paths = document_source
        .as_deref()
        .map(|source| wheel::prompt::cited_paths(source, project, wheel::prompt::CITED_PATHS_CAP))
        .unwrap_or_default();
    // An untracked document has no last commit, so the anchor is when the
    // author wrote it: the file's own modification time.
    let commits_since = document_abs
        .as_ref()
        .and_then(|p| p.metadata().ok())
        .and_then(|m| m.modified().ok())
        .map(|since| {
            tugarc_core::ops::commits_touching_after(
                project,
                since,
                &cited_paths,
                wheel::prompt::COMMITS_CAP,
            )
        })
        .unwrap_or_default();

    // The plan is at the arc's own address or it does not exist; there is no
    // residence to discover and nothing to record.
    let plan_abs = tugarc_core::plan_file(project, name);
    let plan_abs = plan_abs.is_file().then_some(plan_abs);
    // The ledger the implement stage walks: the plan when there is one, the
    // `/arc` door's task list otherwise. This is the whole of what tells the
    // two kinds apart — an arc whose only ledger is a task list has nothing
    // to devise and nothing to review, so its arc opens at implement.
    let ledger_abs = tugarc_core::ledger_file(project, name);
    let task_list = plan_abs.is_none() && ledger_abs.is_some();
    // Every stage after devise names the *arc*, not a path ([P10]): the
    // skills resolve a name, so a stage cannot be pointed at the wrong file.
    let plan_for_prompt = ledger_abs.as_ref().map(|_| name.to_string());

    let ledger_abs_display = ledger_abs
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    let ledger_source = ledger_abs
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok());
    let doc = ledger_source.as_deref().and_then(|s| plan::parse(s).ok());
    // Lint and review state are the *plan's* facts, and only the devise and
    // review stages read them. A task list is held to no skeleton, so it
    // answers neither question rather than answering them badly.
    let lint_ok = plan_abs.is_some()
        && doc
            .as_ref()
            .is_some_and(|d| !plan::has_errors(&plan::lint(d)));
    let review = match (plan_abs.is_some(), doc.as_ref(), ledger_source.as_deref()) {
        (true, Some(d), Some(source)) => Some(plan::review_state(d, source)),
        _ => None,
    };

    let done_count = doc.as_ref().map(count_closed).unwrap_or(0);
    let first_pending = doc.as_ref().and_then(|d| {
        d.ledger_rows
            .iter()
            .position(|row| row.status != "done" && row.status != "withdrawn")
            .map(|index| index + 1)
    });
    // Whether the table holds a row somebody opened and did not close.
    // `in progress` is the step machine's one status for "being walked right
    // now", so its absence over a run with closes behind it and steps ahead
    // of it means the last thing that happened to this ledger was a *close*.
    let step_open = doc
        .as_ref()
        .is_some_and(|d| d.ledger_rows.iter().any(|row| row.status == "in progress"));

    let declarations = tugarc_core::log::read_declarations(project, name);

    let stage_session_current = match record.stages.last() {
        Some(line) => session.claude_session_id.as_deref() == Some(line.session_id.as_str()),
        None => true,
    };
    // Tokens, not a share of the model's window: what makes a stage work badly
    // is a long context, and long is a number.
    let context_tokens = session
        .context_window
        .and_then(|used| u64::try_from(used).ok());

    // The seated stage has more turns to run on this session. Only an
    // implement stage does: devise and review end by rotating.
    let run_through = declarations.run_through.map(|n| n as usize);
    let stage_continues = record.current_stage() == Some(ArcStage::Implement)
        && !declarations.run_complete
        && first_pending
            .zip(run_through)
            .is_some_and(|(next, through)| next <= through);

    let facts = ArcFacts {
        document_exists,
        input_is_plan,
        plan_path: ledger_source
            .is_some()
            .then(|| ledger_abs_display.clone())
            .flatten(),
        task_list,
        lint_ok,
        review,
        ledger: StepLedgerFacts {
            first_pending,
            run_through,
            run_complete: declarations.run_complete,
            step_just_done: match memory.last_done_count {
                Some(previous) => done_count > previous,
                // **Nothing remembered — so read the boundary off the table.**
                //
                // No memory means this arc has not been evaluated since
                // tugcast started. Seeding the comparison at the *current*
                // count, which is what happened before, spends the edge
                // without anyone acting on it: a step that closed in the
                // seconds before a crash was a boundary the arc owed a prompt,
                // and the restart swallowed it. The stage then sat waiting for
                // a boundary that had already gone past.
                //
                // The table can answer instead, and answers with the same rows
                // `done_count` is counted from, so the two cannot disagree: no
                // row open, closes behind, steps ahead — the last thing that
                // happened here was a close, and nothing has answered it.
                None => !step_open && done_count > 0 && first_pending.is_some(),
            },
        },
        session_live: session.live,
        session_idle: session.idle,
        stage_turn_ended: session.turn_ended,
        stage_api_error: session.api_error,
        stage_turn_cancelled: session.turn_cancelled,
        stage_seated: session.stage_seated,
        stage_session_current,
        context_tokens,
        compact_tokens: config.compact_tokens(),
        stage_continues,
        compacted_since_below: memory.compacted_since_below,
        compact_turn_just_ended: memory.compact_turn_just_ended,
        reask_pending: memory.reask_pending,
        audit_declared: matches!(
            declarations.latest,
            Some(tugarc_core::log::ArcDeclaration::Audited)
        ),
        // Runner memory, and the one fact this pass cannot gather: the count
        // is over turns the *previous* tick already saw, so `evaluate` stamps
        // it after this read returns.
        quiet_turns: 0,
        // Runner memory too, and only meaningful on a stopped record: the
        // comparison is against the marks the stop left, which live in the
        // state map. `evaluate` stamps it on the one path that reads it.
        stopped_stage_moved: false,
        // Runner memory too, and for the same reason: the clock is read
        // against a stamp only the caller holds. `evaluate` stamps it.
        stalled: false,
    };

    // Where devise writes: the arc's own `plan.md`, repo-relative, which is
    // also what the record and the stage divider carry.
    let devise_target = Some(format!(".tug/arcs/{name}/plan.md"));

    Some(ArcReading {
        name: name.to_string(),
        record,
        facts,
        done_count,
        plan_for_prompt,
        devise_target,
        cited_paths,
        commits_since,
        turns_ended: session.prompt_turns_ended,
        all_turns_ended: session.turns_ended,
        wake_turns_ended: session.wake_turns_ended,
        config,
    })
}

/// Whether a document already *is* a plan — the fact that lets an arc opened on
/// one skip the devise stage. A brief does not parse as a plan and
/// takes the full arc.
fn lints_as_plan(source: &str) -> bool {
    match plan::parse(source) {
        Ok(doc) => !plan::has_errors(&plan::lint(&doc)),
        Err(_) => false,
    }
}

/// The dirty clause's path list, or `None` when the tree is clean ([P08]).
///
/// Capped at ten. A stage stopped in the middle of a rename campaign leaves
/// two hundred paths behind, and a prompt that listed them all would bury the
/// ask under the footnote — the count is what a reader needs past the tenth
/// name, not the names.
fn dirty_clause(paths: Vec<String>) -> Option<String> {
    const SHOWN: usize = 10;
    if paths.is_empty() {
        return None;
    }
    let extra = paths.len().saturating_sub(SHOWN);
    let mut list = paths
        .iter()
        .take(SHOWN)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if extra > 0 {
        list.push_str(&format!(" and {extra} more"));
    }
    Some(list)
}

/// The arc worktree's dirt off the blocking pool — git runs under it.
async fn worktree_dirt_for(arc: &BoundArc) -> Vec<String> {
    let (project, name) = (arc.project.clone(), arc.name.clone());
    tokio::task::spawn_blocking(move || tugarc_core::ops::worktree_dirt(&project, &name))
        .await
        .unwrap_or_default()
}

/// The stage's opening prompt: the arc's ask, plus what the documents say
/// about where to start and what has moved.
///
/// The facts were gathered in `read`'s blocking pass; the wording is the
/// wheel's, so every arc composes the same way. Nothing here is a word a
/// model wrote.
fn opening_prompt(
    reading: &ArcReading,
    rotation: &Rotation,
    arc: &BoundArc,
    seat: &Path,
    dirty: Option<&str>,
) -> Option<String> {
    let steps = rotation
        .steps
        .map(|(from, through)| step_range(from, through));
    let ask = wheel::prompt::stage_ask(
        rotation.stage.as_str(),
        reading.record.document.as_deref(),
        &reading.name,
        steps.as_deref(),
    )?;
    // Where the stage is, in the runner's own words rather than in four
    // commands the stage would otherwise run to re-learn what this tick just
    // decided. The step coordinates are the implement stage's: a rotation that
    // declares a range carries it, and a first implement stage takes the
    // ledger's own frontier and the run the arc declared.
    let steps_in_hand = rotation.steps.or_else(|| {
        if rotation.stage != ArcStage::Implement {
            return None;
        }
        let ledger = &reading.facts.ledger;
        Some((ledger.first_pending?, ledger.run_through?))
    });
    let place = wheel::prompt::where_clause(
        seat,
        arc.session.as_str(),
        rotation.stage.as_str(),
        steps_in_hand,
    );
    // A stopped arc that is rotating again is resuming, and the stage it opens
    // is owed that fact: it is the difference between starting the work and
    // picking it back up.
    //
    // **`last_stop`, never `stopped`** ([P08]). `compose`'s own docblock says
    // why: every act that picks a stopped arc back up clears `stopped` before
    // the prompt is composed — the `arc-resume` line does it — so a caller
    // reading that field drops the clause on exactly the prompts it exists
    // for. `last_stop` is kept for the generation, for the act doing the
    // picking up.
    //
    // **And gated on a standing `resume`, for the same reason.** `last_stop`
    // is kept for the *generation*, not for the resume: an arc stopped once
    // and picked back up carries it through every rotation afterwards, so a
    // clause read straight off it tells an audit stage rotated hours later
    // that it is resuming from a stop somebody already resumed from. The
    // standing `resume` is what says this rotation is the picking up — it is
    // the same fact the dirty clause is gated on, and the `arc-stage` line
    // this dispatch is about to produce is what clears it.
    let resume = reading
        .record
        .resume
        .is_some()
        .then_some(reading.record.last_stop.as_ref())
        .flatten()
        .map(|(stage, reason)| (stage.as_str(), reason.as_str()));
    Some(wheel::prompt::compose(
        &ask,
        Some(&place),
        &reading.cited_paths,
        &reading.commits_since,
        resume,
        dirty,
    ))
}

/// The seat a stage is handed on its `where` line — made, not computed.
///
/// An implement or audit stage works in the arc's worktree, so the dispatch
/// makes it before it writes the line that names it: `create_in` is
/// idempotent on a present branch and worktree, runs the project's
/// `post_create` on a fresh one, and returns the path it left standing,
/// which is the path the clause names. A line composed from `worktree_path`
/// alone was a promise — the `arc-unification` join removed the stage's own
/// `arc create` and nothing took its place, so every first implement stage
/// opened on a worktree that did not exist and died of it.
///
/// Devise and review make nothing. They write documents at
/// `.tug/arcs/<name>/`, which is not in the worktree, and a seat made at
/// devise would sit empty through two stages that never enter it; their line
/// names the path the seat will have, and that is the one computed path left
/// in the dispatch, kept here so it is one and stated.
///
/// Blocking — git runs under it — so every caller wraps it in
/// `spawn_blocking`. An `Err` is `create_in`'s own sentence, and the caller
/// stops the arc as [`ArcStopReason::SeatUnavailable`] with it as the note.
///
/// **A seat is never made over somebody's rounds.** `create_in`'s repair for
/// a branch whose worktree is gone is to delete the branch and cut a fresh
/// one from the base, which is right for a half-built arc and a silent
/// destruction of the work for one that has been walked. The dispatch calls
/// this before every implement and audit prompt, so the question is asked
/// here rather than regretted after: a branch carrying rounds with no
/// worktree is an `Err`, and the arc stops with the sentence that says how
/// to get the seat back.
fn seat_for(project: &Path, name: &str, stage: ArcStage) -> Result<PathBuf, String> {
    match stage {
        ArcStage::Implement | ArcStage::Audit => {
            let rounds = tugarc_core::ops::rounds_a_rebuild_would_lose(project, name);
            if rounds > 0 {
                return Err(format!(
                    "the arc's branch carries {rounds} round(s) and its worktree is gone, so \
                     making the seat would rebuild the branch from its base and lose them. \
                     Re-attach the worktree by hand — `git worktree add .tug/worktrees/{name} \
                     tugarc/{name}` from the project root — and run the arc again."
                ));
            }
            tugarc_core::ops::create_in(project, name, None, false, None)
                .map(|outcome| PathBuf::from(outcome.worktree))
        }
        ArcStage::Devise | ArcStage::Review => Ok(tugarc_core::ops::worktree_path(project, name)),
    }
}

/// [`seat_for`] off the blocking pool, and the stop when it fails.
///
/// `Some(seat)` is a path that exists for the stages that need one. `None`
/// means the arc has already been stopped as `seat unavailable`, its note
/// carrying `create_in`'s error, and the caller returns.
async fn seat_or_stop(ctx: &ArcContext, arc: &BoundArc, stage: ArcStage) -> Option<PathBuf> {
    let (project, name) = (arc.project.clone(), arc.name.clone());
    let outcome = tokio::task::spawn_blocking(move || seat_for(&project, &name, stage))
        .await
        .unwrap_or_else(|join| Err(format!("the seat task did not finish: {join}")));
    match outcome {
        Ok(seat) => Some(seat),
        Err(error) => {
            // The error rides as a note, the carriage `NeedsDecision` and
            // `RecordsDisagree` use: the reason vocabulary is closed and
            // cannot carry a payload, and a receipt that only says the seat
            // could not be made is a stop nobody can act on.
            let (p, d) = (arc.project.clone(), arc.name.clone());
            let _ = tokio::task::spawn_blocking(move || append_arc_note(&p, &d, &error)).await;
            stop(ctx, arc, stage, ArcStopReason::SeatUnavailable).await;
            None
        }
    }
}

/// What the doctor's comparison left for the caller to act on.
struct RecordsVerdict {
    /// The codes among [`tugarc_core::doctor::OPEN_STEP_CODES`] a resume
    /// excluded from the disagreement. Empty on every path that is not a
    /// resume, and on a resume whose step records agree.
    open_step: Vec<String>,
}

/// Run the doctor's five-record comparison where a dispatch can still act on
/// it: `Some(verdict)` when the records agree, `None` when the arc has been
/// stopped as `RecordsDisagree` and the caller should return.
///
/// **Both resume paths run this, and they act on its one exception
/// differently** ([P07]). A rotation hands a stage its coordinates — the
/// worktree, the seat, the step in hand — as facts rather than as something to
/// probe for, and `tugplug/skills/arc-implement/SKILL.md` tells that stage the
/// runner "ran `arc doctor`'s comparison … immediately before" the `where`
/// line it is reading. That sentence was true of `rotate` and false of
/// `continue_stage`; this helper is what makes it true of both, rather than
/// the alternative of editing the claim down to what the code did.
///
/// **The asymmetry is the whole point.** The three findings in
/// `OPEN_STEP_CODES` describe a step left half-walked, which on a resume is
/// exactly the interruption being resumed from — stopping on them would make a
/// resume unable to resume. So a resume excludes them here and the caller
/// decides what they mean: the stage's **own** session re-enters the row,
/// because it has a transcript that knows what it changed and `arc step start`
/// accepts a re-entry idempotently; a **rotated** session is given a `pending`
/// row instead, because it knows nothing and a half-open row would be a claim
/// it cannot stand behind.
///
/// `arc-unbound` is excluded on every path, resume or not. It asks whether any
/// live session is bound to this arc and answers out of the machine's sessions
/// ledger — a question the caller already answered better, from the binding
/// that produced the seat it is holding. A runner that stopped on it would be
/// taking a second, worse reading of its own premise. `seat-missing` is *not*
/// excluded, which is what makes a worktree deleted by hand and a `create_in`
/// that failed read the same way.
async fn records_agree_or_stop(
    ctx: &ArcContext,
    arc: &BoundArc,
    stage: ArcStage,
    resuming: bool,
) -> Option<RecordsVerdict> {
    let (project, name) = (arc.project.clone(), arc.name.clone());
    let diagnosis =
        tokio::task::spawn_blocking(move || tugarc_core::doctor::doctor(&project, &name, false))
            .await
            .ok()
            .and_then(|outcome| outcome.ok());
    let Some(outcome) = diagnosis else {
        return Some(RecordsVerdict {
            open_step: Vec::new(),
        });
    };
    let mut open_step = Vec::new();
    let mut disagreements = Vec::new();
    for finding in &outcome.diagnosis.findings {
        if finding.code == "arc-unbound" {
            continue;
        }
        // The base holding the arc's own bytes is a state the join drops by
        // itself; the doctor names it for a person, and it stops no stage.
        if finding.code == tugarc_core::doctor::BASE_ECHO_CODE {
            continue;
        }
        if resuming && tugarc_core::doctor::OPEN_STEP_CODES.contains(&finding.code.as_str()) {
            open_step.push(finding.code.clone());
            continue;
        }
        disagreements.push(finding.sentence.clone());
    }
    if !disagreements.is_empty() {
        // The sentences ride as a note, the carriage `NeedsDecision` already
        // established: the reason vocabulary is closed and cannot carry a
        // payload, and a receipt saying only that the records disagree is a
        // stop nobody can act on.
        let note = disagreements.join("; ");
        let (p, d) = (arc.project.clone(), arc.name.clone());
        let _ = tokio::task::spawn_blocking(move || append_arc_note(&p, &d, &note)).await;
        stop(ctx, arc, stage, ArcStopReason::RecordsDisagree).await;
        return None;
    }
    Some(RecordsVerdict { open_step })
}

/// The origin a wheel-sent prompt is attributed to.
///
/// The wheel is a participant in the transcript, not a subsystem announcing
/// itself, so the deck opens a `wheel` turn on this frame and the prompt
/// speaks in a row of the wheel's own — the same shape a typed prompt gets,
/// under the wheel's name. Any other origin gets a quiet note instead, because
/// a sender the reader cannot name has no row to speak from.
const WHEEL_NOTICE_ORIGIN: &str = "wheel";

/// Send a prompt to the stage's own seated session, between turns.
///
/// Two frames in one order: the opener on CODE_OUTPUT, then the submission
/// through the dispatcher. Journaling is not rendering — the dispatcher's
/// intercept makes the turn real to the server and to a later reload, but the
/// live user row comes from the composer echoing its own submission, and the
/// wheel has no composer, so the opener is what puts the wheel's own row on
/// screen. Without it the stage would start working with no visible cause,
/// which is the unannounced server turn the doctrine forbids.
async fn deliver_prompt(
    ctx: &ArcContext,
    state: &Arc<Mutex<HashMap<String, ArcState>>>,
    arc: &BoundArc,
    key: &str,
    reading: &ArcReading,
    kind: &PromptKind,
    why: &PromptWhy,
) {
    // The same guard `rotate` takes, for the same reason: a tick that raced
    // another one decided over facts that may already have moved.
    let project = arc.project.clone();
    let name = arc.name.clone();
    let fresh = tokio::task::spawn_blocking(move || read_arc(&project, &name))
        .await
        .ok()
        .flatten();
    if fresh.as_ref().map(|r| r.stages.len()) != Some(reading.record.stages.len()) {
        // **Never a bare return** ([P10]). A guard that declines silently is
        // indistinguishable in the trace from an act that was never decided,
        // and the arc's own log line for this tick already said it was going
        // to prompt.
        info!(
            target: "dev::session-lifecycle",
            event = "arc.prompt_skipped",
            arc = %arc.name,
            reason = "record moved under the tick",
        );
        return;
    }

    let text = match kind {
        PromptKind::Compact => "/compact".to_string(),
        PromptKind::Continue { steps } => {
            let range = step_range(steps.0, steps.1);
            let Some(ask) = wheel::prompt::stage_ask(
                ArcStage::Implement.as_str(),
                reading.record.document.as_deref(),
                &reading.name,
                Some(&range),
            ) else {
                // The twin of `rotate`'s: an ask that cannot be composed is
                // an arc with no words for its own stage, and it stopped on
                // the rotation path and sat silently here ([P10]).
                stop(
                    ctx,
                    arc,
                    ArcStage::Implement,
                    ArcStopReason::PromptUnavailable,
                )
                .await;
                return;
            };
            // No clauses: the session already holds its own context, and the
            // opening prompt's start-there and what-changed clauses are for a
            // session that does not.
            //
            // The `where` clause is the exception, because its step
            // coordinates are the one fact this prompt moves: the step in hand
            // is the range's first, and the run still reaches its declared end.
            let Some(seat) = seat_or_stop(ctx, arc, ArcStage::Implement).await else {
                return;
            };
            let place = wheel::prompt::where_clause(
                &seat,
                arc.session.as_str(),
                ArcStage::Implement.as_str(),
                Some(*steps),
            );
            wheel::prompt::compose(&ask, Some(&place), &[], &[], None, None)
        }
        // The re-ask, composed exactly as the continue ask is: the `where`
        // clause and nothing else, because the session already holds its own
        // context and the step coordinates are the one fact this prompt moves.
        PromptKind::StillOpen { steps } => {
            let ask = wheel::prompt::still_open_ask(&reading.name, steps.0, steps.1);
            let Some(seat) = seat_or_stop(ctx, arc, ArcStage::Implement).await else {
                return;
            };
            let place = wheel::prompt::where_clause(
                &seat,
                arc.session.as_str(),
                ArcStage::Implement.as_str(),
                Some(*steps),
            );
            wheel::prompt::compose(&ask, Some(&place), &[], &[], None, None)
        }
    };

    let session = arc.session.as_str().to_string();
    ctx.supervisor.code_output.publish_tagged(Frame::new(
        FeedId::CODE_OUTPUT,
        super::base_motion::notice_payload(&session, WHEEL_NOTICE_ORIGIN, &text),
    ));
    ctx.supervisor
        .dispatch_one(Frame::new(
            FeedId::CODE_INPUT,
            super::base_motion::user_message_payload(&session, &text),
        ))
        .await;
    // Tug's own record of what the wheel said, so a reload attributes this
    // prompt to the wheel rather than to the user. Claude's JSONL will record
    // it as an ordinary user entry, because that file cannot say otherwise.
    ctx.supervisor
        .sessions_recorder
        .record_wheel_prompt(&session, &text);

    // A prompt delivered is motion, whichever kind it was — the arc did
    // something, and the clock measures the silence *after* the last thing it
    // did. Stamped unconditionally and before the compact-only block below,
    // which is the only other writer here.
    {
        let mut map = state.lock().await;
        let entry = map.entry(key.to_string()).or_default();
        entry.last_motion_at = Some(Instant::now());
        // The window this prompt was spent from is closed (Table T01). Left
        // standing it would still read as settled at the next tick, and the
        // same reading would buy a second prompt.
        entry.quiet_since = None;
        entry.quiet_marks = None;
    }

    if let PromptWhy::Compact {
        tokens,
        compact_tokens,
    } = why
    {
        let note = format!("{tokens} > {compact_tokens}");
        let (project, name) = (arc.project.clone(), arc.name.clone());
        let arc_note = format!("compacted at {note}");
        let _ = tokio::task::spawn_blocking(move || {
            let _ = append_arc_log(&project, &name, "compact", &note);
            append_arc_note(&project, &name, &arc_note)
        })
        .await;

        let mut map = state.lock().await;
        let entry = map.entry(key.to_string()).or_default();
        entry.compacted_since_below = true;
        entry.pending = Some(PendingPrompt {
            kind: PromptKind::Compact,
            turns_ended_at: reading.turns_ended,
        });
    }

    // The re-ask is remembered the same way, and read back the same way: the
    // turn it opened has ended once the asked count moves past this. Until
    // then `reask_pending` is what keeps the horizon from spending a second
    // re-ask on the quiet turn this one already answered.
    if let PromptKind::StillOpen { .. } = kind {
        let mut map = state.lock().await;
        let entry = map.entry(key.to_string()).or_default();
        entry.pending = Some(PendingPrompt {
            kind: kind.clone(),
            turns_ended_at: reading.turns_ended,
        });
    }

    info!(
        target: "dev::session-lifecycle",
        event = "arc.prompt",
        arc = %arc.name,
        kind = %describe_action(Some(&ArcAction::Prompt {
            kind: kind.clone(),
            why: why.clone(),
        })),
        "arc prompted the seated session",
    );
}

async fn rotate(
    ctx: &ArcContext,
    state: &Arc<Mutex<HashMap<String, ArcState>>>,
    arc: &BoundArc,
    key: &str,
    reading: &ArcReading,
    rotation: &Rotation,
) {
    // Re-read the record immediately before acting: a tick that raced another
    // one decided over facts that may already have moved.
    let project = arc.project.clone();
    let name = arc.name.clone();
    let fresh = tokio::task::spawn_blocking(move || read_arc(&project, &name))
        .await
        .ok()
        .flatten();
    if fresh.as_ref().map(|r| r.stages.len()) != Some(reading.record.stages.len()) {
        info!(
            target: "dev::session-lifecycle",
            event = "arc.rotate_skipped",
            arc = %arc.name,
            stage = rotation.stage.as_str(),
            reason = "record moved under the tick",
        );
        return;
    }

    // **The seat exists before anything names it.** An implement or audit
    // stage is about to be handed its worktree as a fact, so the worktree is
    // made here — idempotently, so a re-rotation costs nothing — and made
    // *before* the doctor runs, because the doctor now reads the seat as a
    // record and would otherwise stop the arc over the very seat this
    // dispatch was about to make. A `create_in` that fails is its own stop.
    let Some(seat) = seat_or_stop(ctx, arc, rotation.stage).await else {
        return;
    };

    // **The records agree, or nothing is seated.** The dispatch is about to
    // hand a stage its coordinates — the worktree, the seat, the step in hand
    // — as facts rather than as something to probe for, and a stage that
    // believes a `where` line built over a desynced record works from a
    // frontier the surfaces do not share. So the doctor's five-record
    // comparison runs here, at the one point where a disagreement can still be
    // caught before anybody acts on it.
    let resuming = reading.record.resume.is_some();
    let Some(verdict) = records_agree_or_stop(ctx, arc, rotation.stage, resuming).await else {
        return;
    };
    // **A rotated resume is handed a `pending` row, never a half-open one**
    // ([P07]). The session about to be seated has no transcript and no way to
    // know what the interrupted one had already changed, so the honest record
    // is a step nobody has opened — plus [Step 7](#step-7)'s dirty-tree
    // clause, which is what says the worktree's edits are the arc's own.
    if !verdict.open_step.is_empty() {
        let (p, d) = (arc.project.clone(), arc.name.clone());
        let reset = tokio::task::spawn_blocking(move || {
            let step = tugarc_core::doctor::open_step(&p, &d)?;
            Some((
                step,
                tugarc_core::ops::step_reset_in(&p, &d, step, Some("resumed on a fresh session")),
            ))
        })
        .await
        .ok()
        .flatten();
        match reset {
            Some((step, Ok(_))) => info!(
                target: "dev::session-lifecycle",
                event = "arc.step_reset_for_rotated_resume",
                arc = %arc.name,
                step = step,
                findings = %verdict.open_step.join(", "),
            ),
            Some((step, Err(e))) => warn!(
                arc = %arc.name,
                step = step,
                error = %e,
                "could not park the open step a rotated resume inherits",
            ),
            None => warn!(
                arc = %arc.name,
                findings = %verdict.open_step.join(", "),
                "the records name a half-walked step and nothing names which",
            ),
        }
    }

    // The worktree's dirt, on a resume only ([P08]). A fresh rotation into a
    // clean stage has no stop to explain, and the clause would read there as
    // an accusation rather than as the handover it is.
    let dirty = if resuming {
        dirty_clause(worktree_dirt_for(arc).await)
    } else {
        None
    };
    let Some(prompt) = opening_prompt(reading, rotation, arc, &seat, dirty.as_deref()) else {
        stop(ctx, arc, rotation.stage, ArcStopReason::PromptUnavailable).await;
        return;
    };
    let Some(document) = reading.record.document.clone() else {
        stop(ctx, arc, rotation.stage, ArcStopReason::DocumentMissing).await;
        return;
    };

    // The devise rotation is where the plan's path is *chosen*, so it is
    // recorded here rather than discovered later.
    let project = arc.project.clone();
    let name = arc.name.clone();
    if rotation.stage == ArcStage::Devise {
        if let Some(target) = reading.devise_target.clone() {
            let (p, d) = (project.clone(), name.clone());
            let _ = tokio::task::spawn_blocking(move || append_arc_plan(&p, &d, &target)).await;
        }
    }
    // An arc opened on a plan never devised one, so the plan path is recorded
    // at its first review instead — the document itself — and every
    // later reading finds it where a devised plan's would be.
    if rotation.stage == ArcStage::Review && reading.record.plan.is_none() {
        if let Some(plan) = reading.plan_for_prompt.clone() {
            let (p, d) = (project.clone(), name.clone());
            let _ = tokio::task::spawn_blocking(move || append_arc_plan(&p, &d, &plan)).await;
        }
    }
    if let Some(note) = rotation.note.clone() {
        let (p, d) = (project.clone(), name.clone());
        let _ = tokio::task::spawn_blocking(move || append_arc_note(&p, &d, &note)).await;
    }

    let plan_for_stage = if rotation.stage == ArcStage::Devise {
        reading.devise_target.clone()
    } else {
        reading.plan_for_prompt.clone()
    };
    let request = RotationRequest::new(arc.session.clone(), prompt, rotation.stage.as_str())
        .document(Some(document))
        .plan(plan_for_stage)
        .arc(Some(arc.name.clone()))
        .model(stage_model(&reading.config, rotation.stage))
        .steps(
            rotation
                .steps
                .map(|(from, through)| step_range(from, through)),
        );

    let dispatched_at = reading.record.stages.len();
    // **The seat's owner, before the seat exists.** The arc log is shared
    // across every instance over one checkout, so a second tugcast reads this
    // arc and — unable to snapshot a session living in this process — cannot
    // tell "not mine to watch" from "gone silent". The owner line is what
    // makes those two different readings. It goes down before the dispatch for
    // the same reason the dispatch goes down before the rotation: a crash in
    // the gap must not leave a seat nobody can attribute. No instance id
    // (a standalone launch, a `cargo`-driven test) writes nothing at all —
    // an unowned arc is every runner's to judge, which is today's behavior.
    if let Some(instance) = tugcore::instance::instance_id() {
        let outcome = tokio::task::spawn_blocking({
            let (project, name) = (project.clone(), name.clone());
            move || append_arc_owner(&project, &name, &instance)
        })
        .await;
        report_append(&project, &name, "arc-owner", outcome);
    }
    // **Intent before the act.** A crash between the wheel firing and the
    // bridge's `arc-stage` line leaves a seat the record cannot explain, and
    // the restarted runner read it as a taken card — a wrong stop, and one
    // the user is told about. The line goes down first so the gap reads as
    // "re-rotate this stage" instead. It reports the way every other append
    // here reports, and does not stop the rotation: a rotation that happened
    // is better than one refused over its own footnote.
    let outcome = tokio::task::spawn_blocking({
        let (project, name, stage) = (project.clone(), name.clone(), rotation.stage);
        move || append_arc_dispatch(&project, &name, stage)
    })
    .await;
    report_append(&project, &name, "arc-dispatch", outcome);
    let outcome = wheel::rotate(&ctx.supervisor, &request).await;
    {
        let mut map = state.lock().await;
        let entry = map.entry(key.to_string()).or_default();
        entry.in_flight_at = outcome.is_ok().then_some(dispatched_at);
        // Seed the comparison rather than clearing it. With `None` the first
        // idle tick after a rotation can report no step boundary whatever the
        // plan says — and an implement stage's first idle tick *is* a turn end
        // at a boundary, so the one moment that should act never could. The
        // count at rotation is the plan's count when the stage was seated,
        // which is exactly the baseline "a step went done since this stage
        // started" needs.
        entry.last_done_count = Some(reading.done_count);
        // A fresh session has compacted nothing and is owed no turn.
        entry.compacted_since_below = false;
        entry.pending = None;
        // A fresh stage is owed the whole horizon: whatever the last one did
        // or failed to do is not this one's record. Both turn counts go with
        // it — the seated session is new, and its counts start over.
        entry.quiet_turns = 0;
        entry.prompt_turns_seen = None;
        entry.all_turns_seen = None;
        // The fresh session's context starts over, so a comparison against
        // the retiring one's would read as motion once and then as silence.
        entry.tokens_seen = None;
        // A fresh stage carries no stop baseline. The entry a rotation reaches
        // may be the one a stop left behind — a resume rotates the stage the
        // stop named — and marks left standing would describe an arc that is
        // running again.
        entry.stop_marks = None;
        // The window the rotation was spent from is closed (Table T01), and
        // the session it described is the retiring one either way.
        entry.quiet_since = None;
        entry.quiet_marks = None;
        // The runner acting is motion. A rotation restarts the clock even
        // when the seated session never announces — what the clock then
        // measures is the silence after the dispatch, which is the wedge, and
        // not the silence before it, which the dispatch just answered.
        entry.last_motion_at = Some(Instant::now());
    }

    match outcome {
        Ok(delivery) => info!(
            arc = %arc.name,
            stage = rotation.stage.as_str(),
            ?delivery,
            "arc rotated a stage",
        ),
        Err(refusal) => {
            warn!(
                arc = %arc.name,
                stage = rotation.stage.as_str(),
                reason = refusal.reason(),
                "arc rotation refused",
            );
            stop(ctx, arc, rotation.stage, refusal.stop_reason()).await;
        }
    }
}

/// End the arc: hand the card back on the deck's own model, then record it.
///
/// The model restore goes first so the card the user is handed back is already
/// theirs by the time the terminal line lands.
/// **Undo a stop the stage itself has contradicted** ([P05]).
///
/// The three appends are the record and their order is load-bearing. The note
/// says *what moved*, so the reversal can be read back by somebody who was not
/// watching; `arc-resume` clears the stop; `arc-continue` clears the resume
/// that would otherwise seat a fresh session on top of a stage that is already
/// working. Writing `arc-resume` alone would rotate the stage — replacing a
/// stage mid-thought with an empty one — and that is exactly the failure the
/// second marker exists to prevent, so the pair is written together or the
/// record is wrong.
///
/// Then the stage's model goes back on the card. A stop hands the card back to
/// the deck's model **before** its receipt, so a stage picked back up is
/// running on the wrong model until this puts it right.
///
/// The state reset is `rotate`'s, minus the in-flight latch: nothing was
/// dispatched, because nothing needed to be.
async fn reverse(
    ctx: &ArcContext,
    state: &Arc<Mutex<HashMap<String, ArcState>>>,
    arc: &BoundArc,
    key: &str,
    reading: &ArcReading,
    stage: ArcStage,
) {
    // Re-read immediately before acting, as `rotate` does: a tick that raced
    // another one decided over facts that may already have moved, and the
    // second reversal of one stop would write a second receipt saying the
    // same thing.
    let (project, name) = (arc.project.clone(), arc.name.clone());
    let fresh = tokio::task::spawn_blocking(move || read_arc(&project, &name))
        .await
        .ok()
        .flatten();
    if fresh.as_ref().is_none_or(|record| record.stopped.is_none()) {
        info!(
            target: "dev::session-lifecycle",
            event = "arc.reverse_skipped",
            arc = %arc.name,
            stage = stage.as_str(),
            reason = "the stop was already answered",
        );
        return;
    }

    // What moved, in the order a reader would want it: a step closing is the
    // most specific thing that can have happened and the one the incident
    // actually produced, so it is named first when more than one is true.
    let marks = {
        let map = state.lock().await;
        map.get(key).and_then(|entry| entry.stop_marks)
    };
    let what_moved = match marks {
        Some(marks) if reading.done_count > marks.done_count => "a step closed",
        Some(marks) if reading.wake_turns_ended > marks.wake_turns_ended => "a wake on its session",
        _ => "a turn opened on its session",
    };

    let note = format!("picked back up: {what_moved}");
    let (project, name) = (arc.project.clone(), arc.name.clone());
    let outcome = tokio::task::spawn_blocking({
        let (project, name) = (project.clone(), name.clone());
        move || append_arc_note(&project, &name, &note)
    })
    .await;
    report_append(&project, &name, "arc-note", outcome);
    let outcome = tokio::task::spawn_blocking({
        let (project, name) = (project.clone(), name.clone());
        move || append_arc_resume(&project, &name, stage)
    })
    .await;
    report_append(&project, &name, "arc-resume", outcome);
    let outcome = tokio::task::spawn_blocking({
        let (project, name) = (project.clone(), name.clone());
        move || append_arc_continue(&project, &name, stage)
    })
    .await;
    report_append(&project, &name, "arc-continue", outcome);

    let model = stage_model(&reading.config, stage).unwrap_or_else(|| "default".to_string());
    if let Err(refusal) = wheel::send_model(&ctx.supervisor, &arc.session, &model).await {
        warn!(
            arc = %arc.name,
            reason = refusal.reason(),
            "arc could not put the stage's model back",
        );
    }

    ctx.supervisor.record_arc_receipt(
        arc.session.as_str(),
        &arc.name,
        &arc.project.to_string_lossy(),
        &format_arc_pickup_receipt(&arc.name, stage, what_moved),
    );

    {
        let mut map = state.lock().await;
        let entry = map.entry(key.to_string()).or_default();
        // **The boundary that undid the stop is left unanswered**, which is
        // the difference between an arc that is running again and one that is
        // merely not stopped. A step closing is the act the wheel owes a
        // continue prompt for, and the stop is the only reason nobody sent
        // one; recording the current count here would spend that boundary on
        // the reversal itself, and the stage would sit at a step it had
        // already closed with nothing left to prompt it. So the count goes
        // back to what the stop saw, and the next tick reads the close the
        // way it would have read it had the stop never happened.
        entry.last_done_count = Some(marks.map_or(reading.done_count, |marks| marks.done_count));
        entry.compacted_since_below = false;
        entry.pending = None;
        entry.quiet_turns = 0;
        // **Seeded, never cleared** — the session is the stage's own and its
        // counts are known right now. `rotate` clears them because a fresh
        // session's turns start over; here, clearing would make the *next*
        // turn end the tick that seeds, so the first quiet turn after a
        // pick-up would go uncounted — and with the clock no longer reading
        // an idle session ([P06]), nothing else would answer it.
        entry.prompt_turns_seen = Some(reading.turns_ended);
        entry.all_turns_seen = Some(reading.all_turns_ended);
        entry.tokens_seen = None;
        entry.quiet_since = None;
        entry.quiet_marks = None;
        // The arc is running again, so the baseline a stop left for whoever
        // noticed life after it has done its work and describes nothing.
        entry.stop_marks = None;
        // Nothing was dispatched: the stage was already seated.
        entry.in_flight_at = None;
        entry.last_motion_at = Some(Instant::now());
    }

    info!(
        target: "dev::session-lifecycle",
        event = "arc.reversed",
        arc = %arc.name,
        stage = stage.as_str(),
        moved = what_moved,
    );
}

/// Pick a resumed stage back up on the session it is already sitting on
/// ([P08]).
///
/// The act a resume takes when the card is still the stage's own, and the
/// difference from [`rotate`] is the whole point: a rotation is a fresh
/// session, and the incident's resume spent the entire working context of a
/// stage that had been working when it was wrongly stopped. Nothing here
/// spawns anything — the stage is seated, so it is asked again, on its own
/// card, in its own model.
///
/// The ask is composed exactly as an opening prompt's is, minus the citations
/// and the commits: a session that has been working this arc for hours does
/// not need the document's paths read back to it. What it is owed is the
/// `where` line, whose step coordinates are the one fact that moved, and the
/// resume clause — which is read from `last_stop` rather than `stopped`,
/// because the `arc-resume` line that got us here already cleared `stopped`.
async fn continue_stage(
    ctx: &ArcContext,
    state: &Arc<Mutex<HashMap<String, ArcState>>>,
    arc: &BoundArc,
    key: &str,
    reading: &ArcReading,
    stage: ArcStage,
    steps: Option<(usize, usize)>,
) {
    // The same guard `rotate` and `reverse` take: a tick that raced another
    // one decided over facts that may already have moved, and a second
    // continue of one resume would ask the stage twice.
    let (project, name) = (arc.project.clone(), arc.name.clone());
    let fresh = tokio::task::spawn_blocking(move || read_arc(&project, &name))
        .await
        .ok()
        .flatten();
    if fresh
        .as_ref()
        .is_none_or(|record| record.resume != Some(stage))
    {
        info!(
            target: "dev::session-lifecycle",
            event = "arc.continue_skipped",
            arc = %arc.name,
            stage = stage.as_str(),
            reason = "the resume was already answered",
        );
        return;
    }

    let steps_range = steps.map(|(from, through)| step_range(from, through));
    let Some(ask) = wheel::prompt::stage_ask(
        stage.as_str(),
        reading.record.document.as_deref(),
        &reading.name,
        steps_range.as_deref(),
    ) else {
        // A stage whose ask cannot be composed is one the arc has no words
        // for, and asking half a sentence is worse than saying so. The same
        // stop `rotate` and `deliver_prompt` take ([P10]).
        stop(ctx, arc, stage, ArcStopReason::PromptUnavailable).await;
        return;
    };

    // **The seat first, then the doctor, then the appends** ([P07]). The
    // order is not `rotate`'s and cannot be: this path records the continue
    // and swaps the card back onto the stage's model *before* it seats, and
    // the `arc-continue` line clears `stopped` and `resume` as it goes. So a
    // doctor dropped in where the prompt is composed would let a
    // `RecordsDisagree` stop land on an arc that had already recorded a
    // continue that never happened, on a card already wearing the stage's
    // model. The seat still goes before the doctor, for `rotate`'s own
    // recorded reason: the doctor reads the seat as a record and would
    // otherwise report `seat-missing` against a worktree this path was about
    // to make.
    let Some(seat) = seat_or_stop(ctx, arc, stage).await else {
        return;
    };
    // A continue is always a resume — the guard above refused every reading
    // whose `resume` is not this stage — so the half-walked-step findings are
    // always the interruption being resumed from.
    let Some(verdict) = records_agree_or_stop(ctx, arc, stage, true).await else {
        return;
    };
    if !verdict.open_step.is_empty() {
        // Re-entered, not reset: this is the stage's own session, whose
        // transcript knows what it changed, and `arc step start` accepts a
        // re-entry idempotently. Only a rotated resume is given a `pending`
        // row, because only a rotated one has no way to know.
        info!(
            target: "dev::session-lifecycle",
            event = "arc.open_step_reentered",
            arc = %arc.name,
            stage = stage.as_str(),
            findings = %verdict.open_step.join(", "),
        );
    }
    // A continue over a missing document composes an ask against nothing —
    // the same stop `rotate` takes, at the same point, above every append.
    if reading.record.document.is_none() {
        stop(ctx, arc, stage, ArcStopReason::DocumentMissing).await;
        return;
    }

    let (project, name) = (arc.project.clone(), arc.name.clone());
    let outcome = tokio::task::spawn_blocking({
        let (project, name) = (project.clone(), name.clone());
        move || append_arc_continue(&project, &name, stage)
    })
    .await;
    report_append(&project, &name, "arc-continue", outcome);

    // The stage's model back on the card. A stop hands the card back to the
    // deck's model, so a resume that did not put the stage's model on would
    // hand the work to whatever the user was last talking to.
    let model = stage_model(&reading.config, stage).unwrap_or_else(|| "default".to_string());
    if let Err(refusal) = wheel::send_model(&ctx.supervisor, &arc.session, &model).await {
        warn!(
            arc = %arc.name,
            reason = refusal.reason(),
            "arc could not put the continued stage's model back",
        );
    }

    let place = wheel::prompt::where_clause(&seat, arc.session.as_str(), stage.as_str(), steps);
    let resume = reading
        .record
        .last_stop
        .as_ref()
        .map(|(stage, reason)| (stage.as_str(), reason.as_str()));
    // A continue is always a resume, so the dirty clause is always owed when
    // there is any dirt to name ([P08]).
    let dirty = dirty_clause(worktree_dirt_for(arc).await);
    let text = wheel::prompt::compose(&ask, Some(&place), &[], &[], resume, dirty.as_deref());

    // Dispatched exactly as `deliver_prompt` dispatches: the wheel's own row
    // on CODE_OUTPUT first, then the submission, then Tug's record of what the
    // wheel said. A prompt the reader cannot see the cause of is the
    // unannounced server turn the doctrine forbids.
    let session = arc.session.as_str().to_string();
    ctx.supervisor.code_output.publish_tagged(Frame::new(
        FeedId::CODE_OUTPUT,
        super::base_motion::notice_payload(&session, WHEEL_NOTICE_ORIGIN, &text),
    ));
    ctx.supervisor
        .dispatch_one(Frame::new(
            FeedId::CODE_INPUT,
            super::base_motion::user_message_payload(&session, &text),
        ))
        .await;
    ctx.supervisor
        .sessions_recorder
        .record_wheel_prompt(&session, &text);

    {
        let mut map = state.lock().await;
        let entry = map.entry(key.to_string()).or_default();
        // As `rotate` resets it (Table T01), with one difference: nothing was
        // dispatched, because the stage was already seated.
        entry.in_flight_at = None;
        entry.last_done_count = Some(reading.done_count);
        entry.compacted_since_below = false;
        entry.pending = None;
        entry.quiet_turns = 0;
        // Seeded rather than cleared, as `reverse` seeds them and for the
        // same reason: this session is the stage's own, so the turn that
        // answers the ask just sent is the next one its count moves past.
        entry.prompt_turns_seen = Some(reading.turns_ended);
        entry.all_turns_seen = Some(reading.all_turns_ended);
        entry.tokens_seen = None;
        entry.stop_marks = None;
        entry.quiet_since = None;
        entry.quiet_marks = None;
        entry.last_motion_at = Some(Instant::now());
    }

    info!(
        target: "dev::session-lifecycle",
        event = "arc.continued",
        arc = %arc.name,
        stage = stage.as_str(),
        session = %arc.session,
        model = %model,
    );
}

/// The receipt a reversal leaves: one row saying the arc is running again, and
/// which fact said so (Spec S04).
///
/// The stage is on the header because the block cannot draw its identity strip
/// without one — a receipt is a frozen record of a past moment with no live
/// store to ask, the same reason the stop receipt reads its own terminality off
/// its own frozen sentence.
///
/// It does not replace the stop's row. The stop happened, and a transcript that
/// erased it would be lying about a minute of the arc's life; the superseding
/// pass folds the older row instead, and this one is what supersedes it.
fn format_arc_pickup_receipt(arc: &str, stage: ArcStage, moved: &str) -> String {
    format!(
        "arc picked back up · {arc} · in {} · {moved}",
        stage.as_str()
    )
}

/// The arc's terminal receipt, as one string.
///
/// What it says is the record itself: which stages ran, on which claude
/// sessions, under which models, and which document came out. Nothing more —
/// no `/join` chip, no instruction, no summary of the work. The join offer is
/// what tells the user what to do next ([D147], [D152]); this row is what tells
/// them what happened, and it has to still read correctly on a relaunch weeks
/// later with the arc long gone.
///
/// Pure, so the wording is a table test rather than a live-run observation.
fn format_arc_receipt(record: &ArcRecord) -> String {
    let mut out = format!("arc complete · {}", record.arc);
    if let Some(document) = record.document.as_ref() {
        out.push_str(&format!("\nopened on {document}"));
    }
    for line in &record.stages {
        out.push_str(&format!(
            "\n{} · {} · {}",
            line.stage.as_str(),
            line.model.as_deref().unwrap_or("account default"),
            line.session_id,
        ));
    }
    if let Some(plan) = record.plan.as_ref() {
        out.push_str(&format!("\nplan {plan}"));
    }
    out
}

/// The receipt a stop leaves in the transcript. A stop is not a completion,
/// so it does not read as one — but it happened on this card, and
/// the card is where the user is watching, so it says which stage stopped,
/// why, and — for the two stops that end the arc — that there is nothing to
/// resume.
///
/// The reason is an [`ArcStopReason`] rather than a word, so the sentence is
/// the type's own and there is no arm for a reason nobody wrote a sentence for.
/// A stop the receipt could not explain is a stop the arc must not write.
///
/// **A resumable stop names no command.** It used to close with `resume with
/// tugtool arc run <name>`, which is implementation leaking into a transcript
/// the user reads: the resume is a **Resume** button in this row's own block
/// ([B01]), and the CLI verb stays what it is — the machine's way in. What
/// survives is the terminal sentence, and it survives because it is a *fact*
/// rather than an instruction: it is the one marker of terminality a restored
/// transcript can still read, where no wire frame is available to ask ([B05]).
fn format_arc_stop_receipt(record: &ArcRecord, stage: ArcStage, reason: ArcStopReason) -> String {
    let terminal = if reason.is_resumable() {
        String::new()
    } else {
        "\nthere is nothing to resume".to_string()
    };
    // The two reasons whose sentence is not the whole story. `NeedsDecision` is
    // a stage saying it met a question it had no authority to answer, and
    // `RecordsDisagree` is the runner saying the arc's five records do not
    // agree; a receipt that said only *that* would in either case be a stop
    // nobody could act on — so the payload itself, which the stop's caller
    // wrote as the record's last note immediately before it, is read back
    // beneath it. Absent when the note did not land, which the append warns
    // about; the stop still speaks.
    let asked = match (reason, record.notes.last()) {
        (ArcStopReason::NeedsDecision | ArcStopReason::RecordsDisagree, Some(payload)) => {
            format!("\n{payload}")
        }
        _ => String::new(),
    };
    format!(
        "arc stopped · {} · in {} — {}{terminal}",
        record.arc,
        stage.as_str(),
        format_args!("{}{asked}", reason.sentence()),
    )
}

/// How a stop reaches the card and the record.
///
/// Every caller of the stop path leaves a receipt — that is what makes it the
/// stop path rather than a helper — so the two things a caller genuinely
/// varies are named and nothing else is. No `Default`: a caller states its
/// combination, so a new one cannot inherit a shape nobody chose.
///
/// A closing card is not a caller at all. It has no card left to paint a
/// receipt on and no hand-back to give (`wheel::hand_back` refuses a
/// `Closed` entry by design), so all it does is write its record — see
/// `arc_api::stop_an_on_arc_cards_arc_as_closed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct StopDelivery {
    pub hand_back: HandBack,
    /// Append `arc-stop` to the arc log. An ending writes none: its own
    /// terminal line already closed the arc's generation, and a line after it
    /// would open a phantom one.
    pub record: bool,
}

/// What to do about the model the stage is running on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HandBack {
    /// Restore the deck's model now — the stage is between turns.
    Send,
    /// Arm the restore for the session's next turn end. The stage is mid-turn,
    /// and nothing retires a claude mid-sentence.
    Arm,
}

/// Stop an arc: hand the card back, leave the receipt, record the stop.
///
/// Every stopper comes through here — the predicate's `Stop`, a refused
/// rotation, an ending, a card close, and `tugtool arc stop`. Four call sites
/// that each remembered three of the four acts is how a discard came to tear
/// down a binding while leaving the card on the stage's model with nothing
/// armed.
///
/// The hand-back is issued **first**, so the card the user is handed back is
/// already theirs by the time the terminal line lands. That is issue-order
/// rather than arrival-order and the function claims no more: `hand_back`
/// reaches the card over `input_tx` and the spawn queue while the receipt
/// publishes on `control_tx`, so the two travel different channels and neither
/// caller can pin which lands first.
///
/// It is now true for a further reason on the button's path: `stop_arc_now`
/// waits for the session to read `is_quiet` before it calls this, so the card
/// handed back is one nothing is still speaking on ([P06]). The wheel's own
/// stoppers earn the same thing through the settle.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn stop_arc_for_session(
    supervisor: &AgentSupervisor,
    state: &wheel::WheelState,
    session: &TugSessionId,
    project: &Path,
    name: &str,
    stage: ArcStage,
    reason: ArcStopReason,
    how: StopDelivery,
) {
    match how.hand_back {
        HandBack::Send => {
            if let Err(refusal) = wheel::hand_back(supervisor, session).await {
                warn!(
                    arc = %name,
                    reason = refusal.reason(),
                    "arc could not restore the deck's model",
                );
            }
        }
        HandBack::Arm => state.arm_hand_back(session.as_str()),
    }

    {
        let summary = if reason.is_resumable() {
            // The record supplies the arc name the receipt reads back. A stop
            // with no record left to read is still worth saying, so a missing
            // one falls back to a record naming only this arc and stage.
            let record = read_arc(project, name).unwrap_or_else(|| ArcRecord {
                arc: name.to_owned(),
                document: None,
                kind: None,
                plan: None,
                stages: Vec::new(),
                notes: Vec::new(),
                stopped: None,
                last_stop: None,
                stopping: None,
                resume: None,
                dispatched: None,
                owner: None,
                done: false,
                last_activity: None,
            });
            format_arc_stop_receipt(&record, stage, reason)
        } else {
            // The two endings are the reasons whose stop has not happened yet:
            // the arc is gone, but the stage is mid-turn and is retired at
            // that turn's end. So the receipt announces the retirement rather
            // than reporting a stop, and names the model the card comes back
            // to.
            let model = supervisor
                .deck_model_for(session.as_str())
                .await
                .unwrap_or_else(|| "the account default".to_string());
            format!(
                "arc {} · {name} · the stage's turn will end and the card returns to {model}",
                reason.as_str(),
            )
        };
        supervisor.record_arc_receipt(session.as_str(), name, &project.to_string_lossy(), &summary);
    }

    if how.record {
        let project = project.to_path_buf();
        let name = name.to_owned();
        let outcome = tokio::task::spawn_blocking({
            let (project, name) = (project.clone(), name.clone());
            move || append_arc_stop(&project, &name, stage, reason)
        })
        .await;
        report_append(&project, &name, "arc-stop", outcome);
    }
}

async fn finish(
    ctx: &ArcContext,
    state: &Arc<Mutex<HashMap<String, ArcState>>>,
    arc: &BoundArc,
    key: &str,
    reading: &ArcReading,
    stopped: Option<(ArcStage, ArcStopReason)>,
) {
    if let Some((stage, reason)) = stopped {
        stop_arc_for_session(
            &ctx.supervisor,
            &ctx.wheel,
            &arc.session,
            &arc.project,
            &arc.name,
            stage,
            reason,
            StopDelivery {
                // **The hand-back is sent, and that is safe because the stop
                // is settled** ([B08], [P09]). A `model_change` arriving
                // mid-turn swaps the model under a stage that is working — the
                // incident's stop did exactly that — and what keeps it from
                // happening is not this line but the settle above: a stop is
                // decided only on an idle reading that was still idle a settle
                // later, so the card this reaches is genuinely between turns.
                // `a_stop_decided_before_the_settle_sends_no_model_change` is
                // the pin.
                hand_back: HandBack::Send,
                record: true,
            },
        )
        .await;
        // The eviction, through the same helper the user stop takes ([P11]).
        evict_for_stop(
            state,
            key,
            Some(StopMarks {
                wake_turns_ended: reading.wake_turns_ended,
                done_count: reading.done_count,
            }),
        )
        .await;
        return;
    }
    // The done ending keeps its own body, receipt before hand-back. Only the
    // stop path was reordered; the completion's ordering is left as it is
    // rather than changed by a step that was not about it.
    let summary = format_arc_receipt(&reading.record);
    ctx.supervisor.record_arc_receipt(
        arc.session.as_str(),
        &arc.name,
        &arc.project.to_string_lossy(),
        &summary,
    );
    if let Err(refusal) = wheel::hand_back(&ctx.supervisor, &arc.session).await {
        warn!(
            arc = %arc.name,
            reason = refusal.reason(),
            "arc could not restore the deck's model",
        );
    }
    let project = arc.project.clone();
    let name = arc.name.clone();
    let outcome = tokio::task::spawn_blocking({
        let (project, name) = (project.clone(), name.clone());
        move || append_arc_done(&project, &name)
    })
    .await;
    report_append(&project, &name, "arc-done", outcome);
    // A finished arc keeps no memory at all. Nothing but the unseated clock's
    // own sweep ever removed an entry, so a completed arc's `last_motion_at`
    // and quiet count outlived it in the map for as long as tugcast ran. There
    // is no stop to leave marks for here — the arc is done, not resumable —
    // so the entry goes and nothing replaces it.
    state.lock().await.remove(key);
}

/// Record a stop and hand the card back, for a refusal discovered mid-rotation.
///
/// A refused rotation left no receipt before this went through the shared
/// path; now it leaves one, which is the whole reason the path is shared.
async fn stop(ctx: &ArcContext, arc: &BoundArc, stage: ArcStage, reason: ArcStopReason) {
    stop_arc_for_session(
        &ctx.supervisor,
        &ctx.wheel,
        &arc.session,
        &arc.project,
        &arc.name,
        stage,
        reason,
        StopDelivery {
            hand_back: HandBack::Send,
            record: true,
        },
    )
    .await;
}

/// Say out loud when an arc's terminal line did not land.
///
/// `arc-stop` and `arc-done` are the two appends that *are* the record: every
/// later reader — the card's placard, the Z2 cell, `arc doctor`, a resume —
/// learns the arc ended from the line and from nothing else. A discarded
/// failure here leaves an arc that has stopped in the world and is still
/// running on disk, and leaves nobody anything to search for. The path is
/// named because the fix is nearly always about the file: a read-only state
/// dir, a full disk, a project moved out from under a bound session.
///
/// Warn rather than error, and never a refusal: the card already carries the
/// receipt, the hand-back has already gone, and there is nothing left for this
/// to fail.
fn report_append(
    project: &Path,
    name: &str,
    marker: &str,
    outcome: Result<Result<(), tugtool_core::error::TugError>, tokio::task::JoinError>,
) {
    let reason = match outcome {
        Ok(Ok(())) => return,
        Ok(Err(error)) => error.to_string(),
        Err(join) => format!("the append task did not finish: {join}"),
    };
    warn!(
        arc = %name,
        marker = %marker,
        path = %tugtool_core::paths::arc_log_path(project).display(),
        reason = %reason,
        "arc could not record its terminal line",
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    /// A plan that parses and lints clean — the fact `lints_as_plan` reads.
    /// Local rather than a repository document: a plan under `arc/` is
    /// archived the day its arc joins, and a test pinned to one goes with it.
    const LINTING_PLAN: &str = r#"## A Two Step Plan {#two-step-plan}

### Plan Metadata {#plan-metadata}

| Field | Value |
|---|---|
| Owner | Someone |

### Phase Overview {#phase-overview}

Some context.

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The first step | pending | — |
| #step-2 | The second step | pending | — |

#### Step 1: The first step {#step-1}

**Commit:** `thing(scope): first`

**References:** [P01] the decision, (#phase-overview)

**Tasks:**
- [ ] Do the first thing.

**Tests:**
- [ ] Unit: the first thing works.

**Checkpoint:**
- [ ] `cargo nextest run`

#### Step 2: The second step {#step-2}

**Commit:** `thing(scope): second`

**References:** [P01] the decision, (#phase-overview)

**Tasks:**
- [ ] Do the second thing.

**Tests:**
- [ ] Unit: the second thing works.

**Checkpoint:**
- [ ] `cargo nextest run`

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** the thing.
"#;

    fn snapshot(live: bool, idle: bool, claude: Option<&str>) -> SessionSnapshot {
        SessionSnapshot {
            live,
            idle,
            // The seated session has run; the never-run case builds its own.
            turn_ended: true,
            turns_ended: 1,
            prompt_turns_ended: 1,
            wake_turns_ended: 0,
            turn_active: false,
            turn_opener: None,
            open_jobs: 0,
            api_error: false,
            turn_cancelled: false,
            // A seated stage is the ordinary case; the taken-card tests build
            // their own.
            stage_seated: true,
            claude_session_id: claude.map(str::to_string),
            context_window: None,
        }
    }

    /// A project whose arc has a brief at its own address, which is where
    /// every document lives now.
    fn project_with_document(root: &Path, document: &str) {
        let path = root.join(document);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "# A brief\n\nSome prose.\n").unwrap();
        std::fs::create_dir_all(root.join(".tugtool")).unwrap();
        // The settle off by default, so a test that means "one sweep decides"
        // still means it. The settle's own tests declare a real one; every
        // other writer below repeats the line because it *overwrites* this
        // file rather than adding to it.
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nidle_settle_secs = 0\n",
        )
        .unwrap();
    }

    #[test]
    fn an_opened_arc_reads_its_document_and_wants_devise() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();

        let reading = read(
            root,
            "demo",
            &snapshot(true, true, None),
            TickMemory::default(),
        )
        .unwrap();
        assert!(reading.facts.document_exists);
        assert!(!reading.facts.input_is_plan);
        assert_eq!(
            arc_action(&reading.record, &reading.facts),
            Some(ArcAction::Rotate(Rotation {
                stage: ArcStage::Devise,
                steps: None,
                note: None,
            }))
        );
    }

    #[test]
    fn a_stage_whose_session_is_not_the_one_running_is_rotated_again() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "gone", None).unwrap();

        let reading = read(
            root,
            "demo",
            &snapshot(true, true, Some("fresh")),
            TickMemory::default(),
        )
        .unwrap();
        assert!(!reading.facts.stage_session_current);
        assert_eq!(
            arc_action(&reading.record, &reading.facts),
            Some(ArcAction::Rotate(Rotation {
                stage: ArcStage::Devise,
                steps: None,
                note: None,
            }))
        );
    }

    #[test]
    fn a_stage_still_running_its_own_session_is_not_re_rotated() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "live", None).unwrap();

        let reading = read(
            root,
            "demo",
            &snapshot(true, true, Some("live")),
            TickMemory::default(),
        )
        .unwrap();
        assert!(reading.facts.stage_session_current);
        // No plan on disk, so the devise stage stops on lint rather than
        // re-rotating — which is the point: the *stage* arm decided, not the
        // liveness arm.
        assert_eq!(
            arc_action(&reading.record, &reading.facts),
            Some(ArcAction::Stop {
                stage: ArcStage::Devise,
                reason: ArcStopReason::Lint,
            })
        );
    }

    #[test]
    fn a_seated_stage_that_has_ended_no_turn_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "live", None).unwrap();

        // Idle, current, no plan on disk — the reading a tick takes in the gap
        // between the stage's spawn and its first frame. The same facts with a
        // turn behind them stop on lint (the test above); with none, the
        // stage has not run and nothing may be decided about its documents.
        let mut session = snapshot(true, true, Some("live"));
        session.turn_ended = false;
        session.turns_ended = 0;
        session.prompt_turns_ended = 0;
        let reading = read(root, "demo", &session, TickMemory::default()).unwrap();
        assert!(reading.facts.stage_session_current);
        assert!(!reading.facts.stage_turn_ended);
        assert_eq!(arc_action(&reading.record, &reading.facts), None);
    }

    #[tokio::test]
    async fn a_tick_before_a_stage_has_ended_a_turn_stops_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        asked(&entry, 0).await;
        let state = Arc::new(Mutex::new(HashMap::new()));

        sweep(&ctx, &state).await;
        assert_eq!(entry.lock().await.queue.len(), 0, "no rotation");
        let record = tugarc_core::read_arc(root, "demo").unwrap();
        assert_eq!(
            record.stopped, None,
            "and no stop written for a plan the stage has not begun"
        );
    }

    /// **The same tick, with a wake behind it instead of an ask.** A stage
    /// whose only ended turn was opened by the harness has still not been
    /// asked anything, so its documents are still not the arc's to judge —
    /// `stage_turn_ended` reads the prompt count and nothing else ([P02]).
    ///
    /// The counts here are the incident's shape at its smallest: the ledger
    /// has ended a turn, and no answer was ever given.
    #[tokio::test]
    async fn stage_turn_ended_reads_asked_turns_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        // No plan on disk: a stage that had ended an *asked* turn here would
        // stop on lint, which is what makes this assertion mean something.
        asked(&entry, 0).await;
        woke(&entry).await;
        let state = Arc::new(Mutex::new(HashMap::new()));

        sweep(&ctx, &state).await;
        assert_eq!(
            tugarc_core::read_arc(root, "demo").unwrap().stopped,
            None,
            "a wake is not the stage answering, so nothing is judged about its plan",
        );
    }

    #[test]
    fn a_document_that_already_lints_as_a_plan_skips_devise() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".tug/arcs/demo")).unwrap();
        std::fs::write(root.join(".tug/arcs/demo/plan.md"), LINTING_PLAN).unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/plan.md").unwrap();

        let reading = read(
            root,
            "demo",
            &snapshot(true, true, None),
            TickMemory::default(),
        )
        .unwrap();
        assert!(reading.facts.input_is_plan);
        // The document is the plan, and every stage after devise names the
        // arc rather than a path.
        assert_eq!(reading.plan_for_prompt.as_deref(), Some("demo"));
        let review = Rotation {
            stage: ArcStage::Review,
            steps: None,
            note: None,
        };
        let prompt = opening_prompt(
            &reading,
            &review,
            &bound(root, "demo"),
            &tugarc_core::ops::worktree_path(root, "demo"),
            None,
        )
        .expect("a prompt");
        assert_eq!(
            prompt.lines().next(),
            Some("/tugplug:arc-review demo"),
            "{prompt}"
        );
        assert_eq!(
            arc_action(&reading.record, &reading.facts),
            Some(ArcAction::Rotate(Rotation {
                stage: ArcStage::Review,
                steps: None,
                note: None,
            }))
        );
    }

    #[test]
    fn a_dead_card_stops_the_arc() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Review, "s", None).unwrap();

        let reading = read(
            root,
            "demo",
            &snapshot(false, true, Some("s")),
            TickMemory::default(),
        )
        .unwrap();
        assert_eq!(
            arc_action(&reading.record, &reading.facts),
            Some(ArcAction::Stop {
                stage: ArcStage::Review,
                reason: ArcStopReason::SessionGone,
            })
        );
    }

    #[test]
    fn a_mid_turn_card_yields_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "s", None).unwrap();

        let reading = read(
            root,
            "demo",
            &snapshot(true, false, Some("s")),
            TickMemory::default(),
        )
        .unwrap();
        assert_eq!(arc_action(&reading.record, &reading.facts), None);
    }

    #[test]
    fn a_stopped_arc_is_not_resumed_by_a_tick() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "s", None).unwrap();
        tugarc_core::arc::append_arc_stop(root, "demo", ArcStage::Devise, ArcStopReason::Lint)
            .unwrap();

        let reading = read(
            root,
            "demo",
            &snapshot(true, true, Some("s")),
            TickMemory::default(),
        )
        .unwrap();
        assert_eq!(arc_action(&reading.record, &reading.facts), None);
    }

    #[test]
    fn the_devise_ask_names_the_brief_and_targets_the_arc() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();

        let reading = read(
            root,
            "demo",
            &snapshot(true, true, None),
            TickMemory::default(),
        )
        .unwrap();
        let prompt = opening_prompt(
            &reading,
            &Rotation {
                stage: ArcStage::Devise,
                steps: None,
                note: None,
            },
            &bound(root, "demo"),
            &tugarc_core::ops::worktree_path(root, "demo"),
            None,
        )
        .unwrap();
        assert!(
            prompt.starts_with(
            "/tugplug:arc-devise a plan for .tug/arcs/demo/brief.md, honoring every [B##] decision it records 🢂 demo"
            ),
            "{prompt}"
        );
    }

    /// Every stage after devise names the arc, so the skill resolves the
    /// address rather than being handed one it could write past.
    #[test]
    fn review_and_implement_asks_name_the_arc() {
        assert_eq!(
            wheel::prompt::stage_ask("review", None, "foo", None).as_deref(),
            Some("/tugplug:arc-review foo")
        );
        assert_eq!(
            wheel::prompt::stage_ask("implement", None, "foo", Some("2-4")).as_deref(),
            Some(
                "/tugplug:arc-implement foo implement Step 2 and end the turn; Steps 2-4 remain on this arc"
            )
        );
        assert_eq!(
            wheel::prompt::stage_ask("implement", None, "foo", None).as_deref(),
            Some("/tugplug:arc-implement foo implement one step and end the turn")
        );
    }

    /// The document has no last commit to key on — it is not tracked — so the
    /// "what changed" clause is anchored on when the author wrote it.
    #[test]
    fn what_changed_is_keyed_on_the_documents_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".tug/arcs/demo")).unwrap();
        std::fs::create_dir_all(root.join(".tugtool")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.name", "Test User"],
            vec!["config", "user.email", "test@example.com"],
        ] {
            tugcore::git_command()
                .arg("-C")
                .arg(root)
                .args(&args)
                .output()
                .unwrap();
        }
        std::fs::write(root.join("src/a.rs"), "fn a() {}\n").unwrap();
        let brief = root.join(".tug/arcs/demo/brief.md");
        std::fs::write(&brief, "# A brief\n\n[F01] `src/a.rs` holds it.\n").unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();

        let commit = |message: &str| {
            tugcore::git_command()
                .arg("-C")
                .arg(root)
                .args(["add", "-A"])
                .output()
                .unwrap();
            tugcore::git_command()
                .arg("-C")
                .arg(root)
                .args(["commit", "-m", message])
                .output()
                .unwrap();
        };

        // Written an hour ago, so the change that lands now is after it.
        std::fs::File::options()
            .write(true)
            .open(&brief)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(3600))
            .unwrap();
        std::fs::write(root.join("src/a.rs"), "fn a() { todo!() }\n").unwrap();
        commit("change the cited file");

        let reading = read(
            root,
            "demo",
            &snapshot(true, true, None),
            TickMemory::default(),
        )
        .unwrap();
        assert_eq!(
            reading.commits_since.len(),
            1,
            "{:?}",
            reading.commits_since
        );
        assert!(reading.commits_since[0].contains("change the cited file"));

        // A brief rewritten after that commit landed has nothing behind it.
        // Two seconds rather than none, because git commit timestamps have
        // one-second granularity and `--since` on the same second still hits.
        std::fs::File::options()
            .write(true)
            .open(&brief)
            .unwrap()
            .set_modified(SystemTime::now() + Duration::from_secs(2))
            .unwrap();
        let reading = read(
            root,
            "demo",
            &snapshot(true, true, None),
            TickMemory::default(),
        )
        .unwrap();
        assert!(
            reading.commits_since.is_empty(),
            "{:?}",
            reading.commits_since
        );
    }

    /// A stage opens on a part, not a title. The document names where
    /// to start, so the stage that opens on it is handed those paths — the
    /// clause the prompt gained over the bare ask.
    #[test]
    fn a_devise_prompt_names_the_files_its_document_cites() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".tug/arcs/demo")).unwrap();
        std::fs::create_dir_all(root.join(".tugtool")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.rs"), "fn a() {}\n").unwrap();
        std::fs::write(root.join("src/b.ts"), "export const b = 1;\n").unwrap();
        std::fs::write(
            root.join(".tug/arcs/demo/brief.md"),
            "# A brief\n\n[F01] `src/a.rs` holds it, `src/b.ts` reads it, `src/gone.rs` does not exist.\n",
        )
        .unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();

        let reading = read(
            root,
            "demo",
            &snapshot(true, true, None),
            TickMemory::default(),
        )
        .unwrap();
        assert_eq!(
            reading.cited_paths,
            vec!["src/a.rs".to_string(), "src/b.ts".to_string()]
        );
        let prompt = opening_prompt(
            &reading,
            &Rotation {
                stage: ArcStage::Devise,
                steps: None,
                note: None,
            },
            &bound(root, "demo"),
            &tugarc_core::ops::worktree_path(root, "demo"),
            None,
        )
        .unwrap();
        assert!(prompt.starts_with("/tugplug:arc-devise a plan for .tug/arcs/demo/brief.md"));
        assert!(prompt.contains("citations: src/a.rs, src/b.ts"));
        assert!(
            !prompt.contains("src/gone.rs"),
            "a backticked token that is not a file on disk is prose"
        );
        // No git repo here at all, so there is nothing git could say moved.
        assert!(!prompt.contains("what changed"));
    }

    #[test]
    fn a_continued_implement_prompt_carries_its_step_range() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        std::fs::write(root.join(".tug/arcs/demo/plan.md"), LINTING_PLAN).unwrap();

        let reading = read(
            root,
            "demo",
            &snapshot(true, true, None),
            TickMemory::default(),
        )
        .unwrap();
        let prompt = opening_prompt(
            &reading,
            &Rotation {
                stage: ArcStage::Implement,
                steps: Some((4, 9)),
                note: None,
            },
            &bound(root, "demo"),
            &tugarc_core::ops::worktree_path(root, "demo"),
            None,
        )
        .unwrap();
        assert!(
            prompt.starts_with(
                "/tugplug:arc-implement demo implement Step 4 and end the turn; Steps 4-9 remain on this arc"
            ),
            "{prompt}"
        );
        // The step in hand is the range's first, and the run's declared end
        // rides with it — the two coordinates a rotated-in session would
        // otherwise have to read the ledger to learn.
        assert!(
            prompt.contains("· stage implement · Step 4 in hand, through 9"),
            "{prompt}"
        );
    }

    #[test]
    fn a_first_implement_prompt_carries_no_selector() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        std::fs::write(root.join(".tug/arcs/demo/plan.md"), LINTING_PLAN).unwrap();

        let reading = read(
            root,
            "demo",
            &snapshot(true, true, None),
            TickMemory::default(),
        )
        .unwrap();
        let prompt = opening_prompt(
            &reading,
            &Rotation {
                stage: ArcStage::Implement,
                steps: None,
                note: None,
            },
            &bound(root, "demo"),
            &tugarc_core::ops::worktree_path(root, "demo"),
            None,
        )
        .unwrap();
        assert!(
            prompt.starts_with("/tugplug:arc-implement demo implement one step and end the turn"),
            "{prompt}"
        );
    }

    /// The seat a prompt is composed for. The `where` clause names a worktree,
    /// a session and a stage, so composing one needs the arc the tick is
    /// working — the tests' arcs are all `demo` on a temp root.
    fn bound(root: &Path, name: &str) -> BoundArc {
        BoundArc {
            project: root.to_path_buf(),
            name: name.to_string(),
            session: TugSessionId::new("claude-1".to_string()),
        }
    }

    /// [`LINTING_PLAN`] with its two ledger rows driven to `first` / `second`.
    ///
    /// A `done` row gets a commit cell with it. The two move together
    /// everywhere a real ledger is written — `arc step done` writes both — and
    /// a fixture that moved only the status would be handing the dispatch's
    /// doctor a disagreement the test is not about.
    fn plan_with_statuses(first: &str, second: &str) -> String {
        let cell = |status: &str| {
            if status == "done" { "`abc1234`" } else { "—" }
        };
        LINTING_PLAN
            .replace(
                "| #step-1 | The first step | pending | — |",
                &format!("| #step-1 | The first step | {first} | {} |", cell(first)),
            )
            .replace(
                "| #step-2 | The second step | pending | — |",
                &format!(
                    "| #step-2 | The second step | {second} | {} |",
                    cell(second)
                ),
            )
    }

    /// A withdrawn row is closed — so it counts, and a rotation steps over it
    /// rather than resuming at a step nobody intends to walk.
    #[test]
    fn a_withdrawn_row_counts_as_closed_and_is_never_the_resume_point() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();

        std::fs::write(
            root.join(".tug/arcs/demo/plan.md"),
            plan_with_statuses("withdrawn", "pending"),
        )
        .unwrap();
        let reading = read(
            root,
            "demo",
            &snapshot(true, true, None),
            TickMemory::default(),
        )
        .unwrap();
        assert_eq!(reading.done_count, 1, "the withdrawn row is closed");
        assert_eq!(
            reading.facts.ledger.first_pending,
            Some(2),
            "the resume point steps over the withdrawal"
        );

        std::fs::write(
            root.join(".tug/arcs/demo/plan.md"),
            plan_with_statuses("done", "withdrawn"),
        )
        .unwrap();
        let reading = read(
            root,
            "demo",
            &snapshot(true, true, None),
            TickMemory::default(),
        )
        .unwrap();
        assert_eq!(reading.done_count, 2);
        assert_eq!(
            reading.facts.ledger.first_pending, None,
            "every row is closed, so there is nothing to resume at"
        );
    }

    /// A real supervisor with one session parked in `Spawning`, a real
    /// in-memory session ledger with that session bound to `demo`, and a real
    /// project on disk holding the arc record. Every frame a rotation sends
    /// lands in the session's spawn queue, which is what the assertions count.
    type Harness = (
        ArcContext,
        Arc<Mutex<super::super::agent_supervisor::LedgerEntry>>,
        mpsc::Receiver<super::super::agent_supervisor::MergerRegistration>,
    );

    async fn harness(root: &Path) -> Harness {
        use super::super::agent_bridge::{CrashBudget, SessionMode};
        use super::super::agent_supervisor::LedgerEntry;
        use super::super::workspace_registry::WorkspaceKey;
        use std::time::Duration;

        let ledger = Arc::new(SessionLedger::open_in_memory().unwrap());
        ledger
            .record_spawn(
                "claude-1",
                "ws-test",
                &root.to_string_lossy(),
                "card-1",
                1_000,
                "claude-1",
                None,
            )
            .unwrap();
        ledger
            .set_arc_binding("claude-1", Some(("tugarc/demo#1", "demo")))
            .unwrap();

        // The registration receiver is handed back so each test can hold it:
        // dropping it would close the channel under a supervisor that is still
        // alive, which is not the state any of these tests is about.
        // The supervisor records into the very ledger this harness holds, so a
        // test can read back what the arc wrote down.
        let (supervisor, register_rx) =
            super::super::agent_supervisor::test_minimal_supervisor_with_recorder(Arc::new(
                super::super::agent_supervisor::LedgerSessionsRecorder::new(Arc::clone(&ledger)),
            ));
        let id = TugSessionId::new("claude-1".to_string());
        let mut entry = LedgerEntry::new(
            id.clone(),
            WorkspaceKey::from_test_str("ws-test"),
            root.to_path_buf(),
            SessionMode::New,
            CrashBudget::new(3, Duration::from_secs(60)),
        );
        entry.claude_session_id = Some("claude-1".to_string());
        entry.spawn_state = SpawnState::Spawning;
        // The seated session has run: a stage that has ended no turn is
        // left alone, and that case has its own test.
        entry.turns_ended = 1;
        entry.prompt_turns_ended = 1;
        let entry = Arc::new(Mutex::new(entry));
        supervisor.ledger.lock().await.insert(id, entry.clone());

        (
            ArcContext {
                supervisor,
                session_ledger: ledger,
                wheel: Arc::new(wheel::WheelState::default()),
                cancel: CancellationToken::new(),
                // Dead by default: the harness's arcs are this runner's, and
                // the two tests that need a live foreign owner say so by
                // overriding the field.
                live_owner: |_| false,
                // The harness drives `sweep` directly and ages the clock
                // through `quiet_since`, so there is nothing to arm.
                settle: None,
            },
            entry,
            register_rx,
        )
    }

    #[tokio::test]
    async fn two_ticks_for_one_arc_produce_one_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nidle_settle_secs = 0\ndocs = \"arc\"\n",
        )
        .unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        let state = Arc::new(Mutex::new(HashMap::new()));

        sweep(&ctx, &state).await;
        let after_first = entry.lock().await.queue.len();
        sweep(&ctx, &state).await;
        let after_second = entry.lock().await.queue.len();

        // Devise declares no model, so a rotation is two frames — the fresh
        // session and its opening prompt.
        assert_eq!(after_first, 2, "one rotation");
        assert_eq!(
            after_second, 2,
            "the second tick must not rotate again while the first rotation's \
             arc-stage line has not landed"
        );
    }

    #[tokio::test]
    async fn a_tick_during_an_open_turn_produces_no_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        entry.lock().await.turn_active = true;
        let state = Arc::new(Mutex::new(HashMap::new()));

        sweep(&ctx, &state).await;
        assert_eq!(entry.lock().await.queue.len(), 0);
    }

    /// The dispatch reads the arc's five records before it hands a stage its
    /// coordinates.
    ///
    /// A `where` clause built over a disagreement is worse than no clause at
    /// all: the stage believes a frontier the surfaces do not share, closes a
    /// step the log will not credit, and the arc finishes somewhere nobody can
    /// follow. So the doctor's comparison runs at the dispatch, and its named
    /// finding becomes the stop.
    #[tokio::test]
    async fn records_that_disagree_stop_the_arc_instead_of_seating_a_stage() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        // The table reads step 1 open and the arc log never declared it —
        // the crash-between-the-two-writes shape `arc doctor` names.
        std::fs::write(
            root.join(".tug/arcs/demo/plan.md"),
            plan_with_statuses("in progress", "pending"),
        )
        .unwrap();

        let (ctx, _entry, _register_rx) = harness(root).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        sweep(&ctx, &state).await;

        let record = tugarc_core::read_arc(root, "demo").expect("the arc record");
        assert!(
            record.stages.is_empty() && record.dispatched.is_none(),
            "no stage is seated over records that disagree"
        );
        let (_, reason) = record.stopped.expect("a stop");
        assert_eq!(reason, ArcStopReason::RecordsDisagree.as_str());
        // The doctor's own sentence rides as the note, which is what the stop
        // receipt reads back beneath its one-line reason.
        assert!(
            record
                .notes
                .last()
                .is_some_and(|note| note.contains("never declared it opened")),
            "{:?}",
            record.notes
        );
    }

    /// The sweep finds the card behind a segment a rotation moved the binding
    /// onto — which is the difference between an arc that decides and one that
    /// never sees a fact again.
    ///
    /// The ledger's answer to "which session is on this arc" is the segment
    /// `seat_line_binding` seated. The supervisor's map is keyed by the card's
    /// tug session id. Before the first rotation those are one string, which is
    /// why every test above this one passed while a real run went factless the
    /// moment its opening stage was seated (`at0505`).
    #[tokio::test]
    async fn a_rotated_binding_still_finds_the_card_the_arc_runs_on() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        // The rotation: a fresh segment on the card's line, recorded under
        // claude's own id, with the arc binding moved onto it — and the card
        // still addressed as `claude-1`, because a card's address never moves.
        ctx.session_ledger
            .record_spawn(
                "stage-2",
                "ws-test",
                &root.to_string_lossy(),
                "card-1",
                2_000,
                "claude-1",
                None,
            )
            .unwrap();
        ctx.session_ledger
            .set_arc_binding("claude-1", None)
            .unwrap();
        ctx.session_ledger
            .set_arc_binding("stage-2", Some(("tugarc/demo#1", "demo")))
            .unwrap();
        entry.lock().await.claude_session_id = Some("stage-2".to_string());

        let arcs = bound_arcs(&ctx).await;
        assert_eq!(arcs.len(), 1, "the arc is bound to exactly one card");
        assert_eq!(
            arcs[0].session.as_str(),
            "claude-1",
            "the sweep hands on the card's address, not the segment the row wears",
        );
    }

    /// A stage whose child died and was never replaced stops as `session gone`.
    ///
    /// The wedge `at0505` drove and W6 could not: `spawn_state` is the bridge's
    /// own account of itself, and a bridge retrying a crashed child goes on
    /// saying `Live`. Killed for real, tugcast held no child for the card,
    /// nothing replaced it, and the entry read `Live` indefinitely — a live
    /// session producing nothing, which the predicate has no arm for and the
    /// clock would only catch at the stall deadline half an hour later.
    ///
    /// The absence is the fact, and [`CHILD_GONE_GRACE`] is what keeps an
    /// ordinary one-second retry from being read as a death.
    #[tokio::test]
    async fn a_child_gone_past_the_grace_stops_the_arc_as_session_gone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        {
            let mut e = entry.lock().await;
            e.spawn_state = SpawnState::Live;
            e.child_pid = None;
            e.child_gone_at = Some(Instant::now() - CHILD_GONE_GRACE - Duration::from_secs(1));
        }
        let state = Arc::new(Mutex::new(HashMap::new()));

        sweep(&ctx, &state).await;
        let record = read_arc(root, "demo").unwrap();
        assert_eq!(
            record
                .stopped
                .as_ref()
                .map(|(stage, reason)| (*stage, reason.as_str())),
            Some((ArcStage::Devise, ArcStopReason::SessionGone.as_str())),
            "a card with no child is not live, whatever the bridge believes",
        );
    }

    /// The same absence, inside the grace, is the retry it usually is.
    #[tokio::test]
    async fn a_child_gone_within_the_grace_is_a_respawn_not_a_death() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        {
            let mut e = entry.lock().await;
            e.spawn_state = SpawnState::Live;
            e.child_pid = None;
            e.child_gone_at = Some(Instant::now());
        }
        // The wheel seated this session, so the stage reads as current — else
        // the arc stops as a taken card and this test would pass for the wrong
        // reason (or, as it first did, fail for one).
        ctx.session_ledger
            .set_stage_provenance("claude-1", "devise", None)
            .unwrap();
        let state = Arc::new(Mutex::new(HashMap::new()));

        sweep(&ctx, &state).await;
        // Not "no stop": a seated devise stage that ends a turn having written
        // no plan is judged on its own product, and that judgement is another
        // test's subject. The claim here is narrower and is the whole of what
        // the grace is for — whatever the arc decides, it does not decide the
        // session is *gone*, because a gap of a second is a respawn in flight.
        let stopped = read_arc(root, "demo").unwrap().stopped;
        assert_ne!(
            stopped.as_ref().map(|(_, reason)| reason.as_str()),
            Some(ArcStopReason::SessionGone.as_str()),
            "a crash-retry closes the gap in about a second and must not read as a death",
        );
    }

    /// The two `Idle`s, told apart.
    ///
    /// An entry rebound from tugbank that no deck has spawned yet is a wait —
    /// judging it would stop every in-flight arc on every relaunch, which is
    /// what `at0503`'s first case asserts. An entry *this process* watched
    /// reach `Live` and then found back at `Idle` has lost its child.
    #[tokio::test]
    async fn an_idle_this_process_never_ran_waits_and_one_it_did_is_gone() {
        for (ever_live_here, expect_stop) in [(false, false), (true, true)] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            project_with_document(root, ".tug/arcs/demo/brief.md");
            tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
            tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
                .unwrap();

            let (ctx, entry, _register_rx) = harness(root).await;
            {
                let mut e = entry.lock().await;
                e.spawn_state = SpawnState::Idle;
                e.ever_live_here = ever_live_here;
            }
            let state = Arc::new(Mutex::new(HashMap::new()));

            sweep(&ctx, &state).await;
            assert_eq!(
                read_arc(root, "demo").unwrap().stopped.is_some(),
                expect_stop,
                "ever_live_here = {ever_live_here}",
            );
        }
    }

    /// An arc whose session yields no snapshot at all is clocked, not dropped.
    ///
    /// The floor under every shape the machine cannot classify: `evaluate`
    /// returned early on `None`, so no facts reached the predicate and — since
    /// W6's clock is driven by facts — nothing counted the silence either. The
    /// wait stays a wait, and a bounded one.
    #[tokio::test]
    async fn an_arc_with_no_snapshot_is_clocked_and_eventually_stops_as_stalled() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nidle_settle_secs = 0\narc_stall_secs = 1\n",
        )
        .unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();

        let (ctx, _entry, _register_rx) = harness(root).await;
        // The entry the sweep would read, removed: `session_snapshot` answers
        // `None`, which is the shape this covers.
        ctx.supervisor
            .ledger
            .lock()
            .await
            .remove(&TugSessionId::new("claude-1".to_string()));
        let state = Arc::new(Mutex::new(HashMap::new()));

        // The first tick seeds the stamp and decides nothing: silence tugcast
        // did not watch is not silence it may hold against a stage.
        sweep(&ctx, &state).await;
        assert!(
            read_arc(root, "demo").unwrap().stopped.is_none(),
            "the seed decides nothing"
        );

        // Age the stamp past the deadline rather than sleeping through it.
        {
            let mut map = state.lock().await;
            for entry in map.values_mut() {
                entry.last_motion_at = Some(Instant::now() - Duration::from_secs(5));
            }
        }
        sweep(&ctx, &state).await;
        let record = read_arc(root, "demo").unwrap();
        assert_eq!(
            record
                .stopped
                .as_ref()
                .map(|(stage, reason)| (*stage, reason.as_str())),
            Some((ArcStage::Devise, ArcStopReason::Stalled.as_str())),
            "a factless arc degrades to late, never to forever",
        );
    }

    /// **A stopping arc is not clocked by the unseated sweep** ([B05]). The
    /// `arc_action` pin cannot catch this: the unseated path never calls it.
    /// It reads the record and stops directly, so the mark has to be read
    /// here too, or a stop in flight is stopped a second time as `Stalled`.
    #[tokio::test]
    async fn a_stopping_arc_is_not_clocked_by_the_unseated_sweep() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nidle_settle_secs = 0\narc_stall_secs = 1\n",
        )
        .unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();
        tugarc_core::arc::append_arc_stopping(root, "demo", ArcStage::Devise).unwrap();

        let (ctx, _entry, _register_rx) = harness(root).await;
        ctx.supervisor
            .ledger
            .lock()
            .await
            .remove(&TugSessionId::new("claude-1".to_string()));
        let state = Arc::new(Mutex::new(HashMap::new()));
        // A clock already past the deadline, so the only thing between this
        // sweep and a `Stalled` stop is the mark.
        state.lock().await.insert(
            demo_key(root),
            ArcState {
                last_motion_at: Some(Instant::now() - Duration::from_secs(5)),
                ..Default::default()
            },
        );

        let stops_before = arc_stop_lines(root);
        sweep(&ctx, &state).await;
        sweep(&ctx, &state).await;

        assert_eq!(arc_stop_lines(root), stops_before, "no `arc-stop` line");
        let record = read_arc(root, "demo").unwrap();
        assert!(record.stopped.is_none());
        assert_eq!(
            record.stopping,
            Some(ArcStage::Devise),
            "and the mark stands"
        );
    }

    /// **A resume on an unspawned card is not clocked** ([B09]). The card the
    /// resume names has no snapshot — the deck has not spawned it yet — so the
    /// sweep lands here, reads silence, and would stop the arc as `Stalled` on
    /// the tick after the press. That wait is the deck's own act rather than
    /// silence, and the only thing that can tell the two apart at this depth
    /// is the standing `resume` on the record.
    #[tokio::test]
    async fn a_resume_on_an_unspawned_card_is_not_clocked() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nidle_settle_secs = 0\narc_stall_secs = 1\n",
        )
        .unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();
        tugarc_core::arc::append_arc_stop(
            root,
            "demo",
            ArcStage::Devise,
            ArcStopReason::StoppedByUser,
        )
        .unwrap();
        tugarc_core::arc::append_arc_resume(root, "demo", ArcStage::Devise).unwrap();

        let (ctx, _entry, _register_rx) = harness(root).await;
        ctx.supervisor
            .ledger
            .lock()
            .await
            .remove(&TugSessionId::new("claude-1".to_string()));
        let state = Arc::new(Mutex::new(HashMap::new()));
        // A clock already past the deadline, so the only thing between this
        // sweep and a `Stalled` stop is the standing resume.
        state.lock().await.insert(
            demo_key(root),
            ArcState {
                last_motion_at: Some(Instant::now() - Duration::from_secs(5)),
                ..Default::default()
            },
        );

        let stops_before = arc_stop_lines(root);
        sweep(&ctx, &state).await;
        sweep(&ctx, &state).await;

        assert_eq!(arc_stop_lines(root), stops_before, "no `arc-stop` line");
        let record = read_arc(root, "demo").unwrap();
        assert!(record.stopped.is_none());
        assert_eq!(
            record.resume,
            Some(ArcStage::Devise),
            "and the resume is still there for the deck to answer",
        );
    }

    /// Seed a project whose arc is owned by another instance, with the stall
    /// deadline at one second — the shape `[F01]` arrived in.
    fn foreign_owned_project(root: &Path, owner: &str) {
        project_with_document(root, ".tug/arcs/demo/brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nidle_settle_secs = 0\narc_stall_secs = 1\n",
        )
        .unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_owner(root, "demo", owner).unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();
    }

    /// **The incident, made a test.** A second instance over one checkout reads
    /// an arc it did not seat, cannot snapshot a session living in the other
    /// tugcast's process, and lands on the unseated path — which is exactly
    /// where the false `Stalled` receipt came from. With the owner alive, this
    /// runner writes nothing however long it watches.
    #[tokio::test]
    async fn a_foreign_live_owner_is_never_clocked() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        foreign_owned_project(root, "release-main");

        let (mut ctx, _entry, _register_rx) = harness(root).await;
        ctx.live_owner = |owner| {
            assert_eq!(owner, "release-main", "the probe asks about the owner");
            true
        };
        ctx.supervisor
            .ledger
            .lock()
            .await
            .remove(&TugSessionId::new("claude-1".to_string()));
        let state = Arc::new(Mutex::new(HashMap::new()));

        // Two sweeps with the clock aged past the deadline in between — the
        // sequence that stops an unowned arc — and the arc is untouched.
        sweep(&ctx, &state).await;
        {
            let mut map = state.lock().await;
            for entry in map.values_mut() {
                entry.last_motion_at = Some(Instant::now() - Duration::from_secs(5));
            }
        }
        sweep(&ctx, &state).await;

        assert!(
            read_arc(root, "demo").unwrap().stopped.is_none(),
            "a live owner's arc is not this runner's to stop"
        );
    }

    /// **A crashed tugcast must not orphan an arc forever.** The owner is named
    /// and gone, so somebody has to be able to clock it — and the only instance
    /// that could is the one that died. `ForeignDead` proceeds exactly as an
    /// unowned arc does.
    #[tokio::test]
    async fn a_foreign_dead_owner_is_clocked_like_any_other() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        foreign_owned_project(root, "release-main");

        let (ctx, _entry, _register_rx) = harness(root).await;
        // The harness's default probe already answers `false`; naming it here
        // is what makes this test's arm the one it says it is.
        assert!(!(ctx.live_owner)("release-main"));
        ctx.supervisor
            .ledger
            .lock()
            .await
            .remove(&TugSessionId::new("claude-1".to_string()));
        let state = Arc::new(Mutex::new(HashMap::new()));

        sweep(&ctx, &state).await;
        {
            let mut map = state.lock().await;
            for entry in map.values_mut() {
                entry.last_motion_at = Some(Instant::now() - Duration::from_secs(5));
            }
        }
        sweep(&ctx, &state).await;

        let record = read_arc(root, "demo").unwrap();
        assert_eq!(
            record
                .stopped
                .as_ref()
                .map(|(stage, reason)| (*stage, reason.as_str())),
            Some((ArcStage::Devise, ArcStopReason::Stalled.as_str())),
            "a dead owner's arc is reachable, or it is stuck forever",
        );
    }

    /// **An unowned arc is every runner's to judge.** No `arc-owner` line at
    /// all — every pre-owner arc, every standalone launch, every `cargo`-driven
    /// test — behaves exactly as it did before ownership existed. This is the
    /// arm that would turn a fix into a far worse regression if it drifted.
    #[tokio::test]
    async fn an_unowned_arc_is_this_runners_to_judge() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nidle_settle_secs = 0\narc_stall_secs = 1\n",
        )
        .unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();

        let (mut ctx, _entry, _register_rx) = harness(root).await;
        // Even with every instance in the world alive, an unowned arc never
        // probes — so this predicate must not be reached.
        ctx.live_owner = |_| panic!("an unowned arc probed liveness");
        ctx.supervisor
            .ledger
            .lock()
            .await
            .remove(&TugSessionId::new("claude-1".to_string()));
        let state = Arc::new(Mutex::new(HashMap::new()));

        sweep(&ctx, &state).await;
        {
            let mut map = state.lock().await;
            for entry in map.values_mut() {
                entry.last_motion_at = Some(Instant::now() - Duration::from_secs(5));
            }
        }
        sweep(&ctx, &state).await;

        assert_eq!(
            read_arc(root, "demo")
                .unwrap()
                .stopped
                .as_ref()
                .map(|(stage, reason)| (*stage, reason.as_str())),
            Some((ArcStage::Devise, ArcStopReason::Stalled.as_str())),
            "byte-identical to the no-owner behavior this preserves",
        );
    }

    /// **The stand-down is total, not merely quiet.** Returning after seeding
    /// `last_motion_at` would start a clock this runner must never read — and
    /// would backdate the deadline if the arc later became this runner's, so
    /// the first tick after an ownership change could stop it outright. The
    /// state map must hold no stamp for an arc that was stood down.
    #[tokio::test]
    async fn standing_down_does_not_seed_the_clock() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        foreign_owned_project(root, "release-main");

        let (mut ctx, _entry, _register_rx) = harness(root).await;
        ctx.live_owner = |_| true;
        ctx.supervisor
            .ledger
            .lock()
            .await
            .remove(&TugSessionId::new("claude-1".to_string()));
        let state = Arc::new(Mutex::new(HashMap::new()));

        sweep(&ctx, &state).await;

        let map = state.lock().await;
        assert!(
            map.values().all(|entry| entry.last_motion_at.is_none()),
            "a stood-down arc leaves no stamp, so a later ownership change \
             starts the clock fresh rather than already expired"
        );
    }

    #[tokio::test]
    async fn a_stopped_arc_is_not_resumed_by_a_tick_at_the_dispatcher() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();
        tugarc_core::arc::append_arc_stop(root, "demo", ArcStage::Devise, ArcStopReason::Lint)
            .unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        let state = Arc::new(Mutex::new(HashMap::new()));

        sweep(&ctx, &state).await;
        assert_eq!(entry.lock().await.queue.len(), 0);
        assert!(read_arc(root, "demo").unwrap().stopped.is_some());
    }

    #[tokio::test]
    async fn a_restart_re_rotates_the_recorded_stage_exactly_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nidle_settle_secs = 0\ndocs = \"arc\"\n",
        )
        .unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        // A stage recorded against a session that is no longer the one on the
        // card — what a tugcast restart leaves behind.
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "gone", None).unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        // A rotation seated the session on the card, which is what tells a
        // stage that died from a card the user took back.
        ctx.session_ledger
            .set_stage_provenance("claude-1", "devise", None)
            .unwrap();

        sweep(&ctx, &state).await;
        assert_eq!(entry.lock().await.queue.len(), 2, "the stage rotated again");
        sweep(&ctx, &state).await;
        assert_eq!(entry.lock().await.queue.len(), 2, "and only once");
    }

    #[tokio::test]
    async fn a_fresh_unseated_session_stops_the_arc_and_hands_the_card_back() {
        // The user reached a fresh session on the card — a `/new`, a reset, a
        // rewind fork. Nothing the wheel did produced it, so no rotation
        // goes back onto it.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nidle_settle_secs = 0\ndocs = \"arc\"\n",
        )
        .unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "gone", None).unwrap();

        // No `set_stage_provenance` for `claude-1`: the session on the card
        // carries no stage label.
        let (ctx, entry, _register_rx) = harness(root).await;
        let state = Arc::new(Mutex::new(HashMap::new()));

        sweep(&ctx, &state).await;

        assert_eq!(
            read_arc(root, "demo").unwrap().stopped,
            Some((ArcStage::Devise, "card taken".to_string())),
            "the stop names the taking, not a dead stage"
        );
        let frames = {
            let mut entry = entry.lock().await;
            let mut out = Vec::new();
            while let Some(frame) = entry.queue.pop() {
                out.push(frame);
            }
            out
        };
        assert_eq!(frames.len(), 1, "the hand-back and nothing else");
        let parsed: serde_json::Value = serde_json::from_slice(&frames[0].payload).unwrap();
        assert_eq!(
            parsed["type"], "model_change",
            "the card goes back on the deck's own model",
        );
    }

    #[tokio::test]
    async fn a_card_that_has_not_spawned_since_startup_is_a_wait_not_a_stop() {
        // The startup sweep runs before any deck reconnects: every bound arc's
        // card is either absent from the supervisor or parked `Idle`. Neither
        // is "session gone" — reading it so would stop every in-flight arc on
        // every tugcast restart.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Review, "gone", None).unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        let state = Arc::new(Mutex::new(HashMap::new()));

        entry.lock().await.spawn_state = SpawnState::Idle;
        sweep(&ctx, &state).await;
        assert_eq!(entry.lock().await.queue.len(), 0, "nothing rotated");
        assert!(
            read_arc(root, "demo").unwrap().stopped.is_none(),
            "and nothing stopped"
        );

        ctx.supervisor.ledger.lock().await.clear();
        sweep(&ctx, &state).await;
        assert!(read_arc(root, "demo").unwrap().stopped.is_none());

        // A card whose claude errored out is the case with nothing to advance.
        ctx.supervisor
            .ledger
            .lock()
            .await
            .insert(TugSessionId::new("claude-1".to_string()), entry.clone());
        entry.lock().await.spawn_state = SpawnState::Errored;
        sweep(&ctx, &state).await;
        assert_eq!(
            read_arc(root, "demo").unwrap().stopped,
            Some((ArcStage::Review, "session gone".to_string()))
        );
    }

    #[tokio::test]
    async fn a_resume_on_a_taken_card_still_rotates() {
        // Resume, end to end at the runner: `arc run` on a stopped arc writes
        // `arc-resume`, and the next idle tick answers that stage — not the
        // one before it, and not nothing.
        //
        // On a card that is no longer the stage's, the answer is the rotation
        // it always was ([P08]): there is no session left holding the stage's
        // context, so there is nothing to continue and a fresh one is the only
        // thing a resume can mean.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        std::fs::write(root.join(".tug/arcs/demo/plan.md"), LINTING_PLAN).unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();
        tugarc_core::arc::append_arc_stop(
            root,
            "demo",
            ArcStage::Review,
            ArcStopReason::SpawnQueueFull,
        )
        .unwrap();
        tugarc_core::arc::append_arc_resume(root, "demo", ArcStage::Review).unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        // Another claude on the card: the record's session is not this one.
        entry.lock().await.claude_session_id = Some("claude-2".to_string());
        let state = Arc::new(Mutex::new(HashMap::new()));
        sweep(&ctx, &state).await;

        let frames = {
            let mut entry = entry.lock().await;
            let mut out = Vec::new();
            while let Some(frame) = entry.queue.pop() {
                out.push(frame);
            }
            out
        };
        assert_eq!(frames.len(), 2, "one rotation: session_command + prompt");
        let command: serde_json::Value = serde_json::from_slice(&frames[0].payload).unwrap();
        assert_eq!(command["stage"]["name"], "review");
    }

    #[tokio::test]
    async fn a_stop_hands_the_card_back_on_the_decks_own_model() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        // A devise stage on the card's own session that produced no plan: the
        // documents say stop.
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        entry.lock().await.deck_model = Some("opus".to_string());
        let state = Arc::new(Mutex::new(HashMap::new()));

        sweep(&ctx, &state).await;

        let frames = {
            let mut entry = entry.lock().await;
            let mut out = Vec::new();
            while let Some(frame) = entry.queue.pop() {
                out.push(frame);
            }
            out
        };
        assert_eq!(frames.len(), 1, "exactly one model_change");
        let parsed: serde_json::Value = serde_json::from_slice(&frames[0].payload).unwrap();
        assert_eq!(parsed["type"], "model_change");
        assert_eq!(parsed["model"], "opus");

        let record = read_arc(root, "demo").unwrap();
        assert_eq!(
            record.stopped,
            Some((ArcStage::Devise, "lint".to_string())),
            "and the stop is recorded with its reason"
        );
    }

    /// Every `arc_receipt` the supervisor published, as its summary text.
    fn receipts(rx: &mut tokio::sync::broadcast::Receiver<Frame>) -> Vec<String> {
        let mut out = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            let Ok(value) = serde_json::from_slice::<serde_json::Value>(&frame.payload) else {
                continue;
            };
            if value.get("action").and_then(|a| a.as_str()) != Some("arc_receipt") {
                continue;
            }
            if let Some(summary) = value.get("summary").and_then(|s| s.as_str()) {
                out.push(summary.to_string());
            }
        }
        out
    }

    /// A project that is also a git repository with one commit on `main` —
    /// what `create_in` needs to make a seat. The arc's own homes are ignored
    /// so the worktree it makes is not base dirt.
    fn git_project(root: &Path) {
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.name", "Test User"],
            vec!["config", "user.email", "test@example.com"],
        ] {
            let out = tugcore::git_command()
                .arg("-C")
                .arg(root)
                .args(&args)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}");
        }
        std::fs::write(root.join(".gitignore"), ".tug/\n.tugtool/\n").unwrap();
        std::fs::write(root.join("README.md"), "# Test\n").unwrap();
        for args in [vec!["add", "-A"], vec!["commit", "-m", "Initial commit"]] {
            let out = tugcore::git_command()
                .arg("-C")
                .arg(root)
                .args(&args)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}");
        }
    }

    /// The text of every user-message frame in a drained queue.
    fn prompt_texts(frames: &[Frame]) -> Vec<String> {
        frames
            .iter()
            .filter_map(|frame| serde_json::from_slice::<serde_json::Value>(&frame.payload).ok())
            .filter(|value| value.get("type").and_then(|t| t.as_str()) == Some("user_message"))
            .filter_map(|value| {
                value
                    .get("content")
                    .and_then(|c| c.as_array())
                    .and_then(|parts| parts.first())
                    .and_then(|part| part.get("text"))
                    .and_then(|t| t.as_str())
                    .map(str::to_owned)
            })
            .collect()
    }

    /// The dispatch makes the seat before it names it. A plain arc opening
    /// at implement in a repository with no branch and no worktree for it is
    /// rotated with a `where` line naming a worktree that exists — made by
    /// the dispatch, through the idempotent `create_in`, so the stage's
    /// coordinates are facts rather than a path somebody computed.
    #[tokio::test]
    async fn the_implement_dispatch_makes_the_seat_and_the_where_line_names_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git_project(root);
        project_with_document(root, ".tug/arcs/demo/brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nidle_settle_secs = 0\ndocs = \"arc\"\n",
        )
        .unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_kind(root, "demo", tugarc_core::arc::ArcKind::Plain).unwrap();
        let worktree = tugarc_core::ops::worktree_path(root, "demo");
        assert!(
            !worktree.exists(),
            "the seat is not there before the dispatch"
        );

        let (ctx, entry, _register_rx) = harness(root).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        sweep(&ctx, &state).await;

        let record = read_arc(root, "demo").expect("the arc record");
        assert_eq!(record.stopped, None, "{:?}", record.notes);
        assert_eq!(record.dispatched, Some(ArcStage::Implement));
        assert!(worktree.is_dir(), "the dispatch made the seat");

        let frames = queued(&entry).await;
        let texts = prompt_texts(&frames);
        let where_line = format!("where: worktree {}", worktree.display());
        assert!(
            texts.iter().any(|t| t.contains(&where_line)),
            "the where line names the seat the dispatch made: {texts:?}"
        );
    }

    /// A seat that cannot be made is a stop with a receipt, never a `where`
    /// line naming a path that is not there. A project that is not a git
    /// repository is the one shape `create_in` cannot serve.
    #[tokio::test]
    async fn a_seat_that_cannot_be_made_stops_the_arc_as_seat_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nidle_settle_secs = 0\ndocs = \"arc\"\n",
        )
        .unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_kind(root, "demo", tugarc_core::arc::ArcKind::Plain).unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        let mut control_rx = ctx.supervisor.control_tx.subscribe();
        let state = Arc::new(Mutex::new(HashMap::new()));
        sweep(&ctx, &state).await;

        let record = read_arc(root, "demo").expect("the arc record");
        assert_eq!(
            record.stopped,
            Some((
                ArcStage::Implement,
                ArcStopReason::SeatUnavailable.as_str().to_string()
            ))
        );
        assert!(
            record.stages.is_empty() && record.dispatched.is_none(),
            "no stage is seated over a seat that does not exist"
        );
        // `create_in`'s own sentence rides as the note.
        assert!(
            record.notes.last().is_some_and(|note| !note.is_empty()),
            "{:?}",
            record.notes
        );
        assert!(!tugarc_core::ops::worktree_path(root, "demo").exists());
        assert!(
            prompt_texts(&queued(&entry).await).is_empty(),
            "no prompt was sent"
        );
        let said = receipts(&mut control_rx);
        assert_eq!(said.len(), 1, "one receipt, got {said:?}");
        assert!(
            said[0].contains("its worktree could not be made"),
            "{said:?}"
        );
    }

    /// A seat is never made over somebody's rounds. `create_in`'s repair for
    /// a branch whose worktree has gone is `git branch -D` and a fresh cut
    /// from the base — so the dispatch, which now runs it before every
    /// implement prompt, asks first and stops rather than deleting the work.
    #[tokio::test]
    async fn a_branch_carrying_rounds_with_no_worktree_stops_instead_of_being_rebuilt() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git_project(root);
        project_with_document(root, ".tug/arcs/demo/brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nidle_settle_secs = 0\ndocs = \"arc\"\n",
        )
        .unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_kind(root, "demo", tugarc_core::arc::ArcKind::Plain).unwrap();

        // A seat that was walked: one round on the branch, and then the
        // worktree removed the way a `git worktree remove` or a disk sweep
        // leaves it — branch behind, tree gone.
        let outcome = tugarc_core::ops::create_in(root, "demo", None, false, None).unwrap();
        let worktree = PathBuf::from(&outcome.worktree);
        std::fs::write(worktree.join("round.txt"), "work\n").unwrap();
        for args in [vec!["add", "-A"], vec!["commit", "-m", "A round"]] {
            let out = tugcore::git_command()
                .arg("-C")
                .arg(&worktree)
                .args(&args)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}");
        }
        let tip = String::from_utf8(
            tugcore::git_command()
                .arg("-C")
                .arg(root)
                .args(["rev-parse", "tugarc/demo"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        let out = tugcore::git_command()
            .arg("-C")
            .arg(root)
            .args(["worktree", "remove", "--force"])
            .arg(&worktree)
            .output()
            .unwrap();
        assert!(out.status.success(), "the worktree is gone");
        assert_eq!(
            tugarc_core::ops::rounds_a_rebuild_would_lose(root, "demo"),
            1
        );

        let (ctx, entry, _register_rx) = harness(root).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        sweep(&ctx, &state).await;

        let record = read_arc(root, "demo").expect("the arc record");
        assert_eq!(
            record.stopped,
            Some((
                ArcStage::Implement,
                ArcStopReason::SeatUnavailable.as_str().to_string()
            ))
        );
        assert!(
            record
                .notes
                .last()
                .is_some_and(|note| note.contains("1 round(s)")),
            "the note counts what a rebuild would have lost: {:?}",
            record.notes
        );
        assert!(
            prompt_texts(&queued(&entry).await).is_empty(),
            "no prompt was sent"
        );
        // And the rounds are still there.
        let still = String::from_utf8(
            tugcore::git_command()
                .arg("-C")
                .arg(root)
                .args(["rev-parse", "tugarc/demo"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        assert_eq!(still, tip, "the branch was not rebuilt");
    }

    /// Drain a session's spawn queue.
    async fn queued(entry: &Arc<Mutex<super::super::agent_supervisor::LedgerEntry>>) -> Vec<Frame> {
        let mut entry = entry.lock().await;
        let mut out = Vec::new();
        while let Some(frame) = entry.queue.pop() {
            out.push(frame);
        }
        out
    }

    #[tokio::test]
    async fn a_refused_rotation_leaves_a_receipt_as_well_as_a_record() {
        // Before every stopper shared one path, a refused rotation recorded
        // and handed back but said nothing on the card.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nidle_settle_secs = 0\ndocs = \"arc\"\n",
        )
        .unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        let mut control_rx = ctx.supervisor.control_tx.subscribe();
        // A closed entry is what the wheel refuses by name.
        entry.lock().await.spawn_state = SpawnState::Closed;
        let state = Arc::new(Mutex::new(HashMap::new()));

        sweep(&ctx, &state).await;

        let record = read_arc(root, "demo").unwrap();
        assert_eq!(
            record.stopped,
            Some((ArcStage::Devise, "session gone".to_string())),
        );
        let said = receipts(&mut control_rx);
        assert_eq!(said.len(), 1, "one receipt, got {said:?}");
        assert!(
            said[0].starts_with("arc stopped · demo · in devise"),
            "{said:?}"
        );
    }

    #[tokio::test]
    async fn a_stop_issues_the_hand_back_before_it_records_the_receipt() {
        // The restore goes first so the card the user is handed back is
        // already theirs by the time the terminal line lands. Issue-order,
        // not arrival-order: the two travel different channels.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        let mut control_rx = ctx.supervisor.control_tx.subscribe();
        entry.lock().await.deck_model = Some("opus".to_string());

        stop_arc_for_session(
            &ctx.supervisor,
            &ctx.wheel,
            &TugSessionId::new("claude-1".to_string()),
            root,
            "demo",
            ArcStage::Devise,
            ArcStopReason::StoppedByUser,
            StopDelivery {
                hand_back: HandBack::Send,
                record: true,
            },
        )
        .await;

        // The hand-back was queued before the receipt was published: the
        // receipt channel is still empty at the moment the frame is on the
        // queue only because the queue write happened first.
        let frames = queued(&entry).await;
        assert_eq!(frames.len(), 1);
        let parsed: serde_json::Value = serde_json::from_slice(&frames[0].payload).unwrap();
        assert_eq!(parsed["type"], "model_change");
        assert_eq!(parsed["model"], "opus");

        let said = receipts(&mut control_rx);
        assert_eq!(said.len(), 1, "got {said:?}");
        assert!(said[0].contains("you stopped it"), "{said:?}");
        assert_eq!(
            read_arc(root, "demo").unwrap().stopped,
            Some((ArcStage::Devise, "stopped by user".to_string())),
        );
    }

    #[tokio::test]
    async fn a_user_stop_writes_the_record_the_receipt_and_the_hand_back() {
        // What `tugtool arc stop` reaches: the same three acts every other
        // stop performs, so a stop the user asked for is not a lesser one.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Implement, "claude-1", None)
            .unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        let mut control_rx = ctx.supervisor.control_tx.subscribe();
        entry.lock().await.deck_model = Some("sonnet".to_string());

        stop_arc_for_session(
            &ctx.supervisor,
            &ctx.wheel,
            &TugSessionId::new("claude-1".to_string()),
            root,
            "demo",
            ArcStage::Implement,
            ArcStopReason::StoppedByUser,
            StopDelivery {
                hand_back: HandBack::Send,
                record: true,
            },
        )
        .await;

        let frames = queued(&entry).await;
        assert_eq!(frames.len(), 1);
        let parsed: serde_json::Value = serde_json::from_slice(&frames[0].payload).unwrap();
        assert_eq!(parsed["model"], "sonnet");

        let said = receipts(&mut control_rx);
        assert_eq!(said.len(), 1, "got {said:?}");
        assert!(said[0].contains("you stopped it"), "{said:?}");
        assert!(
            !said[0].contains("tugtool arc run"),
            "and it names no command — the resume is the receipt's own button: {said:?}",
        );
        assert_eq!(
            read_arc(root, "demo").unwrap().stopped,
            Some((ArcStage::Implement, "stopped by user".to_string())),
        );
    }

    #[tokio::test]
    async fn an_endings_receipt_announces_the_retirement_rather_than_a_stop() {
        // The two endings are the reasons whose stop has not happened yet: the
        // arc is gone, but the stage is mid-turn and retires at that turn's
        // end. So the receipt says what is about to happen and names the model
        // the card comes back to, and it says which gesture ended the arc.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Review, "claude-1", None)
            .unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        let mut control_rx = ctx.supervisor.control_tx.subscribe();
        entry.lock().await.deck_model = Some("opus".to_string());

        for (reason, word) in [
            (ArcStopReason::Discarded, "discarded"),
            (ArcStopReason::Joined, "joined"),
        ] {
            stop_arc_for_session(
                &ctx.supervisor,
                &ctx.wheel,
                &TugSessionId::new("claude-1".to_string()),
                root,
                "demo",
                ArcStage::Review,
                reason,
                StopDelivery {
                    hand_back: HandBack::Arm,
                    record: false,
                },
            )
            .await;
            let said = receipts(&mut control_rx);
            assert_eq!(said.len(), 1, "got {said:?}");
            assert_eq!(
                said[0],
                format!(
                    "arc {word} · demo · the stage's turn will end and the card returns to opus"
                ),
            );
            assert!(ctx.wheel.take_hand_back("claude-1"));
        }
    }

    #[tokio::test]
    async fn an_ending_on_a_card_with_no_model_names_the_account_default() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();

        let (ctx, _entry, _register_rx) = harness(root).await;
        let mut control_rx = ctx.supervisor.control_tx.subscribe();

        stop_arc_for_session(
            &ctx.supervisor,
            &ctx.wheel,
            &TugSessionId::new("claude-1".to_string()),
            root,
            "demo",
            ArcStage::Devise,
            ArcStopReason::Discarded,
            StopDelivery {
                hand_back: HandBack::Arm,
                record: false,
            },
        )
        .await;

        let said = receipts(&mut control_rx);
        assert_eq!(said.len(), 1, "got {said:?}");
        assert!(
            said[0].ends_with("the card returns to the account default"),
            "a card that never chose a model says so rather than showing a blank: {said:?}",
        );
    }

    #[tokio::test]
    async fn an_armed_stop_records_no_line_and_sends_no_frame() {
        // The ending combination: the stage is mid-turn, so the restore is
        // armed rather than sent, and nothing is appended to the arc log —
        // the ending's own terminal line closed the arc's generation, and a
        // line after it would open a phantom one.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Review, "claude-1", None)
            .unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        let mut control_rx = ctx.supervisor.control_tx.subscribe();

        stop_arc_for_session(
            &ctx.supervisor,
            &ctx.wheel,
            &TugSessionId::new("claude-1".to_string()),
            root,
            "demo",
            ArcStage::Review,
            ArcStopReason::Discarded,
            StopDelivery {
                hand_back: HandBack::Arm,
                record: false,
            },
        )
        .await;

        assert!(
            queued(&entry).await.is_empty(),
            "nothing reaches the card yet"
        );
        assert!(
            ctx.wheel.take_hand_back("claude-1"),
            "the restore is armed for the turn's end",
        );
        assert_eq!(
            receipts(&mut control_rx).len(),
            1,
            "and the card is told now"
        );
        assert_eq!(
            read_arc(root, "demo").unwrap().stopped,
            None,
            "no arc-stop line is appended",
        );
    }

    #[tokio::test]
    async fn a_card_that_never_chose_a_model_is_handed_back_the_default() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        sweep(&ctx, &state).await;

        let frame = entry.lock().await.queue.pop().unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(parsed["model"], "default");
    }

    use tugarc_core::arc::ArcStageLine;

    fn stage_line(stage: ArcStage, model: Option<&str>, session: &str) -> ArcStageLine {
        ArcStageLine {
            stage,
            session_id: session.to_owned(),
            model: model.map(str::to_owned),
            at: "2026-08-25T00:00:00Z".to_owned(),
        }
    }

    fn done_record(stages: Vec<ArcStageLine>) -> ArcRecord {
        ArcRecord {
            arc: "foo".to_owned(),
            document: Some("arc/foo-brief.md".to_owned()),
            kind: None,
            plan: Some("arc/foo.md".to_owned()),
            stages,
            notes: Vec::new(),
            stopped: None,
            last_stop: None,
            stopping: None,
            resume: None,
            dispatched: None,
            owner: None,
            done: true,
            last_activity: Some("2026-08-25T00:00:00Z".to_owned()),
        }
    }

    #[test]
    fn only_an_idle_reading_moves_the_done_count() {
        // A mid-turn recompute — a round committing fires one — must not
        // consume the step-boundary edge the turn-end tick reads.
        assert_eq!(retain_done_count(Some(3), 4, false), Some(3));
        assert_eq!(retain_done_count(Some(3), 4, true), Some(4));
        assert_eq!(retain_done_count(None, 4, false), None);
    }

    /// **The clock's deadline, hang-shaped.** The wedge is a stage whose turn
    /// started and never ended: no turn ends, no step closes, the runner acts
    /// on nothing, so `last_motion_at` never moves again while the wall clock
    /// does. The predicate takes its `now`, so the hang is synthesized here
    /// rather than waited out — which is the only way a half-hour deadline is
    /// testable at all.
    #[test]
    fn the_clock_runs_out_on_a_stamp_that_stops_moving() {
        let timeout = Some(Duration::from_secs(1_800));
        let start = Instant::now();

        // Motion, then a hang: the stamp stands still and `now` walks past it.
        assert!(
            !clock_ran_out(Some(start), start + Duration::from_secs(1_799), timeout),
            "a second inside the deadline is a stage still working"
        );
        assert!(
            clock_ran_out(Some(start), start + Duration::from_secs(1_800), timeout),
            "the deadline is inclusive — reaching it is running out"
        );
        assert!(clock_ran_out(
            Some(start),
            start + Duration::from_secs(7_200),
            timeout
        ));

        // Motion restarts it. A turn ending, a step closing, or the runner
        // acting re-stamps, and the hour that went before is not held against
        // the stage.
        let moved = start + Duration::from_secs(7_200);
        assert!(!clock_ran_out(
            Some(moved),
            moved + Duration::from_secs(60),
            timeout
        ));
    }

    /// The two ways the clock declines to fire, both deliberate.
    ///
    /// An unstamped arc has not been *observed* yet — a restart's first sweep
    /// seeds the stamp — and silence tugcast did not watch is not silence it
    /// may stop a stage over. A `None` timeout is `arc_stall_secs = 0`: the
    /// one way a project can ask for the old behaviour of waiting forever.
    #[test]
    fn an_unstamped_arc_and_a_disabled_clock_never_run_out() {
        let start = Instant::now();
        let long_after = start + Duration::from_secs(86_400);
        assert!(!clock_ran_out(
            None,
            long_after,
            Some(Duration::from_secs(1))
        ));
        assert!(!clock_ran_out(Some(start), long_after, None));
    }

    /// The default is far too slow to catch a stage that is merely slow, and
    /// that is the point: the clock is the last resort under every other arm,
    /// never a pacing device. A declared `0` turns it off; anything else is
    /// taken at its word.
    #[test]
    fn the_declared_deadline_is_what_the_clock_uses() {
        use tugtool_core::config::{ARC_STALL_SECS_DEFAULT, ArcConfig};
        assert_eq!(
            ArcConfig::default().stall_timeout(),
            Some(Duration::from_secs(ARC_STALL_SECS_DEFAULT))
        );
        assert_eq!(
            ArcConfig {
                arc_stall_secs: Some(90),
                ..ArcConfig::default()
            }
            .stall_timeout(),
            Some(Duration::from_secs(90))
        );
        assert_eq!(
            ArcConfig {
                arc_stall_secs: Some(0),
                ..ArcConfig::default()
            }
            .stall_timeout(),
            None,
            "zero is the clock turned off, not a deadline of no time at all"
        );
    }

    #[test]
    fn the_receipt_names_every_stage_its_model_and_its_session() {
        let receipt = format_arc_receipt(&done_record(vec![
            stage_line(ArcStage::Devise, Some("opus"), "claude-a"),
            stage_line(ArcStage::Review, Some("opus"), "claude-b"),
            stage_line(ArcStage::Implement, Some("sonnet"), "claude-c"),
        ]));
        assert_eq!(
            receipt,
            "arc complete · foo\n\
             opened on arc/foo-brief.md\n\
             devise · opus · claude-a\n\
             review · opus · claude-b\n\
             implement · sonnet · claude-c\n\
             plan arc/foo.md"
        );
        assert!(
            !receipt.contains("/join"),
            "the receipt never offers the join — the shade does"
        );
    }

    #[test]
    fn a_stage_on_the_account_default_says_so_rather_than_showing_a_blank() {
        let receipt = format_arc_receipt(&done_record(vec![stage_line(
            ArcStage::Devise,
            None,
            "claude-a",
        )]));
        assert!(
            receipt.contains("devise · account default · claude-a"),
            "got {receipt}"
        );
    }

    #[test]
    fn the_stop_receipt_says_what_stopped_it_and_never_a_command() {
        let record = done_record(vec![stage_line(ArcStage::Review, Some("opus"), "claude-b")]);
        // Every reason renders its own sentence. A resumable stop ends there —
        // the resume is a button in the row's own block, not a verb in the
        // text ([B01]) — and only the two endings add the terminal sentence,
        // which is the marker a restored transcript reads terminality off
        // ([B05]).
        for reason in ArcStopReason::ALL {
            let receipt = format_arc_stop_receipt(&record, ArcStage::Review, *reason);
            assert!(
                receipt.starts_with("arc stopped · foo · in review — "),
                "got {receipt}"
            );
            assert!(receipt.contains(reason.sentence()), "got {receipt}");
            assert!(
                !receipt.contains("tugtool arc run"),
                "no stop names a command: got {receipt}"
            );
            if reason.is_resumable() {
                assert!(receipt.ends_with(reason.sentence()), "got {receipt}");
            } else {
                assert!(
                    receipt.ends_with("\nthere is nothing to resume"),
                    "got {receipt}"
                );
            }
        }

        assert_eq!(
            format_arc_stop_receipt(&record, ArcStage::Devise, ArcStopReason::Lint),
            "arc stopped · foo · in devise — the plan does not lint"
        );
        assert_eq!(
            format_arc_stop_receipt(&record, ArcStage::Review, ArcStopReason::Discarded),
            "arc stopped · foo · in review — the arc was discarded\n\
             there is nothing to resume"
        );
        assert_eq!(
            format_arc_stop_receipt(&record, ArcStage::Implement, ArcStopReason::CardTaken),
            "arc stopped · foo · in implement — you took the card back"
        );
    }

    #[test]
    fn an_arc_that_never_reached_a_plan_still_reads() {
        let mut record = done_record(vec![stage_line(ArcStage::Devise, None, "claude-a")]);
        record.plan = None;
        record.document = None;
        assert_eq!(
            format_arc_receipt(&record),
            "arc complete · foo\ndevise · account default · claude-a"
        );
    }

    /// A project with a seated implement stage: a reviewed two-step plan, an
    /// `arc-stage implement` line naming the harness's session, and a declared
    /// run through step 2. A real repository underneath, because every prompt
    /// the implement stage is sent names a seat the dispatch made, and a
    /// project `create_in` cannot serve stops the arc before the prompt.
    fn implementing_project(root: &Path, first: &str, second: &str) {
        git_project(root);
        project_with_document(root, ".tug/arcs/demo/brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nidle_settle_secs = 0\nimplement_compact_tokens = 300000\n",
        )
        .unwrap();
        std::fs::write(
            root.join(".tug/arcs/demo/plan.md"),
            plan_with_statuses(first, second),
        )
        .unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_plan(root, "demo", ".tug/arcs/demo/plan.md").unwrap();
        tugarc_core::log::append_arc_log(root, "demo", "run-through", "2").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Implement, "claude-1", None)
            .unwrap();
    }

    /// Give the session a measured context — the live `cost_update` figure,
    /// which is the only half of the old reading the arc still needs.
    async fn set_context(
        entry: &Arc<Mutex<super::super::agent_supervisor::LedgerEntry>>,
        used: i64,
    ) {
        entry.lock().await.context_window_tokens = Some(used);
    }

    /// What the `compact_boundary` frame leaves behind: no reading at all.
    ///
    /// The supervisor retires the number on that frame, because a compact turn
    /// carries no usage frame of its own and the figure it held measures a
    /// context that is gone. This is what the arc sees on the tick that reads
    /// the compaction's end.
    async fn retire_context(entry: &Arc<Mutex<super::super::agent_supervisor::LedgerEntry>>) {
        entry.lock().await.context_window_tokens = None;
    }

    /// Set the seated session's counts as **asked** turns ending would ([P02]):
    /// the all-openers count and the prompt count move together.
    ///
    /// Every test that predates the split meant asked turns — the horizon was
    /// the only reader — so this is what "the stage ended N turns" spells now.
    /// A test about a *wake*-opened turn reaches for [`woke`] instead, and the
    /// difference between the two is the whole of what this step is about.
    ///
    /// The turn is left **inactive**, because that is what ending one means —
    /// and it has to be said out loud from the re-ask onward: a prompt the arc
    /// dispatches marks the entry's turn active, so a test that bumped only
    /// the count would go on reading a session mid-turn and every arm below
    /// the idle gate would be unreachable.
    async fn asked(entry: &Arc<Mutex<super::super::agent_supervisor::LedgerEntry>>, turns: u32) {
        let mut entry = entry.lock().await;
        entry.turns_ended = turns;
        entry.prompt_turns_ended = turns;
        entry.turn_active = false;
    }

    /// Advance the seated session by one **wake**-opened turn end: the
    /// all-openers count moves and the prompt count does not.
    async fn woke(entry: &Arc<Mutex<super::super::agent_supervisor::LedgerEntry>>) {
        let mut entry = entry.lock().await;
        entry.turns_ended += 1;
        entry.wake_turns_ended += 1;
    }

    /// Declare a real settle over a project the writers left at `0`, so a
    /// settle test says out loud that it is one.
    fn with_settle(root: &Path, secs: u64) {
        let existing = std::fs::read_to_string(root.join(".tugtool/config.toml")).unwrap();
        std::fs::write(
            root.join(".tugtool/config.toml"),
            existing.replace(
                "idle_settle_secs = 0",
                &format!("idle_settle_secs = {secs}"),
            ),
        )
        .unwrap();
    }

    /// Age the window back past the settle rather than sleeping through it —
    /// the same shape the clock's tests use on `last_motion_at`.
    async fn age_the_settle(state: &Arc<Mutex<HashMap<String, ArcState>>>, by: Duration) {
        let mut map = state.lock().await;
        for entry in map.values_mut() {
            entry.quiet_since = entry.quiet_since.map(|since| since - by);
        }
    }

    /// Everything the entry has queued, drained.
    async fn drained(
        entry: &Arc<Mutex<super::super::agent_supervisor::LedgerEntry>>,
    ) -> Vec<serde_json::Value> {
        let mut entry = entry.lock().await;
        let mut out = Vec::new();
        while let Some(frame) = entry.queue.pop() {
            out.push(serde_json::from_slice(&frame.payload).unwrap());
        }
        out
    }

    /// The state the settle tests start from: a step boundary the runner would
    /// answer with a continue prompt on the very first sweep, were it not for
    /// the settle.
    fn settling_state(root: &Path) -> Arc<Mutex<HashMap<String, ArcState>>> {
        let state = Arc::new(Mutex::new(HashMap::new()));
        let mut map = HashMap::new();
        map.insert(
            demo_key(root),
            ArcState {
                last_done_count: Some(0),
                ..Default::default()
            },
        );
        *state.try_lock().unwrap() = map;
        state
    }

    /// The queue's text submissions, in order.
    async fn submitted(
        entry: &Arc<Mutex<super::super::agent_supervisor::LedgerEntry>>,
    ) -> Vec<String> {
        entry
            .lock()
            .await
            .queue
            .iter()
            .filter_map(|frame| {
                let value: serde_json::Value = serde_json::from_slice(&frame.payload).ok()?;
                (value.get("type")?.as_str()? == "user_message").then(|| {
                    value["content"][0]["text"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string()
                })
            })
            .collect()
    }

    /// The **ask** of every prompt the arc submitted — each prompt's first
    /// line.
    ///
    /// A test about *which* prompt was sent reads the ask; the clauses under
    /// it (`where:`, the citations, what moved in them) carry paths a temp
    /// root makes different on every run, and their composition is asserted
    /// where it is written.
    async fn submitted_asks(
        entry: &Arc<Mutex<super::super::agent_supervisor::LedgerEntry>>,
    ) -> Vec<String> {
        submitted(entry)
            .await
            .iter()
            .map(|prompt| prompt.lines().next().unwrap_or_default().to_string())
            .collect()
    }

    /// The arc's own key for the harness's project and arc, which is what the
    /// per-arc memory is filed under.
    fn demo_key(root: &Path) -> String {
        format!("{}\u{0}demo", root.display())
    }

    /// The regression [P04] fixes: with `last_done_count` cleared at rotation,
    /// an implement stage's first idle tick — which *is* a turn end at a step
    /// boundary — could never report one, so the arc sat still forever.
    #[tokio::test]
    async fn the_first_idle_tick_after_a_rotation_sees_a_step_just_done() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        // What `rotate` now writes: the plan's count when the stage was seated.
        let state = Arc::new(Mutex::new(HashMap::new()));
        state.lock().await.insert(
            demo_key(root),
            ArcState {
                last_done_count: Some(0),
                ..Default::default()
            },
        );

        sweep(&ctx, &state).await;

        assert_eq!(
            submitted_asks(&entry).await,
            vec![
                "/tugplug:arc-implement demo implement Step 2 and end the turn; it is the arc's last step"
                    .to_string()
            ],
            "the boundary is seen and the stage is told to walk on"
        );
    }

    /// **A boundary that closed just before a crash is still a boundary.**
    ///
    /// After a restart the runner remembers nothing, and it used to seed the
    /// comparison at the count it found — spending the edge without anyone
    /// acting on it. A step closed in the seconds before the crash was a
    /// boundary the arc owed a prompt, and the stage then sat waiting for one
    /// that had already gone past.
    ///
    /// The table answers instead: no row open, closes behind, steps ahead.
    /// The state map is empty here on purpose — that emptiness *is* the
    /// restart.
    #[tokio::test]
    async fn a_restart_reads_the_unanswered_boundary_off_the_table() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        let state = Arc::new(Mutex::new(HashMap::new()));

        sweep(&ctx, &state).await;

        assert_eq!(
            submitted_asks(&entry).await,
            vec![
                "/tugplug:arc-implement demo implement Step 2 and end the turn; it is the arc's last step"
                    .to_string()
            ],
            "the close the crash interrupted is answered on the first tick back"
        );
    }

    /// **An idle reading is not an edge** ([P01]). The first sweep over a step
    /// boundary reads a session that is idle *at that instant*, which is what
    /// the runner used to spend on a prompt. It now records what it read and
    /// spends nothing.
    #[tokio::test]
    async fn an_idle_reading_is_not_an_edge() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");
        with_settle(root, 5);

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        let state = settling_state(root);

        sweep(&ctx, &state).await;

        assert!(
            submitted_asks(&entry).await.is_empty(),
            "the reading was recorded, not spent",
        );
        let map = state.lock().await;
        let after = &map[&demo_key(root)];
        assert!(after.quiet_since.is_some(), "the window is open");
        assert!(after.quiet_marks.is_some(), "over the facts it was made of");
    }

    /// And a reading that is still true a settle later **is** one. Same
    /// boundary, same facts, one aged window: the prompt goes.
    #[tokio::test]
    async fn a_settled_reading_is_an_edge() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");
        with_settle(root, 5);

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        let state = settling_state(root);

        sweep(&ctx, &state).await;
        assert!(submitted_asks(&entry).await.is_empty());

        age_the_settle(&state, Duration::from_secs(6)).await;
        sweep(&ctx, &state).await;

        assert_eq!(
            submitted_asks(&entry).await,
            vec![
                "/tugplug:arc-implement demo implement Step 2 and end the turn; it is the arc's last step"
                    .to_string()
            ],
            "the same reading, still true, is worth acting on",
        );
    }

    /// **The incident's shape.** A wake inside the window is not the same
    /// session standing still — it is the session working, in the gap between
    /// a turn ending and the harness re-invoking it. The window starts again
    /// over the new reading rather than elapsing over the old one.
    ///
    /// Then a turn opening: not idle at all, so there is no window left.
    #[tokio::test]
    async fn a_wake_inside_the_settle_resets_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");
        with_settle(root, 5);

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        let state = settling_state(root);

        sweep(&ctx, &state).await;
        let armed_at = state.lock().await[&demo_key(root)].quiet_since.unwrap();

        // Four seconds in, a background completion wakes the session. Under a
        // wall clock alone the fifth second would have spent the reading.
        age_the_settle(&state, Duration::from_secs(4)).await;
        woke(&entry).await;
        sweep(&ctx, &state).await;

        {
            let map = state.lock().await;
            let after = &map[&demo_key(root)];
            assert!(
                after.quiet_since.is_some_and(|since| since > armed_at),
                "the window starts again over the reading that replaced it",
            );
        }
        assert!(
            submitted_asks(&entry).await.is_empty(),
            "and nothing was spent on the reading the wake interrupted",
        );

        // The wake's turn opens. A reading that is not idle settles nothing.
        entry.lock().await.turn_active = true;
        sweep(&ctx, &state).await;
        let map = state.lock().await;
        assert_eq!(map[&demo_key(root)].quiet_since, None);
        assert_eq!(map[&demo_key(root)].quiet_marks, None);
    }

    /// The same, for the other half of `is_quiet`: a job opening inside the
    /// window is work starting, and the reading it interrupts is stale.
    #[tokio::test]
    async fn a_job_opening_inside_the_settle_resets_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");
        with_settle(root, 5);

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        let state = settling_state(root);

        sweep(&ctx, &state).await;
        let armed_at = state.lock().await[&demo_key(root)].quiet_since.unwrap();

        // A job opens: the session is no longer idle at all, so the window
        // goes rather than restarting.
        age_the_settle(&state, Duration::from_secs(4)).await;
        entry
            .lock()
            .await
            .open_jobs
            .insert("t1".to_owned(), Instant::now());
        sweep(&ctx, &state).await;
        {
            let map = state.lock().await;
            assert_eq!(map[&demo_key(root)].quiet_since, None, "no idle reading");
        }
        assert!(submitted_asks(&entry).await.is_empty());

        // It closes. That is a fresh reading, and a fresh window over it.
        entry.lock().await.open_jobs.remove("t1");
        sweep(&ctx, &state).await;
        let map = state.lock().await;
        assert!(
            map[&demo_key(root)]
                .quiet_since
                .is_some_and(|since| since > armed_at),
            "the window is the new reading's, not the interrupted one's",
        );
    }

    /// **[P09], at the act that costs most to get wrong.** A stop hands the
    /// card back on the deck's model and writes a terminal line nothing undoes,
    /// so it is the one act that must not be decided in a 120 ms gap. It goes
    /// through the settle like every other.
    #[tokio::test]
    async fn a_stop_decided_before_the_settle_sends_no_model_change() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");
        with_settle(root, 5);

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        state.lock().await.insert(
            demo_key(root),
            ArcState {
                last_done_count: Some(1),
                // At the horizon already: the next quiet turn is the stop.
                quiet_turns: QUIET_TURN_HORIZON - 1,
                prompt_turns_seen: Some(0),
                all_turns_seen: Some(0),
                ..Default::default()
            },
        );
        asked(&entry, 1).await;

        sweep(&ctx, &state).await;
        assert_eq!(
            read_arc(root, "demo").unwrap().stopped,
            None,
            "no arc-stop line on an unsettled reading",
        );
        assert!(
            drained(&entry).await.is_empty(),
            "and no model_change: the card is still the stage's",
        );

        age_the_settle(&state, Duration::from_secs(6)).await;
        sweep(&ctx, &state).await;

        assert_eq!(
            read_arc(root, "demo").unwrap().stopped,
            Some((ArcStage::Implement, "implement idle".to_string())),
            "the settled reading stops the arc",
        );
        let frames = drained(&entry).await;
        assert_eq!(frames.len(), 1, "the hand-back and nothing else");
        assert_eq!(frames[0]["type"], "model_change");
    }

    /// The two stops the settle never holds. A session with no child is gone
    /// whenever it is looked at — the fact is not a claim about an instant —
    /// and holding it would leave the card seated on the stage's model for five
    /// seconds with nothing behind it.
    #[tokio::test]
    async fn a_dead_session_is_never_settled() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");
        with_settle(root, 5);

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        entry.lock().await.spawn_state = SpawnState::Errored;
        let state = settling_state(root);

        sweep(&ctx, &state).await;

        assert_eq!(
            read_arc(root, "demo").unwrap().stopped,
            Some((ArcStage::Implement, "session gone".to_string())),
            "the first sweep stops it, settle or no settle",
        );
    }

    /// The other side of the same read: a stage caught **mid-step** by the
    /// crash is not owed a prompt, and must not be handed one — it would land
    /// on top of a step already being walked.
    #[tokio::test]
    async fn a_restart_mid_step_is_not_a_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "in progress");

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        let state = Arc::new(Mutex::new(HashMap::new()));

        sweep(&ctx, &state).await;

        assert!(
            submitted(&entry).await.is_empty(),
            "an open row is a step being walked, not a boundary to answer"
        );
        assert!(read_arc(root, "demo").unwrap().stopped.is_none());
    }

    /// **The horizon is two asks, counted over turns rather than ticks.**
    ///
    /// The arc's largest silent wedge: an implement turn that ends closing no
    /// step decided `None`, and every tick after it decided `None` too. No
    /// receipt, no gesture, no face — an unattended run simply stopped
    /// advancing and said nothing.
    ///
    /// The first quiet asked turn is now answered with a re-ask naming the
    /// open step, which is what gives the second count a legitimate path: a
    /// stage that ends a turn on a question is asked once more, and only a
    /// stage that declines a second *ask* is handed back.
    ///
    /// A tick fires on a changeset recompute as well as on a turn end, so the
    /// count must be over turns; this drives two sweeps against one turn count
    /// to prove a repeated tick is neither a repeated turn nor a second
    /// re-ask, then advances the count and takes the second quiet turn to the
    /// stop.
    #[tokio::test]
    async fn an_asked_turn_that_closes_nothing_is_re_asked_once_and_then_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        // The stage has closed step 1 and the arc has already acted on that
        // boundary: `last_done_count` equals the plan's count, so nothing on
        // this tick is a boundary.
        state.lock().await.insert(
            demo_key(root),
            ArcState {
                last_done_count: Some(1),
                prompt_turns_seen: Some(0),
                all_turns_seen: Some(0),
                ..Default::default()
            },
        );

        // Turn one ends quietly. The arc asks again rather than waiting.
        sweep(&ctx, &state).await;
        assert_eq!(
            state.lock().await[&demo_key(root)].quiet_turns,
            1,
            "one turn ended and closed nothing"
        );
        assert!(read_arc(root, "demo").unwrap().stopped.is_none());
        assert_eq!(
            submitted_asks(&entry).await,
            vec![
                "/tugplug:arc-implement demo Step 2 is still open: finish it, close it, and end the turn; it is the arc's last step"
                    .to_string()
            ],
            "the open step is named back to the stage that left it open",
        );

        // A second tick on the *same* turn is neither a second turn nor a
        // second re-ask.
        //
        // Read as an *idle* tick on purpose: the dispatch marked the turn
        // active, and a sweep held off by the idle gate would prove nothing
        // about the re-ask being spent once. This is the changeset recompute
        // landing between the re-ask and the turn that answers it, and
        // `reask_pending` is the only thing standing in its way.
        entry.lock().await.turn_active = false;
        sweep(&ctx, &state).await;
        assert_eq!(
            state.lock().await[&demo_key(root)].quiet_turns,
            1,
            "a tick is not a turn"
        );
        assert!(read_arc(root, "demo").unwrap().stopped.is_none());
        assert_eq!(
            submitted_asks(&entry).await.len(),
            1,
            "the re-ask is spent once, and the pending prompt is what says so",
        );

        // Turn two ends quietly too. That is the horizon.
        asked(&entry, 2).await;
        sweep(&ctx, &state).await;

        let record = read_arc(root, "demo").unwrap();
        assert_eq!(
            record.stopped,
            Some((ArcStage::Implement, "implement idle".to_string())),
            "the stop is written where every reader of the arc will find it"
        );
        assert_eq!(
            submitted_asks(&entry).await.len(),
            1,
            "the horizon's own answer is a stop with a receipt, never a third ask"
        );
    }

    /// **An idle session is never the clock's** ([P06]). Before this the
    /// stall deadline was a second answer to a stage that had ended one quiet
    /// turn — and the slower, wronger one: the horizon answers that stage in
    /// one turn with a re-ask, while the clock answered it half an hour later
    /// with a sentence about silence.
    ///
    /// The clock's one job is a turn that never ends, and this drives both
    /// halves against the same aged stamp: idle decides nothing, and the very
    /// same staleness with a turn in flight is the stop.
    #[tokio::test]
    async fn a_quiet_idle_session_is_not_stalled() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nidle_settle_secs = 0\narc_stall_secs = 1\n",
        )
        .unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        asked(&entry, 1).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        state.lock().await.insert(
            demo_key(root),
            ArcState {
                last_done_count: Some(1),
                prompt_turns_seen: Some(1),
                all_turns_seen: Some(1),
                // The re-ask is already out, so the horizon has nothing to say
                // either: whatever this sweep decides, the clock decided it.
                quiet_turns: 1,
                pending: Some(PendingPrompt {
                    kind: PromptKind::StillOpen { steps: (2, 2) },
                    turns_ended_at: 1,
                }),
                // Aged past the deadline rather than slept through.
                last_motion_at: Some(Instant::now() - Duration::from_secs(5)),
                ..Default::default()
            },
        );

        sweep(&ctx, &state).await;
        assert_eq!(
            read_arc(root, "demo").unwrap().stopped,
            None,
            "an idle reading has an edge, and the clock is not what judges it",
        );

        // The same staleness, now over a turn that is not ending. That is the
        // one shape the clock exists for.
        entry.lock().await.turn_active = true;
        state
            .lock()
            .await
            .get_mut(&demo_key(root))
            .unwrap()
            .last_motion_at = Some(Instant::now() - Duration::from_secs(5));
        sweep(&ctx, &state).await;

        assert_eq!(
            read_arc(root, "demo").unwrap().stopped,
            Some((ArcStage::Implement, "stalled".to_string())),
            "a turn that never ends is answered by the clock or by nothing at all",
        );
    }

    /// The re-ask goes on Tug's own record of what the wheel said, like every
    /// other prompt the arc sends — so a reload attributes it to the wheel
    /// rather than to the user who was not there.
    #[tokio::test]
    async fn the_re_ask_is_recorded_as_the_wheels_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        state.lock().await.insert(
            demo_key(root),
            ArcState {
                last_done_count: Some(1),
                prompt_turns_seen: Some(0),
                all_turns_seen: Some(0),
                ..Default::default()
            },
        );

        sweep(&ctx, &state).await;

        let sent = submitted(&entry).await;
        assert_eq!(sent.len(), 1, "the quiet turn was answered with a re-ask");
        assert!(
            sent[0].contains("Step 2 is still open"),
            "and it is the re-ask rather than the continue ask: {}",
            sent[0],
        );
        assert_eq!(
            ctx.session_ledger
                .list_wheel_prompts_for_line("claude-1")
                .unwrap(),
            sent,
            "what the record holds is exactly what went on the wire",
        );
    }

    /// A stop takes the running arc's memory with it, keeping only its marks.
    ///
    /// Every field the runner holds describes a stage that is being asked for
    /// turns. After a stop none of that is true, and each field left standing
    /// is a fact that can only get wronger: `last_motion_at` ages, so the
    /// clock's next read of it is a stall the stop already accounted for, and
    /// `quiet_turns` is at the horizon, so anything that does let a tick
    /// through re-stops immediately.
    #[tokio::test]
    async fn a_stop_evicts_every_memory_but_its_own_marks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        state.lock().await.insert(
            demo_key(root),
            ArcState {
                last_done_count: Some(1),
                prompt_turns_seen: Some(0),
                all_turns_seen: Some(0),
                ..Default::default()
            },
        );

        // Two quiet turns — the horizon, exactly as the test above drives it.
        sweep(&ctx, &state).await;
        asked(&entry, 2).await;
        sweep(&ctx, &state).await;
        assert!(
            read_arc(root, "demo").unwrap().stopped.is_some(),
            "the horizon stopped the arc",
        );

        let map = state.lock().await;
        let after = &map[&demo_key(root)];
        assert_eq!(after.last_motion_at, None, "the clock has nothing to age");
        assert_eq!(after.quiet_turns, 0, "no turns are held against a stop");
        assert_eq!(after.in_flight_at, None);
        assert_eq!(after.prompt_turns_seen, None);
        assert_eq!(after.all_turns_seen, None);
        assert_eq!(
            after.stop_marks,
            Some(StopMarks {
                wake_turns_ended: 0,
                done_count: 1,
            }),
            "the stop's own baseline is the one thing kept",
        );
    }

    /// **A user stop evicts the arc's memory** ([B06], [P11]) exactly as the
    /// wheel's stops do — through the same helper, on the wheel's own map.
    /// Before this the CONTROL-frame stop never touched the runner's state,
    /// so a stale clock, a quiet count at the horizon and a pending prompt all
    /// outlived the stop with no marks beside them.
    #[tokio::test]
    async fn a_user_stop_evicts_the_arcs_memory() {
        use super::super::agent_supervisor::StopTerms;

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Implement, "claude-1", None)
            .unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        // The supervisor's wheel is the runner's wheel, as `main.rs` wires it.
        let _ = ctx.supervisor.wheel.set(Arc::clone(&ctx.wheel));
        entry.lock().await.wake_turns_ended = 3;
        ctx.wheel.arc_memory.lock().await.insert(
            demo_key(root),
            ArcState {
                last_motion_at: Some(Instant::now() - Duration::from_secs(600)),
                quiet_turns: 2,
                pending: Some(PendingPrompt {
                    kind: PromptKind::Continue { steps: (2, 2) },
                    turns_ended_at: 1,
                }),
                last_done_count: Some(1),
                prompt_turns_seen: Some(1),
                all_turns_seen: Some(1),
                ..Default::default()
            },
        );

        ctx.supervisor
            .stop_arc_now(
                "claude-1",
                root,
                "demo",
                StopTerms {
                    stage: ArcStage::Implement,
                    reason: ArcStopReason::StoppedByUser,
                    question: None,
                    halt: false,
                },
            )
            .await
            .expect("the stop lands");

        let map = ctx.wheel.arc_memory.lock().await;
        let after = &map[&demo_key(root)];
        assert_eq!(after.last_motion_at, None, "the clock has nothing to age");
        assert_eq!(after.quiet_turns, 0, "no turns are held against a stop");
        assert!(after.pending.is_none(), "no prompt is waited on");
        assert_eq!(after.last_done_count, None);
        assert_eq!(after.prompt_turns_seen, None);
        assert_eq!(after.all_turns_seen, None);
        assert_eq!(
            after.stop_marks,
            Some(StopMarks {
                wake_turns_ended: 3,
                done_count: 1,
            }),
            "the marks are read from the entry and the ledger at stop time",
        );
    }

    /// **The incident itself, as the horizon sees it.** Six backgrounded
    /// commands completed, each re-invoking the model and each ending a turn;
    /// the runner counted six quiet turns against a stage that had been asked
    /// exactly once, and stopped an arc that was working.
    ///
    /// The horizon counts answers. Six wake-opened turn ends are no answers at
    /// all, so the count stands where the one ask left it, however many sweeps
    /// read the session in between.
    #[tokio::test]
    async fn a_wake_opened_turn_end_is_not_a_quiet_turn() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        state.lock().await.insert(
            demo_key(root),
            ArcState {
                last_done_count: Some(1),
                prompt_turns_seen: Some(0),
                all_turns_seen: Some(0),
                ..Default::default()
            },
        );

        // The one ask, ending quietly. That is the first quiet turn, and the
        // horizon's whole legitimate claim against this stage.
        asked(&entry, 1).await;
        sweep(&ctx, &state).await;
        assert_eq!(state.lock().await[&demo_key(root)].quiet_turns, 1);

        // Then the six background completions, each one a turn end and a
        // sweep. Under the old count this reached the horizon at the second.
        for _ in 0..6 {
            woke(&entry).await;
            sweep(&ctx, &state).await;
        }

        assert_eq!(
            state.lock().await[&demo_key(root)].quiet_turns,
            1,
            "six wakes are no answers, so the count stands where the one ask left it",
        );
        assert_eq!(
            read_arc(root, "demo").unwrap().stopped,
            None,
            "and the arc that was working is not stopped",
        );
    }

    /// The other half of [P02], and the reason the two counts cannot be one:
    /// a wake-opened turn end is not an *answer*, but it is unmistakably the
    /// arc **moving**. The clock reads every opener, so a stage whose only
    /// visible life is its background work is never called stalled.
    #[tokio::test]
    async fn a_wake_opened_turn_end_is_motion_for_the_clock() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nidle_settle_secs = 0\narc_stall_secs = 1\n",
        )
        .unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        asked(&entry, 1).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        state.lock().await.insert(
            demo_key(root),
            ArcState {
                last_done_count: Some(1),
                prompt_turns_seen: Some(1),
                all_turns_seen: Some(1),
                // Aged past the deadline rather than slept through it.
                last_motion_at: Some(Instant::now() - Duration::from_secs(5)),
                ..Default::default()
            },
        );

        // Nothing the stage was asked for has moved — only the harness's own
        // turn, which is exactly the reading the clock must accept.
        woke(&entry).await;
        sweep(&ctx, &state).await;

        assert_eq!(
            read_arc(root, "demo").unwrap().stopped,
            None,
            "a wake is motion, so the clock never ran out",
        );
        let map = state.lock().await;
        let after = &map[&demo_key(root)];
        assert!(
            after
                .last_motion_at
                .is_some_and(|at| at.elapsed() < Duration::from_secs(1)),
            "and the stamp moved to the wake rather than staying five seconds stale",
        );
    }

    /// The wedge the incident sat in overnight: the clock ran over a record
    /// that had already stopped, so the arc was re-stopped by a silence its
    /// own stop had caused.
    #[tokio::test]
    async fn the_clock_is_never_read_on_a_stopped_record() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nidle_settle_secs = 0\narc_stall_secs = 1\n",
        )
        .unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();
        tugarc_core::arc::append_arc_stop(root, "demo", ArcStage::Devise, ArcStopReason::Stalled)
            .unwrap();

        let (ctx, _entry, _register_rx) = harness(root).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        // The entry a stop leaves behind: no clock, and marks.
        state.lock().await.insert(
            demo_key(root),
            ArcState {
                stop_marks: Some(StopMarks::default()),
                ..Default::default()
            },
        );

        let stops_before = arc_stop_lines(root);
        sweep(&ctx, &state).await;
        sweep(&ctx, &state).await;

        assert_eq!(
            arc_stop_lines(root),
            stops_before,
            "a stopped arc is never stopped a second time",
        );
        assert_eq!(
            state.lock().await[&demo_key(root)].last_motion_at,
            None,
            "no tick stamped motion on a record that had already ended",
        );
    }

    /// **The incident's morning.** The arc stopped the evening before, the
    /// clock's deadline ran out over the stopped record all night, and the
    /// user pressed Resume. The resume must win: the staleness is a fact
    /// about the silence the stop itself caused, and re-stopping on it is
    /// what undid both of the user's presses within 160 ms.
    #[tokio::test]
    async fn a_resume_after_a_stale_clock_is_answered_and_never_re_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        std::fs::write(root.join(".tug/arcs/demo/plan.md"), LINTING_PLAN).unwrap();
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nidle_settle_secs = 0\narc_stall_secs = 1\n",
        )
        .unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/brief.md").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();
        tugarc_core::arc::append_arc_stop(root, "demo", ArcStage::Review, ArcStopReason::Stalled)
            .unwrap();
        // The press. `arc-resume` clears the stop and names the stage to run
        // again, so the tick that follows reads a live record with a stale
        // clock behind it — the exact pairing the arm order settles.
        tugarc_core::arc::append_arc_resume(root, "demo", ArcStage::Review).unwrap();

        let (ctx, _entry, _register_rx) = harness(root).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        // Overnight. Aged rather than slept through.
        state.lock().await.insert(
            demo_key(root),
            ArcState {
                last_motion_at: Some(Instant::now() - Duration::from_secs(5)),
                ..Default::default()
            },
        );

        sweep(&ctx, &state).await;

        assert!(
            arc_log_markers(root)
                .iter()
                .any(|line| line == "arc-continue  review"),
            "the resume was answered on the stage's own card: {:?}",
            arc_log_markers(root),
        );
        assert!(
            read_arc(root, "demo").unwrap().stopped.is_none(),
            "the stale clock never got to re-stop the arc the user just resumed",
        );
    }

    /// **A resume keeps the session the stage was working on** ([P08]).
    ///
    /// The incident's resume rotated, and a rotation is a fresh session: the
    /// press cost the stage the entire working context it had built before it
    /// was wrongly stopped. When the card is still the stage's own, there is
    /// nothing to replace — the stage is asked again, on its own card, with
    /// its own model put back and the fact that it is resuming in the prompt.
    #[tokio::test]
    async fn a_resume_on_a_live_stage_session_keeps_the_session() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");
        tugarc_core::arc::append_arc_stop(
            root,
            "demo",
            ArcStage::Implement,
            ArcStopReason::ImplementIdle,
        )
        .unwrap();
        tugarc_core::arc::append_arc_resume(root, "demo", ArcStage::Implement).unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        let state = Arc::new(Mutex::new(HashMap::new()));

        sweep(&ctx, &state).await;

        assert!(
            !arc_log_markers(root)
                .iter()
                .any(|line| line.starts_with("arc-dispatch")),
            "nothing was rotated: {:?}",
            arc_log_markers(root),
        );
        assert_eq!(
            arc_log_markers(root)
                .iter()
                .filter(|line| *line == "arc-continue  implement")
                .count(),
            1,
            "the arc says out loud that the stage was picked back up in place",
        );

        let frames = drained(&entry).await;
        let models: Vec<&str> = frames
            .iter()
            .filter(|frame| frame["type"] == "model_change")
            .filter_map(|frame| frame["model"].as_str())
            .collect();
        assert_eq!(
            models,
            vec!["default"],
            "the stage's model went back on the card the stop had handed to the deck",
        );

        let sent: Vec<&str> = frames
            .iter()
            .filter(|frame| frame["type"] == "user_message")
            .filter_map(|frame| frame["content"][0]["text"].as_str())
            .collect();
        assert_eq!(sent.len(), 1, "one ask, on the session it was already on");
        let mut lines = sent[0].split("\n\n");
        assert_eq!(
            lines.next(),
            Some(
                "/tugplug:arc-implement demo implement Step 2 and end the turn; it is the arc's last step"
            ),
        );
        assert!(
            lines.next().is_some_and(|line| line.starts_with("where: ")
                && line.ends_with("· stage implement · Step 2 in hand, through 2")),
            "the where clause carries the step the resume is picking up: {}",
            sent[0],
        );
        assert_eq!(
            lines.next(),
            Some("this arc was stopped in implement — implement idle; it is resuming"),
            "and the stage is told what it is resuming from, which `stopped` no longer holds",
        );
    }

    /// **A rotated resume is told it is resuming** ([P08], [F12]). Every act
    /// that picks a stopped arc back up clears `stopped` before the runner
    /// composes — the `arc-resume` line does it — so the rotation path, which
    /// read that field, dropped the clause on exactly the prompts it exists
    /// for. `last_stop` is the field kept for the generation, and it is what a
    /// resumed stage is owed: the difference between starting the work and
    /// picking it back up.
    #[test]
    fn a_rotated_resume_is_told_it_is_resuming() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".tug/arcs/demo")).unwrap();
        std::fs::write(root.join(".tug/arcs/demo/plan.md"), LINTING_PLAN).unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/plan.md").unwrap();
        tugarc_core::arc::append_arc_stop(
            root,
            "demo",
            ArcStage::Implement,
            ArcStopReason::StoppedByUser,
        )
        .unwrap();
        tugarc_core::arc::append_arc_resume(root, "demo", ArcStage::Implement).unwrap();

        let reading = read(
            root,
            "demo",
            &snapshot(true, true, None),
            TickMemory::default(),
        )
        .unwrap();
        assert!(
            reading.record.stopped.is_none(),
            "the post-`arc-resume` shape: the field the rotation used to read is already clear",
        );
        let prompt = opening_prompt(
            &reading,
            &Rotation {
                stage: ArcStage::Implement,
                steps: Some((1, 2)),
                note: None,
            },
            &bound(root, "demo"),
            &tugarc_core::ops::worktree_path(root, "demo"),
            None,
        )
        .expect("a prompt");
        assert!(
            prompt.contains("this arc was stopped in implement — stopped by user; it is resuming"),
            "{prompt}",
        );
    }

    /// **And an ordinary rotation after that resume is not.** `last_stop` is
    /// kept for the whole generation, so an arc stopped once carries it into
    /// every rotation afterwards; a clause read straight off it would tell a
    /// stage rotated long after the arc was picked back up that it is
    /// resuming from a stop somebody already resumed from. The standing
    /// `resume` is what says this rotation is the picking up, and the
    /// `arc-stage` line the resumed rotation produced is what clears it.
    #[test]
    fn a_rotation_after_a_resume_is_not_told_it_is_resuming() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".tug/arcs/demo")).unwrap();
        std::fs::write(root.join(".tug/arcs/demo/plan.md"), LINTING_PLAN).unwrap();
        tugarc_core::arc::append_arc_start(root, "demo", ".tug/arcs/demo/plan.md").unwrap();
        tugarc_core::arc::append_arc_stop(
            root,
            "demo",
            ArcStage::Implement,
            ArcStopReason::StoppedByUser,
        )
        .unwrap();
        tugarc_core::arc::append_arc_resume(root, "demo", ArcStage::Implement).unwrap();
        // The rotation the resume asked for lands, which clears `resume` and
        // leaves `last_stop` standing for the rest of the generation.
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Implement, "sess-1", None)
            .unwrap();

        let reading = read(
            root,
            "demo",
            &snapshot(true, true, None),
            TickMemory::default(),
        )
        .unwrap();
        assert!(
            reading.record.last_stop.is_some(),
            "the history the clause would have been read off is still there",
        );
        let prompt = opening_prompt(
            &reading,
            &Rotation {
                stage: ArcStage::Audit,
                steps: None,
                note: None,
            },
            &bound(root, "demo"),
            &tugarc_core::ops::worktree_path(root, "demo"),
            None,
        )
        .expect("a prompt");
        assert!(!prompt.contains("it is resuming"), "{prompt}");
    }

    /// The dirty clause names ten paths and counts the rest. A stage stopped
    /// mid-rename leaves two hundred behind, and a prompt that listed them all
    /// would bury the ask under its own footnote.
    #[test]
    fn a_long_dirty_list_is_capped() {
        let paths: Vec<String> = (1..=11).map(|n| format!("src/f{n}.rs")).collect();
        let clause = dirty_clause(paths).expect("a dirty tree has a clause");
        assert_eq!(clause.matches("src/f").count(), 10, "{clause}");
        assert!(clause.ends_with(" and 1 more"), "{clause}");

        assert_eq!(
            dirty_clause(vec!["src/a.rs".to_string()]).as_deref(),
            Some("src/a.rs"),
            "a short list is named in full, with nothing counted",
        );
        assert_eq!(dirty_clause(Vec::new()), None, "a clean tree has no clause");
    }

    /// A project shaped exactly like [`implementing_project`], with one thing
    /// missing: the `arc-start` line, and so the document it records.
    ///
    /// The one way to reach a record whose `document` is `None` — the fold
    /// sets the field from that line's note and from nowhere else.
    fn implementing_project_without_a_document(root: &Path) {
        git_project(root);
        project_with_document(root, ".tug/arcs/demo/brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nidle_settle_secs = 0\nimplement_compact_tokens = 300000\n",
        )
        .unwrap();
        std::fs::write(
            root.join(".tug/arcs/demo/plan.md"),
            plan_with_statuses("done", "pending"),
        )
        .unwrap();
        tugarc_core::arc::append_arc_plan(root, "demo", ".tug/arcs/demo/plan.md").unwrap();
        tugarc_core::log::append_arc_log(root, "demo", "run-through", "2").unwrap();
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Implement, "claude-1", None)
            .unwrap();
    }

    /// A stopped, resumed implement arc whose table claims a round the log
    /// cannot corroborate: step 1 reads `done` with an empty commit cell.
    ///
    /// A disagreement that is **not** one of the three half-walked-step
    /// findings, which is the point — those three a resume excludes, and a
    /// test written over one of them would prove nothing about the stop.
    fn resumed_arc_whose_records_disagree(root: &Path) {
        implementing_project(root, "done", "pending");
        // A declared stage model, so the `model_change` a continue would send
        // is nameable apart from the `default` a stop's hand-back sends.
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nidle_settle_secs = 0\nimplement_compact_tokens = 300000\n\
             implement_model = \"sonnet\"\n",
        )
        .unwrap();
        let plan = std::fs::read_to_string(root.join(".tug/arcs/demo/plan.md")).unwrap();
        std::fs::write(
            root.join(".tug/arcs/demo/plan.md"),
            plan.replace("| done | `abc1234` |", "| done | — |"),
        )
        .unwrap();
        tugarc_core::arc::append_arc_stop(
            root,
            "demo",
            ArcStage::Implement,
            ArcStopReason::ImplementIdle,
        )
        .unwrap();
        tugarc_core::arc::append_arc_resume(root, "demo", ArcStage::Implement).unwrap();
    }

    /// **The continue path reads the records too** ([P07]). A resumed stage is
    /// handed the same `where` line a rotated one is, and the skill tells it
    /// the runner ran the doctor's comparison immediately before composing it.
    /// That was true of the rotation and false of the continue, so a resume
    /// onto a desynced record asked a stage to work from a frontier the
    /// surfaces do not share.
    #[tokio::test]
    async fn a_continue_over_disagreeing_records_stops_rather_than_asking() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        resumed_arc_whose_records_disagree(root);

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        sweep(&ctx, &state).await;

        let record = tugarc_core::read_arc(root, "demo").expect("the arc record");
        let (_, reason) = record.stopped.expect("a stop");
        assert_eq!(reason, ArcStopReason::RecordsDisagree.as_str());
        let sent: Vec<serde_json::Value> = drained(&entry).await;
        assert!(
            !sent.iter().any(|frame| frame["type"] == "user_message"),
            "no stage was asked anything: {sent:?}",
        );
        assert!(
            record
                .notes
                .last()
                .is_some_and(|note| note.contains("empty commit cell")),
            "{:?}",
            record.notes,
        );
    }

    /// **And it stops before it records anything** ([P07]). The continue path
    /// appends `arc-continue` and swaps the card back onto the stage's model
    /// *before* it seats, and the `arc-continue` line clears `stopped` and
    /// `resume` as it goes — so a doctor dropped in where the prompt is
    /// composed would leave a stopped arc carrying a continue that never
    /// happened, on a card already wearing a model nobody is driving. This is
    /// the pin for the order, and the one that fails if the doctor moves.
    #[tokio::test]
    async fn a_continue_that_stops_on_the_doctor_records_no_continue() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        resumed_arc_whose_records_disagree(root);

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        sweep(&ctx, &state).await;

        assert!(
            !arc_log_markers(root)
                .iter()
                .any(|line| line.starts_with("arc-continue")),
            "no continue was recorded: {:?}",
            arc_log_markers(root),
        );
        let sent = drained(&entry).await;
        assert!(
            !sent
                .iter()
                .any(|frame| frame["type"] == "model_change" && frame["model"] == "sonnet"),
            "and the card was not put back on the stage's model: {sent:?}",
        );
    }

    /// **The stage's own session re-enters its open row** ([P07]). It has a
    /// transcript that knows what it changed, and `arc step start` accepts a
    /// re-entry idempotently — so the row it was working stands, and the
    /// half-walked-step findings are the interruption being resumed from
    /// rather than a disagreement to stop over.
    #[tokio::test]
    async fn a_continue_over_an_open_step_re_enters_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "in progress", "pending");
        tugarc_core::arc::append_arc_stop(
            root,
            "demo",
            ArcStage::Implement,
            ArcStopReason::StoppedByUser,
        )
        .unwrap();
        tugarc_core::arc::append_arc_resume(root, "demo", ArcStage::Implement).unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        sweep(&ctx, &state).await;

        let record = tugarc_core::read_arc(root, "demo").expect("the arc record");
        assert!(record.stopped.is_none(), "the arc was not stopped again");
        assert!(
            arc_log_markers(root)
                .iter()
                .any(|line| line == "arc-continue  implement"),
            "the stage was picked back up in place: {:?}",
            arc_log_markers(root),
        );
        assert_eq!(
            ledger_status(root, "step-1"),
            "in progress",
            "and its open row was left exactly as it was",
        );
    }

    /// **A rotated resume is handed a `pending` row instead** ([P07]). The
    /// session about to be seated has never seen this arc and cannot know what
    /// the interrupted one had already changed, so a row reading `in progress`
    /// would be a claim it has no way to stand behind. It is parked, and
    /// walked again from the top.
    #[tokio::test]
    async fn a_rotated_resume_resets_an_open_step_to_pending() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "in progress", "pending");
        tugarc_core::arc::append_arc_stop(
            root,
            "demo",
            ArcStage::Implement,
            ArcStopReason::StoppedByUser,
        )
        .unwrap();
        tugarc_core::arc::append_arc_resume(root, "demo", ArcStage::Implement).unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        // Another claude on the card: the record's session is not this one, so
        // the resume is a rotation rather than a continue.
        entry.lock().await.claude_session_id = Some("claude-2".to_string());
        set_context(&entry, 100_000).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        sweep(&ctx, &state).await;

        let record = tugarc_core::read_arc(root, "demo").expect("the arc record");
        assert!(record.stopped.is_none(), "the arc was not stopped");
        assert_eq!(
            ledger_status(root, "step-1"),
            "pending",
            "the half-walked row was parked for the session that inherits it",
        );
    }

    /// **A continue over a missing document stops, as a rotation does.** The
    /// ask would be composed against nothing, and a stage asked to work on a
    /// document that is not there is worse off than one told the arc stopped.
    #[tokio::test]
    async fn a_continue_over_a_missing_document_stops() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project_without_a_document(root);
        tugarc_core::arc::append_arc_stop(
            root,
            "demo",
            ArcStage::Implement,
            ArcStopReason::StoppedByUser,
        )
        .unwrap();
        tugarc_core::arc::append_arc_resume(root, "demo", ArcStage::Implement).unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        sweep(&ctx, &state).await;

        let record = tugarc_core::read_arc(root, "demo").expect("the arc record");
        let (_, reason) = record.stopped.expect("a stop");
        assert_eq!(reason, ArcStopReason::DocumentMissing.as_str());
        assert!(
            !arc_log_markers(root)
                .iter()
                .any(|line| line.starts_with("arc-continue")),
            "and nothing was recorded before the stop: {:?}",
            arc_log_markers(root),
        );
    }

    /// The status cell a ledger row carries, read back off the plan.
    fn ledger_status(root: &Path, anchor: &str) -> String {
        let source = std::fs::read_to_string(root.join(".tug/arcs/demo/plan.md")).unwrap();
        tugtool_core::plan::parse(&source)
            .expect("the plan parses")
            .ledger_rows
            .iter()
            .find(|row| row.anchor == anchor)
            .unwrap_or_else(|| panic!("no {anchor} row"))
            .status
            .clone()
    }

    /// How many `arc-stop` lines the arc log holds — the record every later
    /// reader learns a stop from, so a second one is a second stop.
    fn arc_stop_lines(root: &Path) -> usize {
        std::fs::read_to_string(tugtool_core::paths::arc_log_path(root))
            .unwrap_or_default()
            .lines()
            .filter(|line| line.contains("  arc-stop  "))
            .count()
    }

    /// Every marker the arc log holds, in order — the record itself, which is
    /// what a reversal has to get right rather than merely leave a receipt for.
    ///
    /// A line is `<iso>  <arc>  <marker>  <note>`, two spaces between fields;
    /// this drops the timestamp and the arc, which are the same on every line
    /// a test writes, and keeps the pair that says what happened.
    fn arc_log_markers(root: &Path) -> Vec<String> {
        std::fs::read_to_string(tugtool_core::paths::arc_log_path(root))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| {
                let mut fields = line.splitn(4, "  ");
                let _timestamp = fields.next()?;
                let _arc = fields.next()?;
                let marker = fields.next()?;
                let note = fields.next().unwrap_or_default();
                Some(format!("{marker}  {note}"))
            })
            .collect()
    }

    /// Drive an implementing arc to the horizon's stop, and hand back the
    /// state map the stop left its marks in.
    ///
    /// The reversal reads those marks and nothing else, so a test that seeded
    /// a stopped record by hand would be testing a shape the runner cannot
    /// produce: a stop this process did not watch leaves no baseline, and the
    /// reversal correctly declines it.
    async fn stopped_at_the_horizon(
        ctx: &ArcContext,
        entry: &Arc<Mutex<super::super::agent_supervisor::LedgerEntry>>,
        root: &Path,
    ) -> Arc<Mutex<HashMap<String, ArcState>>> {
        set_context(entry, 100_000).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        state.lock().await.insert(
            demo_key(root),
            ArcState {
                last_done_count: Some(1),
                prompt_turns_seen: Some(0),
                all_turns_seen: Some(0),
                ..Default::default()
            },
        );
        asked(entry, 1).await;
        sweep(ctx, &state).await;
        asked(entry, 2).await;
        sweep(ctx, &state).await;
        assert!(
            read_arc(root, "demo").unwrap().stopped.is_some(),
            "the horizon stopped the arc, which is what the reversal undoes",
        );
        state
    }

    /// **The incident's ninety-six seconds, end to end.** The arc was stopped
    /// as `implement idle` at 20:26:23; step 4 of 7 closed at 20:27:59, on the
    /// stage's own session, and nothing read it. The step closing now picks the
    /// arc back up: the record says so, the card goes back on the stage's
    /// model, and the transcript carries a row saying which fact undid the
    /// stop.
    #[tokio::test]
    async fn a_step_closing_on_a_stopped_arc_picks_it_back_up() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nidle_settle_secs = 0\nimplement_model = \"fable\"\n",
        )
        .unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        let mut control_rx = ctx.supervisor.control_tx.subscribe();
        let state = stopped_at_the_horizon(&ctx, &entry, root).await;
        let _ = receipts(&mut control_rx);
        let _ = drained(&entry).await;

        // The step the stage was working on all along closes.
        std::fs::write(
            root.join(".tug/arcs/demo/plan.md"),
            plan_with_statuses("done", "done"),
        )
        .unwrap();
        sweep(&ctx, &state).await;

        let markers = arc_log_markers(root);
        let tail: Vec<&str> = markers
            .iter()
            .rev()
            .take(3)
            .rev()
            .map(String::as_str)
            .collect();
        assert_eq!(
            tail,
            vec![
                "arc-note  picked back up: a step closed",
                "arc-resume  implement",
                "arc-continue  implement",
            ],
            "the note says what moved, the resume clears the stop, the continue clears the resume",
        );

        let record = read_arc(root, "demo").unwrap();
        assert_eq!(record.stopped, None, "the arc is running again");
        assert_eq!(
            record.resume, None,
            "and owed no rotation: the stage is already seated",
        );

        let frames = drained(&entry).await;
        assert_eq!(frames.len(), 1, "one model_change, got {frames:?}");
        assert_eq!(frames[0]["type"], "model_change");
        assert_eq!(
            frames[0]["model"], "fable",
            "the card goes back on the stage's model, not the deck's",
        );

        let said = receipts(&mut control_rx);
        assert_eq!(said.len(), 1, "one receipt, got {said:?}");
        assert_eq!(
            said[0],
            "arc picked back up · demo · in implement · a step closed",
        );
    }

    /// **A picked-back-up arc walks on**, which is the whole claim the
    /// reversal makes: the receipt says there is nothing to resume because it
    /// already did.
    ///
    /// The step that undid the stop is the step the wheel owes a continue
    /// prompt for, and the stop was the only reason nobody sent one. A
    /// reversal that recorded the current done-count would spend that
    /// boundary on itself, leaving an arc that is not stopped, is not clocked
    /// (an idle session is never the clock's, [P06]), and is never asked for
    /// anything again — a worse ending than the wrong stop it replaced,
    /// because it leaves no receipt at all.
    #[tokio::test]
    async fn a_reversed_arc_walks_on_from_the_step_that_undid_the_stop() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "pending", "pending");

        let (ctx, entry, _register_rx) = harness(root).await;
        let mut control_rx = ctx.supervisor.control_tx.subscribe();
        set_context(&entry, 100_000).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        state.lock().await.insert(
            demo_key(root),
            ArcState {
                last_done_count: Some(0),
                prompt_turns_seen: Some(0),
                all_turns_seen: Some(0),
                ..Default::default()
            },
        );
        asked(&entry, 1).await;
        sweep(&ctx, &state).await;
        asked(&entry, 2).await;
        sweep(&ctx, &state).await;
        assert!(read_arc(root, "demo").unwrap().stopped.is_some(), "stopped");
        let _ = receipts(&mut control_rx);
        let _ = drained(&entry).await;

        std::fs::write(
            root.join(".tug/arcs/demo/plan.md"),
            plan_with_statuses("done", "pending"),
        )
        .unwrap();
        sweep(&ctx, &state).await;
        assert_eq!(read_arc(root, "demo").unwrap().stopped, None, "reversed");

        // The stage is seated, idle, and between steps. The next tick reads
        // the close the way it would have read it had the stop never
        // happened, and the ticks after it have nothing left to say.
        sweep(&ctx, &state).await;
        sweep(&ctx, &state).await;
        let asks = submitted_asks(&entry).await;
        assert_eq!(asks.len(), 1, "one continue ask, got {asks:?}");
        assert!(
            asks[0].starts_with("/tugplug:arc-implement demo implement Step 2"),
            "for the step the reversal left open, got {asks:?}",
        );
    }

    /// And a stage that goes quiet *after* a pick-up is still counted.
    ///
    /// The horizon is the only thing left watching an idle session ([P06]),
    /// and it counts a turn ending only against a count the previous tick
    /// already held. Clearing that count at the reversal — as a rotation
    /// clears it, for a session that genuinely starts over — would make the
    /// next turn end the tick that seeds it, so the first quiet turn after a
    /// pick-up would be the one nobody counted.
    #[tokio::test]
    async fn a_quiet_turn_after_a_pick_up_is_counted() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");

        let (ctx, entry, _register_rx) = harness(root).await;
        let state = stopped_at_the_horizon(&ctx, &entry, root).await;

        woke(&entry).await;
        sweep(&ctx, &state).await;
        assert_eq!(
            read_arc(root, "demo").unwrap().stopped,
            None,
            "picked back up",
        );
        let _ = drained(&entry).await;

        // One asked turn ends, closing nothing. The horizon answers it.
        asked(&entry, 3).await;
        sweep(&ctx, &state).await;
        let asks = submitted_asks(&entry).await;
        assert_eq!(asks.len(), 1, "one re-ask, got {asks:?}");
        assert!(
            asks[0].contains("Step 2 is still open"),
            "the re-ask names the open step, got {asks:?}",
        );
    }

    /// The same reversal from the other fact: a wake ending a turn on the
    /// stopped stage's session. The plan has not moved, so the only thing
    /// saying the stage is alive is the harness re-invoking it — which is
    /// precisely the signal the horizon used to read as death.
    #[tokio::test]
    async fn a_wake_on_a_stopped_arc_picks_it_back_up() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");

        let (ctx, entry, _register_rx) = harness(root).await;
        let mut control_rx = ctx.supervisor.control_tx.subscribe();
        let state = stopped_at_the_horizon(&ctx, &entry, root).await;
        let _ = receipts(&mut control_rx);

        woke(&entry).await;
        sweep(&ctx, &state).await;

        assert_eq!(read_arc(root, "demo").unwrap().stopped, None);
        let said = receipts(&mut control_rx);
        assert_eq!(
            said,
            vec!["arc picked back up · demo · in implement · a wake on its session".to_string()],
        );
    }

    /// The stop's row is not erased. It happened, and a transcript that
    /// removed it would be lying about a minute of the arc's life — the
    /// superseding pass folds the older row, and folding needs both.
    #[tokio::test]
    async fn the_stop_receipt_and_the_pickup_receipt_are_two_rows() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");

        let (ctx, entry, _register_rx) = harness(root).await;
        let mut control_rx = ctx.supervisor.control_tx.subscribe();
        let state = stopped_at_the_horizon(&ctx, &entry, root).await;

        woke(&entry).await;
        sweep(&ctx, &state).await;

        let said = receipts(&mut control_rx);
        assert_eq!(said.len(), 2, "two rows, got {said:?}");
        assert!(
            said[0].starts_with("arc stopped · demo · in implement"),
            "{said:?}"
        );
        assert!(
            said[1].starts_with("arc picked back up · demo · in implement"),
            "{said:?}"
        );
    }

    /// **The guard** ([P11]). The incident's morning undid two Resume
    /// presses within 160 ms each, because the stall clock outranked the resume
    /// and the runner's memory outlived the stop. A resume followed by a clock
    /// long since run out must produce no second stop — and the settle is what
    /// makes the window this test drives a real one rather than a lucky
    /// ordering.
    #[tokio::test]
    async fn a_resume_is_never_re_stopped_within_the_settle() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.arc]\nidle_settle_secs = 5\narc_stall_secs = 1\n",
        )
        .unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        tugarc_core::arc::append_arc_stop(
            root,
            "demo",
            ArcStage::Implement,
            ArcStopReason::ImplementIdle,
        )
        .unwrap();
        tugarc_core::arc::append_arc_resume(root, "demo", ArcStage::Implement).unwrap();
        assert_eq!(arc_stop_lines(root), 1, "the stop this test starts from");

        let state = Arc::new(Mutex::new(HashMap::new()));
        sweep(&ctx, &state).await;
        // The overnight clock: a deadline that ran out over a silence the stop
        // had already accounted for.
        {
            let mut map = state.lock().await;
            for entry in map.values_mut() {
                entry.last_motion_at = Some(Instant::now() - Duration::from_secs(600));
            }
        }
        sweep(&ctx, &state).await;
        sweep(&ctx, &state).await;

        assert_eq!(
            arc_stop_lines(root),
            1,
            "the arc the user just resumed is never stopped a second time",
        );
    }

    /// A turn that closes a step clears the count, so a stage that goes quiet,
    /// recovers, and goes quiet again gets the whole horizon back.
    ///
    /// This is also the reopened-step case W3 left for this workstream: a
    /// re-walk of a reopened step is indistinguishable from a first walk to
    /// the runner, and it must be — what clears the count is the boundary,
    /// whichever walk produced it.
    #[tokio::test]
    async fn a_closed_step_clears_the_quiet_count() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        state.lock().await.insert(
            demo_key(root),
            ArcState {
                last_done_count: Some(1),
                prompt_turns_seen: Some(0),
                all_turns_seen: Some(0),
                ..Default::default()
            },
        );

        sweep(&ctx, &state).await;
        assert_eq!(state.lock().await[&demo_key(root)].quiet_turns, 1);

        // The stage closes step 2 and ends its turn.
        std::fs::write(
            root.join(".tug/arcs/demo/plan.md"),
            plan_with_statuses("done", "done"),
        )
        .unwrap();
        asked(&entry, 2).await;
        sweep(&ctx, &state).await;

        assert_eq!(
            state.lock().await[&demo_key(root)].quiet_turns,
            0,
            "a boundary is the opposite of a quiet turn"
        );
        assert!(
            read_arc(root, "demo").unwrap().stopped.is_none(),
            "and the arc is walking on, not stopped"
        );
    }

    #[tokio::test]
    async fn a_prompt_is_an_opener_and_a_submission_in_that_order() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");

        let (ctx, entry, _register_rx) = harness(root).await;
        // Above the declared 300,000.
        set_context(&entry, 350_000).await;
        let mut opener = ctx.supervisor.code_output.subscribe();
        let state = Arc::new(Mutex::new(HashMap::new()));
        state.lock().await.insert(
            demo_key(root),
            ArcState {
                last_done_count: Some(0),
                ..Default::default()
            },
        );

        sweep(&ctx, &state).await;

        let frame = opener.try_recv().expect("the opener is published first");
        let notice: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(notice["type"], "tug_notice");
        assert_eq!(notice["origin"], "wheel");
        assert_eq!(notice["text"], "/compact");
        assert_eq!(submitted(&entry).await, vec!["/compact".to_string()]);
    }

    #[tokio::test]
    async fn a_compaction_writes_the_arc_log_line_and_the_arc_note() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 350_000).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        state.lock().await.insert(
            demo_key(root),
            ArcState {
                last_done_count: Some(0),
                ..Default::default()
            },
        );

        sweep(&ctx, &state).await;

        let record = read_arc(root, "demo").unwrap();
        assert_eq!(
            record.notes.last().map(String::as_str),
            Some("compacted at 350000 > 300000")
        );
        // The new marker moves no declaration: a reader that dates an arc from
        // every line is untroubled, and `read_arc` never learns the word.
        let declarations = tugarc_core::log::read_declarations(root, "demo");
        assert_eq!(declarations.run_through, Some(2));
        assert!(!declarations.run_complete);

        let log = std::fs::read_to_string(
            tugtool_core::paths::project_state_dir(root).join(tugtool_core::paths::ARC_LOG),
        )
        .unwrap();
        let compact = log
            .lines()
            .filter_map(tugarc_core::log::split_log_line)
            .find(|(_, _, marker, _)| *marker == "compact")
            .expect("a compact line");
        assert_eq!(compact.1, "demo");
        assert_eq!(compact.3, "350000 > 300000");
    }

    /// The threshold is a token count and nothing else: the harness declares a
    /// million-token model, and two readings either side of 300,000 say that
    /// the model's own capacity does not enter into it.
    #[tokio::test]
    async fn the_threshold_is_read_in_tokens_not_as_a_share_of_the_window() {
        for (used, compacts) in [(250_000_i64, false), (310_000, true)] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            implementing_project(root, "done", "pending");

            let (ctx, entry, _register_rx) = harness(root).await;
            set_context(&entry, used).await;
            let state = Arc::new(Mutex::new(HashMap::new()));
            state.lock().await.insert(
                demo_key(root),
                ArcState {
                    last_done_count: Some(0),
                    ..Default::default()
                },
            );

            sweep(&ctx, &state).await;

            let sent = submitted(&entry).await;
            assert_eq!(
                sent.first().map(String::as_str) == Some("/compact"),
                compacts,
                "at {used} of a million-token window the arc sent {sent:?}"
            );
        }
    }

    #[tokio::test]
    async fn two_sweeps_on_one_idle_reading_prompt_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 350_000).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        state.lock().await.insert(
            demo_key(root),
            ArcState {
                last_done_count: Some(0),
                ..Default::default()
            },
        );

        sweep(&ctx, &state).await;
        // The prompt opened a turn, so the next tick would read mid-turn on
        // its own. End it, leaving the moved done count as the only thing
        // that can stop a second prompt.
        entry.lock().await.turn_active = false;
        sweep(&ctx, &state).await;

        assert_eq!(
            submitted(&entry).await,
            vec!["/compact".to_string()],
            "the deciding tick moved the done count, so the second reads no boundary"
        );
    }

    #[tokio::test]
    async fn a_compact_turn_that_ended_continues_or_rotates_by_the_new_reading() {
        for (used, expected) in [(100_000_i64, "continue"), (425_000, "rotate")] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            implementing_project(root, "done", "pending");

            let (ctx, entry, _register_rx) = harness(root).await;
            set_context(&entry, used).await;
            // The compact turn has ended: the count has moved past the mark.
            asked(&entry, 2).await;
            let state = Arc::new(Mutex::new(HashMap::new()));
            state.lock().await.insert(
                demo_key(root),
                ArcState {
                    last_done_count: Some(1),
                    compacted_since_below: true,
                    pending: Some(PendingPrompt {
                        kind: PromptKind::Compact,
                        turns_ended_at: 1,
                    }),
                    ..Default::default()
                },
            );

            sweep(&ctx, &state).await;

            match expected {
                "continue" => assert_eq!(
                    submitted_asks(&entry).await,
                    vec![
                "/tugplug:arc-implement demo implement Step 2 and end the turn; it is the arc's last step"
                    .to_string()
            ],
                    "a window the compaction brought down keeps its session"
                ),
                _ => {
                    assert!(
                        !submitted(&entry)
                            .await
                            .contains(&"/compact".to_string()),
                        "the window is already compacted; the answer is a fresh session"
                    );
                    assert!(
                        state.lock().await[&demo_key(root)].in_flight_at.is_some(),
                        "the rotation was dispatched"
                    );
                }
            }
        }
    }

    /// The wedge of 2026-09-04: a compaction whose end fell inside a settle
    /// window left the arc with nothing to decide on ever again.
    ///
    /// The whole sequence, because no shorter one shows it — a step closing,
    /// the settle, the `/compact` the arc sent, that turn ending, **a
    /// changeset tick inside the settle window**, and the re-sweep. That
    /// inside-the-window tick is the load-bearing line: a test that ticks once
    /// and ages the settle passes on the code that wedged, because the tick
    /// which derived `compact_turn_just_ended` was also the one that acted.
    /// The rule under test is the gate's own — a withheld reading is an unspent
    /// one — applied to the compaction's record as it already is to
    /// `last_done_count`.
    #[tokio::test]
    async fn a_compaction_inside_the_settle_still_prompts_the_stage_on() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");
        with_settle(root, 5);

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 350_000).await;
        // The step's own turn has ended; the boundary is what the first sweep
        // reads.
        asked(&entry, 1).await;
        let state = settling_state(root);

        // The step boundary, held for the settle and then spent on the
        // compaction.
        sweep(&ctx, &state).await;
        age_the_settle(&state, Duration::from_secs(6)).await;
        sweep(&ctx, &state).await;
        assert_eq!(
            submitted(&entry).await,
            vec!["/compact".to_string()],
            "the boundary above the threshold is answered by a compaction"
        );

        // The compaction ran and its turn ended, with a reading that came down.
        asked(&entry, 2).await;
        set_context(&entry, 120_000).await;

        // The tick that reads the compaction's end decides a continue, and the
        // settle holds it — a new window over a session whose counts moved.
        sweep(&ctx, &state).await;
        assert_eq!(
            submitted(&entry).await,
            vec!["/compact".to_string()],
            "the compaction's end is held for the settle like every other idle edge"
        );

        // A changeset tick inside that window. It must not spend the record
        // the withheld decision was made from — and its line has to say that
        // a decision was made and held, rather than that none was reached.
        let held = capturing_ticks(async {
            sweep(&ctx, &state).await;
        })
        .await;
        assert_eq!(held.len(), 1, "one line per tick, got {held:#?}");
        assert!(
            held[0].contains("decided=prompt:continue")
                && held[0].contains("action=none")
                && held[0].contains("settled=false"),
            "a held decision is a one-line read rather than an inference: {}",
            held[0]
        );
        assert!(
            state.lock().await[&demo_key(root)].pending.is_some(),
            "a withheld tick leaves the compaction's record standing"
        );

        // The re-sweep the gate armed: the same reading, now old enough.
        age_the_settle(&state, Duration::from_secs(6)).await;
        sweep(&ctx, &state).await;
        assert_eq!(
            submitted_asks(&entry).await,
            vec![
                "/compact".to_string(),
                "/tugplug:arc-implement demo implement Step 2 and end the turn; it is the arc's last step"
                    .to_string()
            ],
            "the stage is prompted on from the compaction's own turn end"
        );
        assert!(
            state.lock().await[&demo_key(root)].pending.is_none(),
            "and the record is spent on the tick that acted, not before"
        );
    }

    /// A compaction judged against **no** reading walks the stage on, and the
    /// judgement is never made against the reading from before it.
    ///
    /// The other half of the same wedge: the last usage frame before the
    /// `/compact` said 350,000, the compact turn produces none of its own, and
    /// the tick that reads the compaction's end is the one that decides whether
    /// the compaction worked. Left standing, that stale number rotates the
    /// stage to a fresh session over a context the compaction had just brought
    /// down — the expensive act the compaction exists to avoid. The supervisor
    /// retires the reading at the boundary, and a missing reading is no reason
    /// to strand a stage with steps left.
    #[tokio::test]
    async fn a_compaction_with_no_reading_after_it_continues_rather_than_rotating() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");
        with_settle(root, 5);

        let (ctx, entry, _register_rx) = harness(root).await;
        // The last usage frame before the compaction, and the only one there
        // will ever be: nothing measures the window again in this test.
        set_context(&entry, 350_000).await;
        asked(&entry, 1).await;
        let state = settling_state(root);

        sweep(&ctx, &state).await;
        age_the_settle(&state, Duration::from_secs(6)).await;
        sweep(&ctx, &state).await;
        assert_eq!(
            submitted(&entry).await,
            vec!["/compact".to_string()],
            "the boundary above the threshold is answered by a compaction"
        );

        // The compaction ran; its boundary retired the reading, and no frame
        // has written a new one.
        asked(&entry, 2).await;
        retire_context(&entry).await;

        sweep(&ctx, &state).await;
        age_the_settle(&state, Duration::from_secs(6)).await;
        sweep(&ctx, &state).await;

        assert_eq!(
            submitted_asks(&entry).await,
            vec![
                "/compact".to_string(),
                "/tugplug:arc-implement demo implement Step 2 and end the turn; it is the arc's last step"
                    .to_string()
            ],
            "with no reading of the new context, the stage keeps its session"
        );
        assert!(
            state.lock().await[&demo_key(root)].in_flight_at.is_none(),
            "and nothing was rotated over a measurement that no longer exists"
        );
    }

    /// A compaction whose end finds nothing left to name spends its record all
    /// the same, and the arc goes on to stop rather than sitting forever.
    ///
    /// The gate withholds by clearing the action, so `action == None` on the
    /// tick after it has two meanings, and only one of them is a reason to
    /// keep the compaction's record. The other is this: an idle tick that
    /// judged the compaction's end and found the ledger naming no next step —
    /// here because the one row still open was withdrawn while the compaction
    /// ran. There is no re-sweep coming for that tick, so a record kept over
    /// it is kept forever, and `compact_turn_just_ended` standing forever
    /// zeroes the quiet-turn count on every tick after it. The arc would then
    /// sit exactly as it sat on 2026-09-04, one door further in.
    #[tokio::test]
    async fn a_compaction_that_ends_with_nothing_to_name_still_spends_its_record() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");
        // A selection running past the ledger's last row, so the withdrawal
        // below leaves the run neither complete nor able to name a next step.
        tugarc_core::log::append_arc_log(root, "demo", "run-through", "3").unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 350_000).await;
        asked(&entry, 1).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        state.lock().await.insert(
            demo_key(root),
            ArcState {
                last_done_count: Some(0),
                prompt_turns_seen: Some(1),
                all_turns_seen: Some(1),
                ..Default::default()
            },
        );

        sweep(&ctx, &state).await;
        assert_eq!(
            submitted(&entry).await,
            vec!["/compact".to_string()],
            "the boundary above the threshold is answered by a compaction"
        );

        // While the compaction ran, the last open row was withdrawn: nothing
        // is left to prompt on, and the run is not complete either.
        std::fs::write(
            root.join(".tug/arcs/demo/plan.md"),
            plan_with_statuses("done", "withdrawn"),
        )
        .unwrap();
        asked(&entry, 2).await;
        set_context(&entry, 120_000).await;

        sweep(&ctx, &state).await;
        assert!(
            state.lock().await[&demo_key(root)].pending.is_none(),
            "the tick that judged the compaction's end spends its record, decision or none"
        );

        // And the count a standing record would have frozen reaches the
        // horizon, so the arc ends with a sentence instead of a silence.
        asked(&entry, 3).await;
        sweep(&ctx, &state).await;
        asked(&entry, 4).await;
        sweep(&ctx, &state).await;
        assert_eq!(
            read_arc(root, "demo").unwrap().stopped,
            Some((ArcStage::Implement, "implement idle".to_string())),
            "an arc with nothing left to name stops rather than ticking forever"
        );
    }

    /// The arc writes down every prompt it sends, not just the one that opened
    /// the stage.
    ///
    /// Claude's JSONL records a prompt the wheel sent exactly as it records one
    /// the user typed, so this record is the only thing that lets a reload put
    /// the wheel's later prompts back under the wheel's name. Read by tugcode's
    /// replay through the same `sessions.db`.
    #[tokio::test]
    async fn a_continued_stage_records_the_prompt_the_wheel_sent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        asked(&entry, 2).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        state.lock().await.insert(
            demo_key(root),
            ArcState {
                last_done_count: Some(1),
                compacted_since_below: true,
                pending: Some(PendingPrompt {
                    kind: PromptKind::Compact,
                    turns_ended_at: 1,
                }),
                ..Default::default()
            },
        );

        sweep(&ctx, &state).await;

        let sent = submitted(&entry).await;
        assert_eq!(sent.len(), 1, "the arc continued the stage");
        assert_eq!(
            ctx.session_ledger
                .list_wheel_prompts_for_line("claude-1")
                .unwrap(),
            sent,
            "what the record holds is exactly what went on the wire",
        );
    }

    /// A compaction that did not happen is never remembered as one. The
    /// context only grows, so a latched flag would compact exactly once,
    /// having compacted not at all — and fall through to a rotation forever
    /// after.
    #[tokio::test]
    async fn a_cancelled_compact_turn_lets_the_next_boundary_compact_again() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 350_000).await;
        {
            let mut entry = entry.lock().await;
            entry.turns_ended = 2;
            entry.prompt_turns_ended = 2;
            entry.turn_cancelled = true;
        }
        let state = Arc::new(Mutex::new(HashMap::new()));
        state.lock().await.insert(
            demo_key(root),
            ArcState {
                last_done_count: Some(1),
                compacted_since_below: true,
                pending: Some(PendingPrompt {
                    kind: PromptKind::Compact,
                    turns_ended_at: 1,
                }),
                ..Default::default()
            },
        );

        sweep(&ctx, &state).await;
        assert!(
            !state.lock().await[&demo_key(root)].compacted_since_below,
            "the cancelled compaction is forgotten"
        );

        // The next step boundary compacts again rather than rotating.
        {
            // The continue the cancel's own tick sent opened a turn; the next
            // boundary is that turn's end.
            let mut entry = entry.lock().await;
            entry.turn_cancelled = false;
            entry.turn_active = false;
            entry.turns_ended = 3;
            entry.prompt_turns_ended = 3;
        }
        {
            let mut map = state.lock().await;
            let entry = map.get_mut(&demo_key(root)).unwrap();
            entry.last_done_count = Some(0);
        }
        sweep(&ctx, &state).await;
        assert!(
            submitted(&entry).await.contains(&"/compact".to_string()),
            "{:?}",
            submitted(&entry).await
        );
    }

    /// Run `body` with a subscriber of our own and hand back every line it
    /// wrote. Several tests read the runner's own trace, and the writer is the
    /// same fifteen lines for all of them.
    async fn capturing_lines<F: std::future::Future<Output = ()>>(body: F) -> Vec<String> {
        use std::sync::{Arc as StdArc, Mutex as StdMutex};
        use tracing_subscriber::fmt::MakeWriter;

        #[derive(Clone)]
        struct Buffer(StdArc<StdMutex<Vec<u8>>>);
        impl std::io::Write for Buffer {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl<'a> MakeWriter<'a> for Buffer {
            type Writer = Buffer;
            fn make_writer(&'a self) -> Self::Writer {
                self.clone()
            }
        }

        let sink = Buffer(StdArc::new(StdMutex::new(Vec::new())));
        let subscriber = tracing_subscriber::fmt()
            .with_writer(sink.clone())
            .with_ansi(false)
            .without_time()
            .finish();
        let captured = {
            let _guard = tracing::subscriber::set_default(subscriber);
            body.await;
            String::from_utf8(sink.0.lock().unwrap().clone()).unwrap()
        };
        captured.lines().map(str::to_string).collect()
    }

    /// The same capture, narrowed to the `arc.tick` lines.
    async fn capturing_ticks<F: std::future::Future<Output = ()>>(body: F) -> Vec<String> {
        capturing_lines(body)
            .await
            .into_iter()
            .filter(|line| line.contains("event=\"arc.tick\""))
            .collect()
    }

    /// **No act-path return is silent** ([P10]).
    ///
    /// Every act re-reads the record immediately before writing anything,
    /// because a tick that raced another one decided over facts that may have
    /// moved. Declining on that guard is right; declining *silently* is what
    /// made the arc's wedges diagnosable only by reading the source — the tick
    /// line said the runner was about to prompt, and then nothing happened and
    /// nothing said why.
    ///
    /// The race is driven by hand rather than hoped for: the reading is taken,
    /// the record moves, and only then is the act called with the reading it
    /// was going to act on.
    #[tokio::test]
    async fn a_prompt_the_record_moved_under_is_logged_not_swallowed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");

        let (ctx, entry, _register_rx) = harness(root).await;
        let reading = read(
            root,
            "demo",
            &snapshot(true, true, Some("claude-1")),
            TickMemory {
                last_done_count: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            reading.facts.ledger.step_just_done,
            "the reading is one the runner would answer with a prompt",
        );

        // The record moves under the tick: another rotation lands between the
        // read and the act.
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Implement, "claude-9", None)
            .unwrap();

        let state = Arc::new(Mutex::new(HashMap::new()));
        let lines = capturing_lines(async {
            deliver_prompt(
                &ctx,
                &state,
                &bound(root, "demo"),
                &demo_key(root),
                &reading,
                &PromptKind::Continue { steps: (2, 2) },
                &PromptWhy::Continue,
            )
            .await;
        })
        .await;

        assert_eq!(
            lines
                .iter()
                .filter(|line| line.contains("event=\"arc.prompt_skipped\""))
                .count(),
            1,
            "the guard said why it declined: {lines:#?}",
        );
        assert!(
            submitted(&entry).await.is_empty(),
            "and it did decline — the stale reading bought no prompt",
        );
    }

    /// The stop that existed on one path and not its twin ([P10]).
    ///
    /// An ask that cannot be composed is an arc with no words for its own
    /// stage. `rotate` has always stopped as `prompt unavailable` and said so
    /// in a receipt; the prompt paths returned silently, so the arc sat with
    /// nothing to advance it and nothing on the card to say so.
    #[tokio::test]
    async fn an_unavailable_ask_stops_as_prompt_unavailable_on_the_prompt_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/arcs/demo/brief.md");
        // No `arc-start`, so the record carries no document — and the devise
        // ask is the one that cannot be composed without one.
        tugarc_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();
        tugarc_core::arc::append_arc_stop(root, "demo", ArcStage::Devise, ArcStopReason::Lint)
            .unwrap();
        tugarc_core::arc::append_arc_resume(root, "demo", ArcStage::Devise).unwrap();
        assert_eq!(read_arc(root, "demo").unwrap().document, None);

        let (ctx, _entry, _register_rx) = harness(root).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        sweep(&ctx, &state).await;

        assert_eq!(
            read_arc(root, "demo").unwrap().stopped,
            Some((ArcStage::Devise, "prompt unavailable".to_string())),
            "the arc says what it could not do rather than sitting still",
        );
    }

    /// Every tick says what it read and what it decided — including the ticks
    /// that decided nothing. The eleven-arc silence that produced this work
    /// was diagnosable only by reading, because no tick had ever said a word.
    #[tokio::test]
    async fn every_tick_logs_its_facts_and_its_decision() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 350_000).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        state.lock().await.insert(
            demo_key(root),
            ArcState {
                last_done_count: Some(0),
                ..Default::default()
            },
        );

        let ticks = capturing_ticks(async {
            // Mid-turn: the tick decides nothing, and says so.
            entry.lock().await.turn_active = true;
            sweep(&ctx, &state).await;
            entry.lock().await.turn_active = false;
            sweep(&ctx, &state).await;
        })
        .await;
        let ticks: Vec<&str> = ticks.iter().map(String::as_str).collect();
        assert_eq!(ticks.len(), 2, "one line per tick, got {ticks:#?}");
        assert!(
            ticks[0].contains("action=none") && ticks[0].contains("idle=false"),
            "{ticks:#?}"
        );
        assert!(
            ticks[1].contains("action=prompt:compact")
                && ticks[1].contains("tokens=\"350000\"")
                && ticks[1].contains("done_count=1")
                && ticks[1].contains("last_done_count=Some(0)")
                && ticks[1].contains("step_just_done=true"),
            "{}",
            ticks[1]
        );
        // The settle is off in this project, so a decided action is settled by
        // definition and nothing is being held.
        assert!(
            ticks[0].contains("settled=false") && ticks[0].contains("quiet_for=\"-\""),
            "{}",
            ticks[0]
        );
        assert!(
            ticks[1].contains("settled=true") && ticks[1].contains("quiet_for=\"-\""),
            "{}",
            ticks[1]
        );
        // And the fields Table T02 added are on **every** line, decided or
        // not: a reader diagnosing a silence needs the same facts from the
        // ticks that did nothing as from the one that acted.
        for tick in &ticks {
            for field in [
                "opener=",
                "quiet_for=",
                "settled=",
                "prompt_turns=",
                "wake_turns=",
                "decided=",
            ] {
                assert!(tick.contains(field), "no {field} on {tick}");
            }
        }
        assert!(
            ticks[0].contains("opener=\"-\""),
            "a turn nothing opened says so rather than omitting the field: {}",
            ticks[0]
        );
    }

    /// And with a settle declared, the two lines say which side of it each
    /// tick fell on — the one fact a reader needs to tell a runner that is
    /// waiting from one that has stopped deciding.
    #[tokio::test]
    async fn the_tick_line_says_which_side_of_the_settle_it_fell_on() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        implementing_project(root, "done", "pending");
        with_settle(root, 5);

        let (ctx, entry, _register_rx) = harness(root).await;
        set_context(&entry, 100_000).await;
        let state = settling_state(root);

        let ticks = capturing_ticks(async {
            sweep(&ctx, &state).await;
            age_the_settle(&state, Duration::from_secs(6)).await;
            sweep(&ctx, &state).await;
        })
        .await;

        assert_eq!(ticks.len(), 2, "one line per tick, got {ticks:#?}");
        assert!(
            ticks[0].contains("settled=false")
                && ticks[0].contains("quiet_for=\"0\"")
                && ticks[0].contains("action=none")
                && ticks[0].contains("decided=prompt:continue"),
            "the held tick says what it decided, that it acted on none of it, and why: {}",
            ticks[0]
        );
        assert!(
            ticks[1].contains("settled=true")
                && ticks[1].contains("action=prompt:")
                && ticks[1].contains("decided=prompt:")
                && !ticks[1].contains("quiet_for=\"-\""),
            "and the settled one says how long it waited: {}",
            ticks[1]
        );
    }

    /// **The incident, and the four shapes around it, as frame sequences**
    /// (List L01).
    ///
    /// Every other test here drives one mechanism. These drive the *wire* —
    /// the order frames actually arrived in on the night of 2026-09-03 and the
    /// orders that neighbour it — because the defect was never in one
    /// mechanism's logic. Each part was defensible alone: a turn end is an
    /// edge, an idle reading is idle, a horizon of two is patient, a clock of
    /// half an hour is generous. The arc stopped because they met in one
    /// order, and only a sequence can hold that.
    ///
    /// No test here sleeps. The settle and the clock are aged by hand, which
    /// is the same thing a wall clock would have said and is over in
    /// microseconds.
    mod frame_sequences {
        use super::*;

        /// **Sequence 1 — the gap the arc was stopped in.** An asked turn
        /// ends; 120 ms later its wake begins. The session is genuinely idle
        /// in between, and a tick landing there used to spend that instant on
        /// a stop.
        #[tokio::test]
        async fn an_asked_turn_end_followed_by_a_wake_within_the_settle_decides_nothing() {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            implementing_project(root, "done", "pending");
            with_settle(root, 5);

            let (ctx, entry, _register_rx) = harness(root).await;
            set_context(&entry, 100_000).await;
            let state = settling_state(root);

            // The turn ends. The reading is idle, and the window opens over
            // it rather than being spent.
            asked(&entry, 2).await;
            sweep(&ctx, &state).await;
            assert!(
                state.lock().await[&demo_key(root)].quiet_since.is_some(),
                "the idle reading armed a window rather than buying an act",
            );
            assert!(submitted(&entry).await.is_empty());

            // 120 ms later the wake opens its turn. The window's facts moved,
            // so the reading it described is gone.
            {
                let mut entry = entry.lock().await;
                entry.turn_active = true;
                entry.turn_opener = Some(TurnOpener::Wake);
            }
            sweep(&ctx, &state).await;

            assert_eq!(
                state.lock().await[&demo_key(root)].quiet_since,
                None,
                "a reading that is not idle settles nothing",
            );
            assert_eq!(read_arc(root, "demo").unwrap().stopped, None);
            assert!(
                submitted(&entry).await.is_empty(),
                "and the gap between a turn and its wake bought nothing at all",
            );
        }

        /// **Sequence 2 — the launch the wire never confirmed.** A
        /// backgrounded call goes out, the turn ends, minutes pass, and only
        /// then does the wake arrive. The session is *busy* for the whole of
        /// it: the launch is what says so, because the `task_started` that
        /// would confirm the job may never come.
        #[tokio::test]
        async fn a_launch_then_a_turn_end_then_minutes_then_a_wake_decides_nothing() {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            implementing_project(root, "done", "pending");
            with_settle(root, 5);

            let (ctx, entry, _register_rx) = harness(root).await;
            set_context(&entry, 100_000).await;
            let state = settling_state(root);
            let session = TugSessionId::new("claude-1".to_string());

            // The launch, as the wire writes it.
            ctx.supervisor
                .record_job_launch(
                    &session,
                    br#"{"type":"tool_use","tool_use_id":"tu-1","tool_name":"Bash","input":{"run_in_background":true}}"#,
                )
                .await;
            assert_eq!(entry.lock().await.open_jobs.len(), 1);

            // The turn ends with the job still running.
            asked(&entry, 2).await;
            sweep(&ctx, &state).await;
            assert_eq!(
                state.lock().await[&demo_key(root)].quiet_since,
                None,
                "an open job is not a quiet session, so no window opened",
            );

            // Minutes of it. Every tick reads the same busy session.
            for _ in 0..4 {
                sweep(&ctx, &state).await;
            }
            assert_eq!(read_arc(root, "demo").unwrap().stopped, None);
            assert!(submitted(&entry).await.is_empty());

            // The wake, which closes the job and opens a turn of its own.
            let closed = ctx
                .supervisor
                .apply_job_edge(
                    &session,
                    br#"{"type":"wake_started","wake_trigger":{"task_id":"tu-1","status":"completed"}}"#,
                )
                .await;
            assert!(closed, "the wake closed the launch it answered");
            {
                let mut entry = entry.lock().await;
                entry.turn_active = true;
                entry.turn_opener = Some(TurnOpener::Wake);
            }
            sweep(&ctx, &state).await;

            assert_eq!(
                read_arc(root, "demo").unwrap().stopped,
                None,
                "nothing in the whole sequence was an answer, and nothing stopped",
            );
        }

        /// **Sequence 3 — the ninety-six seconds after the wrong stop.** The
        /// arc stops for silence, and then the stage it was stopped over
        /// closes its step. The stop was a claim, and this is the one session
        /// entitled to contradict it.
        #[tokio::test]
        async fn a_stop_then_a_wake_reverses() {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            implementing_project(root, "done", "pending");

            let (ctx, entry, _register_rx) = harness(root).await;
            let state = stopped_at_the_horizon(&ctx, &entry, root).await;

            // A wake on the stopped stage's own session.
            woke(&entry).await;
            sweep(&ctx, &state).await;

            let markers = arc_log_markers(root);
            assert!(
                markers.iter().any(|line| line == "arc-continue  implement"),
                "the stop was reversed on the stage's own session: {markers:#?}",
            );
            assert_eq!(
                read_arc(root, "demo").unwrap().stopped,
                None,
                "and the record says the arc is running again",
            );
        }

        /// **Sequence 4 — the incident's morning.** The arc stopped in the
        /// evening, the clock aged over the stopped record all night, and the
        /// user pressed Resume. Both presses were undone within 160 ms,
        /// because the stall arm outranked the resume and the runner's memory
        /// outlived the stop.
        #[tokio::test]
        async fn a_resume_then_a_tick_never_stalls() {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            implementing_project(root, "done", "pending");
            std::fs::write(
                root.join(".tugtool/config.toml"),
                "[tugtool.arc]\nidle_settle_secs = 0\narc_stall_secs = 1\n",
            )
            .unwrap();

            let (ctx, entry, _register_rx) = harness(root).await;
            let state = stopped_at_the_horizon(&ctx, &entry, root).await;
            let _ = drained(&entry).await;

            // Overnight, aged rather than slept through. The stop left no
            // clock to age, which is the first half of the answer.
            assert_eq!(
                state.lock().await[&demo_key(root)].last_motion_at,
                None,
                "a stop evicts the memory of a running arc",
            );

            // The press.
            tugarc_core::arc::append_arc_resume(root, "demo", ArcStage::Implement).unwrap();
            {
                let mut map = state.lock().await;
                let entry = map.get_mut(&demo_key(root)).unwrap();
                entry.last_motion_at = Some(Instant::now() - Duration::from_secs(5));
            }
            sweep(&ctx, &state).await;

            assert_eq!(
                read_arc(root, "demo").unwrap().stopped,
                None,
                "the stale clock never got to re-stop the arc the user resumed",
            );
            assert!(
                arc_log_markers(root)
                    .iter()
                    .any(|line| line == "arc-continue  implement"),
                "and the resume was answered on the stage's own session",
            );

            // A second tick over the same staleness says the same thing.
            sweep(&ctx, &state).await;
            assert_eq!(read_arc(root, "demo").unwrap().stopped, None);
        }

        /// **Sequence 5 — the horizon reached the way it is meant to be.**
        /// An asked turn ends closing nothing, the wheel re-asks, and the
        /// re-asked turn ends closing nothing either. That is two asks, and
        /// the stop is what the sentence says it is.
        #[tokio::test]
        async fn asked_quiet_then_re_ask_then_asked_quiet_stops() {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            implementing_project(root, "done", "pending");

            let (ctx, entry, _register_rx) = harness(root).await;
            set_context(&entry, 100_000).await;
            let state = Arc::new(Mutex::new(HashMap::new()));
            state.lock().await.insert(
                demo_key(root),
                ArcState {
                    last_done_count: Some(1),
                    prompt_turns_seen: Some(0),
                    all_turns_seen: Some(0),
                    ..Default::default()
                },
            );

            sweep(&ctx, &state).await;
            assert_eq!(
                submitted_asks(&entry).await.len(),
                1,
                "the first quiet asked turn is answered, not waited out",
            );
            assert_eq!(read_arc(root, "demo").unwrap().stopped, None);

            // The re-asked turn ends, closing nothing either.
            asked(&entry, 2).await;
            sweep(&ctx, &state).await;

            assert_eq!(
                read_arc(root, "demo").unwrap().stopped,
                Some((ArcStage::Implement, "implement idle".to_string())),
                "two asks, and the receipt's sentence is true of what happened",
            );
            assert_eq!(
                submitted_asks(&entry).await.len(),
                1,
                "there is no third ask",
            );
        }
    }
}
