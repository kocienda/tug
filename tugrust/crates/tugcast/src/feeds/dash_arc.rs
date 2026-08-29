//! The arc predicate — what a server-driven dash arc should do next, decided
//! from documents alone.
//!
//! [`arc_action`] is a first-match-wins rule list over [`ArcFacts`], in the
//! order the doctrine states the transitions. The order *is* the specification: a
//! dead session outranks every document fact, an open turn outranks every
//! rotation, and within a stage the earlier row wins. Reordering the arms
//! changes the machine.
//!
//! # The predicate is pure
//!
//! No filesystem, no git, no process spawn, no clock. Every fact it reads is
//! one the dispatcher already gathered on a path that was going to read the
//! dash-log and the plan anyway — the same split `join_pilot` uses, and
//! for the same reason: a fact checked here and acted on a scheduling hop later
//! is a time-of-check/time-of-use window a second tick walks straight through,
//! so the *act* re-reads under its guard and the *decision* stays testable
//! against synthesized facts.
//!
//! # Nothing here reads a word a model wrote
//!
//! Every arm is a document fact: a file exists, `plan lint` found no errors,
//! the Review Record's newest stamp matches the content, a ledger row says
//! `done`, a recorded context reading is above a declared fraction. A stage announces nothing and is believed about nothing; it either
//! moved the documents or it did not.

use tugdash_core::arc::{ArcRecord, ArcStage, ArcStopReason};
use tugutil_core::plan::ReviewState;

/// How many review rounds an arc runs before it proceeds anyway.
///
/// A plan a second review could not settle is one `dash-implement`'s own setup
/// gate will raise, so the arc records a note and moves rather than looping.
pub const REVIEW_CAP: usize = 2;

/// What the plan's Step Status Ledger and the dash's own run declarations say.
///
/// All of it is read from the plan at its *current* location and from the
/// dash-log's `run-through` / `step-done` lines — the predicate never
/// resolves a path.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StepLedgerFacts {
    /// Step number of the ledger's first row that is neither `done` nor
    /// `withdrawn`, 1-indexed. `None` when every row is closed.
    ///
    /// A withdrawn row is skipped because this is where a rotated implement
    /// stage resumes: returning one would send a fresh session to a step
    /// nobody intends to walk, and it could not close it — the withdrawal is
    /// the decision, and re-walking the row would defeat it.
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
    /// became so. Rotation happens at a step boundary and never mid-step.
    pub step_just_done: bool,
}

/// Everything the predicate is allowed to know, gathered by the dispatcher.
#[derive(Debug, Clone, PartialEq)]
pub struct ArcFacts {
    /// The input document the arc opened on still exists at its recorded path.
    pub document_exists: bool,
    /// The input document already parses and lints as a plan, so the devise
    /// stage is skipped and the first rotation is `review`.
    pub input_is_plan: bool,
    /// The plan's current path — the base copy until adoption, the worktree
    /// copy after it. `None` when no plan file exists there, which is
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
    /// mid-sentence, so nothing rotates until the turn ends.
    pub session_idle: bool,
    /// The stage's claude session has ended at least one turn. A seated
    /// session reads as idle from its spawn until its first frame, and a
    /// decision taken in that gap would judge documents the stage has not
    /// yet touched — the devise stage would stop on a plan it had not begun
    /// to write. `true` when no stage is recorded, so the opening rotation
    /// is decided by the requesting turn alone.
    pub stage_turn_ended: bool,
    /// The stage's most recent turn ended in an API error — a 403, a 529 —
    /// rather than a response. The stage did not run, so nothing its
    /// documents say is its answer; the arc stops and says why.
    pub stage_api_error: bool,
    /// The stage's most recent turn was cancelled by the user — they took the
    /// card back mid-stage.
    ///
    /// A devise or review stage stops on this: the turn *is* the product
    /// there, and a cancelled one leaves no document to be judged on, so
    /// rotating onward would judge a half-written plan and stopping on `lint`
    /// would blame the plan for the user's gesture. An **implement** stage is
    /// exempt: its progress lives in the Step Status Ledger rather than in the
    /// turn, a cancelled turn leaves that ledger exactly as it was, and a
    /// cancel there almost always means "let me redirect you" — which the user
    /// types into the same stage. Stopping would hand the card back and cost a
    /// rotation to say what the user was about to say anyway.
    ///
    /// A *machine* wedge recovery is not a taking and never sets this: tugcode
    /// marks its own cancels `is_recovery`, and the stage it recovered is
    /// still alive and still working.
    pub stage_turn_cancelled: bool,
    /// The claude session running on the bound card is the one the newest
    /// `arc-stage` line names.
    ///
    /// False means the stage the record remembers is not the stage that is
    /// running: a tugcast restart, or a stage that died without ever ending a
    /// turn. Either way the answer is to rotate that stage again — never an
    /// earlier one. `true` when the arc has rotated nothing yet, so
    /// the opening rotation is decided by the documents.
    pub stage_session_current: bool,
    /// The claude session running on the bound card carries a `stage_label`.
    ///
    /// Only a rotation writes one — `set_stage_provenance` is called from one
    /// place, on the `session_init` that follows a rotation's announcement — so
    /// this is the durable, unambiguous answer to "did the wheel seat
    /// this session?". It is keyed on the *outcome* rather than on any one
    /// door, because the deck reaches a fresh session through several: a
    /// `/new` reset, a rewind fork, a re-spawn onto a picked session.
    /// `true` when the arc has rotated nothing yet.
    pub stage_seated: bool,
    /// The stage session's context size in tokens, from the latest recorded
    /// `context_breakdown`. `None` when nothing has been recorded — a missing
    /// measurement is not a reason to guess.
    pub context_tokens: Option<u64>,
    /// The context size above which a continued stage is compacted at a step
    /// boundary, `[tugtool.dash].implement_compact_tokens`. The arc's one
    /// threshold: a stage a compaction cannot bring back under it rotates.
    pub compact_tokens: u64,
    /// The seated stage has more turns to run on this session — it is an
    /// implement stage whose run is not complete and whose next pending step
    /// is within the declared range. Devise and review end by rotating, so
    /// they never continue and are never compacted.
    ///
    /// The runner computes it; it is what keys the compaction arm, so a future
    /// multi-turn stage inherits the behaviour without a second arm.
    pub stage_continues: bool,
    /// A compaction was sent on this session and no idle reading since has
    /// fallen to or below `compact_tokens`. Runner memory: the documents cannot
    /// hold it, exactly as with [`StepLedgerFacts::step_just_done`]. It is
    /// what makes a rotation the *second* answer to an oversized context.
    pub compacted_since_below: bool,
    /// The turn that just ended was the `/compact` the arc sent. A compaction
    /// closes no step, so `step_just_done` is false at its end; this fact is
    /// what lets the predicate continue the stage anyway — and what tells an
    /// API error there apart from one on the work.
    pub compact_turn_just_ended: bool,
    /// The dash carries an `audited` declaration — the audit stage's whole
    /// product, and the one document fact that says it ran.
    ///
    /// Read from the dash-log's declarations rather than from anything the
    /// stage said: a stage announces nothing and is believed about nothing.
    pub audit_declared: bool,
}

/// The inclusive step range a continued implement stage walks, as the opening
/// prompt and the transcript's divider both spell it.
pub fn step_range(from: usize, through: usize) -> String {
    format!("{from}-{through}")
}

/// A rotation the runner should perform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rotation {
    pub stage: ArcStage,
    /// The inclusive step range a continued implement stage's opening prompt
    /// names. `None` for every other rotation.
    pub steps: Option<(usize, usize)>,
    /// A note the runner records before rotating.
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

/// Which prompt the runner should compose and send.
///
/// A kind rather than a sentence: the predicate reads and writes no model's
/// words, so the text lives in the runner beside every other thing that talks
/// to a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptKind {
    /// The literal `/compact`, which compacts the session in place.
    Compact,
    /// The continue ask — `dash-implement` again, over the inclusive step
    /// range the stage has left.
    Continue { steps: (usize, usize) },
}

/// The facts that produced a prompt, carried so the runner records exactly
/// what decided rather than re-reading it a hop later.
#[derive(Debug, Clone, PartialEq)]
pub enum PromptWhy {
    Compact { tokens: u64, compact_tokens: u64 },
    Continue,
}

/// What the arc should do next.
#[derive(Debug, Clone, PartialEq)]
pub enum ArcAction {
    Rotate(Rotation),
    /// Send a prompt to the stage's own seated session, between turns. The
    /// predicate names the kind; the runner composes the words.
    Prompt {
        kind: PromptKind,
        why: PromptWhy,
    },
    /// The run's declared final step is `done`.
    Done,
    /// The arc cannot continue, and says which stage it was in and why
    /// ([L31]).
    Stop {
        stage: ArcStage,
        reason: ArcStopReason,
    },
}

/// Decide the arc's next act, or `None` when it should sit still.
///
/// The arms are in the doctrine's order and the first match wins.
pub fn arc_action(record: &ArcRecord, facts: &ArcFacts) -> Option<ArcAction> {
    // A finished or stopped arc is not advanced by a tick. Resuming a stopped
    // arc is an explicit `/dash`, which rotates the stopped stage again and
    // clears the stop by doing so.
    if record.done || record.stopped.is_some() {
        return None;
    }

    let stage = record.current_stage();

    // A dead session outranks every document fact: whatever the documents say,
    // there is nothing left to advance.
    if !facts.session_live {
        return Some(ArcAction::Stop {
            stage: stage.unwrap_or(ArcStage::Devise),
            reason: ArcStopReason::SessionGone,
        });
    }

    // Nothing rotates mid-turn.
    if !facts.session_idle {
        return None;
    }

    // A resume names the stage to rotate again and outranks the document
    // facts: the documents still say what they said when the arc stopped, and
    // the user has asked for the stopped stage back. The verb runs
    // from inside the asking session's own turn, so the idle check above is
    // what places this rotation at that turn's end.
    if let Some(stage) = record.resume {
        return Some(ArcAction::Rotate(Rotation {
            stage,
            steps: (stage == ArcStage::Implement)
                .then(|| facts.ledger.first_pending.zip(facts.ledger.run_through))
                .flatten(),
            note: None,
        }));
    }

    // A recorded stage that is not the one running is one of two things, and
    // `stage_seated` is what tells them apart.
    //
    // **Seated** — the session carries a `stage_label`, so a rotation put it
    // there: the stage died, or tugcast restarted. Re-rotate that stage, never
    // an earlier one; the runner's in-flight guard is what keeps the
    // window between a dispatch and its `arc-stage` line from reading as this.
    //
    // **Not seated** — nothing the wheel did produced this session, so the
    // user reached a fresh one on the card: a `/new`, a reset, a rewind fork.
    // Rotating the stage back onto the card they just cleared is the taking
    // going unnoticed; the arc stops and says so.
    //
    // A relaunch never reaches the stop: the startup rebind seeds
    // `claude_session_id` from the ledger row, so `stage_session_current` is
    // true and this arm is not consulted at all.
    if let Some(stage) = stage {
        if !facts.stage_session_current && !facts.stage_seated {
            return Some(ArcAction::Stop {
                stage,
                reason: ArcStopReason::CardTaken,
            });
        }
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

    // Seated, current, idle — and never yet run. The stage has a turn coming
    // and its documents are whatever the previous stage left; nothing about
    // them is this stage's answer until it has ended a turn.
    if stage.is_some() && !facts.stage_turn_ended {
        return None;
    }
    // A turn that ended in an API error is a stage that did not run. Rotating
    // on would judge documents it never touched; waiting would wait forever.
    //
    // Which turn failed decides the reason, because the user's fix differs: a
    // failed `/compact` is retried, a failed step is waited out.
    if let Some(stage) = stage {
        if facts.stage_api_error {
            return Some(ArcAction::Stop {
                stage,
                reason: if facts.compact_turn_just_ended {
                    ArcStopReason::CompactFailed
                } else {
                    ArcStopReason::ApiError
                },
            });
        }
    }
    // The user cancelled the stage's turn — they took the card back. Devise
    // and review stop, because the turn was the product; implement sits,
    // because its progress is in the ledger and the cancel is nearly always a
    // redirect the user is about to type into the same stage.
    //
    // Below the API-error arm on purpose: a turn that ended in a 529 is a
    // machine failure with its own reason, not a taking. Below the never-run
    // guard for a simpler reason — a session that has ended no turn cannot
    // have cancelled one.
    if let Some(stage) = stage {
        if facts.stage_turn_cancelled && stage != ArcStage::Implement {
            return Some(ArcAction::Stop {
                stage,
                reason: ArcStopReason::CardTaken,
            });
        }
    }

    // A continued stage above the compaction threshold at a step boundary is
    // compacted before anything else is considered — a compaction is the
    // cheaper act and keeps the session, its context, and its label. The arm
    // sits above `match stage` and keys on `stage_continues` so a future
    // multi-turn stage inherits it; devise and review end by rotating and
    // never reach it.
    if facts.stage_continues && facts.ledger.step_just_done && !facts.compacted_since_below {
        if let Some(tokens) = facts.context_tokens {
            if tokens > facts.compact_tokens {
                return Some(ArcAction::Prompt {
                    kind: PromptKind::Compact,
                    why: PromptWhy::Compact {
                        tokens,
                        compact_tokens: facts.compact_tokens,
                    },
                });
            }
        }
    }

    match stage {
        None => Some(start_action(facts)),
        Some(ArcStage::Devise) => Some(devise_action(facts)),
        Some(ArcStage::Review) => Some(review_action(record, facts)),
        Some(ArcStage::Implement) => implement_action(facts),
        Some(ArcStage::Audit) => Some(audit_action(facts)),
    }
}

fn start_action(facts: &ArcFacts) -> ArcAction {
    if !facts.document_exists {
        return ArcAction::Stop {
            stage: ArcStage::Devise,
            reason: ArcStopReason::DocumentMissing,
        };
    }
    // A document that already lints as a plan takes the arc straight to review.
    // A brief does not parse as a plan and takes the full arc.
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
            reason: ArcStopReason::Lint,
        }
    }
}

fn review_action(record: &ArcRecord, facts: &ArcFacts) -> ArcAction {
    if facts.plan_path.is_none() {
        return ArcAction::Stop {
            stage: ArcStage::Review,
            reason: ArcStopReason::PlanMissing,
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
        // Two rounds and still no stamp: an unreviewed plan is not the
        // implement stage's to walk. Stop, say so, and let the user review
        // by hand or resume — a rotation onward would only reach
        // dash-implement's stale gate, which asks a question no arc can answer.
        ArcAction::Stop {
            stage: ArcStage::Review,
            reason: ArcStopReason::ReviewDidNotStamp,
        }
    }
}

fn implement_action(facts: &ArcFacts) -> Option<ArcAction> {
    if facts.ledger.run_complete {
        // The walk is over and the code is unread by anyone but its author.
        // An audit that had already run is what `Done` means now — a second
        // rotation here would re-audit work the mark says was audited.
        return Some(if facts.audit_declared {
            ArcAction::Done
        } else {
            ArcAction::Rotate(Rotation::plain(ArcStage::Audit))
        });
    }
    // The `/compact` the arc sent has just ended. It closed no step, so
    // `step_just_done` is false — but this boundary is the compaction's, and
    // the stage is owed its next turn either way. The only question left is
    // whether the compaction worked: a context still above the threshold gets
    // the fresh session it was trying to avoid.
    //
    // `compacted_since_below` is what says the compaction was really performed
    // — a cancel or an API error retires it — so a compaction that never
    // happened continues here and compacts again at the next boundary, rather
    // than costing a rotation for a turn nobody took.
    if facts.compact_turn_just_ended {
        let steps = facts.ledger.first_pending.zip(facts.ledger.run_through);
        if facts.compacted_since_below {
            if let (Some(tokens), Some((next, through))) = (facts.context_tokens, steps) {
                if tokens > facts.compact_tokens && next <= through {
                    return Some(ArcAction::Rotate(Rotation {
                        stage: ArcStage::Implement,
                        steps: Some((next, through)),
                        note: None,
                    }));
                }
            }
        }
        return continue_prompt(facts);
    }
    // Every other act here is a step-boundary act, and never mid-step.
    if !facts.ledger.step_just_done {
        return None;
    }
    let next = facts.ledger.first_pending?;
    let through = facts.ledger.run_through?;
    if next > through {
        return None;
    }
    // A context a compaction already failed to bring down: rotate, which is
    // the second and last answer. Above the threshold *without* a compaction
    // behind it the stage never reaches here — the compaction arm above
    // `match stage` returned first.
    if facts.compacted_since_below
        && facts
            .context_tokens
            .is_some_and(|tokens| tokens > facts.compact_tokens)
    {
        return Some(ArcAction::Rotate(Rotation {
            stage: ArcStage::Implement,
            steps: Some((next, through)),
            note: None,
        }));
    }
    // Otherwise the stage keeps its session and is told to walk on — including
    // when nothing has been measured, because a missing reading is no reason
    // to strand a stage that has steps left.
    Some(ArcAction::Prompt {
        kind: PromptKind::Continue {
            steps: (next, through),
        },
        why: PromptWhy::Continue,
    })
}

/// The audit stage's one question: did it mark the dash?
///
/// The mark is the stage's product, exactly as the stamp is the review's, and
/// the stage's own turn has ended by the time this is asked — so a dash still
/// unmarked is one whose audit is over and answered nothing. Waiting another
/// tick would wait forever.
///
/// There is no second round here, and the asymmetry with the review's cap is
/// deliberate: a review that did not stamp leaves a plan the implement stage
/// would walk anyway, so a retry buys something. An audit that did not mark
/// leaves committed code and a run that is finished — the honest end is to
/// stop and say the audit did not happen, because the alternative is a dash
/// that offers its join wearing a word nothing earned.
fn audit_action(facts: &ArcFacts) -> ArcAction {
    if facts.audit_declared {
        ArcAction::Done
    } else {
        ArcAction::Stop {
            stage: ArcStage::Audit,
            reason: ArcStopReason::AuditDidNotMark,
        }
    }
}

/// The continue prompt for whatever the ledger says is left, or `None` when
/// there is nothing left to name.
fn continue_prompt(facts: &ArcFacts) -> Option<ArcAction> {
    let next = facts.ledger.first_pending?;
    let through = facts.ledger.run_through?;
    if next > through {
        return None;
    }
    Some(ArcAction::Prompt {
        kind: PromptKind::Continue {
            steps: (next, through),
        },
        why: PromptWhy::Continue,
    })
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
            resume: None,
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
            stage_turn_ended: true,
            stage_api_error: false,
            stage_turn_cancelled: false,
            stage_seated: true,
            stage_session_current: true,
            context_tokens: None,
            compact_tokens: 300_000,
            stage_continues: false,
            compacted_since_below: false,
            compact_turn_just_ended: false,
            audit_declared: false,
        }
    }

    fn rotation(action: Option<ArcAction>) -> Rotation {
        match action {
            Some(ArcAction::Rotate(rotation)) => rotation,
            other => panic!("expected a rotation, got {other:?}"),
        }
    }

    fn prompt(action: Option<ArcAction>) -> (PromptKind, PromptWhy) {
        match action {
            Some(ArcAction::Prompt { kind, why }) => (kind, why),
            other => panic!("expected a prompt, got {other:?}"),
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
                reason: ArcStopReason::DocumentMissing,
            })
        );
    }

    #[test]
    fn a_devise_stage_that_produced_a_linting_plan_rotates_review() {
        let action = arc_action(&record(&[ArcStage::Devise]), &facts());
        assert_eq!(rotation(action).stage, ArcStage::Review);
    }

    #[test]
    fn a_seated_stage_that_has_ended_no_turn_is_not_judged() {
        // Idle from spawn to first frame; the plan it has not written is not
        // a lint failure, and the review it has not held is not stale.
        for stage in [ArcStage::Devise, ArcStage::Review, ArcStage::Implement] {
            let mut facts = facts();
            facts.stage_turn_ended = false;
            facts.plan_path = None;
            facts.lint_ok = false;
            assert_eq!(arc_action(&record(&[stage]), &facts), None, "{stage:?}");
        }
    }

    #[test]
    fn the_opening_rotation_needs_no_turn_from_a_stage() {
        let mut facts = facts();
        facts.stage_turn_ended = false;
        assert_eq!(
            rotation(arc_action(&record(&[]), &facts)).stage,
            ArcStage::Devise
        );
    }

    #[test]
    fn a_devise_stage_whose_plan_does_not_lint_stops_on_lint() {
        let mut facts = facts();
        facts.lint_ok = false;
        assert_eq!(
            arc_action(&record(&[ArcStage::Devise]), &facts),
            Some(ArcAction::Stop {
                stage: ArcStage::Devise,
                reason: ArcStopReason::Lint,
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
                reason: ArcStopReason::Lint,
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
    fn a_stale_plan_at_the_cap_stops_rather_than_implementing_unreviewed() {
        let mut facts = facts();
        facts.review = Some(ReviewState::Stale);
        let record = record(&[ArcStage::Devise, ArcStage::Review, ArcStage::Review]);
        assert_eq!(
            arc_action(&record, &facts),
            Some(ArcAction::Stop {
                stage: ArcStage::Review,
                reason: ArcStopReason::ReviewDidNotStamp,
            })
        );
    }

    /// One case per predicate-visible row of `tuglaws/dash-lifecycle.md`'s
    /// Interruptions table, so the doctrine and the machine cannot drift.
    ///
    /// The rows this cannot reach are the ones no predicate decides: a bind
    /// refusal happens at the door, an ending and a close are written by the
    /// gesture, and a model switch changes nothing the predicate reads. Each
    /// of those has its own test named in its row.
    #[test]
    fn every_user_side_row_of_the_interruptions_table_has_an_arm() {
        // Cancel during devise, and during review: the card is taken back.
        for stage in [ArcStage::Devise, ArcStage::Review] {
            let mut facts = facts();
            facts.stage_turn_cancelled = true;
            assert_eq!(
                arc_action(&record(&[stage]), &facts),
                Some(ArcAction::Stop {
                    stage,
                    reason: ArcStopReason::CardTaken,
                }),
                "cancel during {stage:?}",
            );
        }

        // Cancel during implement: the stage sits.
        let mut cancelled_implement = facts();
        cancelled_implement.stage_turn_cancelled = true;
        assert_eq!(
            arc_action(&record(&[ArcStage::Implement]), &cancelled_implement),
            None,
            "cancel during implement",
        );

        // A `/compact` the arc sent, ending in an API error: the arc stops
        // rather than walking on with a context the compaction never reduced.
        let mut failed_compaction = facts();
        failed_compaction.stage_api_error = true;
        failed_compaction.compact_turn_just_ended = true;
        assert_eq!(
            arc_action(&record(&[ArcStage::Implement]), &failed_compaction),
            Some(ArcAction::Stop {
                stage: ArcStage::Implement,
                reason: ArcStopReason::CompactFailed,
            }),
            "a failed compaction",
        );

        // A machine wedge recovery: the fact is never set, so nothing decides.
        let recovery = facts();
        assert!(
            !recovery.stage_turn_cancelled,
            "a recovery leaves the cancel fact false",
        );
        assert_ne!(
            arc_action(&record(&[ArcStage::Review]), &recovery),
            Some(ArcAction::Stop {
                stage: ArcStage::Review,
                reason: ArcStopReason::CardTaken,
            }),
            "a wedge recovery is not a taking",
        );

        // A fresh session nothing seated: the card was taken back.
        let mut fresh = facts();
        fresh.stage_session_current = false;
        fresh.stage_seated = false;
        assert_eq!(
            arc_action(&record(&[ArcStage::Review]), &fresh),
            Some(ArcAction::Stop {
                stage: ArcStage::Review,
                reason: ArcStopReason::CardTaken,
            }),
            "a fresh session on the card",
        );

        // A tugcast relaunch: the rebind seeds the recorded id, so the stage
        // reads as current and the arc waits rather than stopping.
        let relaunch = facts();
        assert!(relaunch.stage_session_current);
        assert!(
            !matches!(
                arc_action(&record(&[ArcStage::Review]), &relaunch),
                Some(ArcAction::Stop { .. })
            ),
            "a relaunch is a wait, not a stop",
        );

        // A resume picks the stopped stage back up, at the asking turn's end.
        let mut stopped = record(&[ArcStage::Review]);
        stopped.stopped = Some((ArcStage::Review, "card closed".to_string()));
        assert_eq!(
            arc_action(&stopped, &facts()),
            None,
            "a stopped arc is not advanced by a tick",
        );
        let mut resuming = record(&[ArcStage::Review]);
        resuming.resume = Some(ArcStage::Review);
        assert_eq!(
            rotation(arc_action(&resuming, &facts())).stage,
            ArcStage::Review,
            "and a resume rotates the stage it stopped in",
        );
        let mut mid_turn = facts();
        mid_turn.session_idle = false;
        assert_eq!(
            arc_action(&resuming, &mid_turn),
            None,
            "which lands at the end of the turn that asked for it",
        );

        // A side question changes no document, so nothing decides. The stage
        // has ended no turn since, which is the shape of "still working".
        let mut mid_stage = facts();
        mid_stage.stage_turn_ended = false;
        assert_eq!(
            arc_action(&record(&[ArcStage::Review]), &mid_stage),
            None,
            "a side question inside a stage",
        );
    }

    #[test]
    fn a_session_no_rotation_seated_is_a_card_taken_back() {
        // A `/new`, a reset, a rewind fork: whatever the door, the session on
        // the card carries no stage label, so the wheel did not put it
        // there and the arc must not rotate its stage back onto it.
        for stage in [ArcStage::Devise, ArcStage::Review, ArcStage::Implement] {
            let mut facts = facts();
            facts.stage_session_current = false;
            facts.stage_seated = false;
            assert_eq!(
                arc_action(&record(&[stage]), &facts),
                Some(ArcAction::Stop {
                    stage,
                    reason: ArcStopReason::CardTaken,
                }),
                "{stage:?}"
            );
        }
    }

    #[test]
    fn a_seated_stage_the_record_does_not_name_is_rotated_again() {
        // The restart case, unchanged: a rotation seated this session, so the
        // stage died rather than being taken, and it rotates again.
        let mut facts = facts();
        facts.stage_session_current = false;
        facts.stage_seated = true;
        facts.ledger.first_pending = Some(3);
        facts.ledger.run_through = Some(7);

        let review = rotation(arc_action(&record(&[ArcStage::Review]), &facts));
        assert_eq!(review.stage, ArcStage::Review);
        assert_eq!(review.steps, None);

        let implement = rotation(arc_action(&record(&[ArcStage::Implement]), &facts));
        assert_eq!(implement.stage, ArcStage::Implement);
        assert_eq!(implement.steps, Some((3, 7)));
    }

    #[test]
    fn a_cancelled_devise_or_review_turn_stops_the_arc_as_card_taken() {
        for stage in [ArcStage::Devise, ArcStage::Review] {
            let mut facts = facts();
            facts.stage_turn_cancelled = true;
            // A cancelled devise turn leaves a half-written plan that does not
            // lint. The stop must name the taking, never blame the plan.
            facts.lint_ok = false;
            assert_eq!(
                arc_action(&record(&[stage]), &facts),
                Some(ArcAction::Stop {
                    stage,
                    reason: ArcStopReason::CardTaken,
                }),
                "{stage:?}"
            );
        }
    }

    #[test]
    fn a_cancelled_implement_turn_sits() {
        // The ledger is where an implement stage's progress lives, and a
        // cancelled turn left it exactly as it was.
        let mut facts = facts();
        facts.stage_turn_cancelled = true;
        facts.ledger.step_just_done = false;
        assert_eq!(arc_action(&record(&[ArcStage::Implement]), &facts), None);
    }

    #[test]
    fn an_api_error_outranks_a_cancel() {
        let mut facts = facts();
        facts.stage_api_error = true;
        facts.stage_turn_cancelled = true;
        assert_eq!(
            arc_action(&record(&[ArcStage::Review]), &facts),
            Some(ArcAction::Stop {
                stage: ArcStage::Review,
                reason: ArcStopReason::ApiError,
            })
        );
    }

    #[test]
    fn a_cancel_before_the_stage_has_ended_a_turn_decides_nothing() {
        let mut facts = facts();
        facts.stage_turn_ended = false;
        facts.stage_turn_cancelled = true;
        assert_eq!(arc_action(&record(&[ArcStage::Devise]), &facts), None);
    }

    #[test]
    fn a_stage_whose_turn_ended_in_an_api_error_stops_in_that_stage() {
        for stage in [ArcStage::Devise, ArcStage::Review, ArcStage::Implement] {
            let mut facts = facts();
            facts.stage_api_error = true;
            assert_eq!(
                arc_action(&record(&[stage]), &facts),
                Some(ArcAction::Stop {
                    stage,
                    reason: ArcStopReason::ApiError,
                }),
                "{stage:?}"
            );
        }
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
                reason: ArcStopReason::PlanMissing,
            })
        );
    }

    #[test]
    fn a_finished_run_rotates_to_the_audit() {
        let mut facts = facts();
        facts.ledger.run_complete = true;
        assert_eq!(
            arc_action(&record(&[ArcStage::Implement]), &facts),
            Some(ArcAction::Rotate(Rotation::plain(ArcStage::Audit)))
        );
    }

    /// The mark is what makes a finished run finished, and it is read from the
    /// dash's own declarations rather than from anything a stage said.
    #[test]
    fn a_finished_run_that_was_already_audited_is_done() {
        let mut facts = facts();
        facts.ledger.run_complete = true;
        facts.audit_declared = true;
        assert_eq!(
            arc_action(&record(&[ArcStage::Implement]), &facts),
            Some(ArcAction::Done)
        );
    }

    #[test]
    fn an_audit_that_marked_the_dash_ends_the_arc() {
        let mut facts = facts();
        facts.ledger.run_complete = true;
        facts.audit_declared = true;
        assert_eq!(
            arc_action(&record(&[ArcStage::Audit]), &facts),
            Some(ArcAction::Done)
        );
    }

    /// One round and no more: the code is committed and the run is over, so a
    /// second audit would re-read the same bytes to reach the same silence.
    #[test]
    fn an_audit_that_did_not_mark_stops_and_says_so() {
        let mut facts = facts();
        facts.ledger.run_complete = true;
        assert_eq!(
            arc_action(&record(&[ArcStage::Audit]), &facts),
            Some(ArcAction::Stop {
                stage: ArcStage::Audit,
                reason: ArcStopReason::AuditDidNotMark,
            })
        );
    }

    /// A seated implement stage with steps 4 through 9 left to walk.
    /// `compact_tokens` is 300,000, the declared default.
    fn implementing(tokens: Option<u64>, step_just_done: bool) -> ArcFacts {
        let mut facts = facts();
        facts.ledger.step_just_done = step_just_done;
        facts.ledger.first_pending = Some(4);
        facts.ledger.run_through = Some(9);
        facts.context_tokens = tokens;
        facts.stage_continues = true;
        facts
    }

    #[test]
    fn above_the_threshold_at_a_step_boundary_prompts_a_compaction() {
        let (kind, why) = prompt(arc_action(
            &record(&[ArcStage::Implement]),
            &implementing(Some(350_000), true),
        ));
        assert_eq!(kind, PromptKind::Compact);
        assert_eq!(
            why,
            PromptWhy::Compact {
                tokens: 350_000,
                compact_tokens: 300_000,
            }
        );
    }

    #[test]
    fn below_the_threshold_at_a_step_boundary_prompts_the_next_step() {
        let (kind, why) = prompt(arc_action(
            &record(&[ArcStage::Implement]),
            &implementing(Some(120_000), true),
        ));
        assert_eq!(kind, PromptKind::Continue { steps: (4, 9) });
        assert_eq!(why, PromptWhy::Continue);
    }

    /// A missing measurement is not a reason to strand a stage that has steps
    /// left: it walks on, and the next boundary reads again.
    #[test]
    fn no_reading_at_a_step_boundary_still_continues() {
        let (kind, _) = prompt(arc_action(
            &record(&[ArcStage::Implement]),
            &implementing(None, true),
        ));
        assert_eq!(kind, PromptKind::Continue { steps: (4, 9) });
    }

    #[test]
    fn still_above_the_threshold_after_a_compaction_rotates_with_the_step_range() {
        let mut facts = implementing(Some(500_000), true);
        facts.compacted_since_below = true;
        let rotation = rotation(arc_action(&record(&[ArcStage::Implement]), &facts));
        assert_eq!(rotation.stage, ArcStage::Implement);
        assert_eq!(rotation.steps, Some((4, 9)));
    }

    /// Rotation is the second answer, never the first: a context nothing has
    /// tried to compact is compacted.
    #[test]
    fn above_the_threshold_without_a_compaction_compacts_first() {
        let (kind, _) = prompt(arc_action(
            &record(&[ArcStage::Implement]),
            &implementing(Some(500_000), true),
        ));
        assert_eq!(kind, PromptKind::Compact);
    }

    #[test]
    fn a_compact_turns_end_continues_when_the_context_came_down() {
        let mut facts = implementing(Some(120_000), false);
        facts.compact_turn_just_ended = true;
        facts.compacted_since_below = true;
        let (kind, _) = prompt(arc_action(&record(&[ArcStage::Implement]), &facts));
        assert_eq!(kind, PromptKind::Continue { steps: (4, 9) });
    }

    #[test]
    fn a_compact_turns_end_rotates_when_the_context_did_not_come_down() {
        let mut facts = implementing(Some(500_000), false);
        facts.compact_turn_just_ended = true;
        facts.compacted_since_below = true;
        let rotation = rotation(arc_action(&record(&[ArcStage::Implement]), &facts));
        assert_eq!(rotation.stage, ArcStage::Implement);
        assert_eq!(rotation.steps, Some((4, 9)));
    }

    /// A compact turn nobody took — the runner retires `compacted_since_below`
    /// on a cancel or an API error — costs no rotation, however high the
    /// context reads. The stage walks on and the next boundary compacts again.
    #[test]
    fn a_compact_turn_nobody_took_continues_rather_than_rotating() {
        let mut facts = implementing(Some(500_000), false);
        facts.compact_turn_just_ended = true;
        let (kind, _) = prompt(arc_action(&record(&[ArcStage::Implement]), &facts));
        assert_eq!(kind, PromptKind::Continue { steps: (4, 9) });
    }

    #[test]
    fn a_compact_turn_that_ended_in_an_api_error_stops_as_compact_failed() {
        let mut facts = implementing(Some(500_000), false);
        facts.stage_api_error = true;
        facts.compact_turn_just_ended = true;
        assert_eq!(
            arc_action(&record(&[ArcStage::Implement]), &facts),
            Some(ArcAction::Stop {
                stage: ArcStage::Implement,
                reason: ArcStopReason::CompactFailed,
            })
        );

        // The work's own failed turn is unchanged.
        facts.compact_turn_just_ended = false;
        assert_eq!(
            arc_action(&record(&[ArcStage::Implement]), &facts),
            Some(ArcAction::Stop {
                stage: ArcStage::Implement,
                reason: ArcStopReason::ApiError,
            })
        );
    }

    /// Every act on the seated session happens on an idle reading ([P05]) —
    /// a prompt sent into an open turn would queue behind a working model.
    #[test]
    fn a_mid_turn_reading_prompts_nothing_even_above_the_threshold() {
        let mut facts = implementing(Some(600_000), true);
        facts.session_idle = false;
        assert_eq!(arc_action(&record(&[ArcStage::Implement]), &facts), None);
    }

    /// Devise and review end by rotating, so they never continue — and the
    /// compaction arm, keyed on `stage_continues`, never fires for them.
    #[test]
    fn devise_and_review_never_compact() {
        // Each ends by rotating onward, whatever the context reads.
        for (stage, onward) in [
            (ArcStage::Devise, ArcStage::Review),
            (ArcStage::Review, ArcStage::Implement),
        ] {
            let mut facts = implementing(Some(600_000), true);
            facts.stage_continues = false;
            let action = arc_action(&record(&[stage]), &facts);
            assert!(
                !matches!(action, Some(ArcAction::Prompt { .. })),
                "{stage:?} decided {action:?}",
            );
            assert_eq!(rotation(action).stage, onward);
        }
    }

    /// The wedge a withdrawn row would open if `first_pending` returned one:
    /// the fresh session resumes past it, at a step it can actually close.
    #[test]
    fn a_rotation_resumes_past_a_withdrawn_row() {
        let mut facts = implementing(Some(350_000), true);
        facts.compacted_since_below = true;
        // Row 2 is withdrawn, so the ledger's answer to "where next" is 3.
        facts.ledger.first_pending = Some(3);
        facts.ledger.run_through = Some(3);
        facts.context_tokens = Some(500_000);

        let rotation = rotation(arc_action(&record(&[ArcStage::Implement]), &facts));
        assert_eq!(rotation.stage, ArcStage::Implement);
        assert_eq!(rotation.steps, Some((3, 3)));
    }

    #[test]
    fn above_the_threshold_mid_step_does_nothing() {
        assert_eq!(
            arc_action(
                &record(&[ArcStage::Implement]),
                &implementing(Some(600_000), false)
            ),
            None
        );
    }

    #[test]
    fn a_step_range_is_spelled_the_same_everywhere_it_appears() {
        assert_eq!(step_range(4, 9), "4-9");
    }

    #[test]
    fn a_dead_session_stops_the_arc_whatever_the_documents_say() {
        let mut facts = facts();
        facts.session_live = false;
        assert_eq!(
            arc_action(&record(&[ArcStage::Review]), &facts),
            Some(ArcAction::Stop {
                stage: ArcStage::Review,
                reason: ArcStopReason::SessionGone,
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
    fn a_resumed_arc_rotates_the_stage_it_stopped_in() {
        // A refused rotation out of devise stops *in review* — the stage it
        // was trying to reach — so that is the stage a resume asks for, not
        // the last one recorded.
        let mut record = record(&[ArcStage::Devise]);
        record.resume = Some(ArcStage::Review);
        let mut facts = facts();
        facts.lint_ok = false;
        assert_eq!(
            rotation(arc_action(&record, &facts)).stage,
            ArcStage::Review,
            "the resume outranks what the documents would have decided"
        );
    }

    #[test]
    fn a_resumed_implement_stage_carries_its_step_range() {
        let mut record = record(&[ArcStage::Implement]);
        record.resume = Some(ArcStage::Implement);
        let rotation = rotation(arc_action(&record, &implementing(None, false)));
        assert_eq!(rotation.stage, ArcStage::Implement);
        assert_eq!(rotation.steps, Some((4, 9)));
    }

    #[test]
    fn a_resume_waits_for_the_asking_turn_to_end() {
        let mut record = record(&[ArcStage::Devise]);
        record.resume = Some(ArcStage::Devise);
        let mut facts = facts();
        facts.session_idle = false;
        assert_eq!(arc_action(&record, &facts), None);
    }

    #[test]
    fn a_done_arc_is_not_advanced_by_a_tick() {
        let mut record = record(&[ArcStage::Implement]);
        record.done = true;
        assert_eq!(arc_action(&record, &facts()), None);
    }
}
