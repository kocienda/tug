//! The `preflight`, `log`, and `diff` operations.
//!
//! `preflight` is the one-shot readout a landing starts from (Spec S01): the working
//! tree bucketed into `files` (this session's `attributed` changes),
//! `unattributed` (dirty with no ledger rows), and `foreign` (claimed only by
//! other sessions) — all diffed (a created/untracked file carries a synthesized
//! add-diff, never an empty string) — plus the branch/head and the recent commit
//! subjects, everything needed to compose a message and see the whole dirty tree
//! ([P01]: a dirty file is never invisible). `log` and `diff` (Spec S04) are the
//! standalone history/range read-outs the other skills use.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::changes::{Change, ChangesError, ChangesOptions, ForeignChange, resolve_changes};
use crate::git::{self, FileStat};

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

/// Options for [`preflight`] (Spec S02). `session` defaults from
/// `$TUG_SESSION_ID`; `project` defaults to cwd (and must match how `commit`
/// resolves the repo); `log_limit` is the recent-commit depth (default 10).
#[derive(Debug, Clone)]
pub struct PreflightOptions {
    pub session: Option<String>,
    pub project: Option<PathBuf>,
    pub log_limit: u32,
}

impl Default for PreflightOptions {
    fn default() -> Self {
        Self {
            session: None,
            project: None,
            log_limit: DEFAULT_LOG_LIMIT,
        }
    }
}

/// One recent commit (Spec S02/S04): abbreviated sha + subject.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LogEntry {
    pub sha: String,
    pub subject: String,
}

/// The `preflight` result (Spec S01). `files` is the `attributed` bucket;
/// `unattributed` and `foreign` are additive — they complete the working-tree
/// universe so nothing dirty is invisible ([P01]).
#[derive(Debug, Clone, Serialize)]
pub struct PreflightReport {
    pub session: String,
    pub project: String,
    pub repo_root: String,
    pub branch: String,
    pub head: String,
    pub files: Vec<Change>,
    pub unattributed: Vec<Change>,
    pub foreign: Vec<ForeignChange>,
    pub recent_commits: Vec<LogEntry>,
}

const DEFAULT_LOG_LIMIT: u32 = 10;

/// Run the `preflight` operation (Spec S02) — the session's changed files
/// (always diffed) plus branch/head and recent commits. Surfaces the exit-2
/// ledger-resolution cases as typed [`ChangesError`]s, like `changes`.
pub fn preflight(opts: PreflightOptions) -> Result<PreflightReport, ChangesError> {
    let resolved = resolve_changes(&ChangesOptions {
        session: opts.session.clone(),
        project: opts.project.clone(),
        all: false,
        diff: true,
    })?;

    let repo_root = resolved.repo_root;
    let branch = git::git_stdout(&repo_root, &["branch", "--show-current"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let head = git::git_stdout(&repo_root, &["rev-parse", "--short", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let recent_commits = recent_commits(&repo_root, opts.log_limit);

    Ok(PreflightReport {
        session: resolved.session,
        project: repo_root.to_string_lossy().into_owned(),
        repo_root: repo_root.to_string_lossy().into_owned(),
        branch,
        head,
        files: resolved.files,
        unattributed: resolved.unattributed,
        foreign: resolved.foreign,
        recent_commits,
    })
}

/// The `limit` most-recent commits as `{sha, subject}`, via
/// `git log --format=%h%x00%s -n <limit>`. Empty on any git failure (an unborn
/// HEAD, a non-repo) — the preflight still composes, just without history.
fn recent_commits(repo_root: &Path, limit: u32) -> Vec<LogEntry> {
    let limit_arg = format!("-n{limit}");
    let out = match git::git_stdout(repo_root, &["log", "--format=%h%x00%s", &limit_arg]) {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    parse_log(&out)
}

/// Parse `%h%x00%s` records (one commit per line, NUL between sha and subject)
/// into [`LogEntry`]s.
fn parse_log(output: &str) -> Vec<LogEntry> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(2, '\0');
            let sha = parts.next()?.trim();
            if sha.is_empty() {
                return None;
            }
            Some(LogEntry {
                sha: sha.to_string(),
                subject: parts.next().unwrap_or("").to_string(),
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

/// Options for [`log`] (Spec S04). `range` (two-dot `a..b`) overrides the plain
/// `--limit N` most-recent read.
#[derive(Debug, Clone, Default)]
pub struct LogOptions {
    pub limit: Option<u32>,
    pub range: Option<String>,
}

/// The `log` result (Spec S04).
#[derive(Debug, Clone, Serialize)]
pub struct LogReport {
    pub range: String,
    pub commits: Vec<LogEntry>,
}

/// Run the `log` operation (Spec S04). With `--range a..b`, log that range;
/// otherwise the `--limit N` (default 10) most-recent commits.
pub fn log(opts: LogOptions) -> Result<LogReport, String> {
    let repo_root = std::env::current_dir().map_err(|e| format!("cannot resolve cwd: {e}"))?;
    let repo_root = git::repo_root_for(&repo_root);

    let (range, args): (String, Vec<String>) = match &opts.range {
        Some(range) => (
            range.clone(),
            vec![
                "log".to_string(),
                "--format=%h%x00%s".to_string(),
                range.clone(),
            ],
        ),
        None => {
            let limit = opts.limit.unwrap_or(DEFAULT_LOG_LIMIT);
            (
                format!("HEAD~{limit}..HEAD"),
                vec![
                    "log".to_string(),
                    "--format=%h%x00%s".to_string(),
                    format!("-n{limit}"),
                ],
            )
        }
    };
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = git::git_stdout(&repo_root, &arg_refs)?;
    Ok(LogReport {
        range,
        commits: parse_log(&out),
    })
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

/// Options for [`diff`] (Spec S04). `range` (two-dot `a..b`) diffs a range;
/// `staged` diffs the index; `session` narrows to the session's changed files;
/// otherwise the working tree.
#[derive(Debug, Clone, Default)]
pub struct DiffOptions {
    pub session: Option<String>,
    pub project: Option<PathBuf>,
    pub range: Option<String>,
    pub staged: bool,
    pub session_scope: bool,
}

/// The `diff` result (Spec S04). `range` is `None` for a working-tree/staged
/// diff.
#[derive(Debug, Clone, Serialize)]
pub struct DiffReport {
    pub range: Option<String>,
    pub files: Vec<FileStat>,
}

/// Run the `diff` operation (Spec S04): `--range a..b`, `--staged`, `--session`
/// (the session's changed files only), or the working tree by default.
pub fn diff(opts: DiffOptions) -> Result<DiffReport, String> {
    let project_dir = match &opts.project {
        Some(p) => p.clone(),
        None => std::env::current_dir().map_err(|e| format!("cannot resolve cwd: {e}"))?,
    };
    let repo_root = git::repo_root_for(&project_dir);

    if let Some(range) = &opts.range {
        let files = diff_stats(&repo_root, &[range])?;
        return Ok(DiffReport {
            range: Some(range.clone()),
            files,
        });
    }
    if opts.staged {
        let files = diff_stats(&repo_root, &["--staged"])?;
        return Ok(DiffReport { range: None, files });
    }
    if opts.session_scope {
        // The session's changed files, diffed against the working tree.
        let resolved = resolve_changes(&ChangesOptions {
            session: opts.session.clone(),
            project: opts.project.clone(),
            all: false,
            diff: false,
        })
        .map_err(|e| e.to_string())?;
        if resolved.files.is_empty() {
            return Ok(DiffReport {
                range: None,
                files: Vec::new(),
            });
        }
        let mut scope: Vec<&str> = vec!["--"];
        scope.extend(resolved.files.iter().map(|f| f.path.as_str()));
        let files = diff_stats(&repo_root, &scope)?;
        return Ok(DiffReport { range: None, files });
    }
    let files = diff_stats(&repo_root, &[])?;
    Ok(DiffReport { range: None, files })
}

/// Run `git diff --numstat <scope>` + `git diff --name-status <scope>` and join
/// them into per-file [`FileStat`]s.
///
/// Both reads go through the `-z` door ([B01]): a `tugtool diff` whose scope is
/// the session's own changed files hands those paths straight back to git, so a
/// C-quoted spelling would scope the diff to a file nobody has.
fn diff_stats(repo_root: &Path, scope: &[&str]) -> Result<Vec<FileStat>, String> {
    let mut numstat_args: Vec<&str> = vec!["diff", "--numstat"];
    numstat_args.extend_from_slice(scope);

    let mut name_status_args: Vec<&str> = vec!["diff", "--name-status"];
    name_status_args.extend_from_slice(scope);

    git::read_file_stats(repo_root, &numstat_args, &name_status_args).map_err(|e| e.to_string())
}

// The `preflight`/`log`/`diff` ops are proven end-to-end at the CLI integration
// layer (Step 6, against the built binary + a seeded sessions.db); the unit
// tests below cover the parse + range-shaping logic that has no git dependency,
// plus the temp-repo behaviors this module owns directly.
#[cfg(test)]
mod tests {
    use super::*;

    fn git(root: &Path, args: &[&str]) {
        assert!(
            tugcore::git_command()
                .args(args)
                .current_dir(root)
                .output()
                .expect("git")
                .status
                .success(),
            "git {args:?}"
        );
    }

    fn init_repo_with_commits(subjects: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        git(root, &["init", "-q", "-b", "main"]);
        git(root, &["config", "user.email", "t@t.test"]);
        git(root, &["config", "user.name", "t"]);
        for subject in subjects {
            std::fs::write(root.join(format!("{subject}.txt")), "x\n").unwrap();
            git(root, &["add", "-A"]);
            git(root, &["commit", "-q", "-m", subject]);
        }
        dir
    }

    #[test]
    fn parse_log_splits_sha_and_subject_on_nul() {
        let out = "abc1234\u{0}first subject\ndef5678\u{0}second\n";
        let entries = parse_log(out);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].sha, "abc1234");
        assert_eq!(entries[0].subject, "first subject");
        assert_eq!(entries[1].sha, "def5678");
        assert_eq!(entries[1].subject, "second");
    }

    #[test]
    fn recent_commits_are_most_recent_first() {
        let repo = init_repo_with_commits(&["first", "second", "third"]);
        let commits = recent_commits(repo.path(), 10);
        let subjects: Vec<&str> = commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, ["third", "second", "first"]);
        assert!(!commits[0].sha.is_empty());
    }

    #[test]
    fn diff_staged_reflects_the_index() {
        let repo = init_repo_with_commits(&["base"]);
        let root = repo.path();
        std::fs::write(root.join("base.txt"), "x\nmore\n").unwrap();
        git(root, &["add", "base.txt"]);

        let report = diff(DiffOptions {
            project: Some(root.to_path_buf()),
            staged: true,
            ..Default::default()
        })
        .expect("diff --staged");
        assert_eq!(report.range, None);
        assert_eq!(report.files.len(), 1);
        assert_eq!(report.files[0].path, "base.txt");
        assert_eq!(report.files[0].added, Some(1));
    }

    #[test]
    fn diff_range_carries_the_range_and_files() {
        let repo = init_repo_with_commits(&["first", "second"]);
        let root = repo.path();
        let report = diff(DiffOptions {
            project: Some(root.to_path_buf()),
            range: Some("HEAD~1..HEAD".to_string()),
            ..Default::default()
        })
        .expect("diff range");
        assert_eq!(report.range.as_deref(), Some("HEAD~1..HEAD"));
        // second.txt was added in the newest commit.
        assert!(report.files.iter().any(|f| f.path == "second.txt"));
    }
}
