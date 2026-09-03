//! The arc's voice in the step verbs — the turn boundary, said at the
//! moment it is decided.
//!
//! The Wheel acts **only between turns**. Pacing, `/compact`, rotation, and
//! the `ImplementIdle` clock all hang off the edge where a turn ends, so a
//! stage that closes a step and keeps working locks the arc out of every
//! one of them. Both the skill and the wheel's opening prompt command the
//! boundary in prose, and on the wheel machinery's first live run
//! (`lens-retirement`, 2026-09-01) a stage rolled through both: `step done 1`
//! and then straight into step 2 in the same turn.
//!
//! Prose is the weakest place to keep the most load-bearing discipline in the
//! arc. This module is the first of the two structural answers: **the verb
//! says it**. Tool output is the freshest instruction a model reads before
//! choosing its next act, and that slot was silent. The second answer is the
//! PreToolUse gate (`commands/hook.rs`), which refuses the overrun outright.
//!
//! Off an arc the lines stay plain — a person at a terminal moving their own
//! ledger does not need marching orders.

use std::path::Path;

/// Whether a gesture on `arc` is being made inside a live arc.
///
/// Two facts, either of which is enough, because they fail in opposite
/// directions. `TUG_ARC` is what the wheel stamps on a stage's spawn
/// (`tugcode/src/session.ts`) and is the cheapest, but it is frozen at spawn
/// like every other spawn-time variable — a shell that outlived an arc still
/// carries it. The **arc record** is what the wheel itself reads
/// (`wheel::arc_is_running`) and is the truth, but it costs a repo walk and
/// a file read. So: the record decides when it can be read, and the variable is
/// the fallback for a checkout whose arc file this process cannot reach.
pub(crate) fn under_an_arc(arc: &str) -> bool {
    if let Ok(repo) = tugtool_core::find_repo_root()
        && tugarc_core::arc::read_arc(&repo, arc).is_some()
    {
        return arc_is_live_in(&repo, arc);
    }
    named_arc().is_some_and(|named| named == arc)
}

/// Whether `arc` has an arc running in `repo` — the same reading
/// `wheel::arc_is_running` makes on the server side, against the same
/// record, so the two cannot disagree about what a live arc is.
pub(crate) fn arc_is_live_in(repo: &Path, arc: &str) -> bool {
    match tugarc_core::arc::read_arc(repo, arc) {
        Some(record) => !record.done && record.stopped.is_none(),
        None => false,
    }
}

/// The arc this process was spawned into, if any.
fn named_arc() -> Option<String> {
    match std::env::var("TUG_ARC") {
        Ok(value) if !value.is_empty() => Some(value),
        _ => None,
    }
}

/// Which way a step just moved — the only thing the directive turns on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StepMove {
    /// `step start` — the row is open and this turn belongs to it.
    Opened,
    /// `step reopen` — a finished row is open again, on the same terms.
    Reopened,
    /// `step done` — closed, and the run moved.
    Done,
    /// `step withdraw` — closed without being walked; the run moved anyway.
    Withdrawn,
    /// `step reset` — parked back to `pending`; the run did **not** move.
    Reset,
}

impl StepMove {
    /// Whether this move closed the step in the ledger's sense — what the
    /// turn-boundary gate refuses further writes after.
    pub(crate) fn closed_a_step(self) -> bool {
        matches!(self, StepMove::Done | StepMove::Withdrawn)
    }
}

/// The sentence a step verb ends with under an arc: what just happened, and
/// what the discipline demands next.
///
/// `through` is the run's declared final step (`--through <m>`). Absent, the
/// remaining selection cannot be named and the line says only that the arc
/// takes it from here — which is true and is the part that matters.
pub(crate) fn step_directive(step: u32, mv: StepMove, through: Option<u32>) -> String {
    match mv {
        StepMove::Opened => {
            format!("Step {step} open. This turn closes step {step} and nothing else.")
        }
        StepMove::Reopened => {
            format!("Step {step} reopened. This turn closes step {step} and nothing else.")
        }
        StepMove::Reset => format!(
            "Step {step} parked back to pending. End your turn now — the arc prompts the \
             run's open steps."
        ),
        StepMove::Done | StepMove::Withdrawn => {
            let what = if mv == StepMove::Withdrawn {
                format!("Step {step} withdrawn and closed.")
            } else {
                format!("Step {step} closed.")
            };
            format!("{what} End your turn now — {}", arc_prompts(step, through))
        }
    }
}

/// The half-sentence naming what the arc does next, after a close.
fn arc_prompts(step: u32, through: Option<u32>) -> String {
    match through {
        Some(last) if last > step + 1 => {
            format!("the arc prompts Steps {}–{last}.", step + 1)
        }
        Some(last) if last == step + 1 => format!("the arc prompts Step {last}."),
        // The run's last step, or a generation that never declared one: there
        // is no next step to name, and the arc still owns what follows.
        _ => "the arc takes the run from here.".to_string(),
    }
}

// ---------------------------------------------------------------------------
// The boundary fact
// ---------------------------------------------------------------------------

/// Tell the server this turn has closed a step.
///
/// The one fact the PreToolUse gate cannot compute for itself: the hook is a
/// fresh process with no notion of a turn, and turn boundaries are `tugcast`'s
/// (`LedgerEntry::turn_active`). So the verb reports at the moment of the
/// close, the server holds it until the turn ends, and the gate asks. Advisory
/// on exactly the terms [`announce`] is: a report that does not land leaves the
/// gate where it was before W8, which is open.
pub(crate) fn report_step_closed(step: u32) {
    let _ = crate::session_identity::ask_about_calling_session(
        "step_closed",
        "recording a step close against this turn",
        serde_json::json!({ "step": step }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_opened_step_owns_the_whole_turn() {
        assert_eq!(
            step_directive(1, StepMove::Opened, Some(5)),
            "Step 1 open. This turn closes step 1 and nothing else."
        );
        assert_eq!(
            step_directive(3, StepMove::Reopened, Some(5)),
            "Step 3 reopened. This turn closes step 3 and nothing else."
        );
    }

    #[test]
    fn a_close_names_the_steps_the_arc_will_prompt() {
        assert_eq!(
            step_directive(1, StepMove::Done, Some(5)),
            "Step 1 closed. End your turn now — the arc prompts Steps 2–5."
        );
        // One step left is named singly: "Steps 5–5" is a machine's sentence.
        assert_eq!(
            step_directive(4, StepMove::Done, Some(5)),
            "Step 4 closed. End your turn now — the arc prompts Step 5."
        );
    }

    #[test]
    fn the_runs_last_step_names_no_next_one() {
        assert_eq!(
            step_directive(5, StepMove::Done, Some(5)),
            "Step 5 closed. End your turn now — the arc takes the run from here."
        );
        assert_eq!(
            step_directive(2, StepMove::Done, None),
            "Step 2 closed. End your turn now — the arc takes the run from here."
        );
    }

    #[test]
    fn a_withdrawal_says_it_withdrew_and_still_demands_the_boundary() {
        assert_eq!(
            step_directive(2, StepMove::Withdrawn, Some(4)),
            "Step 2 withdrawn and closed. End your turn now — the arc prompts Steps 3–4."
        );
    }

    #[test]
    fn a_park_ends_the_turn_without_claiming_the_run_moved() {
        let line = step_directive(2, StepMove::Reset, Some(4));
        assert!(line.contains("parked back to pending"), "{line}");
        assert!(line.contains("End your turn now"), "{line}");
        assert!(
            !line.contains("Steps 3"),
            "a park moves no frontier: {line}"
        );
    }

    #[test]
    fn only_a_done_or_a_withdraw_closes_a_step() {
        assert!(StepMove::Done.closed_a_step());
        assert!(StepMove::Withdrawn.closed_a_step());
        assert!(!StepMove::Reset.closed_a_step());
        assert!(!StepMove::Opened.closed_a_step());
        assert!(!StepMove::Reopened.closed_a_step());
    }

    #[test]
    fn a_arc_with_no_arc_record_is_not_under_an_arc() {
        let dir = tempfile::tempdir().expect("temp");
        assert!(!arc_is_live_in(dir.path(), "nothing-here"));
    }
}
