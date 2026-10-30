//! Rounds and marks: `commit` and the worktree sweep, the commit trailers that cite
//! the arc and the session, and `mark`'s declarations.

use serde::Serialize;
use std::path::Path;
use std::process::Command;
use tugcore::instance::Paths;
use tugtool_core::config::{Config, Surface};

use super::documents::ledger_file;
use super::git::{LockAttempt, git_output, git_stdout, git_write, retry_past_index_lock};
use super::identity::{
    arc_base, arc_record_exists, branch_exists, branch_name, ensure_arc_id, reconcile_branches,
    worktree_path,
};
use super::listing::{dirty_tracked_paths, has_uncommitted, untracked_paths};
use super::show::sessions_db_file;
use crate::error::ArcError;
use crate::log::{
    ArcRoundMeta, AuditedPair, MarkStage, append_arc_log, append_mark_declaration, audited_note,
    is_yield_note,
};
use crate::surfaces::{claiming_surface, expand};

/// Outcome of [`commit_in`].
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
pub fn mark_in(
    paths: &Paths,
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
    let note = note.unwrap_or_default();
    // An audit is relative to the tree it read: the arc head and the base tip
    // it stood on when it marked. Both go into the mark, because readiness is
    // derived from whether they still stand. They are read live, and the last
    // `verified` line is cross-checked against them: a verify that ran at
    // another head or onto another base refuses the mark, because the mark
    // would otherwise vouch for a tree no verify saw. A generation that never
    // verified has nothing to cross-check. A tip that cannot be read writes
    // the mark pair-less, which reads stale.
    let note = match stage {
        MarkStage::Audited => {
            let branch = branch_name(name);
            let head = git_stdout(repo_root, &["rev-parse", &branch]).ok();
            let base = arc_base(repo_root, name)
                .ok()
                .and_then(|base| git_stdout(repo_root, &["rev-parse", &base]).ok());
            match (head, base) {
                (Some(head), Some(base)) => {
                    let pair = AuditedPair { head, base };
                    if let Some(refusal) = verified_elsewhere(paths, repo_root, name, &pair) {
                        return Err(ArcError::Refused(refusal));
                    }
                    audited_note(&pair, note)
                }
                _ => note.to_owned(),
            }
        }
        MarkStage::Built => note.to_owned(),
    };
    append_mark_declaration(paths, repo_root, name, stage, &note)
        .map_err(|e| ArcError::arc_log(paths, repo_root, e))?;
    let (open_steps, total_steps) = open_ledger_steps(repo_root, name);
    Ok(MarkOutcome {
        arc: name.to_string(),
        stage: stage.marker().to_string(),
        open_steps,
        total_steps,
    })
}

/// The sentence that refuses an `audited` mark over a tree the last verify did
/// not see, or `None` when the verify saw exactly `live` or nothing verified.
fn verified_elsewhere(
    paths: &Paths,
    repo_root: &Path,
    name: &str,
    live: &AuditedPair,
) -> Option<String> {
    let declarations = crate::log::read_declarations(paths, repo_root, name);
    let (head, base) = crate::log::parse_verified_note(declarations.last_verified.as_deref()?)?;
    let moved = match (head != live.head, base != live.base) {
        (false, false) => return None,
        (true, false) => "a round landed since",
        (false, true) => "the base moved since",
        (true, true) => "the head and the base both moved since",
    };
    let short = |sha: &str| sha.chars().take(9).collect::<String>();
    Some(format!(
        "Cannot mark '{name}' audited: the last verify ran at {} onto {}, and {moved} (now {} onto {}). Run `tugtool arc verify {name}` on this tree first.",
        short(&head),
        short(&base),
        short(&live.head),
        short(&live.base),
    ))
}

/// Commit the arc worktree (if dirty) and append an arc log line. `round_meta`
/// carries the verbatim instruction (git's one gap) + a richer summary; the CLI
/// reads it from stdin.
pub fn commit_in(
    paths: &Paths,
    repo_root: &Path,
    name: &str,
    message: &str,
    round_meta: Option<ArcRoundMeta>,
    session_id: Option<&str>,
) -> Result<CommitOutcome, ArcError> {
    reconcile_branches(paths, repo_root, &mut Vec::new());
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

    // The surfaces' commit checks run over the round's paths before anything
    // is staged, so a refusal leaves the worktree exactly as it found it. A
    // `yield:` round is committed unchecked: a stage yields mid-step precisely
    // when its work is unfinished, and refusing that commit over a half-written
    // type would strand the hand-off the wheel compacts on.
    let subject = message.lines().next().unwrap_or("").trim();
    if !is_yield_note(subject) {
        run_commit_checks(&worktree)?;
    }

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
    // A round commit runs inside the session that made it, whose id the
    // caller resolved.
    let commit_message =
        with_arc_trailers(paths, repo_root, name, &branch, &commit_message, session_id);

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
    append_arc_log(paths, repo_root, name, marker, instruction)
        .map_err(|e| ArcError::arc_log(paths, repo_root, e))?;
    // A `yield:` subject is the stage's mid-step hand-off ([B05]), and it is
    // written as an `arc-note` whether or not the round had bytes to commit:
    // a stage that yields on a clean tree still owes the wheel the line it
    // compacts on and the next session the task it resumes from.
    // The subject line alone: an arc-log note is one line.
    if is_yield_note(subject) {
        append_arc_log(paths, repo_root, name, "arc-note", subject)
            .map_err(|e| ArcError::arc_log(paths, repo_root, e))?;
    }

    Ok(CommitOutcome {
        committed: has_changes,
        commit_hash,
    })
}

/// How many trailing lines of a failed commit check's output the refusal carries.
const COMMIT_CHECK_TAIL_LINES: usize = 60;

/// Run every surface's `commit_check` over the round's paths it claims.
///
/// The round's paths are the worktree's dirty tracked and untracked files that
/// still exist (a deletion has nothing to check). Each is resolved to the
/// surface claiming it; a surface with a `commit_check` runs each command
/// through `sh -c` from the worktree root with `{paths}` expanded to the claimed
/// paths, narrowed by `commit_check_only` when it declares one. The first
/// non-zero exit refuses the commit, naming the command, the surface, the
/// status and the tail of the output.
///
/// A worktree with no `.tugtool/config.toml`, a config that does not load, no
/// surfaces, or no `commit_check` runs nothing: the commit path never refuses
/// over a config it would not otherwise read. A malformed config is `verify`'s
/// to refuse. Unclaimed paths are not a refusal here either — a round often
/// touches a file nobody has declared yet, and `verify` is where that is named.
pub(crate) fn run_commit_checks(worktree: &Path) -> Result<(), ArcError> {
    let mut touched: Vec<String> = Vec::new();
    for path in dirty_tracked_paths(worktree)
        .into_iter()
        .chain(untracked_paths(worktree))
    {
        if !touched.contains(&path) && worktree.join(&path).exists() {
            touched.push(path);
        }
    }
    if touched.is_empty() {
        return Ok(());
    }

    let Ok(config) = Config::load_from_project(worktree) else {
        return Ok(());
    };
    let surfaces = &config.tugtool.arc.surfaces;

    for surface in surfaces.iter().filter(|s| !s.commit_check.is_empty()) {
        let claimed: Vec<String> = touched
            .iter()
            .filter(|path| claiming_surface(surfaces, path).is_some_and(|s| s.name == surface.name))
            .filter(|path| commit_check_applies(surface, path))
            .cloned()
            .collect();
        if claimed.is_empty() {
            continue;
        }
        for command in &surface.commit_check {
            let expanded = expand(command, "HEAD", "HEAD", &claimed);
            let output = Command::new("sh")
                .arg("-c")
                .arg(&expanded)
                .current_dir(worktree)
                .stdin(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .output()
                .map_err(|e| {
                    ArcError::Refused(format!(
                        "commit check `{command}` (surface {}) could not run: {e}; the round is not committed",
                        surface.name
                    ))
                })?;
            if output.status.success() {
                continue;
            }
            let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
            combined.push_str(&String::from_utf8_lossy(&output.stderr));
            let lines: Vec<&str> = combined.lines().collect();
            let start = lines.len().saturating_sub(COMMIT_CHECK_TAIL_LINES);
            let tail = lines[start..].join("\n");
            let status = output
                .status
                .code()
                .map_or_else(|| "by signal".to_string(), |c| c.to_string());
            return Err(ArcError::Refused(format!(
                "commit check `{command}` (surface {}) exited {status}; the round is not committed\n{tail}",
                surface.name
            )));
        }
    }
    Ok(())
}

/// Whether a claimed path is one this surface's `commit_check` runs over: every
/// path when `commit_check_only` is empty, else one whose file name matches a
/// pattern.
fn commit_check_applies(surface: &Surface, path: &str) -> bool {
    if surface.commit_check_only.is_empty() {
        return true;
    }
    let file_name = path.rsplit('/').next().unwrap_or(path);
    surface
        .commit_check_only
        .iter()
        .any(|pattern| file_name_glob_matches(pattern, file_name))
}

/// A file-name glob with `*` as its one wildcard, matching any run of
/// characters: `*.ts` matches `a.ts` and `.ts`, not `a.tsx`.
fn file_name_glob_matches(pattern: &str, name: &str) -> bool {
    if !pattern.contains('*') {
        return pattern == name;
    }
    let mut parts = pattern.split('*');
    let first = parts.next().unwrap_or("");
    let Some(mut rest) = name.strip_prefix(first) else {
        return false;
    };
    let parts: Vec<&str> = parts.collect();
    let (last, middle) = parts
        .split_last()
        .expect("a pattern with `*` has a tail part");
    for part in middle {
        match rest.find(part) {
            Some(at) => rest = &rest[at + part.len()..],
            None => return false,
        }
    }
    rest.ends_with(last)
}

/// The committing session's identity for the commit trailers: the human
/// citation and the machine id ([P10], Spec S03).
///
/// **Who is asked first is the caller's, not the environment's.** A round
/// commit is made by `tugtool arc commit` running *inside* the Claude session,
/// where tugcast exports `TUG_SESSION_ID`, and the CLI reads it at its edge. A
/// **join** is not: the card's press is served by tugcast itself, a process
/// that belongs to no session and exports no such variable — so every join
/// commit ever made carried the arc trailer alone and the History row showed
/// one pill where the work had two. The request already names the pressing
/// card. Either way the id travels as an argument: this crate reads no
/// environment.
///
/// `None` when it can't be resolved — no id given, no
/// `sessions.db`, or no row for that id. Any absence omits both trailers
/// silently: a commit never fails on trailer resolution.
///
/// The citation grammar lives in `tugchanges_core::session_citation`, shared
/// with the deck-commit lane so the two can never drift.
pub(crate) fn session_citation_for(
    paths: &Paths,
    session_id: Option<&str>,
) -> Option<(String, String)> {
    let session_id = session_id.filter(|id| !id.is_empty())?.to_string();
    let db = sessions_db_file(paths)?;
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
/// [`session_citation_for`]; `None` writes no session trailers.
///
/// The session travels as a **pair**: `Tug-Session` is the human citation and
/// `Tug-Session-Id` the full uuid a reader joins against the ledger. Neither
/// is displayed as body ink — tugcast parses both into typed fields and strips
/// the lines.
pub(super) fn with_arc_trailers(
    paths: &Paths,
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
    let session = session_citation_for(paths, session);
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
mod tests {
    use super::*;
    use crate::ops::test_support::*;
    use crate::ops::*;
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
        git(&repo, &["add", "-A"]);
        git(
            &repo,
            &["commit", "-q", "-m", "the other writer got there first"],
        );

        commit_worktree_dirt(&repo, "sweeper").expect("losing the race is not an error");

        let subject = tugcore::test_fixtures::git::command()
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

    #[test]
    fn arc_commit_survives_a_lock_released_mid_call() {
        let temp = TempDir::new().unwrap();
        let (repo, paths) = repo_beside_state(&temp);
        create_in(&paths, &repo, "locked", None, false, None).unwrap();
        let worktree = worktree_path(&repo, "locked");
        fs::write(worktree.join("round.txt"), "work\n").unwrap();
        let releaser = hold_index_lock(&worktree, std::time::Duration::from_millis(300));
        let outcome = commit_in(
            &paths,
            &repo,
            "locked",
            "tugarc(locked): a round",
            None,
            None,
        )
        .expect("the round waits out a transient lock");
        releaser.join().unwrap();
        assert!(outcome.committed, "the round landed");
    }

    /// The round's side of the same yield, produced directly for the same
    /// reason: the sweep having already taken the changes is a state, not a
    /// timing.
    #[test]
    fn arc_commit_reports_uncommitted_when_a_sweep_took_its_changes() {
        let temp = TempDir::new().unwrap();
        let (repo, paths) = repo_beside_state(&temp);
        create_in(&paths, &repo, "swept", None, false, None).unwrap();
        let worktree = worktree_path(&repo, "swept");
        fs::write(worktree.join("round.txt"), "work\n").unwrap();
        commit_worktree_dirt(&worktree, "swept").unwrap();

        let outcome = commit_in(&paths, &repo, "swept", "tugarc(swept): a round", None, None)
            .expect("losing the race is not an error");
        // The sweep committed these bytes, so the round has nothing of its own
        // left — the same outcome a clean worktree has always produced.
        assert!(!outcome.committed);
        assert!(outcome.commit_hash.is_none());
    }

    // -----------------------------------------------------------------------
    // commit_check: a surface's declared check runs over the round's paths it
    // claims, before anything is staged.
    // -----------------------------------------------------------------------

    /// An arc over a base whose `.tugtool/config.toml` is `config`, so the
    /// worktree carries it too.
    fn arc_with_config(temp: &TempDir, name: &str, config: &str) -> (std::path::PathBuf, Paths) {
        let (repo, paths) = repo_beside_state(temp);
        fs::create_dir_all(repo.join(".tugtool")).unwrap();
        fs::write(repo.join(".tugtool/config.toml"), config).unwrap();
        commit_all(&repo, "declare the surfaces");
        create_in(&paths, &repo, name, None, false, None).unwrap();
        (repo, paths)
    }

    fn touch(worktree: &Path, path: &str) {
        let full = worktree.join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, "work\n").unwrap();
    }

    fn src_surface(commit_check: &str, only: &str) -> String {
        format!(
            "[[tugtool.arc.surface]]\nname = \"src\"\npaths = [\"src/\"]\ncheck = []\ncommit_check = [{commit_check}]\n{only}"
        )
    }

    const REFUSING: &str = "\"sh -c 'echo type error; exit 1'\"";

    #[test]
    fn commit_check_refuses_the_round_and_commits_nothing() {
        let temp = TempDir::new().unwrap();
        let (repo, paths) = arc_with_config(&temp, "checked", &src_surface(REFUSING, ""));
        let worktree = worktree_path(&repo, "checked");
        let before = head_sha(&worktree);
        touch(&worktree, "src/a.ts");

        let err = commit_in(
            &paths,
            &repo,
            "checked",
            "tugarc(checked): a round",
            None,
            None,
        )
        .expect_err("a failing check refuses the round")
        .to_string();
        assert!(
            err.contains("type error"),
            "the check's output is in the refusal: {err}"
        );
        assert!(err.contains("surface src"), "the surface is named: {err}");
        assert!(err.contains("exited 1"), "the status is named: {err}");
        assert_eq!(head_sha(&worktree), before, "nothing was committed");
        assert!(
            porcelain_of(&worktree).contains("?? src/"),
            "the dirt is still untracked"
        );
    }

    #[test]
    fn commit_check_receives_the_claimed_paths_and_the_round_lands() {
        let temp = TempDir::new().unwrap();
        let scratch = TempDir::new().unwrap();
        let seen = scratch.path().join("seen");
        let command = format!("\"printf '%s\\\\n' {{paths}} > {}\"", seen.display());
        let (repo, paths) = arc_with_config(&temp, "seen", &src_surface(&command, ""));
        let worktree = worktree_path(&repo, "seen");
        let before = head_sha(&worktree);
        touch(&worktree, "src/a.ts");
        touch(&worktree, "docs/unclaimed.md");

        let outcome = commit_in(&paths, &repo, "seen", "tugarc(seen): a round", None, None)
            .expect("a green check lets the round land");
        assert!(outcome.committed);
        assert_ne!(head_sha(&worktree), before);
        assert_eq!(
            fs::read_to_string(&seen).unwrap(),
            "src/a.ts\n",
            "only the surface's own claimed path is handed to the check"
        );
    }

    #[test]
    fn a_yield_round_is_committed_unchecked() {
        let temp = TempDir::new().unwrap();
        let (repo, paths) = arc_with_config(&temp, "yielding", &src_surface(REFUSING, ""));
        let worktree = worktree_path(&repo, "yielding");
        touch(&worktree, "src/a.ts");

        let outcome = commit_in(
            &paths,
            &repo,
            "yielding",
            "yield: half the type; files: src/a.ts; next: the other half",
            None,
            None,
        )
        .expect("a yield is the hand-off the wheel compacts on, and it lands as it is");
        assert!(outcome.committed);
    }

    #[test]
    fn commit_check_only_skips_a_round_with_no_matching_file() {
        let temp = TempDir::new().unwrap();
        let config = src_surface("\"exit 1\"", "commit_check_only = [\"*.ts\", \"*.tsx\"]\n");
        let (repo, paths) = arc_with_config(&temp, "rust-only", &config);
        let worktree = worktree_path(&repo, "rust-only");
        touch(&worktree, "src/a.rs");

        let outcome = commit_in(
            &paths,
            &repo,
            "rust-only",
            "tugarc(rust-only): a round",
            None,
            None,
        )
        .expect("a round outside the filter runs no check");
        assert!(outcome.committed);

        touch(&worktree, "src/b.tsx");
        let err = commit_in(
            &paths,
            &repo,
            "rust-only",
            "tugarc(rust-only): b",
            None,
            None,
        )
        .expect_err("a matching file runs the check, which refuses");
        assert!(err.to_string().contains("surface src"), "{err}");
    }

    #[test]
    fn a_worktree_with_no_config_commits_as_before() {
        let temp = TempDir::new().unwrap();
        let (repo, paths) = repo_beside_state(&temp);
        create_in(&paths, &repo, "plain", None, false, None).unwrap();
        let worktree = worktree_path(&repo, "plain");
        assert!(!worktree.join(".tugtool/config.toml").exists());
        touch(&worktree, "src/a.ts");

        let outcome = commit_in(&paths, &repo, "plain", "tugarc(plain): a round", None, None)
            .expect("no config, no check");
        assert!(outcome.committed);
    }

    #[test]
    fn a_filter_with_no_commit_check_is_refused_by_validate() {
        let temp = TempDir::new().unwrap();
        fs::create_dir_all(temp.path().join(".tugtool")).unwrap();
        fs::write(
            temp.path().join(".tugtool/config.toml"),
            "[[tugtool.arc.surface]]\nname = \"src\"\npaths = [\"src/\"]\ncommit_check_only = [\"*.ts\"]\n",
        )
        .unwrap();
        let refusal =
            Config::load_from_project(temp.path()).expect_err("a filter with nothing to run");
        assert!(refusal.to_string().contains("\"src\""), "{refusal}");
    }

    #[test]
    fn the_file_name_glob_is_star_only() {
        assert!(file_name_glob_matches("*.ts", "a.ts"));
        assert!(file_name_glob_matches("*.ts", ".ts"));
        assert!(!file_name_glob_matches("*.ts", "a.tsx"));
        assert!(file_name_glob_matches("*.test.*", "a.test.ts"));
        assert!(!file_name_glob_matches("*.test.*", "a.ts"));
        assert!(file_name_glob_matches("exact.rs", "exact.rs"));
        assert!(!file_name_glob_matches("exact.rs", "inexact.rs"));
        assert!(file_name_glob_matches("*", "anything"));
    }

    #[test]
    fn the_sweep_wears_the_round_voice_and_marks_itself() {
        let temp = TempDir::new().unwrap();
        let (repo, paths) = repo_beside_state(&temp);
        create_in(&paths, &repo, "voiced", None, false, None).unwrap();
        let worktree = worktree_path(&repo, "voiced");
        fs::write(worktree.join("dirt.txt"), "x\n").unwrap();
        commit_worktree_dirt(&worktree, "voiced").unwrap();

        let message = tugcore::test_fixtures::git::command()
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

    /// An `audited` mark refuses a tree the last verify did not see, and a
    /// verify of exactly the live pair lets it through. The fit the arc then
    /// reports is the audit's own pair, so the two cannot disagree.
    #[test]
    fn an_audit_mark_refuses_a_base_the_verify_did_not_see() {
        let (_temp, root, paths) = stepped_arc("verified-arc");
        let tips = live_tips(&root, "verified-arc");
        let (head, base) = (tips.head.clone().unwrap(), tips.base.clone().unwrap());
        let elsewhere = "0".repeat(40);

        crate::log::append_arc_log(
            &paths,
            &root,
            "verified-arc",
            "verified",
            &format!("{head} onto {elsewhere} · 1 surfaces checked"),
        )
        .unwrap();
        let refusal = mark_in(&paths, &root, "verified-arc", MarkStage::Audited, None)
            .expect_err("a verify onto another base cannot vouch for this one");
        let sentence = refusal.to_string();
        assert!(sentence.contains("the base moved since"), "{sentence}");
        assert!(
            sentence.contains("tugtool arc verify verified-arc"),
            "{sentence}"
        );
        assert!(
            !matches!(
                crate::log::read_declarations(&paths, &root, "verified-arc").latest,
                Some(crate::log::ArcDeclaration::Audited)
            ),
            "a refused mark writes nothing"
        );

        crate::log::append_arc_log(
            &paths,
            &root,
            "verified-arc",
            "verified",
            &format!("{head} onto {base} · 1 surfaces checked"),
        )
        .unwrap();
        mark_in(&paths, &root, "verified-arc", MarkStage::Audited, None)
            .expect("a verify of the live pair lets the mark through");
        let declarations = crate::log::read_declarations(&paths, &root, "verified-arc");
        let fit = super::super::show::fit_fact(&tips, &declarations).expect("a fit");
        let audited = declarations.audited_at.expect("the mark carries its pair");
        assert_eq!((fit.head, fit.base), (audited.head, audited.base));
        assert!(fit.current);
    }

    /// `mark` says when it is claiming more than the ledger does.
    ///
    /// `audited` arms the join, so making it over a table of `pending` rows is
    /// a claim about work nobody recorded doing. Reported, never refused —
    /// marking ahead of the rows is a real gesture.
    #[test]
    fn mark_reports_the_ledger_rows_still_open() {
        let (_temp, root, paths) = stepped_arc("open-rows-arc");

        let marked = mark_in(&paths, &root, "open-rows-arc", MarkStage::Audited, None).unwrap();
        assert_eq!(marked.total_steps, 2);
        assert_eq!(
            marked.open_steps,
            vec![1, 2],
            "a plan nobody has walked is two open rows, and the mark says so",
        );

        // Closing them empties the report; the mark and the ledger now agree.
        step_start_in(&paths, &root, "open-rows-arc", 1, 2).unwrap();
        step_done_in(&paths, &root, "open-rows-arc", 1, None).unwrap();
        step_start_in(&paths, &root, "open-rows-arc", 2, 2).unwrap();
        step_withdraw_in(&paths, &root, "open-rows-arc", 2).unwrap();

        let marked = mark_in(&paths, &root, "open-rows-arc", MarkStage::Audited, None).unwrap();
        assert!(
            marked.open_steps.is_empty(),
            "a withdrawn row is closed too: {:?}",
            marked.open_steps,
        );
        assert_eq!(marked.total_steps, 2);
        let _ = &root;
    }

    #[test]
    fn mark_refuses_an_unknown_arc() {
        let (_temp, root, paths) = stepped_arc("known-arc");
        let err = mark_in(&paths, &root, "no-such-arc", MarkStage::Built, None)
            .unwrap_err()
            .to_string();
        assert!(err.contains("Arc not found"), "{err}");
    }

    /// An arc whose branch does not exist yet is still an arc: the durable
    /// record is the `tugid`, and an arc binds — and can be marked — before
    /// any `tugarc/<name>` ref is cut. tugcast's binding gate learned this in
    /// W2; `mark` had been left behind refusing "Arc not found" at exactly
    /// the moment an arc most needs to declare something.
    #[test]
    fn mark_accepts_a_arc_whose_record_is_only_its_tugid() {
        let (_temp, root, paths) = stepped_arc("pre-branch-arc");

        // Cut the branch away, leaving the config entry a teardown would have
        // removed with it — `update-ref -d` rather than `branch -D`, because
        // the latter takes the whole `branch.<name>.*` config section, `tugid`
        // and all. This is the pre-branch arc's shape: an id, and no ref yet.
        git(
            &root,
            &[
                "update-ref",
                "-d",
                &format!("refs/heads/{}", branch_name("pre-branch-arc")),
            ],
        );
        assert!(!branch_exists(&root, &branch_name("pre-branch-arc")));
        assert!(arc_record_exists(&root, "pre-branch-arc"));

        let marked = mark_in(&paths, &root, "pre-branch-arc", MarkStage::Built, None)
            .expect("a pre-branch arc may declare that it built");
        assert_eq!(marked.stage, "built");
        assert_eq!(
            crate::log::read_declarations(&paths, &root, "pre-branch-arc").latest,
            Some(crate::log::ArcDeclaration::Built)
        );

        // And a name the repo has no record of at all still refuses.
        assert!(!arc_record_exists(&root, "never-existed"));
    }

    #[test]
    fn test_arc_commit_with_changes_writes_log() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        let paths = redirect_state_dir(&home);

        create_in(
            &paths,
            repo,
            "test-arc",
            Some("Test".to_string()),
            false,
            None,
        )
        .unwrap();

        let worktree = repo.join(".tug/worktrees/test-arc");
        fs::write(worktree.join("test.txt"), "content\n").unwrap();

        let result = commit_in(&paths, repo, "test-arc", "Add test file", None, None);
        assert!(result.unwrap().committed);

        // A new commit landed on the arc branch.
        let count = tugcore::test_fixtures::git::command()
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

    #[test]
    fn test_arc_commit_no_changes() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        let paths = redirect_state_dir(&temp.path().join("state"));

        create_in(
            &paths,
            repo,
            "test-arc",
            Some("Test".to_string()),
            false,
            None,
        )
        .unwrap();

        let result = commit_in(&paths, repo, "test-arc", "No changes", None, None);
        assert!(!result.unwrap().committed);

        // Nothing to commit, so no hand-off was written either.
        let log = fs::read_to_string(arc_log_path(&temp.path().join("state"), repo)).unwrap();
        assert!(!log.contains("arc-note"), "no yield, no note: {log}");

        // A yield on a clean tree still writes its hand-off ([B05]).
        let yield_subject = "yield: half the facts; files: arc.rs; next: tests";
        let result = commit_in(&paths, repo, "test-arc", yield_subject, None, None);
        assert!(!result.unwrap().committed);
        let declarations = crate::log::read_declarations(&paths, repo, "test-arc");
        assert!(declarations.yielded_since_ask);
        assert_eq!(declarations.latest_yield.as_deref(), Some(yield_subject));

        // No commit ahead of base.
        let count = tugcore::test_fixtures::git::command()
            .arg("-C")
            .arg(repo)
            .args(["rev-list", "--count", "main..tugarc/test-arc"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&count.stdout).trim(), "0");
    }

    #[test]
    fn test_arc_commit_multibyte_summary_does_not_panic() {
        // A multibyte summary longer than 72 bytes must not panic on a byte
        // slice, and `--message` must remain the commit subject.
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        let paths = redirect_state_dir(&temp.path().join("state"));

        create_in(&paths, repo, "test-arc", None, false, None).unwrap();
        let worktree = repo.join(".tug/worktrees/test-arc");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();

        // A long multibyte summary that straddles byte 72 (100 bytes, 50 chars).
        let meta = ArcRoundMeta {
            instruction: Some("i".to_string()),
            summary: Some("é".repeat(50)),
        };
        commit_in(&paths, repo, "test-arc", "feat: thing", Some(meta), None).unwrap();

        // The subject is the --message; the summary rode into the body.
        let subject = tugcore::test_fixtures::git::command()
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

    #[test]
    fn test_arc_commit_round_meta_writes_instruction() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        let paths = redirect_state_dir(&home);

        create_in(
            &paths,
            repo,
            "test-arc",
            Some("Test".to_string()),
            false,
            None,
        )
        .unwrap();

        let worktree = repo.join(".tug/worktrees/test-arc");
        fs::write(worktree.join("test.txt"), "test\n").unwrap();

        // The verbatim instruction is git's one gap — it must reach the arc log.
        let meta = ArcRoundMeta {
            instruction: Some("add test file".to_string()),
            summary: Some("Added test file".to_string()),
        };
        commit_in(&paths, repo, "test-arc", "Test commit", Some(meta), None).unwrap();

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
    #[test]
    fn a_round_commit_from_a_stage_cites_the_line() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        let mut paths = redirect_state_dir(&home);

        // A line of two segments: the root, and the stage a rotation seated.
        // The commit is made from the stage.
        let line_id = "7f3d2c18-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
        let stage = "aa11bb22-cc33-4d44-8e55-ff6677889900";
        let ledgers = tugcore::test_fixtures::ledgers(temp.path());
        let sessions_db = ledgers.sessions_db();
        {
            let conn = ledgers.sessions();
            conn.execute(
                "INSERT INTO lines (line_id, tag, name, name_user_set, card_id,
                                    project_dir, created_at, last_used_at)
                 VALUES (?1, 'heroic-mule', 'arc+join-xp', 1, 'card-1', '/proj', 1, 1)",
                rusqlite::params![line_id],
            )
            .unwrap();
            for segment in ["5b4b5867-1111-4222-8333-444455556666", stage] {
                ledgers.add_session(segment, line_id);
            }
        }
        paths.sessions_db = sessions_db.clone();

        create_in(
            &paths,
            repo,
            "cite-arc",
            Some("Test".to_string()),
            false,
            None,
        )
        .unwrap();
        let worktree = repo.join(".tug/worktrees/cite-arc");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();
        commit_in(&paths, repo, "cite-arc", "Add f", None, Some(stage)).unwrap();

        let round = tugcore::test_fixtures::git::command()
            .arg("-C")
            .arg(&worktree)
            .args(["log", "-1", "--format=%B"])
            .output()
            .unwrap();
        let round = String::from_utf8_lossy(&round.stdout);

        assert!(
            round.contains("Tug-Session: heroic-mule (7f3d2c18)"),
            "the citation is the line's callsign and the line's short id: {round}"
        );
        assert!(
            round.contains(&format!("Tug-Session-Id: {stage}")),
            "the machine id pins the segment the commit was made in: {round}"
        );
    }

    #[test]
    fn test_arc_commits_carry_arc_trailer() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        let home = temp.path().join("state");
        init_git_repo(repo);
        let paths = redirect_state_dir(&home);

        create_in(
            &paths,
            repo,
            "trailer-arc",
            Some("Test".to_string()),
            false,
            None,
        )
        .unwrap();
        let worktree = repo.join(".tug/worktrees/trailer-arc");
        fs::write(worktree.join("f.txt"), "x\n").unwrap();
        commit_in(&paths, repo, "trailer-arc", "Add f", None, None).unwrap();

        let round = tugcore::test_fixtures::git::command()
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
        // No session id given, so neither key lands — they travel together.
        assert!(
            !round.contains("Tug-Session:"),
            "no session id → no Tug-Session: {round}"
        );
        assert!(
            !round.contains("Tug-Session-Id:"),
            "no session id → no Tug-Session-Id: {round}"
        );

        join_in(
            &paths,
            repo,
            "trailer-arc",
            JoinOptions {
                message: Some("Land it".to_string()),
                ..mechanics()
            },
        )
        .unwrap();
        let squash = tugcore::test_fixtures::git::command()
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
    #[test]
    fn an_arc_round_names_its_hostile_files_by_their_real_names() {
        let temp = TempDir::new().unwrap();
        let (repo, paths) = repo_beside_state(&temp);
        create_in(&paths, &repo, "hostile", None, false, None).unwrap();
        let worktree = worktree_path(&repo, "hostile");

        // Git's own spelling of the roster: verbatim, except the decomposed
        // name, which git precomposes where the platform precomposes at all
        // (measured in `tugcore::hostile_repo`).
        let mut want = tugcore::hostile_repo::hostile_paths_as_git_reports_them();
        want.sort();

        // A round that brings them in.
        tugcore::hostile_repo::write_hostile_files(&worktree).expect("the fixture writes");
        let outcome = commit_in(
            &paths,
            &repo,
            "hostile",
            "tugarc(hostile): add the records",
            None,
            None,
        )
        .unwrap();
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
        let outcome = commit_in(
            &paths,
            &repo,
            "hostile",
            "tugarc(hostile): revise the records",
            None,
            None,
        )
        .unwrap();
        assert!(outcome.committed);
        assert!(worktree_dirt(&repo, "hostile").is_empty());
    }
}
