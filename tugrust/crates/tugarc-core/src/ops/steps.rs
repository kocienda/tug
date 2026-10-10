//! The step verbs: `start`, `done`, `withdraw`, `reset` and `reopen` move a ledger
//! row and its paired arc-log line together.

use serde::Serialize;
use std::path::Path;

use super::documents::{documents_dir, ledger_file};
use super::git::{git_output, git_stdout};
use super::identity::{branch_exists, branch_name, reconcile_branches, worktree_path};
use crate::error::ArcError;
use crate::log::{
    StepPhase, append_run_through, open_arc_log, read_declarations, step_declaration_note,
    write_arc_log_line,
};

// --- steps ([P04], [P08]) --------------------------------------------------

/// What one `arc step` verb did (Spec S02).
#[derive(Debug, Clone, Serialize)]
pub struct StepOutcome {
    #[serde(rename = "arc")]
    pub arc: String,
    /// The absolute path of the plan whose ledger moved.
    pub plan: String,
    pub step: u32,
    /// Ledger rows in the plan — the `N` of `i/N`.
    pub total: u32,
    /// The status the row now carries.
    pub status: String,
    /// The commit recorded in the row, on `done`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// The run's declared final step — the `--through <m>` of [P01]. Present on
    /// a start, and on a done when the generation has declared a run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub through: Option<u32>,
}

/// Write `contents` over `path` without ever leaving a half-written plan on
/// disk: a uniquely named sibling temp file, synced, then renamed over.
///
/// The temp name is unique per writer because tugcast's arc runner and the
/// CLI both write arc documents, and two writers sharing one temp path could
/// rename each other's partial file into place. With a temp file each, two
/// concurrent writes resolve to "last rename wins" — one writer's whole
/// document, never a splice. The sync before the rename is what makes the
/// rename atomic in content and not only in name.
pub(crate) fn write_atomic(path: &Path, contents: &str) -> Result<(), ArcError> {
    use std::io::Write;
    let dir = path
        .parent()
        .ok_or_else(|| ArcError::Refused(format!("{} has no parent directory", path.display())))?;
    let stem = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "plan".to_string());
    // Dot-prefixed, so whatever ignores dotfiles in the directory ignores the
    // temp too, as it did when the name was fixed.
    let mut tmp = tempfile::Builder::new()
        .prefix(&format!(".{stem}."))
        .suffix(".tugtmp")
        .tempfile_in(dir)
        .map_err(|e| {
            ArcError::io(
                format!("cannot create a temp file in {}", dir.display()),
                dir,
                e,
            )
        })?;
    // A temp file is created owner-only; the document keeps the mode it had,
    // or the ordinary one when it is new.
    let mode = std::fs::metadata(path)
        .map(|m| m.permissions())
        .unwrap_or_else(|_| std::os::unix::fs::PermissionsExt::from_mode(0o644));
    let temp_path = tmp.path().to_path_buf();
    tmp.as_file_mut()
        .write_all(contents.as_bytes())
        .and_then(|()| tmp.as_file().set_permissions(mode))
        .and_then(|()| tmp.as_file().sync_all())
        .map_err(|e| {
            ArcError::io(
                format!("cannot write {}", temp_path.display()),
                &temp_path,
                e,
            )
        })?;
    // A failed persist hands the temp back, and dropping it removes it.
    tmp.persist(path)
        .map(drop)
        .map_err(|e| ArcError::io(format!("cannot replace {}", path.display()), path, e.error))
}

/// Commit the two records a step move produces — the ledger table and the
/// arc log line — as close to together as two files can be committed.
///
/// No filesystem moves two files as one, and the arc log cannot be
/// rename-committed the way the plan can: it is shared by every arc in the
/// project and appended to concurrently, so read-modify-rename would drop a
/// neighbouring arc's line. What is available instead is *ordering the
/// fallible parts before the committing parts*, which is what this does:
///
/// 1. **Open the log first.** Creating `.tug/` and opening the file is where a
///    log append actually fails — a bad permission, a missing parent, a full
///    disk on the create. Doing it before the table moves means those failures
///    leave both records exactly as they were.
/// 2. **Rename the plan.** [`write_atomic`] writes a sibling temp and renames,
///    so the table is never half-written.
/// 3. **Write the line** through the handle already open. On a file opened
///    `O_APPEND` this is one `write` with nowhere left to go wrong for a
///    reason step 1 could not already have found.
/// 4. **Roll the table back if step 3 still fails.** The original bytes are in
///    hand, so the plan goes back to what it was and the refusal says the row
///    was not moved — true again.
///
/// What remains is a hard crash in the gap between the rename and the write,
/// which no two-file scheme closes. That gap is why `arc doctor` exists: the
/// window is now a machine failure rather than an ordinary error path, and it
/// is detected and repairable rather than silent.
///
/// **Idempotent re-entry writes nothing.** A `step start` on a row already `in
/// progress` produces byte-identical text, and if the log already declares that
/// step open the act has entirely happened — so no duplicate `step-start` line
/// is appended. The two conditions are checked together on purpose: a table
/// that did not move while the log says nothing is the *desync*, and appending
/// the missing line there is the repair, not a duplicate.
#[allow(clippy::too_many_arguments)]
fn write_step_pair(
    repo_root: &Path,
    name: &str,
    plan: &Path,
    source: &str,
    edited: &str,
    phase: StepPhase,
    step: u32,
    total: u32,
    note_tail: &str,
    log_already_says_so: bool,
) -> Result<(), ArcError> {
    if edited == source && log_already_says_so {
        return Ok(());
    }

    let mut log = open_arc_log(repo_root).map_err(|e| {
        ArcError::arc_log_said(
            repo_root,
            format!("the arc log will not open ({e}); step {step} of '{name}' was not moved"),
        )
    })?;

    write_atomic(plan, edited)?;

    let note = step_declaration_note(step, total, note_tail);
    if let Err(e) = write_arc_log_line(&mut log, name, phase.marker(), note.trim()) {
        let undone = match write_atomic(plan, source) {
            Ok(()) => "the row was put back",
            Err(_) => {
                "AND THE ROW COULD NOT BE PUT BACK — the table and the log now \
                 disagree; run `tugtool arc doctor`"
            }
        };
        return Err(ArcError::arc_log_said(
            repo_root,
            format!("step {step} of '{name}' could not be declared in the arc log ({e}); {undone}"),
        ));
    }
    Ok(())
}

/// Drive one ledger row and the arc log in a single gesture ([P04]).
///
/// The edit is computed, verified, and only then written, so every refusal
/// leaves the plan byte-for-byte as it was, and the pair is committed by
/// [`write_step_pair`], which is where the "two records, one act" discipline
/// lives.
pub(super) fn step_in(
    repo_root: &Path,
    name: &str,
    step: u32,
    phase: StepPhase,
    commit: Option<&str>,
    through: Option<u32>,
    why: Option<&str>,
) -> Result<StepOutcome, ArcError> {
    let branch = branch_name(name);
    let worktree = worktree_path(repo_root, name);
    if !branch_exists(repo_root, &branch) || !worktree.exists() {
        return Err(ArcError::Refused(format!(
            "Arc not found or not active: {}",
            name
        )));
    }

    // The ledger is the plan when there is one and the task list otherwise:
    // one step verb, either kind, no flag to get wrong.
    let abs = ledger_file(repo_root, name).ok_or_else(|| {
        ArcError::Refused(format!(
            "arc '{name}' has no plan or task list at {}",
            documents_dir(repo_root, name).display()
        ))
    })?;
    let rel = abs.display().to_string();
    let source = std::fs::read_to_string(&abs).map_err(|e| {
        ArcError::io(
            format!("cannot read the ledger at {}", abs.display()),
            &abs,
            e,
        )
    })?;
    let doc = tugtool_core::plan::parse(&source)
        .map_err(|_| ArcError::Refused(format!("{rel} carries no step ledger")))?;

    let anchor = format!("step-{step}");
    let total = doc.ledger_rows.len() as u32;
    let (title, row_commit) = doc
        .ledger_rows
        .iter()
        .find(|r| r.anchor == anchor)
        .map(|r| (r.title.clone(), r.commit.clone()))
        .ok_or_else(|| ArcError::Refused(format!("{rel}: no ledger row for #{anchor}")))?;

    // The run's selection is declared before its first step moves, so a run that
    // dies after the start still says what it set out to do ([P01], Spec S01).
    let declared = read_declarations(repo_root, name);
    if let Some(through) = through {
        if through < step {
            return Err(ArcError::Refused(format!(
                "--through {through} is before step {step}: it names the final step of this run's selection"
            )));
        }
        let through_anchor = format!("step-{through}");
        if !doc.ledger_rows.iter().any(|r| r.anchor == through_anchor) {
            return Err(ArcError::Refused(format!(
                "{rel}: no ledger row for #{through_anchor}"
            )));
        }
        if declared.run_through != Some(through) {
            append_run_through(repo_root, name, through)
                .map_err(|e| ArcError::arc_log(repo_root, e))?;
        }
    }
    let through = through.or(declared.run_through);

    let status = match phase {
        StepPhase::Start | StepPhase::Reopen => "in progress",
        StepPhase::Done => "done",
        StepPhase::Withdrawn => "withdrawn",
        StepPhase::Reset => "pending",
    };
    // A withdrawal records no commit, because none was made — so its note tail
    // falls through to the step's title, the grammar a `step-start` writes.
    let sha = match phase {
        StepPhase::Start | StepPhase::Withdrawn => None,
        // A park clears the cell; a reopen keeps whatever the round recorded,
        // so the outcome reports the row as it now stands rather than nothing.
        StepPhase::Reset => None,
        StepPhase::Reopen => row_commit.clone(),
        StepPhase::Done => Some(match commit {
            // A sha the caller supplies is checked against the worktree the
            // arc actually runs in. Recorded unverified, any string at all
            // read as a round: a typo, a sha from the base checkout, the word
            // `HEAD~1` after a rebase moved it. The ledger's commit cell is
            // what a later reader follows back to the work, and a cell that
            // resolves to nothing is worse than an empty one, because it
            // claims there is something to find.
            Some(sha) => {
                let sha = sha.trim();
                verify_commit(&worktree, sha).map_err(|detail| {
                    ArcError::Refused(format!(
                        "step {step} of '{name}' cannot record commit '{sha}': {detail}. \
                         The row was not moved."
                    ))
                })?
            }
            None => git_stdout(repo_root, &["rev-parse", "--short", &branch])?,
        }),
    };

    let edited = match phase {
        StepPhase::Reset => tugtool_core::plan::reset_ledger_row(&source, &anchor),
        StepPhase::Reopen => tugtool_core::plan::reopen_ledger_row(&source, &anchor),
        _ => tugtool_core::plan::set_ledger_status(&source, &anchor, status, sha.as_deref()),
    }
    .map_err(|e| ArcError::Refused(format!("{rel}: {e}")))?;

    // A `done` note's tail is the round's sha; every other phase's is the
    // step's title, which is what a display has to show. A `--why` rides after
    // it, so the reason a step was parked or reopened is in the log line that
    // records the act rather than in nobody's memory.
    let note_tail = match (phase, &sha, why) {
        (StepPhase::Done, Some(sha), _) => sha.clone(),
        (_, _, Some(why)) if !why.trim().is_empty() => {
            format!("Step {step}: {title} — {}", why.trim())
        }
        _ => format!("Step {step}: {title}"),
    };

    // Whether the log already carries this exact act, which is what makes a
    // re-entry a no-op rather than a duplicate line. Only `start` re-enters:
    // every other phase either moves the row or refuses at the gate above.
    let log_already_says_so = phase == StepPhase::Start
        && declared.step == Some((step, total))
        && declared.step_in_flight;

    write_step_pair(
        repo_root,
        name,
        &abs,
        &source,
        &edited,
        phase,
        step,
        total,
        &note_tail,
        log_already_says_so,
    )
    .map_err(|e| e.context(&rel))?;

    Ok(StepOutcome {
        arc: name.to_string(),
        plan: rel,
        step,
        total,
        status: status.to_string(),
        commit: sha,
        through,
    })
}

/// [`step_reset`] against a repo root the caller already holds.
///
/// The CLI resolves its root from the cwd, which is the one thing a server
/// cannot do: the arc runner holds the project path as a fact and runs from
/// wherever tugcast was launched. So the body lives here and `step_reset`
/// delegates to it — one park, whichever door reached it, rather than two
/// that are free to drift.
pub fn step_reset_in(
    repo_root: &Path,
    name: &str,
    step: u32,
    why: Option<&str>,
) -> Result<StepOutcome, ArcError> {
    reconcile_branches(repo_root, &mut Vec::new());
    step_in(repo_root, name, step, StepPhase::Reset, None, None, why)
}

/// Resolve `rev` to a commit in `worktree`, or say why it does not.
///
/// `--verify` with a `^{commit}` peel is the whole check: it refuses a name
/// that resolves to nothing, and it refuses one that resolves to a tree or a
/// tag pointing at something that is not a commit. The **short** form comes
/// back, because that is what the auto path records and a ledger whose commit
/// cells are written two ways for one reason reads as two facts.
fn verify_commit(worktree: &Path, rev: &str) -> Result<String, ArcError> {
    if rev.is_empty() {
        return Err(ArcError::Refused("it is empty".to_string()));
    }
    let out = git_output(
        worktree,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{rev}^{{commit}}"),
        ],
    )?;
    if !out.status.success() {
        return Err(ArcError::Refused(format!(
            "it resolves to no commit in the arc worktree at {}",
            worktree.display()
        )));
    }
    let full = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(git_stdout(worktree, &["rev-parse", "--short", &full]).unwrap_or(full))
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // set_current_dir is needed for tests with isolated temp dirs
mod tests {
    use super::*;
    use crate::ops::test_support::*;
    use crate::ops::*;
    use serial_test::serial;
    use std::fs;
    use tempfile::TempDir;

    #[serial]
    #[test]
    fn step_verbs_drive_the_ledger_and_the_arc_log_together() {
        let (_temp, root) = stepped_arc("step-arc");

        let started = step_start("step-arc", 1, 2).unwrap();
        assert_eq!(
            started.plan,
            plan_file(&root, "step-arc").display().to_string()
        );
        assert_eq!((started.step, started.total), (1, 2));
        assert_eq!(started.status, "in progress");
        assert_eq!(
            ledger_row(&root, "step-arc", "step-1").status,
            "in progress"
        );
        assert_eq!(
            crate::log::read_declarations(&root, "step-arc").latest,
            Some(crate::log::ArcDeclaration::Step {
                current: 1,
                total: 2
            })
        );

        let head = worktree_head(&root, "step-arc");
        let done = step_done("step-arc", 1, Some(&head)).unwrap();
        assert_eq!(done.commit.as_deref(), Some(head.as_str()));
        let row = ledger_row(&root, "step-arc", "step-1");
        assert_eq!(row.status, "done");
        assert_eq!(row.commit.as_deref(), Some(head.as_str()));

        // Nothing records where the plan is; the next step finds it at the same
        // address the first one did.
        let next = step_start("step-arc", 2, 2).unwrap();
        assert_eq!(
            next.plan,
            plan_file(&root, "step-arc").display().to_string()
        );
        assert_eq!(
            ledger_row(&root, "step-arc", "step-2").status,
            "in progress"
        );
    }

    /// The park: an opened step goes back to never-walked, in the table and in
    /// the log, and the run does not advance past it.
    #[serial]
    #[test]
    fn step_reset_parks_an_open_step_in_both_records() {
        let (_temp, root) = stepped_arc("park-arc");

        step_start("park-arc", 1, 2).unwrap();
        let parked = step_reset("park-arc", 1, Some("the approach was wrong")).unwrap();
        assert_eq!(parked.status, "pending");
        assert_eq!(parked.commit, None);
        assert_eq!(ledger_row(&root, "park-arc", "step-1").status, "pending");

        // The log declares the park, carries the reason, and reports the step
        // as neither in flight nor closed.
        let decls = crate::log::read_declarations(&root, "park-arc");
        assert!(!decls.step_in_flight, "a parked step is not in flight");
        assert!(!decls.run_complete);
        assert_eq!(decls.step, Some((1, 2)));
        assert!(
            log_text(&root)
                .contains("step-reset  1/2 Step 1: The first step — the approach was wrong"),
            "the log names the park and its reason: {}",
            log_text(&root)
        );

        // And it is genuinely a park, not a close: the step opens again.
        let reopened = step_start("park-arc", 1, 2).unwrap();
        assert_eq!(reopened.status, "in progress");
    }

    /// A park is refused on a finished row. Un-finishing is `reopen`'s act,
    /// and the two keep different records for a reason.
    #[serial]
    #[test]
    fn step_reset_refuses_a_done_row() {
        let (_temp, root) = stepped_arc("park-done-arc");
        step_start("park-done-arc", 1, 2).unwrap();
        step_done("park-done-arc", 1, None).unwrap();

        let before = fs::read_to_string(plan_file(&root, "park-done-arc")).unwrap();
        let err = step_reset("park-done-arc", 1, None)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("'done'") && err.contains("'pending'"),
            "the refusal names both ends: {err}"
        );
        assert_eq!(
            fs::read_to_string(plan_file(&root, "park-done-arc")).unwrap(),
            before,
            "a refused park leaves the plan byte-for-byte as it was"
        );
    }

    /// Reopen is the audit-rejected case: the row comes back to `in progress`
    /// keeping its sha, and — the settled decision — the join un-arms until the
    /// step closes again.
    #[serial]
    #[test]
    fn step_reopen_unarms_the_join_until_the_step_recloses() {
        let (_temp, root) = stepped_arc("reopen-arc");
        let worktree = worktree_path(&root, "reopen-arc");

        step_start("reopen-arc", 1, 1).unwrap();
        fs::write(worktree.join("one.txt"), "first\n").unwrap();
        commit("reopen-arc", "r1", None).unwrap();
        let done = step_done("reopen-arc", 1, None).unwrap();
        let sha = done.commit.clone().unwrap();
        assert!(arc_detail_entry_in(&root, "reopen-arc").unwrap().join_ready);

        let reopened = step_reopen("reopen-arc", 1, "the audit rejected the approach").unwrap();
        assert_eq!(reopened.status, "in progress");
        assert_eq!(
            reopened.commit.as_deref(),
            Some(sha.as_str()),
            "the rejected round is still on the branch and still named"
        );
        let row = ledger_row(&root, "reopen-arc", "step-1");
        assert_eq!(row.status, "in progress");
        assert_eq!(row.commit.as_deref(), Some(sha.as_str()));

        let detail = arc_detail_entry_in(&root, "reopen-arc").unwrap();
        assert!(!detail.run_complete, "the run is no longer finished");
        assert!(
            !detail.join_ready,
            "rejected work must not be offerable for landing"
        );
        assert_eq!(detail.stage, "implementing");
        assert!(
            log_text(&root)
                .contains("step-reopen  1/2 Step 1: The first step — the audit rejected"),
            "the log names the reopen and why: {}",
            log_text(&root)
        );

        // Re-closing re-arms it, with no further gesture.
        fs::write(worktree.join("one.txt"), "second try\n").unwrap();
        commit("reopen-arc", "r2", None).unwrap();
        step_done("reopen-arc", 1, None).unwrap();
        let detail = arc_detail_entry_in(&root, "reopen-arc").unwrap();
        assert!(detail.run_complete);
        assert!(detail.join_ready);
    }

    /// **Reopening a step in the *middle* of a finished run re-arms the join
    /// when that step re-closes.**
    ///
    /// The wedge this pins: `run_complete` used to be one number against the
    /// run-through, and re-closing a reopened middle step wrote that number
    /// back to the step's own — so a five-step run whose step 2 was reopened
    /// and re-closed ended on `step-done 2`, read as "the run reached step 2",
    /// and could never be joined again. No gesture recovered it; the only exit
    /// was hand-editing the log the machine is supposed to own.
    ///
    /// The fold now keeps the run's **frontier** apart from the last line's
    /// number, so the sentence the log tells is "this run got to 2, and
    /// nothing it passed is open" — which the re-close makes true again. The
    /// companion above covers the *final* step, where the two readings agree
    /// and the wedge never showed.
    #[serial]
    #[test]
    fn reopening_a_middle_step_re_arms_the_join_when_that_step_recloses() {
        let (_temp, root) = stepped_arc("reopen-middle-arc");
        let worktree = worktree_path(&root, "reopen-middle-arc");

        // A two-step run, walked to the end. Step 1 is the middle step here:
        // the run's frontier passes it and settles on 2.
        step_start("reopen-middle-arc", 1, 2).unwrap();
        fs::write(worktree.join("one.txt"), "first\n").unwrap();
        commit("reopen-middle-arc", "r1", None).unwrap();
        step_done("reopen-middle-arc", 1, None).unwrap();

        step_start("reopen-middle-arc", 2, 2).unwrap();
        fs::write(worktree.join("two.txt"), "second\n").unwrap();
        commit("reopen-middle-arc", "r2", None).unwrap();
        step_done("reopen-middle-arc", 2, None).unwrap();

        let detail = arc_detail_entry_in(&root, "reopen-middle-arc").unwrap();
        assert!(detail.run_complete, "the selection finished");
        assert!(detail.join_ready);

        // The audit rejects step 1's round. The run is not finished any more,
        // even though the frontier already reached 2.
        step_reopen("reopen-middle-arc", 1, "the audit rejected the approach").unwrap();
        let detail = arc_detail_entry_in(&root, "reopen-middle-arc").unwrap();
        assert!(
            !detail.run_complete,
            "a reopened step behind the frontier still un-arms the run"
        );
        assert!(!detail.join_ready);

        // Re-closing settles it. The last step line names step 1 — which is
        // exactly the reading the old arithmetic mistook for the frontier.
        fs::write(worktree.join("one.txt"), "second try\n").unwrap();
        commit("reopen-middle-arc", "r3", None).unwrap();
        step_done("reopen-middle-arc", 1, None).unwrap();

        let detail = arc_detail_entry_in(&root, "reopen-middle-arc").unwrap();
        assert_eq!(
            (detail.step_current, detail.step_total),
            (Some(1), Some(2)),
            "the log's last step line is about step 1, not step 2"
        );
        assert!(
            detail.run_complete,
            "and the run is finished all the same — the frontier is not the last line"
        );
        assert!(detail.join_ready, "so the join is armed again");
    }

    /// A *parked* middle step holds the run open the same way, and unparking
    /// it releases the run rather than dragging the frontier back.
    ///
    /// `step reset` and `step reopen` differ in what they say about the row —
    /// one un-finishes it, the other un-starts it — and not at all in what
    /// they say about the run. Both are debts against the frontier.
    #[serial]
    #[test]
    fn parking_a_middle_step_holds_the_run_open_until_it_closes_again() {
        let (_temp, root) = stepped_arc("reset-middle-arc");
        let worktree = worktree_path(&root, "reset-middle-arc");

        step_start("reset-middle-arc", 1, 2).unwrap();
        fs::write(worktree.join("one.txt"), "first\n").unwrap();
        commit("reset-middle-arc", "r1", None).unwrap();
        step_done("reset-middle-arc", 1, None).unwrap();
        step_start("reset-middle-arc", 2, 2).unwrap();
        fs::write(worktree.join("two.txt"), "second\n").unwrap();
        commit("reset-middle-arc", "r2", None).unwrap();
        step_done("reset-middle-arc", 2, None).unwrap();
        assert!(
            arc_detail_entry_in(&root, "reset-middle-arc")
                .unwrap()
                .join_ready
        );

        step_reopen("reset-middle-arc", 1, "wrong shape").unwrap();
        step_reset("reset-middle-arc", 1, Some("parked for now")).unwrap();
        let detail = arc_detail_entry_in(&root, "reset-middle-arc").unwrap();
        assert!(!detail.run_complete, "a parked step is an open debt");
        assert!(
            !crate::log::read_declarations(&root, "reset-middle-arc").step_in_flight,
            "and it is not in flight either"
        );

        step_start("reset-middle-arc", 1, 2).unwrap();
        fs::write(worktree.join("one.txt"), "third try\n").unwrap();
        commit("reset-middle-arc", "r3", None).unwrap();
        step_done("reset-middle-arc", 1, None).unwrap();
        let detail = arc_detail_entry_in(&root, "reset-middle-arc").unwrap();
        assert!(
            detail.run_complete,
            "the debt is settled and the run stands"
        );
        assert!(detail.join_ready);
    }

    /// Reopen refuses every row that is not `done` — a step nobody finished is
    /// not a step anybody can un-finish.
    #[serial]
    #[test]
    fn step_reopen_refuses_a_row_that_was_never_closed() {
        let (_temp, root) = stepped_arc("reopen-open-arc");
        step_start("reopen-open-arc", 1, 2).unwrap();
        let err = step_reopen("reopen-open-arc", 1, "because")
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("'in progress'"),
            "the refusal names the row's actual status: {err}"
        );
        assert_eq!(
            ledger_row(&root, "reopen-open-arc", "step-1").status,
            "in progress"
        );
    }

    /// Idempotent re-entry writes nothing. Re-opening a step already open is a
    /// legal gesture — an interrupted run does it — and it used to append a
    /// `step-start` line every time, so a log that is the derivation surface
    /// filled with declarations of an act that did not happen.
    #[serial]
    #[test]
    fn re_entering_an_open_step_appends_no_second_log_line() {
        let (_temp, root) = stepped_arc("reentry-arc");

        step_start("reentry-arc", 1, 2).unwrap();
        let after_first = log_text(&root);
        assert_eq!(after_first.matches("step-start").count(), 1);

        step_start("reentry-arc", 1, 2).unwrap();
        step_start("reentry-arc", 1, 2).unwrap();
        assert_eq!(
            log_text(&root).matches("step-start").count(),
            1,
            "re-entry declares nothing new: {}",
            log_text(&root)
        );
        assert_eq!(
            ledger_row(&root, "reentry-arc", "step-1").status,
            "in progress"
        );

        // But a *different* step still declares itself, and a re-entry after a
        // park is a genuine reopening of the row.
        step_start("reentry-arc", 2, 2).unwrap();
        assert_eq!(log_text(&root).matches("step-start").count(), 2);
        step_reset("reentry-arc", 2, None).unwrap();
        step_start("reentry-arc", 2, 2).unwrap();
        assert_eq!(
            log_text(&root).matches("step-start").count(),
            3,
            "a park makes the next start a real one again"
        );
    }

    /// The desync repair rides on the same predicate: a table that already
    /// reads `in progress` while the log declares nothing gets the missing
    /// line rather than being mistaken for a re-entry.
    #[serial]
    #[test]
    fn a_table_ahead_of_the_log_gets_the_missing_declaration() {
        let (_temp, root) = stepped_arc("desync-arc");

        // Move the table alone, exactly as a crash between the two writes does.
        let plan = plan_file(&root, "desync-arc");
        let source = fs::read_to_string(&plan).unwrap();
        let moved =
            tugtool_core::plan::set_ledger_status(&source, "step-1", "in progress", None).unwrap();
        fs::write(&plan, &moved).unwrap();
        assert!(!log_text(&root).contains("step-start"));

        step_start("desync-arc", 1, 2).unwrap();
        assert_eq!(
            log_text(&root).matches("step-start").count(),
            1,
            "the log caught up rather than being taken for already-correct"
        );
    }

    #[serial]
    #[test]
    fn the_run_declares_its_selection_once_and_refuses_a_nonsense_one() {
        let (_temp, root) = stepped_arc("through-arc");

        let started = step_start("through-arc", 1, 2).unwrap();
        assert_eq!(started.through, Some(2));
        assert_eq!(
            crate::log::read_declarations(&root, "through-arc").run_through,
            Some(2)
        );

        // Re-entering the same step re-declares nothing.
        step_start("through-arc", 1, 2).unwrap();
        let log = fs::read_to_string(
            tugtool_core::project_state_dir(&root).join(tugtool_core::paths::ARC_LOG),
        )
        .unwrap();
        assert_eq!(
            log.lines()
                .filter(|l| l.contains("  through-arc  run-through  "))
                .count(),
            1,
            "an unchanged selection writes no second line"
        );

        // A done carries the standing declaration without re-writing it.
        let head = worktree_head(&root, "through-arc");
        let done = step_done("through-arc", 1, Some(&head)).unwrap();
        assert_eq!(done.through, Some(2));

        // A selection ending before the step it starts is not a selection.
        let err = step_start("through-arc", 2, 1).unwrap_err().to_string();
        assert!(err.contains("--through 1 is before step 2"), "{err}");

        // Nor is one naming a row the ledger does not carry.
        let err = step_start("through-arc", 2, 9).unwrap_err().to_string();
        assert!(err.contains("no ledger row for #step-9"), "{err}");
    }

    #[serial]
    #[test]
    fn step_done_records_the_branch_tip_when_no_commit_is_named() {
        let (_temp, root) = stepped_arc("tip-arc");
        step_start("tip-arc", 1, 2).unwrap();
        let tip = git_stdout(&root, &["rev-parse", "--short", "tugarc/tip-arc"]).unwrap();

        let done = step_done("tip-arc", 1, None).unwrap();
        assert_eq!(done.commit.as_deref(), Some(tip.as_str()));
        assert_eq!(
            ledger_row(&root, "tip-arc", "step-1").commit.as_deref(),
            Some(tip.as_str())
        );
    }

    /// A `--commit` that resolves to nothing is refused, and the row does not
    /// move.
    ///
    /// The cell is what a later reader follows back to the work. Any string at
    /// all used to be recorded — a typo, a sha from the base checkout, a
    /// `HEAD~1` that a rebase had moved — so a row could claim there was
    /// something to find where there was not.
    #[serial]
    #[test]
    fn step_done_refuses_a_commit_the_arc_worktree_cannot_resolve() {
        let (_temp, root) = stepped_arc("bogus-sha-arc");
        step_start("bogus-sha-arc", 1, 2).unwrap();

        let err = step_done("bogus-sha-arc", 1, Some("abc1234"))
            .unwrap_err()
            .to_string();
        assert!(err.contains("cannot record commit 'abc1234'"), "{err}");
        assert!(err.contains("The row was not moved."), "{err}");
        assert_eq!(
            ledger_row(&root, "bogus-sha-arc", "step-1").status,
            "in progress",
            "a refused done leaves the row open rather than half-closing it",
        );

        // And the same row closes on a sha the worktree does hold.
        let head = worktree_head(&root, "bogus-sha-arc");
        step_done("bogus-sha-arc", 1, Some(&head)).unwrap();
        assert_eq!(ledger_row(&root, "bogus-sha-arc", "step-1").status, "done");
    }

    /// A sha is recorded in the short form the automatic path writes, so the
    /// ledger's commit cells are one shape rather than two.
    #[serial]
    #[test]
    fn step_done_records_a_named_commit_in_its_short_form() {
        let (_temp, root) = stepped_arc("long-sha-arc");
        step_start("long-sha-arc", 1, 2).unwrap();
        let worktree = worktree_path(&root, "long-sha-arc");
        let full = git_stdout(&worktree, &["rev-parse", "HEAD"]).unwrap();
        let short = git_stdout(&worktree, &["rev-parse", "--short", "HEAD"]).unwrap();

        let done = step_done("long-sha-arc", 1, Some(&full)).unwrap();
        assert_eq!(done.commit.as_deref(), Some(short.as_str()));
    }

    #[serial]
    #[test]
    fn step_verbs_refuse_and_leave_the_plan_untouched() {
        let (_temp, root) = stepped_arc("refuse-arc");
        let plan = plan_file(&root, "refuse-arc");
        let before = fs::read_to_string(&plan).unwrap();

        // An arc with neither document at its own address.
        fs::remove_file(&plan).unwrap();
        let err = step_start("refuse-arc", 1, 2).unwrap_err().to_string();
        assert!(err.contains("has no plan or task list at"), "{err}");
        fs::write(&plan, &before).unwrap();

        // An anchor the ledger does not carry.
        let err = step_start("refuse-arc", 9, 2).unwrap_err().to_string();
        assert!(err.contains("no ledger row for #step-9"), "{err}");

        // A finished row refuses to be started again, naming its status.
        step_start("refuse-arc", 1, 2).unwrap();
        step_done("refuse-arc", 1, None).unwrap();
        let err = step_start("refuse-arc", 1, 2).unwrap_err().to_string();
        assert!(err.contains("is 'done'"), "{err}");

        // Only the two successful calls moved the document.
        let after = fs::read_to_string(&plan).unwrap();
        assert_eq!(
            after.lines().filter(|l| l.starts_with("| #step-")).count(),
            2
        );
        assert_eq!(
            before.lines().count(),
            after.lines().count(),
            "no refusal added or dropped a line"
        );
    }

    /// The verbs drive the plan where it lives, and the worktree never sees it:
    /// a run's whole ledger walk leaves the arc's tree byte-for-byte clean.
    #[serial]
    #[test]
    fn step_verbs_drive_the_plan_in_the_arc_directory() {
        let (_temp, root) = stepped_arc("home-arc");
        let worktree = worktree_path(&root, "home-arc");
        let porcelain = || git_stdout(&worktree, &["status", "--porcelain"]).unwrap();
        assert_eq!(porcelain(), "", "the seeded plan is not in the worktree");

        let started = step_start("home-arc", 1, 2).unwrap();
        assert_eq!(
            started.plan,
            plan_file(&root, "home-arc").display().to_string()
        );
        assert_eq!(porcelain(), "");

        let tip = git_stdout(&root, &["rev-parse", "--short", "tugarc/home-arc"]).unwrap();
        step_done("home-arc", 1, None).unwrap();
        let row = ledger_row(&root, "home-arc", "step-1");
        assert_eq!(row.status, "done");
        assert_eq!(row.commit.as_deref(), Some(tip.as_str()));
        assert_eq!(porcelain(), "", "and the ledger write left no dirt behind");
    }

    #[serial]
    #[test]
    fn step_start_re_enters_an_interrupted_step() {
        let (_temp, root) = stepped_arc("resume-arc");
        step_start("resume-arc", 1, 2).unwrap();
        let interrupted = fs::read_to_string(plan_file(&root, "resume-arc")).unwrap();

        step_start("resume-arc", 1, 2).expect("a resumed run re-enters its own step");
        let after = fs::read_to_string(plan_file(&root, "resume-arc")).unwrap();
        assert_eq!(after, interrupted, "re-entry moves no byte of the plan");
    }

    #[serial]
    #[test]
    fn step_withdraw_closes_the_row_with_no_commit() {
        let (_temp, root) = stepped_arc("withdraw-arc");
        step_start("withdraw-arc", 1, 2).unwrap();

        let outcome = step_withdraw("withdraw-arc", 1).unwrap();
        assert_eq!(outcome.status, "withdrawn");
        assert_eq!(outcome.commit, None);
        assert_eq!(
            outcome.through,
            Some(2),
            "a withdrawal inherits the run's declared selection"
        );

        let row = ledger_row(&root, "withdraw-arc", "step-1");
        assert_eq!(row.status, "withdrawn");
        assert_eq!(row.commit, None, "no round was made, so none is recorded");

        // The log carries the step's title, the grammar a start writes, since
        // there is no sha to name.
        let log_path = tugtool_core::project_state_dir(&root).join(tugtool_core::paths::ARC_LOG);
        let log = fs::read_to_string(&log_path).unwrap();
        assert!(
            log.lines()
                .any(|l| l.contains("step-withdrawn") && l.contains("1/2 Step 1:")),
            "{log}"
        );
        assert_eq!(
            crate::log::read_declarations(&root, "withdraw-arc").latest,
            Some(crate::log::ArcDeclaration::Step {
                current: 1,
                total: 2
            })
        );
    }

    #[serial]
    #[test]
    fn step_withdraw_refuses_a_done_row() {
        let (_temp, root) = stepped_arc("withdraw-done-arc");
        step_start("withdraw-done-arc", 1, 2).unwrap();
        step_done("withdraw-done-arc", 1, None).unwrap();
        let before = fs::read_to_string(plan_file(&root, "withdraw-done-arc")).unwrap();

        let err = step_withdraw("withdraw-done-arc", 1)
            .unwrap_err()
            .to_string();
        assert!(err.contains("is 'done'"), "{err}");
        assert!(err.contains("#step-1"), "{err}");
        assert!(err.contains("plan.md"), "the refusal names the plan: {err}");

        let after = fs::read_to_string(plan_file(&root, "withdraw-done-arc")).unwrap();
        assert_eq!(after, before, "a refusal moves no byte of the plan");
    }

    #[serial]
    #[test]
    fn a_withdrawn_step_can_be_taken_up_again() {
        let (_temp, root) = stepped_arc("reopen-arc");
        step_withdraw("reopen-arc", 1).unwrap();
        step_start("reopen-arc", 1, 2).expect("changing your mind needs no hand-edit");
        assert_eq!(
            ledger_row(&root, "reopen-arc", "step-1").status,
            "in progress"
        );
    }

    /// The wedge [P02] exists to prevent: a run whose final selected step is
    /// withdrawn is finished, and so joinable.
    #[serial]
    #[test]
    fn withdrawing_the_final_selected_step_completes_the_run() {
        let (_temp, root) = stepped_arc("armed-arc");
        step_start("armed-arc", 1, 2).unwrap();
        step_done("armed-arc", 1, None).unwrap();
        step_withdraw("armed-arc", 2).unwrap();

        let found = crate::log::read_declarations(&root, "armed-arc");
        assert!(found.run_complete, "the declared selection is finished");
        assert!(!found.step_in_flight);
    }

    /// Two writers of one document at once — the arc runner and the CLI —
    /// each succeed, the document is exactly one writer's whole text, and no
    /// temp file is left behind. With one shared temp name the loser's rename
    /// found its temp already moved, or moved the winner's partial bytes.
    #[test]
    fn concurrent_atomic_writes_leave_one_whole_document() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("plan.md");
        // Large enough that a write is not one syscall, so the two overlap.
        let texts = ["a".repeat(1 << 20), "b".repeat(1 << 20)];
        for round in 0..20 {
            let barrier = std::sync::Barrier::new(2);
            let results: Vec<Result<(), ArcError>> = std::thread::scope(|scope| {
                let handles: Vec<_> = texts
                    .iter()
                    .map(|text| {
                        let (barrier, path) = (&barrier, &path);
                        scope.spawn(move || {
                            barrier.wait();
                            write_atomic(path, text)
                        })
                    })
                    .collect();
                handles.into_iter().map(|h| h.join().unwrap()).collect()
            });
            for result in &results {
                assert!(result.is_ok(), "round {round}: {result:?}");
            }
            let landed = fs::read_to_string(&path).unwrap();
            assert!(
                texts.contains(&landed),
                "round {round}: the document is a splice of {} bytes",
                landed.len()
            );
            let entries: Vec<String> = fs::read_dir(dir.path())
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            assert_eq!(entries, vec!["plan.md".to_string()], "round {round}");
        }
    }

    /// A rewrite keeps the document's mode; the temp file's owner-only mode
    /// never reaches it.
    #[test]
    fn atomic_write_keeps_the_documents_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("plan.md");
        write_atomic(&path, "first").unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o644
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        write_atomic(&path, "second").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }

    /// The doctor end to end over a real arc: a table moved by hand is
    /// detected, an ordinary `arc status` says so rather than answering from
    /// one side, and `--repair` appends the declaration that reconciles it.
    #[serial]
    #[test]
    fn the_doctor_finds_a_hand_moved_table_and_status_says_so() {
        let (_temp, root) = stepped_arc("doctor-arc");

        // A healthy arc is quiet, and so is its status.
        assert!(crate::doctor::diagnose(&root, "doctor-arc").healthy());
        assert!(
            status_in(&root, "doctor-arc")
                .unwrap()
                .disagreements
                .is_empty()
        );

        // Now the hand-edit — or the crash between the two writes, which
        // leaves exactly this.
        let plan = plan_file(&root, "doctor-arc");
        let source = fs::read_to_string(&plan).unwrap();
        let moved =
            tugtool_core::plan::set_ledger_status(&source, "step-2", "in progress", None).unwrap();
        fs::write(&plan, &moved).unwrap();

        let diagnosis = crate::doctor::diagnose(&root, "doctor-arc");
        assert_eq!(
            diagnosis
                .findings
                .iter()
                .map(|f| f.code.as_str())
                .collect::<Vec<_>>(),
            ["undeclared-open-row"]
        );

        // An ordinary status call carries the sentence, which is the point:
        // nobody has to know to run the doctor to find out.
        let status = status_in(&root, "doctor-arc").unwrap();
        assert_eq!(status.disagreements.len(), 1);
        assert!(
            status.disagreements[0].contains("step 2"),
            "{:?}",
            status.disagreements
        );

        // Repair appends, never rewrites, and the log's own reading moves.
        let before = log_text(&root);
        let outcome = crate::doctor::doctor(&root, "doctor-arc", true).unwrap();
        assert_eq!(outcome.appended.len(), 1);
        assert_eq!(outcome.left_for_a_person, 0);
        let after = log_text(&root);
        assert!(
            after.starts_with(&before),
            "the arc log is append-only; a repair may only add to it"
        );
        assert!(
            after.contains("step-start  2/2 Step 2: The second step (reconciled by arc doctor)")
        );

        let decls = crate::log::read_declarations(&root, "doctor-arc");
        assert_eq!(decls.step, Some((2, 2)));
        assert!(decls.step_in_flight);
        assert!(crate::doctor::diagnose(&root, "doctor-arc").healthy());
        assert!(
            status_in(&root, "doctor-arc")
                .unwrap()
                .disagreements
                .is_empty()
        );
    }

    /// The audit's headline through the real verbs: a run the log says
    /// finished, over a table with an open row inside the selection. Named,
    /// and deliberately not repaired — which record is right is a judgment.
    #[serial]
    #[test]
    fn the_doctor_names_a_join_armed_over_an_open_row() {
        let (_temp, root) = stepped_arc("armed-arc");
        let worktree = worktree_path(&root, "armed-arc");

        step_start("armed-arc", 1, 2).unwrap();
        fs::write(worktree.join("one.txt"), "first\n").unwrap();
        commit("armed-arc", "r1", None).unwrap();
        step_done("armed-arc", 1, None).unwrap();
        step_start("armed-arc", 2, 2).unwrap();
        fs::write(worktree.join("two.txt"), "second\n").unwrap();
        commit("armed-arc", "r2", None).unwrap();
        step_done("armed-arc", 2, None).unwrap();
        assert!(arc_detail_entry_in(&root, "armed-arc").unwrap().join_ready);

        // Somebody walks step 2's row back by hand. The log still arms the
        // join; the table now resumes at 2. Those are the two families the
        // doctor exists to compare.
        let plan = plan_file(&root, "armed-arc");
        let source = fs::read_to_string(&plan).unwrap();
        let walked = tugtool_core::plan::reset_ledger_row(
            &tugtool_core::plan::reopen_ledger_row(&source, "step-2").unwrap(),
            "step-2",
        )
        .unwrap();
        fs::write(&plan, &walked).unwrap();

        let outcome = crate::doctor::doctor(&root, "armed-arc", true).unwrap();
        let codes: Vec<&str> = outcome
            .diagnosis
            .findings
            .iter()
            .map(|f| f.code.as_str())
            .collect();
        assert!(codes.contains(&"armed-over-open-rows"), "{codes:?}");
        assert!(
            outcome.appended.is_empty(),
            "a judgment call is never repaired silently"
        );
        assert!(outcome.left_for_a_person >= 1);
    }
}
