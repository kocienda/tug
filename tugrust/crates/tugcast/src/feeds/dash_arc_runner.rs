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
use tugcast_core::protocol::{Frame, TugSessionId};
use tugdash_core::arc::{
    ArcRecord, ArcStage, ArcStopReason, append_arc_done, append_arc_note, append_arc_plan,
    append_arc_stop, read_arc, stage_model,
};
use tugutil_core::config::{Config, DashConfig};
use tugutil_core::plan;

use super::agent_supervisor::{AgentSupervisor, SpawnState};
use super::dash_arc::{
    ArcAction, ArcFacts, Rotation, StepLedgerFacts, arc_action, context_max_from_breakdown,
    step_range,
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
    let last_done_count = {
        let map = state.lock().await;
        map.get(&key).and_then(|s| s.last_done_count)
    };

    let project = arc.project.clone();
    let dash = arc.dash.clone();
    let Ok(Some(reading)) =
        tokio::task::spawn_blocking(move || read(&project, &dash, &session, last_done_count)).await
    else {
        return;
    };

    {
        let mut map = state.lock().await;
        let entry = map.entry(key.clone()).or_default();
        // A dispatched rotation whose `arc-stage` line has not landed yet: the
        // newest line still names the session that just ended, which is
        // indistinguishable from a stage that died. Wait for the line.
        if let Some(dispatched_at) = entry.in_flight_at {
            if reading.record.stages.len() <= dispatched_at {
                return;
            }
            entry.in_flight_at = None;
        }
        entry.last_done_count = retain_done_count(
            entry.last_done_count,
            reading.done_count,
            reading.facts.session_idle,
        );
    }

    let Some(action) = arc_action(&reading.record, &reading.facts) else {
        return;
    };

    match action {
        ArcAction::Rotate(rotation) => rotate(ctx, state, arc, &key, &reading, &rotation).await,
        ArcAction::Done => finish(ctx, arc, &reading, None).await,
        ArcAction::Stop { stage, reason } => finish(ctx, arc, &reading, Some((stage, reason))).await,
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
    /// The claude session running on the card carries a `stage_label` — a
    /// rotation seated it.
    stage_seated: bool,
    claude_session_id: Option<String>,
    context_window: Option<i64>,
    context_max: Option<i64>,
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
    let (live, idle, turn_ended, api_error, turn_cancelled, claude_session_id, context_window) = {
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
            !entry.turn_active,
            entry.turns_ended > 0,
            entry.turn_api_error,
            entry.turn_cancelled,
            entry.claude_session_id.clone(),
            entry.context_window_tokens,
        )
    };
    // `context_max` is the one half of the reading that is durable — the
    // persisted breakdown row carries the model's window cap. The used half
    // is the live `cost_update` figure above, because the breakdown frame
    // deliberately carries no total.
    let context_max = claude_session_id
        .as_deref()
        .and_then(|id| ctx.session_ledger.get_context_breakdown(id).ok().flatten())
        .and_then(|row| context_max_from_breakdown(&row.payload));
    // Only a rotation writes a `stage_label`, at the `session_init` that
    // follows its announcement, so the label is the durable fact that this
    // session was seated by the wheel rather than reached by the deck.
    let stage_seated = claude_session_id
        .as_deref()
        .is_some_and(|id| ctx.session_ledger.stage_provenance(id).is_some());
    Some(SessionSnapshot {
        live,
        idle,
        turn_ended,
        api_error,
        turn_cancelled,
        stage_seated,
        claude_session_id,
        context_window,
        context_max,
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
    config: DashConfig,
}

/// Gather the facts. Blocking: file reads and, for an implement stage, one
/// scoped git read.
fn read(
    project: &Path,
    dash: &str,
    session: &SessionSnapshot,
    last_done_count: Option<usize>,
) -> Option<ArcReading> {
    let record = read_arc(project, dash)?;
    let project_config = Config::load_from_project(project).unwrap_or_default();
    let config = project_config.tugtool.dash.clone();

    let document_abs = record.document.as_ref().map(|doc| project.join(doc));
    let document_exists = document_abs.as_ref().is_some_and(|p| p.is_file());
    let document_source = document_abs
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok());
    let input_is_plan = document_source
        .as_deref()
        .is_some_and(lints_as_plan);

    // What a stage is handed beyond its ask: the paths the
    // document itself cites, and what git says moved in them since the
    // document was written. Both gathered here, inside the pass that is
    // blocking by construction, and both total — a document citing nothing and
    // a repo git has never seen simply contribute no clause.
    let cited_paths = document_source
        .as_deref()
        .map(|source| {
            wheel::prompt::cited_paths(source, project, wheel::prompt::CITED_PATHS_CAP)
        })
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
    // Every stage after devise names the *dash*, not a path ([P10]): the
    // skills resolve a name, so a stage cannot be pointed at the wrong file.
    let plan_for_prompt = plan_abs.as_ref().map(|_| dash.to_string());

    let plan_abs_display = plan_abs.as_ref().map(|p| p.to_string_lossy().into_owned());
    let plan_source = plan_abs
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok());
    let doc = plan_source.as_deref().and_then(|s| plan::parse(s).ok());
    let lint_ok = doc
        .as_ref()
        .is_some_and(|d| !plan::has_errors(&plan::lint(d)));
    let review = match (doc.as_ref(), plan_source.as_deref()) {
        (Some(d), Some(source)) => Some(plan::review_state(d, source)),
        _ => None,
    };

    let done_count = doc
        .as_ref()
        .map(|d| {
            d.ledger_rows
                .iter()
                .filter(|row| row.status == "done")
                .count()
        })
        .unwrap_or(0);
    let first_pending = doc.as_ref().and_then(|d| {
        d.ledger_rows
            .iter()
            .position(|row| row.status != "done")
            .map(|index| index + 1)
    });

    let declarations = tugdash_core::dash::read_declarations(project, dash);

    let stage_session_current = match record.stages.last() {
        Some(line) => session.claude_session_id.as_deref() == Some(line.session_id.as_str()),
        None => true,
    };
    let context_fraction = match (session.context_window, session.context_max) {
        (Some(used), Some(max)) if max > 0 => Some(used as f32 / max as f32),
        _ => None,
    };

    let facts = ArcFacts {
        document_exists,
        input_is_plan,
        plan_path: plan_source
            .is_some()
            .then(|| plan_abs_display.clone())
            .flatten(),
        lint_ok,
        review,
        ledger: StepLedgerFacts {
            first_pending,
            run_through: declarations.run_through.map(|n| n as usize),
            run_complete: declarations.run_complete,
            step_just_done: last_done_count.is_some_and(|previous| done_count > previous),
        },
        session_live: session.live,
        session_idle: session.idle,
        stage_turn_ended: session.turn_ended,
        stage_api_error: session.api_error,
        stage_turn_cancelled: session.turn_cancelled,
        stage_seated: session.stage_seated,
        stage_session_current,
        context_fraction,
        rotate_at: config.rotate_at(),
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

/// The stage's opening prompt: the score's ask, plus what the documents say
/// about where to start and what has moved.
///
/// The facts were gathered in `read`'s blocking pass; the wording is the
/// wheel's, so every score composes the same way. Nothing here is a word a
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
        .score(Some(arc.dash.clone()))
        .model(stage_model(&reading.config, rotation.stage))
        .steps(
            rotation
                .steps
                .map(|(from, through)| step_range(from, through)),
        );

    let dispatched_at = reading.record.stages.len();
    let outcome = wheel::rotate(&ctx.supervisor, &request).await;
    {
        let mut map = state.lock().await;
        let entry = map.entry(key.to_string()).or_default();
        entry.in_flight_at = outcome.is_ok().then_some(dispatched_at);
        // The rotation replaces the stage, so the next tick's "a step just
        // went done" comparison starts fresh against the new stage's plan.
        entry.last_done_count = None;
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
        format!("resume with tugutil dash run {}", record.dash)
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
/// `dash_api::stop_a_scored_cards_arc_as_closed`.
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
/// rotation, an ending, a card close, and `tugutil dash stop`. Four call sites
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
                plan: None,
                stages: Vec::new(),
                notes: Vec::new(),
                stopped: None,
                resume: None,
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
        supervisor.record_arc_receipt(
            session.as_str(),
            dash,
            &project.to_string_lossy(),
            &summary,
        );
    }

    if how.record {
        let project = project.to_path_buf();
        let dash = dash.to_owned();
        let _ = tokio::task::spawn_blocking(move || append_arc_stop(&project, &dash, stage, reason))
            .await;
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
    let _ = tokio::task::spawn_blocking(move || append_arc_done(&project, &dash)).await;
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
            api_error: false,
            turn_cancelled: false,
            // A seated stage is the ordinary case; the taken-card tests build
            // their own.
            stage_seated: true,
            claude_session_id: claude.map(str::to_string),
            context_window: None,
            context_max: None,
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

        let reading = read(root, "demo", &snapshot(true, true, None), None).unwrap();
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

        let reading = read(root, "demo", &snapshot(true, true, Some("fresh")), None).unwrap();
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

        let reading = read(root, "demo", &snapshot(true, true, Some("live")), None).unwrap();
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
        let reading = read(root, "demo", &session, None).unwrap();
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
        assert_eq!(record.stopped, None, "and no stop written for a plan the stage has not begun");
    }

    #[test]
    fn a_document_that_already_lints_as_a_plan_skips_devise() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".tug/dashes/demo")).unwrap();
        std::fs::write(root.join(".tug/dashes/demo/plan.md"), LINTING_PLAN).unwrap();
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/plan.md").unwrap();

        let reading = read(root, "demo", &snapshot(true, true, None), None).unwrap();
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
            Some("/tugplug:plan-review demo")
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

        let reading = read(root, "demo", &snapshot(false, true, Some("s")), None).unwrap();
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

        let reading = read(root, "demo", &snapshot(true, false, Some("s")), None).unwrap();
        assert_eq!(arc_action(&reading.record, &reading.facts), None);
    }

    #[test]
    fn a_stopped_arc_is_not_resumed_by_a_tick() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "s", None).unwrap();
        tugdash_core::arc::append_arc_stop(root, "demo", ArcStage::Devise, ArcStopReason::Lint).unwrap();

        let reading = read(root, "demo", &snapshot(true, true, Some("s")), None).unwrap();
        assert_eq!(arc_action(&reading.record, &reading.facts), None);
    }

    #[test]
    fn the_devise_ask_names_the_brief_and_targets_the_dash() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();

        let reading = read(root, "demo", &snapshot(true, true, None), None).unwrap();
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
            "/tugplug:plan-devise a plan for .tug/dashes/demo/brief.md, honoring every [B##] decision it records 🢂 demo"
        );
    }

    /// Every stage after devise names the dash, so the skill resolves the
    /// address rather than being handed one it could write past.
    #[test]
    fn review_and_implement_asks_name_the_dash() {
        assert_eq!(
            wheel::prompt::stage_ask("review", None, "foo", None).as_deref(),
            Some("/tugplug:plan-review foo")
        );
        assert_eq!(
            wheel::prompt::stage_ask("implement", None, "foo", Some("2-4")).as_deref(),
            Some("/tugplug:dash-implement foo Steps 2-4")
        );
        assert_eq!(
            wheel::prompt::stage_ask("implement", None, "foo", None).as_deref(),
            Some("/tugplug:dash-implement foo")
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

        let reading = read(root, "demo", &snapshot(true, true, None), None).unwrap();
        assert_eq!(reading.commits_since.len(), 1, "{:?}", reading.commits_since);
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
        let reading = read(root, "demo", &snapshot(true, true, None), None).unwrap();
        assert!(reading.commits_since.is_empty(), "{:?}", reading.commits_since);
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

        let reading = read(root, "demo", &snapshot(true, true, None), None).unwrap();
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
        assert!(prompt.starts_with("/tugplug:plan-devise a plan for .tug/dashes/demo/brief.md"));
        assert!(prompt.contains("start there: src/a.rs, src/b.ts"));
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

        let reading = read(root, "demo", &snapshot(true, true, None), None).unwrap();
        let prompt = opening_prompt(
            &reading,
            &Rotation {
                stage: ArcStage::Implement,
                steps: Some((4, 9)),
                note: None,
            },
        )
        .unwrap();
        assert_eq!(prompt, "/tugplug:dash-implement demo Steps 4-9");
    }

    #[test]
    fn a_first_implement_prompt_carries_no_selector() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, ".tug/dashes/demo/brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", ".tug/dashes/demo/brief.md").unwrap();
        std::fs::write(root.join(".tug/dashes/demo/plan.md"), LINTING_PLAN).unwrap();

        let reading = read(root, "demo", &snapshot(true, true, None), None).unwrap();
        let prompt = opening_prompt(
            &reading,
            &Rotation {
                stage: ArcStage::Implement,
                steps: None,
                note: None,
            },
        )
        .unwrap();
        assert_eq!(prompt, "/tugplug:dash-implement demo");
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
                None,
            )
            .unwrap();
        ledger
            .set_dash_binding("claude-1", Some(("tugdash/demo#1", "demo")))
            .unwrap();

        // The registration receiver is handed back so each test can hold it:
        // dropping it would close the channel under a supervisor that is still
        // alive, which is not the state any of these tests is about.
        let (supervisor, register_rx) = super::super::agent_supervisor::test_minimal_supervisor();
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
        supervisor
            .ledger
            .lock()
            .await
            .insert(id, entry.clone());

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
        tugdash_core::arc::append_arc_stop(root, "demo", ArcStage::Devise, ArcStopReason::Lint).unwrap();

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
        tugdash_core::arc::append_arc_stop(root, "demo", ArcStage::Review, ArcStopReason::SpawnQueueFull)
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
        assert!(said[0].starts_with("arc stopped · demo · in devise"), "{said:?}");
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
        // What `tugutil dash stop` reaches: the same three acts every other
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
            said[0].contains("resume with tugutil dash run demo"),
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

        assert!(queued(&entry).await.is_empty(), "nothing reaches the card yet");
        assert!(
            ctx.wheel.take_hand_back("claude-1"),
            "the restore is armed for the turn's end",
        );
        assert_eq!(receipts(&mut control_rx).len(), 1, "and the card is told now");
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
            plan: Some("dash/foo.md".to_owned()),
            stages,
            notes: Vec::new(),
            stopped: None,
            resume: None,
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
                    receipt.ends_with("\nresume with tugutil dash run foo"),
                    "got {receipt}"
                );
            } else {
                assert!(receipt.ends_with("\nthere is nothing to resume"), "got {receipt}");
            }
        }

        assert_eq!(
            format_arc_stop_receipt(&record, ArcStage::Devise, ArcStopReason::Lint),
            "arc stopped · foo · in devise — the plan does not lint\n\
             resume with tugutil dash run foo"
        );
        assert_eq!(
            format_arc_stop_receipt(&record, ArcStage::Review, ArcStopReason::Discarded),
            "arc stopped · foo · in review — the dash was discarded\n\
             there is nothing to resume"
        );
        assert_eq!(
            format_arc_stop_receipt(&record, ArcStage::Implement, ArcStopReason::CardTaken),
            "arc stopped · foo · in implement — you took the card back\n\
             resume with tugutil dash run foo"
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
}
