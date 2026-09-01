//! The course's voice in the step verbs — the turn boundary, said at the
//! moment it is decided.
//!
//! The Wheel acts **only between turns**. Pacing, `/compact`, rotation, and
//! the `ImplementIdle` clock all hang off the edge where a turn ends, so a
//! stage that closes a step and keeps working locks the course out of every
//! one of them. Both the skill and the wheel's opening prompt command the
//! boundary in prose, and on the course machinery's first live run
//! (`lens-retirement`, 2026-09-01) a stage rolled through both: `step done 1`
//! and then straight into step 2 in the same turn.
//!
//! Prose is the weakest place to keep the most load-bearing discipline in the
//! course. This module is the first of the two structural answers: **the verb
//! says it**. Tool output is the freshest instruction a model reads before
//! choosing its next act, and that slot was silent. The second answer is the
//! PreToolUse gate (`commands/hook.rs`), which refuses the overrun outright.
//!
//! Off a course the lines stay plain — a person at a terminal moving their own
//! ledger does not need marching orders.

use std::path::Path;

/// Whether a gesture on `dash` is being made inside a live course.
///
/// Two facts, either of which is enough, because they fail in opposite
/// directions. `TUG_DASH_COURSE` is what the wheel stamps on a stage's spawn
/// (`tugcode/src/session.ts`) and is the cheapest, but it is frozen at spawn
/// like every other spawn-time variable — a shell that outlived a course still
/// carries it. The **course record** is what the wheel itself reads
/// (`wheel::course_is_running`) and is the truth, but it costs a repo walk and
/// a file read. So: the record decides when it can be read, and the variable is
/// the fallback for a checkout whose arc file this process cannot reach.
pub(crate) fn under_a_course(dash: &str) -> bool {
    if let Ok(repo) = tugtool_core::find_repo_root()
        && tugdash_core::arc::read_arc(&repo, dash).is_some()
    {
        return course_is_live_in(&repo, dash);
    }
    named_course().is_some_and(|course| course == dash)
}

/// Whether `dash` has a course running in `repo` — the same reading
/// `wheel::course_is_running` makes on the server side, against the same
/// record, so the two cannot disagree about what a course is.
pub(crate) fn course_is_live_in(repo: &Path, dash: &str) -> bool {
    match tugdash_core::arc::read_arc(repo, dash) {
        Some(record) => !record.done && record.stopped.is_none(),
        None => false,
    }
}

/// The course this process was spawned into, if any.
///
/// `TUG_DASH_ARC` is the old spelling, still exported beside the new one for
/// one release (`tuglaws/wheel.md`), so a bundle-old reader and a bundle-new
/// one agree.
fn named_course() -> Option<String> {
    for key in ["TUG_DASH_COURSE", "TUG_DASH_ARC"] {
        if let Ok(value) = std::env::var(key)
            && !value.is_empty()
        {
            return Some(value);
        }
    }
    None
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

    /// The sub-verb that makes this move, for an announcement that echoes the
    /// gesture as it was typed.
    pub(crate) fn spelling(self) -> &'static str {
        match self {
            StepMove::Opened => "start",
            StepMove::Reopened => "reopen",
            StepMove::Done => "done",
            StepMove::Withdrawn => "withdraw",
            StepMove::Reset => "reset",
        }
    }
}

/// The sentence a step verb ends with under a course: what just happened, and
/// what the discipline demands next.
///
/// `through` is the run's declared final step (`--through <m>`). Absent, the
/// remaining selection cannot be named and the line says only that the course
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
            "Step {step} parked back to pending. End your turn now — the course prompts the \
             run's open steps."
        ),
        StepMove::Done | StepMove::Withdrawn => {
            let what = if mv == StepMove::Withdrawn {
                format!("Step {step} withdrawn and closed.")
            } else {
                format!("Step {step} closed.")
            };
            format!("{what} End your turn now — {}", course_prompts(step, through))
        }
    }
}

/// The half-sentence naming what the course does next, after a close.
fn course_prompts(step: u32, through: Option<u32>) -> String {
    match through {
        Some(last) if last > step + 1 => {
            format!("the course prompts Steps {}–{last}.", step + 1)
        }
        Some(last) if last == step + 1 => format!("the course prompts Step {last}."),
        // The run's last step, or a generation that never declared one: there
        // is no next step to name, and the course still owns what follows.
        _ => "the course takes the run from here.".to_string(),
    }
}

/// The one-line announcement a gesture makes on the card, in the fixed shape
/// every ledger gesture uses: the verb as it was typed, and one sentence.
///
/// Kept beside the directive because the two are the same fact told to two
/// readers — the directive instructs the model, the announcement shows the
/// person watching the card that the run moved.
pub(crate) fn step_announcement(
    dash: &str,
    step: u32,
    total: u32,
    mv: StepMove,
    commit: Option<&str>,
) -> String {
    let verb = match mv {
        StepMove::Opened => "started",
        StepMove::Reopened => "reopened",
        StepMove::Done => "closed",
        StepMove::Withdrawn => "withdrawn",
        StepMove::Reset => "reset to pending",
    };
    let mut line = format!("{dash}: step {step}/{total} {verb}");
    if let Some(commit) = commit {
        line.push_str(&format!(" ({commit})"));
    }
    line
}

// ---------------------------------------------------------------------------
// The card's quiet lines, and the boundary fact
// ---------------------------------------------------------------------------

/// Announce one ledger gesture on the calling session's card, as durable ink.
///
/// **Why the verb and not the stage.** A run's progression was invisible from
/// the card — the only sign was a stuck indicator — because every announcement
/// was a thing a stage was asked to write in prose, and a forgotten
/// announcement is this incident's whole shape. So the gesture announces
/// itself: `tugcast` records a `$`-route shell-exchange row keyed to the
/// caller's *line* (so a rotation carries it) and broadcasts it, exactly the
/// way a `/commit` landing's receipt reaches the card ([P07]/[D111]).
///
/// **Advisory, always.** Nothing here can fail the verb. No instance, an
/// instance too old to know the op, no calling session at all — a plain
/// terminal, a fixture, a foreign project — and the line is simply not drawn.
/// The ledger move already happened; a receipt that cannot be painted must not
/// unmake it.
pub(crate) fn announce(command: &str, line: &str) {
    let Some(resolved) = crate::session_identity::resolve_soft(None) else {
        return;
    };
    if !resolved.resolved {
        return;
    }
    let project_dir = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let _ = crate::dash::post_instance_api(
        "/api/session",
        "announcing a dash gesture",
        serde_json::json!({
            "op": "note",
            "tug_session_id": resolved.session_id,
            "command": command,
            "note": line,
            "project_dir": project_dir,
        }),
    );
}

/// Tell the server this turn has closed a step.
///
/// The one fact the PreToolUse gate cannot compute for itself: the hook is a
/// fresh process with no notion of a turn, and turn boundaries are `tugcast`'s
/// (`LedgerEntry::turn_active`). So the verb reports at the moment of the
/// close, the server holds it until the turn ends, and the gate asks. Advisory
/// on exactly the terms [`announce`] is: a report that does not land leaves the
/// gate where it was before W8, which is open.
pub(crate) fn report_step_closed(step: u32) {
    let Some(resolved) = crate::session_identity::resolve_soft(None) else {
        return;
    };
    if !resolved.resolved {
        return;
    }
    let _ = crate::dash::post_instance_api(
        "/api/session",
        "recording a step close against this turn",
        serde_json::json!({
            "op": "step_closed",
            "tug_session_id": resolved.session_id,
            "step": step,
        }),
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
    fn a_close_names_the_steps_the_course_will_prompt() {
        assert_eq!(
            step_directive(1, StepMove::Done, Some(5)),
            "Step 1 closed. End your turn now — the course prompts Steps 2–5."
        );
        // One step left is named singly: "Steps 5–5" is a machine's sentence.
        assert_eq!(
            step_directive(4, StepMove::Done, Some(5)),
            "Step 4 closed. End your turn now — the course prompts Step 5."
        );
    }

    #[test]
    fn the_runs_last_step_names_no_next_one() {
        assert_eq!(
            step_directive(5, StepMove::Done, Some(5)),
            "Step 5 closed. End your turn now — the course takes the run from here."
        );
        assert_eq!(
            step_directive(2, StepMove::Done, None),
            "Step 2 closed. End your turn now — the course takes the run from here."
        );
    }

    #[test]
    fn a_withdrawal_says_it_withdrew_and_still_demands_the_boundary() {
        assert_eq!(
            step_directive(2, StepMove::Withdrawn, Some(4)),
            "Step 2 withdrawn and closed. End your turn now — the course prompts Steps 3–4."
        );
    }

    #[test]
    fn a_park_ends_the_turn_without_claiming_the_run_moved() {
        let line = step_directive(2, StepMove::Reset, Some(4));
        assert!(line.contains("parked back to pending"), "{line}");
        assert!(line.contains("End your turn now"), "{line}");
        assert!(!line.contains("Steps 3"), "a park moves no frontier: {line}");
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
    fn the_announcement_names_the_dash_the_step_and_the_commit() {
        assert_eq!(
            step_announcement("lens-retirement", 1, 7, StepMove::Done, Some("999353ca1")),
            "lens-retirement: step 1/7 closed (999353ca1)"
        );
        assert_eq!(
            step_announcement("d", 2, 7, StepMove::Opened, None),
            "d: step 2/7 started"
        );
    }

    #[test]
    fn a_dash_with_no_arc_record_is_not_under_a_course() {
        let dir = tempfile::tempdir().expect("temp");
        assert!(!course_is_live_in(dir.path(), "nothing-here"));
    }
}
