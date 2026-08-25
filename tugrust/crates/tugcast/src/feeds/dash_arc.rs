//! The arc predicate — what a server-driven dash arc should do next, decided
//! from documents alone.
//!
//! [`arc_action`] is a first-match-wins rule list over [`ArcFacts`], in the
//! order Spec S03 states the transitions. The order *is* the specification: a
//! dead session outranks every document fact, an open turn outranks every
//! rotation, and within a stage the earlier row wins. Reordering the arms
//! changes the machine.
//!
//! # The predicate is pure
//!
//! No filesystem, no git, no process spawn, no clock. Every fact it reads is
//! one the dispatcher already gathered on a path that was going to read the
//! dash-log and the plan anyway ([P04]) — the same split `join_pilot` uses, and
//! for the same reason: a fact checked here and acted on a scheduling hop later
//! is a time-of-check/time-of-use window a second tick walks straight through,
//! so the *act* re-reads under its guard and the *decision* stays testable
//! against synthesized facts.
//!
//! # Nothing here reads a word a model wrote
//!
//! Every arm is a document fact: a file exists, `plan lint` found no errors,
//! the Review Record's newest stamp matches the content, a ledger row says
//! `done`, a recorded context reading is above a declared fraction ([B02],
//! [F04]). A stage announces nothing and is believed about nothing; it either
//! moved the documents or it did not.

use tugdash_core::arc::{ArcRecord, ArcStage};
use tugutil_core::plan::ReviewState;

/// How many review rounds an arc runs before it proceeds anyway ([P06]).
///
/// A plan a second review could not settle is one `dash-implement`'s own setup
/// gate will raise, so the arc records a note and moves rather than looping.
pub const REVIEW_CAP: usize = 2;

/// The note the cap records before it rotates to implement ([P06]).
pub const REVIEW_CAP_NOTE: &str =
    "review cap reached — the plan is still stale; dash-implement's setup gate raises it";

/// What the plan's Step Status Ledger and the dash's own run declarations say.
///
/// All of it is read from the plan at its *current* location and from the
/// dash-log's `run-through` / `step-done` lines ([P16]) — the predicate never
/// resolves a path.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StepLedgerFacts {
    /// Step number of the ledger's first row that is not `done`, 1-indexed.
    /// `None` when every row is done.
    pub first_pending: Option<usize>,
    /// The last step the implement run declared it would walk
    /// (`DashDeclarations::run_through`). `None` until a run declares one, and
    /// a continued implement stage cannot be composed without it.
    pub run_through: Option<usize>,
    /// The declared final step is `done` — the run is finished
    /// (`DashDeclarations::run_complete`).
    pub run_complete: bool,
    /// A step went `done` since the dispatcher's previous tick. It is the
    /// dispatcher's fact, not the ledger's: the ledger says which rows are
    /// done, and only a caller holding the previous reading can say one *just*
    /// became so. Rotation happens at a step boundary and never mid-step
    /// ([B15]).
    pub step_just_done: bool,
}

/// Everything the predicate is allowed to know, gathered by the dispatcher.
#[derive(Debug, Clone, PartialEq)]
pub struct ArcFacts {
    /// The input document the arc opened on still exists at its recorded path.
    pub document_exists: bool,
    /// The input document already parses and lints as a plan, so the devise
    /// stage is skipped and the first rotation is `review` (Spec S09).
    pub input_is_plan: bool,
    /// The plan's current path — the base copy until adoption, the worktree
    /// copy after it ([P16]). `None` when no plan file exists there, which is
    /// what a devise stage that produced nothing looks like.
    pub plan_path: Option<String>,
    /// `tugutil plan lint` found no errors in the plan at `plan_path`.
    pub lint_ok: bool,
    /// What the plan's Review Record says about the content on disk now.
    /// `None` when there is no plan to ask about.
    pub review: Option<ReviewState>,
    pub ledger: StepLedgerFacts,
    /// The claude session the arc's current stage runs on is still alive.
    pub session_live: bool,
    /// That session is between turns. A rotation mid-turn would kill claude
    /// mid-sentence, so nothing rotates until the turn ends ([P05], [R02]).
    pub session_idle: bool,
    /// The claude session running on the bound card is the one the newest
    /// `arc-stage` line names.
    ///
    /// False means the stage the record remembers is not the stage that is
    /// running: a tugcast restart, or a stage that died without ever ending a
    /// turn. Either way the answer is to rotate that stage again — never an
    /// earlier one ([P11]). `true` when the arc has rotated nothing yet, so
    /// the opening rotation is decided by the documents.
    pub stage_session_current: bool,
    /// The used fraction of the stage session's context window, from the
    /// latest recorded `context_breakdown`. `None` when nothing has been
    /// recorded — a missing measurement is not a reason to guess ([P07]).
    pub context_fraction: Option<f32>,
    /// The fraction above which a continued implement stage rotates,
    /// `[tugtool.dash].implement_rotate_at`.
    pub rotate_at: f32,
}

/// The used fraction of a session's context window, from the two halves that
/// carry it ([P07]).
///
/// The persisted `context_breakdown_latest` payload holds the **cap** and the
/// session-stable categories; it deliberately carries no total and no
/// `messages` category, both of which the deck derives feed-exact. So the cap
/// comes from that row and the used figure from the session's latest
/// `cost_update` window. One helper, so a payload shape change breaks in one
/// place.
pub fn context_max_from_breakdown(payload: &[u8]) -> Option<i64> {
    let value: serde_json::Value = serde_json::from_slice(payload).ok()?;
    let max = value.get("context_max")?.as_i64()?;
    (max > 0).then_some(max)
}

/// The inclusive step range a continued implement stage walks, as the opening
/// prompt and the transcript's divider both spell it ([P07], [B13]).
pub fn step_range(from: usize, through: usize) -> String {
    format!("{from}-{through}")
}

/// A rotation the runner should perform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rotation {
    pub stage: ArcStage,
    /// The inclusive step range a continued implement stage's opening prompt
    /// names ([P07], Spec S09). `None` for every other rotation.
    pub steps: Option<(usize, usize)>,
    /// A note the runner records before rotating ([P06]).
    pub note: Option<String>,
}

impl Rotation {
    fn plain(stage: ArcStage) -> Rotation {
        Rotation {
            stage,
            steps: None,
            note: None,
        }
    }
}

/// What the arc should do next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArcAction {
    Rotate(Rotation),
    /// The run's declared final step is `done` ([P12]).
    Done,
    /// The arc cannot continue, and says which stage it was in and why
    /// ([P11], [L31]).
    Stop { stage: ArcStage, reason: String },
}

/// Decide the arc's next act, or `None` when it should sit still.
///
/// The arms are in Spec S03's order and the first match wins.
pub fn arc_action(record: &ArcRecord, facts: &ArcFacts) -> Option<ArcAction> {
    // A finished or stopped arc is not advanced by a tick. Resuming a stopped
    // arc is an explicit `/dash`, which rotates the stopped stage again and
    // clears the stop by doing so ([P11]).
    if record.done || record.stopped.is_some() {
        return None;
    }

    let stage = record.current_stage();

    // A dead session outranks every document fact: whatever the documents say,
    // there is nothing left to advance ([P11]).
    if !facts.session_live {
        return Some(ArcAction::Stop {
            stage: stage.unwrap_or(ArcStage::Devise),
            reason: "session gone".to_string(),
        });
    }

    // Nothing rotates mid-turn.
    if !facts.session_idle {
        return None;
    }

    // A recorded stage that is not the one running is a stage that died —
    // a restart, or a crash that never sent a turn end. Re-rotate that stage,
    // never an earlier one ([P11]); the runner's in-flight guard is what keeps
    // the window between a dispatch and its `arc-stage` line from reading as
    // this ([R01]).
    if let Some(stage) = stage {
        if !facts.stage_session_current {
            return Some(ArcAction::Rotate(Rotation {
                stage,
                steps: (stage == ArcStage::Implement)
                    .then(|| facts.ledger.first_pending.zip(facts.ledger.run_through))
                    .flatten(),
                note: None,
            }));
        }
    }

    match stage {
        None => Some(start_action(facts)),
        Some(ArcStage::Devise) => Some(devise_action(facts)),
        Some(ArcStage::Review) => Some(review_action(record, facts)),
        Some(ArcStage::Implement) => implement_action(facts),
    }
}

fn start_action(facts: &ArcFacts) -> ArcAction {
    if !facts.document_exists {
        return ArcAction::Stop {
            stage: ArcStage::Devise,
            reason: "document missing".to_string(),
        };
    }
    // A document that already lints as a plan takes the arc straight to review
    // (Spec S09). A brief does not parse as a plan and takes the full arc.
    let stage = if facts.input_is_plan {
        ArcStage::Review
    } else {
        ArcStage::Devise
    };
    ArcAction::Rotate(Rotation::plain(stage))
}

fn devise_action(facts: &ArcFacts) -> ArcAction {
    if facts.plan_path.is_some() && facts.lint_ok {
        ArcAction::Rotate(Rotation::plain(ArcStage::Review))
    } else {
        // The stage's own turn has ended and the plan still does not lint, so
        // waiting another tick would only wait forever.
        ArcAction::Stop {
            stage: ArcStage::Devise,
            reason: "lint".to_string(),
        }
    }
}

fn review_action(record: &ArcRecord, facts: &ArcFacts) -> ArcAction {
    if facts.plan_path.is_none() {
        return ArcAction::Stop {
            stage: ArcStage::Review,
            reason: "plan missing".to_string(),
        };
    }
    if facts.review == Some(ReviewState::Reviewed) {
        return ArcAction::Rotate(Rotation::plain(ArcStage::Implement));
    }
    // Stale, or a round that ended without stamping — the same fact for the
    // cap's purposes: the newest content is not vouched for.
    if record.review_rounds() < REVIEW_CAP {
        ArcAction::Rotate(Rotation::plain(ArcStage::Review))
    } else {
        ArcAction::Rotate(Rotation {
            stage: ArcStage::Implement,
            steps: None,
            note: Some(REVIEW_CAP_NOTE.to_string()),
        })
    }
}

fn implement_action(facts: &ArcFacts) -> Option<ArcAction> {
    if facts.ledger.run_complete {
        return Some(ArcAction::Done);
    }
    // Rotation is a step-boundary act, and only a measured reading justifies
    // one ([P07], [B15]).
    if !facts.ledger.step_just_done {
        return None;
    }
    let fraction = facts.context_fraction?;
    if fraction <= facts.rotate_at {
        return None;
    }
    let next = facts.ledger.first_pending?;
    let through = facts.ledger.run_through?;
    if next > through {
        return None;
    }
    Some(ArcAction::Rotate(Rotation {
        stage: ArcStage::Implement,
        steps: Some((next, through)),
        note: None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tugdash_core::arc::ArcStageLine;

    fn record(stages: &[ArcStage]) -> ArcRecord {
        ArcRecord {
            dash: "demo".to_string(),
            document: Some("dash/demo-brief.md".to_string()),
            plan: Some("dash/demo.md".to_string()),
            stages: stages
                .iter()
                .map(|stage| ArcStageLine {
                    stage: *stage,
                    session_id: "sess".to_string(),
                    model: None,
                    at: "2026-08-24T00:00:00Z".to_string(),
                })
                .collect(),
            notes: Vec::new(),
            stopped: None,
            done: false,
            last_activity: Some("2026-08-24T00:00:00Z".to_string()),
        }
    }

    fn facts() -> ArcFacts {
        ArcFacts {
            document_exists: true,
            input_is_plan: false,
            plan_path: Some("dash/demo.md".to_string()),
            lint_ok: true,
            review: Some(ReviewState::Reviewed),
            ledger: StepLedgerFacts::default(),
            session_live: true,
            session_idle: true,
            stage_session_current: true,
            context_fraction: None,
            rotate_at: 0.6,
        }
    }

    fn rotation(action: Option<ArcAction>) -> Rotation {
        match action {
            Some(ArcAction::Rotate(rotation)) => rotation,
            other => panic!("expected a rotation, got {other:?}"),
        }
    }

    #[test]
    fn an_opened_arc_rotates_devise_when_its_document_is_not_a_plan() {
        let action = arc_action(&record(&[]), &facts());
        assert_eq!(rotation(action).stage, ArcStage::Devise);
    }

    #[test]
    fn an_opened_arc_on_a_document_that_already_lints_skips_devise() {
        let mut facts = facts();
        facts.input_is_plan = true;
        let action = arc_action(&record(&[]), &facts);
        assert_eq!(rotation(action).stage, ArcStage::Review);
    }

    #[test]
    fn an_opened_arc_whose_document_is_gone_stops() {
        let mut facts = facts();
        facts.document_exists = false;
        assert_eq!(
            arc_action(&record(&[]), &facts),
            Some(ArcAction::Stop {
                stage: ArcStage::Devise,
                reason: "document missing".to_string(),
            })
        );
    }

    #[test]
    fn a_devise_stage_that_produced_a_linting_plan_rotates_review() {
        let action = arc_action(&record(&[ArcStage::Devise]), &facts());
        assert_eq!(rotation(action).stage, ArcStage::Review);
    }

    #[test]
    fn a_devise_stage_whose_plan_does_not_lint_stops_on_lint() {
        let mut facts = facts();
        facts.lint_ok = false;
        assert_eq!(
            arc_action(&record(&[ArcStage::Devise]), &facts),
            Some(ArcAction::Stop {
                stage: ArcStage::Devise,
                reason: "lint".to_string(),
            })
        );
    }

    #[test]
    fn a_devise_stage_that_wrote_no_plan_at_all_stops_on_lint() {
        let mut facts = facts();
        facts.plan_path = None;
        assert_eq!(
            arc_action(&record(&[ArcStage::Devise]), &facts),
            Some(ArcAction::Stop {
                stage: ArcStage::Devise,
                reason: "lint".to_string(),
            })
        );
    }

    #[test]
    fn a_reviewed_plan_rotates_implement() {
        let action = arc_action(&record(&[ArcStage::Devise, ArcStage::Review]), &facts());
        let rotation = rotation(action);
        assert_eq!(rotation.stage, ArcStage::Implement);
        assert_eq!(rotation.note, None);
    }

    #[test]
    fn a_stale_plan_under_the_cap_rotates_review_again() {
        let mut facts = facts();
        facts.review = Some(ReviewState::Stale);
        let action = arc_action(&record(&[ArcStage::Devise, ArcStage::Review]), &facts);
        assert_eq!(rotation(action).stage, ArcStage::Review);
    }

    #[test]
    fn a_stale_plan_at_the_cap_rotates_implement_and_carries_the_note() {
        let mut facts = facts();
        facts.review = Some(ReviewState::Stale);
        let record = record(&[ArcStage::Devise, ArcStage::Review, ArcStage::Review]);
        let rotation = rotation(arc_action(&record, &facts));
        assert_eq!(rotation.stage, ArcStage::Implement);
        assert_eq!(rotation.note.as_deref(), Some(REVIEW_CAP_NOTE));
    }

    #[test]
    fn a_round_that_never_stamped_counts_the_same_as_a_stale_one() {
        let mut facts = facts();
        facts.review = Some(ReviewState::NeverReviewed);
        let action = arc_action(&record(&[ArcStage::Review]), &facts);
        assert_eq!(rotation(action).stage, ArcStage::Review);
    }

    #[test]
    fn a_review_stage_whose_plan_vanished_stops() {
        let mut facts = facts();
        facts.plan_path = None;
        facts.review = None;
        assert_eq!(
            arc_action(&record(&[ArcStage::Review]), &facts),
            Some(ArcAction::Stop {
                stage: ArcStage::Review,
                reason: "plan missing".to_string(),
            })
        );
    }

    #[test]
    fn a_finished_run_is_done() {
        let mut facts = facts();
        facts.ledger.run_complete = true;
        assert_eq!(
            arc_action(&record(&[ArcStage::Implement]), &facts),
            Some(ArcAction::Done)
        );
    }

    /// The four rows of [P07], one test each. `rotate_at` is `0.6`, the
    /// declared default.
    fn implementing(fraction: Option<f32>, step_just_done: bool) -> ArcFacts {
        let mut facts = facts();
        facts.ledger.step_just_done = step_just_done;
        facts.ledger.first_pending = Some(4);
        facts.ledger.run_through = Some(9);
        facts.context_fraction = fraction;
        facts
    }

    #[test]
    fn above_the_threshold_at_a_step_boundary_rotates_with_the_step_range() {
        let action = arc_action(
            &record(&[ArcStage::Implement]),
            &implementing(Some(0.72), true),
        );
        let rotation = rotation(action);
        assert_eq!(rotation.stage, ArcStage::Implement);
        assert_eq!(rotation.steps, Some((4, 9)));
    }

    #[test]
    fn below_the_threshold_does_not_rotate() {
        assert_eq!(
            arc_action(
                &record(&[ArcStage::Implement]),
                &implementing(Some(0.41), true)
            ),
            None
        );
    }

    #[test]
    fn above_the_threshold_mid_step_does_not_rotate() {
        assert_eq!(
            arc_action(
                &record(&[ArcStage::Implement]),
                &implementing(Some(0.94), false)
            ),
            None
        );
    }

    #[test]
    fn an_implement_stage_with_steps_left_and_no_reading_sits_still() {
        assert_eq!(
            arc_action(&record(&[ArcStage::Implement]), &implementing(None, true)),
            None
        );
    }

    #[test]
    fn a_step_range_is_spelled_the_same_everywhere_it_appears() {
        assert_eq!(step_range(4, 9), "4-9");
    }

    #[test]
    fn a_context_cap_is_read_from_the_breakdown_payload_and_nowhere_else() {
        assert_eq!(
            context_max_from_breakdown(br#"{"context_max":200000,"categories":[]}"#),
            Some(200_000)
        );
        // No cap, a zero cap, or a payload that is not one at all: no reading,
        // and a missing measurement never becomes a guess.
        assert_eq!(context_max_from_breakdown(br#"{"categories":[]}"#), None);
        assert_eq!(context_max_from_breakdown(br#"{"context_max":0}"#), None);
        assert_eq!(context_max_from_breakdown(b"not json"), None);
    }

    #[test]
    fn a_dead_session_stops_the_arc_whatever_the_documents_say() {
        let mut facts = facts();
        facts.session_live = false;
        assert_eq!(
            arc_action(&record(&[ArcStage::Review]), &facts),
            Some(ArcAction::Stop {
                stage: ArcStage::Review,
                reason: "session gone".to_string(),
            })
        );
    }

    #[test]
    fn a_mid_turn_session_yields_nothing() {
        let mut facts = facts();
        facts.session_idle = false;
        assert_eq!(arc_action(&record(&[ArcStage::Devise]), &facts), None);
    }

    #[test]
    fn a_stopped_arc_is_not_advanced_by_a_tick() {
        let mut record = record(&[ArcStage::Devise]);
        record.stopped = Some((ArcStage::Devise, "lint".to_string()));
        assert_eq!(arc_action(&record, &facts()), None);
    }

    #[test]
    fn a_done_arc_is_not_advanced_by_a_tick() {
        let mut record = record(&[ArcStage::Implement]);
        record.done = true;
        assert_eq!(arc_action(&record, &facts()), None);
    }
}
