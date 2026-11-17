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

use chrono::{Days, Local, NaiveDate, SecondsFormat};
use serde::Serialize;

use crate::changes::{Change, ChangesError, ChangesOptions, ForeignChange, resolve_changes};
use crate::git::{self, FileStat};
use crate::line_kinds::{KindSet, LineKind, LineKinds};

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

/// The `--since` of the last `days` calendar days, today among them: from local
/// midnight on the oldest. Git's `N days ago` is a rolling N×24 hours, which
/// touches N+1 calendar days, so a chart of it draws one more day than it says.
/// A commit whose own offset differs from the local one can still bucket a day
/// outside the window, since `%cs` reads the committer's offset.
fn oldest_day(today: NaiveDate, days: u32) -> NaiveDate {
    // Git reads no date before its epoch, and every offset has reached this one.
    let floor = NaiveDate::from_ymd_opt(1970, 1, 2).unwrap_or_default();
    today
        .checked_sub_days(Days::new(u64::from(days.max(1) - 1)))
        .map_or(floor, |day| day.max(floor))
}

/// An absolute window over history: `since` is a local calendar day
/// (`YYYY-MM-DD`), read from its midnight, and `until`, when set, an RFC 3339
/// instant. A read that was made by one can be made again by the same one,
/// which a count of days ending now cannot promise.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window {
    pub since: String,
    pub until: Option<String>,
}

impl Window {
    /// The last `days` calendar days, today among them, ending at this instant.
    pub fn last_days(days: u32) -> Window {
        let now = Local::now();
        let mut window = Window::on(now.date_naive(), days);
        window.until = Some(now.to_rfc3339_opts(SecondsFormat::Secs, false));
        window
    }

    /// The last `days` calendar days ending on `today`, with no upper bound.
    fn on(today: NaiveDate, days: u32) -> Window {
        Window {
            since: oldest_day(today, days).format("%Y-%m-%d").to_string(),
            until: None,
        }
    }

    /// The arguments that give `git log` this window.
    pub fn git_args(&self) -> Vec<String> {
        let mut args = vec![format!("--since={} 00:00:00", self.since)];
        if let Some(until) = &self.until {
            args.push(format!("--until={until}"));
        }
        args
    }

    /// The window as a range reads: `<since> to <until's day>`.
    pub fn label(&self) -> String {
        match &self.until {
            Some(until) => format!("{} to {}", self.since, &until[..until.len().min(10)]),
            None => format!("from {}", self.since),
        }
    }
}

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

/// Options for [`log`] (Spec S04). `range` (two-dot `a..b`) overrides the plain
/// `--limit N` most-recent read; `days` (with neither) reads the commits
/// whose committer date falls within the last `N` calendar days, through git's
/// own `--since`, which is the window `log --chart` buckets; `window`, when
/// set, is that read by an absolute [`Window`] in place of `days`. `project` is the
/// directory whose repository is read, the cwd when `None`; `path`, relative
/// to that repository's root, narrows every form to the commits touching it.
#[derive(Debug, Clone, Default)]
pub struct LogOptions {
    pub project: Option<PathBuf>,
    pub limit: Option<u32>,
    pub range: Option<String>,
    pub days: Option<u32>,
    pub window: Option<Window>,
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

    let window = opts
        .window
        .clone()
        .or_else(|| opts.days.map(Window::last_days));
    let (mut range, mut args): (String, Vec<String>) = match (&opts.range, opts.limit, window) {
        (Some(range), _, _) => (
            range.clone(),
            vec!["log".to_string(), LOG_FORMAT.to_string(), range.clone()],
        ),
        (None, None, Some(window)) => {
            let label = match (opts.window.is_some(), opts.days) {
                (false, Some(days)) => format!("last {days} days"),
                _ => window.label(),
            };
            let mut args = vec!["log".to_string(), LOG_FORMAT.to_string()];
            args.extend(window.git_args());
            args.push("HEAD".to_string());
            (label, args)
        }
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
/// commits landed on it, by their short shas in log order (newest first).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DayStat {
    pub day: String,
    pub added: u64,
    pub deleted: u64,
    pub commits: u32,
    pub shas: Vec<String>,
}

/// Lines added and deleted under one path, and how many commits touched it.
/// `is_file` says the group is one file rather than a directory: a file whose
/// path is its own prefix formed it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PathStat {
    pub path: String,
    pub added: u64,
    pub deleted: u64,
    pub commits: u32,
    pub is_file: bool,
}

/// One commit of a numstat read: its short sha, its committer day and each
/// file it changed.
#[derive(Debug, Clone, PartialEq, Eq)]
struct NumstatCommit {
    sha: String,
    day: String,
    files: Vec<NumstatFile>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NumstatFile {
    path: String,
    added: u64,
    deleted: u64,
}

/// One commit's lines: its short sha, its committer day, and the lines it
/// added and deleted over every file it changed. A merge that changed no
/// lines is a row of zeros, so a day's commit count still counts it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitLines {
    pub sha: String,
    pub day: String,
    pub added: u64,
    pub deleted: u64,
}

impl CommitLines {
    pub fn lines(&self) -> u64 {
        self.added + self.deleted
    }
}

fn read_numstat_log(
    repo_root: &Path,
    window: &Window,
    path: Option<&str>,
) -> Result<Vec<NumstatCommit>, String> {
    let window_args = window.git_args();
    let mut args = vec!["log"];
    args.extend(window_args.iter().map(String::as_str));
    args.extend(["--format=%x01%h %cs", "--numstat", "HEAD"]);
    if let Some(path) = path {
        args.extend(["--", path]);
    }
    let records = git::listing(repo_root, &args).map_err(|e| e.to_string())?;
    Ok(parse_numstat_log(&records))
}

/// Parse the records of `git log -z --format='%x01%h %cs' --numstat`: a
/// `\x01`-prefixed record opens a commit as its short sha and its day, and
/// the numstat records after it are its files, the first of them led by a
/// newline. A binary file's `-` counts 0, and a renamed file counts under
/// where it ended up.
fn parse_numstat_log(records: &[String]) -> Vec<NumstatCommit> {
    let mut commits: Vec<(&str, &str, Vec<String>)> = Vec::new();
    for record in records {
        if let Some(head) = record.strip_prefix('\u{1}') {
            let (sha, day) = head.split_once(' ').unwrap_or((head, ""));
            commits.push((sha, day, Vec::new()));
        } else if let Some((_, _, rows)) = commits.last_mut() {
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
        .map(|(sha, day, rows)| NumstatCommit {
            sha: sha.to_string(),
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

/// One file of a classified numstat read: its path, the kind its path makes
/// it, and the lines it added and deleted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileLines {
    pub path: String,
    pub kind: LineKind,
    pub added: u64,
    pub deleted: u64,
}

/// One commit of a classified numstat read: its short sha, its committer day
/// and each file it changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitFiles {
    pub sha: String,
    pub day: String,
    pub files: Vec<FileLines>,
}

/// Every commit of the window on HEAD with each file it changed classified by
/// `kinds`, newest first; `path` narrows the read to it. Every line recipe
/// sums this read, so what it counts has always passed through the
/// classifier.
pub fn numstat_files_in(
    repo_root: &Path,
    window: &Window,
    path: Option<&str>,
    kinds: &LineKinds,
) -> Result<Vec<CommitFiles>, String> {
    Ok(classify_commits(
        read_numstat_log(repo_root, window, path)?,
        kinds,
    ))
}

fn classify_commits(commits: Vec<NumstatCommit>, kinds: &LineKinds) -> Vec<CommitFiles> {
    commits
        .into_iter()
        .map(|commit| CommitFiles {
            sha: commit.sha,
            day: commit.day,
            files: commit
                .files
                .into_iter()
                .map(|file| FileLines {
                    kind: kinds.classify(&file.path),
                    path: file.path,
                    added: file.added,
                    deleted: file.deleted,
                })
                .collect(),
        })
        .collect()
}

/// Each commit's lines of the kinds in `set`, newest first as given. A commit
/// with no counted line has no entry: it says nothing about the work the
/// chart counts.
pub fn commit_lines(commits: &[CommitFiles], set: KindSet) -> Vec<CommitLines> {
    commits
        .iter()
        .filter_map(|commit| {
            let (added, deleted) = commit
                .files
                .iter()
                .filter(|file| set.holds(file.kind))
                .fold((0, 0), |(a, d), file| (a + file.added, d + file.deleted));
            (added + deleted > 0).then(|| CommitLines {
                sha: commit.sha.clone(),
                day: commit.day.clone(),
                added,
                deleted,
            })
        })
        .collect()
}

/// The lines of each kind outside `set`, summed over the read, in
/// [`LineKind::ALL`] order; a kind with no line is absent.
pub fn left_out(commits: &[CommitFiles], set: KindSet) -> Vec<(LineKind, u64)> {
    LineKind::ALL
        .into_iter()
        .filter(|kind| !set.holds(*kind))
        .filter_map(|kind| {
            let lines: u64 = commits
                .iter()
                .flat_map(|commit| &commit.files)
                .filter(|file| file.kind == kind)
                .map(|file| file.added + file.deleted)
                .sum();
            (lines > 0).then_some((kind, lines))
        })
        .collect()
}

/// The counted lines summed per [`path_prefix`] at `depth`. A commit counts
/// once per prefix however many of its counted files fall under it, a group
/// is a file when a file's path is its own prefix, and a prefix with no
/// counted line has no row. Largest first, ties by path.
pub fn group_paths(commits: &[CommitFiles], set: KindSet, depth: usize) -> Vec<PathStat> {
    let mut groups: BTreeMap<String, PathStat> = BTreeMap::new();
    for commit in commits {
        let mut seen: BTreeSet<String> = BTreeSet::new();
        for file in commit.files.iter().filter(|file| set.holds(file.kind)) {
            if file.added + file.deleted == 0 {
                continue;
            }
            let prefix = path_prefix(&file.path, depth);
            let stat = groups.entry(prefix.clone()).or_insert_with(|| PathStat {
                path: prefix.clone(),
                added: 0,
                deleted: 0,
                commits: 0,
                is_file: false,
            });
            stat.is_file |= prefix == file.path;
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

/// `commits` summed per committer day, oldest day first, each day's shas in
/// the order given.
pub fn day_stats(commits: &[CommitLines]) -> Vec<DayStat> {
    let mut days: BTreeMap<&str, DayStat> = BTreeMap::new();
    for commit in commits {
        let stat = days.entry(&commit.day).or_insert_with(|| DayStat {
            day: commit.day.clone(),
            added: 0,
            deleted: 0,
            commits: 0,
            shas: Vec::new(),
        });
        stat.commits += 1;
        stat.shas.push(commit.sha.clone());
        stat.added += commit.added;
        stat.deleted += commit.deleted;
    }
    days.into_values().collect()
}

/// The first `depth` components of `path` joined by `/`, so a file at the root
/// keeps its name.
pub fn path_prefix(path: &str, depth: usize) -> String {
    path.split('/').take(depth).collect::<Vec<_>>().join("/")
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
            "\u{1}aaa1111 2026-10-29\0\n1\t2\ta/b/x.rs\x003\t4\ta/c/y.rs\0\u{1}bbb2222 2026-10-29\0\n5\t6\ta/b/z.rs\0-\t-\tb/logo.png\0\u{1}ccc3333 2026-10-28\0\n7\t0\tREADME.md\0",
        )
    }

    #[test]
    fn numstat_log_sums_commits_per_day_and_keeps_days_apart() {
        let commits = commit_lines(
            &classified(&numstat_fixture()),
            KindSet::parse("all").unwrap(),
        );
        assert_eq!(
            commits,
            vec![
                CommitLines {
                    sha: "aaa1111".to_string(),
                    day: "2026-10-29".to_string(),
                    added: 4,
                    deleted: 6,
                },
                CommitLines {
                    sha: "bbb2222".to_string(),
                    day: "2026-10-29".to_string(),
                    added: 5,
                    deleted: 6,
                },
                CommitLines {
                    sha: "ccc3333".to_string(),
                    day: "2026-10-28".to_string(),
                    added: 7,
                    deleted: 0,
                },
            ]
        );
        let days = day_stats(&commits);
        assert_eq!(
            days,
            vec![
                DayStat {
                    day: "2026-10-28".to_string(),
                    added: 7,
                    deleted: 0,
                    commits: 1,
                    shas: vec!["ccc3333".to_string()],
                },
                DayStat {
                    day: "2026-10-29".to_string(),
                    added: 9,
                    deleted: 12,
                    commits: 2,
                    shas: vec!["aaa1111".to_string(), "bbb2222".to_string()],
                },
            ]
        );
    }

    #[test]
    fn numstat_log_counts_a_binary_file_as_zero() {
        let commits = parse_numstat_log(&numstat_records(
            "\u{1}abc1234 2026-10-29\0\n-\t-\tlogo.png\0",
        ));
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].sha, "abc1234");
        assert_eq!(commits[0].day, "2026-10-29");
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
            "\u{1}d4d4d4d 2026-10-30\0\u{1}e5e5e5e 2026-10-29\0\n2\t1\t\0old/f.rs\0new/f.rs\x003\t0\tg.rs\0",
        ));
        assert_eq!(commits.len(), 2);
        assert!(commits[0].files.is_empty());
        // The classified read keeps the empty commit too, with no files.
        let read = classify_commits(commits.clone(), &LineKinds::defaults());
        assert_eq!(read.len(), 2);
        assert!(read[0].files.is_empty());
        assert_eq!(read[1].files[0].path, "new/f.rs");
        assert_eq!(commits[0].sha, "d4d4d4d");
        assert_eq!(commits[1].sha, "e5e5e5e");
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
    fn group_paths_counts_a_commit_once_per_prefix() {
        let commits = classified(&numstat_fixture());
        let all = KindSet::parse("all").unwrap();
        let summed = |stats: Vec<PathStat>| -> Vec<(String, u64, u32)> {
            stats
                .into_iter()
                .map(|s| (s.path, s.added + s.deleted, s.commits))
                .collect()
        };
        assert_eq!(
            summed(group_paths(&commits, all, 1)),
            vec![("a".to_string(), 21, 2), ("README.md".to_string(), 7, 1),]
        );
        assert_eq!(
            summed(group_paths(&commits, all, 2)),
            vec![
                ("a/b".to_string(), 14, 2),
                ("README.md".to_string(), 7, 1),
                ("a/c".to_string(), 7, 1),
            ]
        );
        // A group is a file exactly when a file's path is its own prefix.
        let files = |stats: Vec<PathStat>| -> Vec<(String, bool)> {
            stats.into_iter().map(|s| (s.path, s.is_file)).collect()
        };
        assert_eq!(
            files(group_paths(&commits, all, 1)),
            vec![("a".to_string(), false), ("README.md".to_string(), true),]
        );
        assert!(files(group_paths(&commits, all, 2)).contains(&("a/b".to_string(), false)));
        // A binary file's lines count nothing, so its prefix has no row.
        assert!(
            !files(group_paths(&commits, all, 2))
                .iter()
                .any(|(p, _)| p == "b/logo.png")
        );
    }

    /// `records` parsed and classified by the built-in patterns.
    fn classified(records: &[String]) -> Vec<CommitFiles> {
        classify_commits(parse_numstat_log(records), &LineKinds::defaults())
    }

    fn file(path: &str, kind: LineKind, added: u64, deleted: u64) -> FileLines {
        FileLines {
            path: path.to_string(),
            kind,
            added,
            deleted,
        }
    }

    fn classified_fixture() -> Vec<CommitFiles> {
        use LineKind::*;
        vec![
            CommitFiles {
                sha: "aaa1111".into(),
                day: "2026-10-29".into(),
                files: vec![
                    file("src/a/x.rs", Source, 10, 2),
                    file("src/a/x_test.rs", Tests, 4, 0),
                    file("data/big.json", Data, 500, 100),
                ],
            },
            CommitFiles {
                sha: "bbb2222".into(),
                day: "2026-10-29".into(),
                files: vec![file("README.md", Docs, 7, 1)],
            },
            CommitFiles {
                sha: "ccc3333".into(),
                day: "2026-10-28".into(),
                files: vec![
                    file("src/b.rs", Source, 3, 3),
                    file("tests/t.rs", Tests, 1, 1),
                    file("src/logo.png", Source, 0, 0),
                ],
            },
        ]
    }

    #[test]
    fn commit_lines_counts_only_the_kinds_held_and_drops_a_commit_with_none() {
        let code = KindSet::parse("code").unwrap();
        let lines = commit_lines(&classified_fixture(), code);
        assert_eq!(
            lines
                .iter()
                .map(|c| (c.sha.as_str(), c.added, c.deleted))
                .collect::<Vec<_>>(),
            vec![("aaa1111", 14, 2), ("ccc3333", 4, 4)],
        );
        let docs = commit_lines(&classified_fixture(), KindSet::parse("docs").unwrap());
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].sha, "bbb2222");
    }

    #[test]
    fn left_out_sums_the_kinds_outside_the_set() {
        let code = KindSet::parse("code").unwrap();
        assert_eq!(
            left_out(&classified_fixture(), code),
            vec![(LineKind::Data, 600), (LineKind::Docs, 8)],
        );
        assert!(left_out(&classified_fixture(), KindSet::parse("all").unwrap()).is_empty());
    }

    #[test]
    fn group_paths_sums_counted_lines_per_prefix() {
        let code = KindSet::parse("code").unwrap();
        let summed = |stats: Vec<PathStat>| -> Vec<(String, u64, u32, bool)> {
            stats
                .into_iter()
                .map(|s| (s.path, s.added + s.deleted, s.commits, s.is_file))
                .collect()
        };
        assert_eq!(
            summed(group_paths(&classified_fixture(), code, 1)),
            vec![
                ("src".to_string(), 22, 2, false),
                ("tests".to_string(), 2, 1, false),
            ]
        );
        assert_eq!(
            summed(group_paths(&classified_fixture(), code, 2)),
            vec![
                ("src/a".to_string(), 16, 1, false),
                ("src/b.rs".to_string(), 6, 1, true),
                ("tests/t.rs".to_string(), 2, 1, true),
            ]
        );
        assert_eq!(
            summed(group_paths(
                &classified_fixture(),
                KindSet::parse("all").unwrap(),
                1
            )),
            vec![
                ("data".to_string(), 600, 1, false),
                ("src".to_string(), 22, 2, false),
                ("README.md".to_string(), 8, 1, true),
                ("tests".to_string(), 2, 1, false),
            ]
        );
    }

    #[test]
    fn the_classified_read_classifies_a_real_history() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        GitFixture::init(root);
        std::fs::create_dir_all(root.join("tests")).unwrap();
        std::fs::write(root.join("main.rs"), "a\nb\n").unwrap();
        std::fs::write(root.join("tests/t.rs"), "c\n").unwrap();
        std::fs::write(root.join("notes.md"), "d\n").unwrap();
        git(root, &["add", "-A"]);
        git(root, &["commit", "-q", "-m", "first"]);
        let commits = numstat_files_in(root, &Window::last_days(1), None, &LineKinds::defaults())
            .expect("classified read");
        assert_eq!(commits.len(), 1);
        let mut kinds: Vec<(String, LineKind, u64)> = commits[0]
            .files
            .iter()
            .map(|f| (f.path.clone(), f.kind, f.added))
            .collect();
        kinds.sort();
        assert_eq!(
            kinds,
            vec![
                ("main.rs".to_string(), LineKind::Source, 2),
                ("notes.md".to_string(), LineKind::Docs, 1),
                ("tests/t.rs".to_string(), LineKind::Tests, 1),
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

        let all = KindSet::parse("all").unwrap();
        let window = Window::last_days(1);
        let kinds = LineKinds::defaults();
        let under_dir = numstat_files_in(root, &window, Some("dir"), &kinds).expect("under dir");
        // The move is read under where the file ended up, and changed no line.
        let moved: Vec<&FileLines> = under_dir
            .iter()
            .flat_map(|commit| &commit.files)
            .filter(|file| file.path == "dir/new/f.txt")
            .collect();
        assert_eq!(moved.len(), 1);
        assert_eq!((moved[0].added, moved[0].deleted), (0, 0));
        let paths = group_paths(&under_dir, all, 2);
        assert!(paths.iter().any(|p| p.path == "dir/old"), "{paths:?}");
        assert!(
            paths.iter().any(|p| p.path == "dir/qu\"ote é.txt"),
            "{paths:?}"
        );

        let every = numstat_files_in(root, &window, None, &kinds).expect("every commit");
        // Every commit of the window is read, the one that changed no line too.
        assert_eq!(every.len(), 4);
        let lines = commit_lines(&every, all);
        let days = day_stats(&lines);
        assert_eq!(days.len(), 1);
        assert_eq!(days[0].commits, 3);
        assert_eq!(days[0].added, 6);
        // The day carries its commits, newest first, as `git log` spells them.
        let head = git::listing(root, &["log", "-1", "--format=%h"]).expect("head sha");
        assert_eq!(days[0].shas.len(), 3);
        assert_eq!(days[0].shas[0], head[0].trim());
        // `move` changed no lines and has no entry; the rest read newest first.
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].sha, head[0].trim());
        assert_eq!(lines[0].lines(), 1);
        assert_eq!(lines[1].lines(), 4);
        assert_eq!(lines[2].lines(), 1);
    }

    #[test]
    fn a_window_of_n_days_starts_at_midnight_on_the_nth_day_back() {
        let since_on = |today, days| Window::on(today, days).git_args().remove(0);
        let today = NaiveDate::from_ymd_opt(2026, 10, 30).unwrap();
        assert_eq!(since_on(today, 1), "--since=2026-10-30 00:00:00");
        assert_eq!(since_on(today, 30), "--since=2026-10-01 00:00:00");
        assert_eq!(since_on(today, 0), "--since=2026-10-30 00:00:00");
        assert_eq!(since_on(today, u32::MAX), "--since=1970-01-02 00:00:00");
    }

    #[test]
    fn a_window_spells_its_git_arguments_and_its_label() {
        let open = Window {
            since: "2026-10-01".to_string(),
            until: None,
        };
        assert_eq!(open.git_args(), ["--since=2026-10-01 00:00:00"]);
        assert_eq!(open.label(), "from 2026-10-01");
        let closed = Window {
            since: "2026-10-01".to_string(),
            until: Some("2026-10-30T09:14:02-08:00".to_string()),
        };
        assert_eq!(
            closed.git_args(),
            [
                "--since=2026-10-01 00:00:00",
                "--until=2026-10-30T09:14:02-08:00"
            ]
        );
        assert_eq!(closed.label(), "2026-10-01 to 2026-10-30");
        let last = Window::last_days(30);
        assert_eq!(Window::on(Local::now().date_naive(), 30).since, last.since);
        assert!(last.until.is_some_and(|u| u.contains('T')));
    }

    #[test]
    fn a_days_window_reads_what_its_absolute_window_reads() {
        let repo = init_repo_with_commits(&["one", "two"]);
        let root = repo.path();
        let window = Window::last_days(1);
        let open = Window {
            since: window.since.clone(),
            until: None,
        };
        let kinds = LineKinds::defaults();
        assert_eq!(
            numstat_files_in(root, &window, None, &kinds).unwrap(),
            numstat_files_in(root, &open, None, &kinds).unwrap()
        );
        let windowed = log(LogOptions {
            project: Some(root.to_path_buf()),
            window: Some(window.clone()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(windowed.range, window.label());
        assert_eq!(windowed.commits.len(), 2);
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
