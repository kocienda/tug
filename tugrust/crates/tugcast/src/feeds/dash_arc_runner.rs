//! The arc runner — the act half of the arc ([P04]).
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
//! `base_motion`'s ([P05]). The changeset recompute is the floor, for a stage
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
//! rotation ([R01]).
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
    ArcRecord, ArcStage, append_arc_done, append_arc_note, append_arc_plan, append_arc_stop,
    read_arc,
};
use tugutil_core::config::{Config, DashConfig};
use tugutil_core::plan;

use super::agent_supervisor::{AgentSupervisor, SpawnState, StageSpec};
use super::dash_arc::{
    ArcAction, ArcFacts, Rotation, StepLedgerFacts, arc_action, context_max_from_breakdown,
    step_range,
};
use crate::session_ledger::SessionLedger;

/// What the engine needs to run.
pub struct ArcContext {
    pub supervisor: Arc<AgentSupervisor>,
    pub session_ledger: Arc<SessionLedger>,
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
    /// boundary rather than a mid-step interruption ([B15]).
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
/// Bound-ness is the dash binding ([P01]) and nothing else: the arc record
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
        // indistinguishable from a stage that died. Wait for the line ([R01]).
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
    let (live, idle, turn_ended, claude_session_id, context_window) = {
        let entry = entry_arc.lock().await;
        let live = match entry.spawn_state {
            SpawnState::Idle => return None,
            SpawnState::Spawning | SpawnState::Live => true,
            SpawnState::Errored | SpawnState::Closed => false,
        };
        (
            live,
            !entry.turn_active,
            entry.turns_ended > 0,
            entry.claude_session_id.clone(),
            entry.context_window_tokens,
        )
    };
    // `context_max` is the one half of the reading that is durable — the
    // persisted breakdown row carries the model's window cap. The used half
    // is the live `cost_update` figure above, because the breakdown frame
    // deliberately carries no total ([P07]).
    let context_max = claude_session_id
        .as_deref()
        .and_then(|id| ctx.session_ledger.get_context_breakdown(id).ok().flatten())
        .and_then(|row| context_max_from_breakdown(&row.payload));
    Some(SessionSnapshot {
        live,
        idle,
        turn_ended,
        claude_session_id,
        context_window,
        context_max,
    })
}

/// Everything one tick read, kept together so the act does not read it again.
struct ArcReading {
    record: ArcRecord,
    facts: ArcFacts,
    /// How many ledger rows read `done` — the next tick's comparison point.
    done_count: usize,
    /// The plan path as the stage's prompt should name it, from the card's own
    /// project dir ([P14], [P16]).
    plan_for_prompt: Option<String>,
    /// Where the devise stage should write its plan: `<docs>/<dash>.md`.
    devise_target: Option<String>,
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
    let input_is_plan = document_abs
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .is_some_and(|source| lints_as_plan(&source));

    // Where the plan lives *now* ([P16]): the worktree copy from adoption on,
    // the base copy before it. The git read is scoped to this one dash and
    // only happens once the arc has reached implement.
    let detail = (record.current_stage() == Some(ArcStage::Implement))
        .then(|| tugdash_core::ops::dash_detail_entry_in(project, dash))
        .flatten();
    let (plan_abs, plan_for_prompt) = match detail
        .as_ref()
        .and_then(|d| d.plan_path.as_ref().map(|p| (d, p)))
    {
        Some((detail, rel)) => {
            let abs = Path::new(&detail.worktree_abs).join(rel);
            let spelling = abs.to_string_lossy().into_owned();
            (Some(abs), Some(spelling))
        }
        None => match record.plan.as_ref() {
            Some(rel) => (Some(project.join(rel)), Some(rel.clone())),
            None => (None, None),
        },
    };

    let plan_source = plan_abs
        .as_ref()
        .filter(|p| p.is_file())
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
        plan_path: plan_source.is_some().then(|| {
            plan_for_prompt
                .clone()
                .unwrap_or_else(|| dash.to_string())
        }),
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
        stage_session_current,
        context_fraction,
        rotate_at: config.rotate_at(),
    };

    let devise_target = project_config
        .docs_dir(project)
        .map(|dir| dir.join(format!("{dash}.md")))
        .and_then(|abs| {
            abs.strip_prefix(project)
                .ok()
                .map(|rel| rel.to_string_lossy().into_owned())
                .or_else(|| Some(abs.to_string_lossy().into_owned()))
        });

    Some(ArcReading {
        record,
        facts,
        done_count,
        plan_for_prompt,
        devise_target,
        config,
    })
}

/// Whether a document already *is* a plan — the fact that lets an arc opened on
/// one skip the devise stage (Spec S09). A brief does not parse as a plan and
/// takes the full arc.
fn lints_as_plan(source: &str) -> bool {
    match plan::parse(source) {
        Ok(doc) => !plan::has_errors(&plan::lint(&doc)),
        Err(_) => false,
    }
}

/// The model the project declared for a stage ([P13]). `None` is the account
/// default, which sends no `model_change` frame at all.
fn stage_model(config: &DashConfig, stage: ArcStage) -> Option<String> {
    match stage {
        ArcStage::Devise => config.devise_model.clone(),
        ArcStage::Review => config.review_model.clone(),
        ArcStage::Implement => config.implement_model.clone(),
    }
}

/// The stage's opening prompt (Spec S09). Every character of it is composed
/// from the arc record and the project's declarations; nothing here is a word
/// a model wrote.
fn opening_prompt(reading: &ArcReading, rotation: &Rotation) -> Option<String> {
    match rotation.stage {
        ArcStage::Devise => {
            let document = reading.record.document.as_deref()?;
            let target = reading.devise_target.as_deref()?;
            Some(format!(
                "/tugplug:plan-devise a plan for {document}, honoring every [B##] decision it records 🢂 {target}"
            ))
        }
        ArcStage::Review => Some(format!(
            "/tugplug:plan-review {}",
            reading.plan_for_prompt.as_deref()?
        )),
        ArcStage::Implement => {
            let plan = reading.plan_for_prompt.as_deref()?;
            Some(match rotation.steps {
                // No selector on the first implement stage: the whole plan, and
                // `dash-implement`'s own setup declares `--through`.
                None => format!("/tugplug:dash-implement {plan}"),
                Some((from, through)) => {
                    format!(
                        "/tugplug:dash-implement {plan} Steps {}",
                        step_range(from, through)
                    )
                }
            })
        }
    }
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
    // one decided over facts that may already have moved ([R01]).
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
        stop(ctx, arc, rotation.stage, "prompt unavailable").await;
        return;
    };
    let Some(document) = reading.record.document.clone() else {
        stop(ctx, arc, rotation.stage, "document missing").await;
        return;
    };

    // The devise rotation is where the plan's path is *chosen*, so it is
    // recorded here rather than discovered later ([P16]).
    let project = arc.project.clone();
    let dash = arc.dash.clone();
    if rotation.stage == ArcStage::Devise {
        if let Some(target) = reading.devise_target.clone() {
            let (p, d) = (project.clone(), dash.clone());
            let _ = tokio::task::spawn_blocking(move || append_arc_plan(&p, &d, &target)).await;
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
    let spec = StageSpec {
        stage: rotation.stage.as_str().to_string(),
        document,
        plan: plan_for_stage,
        arc: arc.dash.clone(),
        model: stage_model(&reading.config, rotation.stage),
        steps: rotation
            .steps
            .map(|(from, through)| step_range(from, through)),
        prompt,
    };

    let dispatched_at = reading.record.stages.len();
    let outcome = ctx.supervisor.drive_stage(&arc.session, &spec).await;
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
            stop(ctx, arc, rotation.stage, refusal.reason()).await;
        }
    }
}

/// End the arc: hand the card back on the deck's own model, then record it.
///
/// The model restore goes first so the card the user is handed back is already
/// theirs by the time the terminal line lands ([P15]).
/// The arc's terminal receipt, as one string ([P12]).
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
/// so it does not read as one ([P12]) — but it happened on this card, and
/// the card is where the user is watching, so it says which stage stopped,
/// why, and what resumes it ([P11]).
fn format_arc_stop_receipt(record: &ArcRecord, stage: ArcStage, reason: &str) -> String {
    let why = match reason {
        "lint" => "the plan does not lint".to_string(),
        "document missing" => "the document it opened on is gone".to_string(),
        "plan missing" => "the plan is gone".to_string(),
        "session gone" => "its session ended".to_string(),
        other => other.to_string(),
    };
    format!(
        "arc stopped · {} · in {} — {why}\nresume with tugutil dash run {}",
        record.dash,
        stage.as_str(),
        record.dash,
    )
}

async fn finish(
    ctx: &ArcContext,
    arc: &BoundArc,
    reading: &ArcReading,
    stopped: Option<(ArcStage, String)>,
) {
    // Either ending leaves a receipt on the card: the done ending's says the
    // arc completed ([P12]); a stop's says where it stopped and why, so the
    // card the user is watching is never the last to know ([L31]).
    let summary = match stopped.as_ref() {
        None => format_arc_receipt(&reading.record),
        Some((stage, reason)) => format_arc_stop_receipt(&reading.record, *stage, reason),
    };
    ctx.supervisor.record_arc_receipt(
        arc.session.as_str(),
        &arc.dash,
        &arc.project.to_string_lossy(),
        &summary,
    );
    if let Err(refusal) = ctx.supervisor.restore_deck_model(&arc.session).await {
        warn!(
            dash = %arc.dash,
            reason = refusal.reason(),
            "arc could not restore the deck's model",
        );
    }
    let project = arc.project.clone();
    let dash = arc.dash.clone();
    let _ = tokio::task::spawn_blocking(move || match stopped {
        Some((stage, reason)) => append_arc_stop(&project, &dash, stage, &reason),
        None => append_arc_done(&project, &dash),
    })
    .await;
}

/// Record a stop and hand the card back, for a refusal discovered mid-rotation.
async fn stop(ctx: &ArcContext, arc: &BoundArc, stage: ArcStage, reason: &str) {
    if let Err(refusal) = ctx.supervisor.restore_deck_model(&arc.session).await {
        warn!(
            dash = %arc.dash,
            reason = refusal.reason(),
            "arc could not restore the deck's model",
        );
    }
    let project = arc.project.clone();
    let dash = arc.dash.clone();
    let reason = reason.to_string();
    let _ = tokio::task::spawn_blocking(move || append_arc_stop(&project, &dash, stage, &reason))
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

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
            claude_session_id: claude.map(str::to_string),
            context_window: None,
            context_max: None,
        }
    }

    fn project_with_document(root: &Path, document: &str) {
        std::fs::create_dir_all(root.join("dash")).unwrap();
        std::fs::write(root.join(document), "# A brief\n\nSome prose.\n").unwrap();
        std::fs::create_dir_all(root.join(".tugtool")).unwrap();
    }

    #[test]
    fn an_opened_arc_reads_its_document_and_wants_devise() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, "dash/demo-brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", "dash/demo-brief.md").unwrap();

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
        project_with_document(root, "dash/demo-brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", "dash/demo-brief.md").unwrap();
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
        project_with_document(root, "dash/demo-brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", "dash/demo-brief.md").unwrap();
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
                reason: "lint".to_string(),
            })
        );
    }

    #[test]
    fn a_seated_stage_that_has_ended_no_turn_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, "dash/demo-brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", "dash/demo-brief.md").unwrap();
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
        project_with_document(root, "dash/demo-brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", "dash/demo-brief.md").unwrap();
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
        std::fs::create_dir_all(root.join("dash")).unwrap();
        std::fs::write(root.join("dash/demo.md"), LINTING_PLAN).unwrap();
        tugdash_core::arc::append_arc_start(root, "demo", "dash/demo.md").unwrap();

        let reading = read(root, "demo", &snapshot(true, true, None), None).unwrap();
        assert!(reading.facts.input_is_plan);
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
        project_with_document(root, "dash/demo-brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", "dash/demo-brief.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Review, "s", None).unwrap();

        let reading = read(root, "demo", &snapshot(false, true, Some("s")), None).unwrap();
        assert_eq!(
            arc_action(&reading.record, &reading.facts),
            Some(ArcAction::Stop {
                stage: ArcStage::Review,
                reason: "session gone".to_string(),
            })
        );
    }

    #[test]
    fn a_mid_turn_card_yields_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, "dash/demo-brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", "dash/demo-brief.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "s", None).unwrap();

        let reading = read(root, "demo", &snapshot(true, false, Some("s")), None).unwrap();
        assert_eq!(arc_action(&reading.record, &reading.facts), None);
    }

    #[test]
    fn a_stopped_arc_is_not_resumed_by_a_tick() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, "dash/demo-brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", "dash/demo-brief.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "s", None).unwrap();
        tugdash_core::arc::append_arc_stop(root, "demo", ArcStage::Devise, "lint").unwrap();

        let reading = read(root, "demo", &snapshot(true, true, Some("s")), None).unwrap();
        assert_eq!(arc_action(&reading.record, &reading.facts), None);
    }

    #[test]
    fn the_devise_prompt_names_the_document_and_the_declared_docs_dir() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, "dash/demo-brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.dash]\ndocs = \"dash\"\n",
        )
        .unwrap();
        tugdash_core::arc::append_arc_start(root, "demo", "dash/demo-brief.md").unwrap();

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
            "/tugplug:plan-devise a plan for dash/demo-brief.md, honoring every [B##] decision it records 🢂 dash/demo.md"
        );
    }

    #[test]
    fn a_continued_implement_prompt_carries_its_step_range() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, "dash/demo-brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", "dash/demo-brief.md").unwrap();
        tugdash_core::arc::append_arc_plan(root, "demo", "dash/demo.md").unwrap();

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
        assert_eq!(prompt, "/tugplug:dash-implement dash/demo.md Steps 4-9");
    }

    #[test]
    fn a_first_implement_prompt_carries_no_selector() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, "dash/demo-brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", "dash/demo-brief.md").unwrap();
        tugdash_core::arc::append_arc_plan(root, "demo", "dash/demo.md").unwrap();

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
        assert_eq!(prompt, "/tugplug:dash-implement dash/demo.md");
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
        project_with_document(root, "dash/demo-brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.dash]\ndocs = \"dash\"\n",
        )
        .unwrap();
        tugdash_core::arc::append_arc_start(root, "demo", "dash/demo-brief.md").unwrap();

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
        project_with_document(root, "dash/demo-brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", "dash/demo-brief.md").unwrap();

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
        project_with_document(root, "dash/demo-brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", "dash/demo-brief.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();
        tugdash_core::arc::append_arc_stop(root, "demo", ArcStage::Devise, "lint").unwrap();

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
        project_with_document(root, "dash/demo-brief.md");
        std::fs::write(
            root.join(".tugtool/config.toml"),
            "[tugtool.dash]\ndocs = \"dash\"\n",
        )
        .unwrap();
        tugdash_core::arc::append_arc_start(root, "demo", "dash/demo-brief.md").unwrap();
        // A stage recorded against a session that is no longer the one on the
        // card — what a tugcast restart leaves behind.
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "gone", None).unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        let state = Arc::new(Mutex::new(HashMap::new()));

        sweep(&ctx, &state).await;
        assert_eq!(entry.lock().await.queue.len(), 2, "the stage rotated again");
        sweep(&ctx, &state).await;
        assert_eq!(entry.lock().await.queue.len(), 2, "and only once");
    }

    #[tokio::test]
    async fn a_card_that_has_not_spawned_since_startup_is_a_wait_not_a_stop() {
        // The startup sweep runs before any deck reconnects: every bound arc's
        // card is either absent from the supervisor or parked `Idle`. Neither
        // is "session gone" — reading it so would stop every in-flight arc on
        // every tugcast restart.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, "dash/demo-brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", "dash/demo-brief.md").unwrap();
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
        // [P11] end to end at the runner: `dash run` on a stopped arc writes
        // `arc-resume`, and the next idle tick rotates that stage — not the
        // one before it, and not nothing.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, "dash/demo-brief.md");
        std::fs::write(root.join("dash/demo.md"), LINTING_PLAN).unwrap();
        tugdash_core::arc::append_arc_start(root, "demo", "dash/demo-brief.md").unwrap();
        tugdash_core::arc::append_arc_plan(root, "demo", "dash/demo.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();
        tugdash_core::arc::append_arc_stop(root, "demo", ArcStage::Review, "spawn queue full")
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
        project_with_document(root, "dash/demo-brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", "dash/demo-brief.md").unwrap();
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

    #[tokio::test]
    async fn a_card_that_never_chose_a_model_is_handed_back_the_default() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        project_with_document(root, "dash/demo-brief.md");
        tugdash_core::arc::append_arc_start(root, "demo", "dash/demo-brief.md").unwrap();
        tugdash_core::arc::append_arc_stage(root, "demo", ArcStage::Devise, "claude-1", None)
            .unwrap();

        let (ctx, entry, _register_rx) = harness(root).await;
        let state = Arc::new(Mutex::new(HashMap::new()));
        sweep(&ctx, &state).await;

        let frame = entry.lock().await.queue.pop().unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(parsed["model"], "default");
    }

    /// [P16]: adoption commits the plan on the dash branch and **cleans the
    /// base copy**, so a runner that kept reading the devise path would see
    /// "plan gone" and stop a healthy arc. A real checkout with a real linked
    /// worktree, because the path being tested is the one `DashDetail`
    /// composes from git.
    #[test]
    fn after_adoption_the_facts_come_from_the_worktree_copy() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("checkout");
        // `.tug/worktrees/<name>` is where tugdash-core composes a dash's
        // worktree path from, so that is where the linked worktree has to be
        // for `DashDetail` to find it.
        let worktree = root.join(".tug/worktrees/demo");
        std::fs::create_dir_all(&root).unwrap();
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .expect("git runs")
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "T"]);
        std::fs::create_dir_all(root.join("dash")).unwrap();
        std::fs::write(root.join("dash/demo-brief.md"), "# A brief\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-qm", "seed"]);
        git(&[
            "worktree",
            "add",
            "-q",
            "-b",
            "tugdash/demo",
            worktree.to_str().unwrap(),
        ]);

        // The plan as adoption leaves it: in the worktree, gone from the base
        // checkout, and its path recorded on the branch.
        std::fs::create_dir_all(worktree.join("dash")).unwrap();
        std::fs::write(worktree.join("dash/demo.md"), LINTING_PLAN).unwrap();
        tugdash_core::ops::set_dash_plan_path(&root, "demo", "dash/demo.md").unwrap();

        tugdash_core::arc::append_arc_start(&root, "demo", "dash/demo-brief.md").unwrap();
        tugdash_core::arc::append_arc_plan(&root, "demo", "dash/demo.md").unwrap();
        tugdash_core::arc::append_arc_stage(&root, "demo", ArcStage::Implement, "claude-1", None)
            .unwrap();
        assert!(
            !root.join("dash/demo.md").exists(),
            "the base copy is gone, which is the whole point"
        );

        let reading = read(&root, "demo", &snapshot(true, true, Some("claude-1")), None).unwrap();
        assert!(
            reading
                .plan_for_prompt
                .as_deref()
                .is_some_and(|p| p.ends_with("dash/demo.md") && p != "dash/demo.md"),
            "the prompt names the worktree copy by absolute path, got {:?}",
            reading.plan_for_prompt
        );
        assert!(reading.facts.lint_ok, "and the facts came from it");
        assert_eq!(
            arc_action(&reading.record, &reading.facts),
            None,
            "an implement stage with steps left and no reading sits still — \
             the base path's absence is not a stop"
        );
    }

    #[test]
    fn a_stage_model_comes_from_the_projects_own_declaration() {
        let mut config = DashConfig::default();
        assert_eq!(stage_model(&config, ArcStage::Review), None);
        config.review_model = Some("opus".to_string());
        assert_eq!(
            stage_model(&config, ArcStage::Review),
            Some("opus".to_string())
        );
        assert_eq!(stage_model(&config, ArcStage::Devise), None);
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
            "the receipt never offers the join — the shade does ([P12])"
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
