//! The git runner every arc verb reads and writes through: raw output, trimmed
//! stdout, single config values, and the "what moved since" reader.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::error::ArcError;

// --- git helpers -----------------------------------------------------------

/// Run a git command in `dir`, returning its raw output.
pub(crate) fn git_output(dir: &Path, args: &[&str]) -> Result<std::process::Output, ArcError> {
    tugcore::git_command()
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| {
            ArcError::git(
                format!("failed to run git {}", args.join(" ")),
                args,
                e.to_string(),
            )
        })
}

/// Run a git command in `dir`, returning trimmed stdout on success.
pub(crate) fn git_stdout(dir: &Path, args: &[&str]) -> Result<String, ArcError> {
    let out = git_output(dir, args)?;
    if !out.status.success() {
        return Err(ArcError::git(
            format!("git {} failed", args.join(" ")),
            args,
            String::from_utf8_lossy(&out.stderr).trim(),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The commits since `since` that touched any of `paths`, newest first,
/// capped at `cap` lines.
///
/// The anchor for "what changed since this document was written". `since` is a
/// wall-clock instant — the document's own modification time — rather than the
/// commit that last touched it, because an arc's documents are not tracked and
/// so have no such commit; the clause always meant "since the author wrote
/// this", and the mtime is that fact more directly.
///
/// Total: an unborn HEAD, a repo that is not one, and a time git cannot parse
/// all answer with an empty vector, because a rotation must never fail over a
/// paragraph it could have omitted.
pub fn commits_touching_after(
    root: &Path,
    since: SystemTime,
    paths: &[String],
    cap: usize,
) -> Vec<String> {
    if paths.is_empty() || cap == 0 {
        return Vec::new();
    }
    let Ok(epoch) = since.duration_since(SystemTime::UNIX_EPOCH) else {
        return Vec::new();
    };
    // git reads `@<seconds>` as a raw epoch instant in every locale.
    let since = format!("--since=@{}", epoch.as_secs());
    let mut args: Vec<&str> = vec!["log", "--oneline", &since, "HEAD", "--"];
    args.extend(paths.iter().map(String::as_str));
    let Ok(out) = git_stdout(root, &args) else {
        return Vec::new();
    };
    out.lines()
        .filter(|line| !line.trim().is_empty())
        .take(cap)
        .map(str::to_owned)
        .collect()
}

/// Read a single git config value, if present and non-empty.
pub(crate) fn config_get(repo: &Path, key: &str) -> Option<String> {
    let out = git_output(repo, &["config", "--get", key]).ok()?;
    if !out.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// How many times a commit path re-attempts past a held `index.lock`, and how
/// long it waits between attempts — a ~1.5s ceiling (Spec S02).
///
/// The bound is what keeps this a retry rather than a wait: a lock still held
/// after a second and a half is not the other writer finishing its commit, it
/// is a crashed process leaving a file behind, and that wants the error.
pub(super) const INDEX_LOCK_ATTEMPTS: u32 = 10;
pub(super) const INDEX_LOCK_BACKOFF: std::time::Duration = std::time::Duration::from_millis(150);

/// Whether a failed git invocation lost the race for the worktree's index
/// rather than failing on its merits.
///
/// Two writers commit into the same arc worktree at the same moment: the join
/// arc's preflight sweep, and a live `tugtool arc commit` closing the run's
/// final step. They want the same dirt, and the loser used to die on
/// `index.lock: File exists` — killing either a join the user had just
/// accepted or the round that ends the run.
///
/// Matched on the lock file's name, which git spells the same way in every
/// message that reports it. One predicate for both sites, so they can never
/// disagree about what is transient.
fn index_lock_blocked(stderr: &str) -> bool {
    stderr.contains("index.lock")
}

/// What one attempt at an index-writing act came to.
pub(super) enum LockAttempt<T> {
    /// The act finished — it wrote, or found there was nothing left to write.
    Done(T),
    /// A git write lost the race for `index.lock`; the error is git's own.
    Blocked(ArcError),
}

/// Run an index-writing act, re-attempting past a held `index.lock` under
/// [`INDEX_LOCK_ATTEMPTS`] and [`INDEX_LOCK_BACKOFF`] (Spec S02).
///
/// The one loop, for every site that writes an index another Tug process may
/// be writing — the arc worktree's two commit paths and the base's landing —
/// so they cannot disagree about what is transient or for how long. The whole
/// closure re-runs per attempt, which is what lets a caller re-read state
/// first and find that the writer it lost to already did the work. An `Err`
/// from the closure is a failure on the merits and ends the loop at once.
///
/// When the window closes with the lock still held, the last blocked error
/// goes back verbatim — a retry that rewrote it would cost the reader the one
/// word (`index.lock`) that says what actually happened.
///
/// Generic in the closure's error so a caller still on `String` can keep its
/// own `?`s inside the attempt; the blocked error converts into it.
pub(super) fn retry_past_index_lock<T, E: From<ArcError>>(
    mut attempt: impl FnMut() -> Result<LockAttempt<T>, E>,
) -> Result<T, E> {
    let mut last_error = None;
    for n in 0..INDEX_LOCK_ATTEMPTS {
        if n > 0 {
            std::thread::sleep(INDEX_LOCK_BACKOFF);
        }
        match attempt()? {
            LockAttempt::Done(value) => return Ok(value),
            LockAttempt::Blocked(e) => last_error = Some(e),
        }
    }
    Err(E::from(
        last_error.expect("INDEX_LOCK_ATTEMPTS is not zero"),
    ))
}

/// One git write inside a [`retry_past_index_lock`] attempt: `Blocked` when it
/// lost the index lock, `Err` when it failed on its merits, both as
/// `<what>: <git's stderr>`.
pub(super) fn git_write(
    dir: &Path,
    args: &[&str],
    what: &str,
) -> Result<LockAttempt<()>, ArcError> {
    let out = git_output(dir, args)?;
    if out.status.success() {
        return Ok(LockAttempt::Done(()));
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let blocked = index_lock_blocked(&stderr);
    let error = ArcError::git(what, args, stderr);
    if blocked {
        Ok(LockAttempt::Blocked(error))
    } else {
        Err(error)
    }
}

/// A git write on the base whose failure may be the caller's own signal — a
/// fast-forward the base has outgrown, a cherry-pick that conflicts — run
/// through [`retry_past_index_lock`] so that only the merits decide it.
///
/// `None` is success; `Some(stderr)` is git's own refusal, which the caller
/// reads as the signal it was watching for; `Err` is the lock held past the
/// window, which is neither and must never be read as one. A fast-forward
/// that "failed" because another Tug process held the index would otherwise
/// send the rebase down its cherry-pick and land the arc on the base as fresh
/// commits — the shape decided by a race.
pub(super) fn git_write_on_the_merits(
    dir: &Path,
    args: &[&str],
    what: &str,
) -> Result<Option<String>, ArcError> {
    retry_past_index_lock(|| {
        let out = git_output(dir, args)?;
        if out.status.success() {
            return Ok(LockAttempt::Done(None));
        }
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if index_lock_blocked(&stderr) {
            return Ok(LockAttempt::Blocked(ArcError::git(what, args, stderr)));
        }
        Ok(LockAttempt::Done(Some(stderr)))
    })
}

/// The repository root an arc operation works against.
///
/// An arc's branch, its worktree, and its op log all live in the main
/// repository, so a caller that names a *linked worktree* means the same repo —
/// and must be answered about the same one. The CLI already resolves this way
/// (`join` → `find_repo_root`); without this, tugcast serving a card whose
/// project is itself a worktree would read every arc as `off-base` against
/// that worktree's own branch while `tugtool arc join` beside it reports a
/// clean bill. Idempotent: a main root resolves to itself.
pub(crate) fn main_repo_root(start: &Path) -> PathBuf {
    tugtool_core::find_repo_root_from(start).unwrap_or_else(|_| start.to_path_buf())
}

/// Resolve a revision to its commit sha.
///
/// Exposed because a cache keyed by a head pair has to be able to read that
/// pair cheaply — two of these are what a cache hit costs.
pub fn rev_parse(repo_root: &Path, rev: &str) -> Result<String, ArcError> {
    git_stdout(&main_repo_root(repo_root), &["rev-parse", rev])
}

/// Which branch the repository has checked out.
///
/// A property of the repository rather than of any arc, so a composition
/// covering many arcs reads it once and passes it down — the one blocker
/// input the per-arc detail walk does not already hold.
pub fn current_branch(repo_root: &Path) -> Result<String, ArcError> {
    git_stdout(
        &main_repo_root(repo_root),
        &["rev-parse", "--abbrev-ref", "HEAD"],
    )
}

#[cfg(test)]
#[allow(clippy::disallowed_methods)] // set_current_dir is needed for tests with isolated temp dirs
mod tests {
    use super::*;
    use crate::ops::test_support::*;
    use std::fs;
    use std::path::Path;
    use std::time::Duration;
    use tempfile::TempDir;

    #[test]
    fn the_git_reader_answers_what_moved_and_never_fails_over_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let paths = ["a.rs".to_string()];

        // An unborn HEAD: git has never seen anything here.
        assert!(commits_touching_after(root, SystemTime::UNIX_EPOCH, &paths, 20).is_empty());

        init_git_repo(root);
        fs::write(root.join("a.rs"), "fn a() {}\n").unwrap();
        commit_all(root, "add the file the document cites");
        // A second past the commit, because git commit timestamps have
        // one-second granularity and `--since` on the same second still hits.
        let written = SystemTime::now() + Duration::from_secs(1);

        // Nothing has moved since the document was written.
        assert!(commits_touching_after(root, written, &paths, 20).is_empty());

        // A commit landing after it does, and only in the cited paths.
        std::thread::sleep(Duration::from_millis(2100));
        fs::write(root.join("a.rs"), "fn a() { todo!() }\n").unwrap();
        commit_all(root, "change the cited file");
        fs::write(root.join("b.rs"), "fn b() {}\n").unwrap();
        commit_all(root, "add an uncited file");

        let moved = commits_touching_after(root, written, &paths, 20);
        assert_eq!(moved.len(), 1, "scoped to the paths, not the whole repo");
        assert!(moved[0].contains("change the cited file"));

        // No paths and no cap are each no clause rather than an error.
        assert!(commits_touching_after(root, written, &[], 20).is_empty());
        assert!(commits_touching_after(root, written, &paths, 0).is_empty());
    }

    /// The shared runner's git declines optional locks — read back through
    /// git itself, whose `!` alias runs in the environment git was given.
    #[test]
    fn the_runner_spawns_git_without_optional_locks() {
        let out = git_stdout(
            Path::new("."),
            &[
                "-c",
                "alias.lockenv=!printenv GIT_OPTIONAL_LOCKS",
                "lockenv",
            ],
        )
        .expect("git runs");
        assert_eq!(out, "0");
    }

    /// The helper alone, against a real held lock: a write whose lock is
    /// released inside the window lands, and one held past it comes back as
    /// git's own message.
    #[test]
    fn a_lock_retry_lands_inside_the_window_and_reports_git_past_it() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        init_git_repo(repo);
        fs::write(repo.join("a.txt"), "a\n").unwrap();

        let add = || retry_past_index_lock(|| git_write(repo, &["add", "a.txt"], "git add failed"));

        let held = hold_index_lock(repo, INDEX_LOCK_BACKOFF * 2);
        add().expect("released inside the window");
        held.join().unwrap();
        assert_eq!(
            git_stdout(repo, &["diff", "--cached", "--name-only"]).unwrap(),
            "a.txt"
        );

        fs::write(repo.join("a.txt"), "b\n").unwrap();
        let held = hold_index_lock(repo, INDEX_LOCK_BACKOFF * (INDEX_LOCK_ATTEMPTS + 4));
        let err = add().unwrap_err().to_string();
        held.join().unwrap();
        assert!(err.starts_with("git add failed: "), "{err}");
        assert!(err.contains("index.lock"), "git's own message: {err}");
    }
}
