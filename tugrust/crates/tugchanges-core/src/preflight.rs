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

use std::collections::{BTreeMap, BTreeSet};
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

/// One recent commit (Spec S02/S04): abbreviated sha, subject, and the
/// committer date as `YYYY-MM-DD` (`%cs`). The committer date, not the
/// author's, because git's `--since` window filters on it: bucketing on
/// the same date is what lets the window's edge days hold every commit
/// they should. On `main` the committer date is the landing day. `at` is the
/// same moment to the second, as ISO 8601 with its offset (`%cI`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LogEntry {
    pub sha: String,
    pub subject: String,
    pub date: String,
    pub at: String,
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

/// The one `git log` record format every reader here parses: sha, subject,
/// committer date and committer time, NUL between fields, one commit per line.
const LOG_FORMAT: &str = "--format=%h%x00%s%x00%cs%x00%cI";

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

/// The `limit` most-recent commits as `{sha, subject, date, at}`, via
/// `git log` in [`LOG_FORMAT`]. Empty on any git failure (an unborn
/// HEAD, a non-repo) — the preflight still composes, just without history.
fn recent_commits(repo_root: &Path, limit: u32) -> Vec<LogEntry> {
    let limit_arg = format!("-n{limit}");
    let out = match git::git_stdout(repo_root, &["log", LOG_FORMAT, &limit_arg]) {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    parse_log(&out)
}

/// Parse [`LOG_FORMAT`] records (one commit per line, NUL between sha,
/// subject, date and time) into [`LogEntry`]s.
fn parse_log(output: &str) -> Vec<LogEntry> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(4, '\0');
            let sha = parts.next()?.trim();
            if sha.is_empty() {
                return None;
            }
            Some(LogEntry {
                sha: sha.to_string(),
                subject: parts.next().unwrap_or("").to_string(),
                date: parts.next().unwrap_or("").trim().to_string(),
                at: parts.next().unwrap_or("").trim().to_string(),
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

/// Options for [`log`] (Spec S04). `range` (two-dot `a..b`) overrides the plain
/// `--limit N` most-recent read; `days` (with neither) reads the commits
/// whose committer date falls within the last `N` days, through git's own
/// `--since`, which is the window `log --chart` buckets. `project` is the
/// directory whose repository is read, the cwd when `None`; `path`, relative
/// to that repository's root, narrows every form to the commits touching it.
#[derive(Debug, Clone, Default)]
pub struct LogOptions {
    pub project: Option<PathBuf>,
    pub limit: Option<u32>,
    pub range: Option<String>,
    pub days: Option<u32>,
    pub path: Option<String>,
}

/// The `log` result (Spec S04).
#[derive(Debug, Clone, Serialize)]
pub struct LogReport {
    pub range: String,
    pub commits: Vec<LogEntry>,
}

/// Run the `log` operation (Spec S04). With `--range a..b`, log that range;
/// with `--days N` and no range or limit, the last `N` days on HEAD;
/// otherwise the `--limit N` (default 10) most-recent commits.
pub fn log(opts: LogOptions) -> Result<LogReport, String> {
    let project_dir = match &opts.project {
        Some(p) => p.clone(),
        None => std::env::current_dir().map_err(|e| format!("cannot resolve cwd: {e}"))?,
    };
    let repo_root = git::repo_root_for(&project_dir);

    let (mut range, mut args): (String, Vec<String>) = match (&opts.range, opts.limit, opts.days) {
        (Some(range), _, _) => (
            range.clone(),
            vec!["log".to_string(), LOG_FORMAT.to_string(), range.clone()],
        ),
        (None, None, Some(days)) => (
            format!("last {days} days"),
            vec![
                "log".to_string(),
                LOG_FORMAT.to_string(),
                format!("--since={days} days ago"),
                "HEAD".to_string(),
            ],
        ),
        (None, limit, _) => {
            let limit = limit.unwrap_or(DEFAULT_LOG_LIMIT);
            (
                format!("HEAD~{limit}..HEAD"),
                vec![
                    "log".to_string(),
                    LOG_FORMAT.to_string(),
                    format!("-n{limit}"),
                ],
            )
        }
    };
    if let Some(path) = &opts.path {
        range = format!("{range} under {path}");
        args.extend(["--".to_string(), path.clone()]);
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = git::git_stdout(&repo_root, &arg_refs)?;
    Ok(LogReport {
        range,
        commits: parse_log(&out),
    })
}

// ---------------------------------------------------------------------------
// numstat over history
// ---------------------------------------------------------------------------

/// Lines added and deleted on one committer day (`YYYY-MM-DD`), and how many
/// commits landed on it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DayStat {
    pub day: String,
    pub added: u64,
    pub deleted: u64,
    pub commits: u32,
}

/// Lines added and deleted under one path, and how many commits touched it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PathStat {
    pub path: String,
    pub added: u64,
    pub deleted: u64,
    pub commits: u32,
}

/// One commit of a numstat read: its committer day and each file it changed.
#[derive(Debug, Clone, PartialEq, Eq)]
struct NumstatCommit {
    day: String,
    files: Vec<NumstatFile>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NumstatFile {
    path: String,
    added: u64,
    deleted: u64,
}

/// The commits of the last `days` days on HEAD, summed per committer day,
/// oldest first; `path` narrows the read to it. A day with no commits has no
/// row: filling the gaps takes a calendar, which belongs to the caller.
pub fn numstat_by_day(
    repo_root: &Path,
    days: u32,
    path: Option<&str>,
) -> Result<Vec<DayStat>, String> {
    Ok(sum_by_day(&read_numstat_log(repo_root, days, path)?))
}

/// The same read summed by the first `depth` components of each path, largest
/// `added + deleted` first.
pub fn numstat_by_path(
    repo_root: &Path,
    days: u32,
    path: Option<&str>,
    depth: usize,
) -> Result<Vec<PathStat>, String> {
    Ok(group_by_depth(
        &read_numstat_log(repo_root, days, path)?,
        depth,
    ))
}

fn read_numstat_log(
    repo_root: &Path,
    days: u32,
    path: Option<&str>,
) -> Result<Vec<NumstatCommit>, String> {
    let since = format!("--since={days} days ago");
    let mut args = vec![
        "log",
        since.as_str(),
        "--format=%x01%cs",
        "--numstat",
        "HEAD",
    ];
    if let Some(path) = path {
        args.extend(["--", path]);
    }
    let records = git::listing(repo_root, &args).map_err(|e| e.to_string())?;
    Ok(parse_numstat_log(&records))
}

/// Parse the records of `git log -z --format=%x01%cs --numstat`: a
/// `\x01`-prefixed record opens a commit's day and the numstat records after
/// it are its files, the first of them led by a newline. A binary file's `-`
/// counts 0, and a renamed file counts under where it ended up.
fn parse_numstat_log(records: &[String]) -> Vec<NumstatCommit> {
    let mut commits: Vec<(&str, Vec<String>)> = Vec::new();
    for record in records {
        if let Some(day) = record.strip_prefix('\u{1}') {
            commits.push((day, Vec::new()));
        } else if let Some((_, rows)) = commits.last_mut() {
            let row = if rows.is_empty() {
                record.strip_prefix('\n').unwrap_or(record)
            } else {
                record
            };
            rows.push(row.to_string());
        }
    }
    commits
        .into_iter()
        .map(|(day, rows)| NumstatCommit {
            day: day.to_string(),
            files: git::parse_numstat_records(&rows)
                .into_iter()
                .map(|entry| NumstatFile {
                    path: entry.path,
                    added: u64::from(entry.added.unwrap_or(0)),
                    deleted: u64::from(entry.deleted.unwrap_or(0)),
                })
                .collect(),
        })
        .collect()
}

fn sum_by_day(commits: &[NumstatCommit]) -> Vec<DayStat> {
    let mut days: BTreeMap<&str, DayStat> = BTreeMap::new();
    for commit in commits {
        let stat = days.entry(&commit.day).or_insert_with(|| DayStat {
            day: commit.day.clone(),
            added: 0,
            deleted: 0,
            commits: 0,
        });
        stat.commits += 1;
        for file in &commit.files {
            stat.added += file.added;
            stat.deleted += file.deleted;
        }
    }
    days.into_values().collect()
}

/// The first `depth` components of `path` joined by `/`, so a file at the root
/// keeps its name.
pub fn path_prefix(path: &str, depth: usize) -> String {
    path.split('/').take(depth).collect::<Vec<_>>().join("/")
}

/// Sum per [`path_prefix`]. A commit counts once per prefix however many of its
/// files fall under it. Largest first, ties by path.
fn group_by_depth(commits: &[NumstatCommit], depth: usize) -> Vec<PathStat> {
    let mut groups: BTreeMap<String, PathStat> = BTreeMap::new();
    for commit in commits {
        let mut seen: BTreeSet<String> = BTreeSet::new();
        for file in &commit.files {
            let prefix = path_prefix(&file.path, depth);
            let stat = groups.entry(prefix.clone()).or_insert_with(|| PathStat {
                path: prefix.clone(),
                added: 0,
                deleted: 0,
                commits: 0,
            });
            stat.added += file.added;
            stat.deleted += file.deleted;
            if seen.insert(prefix) {
                stat.commits += 1;
            }
        }
    }
    let mut out: Vec<PathStat> = groups.into_values().collect();
    out.sort_by_key(|s| std::cmp::Reverse(s.added + s.deleted));
    out
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
    use tugcore::test_fixtures::git::{GitFixture, git};

    fn init_repo_with_commits(subjects: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        GitFixture::init(root);
        for subject in subjects {
            std::fs::write(root.join(format!("{subject}.txt")), "x\n").unwrap();
            git(root, &["add", "-A"]);
            git(root, &["commit", "-q", "-m", subject]);
        }
        dir
    }

    #[test]
    fn parse_log_splits_sha_and_subject_on_nul() {
        let out = "abc1234\u{0}first subject\u{0}2026-10-28\u{0}2026-10-28T09:30:00-07:00\ndef5678\u{0}second\u{0}2026-10-27\u{0}2026-10-27T23:59:01+00:00\n";
        let entries = parse_log(out);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].sha, "abc1234");
        assert_eq!(entries[0].subject, "first subject");
        assert_eq!(entries[0].date, "2026-10-28");
        assert_eq!(entries[1].sha, "def5678");
        assert_eq!(entries[1].subject, "second");
        assert_eq!(entries[1].date, "2026-10-27");
        assert_eq!(entries[0].at, "2026-10-28T09:30:00-07:00");
        assert_eq!(entries[1].at, "2026-10-27T23:59:01+00:00");
    }

    fn numstat_records(payload: &str) -> Vec<String> {
        git::nul_records(payload.as_bytes()).expect("records")
    }

    fn numstat_fixture() -> Vec<String> {
        numstat_records(
            "\u{1}2026-10-29\0\n1\t2\ta/b/x.rs\x003\t4\ta/c/y.rs\0\u{1}2026-10-29\0\n5\t6\ta/b/z.rs\0-\t-\tb/logo.png\0\u{1}2026-10-28\0\n7\t0\tREADME.md\0",
        )
    }

    #[test]
    fn numstat_log_sums_commits_per_day_and_keeps_days_apart() {
        let days = sum_by_day(&parse_numstat_log(&numstat_fixture()));
        assert_eq!(
            days,
            vec![
                DayStat {
                    day: "2026-10-28".to_string(),
                    added: 7,
                    deleted: 0,
                    commits: 1,
                },
                DayStat {
                    day: "2026-10-29".to_string(),
                    added: 9,
                    deleted: 12,
                    commits: 2,
                },
            ]
        );
    }

    #[test]
    fn numstat_log_counts_a_binary_file_as_zero() {
        let commits = parse_numstat_log(&numstat_records("\u{1}2026-10-29\0\n-\t-\tlogo.png\0"));
        assert_eq!(commits.len(), 1);
        assert_eq!(
            commits[0].files,
            vec![NumstatFile {
                path: "logo.png".to_string(),
                added: 0,
                deleted: 0,
            }]
        );
    }

    #[test]
    fn numstat_log_counts_a_rename_where_it_ended_up_and_keeps_an_empty_commit() {
        let commits = parse_numstat_log(&numstat_records(
            "\u{1}2026-10-30\0\u{1}2026-10-29\0\n2\t1\t\0old/f.rs\0new/f.rs\x003\t0\tg.rs\0",
        ));
        assert_eq!(commits.len(), 2);
        assert!(commits[0].files.is_empty());
        assert_eq!(
            commits[1].files,
            vec![
                NumstatFile {
                    path: "new/f.rs".to_string(),
                    added: 2,
                    deleted: 1,
                },
                NumstatFile {
                    path: "g.rs".to_string(),
                    added: 3,
                    deleted: 0,
                },
            ]
        );
    }

    #[test]
    fn group_by_depth_counts_a_commit_once_per_prefix() {
        let commits = parse_numstat_log(&numstat_fixture());
        let summed = |stats: Vec<PathStat>| -> Vec<(String, u64, u32)> {
            stats
                .into_iter()
                .map(|s| (s.path, s.added + s.deleted, s.commits))
                .collect()
        };
        assert_eq!(
            summed(group_by_depth(&commits, 1)),
            vec![
                ("a".to_string(), 21, 2),
                ("README.md".to_string(), 7, 1),
                ("b".to_string(), 0, 1),
            ]
        );
        assert_eq!(
            summed(group_by_depth(&commits, 2)),
            vec![
                ("a/b".to_string(), 14, 2),
                ("README.md".to_string(), 7, 1),
                ("a/c".to_string(), 7, 1),
                ("b/logo.png".to_string(), 0, 1),
            ]
        );
    }

    #[test]
    fn numstat_readers_read_a_real_history_and_follow_a_rename() {
        let repo = init_repo_with_commits(&["base"]);
        let root = repo.path();
        std::fs::create_dir_all(root.join("dir/old")).unwrap();
        std::fs::write(root.join("dir/old/f.txt"), "one\ntwo\nthree\nfour\n").unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "add"]);
        git(root, &["mv", "dir/old", "dir/new"]);
        git(root, &["commit", "-q", "-m", "move"]);
        // A name the line form of this read would hand back C-quoted.
        std::fs::write(root.join("dir/qu\"ote é.txt"), "one\n").unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "awkward"]);

        let paths = numstat_by_path(root, 1, Some("dir"), 2).expect("by path");
        let moved = paths.iter().find(|p| p.path == "dir/new").expect("dir/new");
        assert_eq!((moved.added, moved.deleted, moved.commits), (0, 0, 1));
        assert!(
            paths.iter().any(|p| p.path == "dir/qu\"ote é.txt"),
            "{paths:?}"
        );

        let days = numstat_by_day(root, 1, None).expect("by day");
        assert_eq!(days.len(), 1);
        assert_eq!(days[0].commits, 4);
        assert_eq!(days[0].added, 6);
    }

    #[test]
    fn log_reads_the_named_project_under_a_path() {
        let repo = init_repo_with_commits(&["base"]);
        let root = repo.path();
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::write(root.join("a/f.txt"), "x\n").unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "touch a"]);

        let report = log(LogOptions {
            project: Some(root.to_path_buf()),
            limit: Some(5),
            path: Some("a".to_string()),
            ..Default::default()
        })
        .expect("log");
        assert_eq!(report.range, "HEAD~5..HEAD under a");
        let subjects: Vec<&str> = report.commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, ["touch a"]);
        assert!(report.commits[0].at.contains('T'));
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
