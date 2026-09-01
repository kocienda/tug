//! The arc runner — the act half of the arc.
//!
//! [`super::dash_arc::arc_action`] decides; this gathers the facts it decides
//! over, performs what it returns, and records the result in the dash-log. The
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
//! apart, and it is why the dash-log is re-read immediately before every
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

use tokio::sync::{Mutex, mpsc, watch};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};
use tugcast_core::protocol::{FeedId, Frame, TugSessionId};
use tugdash_core::arc::{
    ArcRecord, ArcStage, ArcStopReason, append_arc_dispatch, append_arc_done, append_arc_note,
    append_arc_plan, append_arc_stop, read_arc, stage_model,
};
use tugdash_core::dash::append_dash_log;
use tugtool_core::config::{Config, DashConfig};
use tugtool_core::plan;

use super::agent_supervisor::{AgentSupervisor, SpawnState};
use super::dash_arc::{
    ArcAction, ArcFacts, PromptKind, PromptWhy, QUIET_TURN_HORIZON, Rotation, StepLedgerFacts,
    arc_action, step_range,
};
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
}

/// Per-arc memory the documents cannot hold.
#[derive(Debug, Default, Clone)]
struct ArcState {
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
    /// The seated session's `turns_ended` as the previous tick read it — what
    /// makes "a turn ended since we last looked" answerable at all. `None`
    /// until the first tick, which seeds it without counting: a stage tugcast
    /// inherited across a restart has ended turns nobody here watched, and
    /// they are not this horizon's to hold against it.
    turns_seen: Option<u32>,
}

/// A prompt already delivered, remembered until the turn it opened ends.
#[derive(Debug, Clone)]
struct PendingPrompt {
    kind: PromptKind,
    /// The session's `turns_ended` at the moment the prompt went out. The turn
    /// this prompt opened has ended once the count has moved past it.
    turns_ended_at: u32,
}

/// One arc the sweep found: a bound dash, and the card it runs on.
struct BoundArc {
    project: PathBuf,
    dash: String,
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
    let state: Arc<Mutex<HashMap<String, ArcState>>> = Arc::new(Mutex::new(HashMap::new()));

    // The level read the edge cannot give: an arc mid-stage when tugcast
    // restarted has no turn left to end, and would otherwise wait forever.
    sweep(&ctx, &state).await;

    loop {
        tokio::select! {
            _ = ctx.cancel.cancelled() => {
                debug!("arc engine shutting down");
                return;
            }
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
        }
        sweep(&ctx, &state).await;
    }
}

/// Evaluate every arc a live session is bound to.
async fn sweep(ctx: &ArcContext, state: &Arc<Mutex<HashMap<String, ArcState>>>) {
    for arc in bound_arcs(ctx) {
        evaluate(ctx, state, &arc).await;
    }
}

/// Every arc with a live card behind it.
///
/// Bound-ness is the dash binding and nothing else: the arc record
/// names no session, so "whose card is this arc on" is answered by the ledger
/// the Bind control already writes. `bound_sessions_by_dash` filters to live
/// rows, so a card that closed takes its arc out of the sweep.
fn bound_arcs(ctx: &ArcContext) -> Vec<BoundArc> {
    let Ok(by_dash) = ctx.session_ledger.bound_sessions_by_dash() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for sessions in by_dash.values() {
        for session in sessions {
            let Ok(Some(row)) = ctx.session_ledger.get(session) else {
                continue;
            };
            let Some(dash) = row.dash_name.clone() else {
                continue;
            };
            out.push(BoundArc {
                project: PathBuf::from(&row.project_dir),
                dash,
                session: TugSessionId::new(session.clone()),
            });
        }
    }
    out
}

/// A key that separates two dashes of the same name in different projects.
fn arc_key(arc: &BoundArc) -> String {
    format!("{}\u{0}{}", arc.project.display(), arc.dash)
}

async fn evaluate(ctx: &ArcContext, state: &Arc<Mutex<HashMap<String, ArcState>>>, arc: &BoundArc) {
    let key = arc_key(arc);
    let Some(session) = session_snapshot(ctx, &arc.session).await else {
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
                        && session.turns_ended > pending.turns_ended_at
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
    let dash = arc.dash.clone();
    let Ok(Some(reading)) =
        tokio::task::spawn_blocking(move || read(&project, &dash, &session, memory)).await
    else {
        return;
    };
    let mut reading = reading;

    let quiet_turns;
    {
        let mut map = state.lock().await;
        let entry = map.entry(key.clone()).or_default();
        // Count the turn that just ended, before anything else reads the
        // memory. A tick fires on a changeset recompute as well as on a turn
        // end, so the count is over *turns* — the unit the stage acts in —
        // rather than over ticks, which fire for reasons the stage had no
        // part in.
        let previously_seen = entry.turns_seen.replace(reading.turns_ended);
        let a_turn_ended = previously_seen.is_some_and(|seen| reading.turns_ended > seen);
        if reading.facts.ledger.step_just_done {
            entry.quiet_turns = 0;
        } else if a_turn_ended && !reading.facts.compact_turn_just_ended {
            entry.quiet_turns = entry.quiet_turns.saturating_add(1);
        }
        quiet_turns = entry.quiet_turns;
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
            if reading.record.stages.len() <= dispatched_at
                && entry.quiet_turns < QUIET_TURN_HORIZON
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
        // A pending prompt is read back exactly once: the tick that derived
        // `compact_turn_just_ended` from it is the tick that consumes it.
        if memory.compact_turn_just_ended {
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

    let action = arc_action(&reading.record, &reading.facts);

    // Every tick says what it read and what it decided, including the ticks
    // that decided nothing. An arc that advances silently is an arc whose
    // divergence from the predicate can only be found by guessing.
    info!(
        target: "dev::session-lifecycle",
        event = "arc.tick",
        dash = %arc.dash,
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
        step_just_done = reading.facts.ledger.step_just_done,
        quiet_turns = reading.facts.quiet_turns,
        compacted_since_below = reading.facts.compacted_since_below,
        compact_turn_just_ended = reading.facts.compact_turn_just_ended,
        action = %describe_action(action.as_ref()),
    );

    let Some(action) = action else { return };

    match action {
        ArcAction::Rotate(rotation) => rotate(ctx, state, arc, &key, &reading, &rotation).await,
        ArcAction::Prompt { kind, why } => {
            deliver_prompt(ctx, state, arc, &key, &reading, &kind, &why).await
        }
        ArcAction::Done => finish(ctx, arc, &reading, None).await,
        ArcAction::Stop { stage, reason } => {
            finish(ctx, arc, &reading, Some((stage, reason))).await
        }
    }
}

/// The `action` word on an `arc.tick` line — one token per decision, so the
/// log can be grepped for what the arc did at a boundary.
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
        Some(ArcAction::Done) => "done".to_string(),
        Some(ArcAction::Stop { reason, .. }) => format!("stop:{}", reason.as_str()),
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
struct SessionSnapshot {
    live: bool,
    idle: bool,
    /// The seated claude session has ended at least one turn.
    turn_ended: bool,
    /// Its most recent turn ended in an API error rather than a response.
    api_error: bool,
    /// Its most recent turn was cancelled by the user.
    turn_cancelled: bool,
    /// How many turns the seated claude session has ended. The count, not the
    /// flag, because a pending prompt is read back by comparing against the
    /// count at the moment it was sent.
    turns_ended: u32,
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
    // are the states with nothing left to advance.
    let entry_arc = entry_arc?;
    let (live, idle, turns_ended, api_error, turn_cancelled, claude_session_id, context_window) = {
        let entry = entry_arc.lock().await;
        let live = match entry.spawn_state {
            // The early return costs the taken-card arm its immediacy, and
            // that is the right trade. A `/new` parks the entry `Idle`, so no
            // stop is decided until the card spawns again — the stop lands at
            // the user's next prompt rather than at the gesture. A card parked
            // `Idle` is indistinguishable from a card whose tugcast just
            // restarted, and judging it would stop every in-flight arc on
            // every relaunch.
            SpawnState::Idle => return None,
            SpawnState::Spawning | SpawnState::Live => true,
            SpawnState::Errored | SpawnState::Closed => false,
        };
        (
            live,
            // Idle means finished, not merely between frames: a stage that
            // backgrounded a test sweep has not decided anything yet, and a
            // rotation on that reading would advance the arc past work still
            // running.
            entry.is_quiet(),
            entry.turns_ended,
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
        turn_ended: turns_ended > 0,
        turns_ended,
        api_error,
        turn_cancelled,
        stage_seated,
        claude_session_id,
        context_window,
    })
}

/// Everything one tick read, kept together so the act does not read it again.
struct ArcReading {
    /// The dash this reading is of — how every stage after devise is asked.
    dash: String,
    record: ArcRecord,
    facts: ArcFacts,
    /// How many ledger rows read `done` — the next tick's comparison point.
    done_count: usize,
    /// How a stage's prompt names the plan: the dash's name ([P10]). `None`
    /// when there is no plan yet, which is what a devise stage means.
    plan_for_prompt: Option<String>,
    /// Where the devise stage should write its plan, repo-relative.
    devise_target: Option<String>,
    /// The repo-relative paths the document cites.
    cited_paths: Vec<String>,
    /// What moved in those paths since the document was last written.
    commits_since: Vec<String>,
    /// How many turns the seated session had ended when this tick read it —
    /// the mark a delivered prompt's own turn is later recognized against.
    turns_ended: u32,
    config: DashConfig,
}

/// The runner's per-arc memory as one tick reads it — the facts no document
/// can hold, gathered before the blocking read so they reach the predicate.
#[derive(Debug, Clone, Copy, Default)]
struct TickMemory {
    last_done_count: Option<usize>,
    compacted_since_below: bool,
    compact_turn_just_ended: bool,
}

/// Gather the facts. Blocking: file reads and, for an implement stage, one
/// scoped git read.
fn read(
    project: &Path,
    dash: &str,
    session: &SessionSnapshot,
    memory: TickMemory,
) -> Option<ArcReading> {
    let record = read_arc(project, dash)?;
    let project_config = Config::load_from_project(project).unwrap_or_default();
    let config = project_config.tugtool.dash.clone();

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
            tugdash_core::ops::commits_touching_after(
                project,
                since,
                &cited_paths,
                wheel::prompt::COMMITS_CAP,
            )
        })
        .unwrap_or_default();

    // The plan is at the dash's own address or it does not exist; there is no
    // residence to discover and nothing to record.
    let plan_abs = tugdash_core::plan_file(project, dash);
    let plan_abs = plan_abs.is_file().then_some(plan_abs);
    // The ledger the implement stage walks: the plan when there is one, the
    // `/dash` door's task list otherwise. This is the whole of what tells the
    // two courses apart — a dash whose only ledger is a task list has nothing
    // to devise and nothing to review, so its arc opens at implement.
    let ledger_abs = tugdash_core::ledger_file(project, dash);
    let task_list = plan_abs.is_none() && ledger_abs.is_some();
    // Every stage after devise names the *dash*, not a path ([P10]): the
    // skills resolve a name, so a stage cannot be pointed at the wrong file.
    let plan_for_prompt = ledger_abs.as_ref().map(|_| dash.to_string());

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

    // Closed, not finished: a withdrawn step ended, so it counts here and a
    // withdrawal is a rotation boundary exactly as a completion is.
    let done_count = doc
        .as_ref()
        .map(|d| {
            d.ledger_rows
                .iter()
                .filter(|row| row.status == "done" || row.status == "withdrawn")
                .count()
        })
        .unwrap_or(0);
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

    let declarations = tugdash_core::dash::read_declarations(project, dash);

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
        audit_declared: matches!(
            declarations.latest,
            Some(tugdash_core::dash::DashDeclaration::Audited)
        ),
        // Runner memory, and the one fact this pass cannot gather: the count
        // is over turns the *previous* tick already saw, so `evaluate` stamps
        // it after this read returns.
        quiet_turns: 0,
    };

    // Where devise writes: the dash's own `plan.md`, repo-relative, which is
    // also what the record and the stage divider carry.
    let devise_target = Some(format!(".tug/dashes/{dash}/plan.md"));

    Some(ArcReading {
        dash: dash.to_string(),
        record,
        facts,
        done_count,
        plan_for_prompt,
        devise_target,
        cited_paths,
        commits_since,
        turns_ended: session.turns_ended,
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

/// The stage's opening prompt: the course's ask, plus what the documents say
/// about where to start and what has moved.
///
/// The facts were gathered in `read`'s blocking pass; the wording is the
/// wheel's, so every course composes the same way. Nothing here is a word a
/// model wrote.
fn opening_prompt(reading: &ArcReading, rotation: &Rotation) -> Option<String> {
    let steps = rotation
        .steps
        .map(|(from, through)| step_range(from, through));
    let ask = wheel::prompt::stage_ask(
        rotation.stage.as_str(),
        reading.record.document.as_deref(),
        &reading.dash,
        steps.as_deref(),
    )?;
    // A stopped arc that is rotating again is resuming, and the stage it opens
    // is owed that fact: it is the difference between starting the work and
    // picking it back up.
    let resume = reading
        .record
        .stopped
        .as_ref()
        .map(|(stage, reason)| (stage.as_str(), reason.as_str()));
    Some(wheel::prompt::compose(
        &ask,
        &reading.cited_paths,
        &reading.commits_since,
        resume,
    ))
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
    let dash = arc.dash.clone();
    let fresh = tokio::task::spawn_blocking(move || read_arc(&project, &dash))
        .await
        .ok()
        .flatten();
    if fresh.as_ref().map(|r| r.stages.len()) != Some(reading.record.stages.len()) {
        return;
    }

    let text = match kind {
        PromptKind::Compact => "/compact".to_string(),
        PromptKind::Continue { steps } => {
            let range = step_range(steps.0, steps.1);
            let Some(ask) = wheel::prompt::stage_ask(
                ArcStage::Implement.as_str(),
                reading.record.document.as_deref(),
                &reading.dash,
                Some(&range),
            ) else {
                return;
            };
            // No clauses: the session already holds its own context, and the
            // opening prompt's start-there and what-changed clauses are for a
            // session that does not.
            wheel::prompt::compose(&ask, &[], &[], None)
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

    if let PromptWhy::Compact {
        tokens,
        compact_tokens,
    } = why
    {
        let note = format!("{tokens} > {compact_tokens}");
        let (project, dash) = (arc.project.clone(), arc.dash.clone());
        let arc_note = format!("compacted at {note}");
        let _ = tokio::task::spawn_blocking(move || {
            let _ = append_dash_log(&project, &dash, "compact", &note);
            append_arc_note(&project, &dash, &arc_note)
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

    info!(
        target: "dev::session-lifecycle",
        event = "arc.prompt",
        dash = %arc.dash,
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
    let dash = arc.dash.clone();
    let fresh = tokio::task::spawn_blocking(move || read_arc(&project, &dash))
        .await
        .ok()
        .flatten();
    if fresh.as_ref().map(|r| r.stages.len()) != Some(reading.record.stages.len()) {
        return;
    }

    let Some(prompt) = opening_prompt(reading, rotation) else {
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
    let dash = arc.dash.clone();
    if rotation.stage == ArcStage::Devise {
        if let Some(target) = reading.devise_target.clone() {
            let (p, d) = (project.clone(), dash.clone());
            let _ = tokio::task::spawn_blocking(move || append_arc_plan(&p, &d, &target)).await;
        }
    }
    // An arc opened on a plan never devised one, so the plan path is recorded
    // at its first review instead — the document itself — and every
    // later reading finds it where a devised plan's would be.
    if rotation.stage == ArcStage::Review && reading.record.plan.is_none() {
        if let Some(plan) = reading.plan_for_prompt.clone() {
            let (p, d) = (project.clone(), dash.clone());
            let _ = tokio::task::spawn_blocking(move || append_arc_plan(&p, &d, &plan)).await;
        }
    }
    if let Some(note) = rotation.note.clone() {
        let (p, d) = (project.clone(), dash.clone());
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
        .course(Some(arc.dash.clone()))
        .model(stage_model(&reading.config, rotation.stage))
        .steps(
            rotation
                .steps
                .map(|(from, through)| step_range(from, through)),
        );

    let dispatched_at = reading.record.stages.len();
    // **Intent before the act.** A crash between the wheel firing and the
    // bridge's `arc-stage` line leaves a seat the record cannot explain, and
    // the restarted runner read it as a taken card — a wrong stop, and one
    // the user is told about. The line goes down first so the gap reads as
    // "re-rotate this stage" instead. It reports the way every other append
    // here reports, and does not stop the rotation: a rotation that happened
    // is better than one refused over its own footnote.
    let outcome = tokio::task::spawn_blocking({
        let (project, dash, stage) = (project.clone(), dash.clone(), rotation.stage);
        move || append_arc_dispatch(&project, &dash, stage)
    })
    .await;
    report_append(&project, &dash, "arc-dispatch", outcome);
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
        // or failed to do is not this one's record. `turns_seen` goes with it
        // — the seated session is new, and its turn count starts over.
        entry.quiet_turns = 0;
        entry.turns_seen = None;
    }

    match outcome {
        Ok(delivery) => info!(
            dash = %arc.dash,
            stage = rotation.stage.as_str(),
            ?delivery,
            "arc rotated a stage",
        ),
        Err(refusal) => {
            warn!(
                dash = %arc.dash,
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
    let mut out = format!("arc complete · {}", record.dash);
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
/// why, and what resumes it.
///
/// The reason is an [`ArcStopReason`] rather than a word, so the sentence is
/// the type's own and there is no arm for a reason nobody wrote a sentence for.
/// A stop the receipt could not explain is a stop the arc must not write.
fn format_arc_stop_receipt(record: &ArcRecord, stage: ArcStage, reason: ArcStopReason) -> String {
    let next = if reason.is_resumable() {
        format!("resume with tugtool dash run {}", record.dash)
    } else {
        "there is nothing to resume".to_string()
    };
    format!(
        "arc stopped · {} · in {} — {}\n{next}",
        record.dash,
        stage.as_str(),
        reason.sentence(),
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
/// `dash_api::stop_an_on_course_cards_arc_as_closed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct StopDelivery {
    pub hand_back: HandBack,
    /// Append `arc-stop` to the dash-log. An ending writes none: its own
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
/// rotation, an ending, a card close, and `tugtool dash stop`. Four call sites
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
#[allow(clippy::too_many_arguments)]
pub(crate) async fn stop_arc_for_session(
    supervisor: &AgentSupervisor,
    state: &wheel::WheelState,
    session: &TugSessionId,
    project: &Path,
    dash: &str,
    stage: ArcStage,
    reason: ArcStopReason,
    how: StopDelivery,
) {
    match how.hand_back {
        HandBack::Send => {
            if let Err(refusal) = wheel::hand_back(supervisor, session).await {
                warn!(
                    dash = %dash,
                    reason = refusal.reason(),
                    "arc could not restore the deck's model",
                );
            }
        }
        HandBack::Arm => state.arm_hand_back(session.as_str()),
    }

    {
        let summary = if reason.is_resumable() {
            // The record supplies the dash name the receipt reads back. A stop
            // with no record left to read is still worth saying, so a missing
            // one falls back to a record naming only this dash and stage.
            let record = read_arc(project, dash).unwrap_or_else(|| ArcRecord {
                dash: dash.to_owned(),
                document: None,
                course: None,
                plan: None,
                stages: Vec::new(),
                notes: Vec::new(),
                stopped: None,
                resume: None,
                dispatched: None,
                done: false,
                last_activity: None,
            });
            format_arc_stop_receipt(&record, stage, reason)
        } else {
            // The two endings are the reasons whose stop has not happened yet:
            // the dash is gone, but the stage is mid-turn and is retired at
            // that turn's end. So the receipt announces the retirement rather
            // than reporting a stop, and names the model the card comes back
            // to.
            let model = supervisor
                .deck_model_for(session.as_str())
                .await
                .unwrap_or_else(|| "the account default".to_string());
            format!(
                "arc {} · {dash} · the stage's turn will end and the card returns to {model}",
                reason.as_str(),
            )
        };
        supervisor.record_arc_receipt(session.as_str(), dash, &project.to_string_lossy(), &summary);
    }

    if how.record {
        let project = project.to_path_buf();
        let dash = dash.to_owned();
        let outcome = tokio::task::spawn_blocking({
            let (project, dash) = (project.clone(), dash.clone());
            move || append_arc_stop(&project, &dash, stage, reason)
        })
        .await;
        report_append(&project, &dash, "arc-stop", outcome);
    }
}

async fn finish(
    ctx: &ArcContext,
    arc: &BoundArc,
    reading: &ArcReading,
    stopped: Option<(ArcStage, ArcStopReason)>,
) {
    if let Some((stage, reason)) = stopped {
        stop_arc_for_session(
            &ctx.supervisor,
            &ctx.wheel,
            &arc.session,
            &arc.project,
            &arc.dash,
            stage,
            reason,
            StopDelivery {
                hand_back: HandBack::Send,
                record: true,
            },
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
        &arc.dash,
        &arc.project.to_string_lossy(),
        &summary,
    );
    if let Err(refusal) = wheel::hand_back(&ctx.supervisor, &arc.session).await {
        warn!(
            dash = %arc.dash,
            reason = refusal.reason(),
            "arc could not restore the deck's model",
        );
    }
    let project = arc.project.clone();
    let dash = arc.dash.clone();
    let outcome = tokio::task::spawn_blocking({
        let (project, dash) = (project.clone(), dash.clone());
        move || append_arc_done(&project, &dash)
    })
    .await;
    report_append(&project, &dash, "arc-done", outcome);
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
        &arc.dash,
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
/// later reader — the card's placard, the Z2 cell, `dash doctor`, a resume —
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
    dash: &str,
    marker: &str,
    outcome: Result<Result<(), tugtool_core::error::TugError>, tokio::task::JoinError>,
) {
    let reason = match outcome {
        Ok(Ok(())) => return,
        Ok(Err(error)) => error.to_string(),
        Err(join) => format!("the append task did not finish: {join}"),
    };
    warn!(
        dash = %dash,
        marker = %marker,
        path = %tugtool_core::paths::project_state_dir(project)
            .join("dash-log.md")
            .display(),
        reason = %reason,
        "arc could not record its terminal line",
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    /// A plan that parses and lints clean — the fact `lints_as_plan` reads.
    /// Local rather than a repository document: a plan under `dash/` is
    /// archived the day its dash joins, and a test pinned to one goes with it.
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
            api_error: false,
            turn_cancelled: false,
            // A seated stage is the ordinary case; the taken-card tests build
            // their own.
            stage_seated: true,
            claude_session_id: claude.map(str::to_string),
            context_window: None,
        }
    }

    /// A project whose dash has a brief at its own address, which is where
    /// every document lives now.
    fn project_with_document(root: &Path, document: &str) {
        let path = root.join(document);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "# A brief\n\nSome prose.\n").unwrap();
        std::fs::create_dir_all(root.join(".tugtool")).unwrap();
    }

    #[test]
    fn an_opened_arc_reads_its_document_and_wants_devise() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();

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
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "gone", None).unwrap();

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
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "live", None).unwrap();

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
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "live", None).unwrap();

        // Idle, current, no plan on disk — the reading a tick takes in the gap
        // between the stage's spawn and its first frame. The same facts with a
        // turn behind them stop on lint (the test above); with none, the
        // stage has not run and nothing may be decided about its documents.
        let mut session = snapshot(true, true, Some("live"));
        session.turn_ended = false;
        let reading = read(root, "demo", &session, TickMemory::default()).unwrap();
        assert!(reading.facts.stage_session_current);
        assert!(!reading.facts.stage_turn_ended);
        assert_eq!(arc_action(&reading.record, &reading.facts), None);
    }

    #[tokio::test]
    async fn a_tick_before_a_stage_has_ended_a_turn_stops_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        entry.lock().await.turns_ended = 0;
        let state = Arc::new(Mutex::new(HashMap::new()));

        sweep(&ctx, &state).await;
        assert_eq!(entry.lock().await.queue.len(), 0, "no rotation");
        let record = tugdash_core::read_arc(root, "demo").unwrap();
        assert_eq!(
            record.stopped, None,
            "and no stop written for a plan the stage has not begun"
        );
    }

    #[test]
    fn a_document_that_already_lints_as_a_plan_skips_devise() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".tug/dashes/demo")).unwrap();
        std::fs::write(root.join(".tug/dashes/demo/plan.md"), LINTING_PLAN).unwrap();
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/plan.md").unwrap();

        let reading = read(
            root,
            "demo",
            &snapshot(true, true, None),
            TickMemory::default(),
        )
        .unwrap();
        assert!(reading.facts.input_is_plan);
        // The document is the plan, and every stage after devise names the
        // dash rather than a path.
        assert_eq!(reading.plan_for_prompt.as_deref(), Some("demo"));
        let review = Rotation {
            stage: ArcStage::Review,
            steps: None,
            note: None,
        };
        assert_eq!(
            opening_prompt(&reading, &review).as_deref(),
            Some("/tugplug:dash-review demo")
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
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Review, "s", None).unwrap();

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
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "s", None).unwrap();

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
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "s", None).unwrap();
        tugdash_core::arc::append_arc_stop(root, "demo", ArcStage::Devise, ArcStopReason::Lint)
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
    fn the_devise_ask_names_the_brief_and_targets_the_dash() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();

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
        )
        .unwrap();
        assert_eq!(
            prompt,
            "/tugplug:dash-devise a plan for .tug/dashes/demo/brief.md, honoring every [B##] decision it records 🢂 demo"
        );
    }

    /// Every stage after devise names the dash, so the skill resolves the
    /// address rather than being handed one it could write past.
    #[test]
    fn review_and_implement_asks_name_the_dash() {
        assert_eq!(
            wheel::prompt::stage_ask("review", None, "foo", None).as_deref(),
            Some("/tugplug:dash-review foo")
        );
        assert_eq!(
            wheel::prompt::stage_ask("implement", None, "foo", Some("2-4")).as_deref(),
            Some(
                "/tugplug:dash-implement foo Steps 2-4 — under this arc, close one step and end your turn; the arc prompts you with the next"
            )
        );
        assert_eq!(
            wheel::prompt::stage_ask("implement", None, "foo", None).as_deref(),
            Some(
                "/tugplug:dash-implement foo — under this arc, close one step and end your turn; the arc prompts you with the next"
            )
        );
    }

    /// The document has no last commit to key on — it is not tracked — so the
    /// "what changed" clause is anchored on when the author wrote it.
    #[test]
    fn what_changed_is_keyed_on_the_documents_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".tug/dashes/demo")).unwrap();
        std::fs::create_dir_all(root.join(".tugtool")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.name", "Test User"],
            vec!["config", "user.email", "test@example.com"],
        ] {
            std::process::Command::new("git")
                .arg("-C")
                .arg(root)
                .args(&args)
                .output()
                .unwrap();
        }
        std::fs::write(root.join("src/a.rs"), "fn a() {}\n").unwrap();
        let brief = root.join(".tug/dashes/demo/brief.md");
        std::fs::write(&brief, "# A brief\n\n[F01] `src/a.rs` holds it.\n").unwrap();
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();

        let commit = |message: &str| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(root)
                .args(["add", "-A"])
                .output()
                .unwrap();
            std::process::Command::new("git")
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
        std::fs::create_dir_all(root.join(".tug/dashes/demo")).unwrap();
        std::fs::create_dir_all(root.join(".tugtool")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.rs"), "fn a() {}\n").unwrap();
        std::fs::write(root.join("src/b.ts"), "export const b = 1;\n").unwrap();
        std::fs::write(
            root.join(".tug/dashes/demo/brief.md"),
            "# A brief\n\n[F01] `src/a.rs` holds it, `src/b.ts` reads it, `src/gone.rs` does not exist.\n",
        )
        .unwrap();
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();

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
        )
        .unwrap();
        assert!(prompt.starts_with("/tugplug:dash-devise a plan for .tug/dashes/demo/brief.md"));
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
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        std::fs::write(root.join(".tug/dashes/demo/plan.md"), LINTING_PLAN).unwrap();

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
        )
        .unwrap();
        assert_eq!(
            prompt,
            "/tugplug:dash-implement demo Steps 4-9 — under this arc, close one step and end your turn; the arc prompts you with the next"
        );
    }

    #[test]
    fn a_first_implement_prompt_carries_no_selector() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        std::fs::write(root.join(".tug/dashes/demo/plan.md"), LINTING_PLAN).unwrap();

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
        )
        .unwrap();
        assert_eq!(
            prompt,
            "/tugplug:dash-implement demo — under this arc, close one step and end your turn; the arc prompts you with the next"
        );
    }

    /// [`LINTING_PLAN`] with its two ledger rows driven to `first` / `second`.
    fn plan_with_statuses(first: &str, second: &str) -> String {
        LINTING_PLAN
            .replace(
                "| #step-1 | The first step | pending | — |",
                &format!("| #step-1 | The first step | {first} | — |"),
            )
            .replace(
                "| #step-2 | The second step | pending | — |",
                &format!("| #step-2 | The second step | {second} | — |"),
            )
    }

    /// A withdrawn row is closed — so it counts, and a rotation steps over it
    /// rather than resuming at a step nobody intends to walk.
    #[test]
    fn a_withdrawn_row_counts_as_closed_and_is_never_the_resume_point() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();

        std::fs::write(
            root.join(".tug/dashes/demo/plan.md"),
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
            root.join(".tug/dashes/demo/plan.md"),
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
            .set_dash_binding("claude-1", Some(("tugdash/demo#1", "demo")))
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
        let entry = Arc::new(Mutex::new(entry));
        supervisor.ledger.lock().await.insert(id, entry.clone());

        (
            ArcContext {
                supervisor,
                session_ledger: ledger,
                wheel: Arc::new(wheel::WheelState::default()),
                cancel: CancellationToken::new(),
            },
            entry,
            register_rx,
        )
    }

    #[tokio::test]
    async fn two_ticks_for_one_arc_produce_one_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/dashes/demo/brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.dash]\ndocs = \"dash\"\n",
        )
        .unwrap();
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();

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
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        entry.lock().await.turn_active = true;
        let state = Arc::new(Mutex::new(HashMap::new()));

        sweep(&ctx, &state).await;
        assert_eq!(entry.lock().await.queue.len(), 0);
    }

    #[tokio::test]
    async fn a_stopped_arc_is_not_resumed_by_a_tick_at_the_dispatcher() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();
        tugdash_core::arc::append_arc_stop(root, "demo", ArcStage::Devise, ArcStopReason::Lint)
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
        project_with_document(root, ".tug/dashes/demo/brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.dash]\ndocs = \"dash\"\n",
        )
        .unwrap();
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        // A stage recorded against a session that is no longer the one on the
        // card — what a tugcast restart leaves behind.
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "gone", None).unwrap();

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
        project_with_document(root, ".tug/dashes/demo/brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.dash]\ndocs = \"dash\"\n",
        )
        .unwrap();
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "gone", None).unwrap();

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
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Review, "gone", None).unwrap();

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
    async fn a_resumed_arc_rotates_its_stopped_stage_at_the_next_idle() {
        // Resume, end to end at the runner: `dash run` on a stopped arc writes
        // `arc-resume`, and the next idle tick rotates that stage — not the
        // one before it, and not nothing.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/dashes/demo/brief.md");
        std::fs::write(root.join(".tug/dashes/demo/plan.md"), LINTING_PLAN).unwrap();
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();
        tugdash_core::arc::append_arc_stop(
            root,
            "demo",
            ArcStage::Review,
            ArcStopReason::SpawnQueueFull,
        )
        .unwrap();
        tugdash_core::arc::append_arc_resume(root, "demo", ArcStage::Review).unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
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
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        // A devise stage on the card's own session that produced no plan: the
        // documents say stop.
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
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
        project_with_document(root, ".tug/dashes/demo/brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.dash]\ndocs = \"dash\"\n",
        )
        .unwrap();
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();

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
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
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
        // What `tugtool dash stop` reaches: the same three acts every other
        // stop performs, so a stop the user asked for is not a lesser one.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Implement, "claude-1", None)
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
            said[0].contains("resume with tugtool dash run demo"),
            "and the receipt says how to pick it back up: {said:?}",
        );
        assert_eq!(
            read_arc(root, "demo").unwrap().stopped,
            Some((ArcStage::Implement, "stopped by user".to_string())),
        );
    }

    #[tokio::test]
    async fn an_endings_receipt_announces_the_retirement_rather_than_a_stop() {
        // The two endings are the reasons whose stop has not happened yet: the
        // dash is gone, but the stage is mid-turn and retires at that turn's
        // end. So the receipt says what is about to happen and names the model
        // the card comes back to, and it says which gesture ended the dash.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Review, "claude-1", None)
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
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();

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
        // armed rather than sent, and nothing is appended to the dash-log —
        // the ending's own terminal line closed the arc's generation, and a
        // line after it would open a phantom one.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Review, "claude-1", None)
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
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        sweep(&ctx, &state).await;

        let frame = entry.lock().await.queue.pop().unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(parsed["model"], "default");
    }

    use tugdash_core::arc::ArcStageLine;

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
            dash: "foo".to_owned(),
            document: Some("dash/foo-brief.md".to_owned()),
            course: None,
            plan: Some("dash/foo.md".to_owned()),
            stages,
            notes: Vec::new(),
            stopped: None,
            resume: None,
            dispatched: None,
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
             opened on dash/foo-brief.md\n\
             devise · opus · claude-a\n\
             review · opus · claude-b\n\
             implement · sonnet · claude-c\n\
             plan dash/foo.md"
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
    fn the_stop_receipt_says_what_stopped_it_and_how_to_resume() {
        let record = done_record(vec![stage_line(ArcStage::Review, Some("opus"), "claude-b")]);
        // Every reason renders its own sentence, and every resumable one ends
        // with the gesture that picks the work back up.
        for reason in ArcStopReason::ALL {
            let receipt = format_arc_stop_receipt(&record, ArcStage::Review, *reason);
            assert!(
                receipt.starts_with("arc stopped · foo · in review — "),
                "got {receipt}"
            );
            assert!(receipt.contains(reason.sentence()), "got {receipt}");
            if reason.is_resumable() {
                assert!(
                    receipt.ends_with("\nresume with tugtool dash run foo"),
                    "got {receipt}"
                );
            } else {
                assert!(
                    receipt.ends_with("\nthere is nothing to resume"),
                    "got {receipt}"
                );
            }
        }

        assert_eq!(
            format_arc_stop_receipt(&record, ArcStage::Devise, ArcStopReason::Lint),
            "arc stopped · foo · in devise — the plan does not lint\n\
             resume with tugtool dash run foo"
        );
        assert_eq!(
            format_arc_stop_receipt(&record, ArcStage::Review, ArcStopReason::Discarded),
            "arc stopped · foo · in review — the dash was discarded\n\
             there is nothing to resume"
        );
        assert_eq!(
            format_arc_stop_receipt(&record, ArcStage::Implement, ArcStopReason::CardTaken),
            "arc stopped · foo · in implement — you took the card back\n\
             resume with tugtool dash run foo"
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
    /// run through step 2.
    fn implementing_project(root: &Path, first: &str, second: &str) {
        project_with_document(root, ".tug/dashes/demo/brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.dash]\nimplement_compact_tokens = 300000\n",
        )
        .unwrap();
        std::fs::write(
            root.join(".tug/dashes/demo/plan.md"),
            plan_with_statuses(first, second),
        )
        .unwrap();
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        tugdash_core::arc::append_arc_plan(root, "demo", ".tug/dashes/demo/plan.md").unwrap();
        tugdash_core::dash::append_dash_log(root, "demo", "run-through", "2").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Implement, "claude-1", None)
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

    /// The arc's own key for the harness's project and dash, which is what the
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
            submitted(&entry).await,
            vec![
                "/tugplug:dash-implement demo Steps 2-2 — under this arc, close one step and end your turn; the arc prompts you with the next"
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
            submitted(&entry).await,
            vec![
                "/tugplug:dash-implement demo Steps 2-2 — under this arc, close one step and end your turn; the arc prompts you with the next"
                    .to_string()
            ],
            "the close the crash interrupted is answered on the first tick back"
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

    /// **The quiet-turn horizon, counted over turns rather than ticks.**
    ///
    /// The arc's largest silent wedge: an implement turn that ends closing no
    /// step decided `None`, and every tick after it decided `None` too. No
    /// receipt, no gesture, no face — an unattended run simply stopped
    /// advancing and said nothing.
    ///
    /// A tick fires on a changeset recompute as well as on a turn end, so the
    /// count must be over turns; this drives two sweeps against one turn count
    /// to prove a repeated tick is not a repeated turn, then advances the
    /// count and takes the second quiet turn to the stop.
    #[tokio::test]
    async fn two_quiet_implement_turns_stop_the_arc_and_leave_a_receipt() {
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
                turns_seen: Some(0),
                ..Default::default()
            },
        );

        // Turn one ends quietly. The arc waits.
        sweep(&ctx, &state).await;
        assert_eq!(
            state.lock().await[&demo_key(root)].quiet_turns,
            1,
            "one turn ended and closed nothing"
        );
        assert!(read_arc(root, "demo").unwrap().stopped.is_none());

        // A second tick on the *same* turn is not a second turn.
        sweep(&ctx, &state).await;
        assert_eq!(
            state.lock().await[&demo_key(root)].quiet_turns,
            1,
            "a tick is not a turn"
        );
        assert!(read_arc(root, "demo").unwrap().stopped.is_none());

        // Turn two ends quietly too. That is the horizon.
        entry.lock().await.turns_ended = 2;
        sweep(&ctx, &state).await;

        let record = read_arc(root, "demo").unwrap();
        assert_eq!(
            record.stopped,
            Some((ArcStage::Implement, "implement idle".to_string())),
            "the stop is written where every reader of the arc will find it"
        );
        assert!(
            submitted(&entry).await.is_empty(),
            "the horizon is a stop with a receipt, never a re-prompt"
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
                turns_seen: Some(0),
                ..Default::default()
            },
        );

        sweep(&ctx, &state).await;
        assert_eq!(state.lock().await[&demo_key(root)].quiet_turns, 1);

        // The stage closes step 2 and ends its turn.
        std::fs::write(
            root.join(".tug/dashes/demo/plan.md"),
            plan_with_statuses("done", "done"),
        )
        .unwrap();
        entry.lock().await.turns_ended = 2;
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
    async fn a_compaction_writes_the_dash_log_line_and_the_arc_note() {
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
        // The new marker moves no declaration: a reader that dates a dash from
        // every line is untroubled, and `read_arc` never learns the word.
        let declarations = tugdash_core::dash::read_declarations(root, "demo");
        assert_eq!(declarations.run_through, Some(2));
        assert!(!declarations.run_complete);

        let log = std::fs::read_to_string(
            tugtool_core::paths::project_state_dir(root).join("dash-log.md"),
        )
        .unwrap();
        let compact = log
            .lines()
            .filter_map(tugdash_core::dash::split_log_line)
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
            entry.lock().await.turns_ended = 2;
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
                    submitted(&entry).await,
                    vec![
                "/tugplug:dash-implement demo Steps 2-2 — under this arc, close one step and end your turn; the arc prompts you with the next"
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
        entry.lock().await.turns_ended = 2;
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

    /// Every tick says what it read and what it decided — including the ticks
    /// that decided nothing. The eleven-arc silence that produced this work
    /// was diagnosable only by reading, because no tick had ever said a word.
    #[tokio::test]
    async fn every_tick_logs_its_facts_and_its_decision() {
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

        let sink = Buffer(StdArc::new(StdMutex::new(Vec::new())));
        let subscriber = tracing_subscriber::fmt()
            .with_writer(sink.clone())
            .with_ansi(false)
            .without_time()
            .finish();
        let captured = {
            let _guard = tracing::subscriber::set_default(subscriber);
            // Mid-turn: the tick decides nothing, and says so.
            entry.lock().await.turn_active = true;
            sweep(&ctx, &state).await;
            entry.lock().await.turn_active = false;
            sweep(&ctx, &state).await;
            String::from_utf8(sink.0.lock().unwrap().clone()).unwrap()
        };

        let ticks: Vec<&str> = captured
            .lines()
            .filter(|line| line.contains("event=\"arc.tick\""))
            .collect();
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
    }
}
