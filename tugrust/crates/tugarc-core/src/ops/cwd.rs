//! The cwd-reading doors: each verb's repo root resolved from the process's
//! working directory, then handed to the `*_in` form that does the work.
//!
//! Only the `tugtool` CLI calls these; tugcast and every other server-side
//! caller holds its project path as a fact and calls the `*_in` forms. They
//! live together so that what reads the cwd is visible in one place.

use tugtool_core::find_repo_root;

use super::{
    ArcListItem, ArcStatus, CommitOutcome, CreateOutcome, DeleteDocumentsOutcome, DiscardOutcome,
    JoinOptions, JoinOutcome, MarkOutcome, ShowOutcome, StepOutcome, commit_in, create_in,
    delete_documents_in, discard_in, join_in, list_in, mark_in, reconcile_branches, show_in,
    status_in, step_in, step_reset_in,
};
use crate::error::ArcError;
use crate::log::{ArcRoundMeta, MarkStage, StepPhase};

/// The repo root the process's cwd sits in. A cwd outside any repository is
/// the caller standing in the wrong place, which the verb declines in
/// `find_repo_root`'s own words.
pub(crate) fn cwd_repo_root() -> Result<std::path::PathBuf, ArcError> {
    find_repo_root().map_err(|e| ArcError::Refused(e.to_string()))
}

/// [`list_in`] against the process cwd's repo root.
pub fn list() -> Result<Vec<ArcListItem>, ArcError> {
    let repo_root = cwd_repo_root()?;
    list_in(&repo_root)
}

/// [`show_in`] against the process cwd's repo root.
pub fn show(name: &str) -> Result<ShowOutcome, ArcError> {
    let repo_root = cwd_repo_root()?;
    show_in(&repo_root, name)
}

/// [`status_in`] against the cwd's repo — the CLI's entry point.
pub fn status(name: &str) -> Result<ArcStatus, ArcError> {
    let repo_root = cwd_repo_root()?;
    reconcile_branches(&repo_root, &mut Vec::new());
    status_in(&repo_root, name)
}

/// [`mark_in`] against the process cwd's repo root.
pub fn mark(name: &str, stage: MarkStage, note: Option<&str>) -> Result<MarkOutcome, ArcError> {
    let repo_root = cwd_repo_root()?;
    mark_in(&repo_root, name, stage, note)
}

/// [`commit_in`] against the process cwd's repo root.
pub fn commit(
    name: &str,
    message: &str,
    round_meta: Option<ArcRoundMeta>,
) -> Result<CommitOutcome, ArcError> {
    let repo_root = cwd_repo_root()?;
    commit_in(&repo_root, name, message, round_meta)
}

/// Create an arc: branch `tugarc/<name>` + worktree, base recorded in git
/// config, `[tugtool.arc].post_create` hook run. Idempotent — a fully-present
/// arc returns as-is (`created: false`) with no re-hydration.
///
/// With `plan`, the arc adopts that plan at birth: the file lands committed on
/// the arc branch and the base copy is cleaned, so there is one live copy from
/// second zero. Adoption runs on both exits — a re-run over an existing arc is
/// a repair, not an error.
///
/// With `carry`, the base checkout's uncommitted working set moves into the new
/// worktree ([P06]), uncommitted — the work is in progress by definition, and
/// the arc's first round commits it with intent. `carry` follows `plan`'s rule
/// on the idempotent revisit: a re-run transplants whatever the base holds now,
/// because a revisit is the repair path for both.
///
/// With `base`, the arc forks from that branch and records it as its
/// `tugbase` instead of consulting [`detect_default_branch`]. A checkout parked
/// off the default branch — a linked worktree under test, say — would otherwise
/// fork an arc from content it is not working on, and the join preflight would
/// later refuse over a base branch nobody has out. A base that does not exist
/// is refused before anything is created. A revisit ignores it: an arc's base
/// is set at birth.
pub fn create(
    name: &str,
    description: Option<String>,
    carry: bool,
    base: Option<&str>,
) -> Result<CreateOutcome, ArcError> {
    let repo_root = cwd_repo_root()?;
    create_in(&repo_root, name, description, carry, base)
}

/// Begin a step: the ledger row goes `in progress` and the log records it.
///
/// Idempotent on a row already `in progress` ([P04]), so an interrupted run
/// re-enters the step it was on without a hand-edit.
///
/// `through` is the final step of this run's selection, which the log records
/// so the join can tell a finished run from a paused one ([P01]).
pub fn step_start(name: &str, step: u32, through: u32) -> Result<StepOutcome, ArcError> {
    let repo_root = cwd_repo_root()?;
    reconcile_branches(&repo_root, &mut Vec::new());
    step_in(
        &repo_root,
        name,
        step,
        StepPhase::Start,
        None,
        Some(through),
        None,
    )
}

/// Finish a step: the ledger row goes `done` and records the round's commit.
pub fn step_done(name: &str, step: u32, commit: Option<&str>) -> Result<StepOutcome, ArcError> {
    let repo_root = cwd_repo_root()?;
    reconcile_branches(&repo_root, &mut Vec::new());
    step_in(&repo_root, name, step, StepPhase::Done, commit, None, None)
}

/// Withdraw a step: the ledger row goes `withdrawn` and the commit cell stays
/// empty, because a step nobody walked produced no round.
///
/// A withdrawal closes the step and advances the run exactly as a completion
/// does, so withdrawing a run's final selected step arms the join rather than
/// wedging the arc. It is reversible through `step_start`.
pub fn step_withdraw(name: &str, step: u32) -> Result<StepOutcome, ArcError> {
    let repo_root = cwd_repo_root()?;
    reconcile_branches(&repo_root, &mut Vec::new());
    step_in(
        &repo_root,
        name,
        step,
        StepPhase::Withdrawn,
        None,
        None,
        None,
    )
}

/// Park a step: the ledger row goes back to `pending`, its commit cell is
/// cleared, and the log records the park.
///
/// This is the gesture withdraw was being pressed into meaning and does not
/// mean. A withdrawal *closes* a step — it advances the run and can arm the
/// join — which is the right record for "we decided not to walk this" and the
/// wrong one for "we opened this and are putting it down". A park says the
/// second thing: nothing is claimed about the step, and the run has not moved
/// past it.
///
/// Refused on `done`, which is [`step_reopen`]'s business.
pub fn step_reset(name: &str, step: u32, why: Option<&str>) -> Result<StepOutcome, ArcError> {
    let repo_root = cwd_repo_root()?;
    step_reset_in(&repo_root, name, step, why)
}

/// Reopen a finished step: the ledger row goes `done` → `in progress`, its
/// commit cell stands, and the log records why.
///
/// The audit-rejected case, and the reason `done` is no longer the end of the
/// road. The log line does two things: it names the reason, so a later reader
/// knows what the re-walk is answering, and it **un-arms the join** — the
/// generation's last close is gone, so `run_complete` reads false until the
/// step closes again. An arc whose work an audit rejected must not be offerable
/// for landing, and that fact now lives in the log rather than in a person.
pub fn step_reopen(name: &str, step: u32, why: &str) -> Result<StepOutcome, ArcError> {
    let repo_root = cwd_repo_root()?;
    reconcile_branches(&repo_root, &mut Vec::new());
    step_in(
        &repo_root,
        name,
        step,
        StepPhase::Reopen,
        None,
        None,
        Some(why),
    )
}

/// [`delete_documents_in`] against the process cwd's repo root.
pub fn delete_documents(name: &str) -> Result<DeleteDocumentsOutcome, ArcError> {
    let repo_root = cwd_repo_root()?;
    delete_documents_in(&repo_root, name)
}

/// Join an arc into its base branch ([P14]): `--strategy squash|merge|rebase`,
/// a `--preview` (in-memory `git merge-tree`, nothing touched), an
/// intersection-aware preflight (base dirt blocks only when it overlaps the
/// arc's changed set), a clean abort on conflict with the structured conflict
/// list, and a recorded teardown resumable via `--continue`. The default
/// squash/merge message is the maintained arc draft, else the description.
pub fn join(name: &str, opts: JoinOptions) -> Result<JoinOutcome, ArcError> {
    let repo_root = cwd_repo_root()?;
    join_in(&repo_root, name, opts)
}

/// Release an arc: tear down its worktree + branch without merging.
pub fn discard(
    name: &str,
    origin: Option<&str>,
    break_lease: bool,
) -> Result<DiscardOutcome, ArcError> {
    let repo_root = cwd_repo_root()?;
    discard_in(&repo_root, name, origin, break_lease)
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // set_current_dir is needed for tests with isolated temp dirs
mod tests {
    use super::*;
    use crate::ops::test_support::*;
    use crate::ops::*;
    use serial_test::serial;

    /// The park has one body, whichever door reached it ([P07]).
    ///
    /// `step_reset` resolves its root from the cwd, which is the one thing the
    /// arc runner cannot do — it holds the project path as a fact and runs from
    /// wherever tugcast was launched. So the runner calls `step_reset_in`, and
    /// what it gets has to be exactly what a person at the CLI gets.
    #[serial]
    #[test]
    fn step_reset_and_step_reset_in_agree() {
        let (_temp, root) = stepped_arc("park-twin-arc");

        step_start("park-twin-arc", 1, 2).unwrap();
        let through_cwd = step_reset("park-twin-arc", 1, Some("the same reason")).unwrap();
        step_start("park-twin-arc", 1, 2).unwrap();
        let through_root =
            step_reset_in(&root, "park-twin-arc", 1, Some("the same reason")).unwrap();

        assert_eq!(through_cwd.arc, through_root.arc);
        assert_eq!(through_cwd.plan, through_root.plan);
        assert_eq!(through_cwd.step, through_root.step);
        assert_eq!(through_cwd.total, through_root.total);
        assert_eq!(through_cwd.status, through_root.status);
        assert_eq!(through_cwd.commit, through_root.commit);
        assert_eq!(through_cwd.through, through_root.through);
        assert_eq!(through_root.status, "pending");
        assert_eq!(
            log_text(&root)
                .matches("step-reset  1/2 Step 1: The first step — the same reason")
                .count(),
            2,
            "both doors wrote the same line: {}",
            log_text(&root),
        );
    }
}
