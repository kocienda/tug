//! Rounds and marks: `commit` and the worktree sweep, the commit trailers that cite
//! the arc and the session, and `mark`'s declarations.

use serde::Serialize;
use std::path::Path;

use super::documents::ledger_file;
use super::git::{LockAttempt, git_output, git_stdout, git_write, retry_past_index_lock};
use super::identity::{
    arc_base, arc_record_exists, branch_exists, branch_name, ensure_arc_id, reconcile_branches,
    worktree_path,
};
use super::listing::has_uncommitted;
use super::show::sessions_db_file;
use crate::error::ArcError;
use crate::log::{ArcRoundMeta, MarkStage, append_arc_log, append_mark_declaration};

/// Outcome of [`commit`].
#[derive(Debug, Clone, Serialize)]
pub struct CommitOutcome {
    pub committed: bool,
    pub commit_hash: Option<String>,
}

/// What a `arc mark` declared ([P09]).
#[derive(Debug, Clone, Serialize)]
pub struct MarkOutcome {
    #[serde(rename = "arc")]
    pub arc: String,
    /// The stage now declared — also the log marker that recorded it.
    pub stage: String,
    /// Ledger rows that are still open — neither `done` nor `withdrawn` —
    /// named by step number.
    ///
    /// A mark is a claim about the whole arc: `built` says the work is
    /// there, `audited` says it has been judged, and `audited` is what arms
    /// the join. Made over a ledger still full of `pending`, it is a claim
    /// about work nobody did — and the verb used to make it in silence, so
    /// the disagreement between the mark and the rows surfaced only when
    /// somebody read the plan.
    ///
    /// Reported, never enforced. Marking ahead of the rows is a real gesture
    /// (a withdrawn tail, a run that closed its steps out of band), and the
    /// verb's job is to say so, not to refuse.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub open_steps: Vec<u32>,
    /// Ledger rows in total, so `open_steps` reads as a fraction.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub total_steps: u32,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// Which ledger rows an arc still has open, and how many rows there are.
///
/// `(open, total)`. An arc with no ledger at all answers `(vec![], 0)`: there
/// is nothing to disagree with, which is different from agreeing.
fn open_ledger_steps(repo_root: &Path, name: &str) -> (Vec<u32>, u32) {
    let Some(path) = ledger_file(repo_root, name) else {
        return (Vec::new(), 0);
    };
    let Ok(source) = std::fs::read_to_string(&path) else {
        return (Vec::new(), 0);
    };
    let Ok(doc) = tugtool_core::plan::parse(&source) else {
        return (Vec::new(), 0);
    };
    let total = doc.ledger_rows.len() as u32;
    let open = doc
        .ledger_rows
        .iter()
        .filter(|row| !matches!(row.status.as_str(), "done" | "withdrawn"))
        .filter_map(|row| row.anchor.strip_prefix("step-")?.parse::<u32>().ok())
        .collect();
    (open, total)
}

/// Declare a lifecycle stage git cannot see ([P09]).
///
/// The vocabulary is closed to `built` and `audited`, and the whole action is
/// one arc log line: nothing else on disk changes, so a mark is safe from a
/// skill that is otherwise forbidden to write.
pub(crate) fn mark_in(
    repo_root: &Path,
    name: &str,
    stage: MarkStage,
    note: Option<&str>,
) -> Result<MarkOutcome, ArcError> {
    if !arc_record_exists(repo_root, name) {
        return Err(ArcError::NotFound {
            name: name.to_string(),
        });
    }
    append_mark_declaration(repo_root, name, stage, note.unwrap_or_default())
        .map_err(|e| ArcError::arc_log(repo_root, e))?;
    let (open_steps, total_steps) = open_ledger_steps(repo_root, name);
    Ok(MarkOutcome {
        arc: name.to_string(),
        stage: stage.marker().to_string(),
        open_steps,
        total_steps,
    })
}

/// Commit the arc worktree (if dirty) and append an arc log line. `round_meta`
/// carries the verbatim instruction (git's one gap) + a richer summary; the CLI
/// reads it from stdin.
pub(crate) fn commit_in(
    repo_root: &Path,
    name: &str,
    message: &str,
    round_meta: Option<ArcRoundMeta>,
) -> Result<CommitOutcome, ArcError> {
    reconcile_branches(repo_root, &mut Vec::new());
    let branch = branch_name(name);
    let worktree = worktree_path(repo_root, name);

    if !branch_exists(repo_root, &branch) || !worktree.exists() {
        return Err(ArcError::Refused(format!(
            "Arc not found or not active: {}",
            name
        )));
    }

    // A round is a write-path touch, so an arc created by an older build
    // backfills its creation id here ([P02]).
    let _ = ensure_arc_id(repo_root, name);

    // `--message` is the conventional-commit subject; a longer `summary`
    // (if any) enriches the body. Byte-safe: no slicing on a char boundary.
    let summary = round_meta
        .as_ref()
        .and_then(|m| m.summary.as_deref())
        .unwrap_or("");
    let commit_message = if summary.is_empty() || summary == message {
        message.to_string()
    } else {
        format!("{}\n\n{}", message, summary)
    };
    // Machine-parseable trailers ([P08], Spec S02): `Tug-Session:` when the
    // committing session resolves + `Tug-Dash: <branch> onto <base>`.
    // A round commit runs inside the session that made it, so the env answers.
    let commit_message = with_arc_trailers(repo_root, name, &branch, &commit_message, None);

    // Stage and commit, re-attempting past a held `index.lock` (Spec S02) —
    // the join's preflight sweep commits into this same worktree, and
    // whichever writer lost the race used to die outright.
    let commit_hash = retry_past_index_lock(|| {
        if let LockAttempt::Blocked(e) = git_write(&worktree, &["add", "-A"], "git add failed")? {
            return Ok(LockAttempt::Blocked(e));
        }

        // Anything staged? Re-asked on every attempt, which is what makes a
        // concurrent sweep a graceful outcome rather than an error: it took
        // these changes, so this round has nothing left to commit and reports
        // `committed: false` — already a legal outcome for a clean worktree.
        let diff = git_output(&worktree, &["diff", "--cached", "--quiet"])?;
        let has_changes = !diff.status.success(); // exits 1 when there are changes
        if !has_changes {
            return Ok(LockAttempt::Done(None));
        }

        if let LockAttempt::Blocked(e) = git_write(
            &worktree,
            &["commit", "-m", &commit_message],
            "git commit failed",
        )? {
            return Ok(LockAttempt::Blocked(e));
        }
        Ok(LockAttempt::Done(Some(git_stdout(
            &worktree,
            &["rev-parse", "--short", "HEAD"],
        )?)))
    })?;
    let has_changes = commit_hash.is_some();

    // Append an arc log line ([P04]): the verbatim instruction is git's one gap.
    let instruction = round_meta
        .as_ref()
        .and_then(|m| m.instruction.as_deref())
        .unwrap_or("");
    let marker = commit_hash.as_deref().unwrap_or("-");
    append_arc_log(repo_root, name, marker, instruction)
        .map_err(|e| ArcError::arc_log(repo_root, e))?;

    Ok(CommitOutcome {
        committed: has_changes,
        commit_hash,
    })
}

/// The committing session's identity for the commit trailers: the human
/// citation and the machine id ([P10], Spec S03).
///
/// **Who is asked first is the caller's, not the environment's.** A round
/// commit is made by `tugtool arc commit` running *inside* the Claude session,
/// where tugcast exports `TUG_SESSION_ID`, and the env is the whole answer. A
/// **join** is not: the card's press is served by tugcast itself, a process
/// that belongs to no session and exports no such variable — so every join
/// commit ever made carried the arc trailer alone and the History row showed
/// one pill where the work had two. The request already names the pressing
/// card, so the id travels as an argument and the env is the fallback for the
/// callers that have none.
///
/// `None` when it can't be resolved — no id from either source, no
/// `sessions.db`, or no row for that id. Any absence omits both trailers
/// silently: a commit never fails on trailer resolution.
///
/// The citation grammar lives in `tugchanges_core::session_citation`, shared
/// with the deck-commit lane so the two can never drift.
pub(crate) fn session_citation_for(session_id: Option<&str>) -> Option<(String, String)> {
    let session_id = match session_id {
        Some(id) if !id.is_empty() => id.to_string(),
        _ => std::env::var("TUG_SESSION_ID")
            .ok()
            .filter(|s| !s.is_empty())?,
    };
    let db = sessions_db_file()?;
    let conn =
        rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
    // No row → `query_row` errors → `.ok()?` omits the trailers.
    // The citation names the **line** ([P13]): its callsign, and its eight
    // characters inside the parentheses, so a citation written from inside an
    // arc stage resolves to the conversation rather than to the segment that
    // happened to be seated. `Tug-Session-Id` beside it still pins the exact
    // transcript.
    let (tag, line_id): (String, String) = conn
        .query_row(
            "SELECT l.tag, l.line_id FROM sessions s
             JOIN lines l ON l.line_id = s.line_id
             WHERE s.session_id = ?1",
            rusqlite::params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()?;
    let citation = tugchanges_core::session_citation(Some(&tag), &line_id);
    Some((citation, session_id))
}

/// Append the session trailers (when resolvable) + `Tug-Arc: <branch> onto
/// <base>` to an arc round-commit or join/squash message ([P08]/[P10], Spec
/// S02/S03). `base` comes from the arc's recorded base branch — the same
/// source `show()` / join use. Idempotent via `append_trailers`, so a draft
/// that already carries a trailer is never duplicated.
///
/// `session` is the id the caller knows, if any — see
/// [`session_citation_for`]; `None` falls back to the process's own.
///
/// The session travels as a **pair**: `Tug-Session` is the human citation and
/// `Tug-Session-Id` the full uuid a reader joins against the ledger. Neither
/// is displayed as body ink — tugcast parses both into typed fields and strips
/// the lines.
pub(super) fn with_arc_trailers(
    repo: &Path,
    name: &str,
    branch: &str,
    message: &str,
    session: Option<&str>,
) -> String {
    let arc_value = match arc_base(repo, name) {
        Ok(base) if !base.is_empty() => format!("{branch} onto {base}"),
        _ => branch.to_string(),
    };
    let session = session_citation_for(session);
    let mut trailers: Vec<(&str, &str)> = Vec::new();
    if let Some((citation, id)) = session.as_ref() {
        trailers.push(("Tug-Session", citation.as_str()));
        trailers.push(("Tug-Session-Id", id.as_str()));
    }
    trailers.push(("Tug-Arc", arc_value.as_str()));
    tugchanges_core::append_trailers(message, &trailers)
}

/// Auto-commit any outstanding changes in the arc worktree — FATAL on error
/// ([P14]). A no-op when the worktree is absent or clean. Shared by `join_in`
/// (before integrating) and the resolution ladder (before computing a candidate
/// against the branch tip) so the tip always reflects the arc's real state.
pub(crate) fn commit_worktree_dirt(worktree: &Path, name: &str) -> Result<(), ArcError> {
    if !worktree.exists() {
        return Ok(());
    }
    // The subject speaks in the same scope-colon voice the engine's own arc
    // commits wear, so `tug log` on the branch reads as one voice wherever
    // this commit does surface. The trailer is what keeps it from being
    // *counted* as a round: the two are separate jobs, and both are needed.
    let message = tugchanges_core::append_trailers(
        &format!("tugarc({name}): commit outstanding changes"),
        &[(SWEEP_TRAILER_KEY, "1")],
    );
    retry_past_index_lock(|| {
        // Re-read the status on every attempt, not once before the loop. This
        // is what makes losing the race a graceful yield rather than an error:
        // if the other writer swept the dirt while we waited, there is nothing
        // left to commit, and the act this call exists to produce has already
        // happened ([L31] — the act, not a swallowed failure).
        if !has_uncommitted(worktree)? {
            return Ok(LockAttempt::Done(()));
        }
        if let LockAttempt::Blocked(e) = git_write(
            worktree,
            &["add", "-A"],
            "join: git add in the arc worktree failed",
        )? {
            return Ok(LockAttempt::Blocked(e));
        }
        if let LockAttempt::Blocked(e) = git_write(
            worktree,
            &["commit", "-m", &message],
            "join: auto-commit in the arc worktree failed",
        )? {
            return Ok(LockAttempt::Blocked(e));
        }
        Ok(LockAttempt::Done(()))
    })
}

/// The trailer that marks a commit as the join's preflight sweep rather
/// than authored work (Spec S03).
///
/// Written at exactly one site — [`commit_worktree_dirt`] — and read as an
/// exact key match, never as a subject-string pattern. A trailer is a fact the
/// commit carries; a subject is prose, and prose that a rename or a user's own
/// commit could collide with is not an identity.
pub(super) const SWEEP_TRAILER_KEY: &str = "Tug-Sweep";

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // set_current_dir is needed for tests with isolated temp dirs
mod tests {
    use super::*;
    use crate::ops::test_support::*;
    use crate::ops::*;
    use serial_test::serial;
    use std::fs;
    use tempfile::TempDir;

    // -----------------------------------------------------------------------
    // index.lock contention (Spec S02)
    //
    // The race is real and symmetric: the join's preflight sweep and a
    // live `tugtool arc commit` both commit the same worktree's dirt at the
    // same moment, and the loser used to die on `index.lock: File exists`.
    // These hold the lock deterministically and release it from a helper
    // thread — racing two real processes would be flake by construction.
    // -----------------------------------------------------------------------

    #[test]
    fn commit_worktree_dirt_survives_a_lock_released_mid_call() {
        let temp = TempDir::new().unwrap();
        let repo = dirty_repo(&temp);
        let before = head_sha(&repo);
        let releaser = hold_index_lock(&repo, std::time::Duration::from_millis(300));
        commit_worktree_dirt(&repo, "sweeper").expect("the sweep waits out a transient lock");
        releaser.join().unwrap();
        assert_ne!(head_sha(&repo), before, "the dirt was committed");
    }

    /// The losing side's outcome, asserted without racing anything.
    ///
    /// The other writer having already taken the dirt is the *state* a loser
    /// wakes up to, so the test produces that state directly instead of
    /// starting a second writer and hoping the interleaving lands. Two live
    /// writers is flake by construction: git reports contention with more than
    /// one message, and one of them is not the `index.lock` this retries on.
    #[test]
    fn commit_worktree_dirt_yields_when_the_other_writer_took_the_dirt() {
        let temp = TempDir::new().unwrap();
        let repo = dirty_repo(&temp);
        tugcore::git_command()
            .arg("-C")
            .arg(&repo)
            .args(["add", "-A"])
            .output()
            .unwrap();
        tugcore::git_command()
            .arg("-C")
            .arg(&repo)
            .args(["commit", "-q", "-m", "the other writer got there first"])
            .output()
            .unwrap();

        commit_worktree_dirt(&repo, "sweeper").expect("losing the race is not an error");

        let subject = tugcore::git_command()
            .arg("-C")
            .arg(&repo)
            .args(["log", "-1", "--format=%s"])
            .output()
            .unwrap();
        // The yield is a no-op: nothing stacked on top of the winner's commit,
        // because the status re-read found the worktree already clean.
        assert_eq!(
            String::from_utf8_lossy(&subject.stdout).trim(),
            "the other writer got there first"
        );
    }

    #[test]
    fn commit_worktree_dirt_surfaces_a_lock_that_never_clears() {
        let temp = TempDir::new().unwrap();
        let repo = dirty_repo(&temp);
        fs::write(index_lock_path(&repo), b"").unwrap();
        let err = commit_worktree_dirt(&repo, "sweeper")
            .expect_err("a stuck lock is an error")
            .to_string();
        // Verbatim: the retry must not cost the reader the one word that says
        // what happened.
        assert!(err.contains("index.lock"), "error was: {err}");
    }

    #[serial]
    #[test]
    fn arc_commit_survives_a_lock_released_mid_call() {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        create("locked", None, false, None).unwrap();
        let worktree = worktree_path(&repo, "locked");
        fs::write(worktree.join("round.txt"), "work\n").unwrap();
        let releaser = hold_index_lock(&worktree, std::time::Duration::from_millis(300));
        let outcome = commit("locked", "tugarc(locked): a round", None)
            .expect("the round waits out a transient lock");
        releaser.join().unwrap();
        assert!(outcome.committed, "the round landed");
    }

    /// The round's side of the same yield, produced directly for the same
    /// reason: the sweep having already taken the changes is a state, not a
    /// timing.
    #[serial]
    #[test]
    fn arc_commit_reports_uncommitted_when_a_sweep_took_its_changes() {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        create("swept", None, false, None).unwrap();
        let worktree = worktree_path(&repo, "swept");
        fs::write(worktree.join("round.txt"), "work\n").unwrap();
        commit_worktree_dirt(&worktree, "swept").unwrap();

        let outcome = commit("swept", "tugarc(swept): a round", None)
            .expect("losing the race is not an error");
        // The sweep committed these bytes, so the round has nothing of its own
        // left — the same outcome a clean worktree has always produced.
        assert!(!outcome.committed);
        assert!(outcome.commit_hash.is_none());
    }

    #[serial]
    #[test]
    fn the_sweep_wears_the_round_voice_and_marks_itself() {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        create("voiced", None, false, None).unwrap();
        let worktree = worktree_path(&repo, "voiced");
        fs::write(worktree.join("dirt.txt"), "x\n").unwrap();
        commit_worktree_dirt(&worktree, "voiced").unwrap();

        let message = tugcore::git_command()
            .arg("-C")
            .arg(&worktree)
            .args(["log", "-1", "--format=%B"])
            .output()
            .unwrap();
        let message = String::from_utf8_lossy(&message.stdout);
        assert!(
            message.starts_with("tugarc(voiced): commit outstanding changes"),
            "message was: {message}"
        );
        assert!(message.contains("Tug-Sweep: 1"), "message was: {message}");
    }

    /// `mark` says when it is claiming more than the ledger does.
    ///
    /// `audited` arms the join, so making it over a table of `pending` rows is
    /// a claim about work nobody recorded doing. Reported, never refused —
    /// marking ahead of the rows is a real gesture.
    #[serial]
    #[test]
    fn mark_reports_the_ledger_rows_still_open() {
        let (_temp, root) = stepped_arc("open-rows-arc");

        let marked = mark("open-rows-arc", MarkStage::Audited, None).unwrap();
        assert_eq!(marked.total_steps, 2);
        assert_eq!(
            marked.open_steps,
            vec![1, 2],
            "a plan nobody has walked is two open rows, and the mark says so",
        );

        // Closing them empties the report; the mark and the ledger now agree.
        step_start("open-rows-arc", 1, 2).unwrap();
        step_done("open-rows-arc", 1, None).unwrap();
        step_start("open-rows-arc", 2, 2).unwrap();
        step_withdraw("open-rows-arc", 2).unwrap();

        let marked = mark("open-rows-arc", MarkStage::Audited, None).unwrap();
        assert!(
            marked.open_steps.is_empty(),
            "a withdrawn row is closed too: {:?}",
            marked.open_steps,
        );
        assert_eq!(marked.total_steps, 2);
        let _ = &root;
    }

    #[serial]
    #[test]
    fn mark_refuses_an_unknown_arc() {
        let (_temp, _root) = stepped_arc("known-arc");
        let err = mark("no-such-arc", MarkStage::Built, None)
            .unwrap_err()
            .to_string();
        assert!(err.contains("Arc not found"), "{err}");
    }

    /// An arc whose branch does not exist yet is still an arc: the durable
    /// record is the `tugid`, and an arc binds — and can be marked — before
    /// any `tugarc/<name>` ref is cut. tugcast's binding gate learned this in
    /// W2; `mark` had been left behind refusing "Arc not found" at exactly
    /// the moment an arc most needs to declare something.
    #[serial]
    #[test]
    fn mark_accepts_a_arc_whose_record_is_only_its_tugid() {
        let (_temp, root) = stepped_arc("pre-branch-arc");

        // Cut the branch away, leaving the config entry a teardown would have
        // removed with it — `update-ref -d` rather than `branch -D`, because
        // the latter takes the whole `branch.<name>.*` config section, `tugid`
        // and all. This is the pre-branch arc's shape: an id, and no ref yet.
        run_git(
            &root,
            &[
                "update-ref",
                "-d",
                &format!("refs/heads/{}", branch_name("pre-branch-arc")),
            ],
        );
        assert!(!branch_exists(&root, &branch_name("pre-branch-arc")));
        assert!(arc_record_exists(&root, "pre-branch-arc"));

        let marked = mark("pre-branch-arc", MarkStage::Built, None)
            .expect("a pre-branch arc may declare that it built");
        assert_eq!(marked.stage, "built");
        assert_eq!(
            crate::log::read_declarations(&root, "pre-branch-arc").latest,
            Some(crate::log::ArcDeclaration::Built)
        );

        // And a name the repo has no record of at all still refuses.
        assert!(!arc_record_exists(&root, "never-existed"));
    }

    #[serial]
    #[test]
    fn test_arc_commit_with_changes_writes_log() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        create("test-arc", Some("Test".to_string()), false, None).unwrap();

        let worktree = repo.join(".tug/worktrees/test-arc");
        fs::write(worktree.join("test.txt"), "content\n").unwrap();

        let result = commit("test-arc", "Add test file", None);
        assert!(result.unwrap().committed);

        // A new commit landed on the arc branch.
        let count = tugcore::git_command()
            .arg("-C")
            .arg(repo)
            .args(["rev-list", "--count", "main..tugarc/test-arc"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&count.stdout).trim(), "1");

        // The arc log got a line naming the arc.
        let log = fs::read_to_string(arc_log_path(&home, repo)).unwrap();
        assert!(
            log.contains("test-arc"),
            "arc log should record the commit: {log}"
        );
    }

    #[serial]
    #[test]
    fn test_arc_commit_no_changes() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        create("test-arc", Some("Test".to_string()), false, None).unwrap();

        let result = commit("test-arc", "No changes", None);
        assert!(!result.unwrap().committed);

        // No commit ahead of base.
        let count = tugcore::git_command()
            .arg("-C")
            .arg(repo)
            .args(["rev-list", "--count", "main..tugarc/test-arc"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&count.stdout).trim(), "0");
    }

    #[serial]
    #[test]
    fn test_arc_commit_multibyte_summary_does_not_panic() {
        // A multibyte summary longer than 72 bytes must not panic on a byte
        // slice, and `--message` must remain the commit subject.
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        redirect_state_dir(&temp.path().join("state"));
        std::env::set_current_dir(repo).unwrap();

        create("test-arc", None, false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/test-arc");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();

        // A long multibyte summary that straddles byte 72 (100 bytes, 50 chars).
        let meta = ArcRoundMeta {
            instruction: Some("i".to_string()),
            summary: Some("é".repeat(50)),
        };
        commit("test-arc", "feat: thing", Some(meta)).unwrap();

        // The subject is the --message; the summary rode into the body.
        let subject = tugcore::git_command()
            .arg("-C")
            .arg(repo)
            .args(["log", "-1", "--format=%s", "tugarc/test-arc"])
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&subject.stdout).trim(),
            "feat: thing"
        );
    }

    #[serial]
    #[test]
    fn test_arc_commit_round_meta_writes_instruction() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        std::env::set_current_dir(repo).unwrap();
        redirect_state_dir(&home);

        create("test-arc", Some("Test".to_string()), false, None).unwrap();

        let worktree = repo.join(".tug/worktrees/test-arc");
        fs::write(worktree.join("test.txt"), "test\n").unwrap();

        // The verbatim instruction is git's one gap — it must reach the arc log.
        let meta = ArcRoundMeta {
            instruction: Some("add test file".to_string()),
            summary: Some("Added test file".to_string()),
        };
        commit("test-arc", "Test commit", Some(meta)).unwrap();

        let log = fs::read_to_string(arc_log_path(&home, repo)).unwrap();
        assert!(
            log.contains("add test file"),
            "log should carry the instruction: {log}"
        );
    }

    /// A round commit made from inside an arc stage cites the **line**, not
    /// the segment ([P13]): the line's callsign, the line's eight characters
    /// inside the parentheses, and the segment's own uuid in
    /// `Tug-Session-Id`, which is what pins the transcript the commit was
    /// made in.
    #[serial]
    #[test]
    fn a_round_commit_from_a_stage_cites_the_line() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        // A line of two segments: the root, and the stage a rotation seated.
        // The commit is made from the stage.
        let line_id = "7f3d2c18-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
        let stage = "aa11bb22-cc33-4d44-8e55-ff6677889900";
        let sessions_db = temp.path().join("sessions.db");
        {
            let conn = rusqlite::Connection::open(&sessions_db).unwrap();
            conn.execute_batch(
                "CREATE TABLE lines (
                    line_id       TEXT PRIMARY KEY,
                    tag           TEXT NOT NULL UNIQUE,
                    name          TEXT,
                    name_user_set INTEGER NOT NULL DEFAULT 0,
                    card_id       TEXT,
                    project_dir   TEXT NOT NULL,
                    created_at    INTEGER NOT NULL,
                    last_used_at  INTEGER NOT NULL
                 );
                 CREATE TABLE sessions (
                    session_id   TEXT PRIMARY KEY,
                    line_id      TEXT NOT NULL
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO lines (line_id, tag, name, name_user_set, card_id,
                                    project_dir, created_at, last_used_at)
                 VALUES (?1, 'heroic-mule', 'arc+join-xp', 1, 'card-1', '/proj', 1, 1)",
                rusqlite::params![line_id],
            )
            .unwrap();
            for segment in ["5b4b5867-1111-4222-8333-444455556666", stage] {
                conn.execute(
                    "INSERT INTO sessions (session_id, line_id) VALUES (?1, ?2)",
                    rusqlite::params![segment, line_id],
                )
                .unwrap();
            }
        }
        // SAFETY: serial test; see redirect_state_dir.
        unsafe {
            std::env::set_var(tugcore::instance::ENV_SESSIONS_DB, &sessions_db);
            std::env::set_var("TUG_SESSION_ID", stage);
        }

        create("cite-arc", Some("Test".to_string()), false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/cite-arc");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();
        commit("cite-arc", "Add f", None).unwrap();

        let round = tugcore::git_command()
            .arg("-C")
            .arg(&worktree)
            .args(["log", "-1", "--format=%B"])
            .output()
            .unwrap();
        let round = String::from_utf8_lossy(&round.stdout);

        // SAFETY: serial test; see redirect_state_dir.
        unsafe {
            std::env::remove_var(tugcore::instance::ENV_SESSIONS_DB);
            std::env::remove_var("TUG_SESSION_ID");
        }

        assert!(
            round.contains("Tug-Session: heroic-mule (7f3d2c18)"),
            "the citation is the line's callsign and the line's short id: {round}"
        );
        assert!(
            round.contains(&format!("Tug-Session-Id: {stage}")),
            "the machine id pins the segment the commit was made in: {round}"
        );
    }

    #[serial]
    #[test]
    fn test_arc_commits_carry_arc_trailer() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        redirect_state_dir(&home);
        std::env::set_current_dir(repo).unwrap();

        create("trailer-arc", Some("Test".to_string()), false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/trailer-arc");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();
        commit("trailer-arc", "Add f", None).unwrap();

        let round = tugcore::git_command()
            .arg("-C")
            .arg(&worktree)
            .args(["log", "-1", "--format=%B"])
            .output()
            .unwrap();
        let round = String::from_utf8_lossy(&round.stdout);
        assert!(
            round.contains("Tug-Arc: tugarc/trailer-arc onto "),
            "round commit carries Tug-Arc: {round}"
        );
        // Only assert absence when the environment genuinely lacks the id, so
        // the test never flakes on a runner that happens to export it. Both
        // keys travel together — neither lands without the other.
        if std::env::var("TUG_SESSION_ID").is_err() {
            assert!(
                !round.contains("Tug-Session:"),
                "no session env → no Tug-Session: {round}"
            );
            assert!(
                !round.contains("Tug-Session-Id:"),
                "no session env → no Tug-Session-Id: {round}"
            );
        }

        join(
            "trailer-arc",
            JoinOptions {
                message: Some("Land it".to_string()),
                ..mechanics()
            },
        )
        .unwrap();
        let squash = tugcore::git_command()
            .arg("-C")
            .arg(repo)
            .args(["log", "-1", "--format=%B"])
            .output()
            .unwrap();
        let squash = String::from_utf8_lossy(&squash.stdout);
        assert!(
            squash.contains("tugarc(trailer-arc):"),
            "squash subject stays tugarc(<name>): {squash}"
        );
        assert!(
            squash.contains("Tug-Arc: tugarc/trailer-arc onto "),
            "squash commit carries Tug-Arc: {squash}"
        );
    }

    // -----------------------------------------------------------------------
    // The hostile-filename fixture [B05] — the arc's own round trip
    // -----------------------------------------------------------------------

    /// An arc round carrying files git considers unusual reports them by their
    /// **real names**, through the listings every arc surface reads.
    ///
    /// The arc's rounds commit with `add -A`, so the round itself lands today;
    /// what does not is every *listing* around it — `worktree_dirt` reads
    /// `diff --name-only HEAD`, the dirt census reads `ls-files --others`, and
    /// both hand back git's C-quoted display form ([F01]). These are the sites
    /// that move a user's work: a join preflight that cannot name what is dirty
    /// is a join that sweeps or refuses on a path nobody has.
    ///
    /// RED until step 5 moves `tugarc-core` onto the [B01] door.
    #[serial]
    #[test]
    fn an_arc_round_names_its_hostile_files_by_their_real_names() {
        let temp = TempDir::new().unwrap();
        let repo = repo_beside_state(&temp);
        create("hostile", None, false, None).unwrap();
        let worktree = worktree_path(&repo, "hostile");

        // Git's own spelling of the roster: verbatim, except the decomposed
        // name, which git precomposes where the platform precomposes at all
        // (measured in `tugcore::hostile_repo`).
        let mut want = tugcore::hostile_repo::hostile_paths_as_git_reports_them();
        want.sort();

        // A round that brings them in.
        tugcore::hostile_repo::write_hostile_files(&worktree).expect("the fixture writes");
        let outcome = commit("hostile", "tugarc(hostile): add the records", None).unwrap();
        assert!(outcome.committed, "the round carried the files");
        assert!(
            worktree_dirt(&repo, "hostile").is_empty(),
            "the round left nothing behind"
        );

        // A round that changes them: now every one is dirty, and the arc has
        // to be able to say which.
        for name in tugcore::hostile_repo::HOSTILE_NAMES {
            let path = worktree.join(name.path);
            let body = fs::read_to_string(&path).unwrap();
            fs::write(&path, format!("{body}more\n")).unwrap();
        }

        let mut dirt = worktree_dirt(&repo, "hostile");
        dirt.sort();
        assert_eq!(dirt, want, "the arc names every dirty file as it really is");

        // And a second round takes them all, leaving the worktree clean.
        let outcome = commit("hostile", "tugarc(hostile): revise the records", None).unwrap();
        assert!(outcome.committed);
        assert!(worktree_dirt(&repo, "hostile").is_empty());
    }
}
