//! Git status parsing + `/diff` sourcing.
//!
//! The GIT status feed (0x20) was retired when the Changeset card replaced
//! the git card ([P16]); this module keeps the shared `git status`
//! porcelain-v2 parser (now driven by `feeds/changeset.rs`) and the
//! single-shot `git diff HEAD` sourcing for the `/diff` sheet (GIT_DIFF,
//! 0x21).

use std::path::Path;

use tokio::process::Command;
use tracing::warn;

use tugcast_core::types::{
    FileStatus, GitCommitFile, GitCommitFilesSnapshot, GitDiffFile, GitDiffFileStatus,
    GitDiffSnapshot, GitLogCommit, GitLogSnapshot, GitStatus,
};
use tugchanges_core::HUNK_DIFF_FLAGS;

/// Parse git status --porcelain=v2 --branch output into GitStatus.
///
/// Delegates the parsing to `tugchanges_core`'s canonical
/// [`parse_status_porcelain_v2`](tugchanges_core::parse_status_porcelain_v2)
/// ([P06]/[P08]) and maps its [`StatusReport`](tugchanges_core::StatusReport) into
/// the `tugcast_core` wire type: each tracked entry's XY splits into a staged
/// (X, rendered `R` for a rename) and/or unstaged (Y) `FileStatus`, in the same
/// per-line order as before; untracked paths and branch/ahead/behind/head carry
/// straight over. `head_message` is filled separately via git log. The wire
/// contract is unchanged — only the parser internals moved.
pub(crate) fn parse_porcelain_v2(output: &str) -> GitStatus {
    let report = tugchanges_core::parse_status_porcelain_v2(output);
    let mut staged: Vec<FileStatus> = Vec::new();
    let mut unstaged: Vec<FileStatus> = Vec::new();
    for entry in &report.entries {
        let mut chars = entry.xy.chars();
        let x = chars.next().unwrap_or('.');
        let y = chars.next().unwrap_or('.');
        if x != '.' {
            staged.push(FileStatus {
                path: entry.path.clone(),
                status: if entry.renamed {
                    "R".to_string()
                } else {
                    x.to_string()
                },
            });
        }
        if y != '.' {
            unstaged.push(FileStatus {
                path: entry.path.clone(),
                status: y.to_string(),
            });
        }
    }
    GitStatus {
        branch: report.branch,
        ahead: report.ahead,
        behind: report.behind,
        staged,
        unstaged,
        untracked: report.untracked,
        head_sha: report.head_sha,
        head_message: String::new(), // Filled separately via git log
    }
}

/// Fetch the HEAD commit message
pub(crate) async fn fetch_head_message(repo_dir: &Path) -> String {
    let output = Command::new("git")
        .args([
            "-C",
            &repo_dir.to_string_lossy(),
            "log",
            "-1",
            "--format=%s",
        ])
        .output()
        .await;

    match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => String::new(),
    }
}

/// Fetch git status output
///
/// `--no-optional-locks` keeps this background poll from taking the repo's
/// `index.lock` to refresh the stat cache. The event-driven git watch fires
/// this recompute on every `.git`-touching batch, so an optional lock here
/// races a concurrent user `git commit`/`git add` in the same repo (the commit
/// fails with `index.lock: File exists`). A read-only status has no need to
/// write the index, so we opt out of the lock entirely.
pub(crate) async fn fetch_git_status(repo_dir: &Path) -> Option<String> {
    let output = Command::new("git")
        .args([
            "-C",
            &repo_dir.to_string_lossy(),
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "--branch",
        ])
        .output()
        .await;

    match output {
        Ok(o) if o.status.success() => Some(String::from_utf8_lossy(&o.stdout).to_string()),
        Ok(o) => {
            // `git`'s stderr ends with a `\n`; the tracing fmt layer
            // appends its own newline per event, so logging the raw
            // string would produce a `\n\n` and a blank line in the
            // log file. Trim before logging.
            let stderr = String::from_utf8_lossy(&o.stderr);
            let stderr = stderr.trim_end();
            warn!(stderr = %stderr, "git status command failed");
            None
        }
        Err(e) => {
            warn!(error = %e, "failed to execute git status");
            None
        }
    }
}

/// Cheap, subprocess-free check for whether `dir` lies within a git working
/// tree: walk up from `dir` looking for a `.git` entry (a directory for a
/// normal repo, a file for a worktree/submodule), stopping at the filesystem
/// root.
///
/// Used to gate the `git status` poll. A non-git project dir (e.g.
/// `/tmp/scratch`) otherwise forks a `git` every cycle that fails with exit
/// 128 and logs a warning — forever. With this gate it costs only a handful
/// of `stat`s per cycle, and the feed self-activates the moment a `.git`
/// appears (a `git init` after the card is already live). The ancestor walk
/// matters because a project dir can be a *subdirectory* of a repo, where
/// `.git` lives above it.
pub(crate) async fn is_within_git_worktree(dir: &Path) -> bool {
    let mut cursor = Some(dir);
    while let Some(current) = cursor {
        if tokio::fs::metadata(current.join(".git")).await.is_ok() {
            return true;
        }
        cursor = current.parent();
    }
    false
}

// ---------------------------------------------------------------------------
// Single-shot `git diff HEAD` sourcing for the `/diff` sheet ([#step-10a])
// ---------------------------------------------------------------------------

/// The ref the working tree is diffed against for `/diff`. Claude Code's
/// `/diff` shows "Uncommitted changes (git diff HEAD)"; we match it.
const GIT_DIFF_BASE: &str = "HEAD";

/// Run `git diff HEAD` in `repo_dir` and assemble a single-shot
/// [`GitDiffSnapshot`] for a `/diff` request.
///
/// The diff is computed in the project dir tugcast already keys git by (the
/// dir behind the Z4B GIT-status chip). Rename detection is on (`-M`),
/// colorization off, and `core.quotepath=false` so non-ASCII paths arrive
/// literal. The `total_*` summary is derived from the parsed files so the
/// header totals always equal the sum the client renders.
///
/// On a git error — most commonly a repository with no commits, where `HEAD`
/// does not resolve — the snapshot is empty (`file_count = 0`); the sheet
/// shows its "no changes" state rather than surfacing a raw git failure.
///
/// A non-empty `paths` narrows the diff with a `-- <paths…>` pathspec
/// (repo-relative), so the changeset card can scope the sheet to one file or
/// one changeset. An empty slice keeps the whole-tree behavior.
pub async fn build_git_diff_snapshot(
    repo_dir: &Path,
    request_id: String,
    workspace_key: &str,
    paths: &[String],
) -> GitDiffSnapshot {
    // Distinguish "not a git repo" from "clean repo" so the client can say so
    // rather than misreport a clean tree. Cheap, subprocess-free.
    if !is_within_git_worktree(repo_dir).await {
        return GitDiffSnapshot {
            request_id,
            workspace_key: workspace_key.to_string(),
            base: GIT_DIFF_BASE.to_string(),
            no_repo: true,
            file_count: 0,
            total_added: 0,
            total_removed: 0,
            files: Vec::new(),
        };
    }
    let files = match fetch_git_diff_with_untracked(repo_dir, paths).await {
        Some(output) => parse_git_diff(&output),
        None => Vec::new(),
    };
    let total_added = files.iter().map(|f| f.added).sum();
    let total_removed = files.iter().map(|f| f.removed).sum();
    GitDiffSnapshot {
        request_id,
        workspace_key: workspace_key.to_string(),
        base: GIT_DIFF_BASE.to_string(),
        no_repo: false,
        file_count: files.len() as u32,
        total_added,
        total_removed,
        files,
    }
}

/// Assemble a single-shot [`GitDiffSnapshot`] for one **commit** — what the
/// `/commit` receipt's file rows expand into ([P08]). The diff is the commit
/// against its first parent via `git diff-tree --no-commit-id --root -M -p`,
/// which also covers a root commit (diffed against the empty tree). A
/// non-empty `paths` narrows with a pathspec so a receipt row can fetch just
/// its own file. A missing sha (rebase, gc) yields an empty snapshot, not an
/// error — the client shows a notice while the frozen rows stay intact.
pub async fn build_commit_diff_snapshot(
    repo_dir: &Path,
    request_id: String,
    workspace_key: &str,
    sha: &str,
    paths: &[String],
) -> GitDiffSnapshot {
    if !is_within_git_worktree(repo_dir).await {
        return GitDiffSnapshot {
            request_id,
            workspace_key: workspace_key.to_string(),
            base: sha.to_string(),
            no_repo: true,
            file_count: 0,
            total_added: 0,
            total_removed: 0,
            files: Vec::new(),
        };
    }
    let mut args: Vec<&str> = vec![
        "-c",
        "core.quotepath=false",
        "diff-tree",
        "--no-commit-id",
        "--root",
        "--no-color",
        "-M",
        "-p",
        sha,
    ];
    if !paths.is_empty() {
        args.push("--");
        args.extend(paths.iter().map(String::as_str));
    }
    let files = match run_git_capture(repo_dir, &args).await {
        Some(output) => parse_git_diff(&output),
        None => Vec::new(),
    };
    let total_added = files.iter().map(|f| f.added).sum();
    let total_removed = files.iter().map(|f| f.removed).sum();
    GitDiffSnapshot {
        request_id,
        workspace_key: workspace_key.to_string(),
        base: sha.to_string(),
        no_repo: false,
        file_count: files.len() as u32,
        total_added,
        total_removed,
        files,
    }
}

/// Assemble a single-shot [`GitCommitFilesSnapshot`] — the changed files of one
/// commit (name-status joined with numstat counts), what a History row expands
/// into ([P10]). This is the light list, no unified diff text: each file's hunks
/// are fetched lazily per-row through the existing commit-flavor GIT_DIFF path.
///
/// Reuses `tugchanges_core::file_stats` — the same join the `/commit` receipt
/// builds — over `git show --numstat/--name-status --format= <sha>`. A missing
/// sha (rebase, gc) yields empty `files`, not an error; a non-git dir returns
/// `no_repo: true`.
pub async fn build_commit_files_snapshot(
    repo_dir: &Path,
    request_id: String,
    workspace_key: &str,
    sha: &str,
) -> GitCommitFilesSnapshot {
    if !is_within_git_worktree(repo_dir).await {
        return GitCommitFilesSnapshot {
            request_id,
            workspace_key: workspace_key.to_string(),
            sha: sha.to_string(),
            no_repo: true,
            subject: String::new(),
            author: String::new(),
            date: String::new(),
            files: Vec::new(),
        };
    }
    // Every commit-shaped token the annotator finds arrives here as a verdict
    // query, and most of them are not commits: a session id's first eight hex
    // digits look exactly like a short sha. Ask the one silent question first,
    // so a hash that names nothing yields the empty snapshot without three
    // `git show` failures logged as if something went wrong.
    let commitish = format!("{sha}^{{commit}}");
    if run_git_line(repo_dir, &["rev-parse", "--verify", "--quiet", &commitish])
        .await
        .is_none()
    {
        return GitCommitFilesSnapshot {
            request_id,
            workspace_key: workspace_key.to_string(),
            sha: sha.to_string(),
            no_repo: false,
            subject: String::new(),
            author: String::new(),
            date: String::new(),
            files: Vec::new(),
        };
    }
    let numstat = run_git_capture(
        repo_dir,
        &[
            "-c",
            "core.quotepath=false",
            "show",
            "--numstat",
            "--format=",
            sha,
        ],
    )
    .await
    .unwrap_or_default();
    let name_status = run_git_capture(
        repo_dir,
        &[
            "-c",
            "core.quotepath=false",
            "show",
            "--name-status",
            "--format=",
            sha,
        ],
    )
    .await
    .unwrap_or_default();
    let files = tugchanges_core::file_stats(&numstat, &name_status)
        .into_iter()
        .map(|f| GitCommitFile {
            path: f.path,
            status: f.status,
            added: f.added.unwrap_or(0),
            removed: f.deleted.unwrap_or(0),
        })
        .collect();
    // The commit's own identity, for a reader that has to say what this sha
    // IS — a hover over a bare hash in prose. `-s` suppresses the diff, and
    // the unit separator cannot appear in a name or in `%s` (which strips
    // newlines), so the split is unambiguous. A sha that resolves to nothing
    // yields an empty capture and therefore empty fields, matching the empty
    // `files` the same sha produces above.
    let header = run_git_capture(
        repo_dir,
        &[
            "show",
            "-s",
            &format!("--format=%s{LOG_FIELD_SEP}%an{LOG_FIELD_SEP}%ad"),
            "--date=short",
            sha,
        ],
    )
    .await
    .unwrap_or_default();
    let mut header_fields = header.trim_end_matches('\n').split(LOG_FIELD_SEP);
    let subject = header_fields.next().unwrap_or_default().to_string();
    let author = header_fields.next().unwrap_or_default().to_string();
    let date = header_fields.next().unwrap_or_default().to_string();
    GitCommitFilesSnapshot {
        request_id,
        workspace_key: workspace_key.to_string(),
        sha: sha.to_string(),
        no_repo: false,
        subject,
        author,
        date,
        files,
    }
}

// ---------------------------------------------------------------------------
// Recent-commits (`git log`) sourcing for the Git History Lens section.
// ---------------------------------------------------------------------------

/// The unit-separator byte git emits for `%x1f` — used to delimit the log
/// record fields. It cannot appear in an author name, a single-line subject
/// (`%s` strips newlines), or a body, so the field split is unambiguous.
const LOG_FIELD_SEP: char = '\u{1f}';

/// The record-separator byte (`%x1e`) git joins repeated `Tug-Dash:` trailer
/// values with — chosen so it survives the `-z` NUL record terminator.
const LOG_TRAILER_SEP: char = '\u{1e}';

/// Assemble a single-shot [`GitLogSnapshot`] — one page of `limit` commits in
/// `repo_dir`, starting `offset` commits back from HEAD.
///
/// Gated on [`is_within_git_worktree`] — a non-git dir short-circuits to
/// `no_repo: true` before any git fork. The branch comes from
/// `git branch --show-current` (empty/`None` → `"(detached)"`, which also
/// covers an unborn HEAD spelled empty). A failed `git log` — most commonly an
/// unborn HEAD in a fresh `git init` — yields empty `commits` with
/// `no_repo: false`, mirroring how [`build_git_diff_snapshot`] treats a
/// `HEAD`-less repo as empty, not an error.
///
/// `has_more` is measured, not guessed: the walk asks git for one commit MORE
/// than the page needs and reports whether that probe came back, then drops it.
/// A count (`git rev-list --count`) would walk the whole history to answer a
/// yes/no question; the extra commit costs one more record.
pub async fn build_git_log_snapshot(
    repo_dir: &Path,
    request_id: String,
    workspace_key: &str,
    offset: u32,
    limit: u32,
) -> GitLogSnapshot {
    if !is_within_git_worktree(repo_dir).await {
        return GitLogSnapshot {
            request_id,
            workspace_key: workspace_key.to_string(),
            branch: String::new(),
            no_repo: true,
            offset,
            has_more: false,
            commits: Vec::new(),
        };
    }
    let branch = run_git_line(repo_dir, &["branch", "--show-current"])
        .await
        .unwrap_or_else(|| "(detached)".to_string());
    let limit_arg = format!("-n{}", limit.saturating_add(1));
    let skip_arg = format!("--skip={offset}");
    let mut commits = match run_git_capture(
        repo_dir,
        &[
            "-c",
            "core.quotepath=false",
            "log",
            // `-z` NUL-terminates each commit record so the final `%b` body
            // field can span multiple lines without a newline-split
            // mis-parsing it as a fresh commit.
            "-z",
            &skip_arg,
            &limit_arg,
            // Fields are `%x1f`-delimited: sha, author name, author date
            // (short), committer name, committer email, committer date (strict
            // ISO), subject, the three Tug trailers (`Tug-Dash` for the
            // History join badge [P09]; `Tug-Session` / `Tug-Session-Id` for
            // the session citation [P10]) — each empty when absent — then the
            // multi-line body (`%b`). A trailer's own multi-value separator is
            // `%x1e` (RS) — NOT `%x00`, which `-z` owns as the record
            // terminator.
            //
            // Adding a trailer field here REQUIRES widening `parse_git_log`'s
            // `splitn` cap in the same edit, or the new values glue themselves
            // to the front of every body.
            "--format=%H%x1f%an%x1f%ad%x1f%cn%x1f%ce%x1f%cI%x1f%s\
             %x1f%(trailers:key=Tug-Dash,valueonly,separator=%x1e)\
             %x1f%(trailers:key=Tug-Session,valueonly,separator=%x1e)\
             %x1f%(trailers:key=Tug-Session-Id,valueonly,separator=%x1e)\
             %x1f%b",
            // Each commit's changed paths follow its record, so the History
            // filter can match on the files a commit touched. Paths only —
            // statuses and line counts stay on the `GIT_COMMIT_FILES` route.
            "--name-only",
            "--date=short",
        ],
    )
    .await
    {
        Some(output) => parse_git_log(&output),
        None => Vec::new(),
    };
    // The probe commit answered "is there more"; it is not part of this page.
    let has_more = commits.len() > limit as usize;
    commits.truncate(limit as usize);
    GitLogSnapshot {
        request_id,
        workspace_key: workspace_key.to_string(),
        branch,
        no_repo: false,
        offset,
        has_more,
        commits,
    }
}

/// The trailer keys whose lines never belong in a displayed commit body: they
/// are machine plumbing, and every one of them is already a typed field on
/// [`GitLogCommit`]. Stripped together so the History card carries no Tug
/// trailer ink at all rather than some of it.
const TUG_TRAILER_KEYS: &[&str] = &["Tug-Session:", "Tug-Session-Id:", "Tug-Dash:"];

/// Remove Tug trailer lines from a `%b` body and trim the trailing whitespace
/// they leave behind.
///
/// Line-wise rather than paragraph-wise on purpose: trailers are supposed to
/// be one final block, but a hand-edited or re-drafted message can interleave
/// them with prose, and a body that keeps one stray `Tug-Session:` line is the
/// exact ink this exists to remove. Non-trailer lines are preserved verbatim,
/// including blank ones inside the body.
fn strip_tug_trailers(body: &str) -> String {
    let kept: Vec<&str> = body
        .lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            !TUG_TRAILER_KEYS.iter().any(|key| trimmed.starts_with(key))
        })
        .collect();
    kept.join("\n").trim_end().to_string()
}

/// Parse `git log -z --name-only` output into [`GitLogCommit`]s.
///
/// `-z` NUL-terminates every chunk, and `--name-only` makes two kinds of chunk
/// share the stream: a commit's
/// `%H%x1f%an%x1f%ad%x1f%cn%x1f%ce%x1f%cI%x1f%s%x1f<3 trailers>%x1f%b` record,
/// then one chunk per changed path (git prefixes the first path of a commit
/// with a newline, which is stripped). The two are told apart by the
/// **presence** of a field separator, not by a count: a path cannot contain
/// one — `%x1f` is a control byte no checked-in path uses. Every path chunk
/// belongs to the record that most recently preceded it, so a commit with no
/// files (a merge, an empty commit) simply collects none.
///
/// Record fields, 0-indexed: 0 sha, 1 author, 2 author date, 3 committer,
/// 4 committer email, 5 committer date, 6 subject, **7 `Tug-Dash`,
/// 8 `Tug-Session`, 9 `Tug-Session-Id`**, 10 the multi-line body with trailing
/// whitespace trimmed. A trailer field is empty when absent; a repeated
/// trailer's values are `%x1e`-joined and only the first is kept.
///
/// Records with fewer than seven fields (no subject) are skipped with a
/// `warn!`, and so are the paths that would have followed them. That bound is
/// **seven, not ten**, and stays there when trailer fields are added: it exists
/// because `subject` is `fields[6]`, an index the trailing fields do not move.
/// Raising it would newly reject records this parser handles today and drop
/// their paths.
fn parse_git_log(output: &str) -> Vec<GitLogCommit> {
    let mut commits: Vec<GitLogCommit> = Vec::new();
    // False while the paths of a record we rejected stream past, so they are
    // never misfiled onto the previous (good) commit.
    let mut collecting = false;
    for chunk in output.split('\0') {
        // Only the first path of each commit carries git's leading newline;
        // trimming it here costs nothing on the others.
        let chunk = chunk.trim_start_matches('\n');
        if chunk.is_empty() {
            continue;
        }
        if !chunk.contains(LOG_FIELD_SEP) {
            if collecting {
                if let Some(commit) = commits.last_mut() {
                    commit.files.push(chunk.to_string());
                }
            }
            continue;
        }
        // 11 = 10 leading fields + the body, which must stay whole. Left one
        // short, every trailer value after the cap glues itself to the front
        // of the body — a silent corruption under a green suite.
        let fields: Vec<&str> = chunk.splitn(11, LOG_FIELD_SEP).collect();
        if fields.len() < 7 {
            warn!(record = chunk, "skipping malformed git log record");
            collecting = false;
            continue;
        }
        let trailer = |index: usize| -> Option<String> {
            fields
                .get(index)
                .and_then(|raw| raw.split(LOG_TRAILER_SEP).next())
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
        };
        let tug_dash = trailer(7);
        let tug_session = trailer(8);
        let tug_session_id = trailer(9);
        // `%b` retains trailer lines — git does not remove them — which is why
        // the History card showed raw trailer ink. Strip every Tug trailer so
        // the body is the message the author wrote.
        let body = fields
            .get(10)
            .map(|raw| strip_tug_trailers(raw))
            .unwrap_or_default();
        commits.push(GitLogCommit {
            sha: fields[0].to_string(),
            author: fields[1].to_string(),
            date: fields[2].to_string(),
            committer: fields[3].to_string(),
            committer_email: fields[4].to_string(),
            committer_date: fields[5].to_string(),
            subject: fields[6].to_string(),
            body,
            tug_dash,
            tug_session,
            tug_session_id,
            files: Vec::new(),
        });
        collecting = true;
    }
    commits
}

/// Assemble a single-shot [`GitDiffSnapshot`] for a **dash range** diff — the
/// "everything this dash has done past its base" view: committed rounds plus
/// uncommitted worktree dirt ([P19], #diff-descriptor-resolution).
///
/// `repo_dir` is the checkout root (the workspace), used only to decide whether
/// there is a repository here at all; `worktree_abs` is the dash worktree's
/// **absolute** path, resolved by `dash_detail_entries_in` against the main
/// repository root and carried whole. The two are never composed: `repo_dir`
/// may itself be a linked worktree, which is not the root the dash path is
/// relative to. The diff itself is resolved by [`fetch_dash_diff`]: working
/// tree vs. merge-base when the worktree exists (rounds + dirt), else committed
/// rounds only. The snapshot's `base` field carries the human-readable range
/// `<base>...<branch>` so the document header reads correctly.
pub async fn build_dash_diff_snapshot(
    repo_dir: &Path,
    request_id: String,
    workspace_key: &str,
    worktree_abs: &str,
    base: &str,
    branch: &str,
) -> GitDiffSnapshot {
    let range = format!("{base}...{branch}");
    if !is_within_git_worktree(repo_dir).await {
        return GitDiffSnapshot {
            request_id,
            workspace_key: workspace_key.to_string(),
            base: range,
            no_repo: true,
            file_count: 0,
            total_added: 0,
            total_removed: 0,
            files: Vec::new(),
        };
    }
    let files = match fetch_dash_diff(repo_dir, worktree_abs, base, branch).await {
        Some(output) => parse_git_diff(&output),
        None => Vec::new(),
    };
    let total_added = files.iter().map(|f| f.added).sum();
    let total_removed = files.iter().map(|f| f.removed).sum();
    GitDiffSnapshot {
        request_id,
        workspace_key: workspace_key.to_string(),
        base: range,
        no_repo: false,
        file_count: files.len() as u32,
        total_added,
        total_removed,
        files,
    }
}

/// Fetch a dash's "rounds + worktree dirt" diff ([P19]).
///
/// When the dash worktree exists, resolve `merge-base(<base>, <branch>)` in it
/// and diff the working tree against that base — this captures both committed
/// rounds and uncommitted dirt in one pass, while keeping upstream drift on
/// `base` out (the same committed-part semantics as `<base>...<branch>`).
/// Three-dot syntax can't include a dirty working tree, hence the two-step
/// merge-base resolution. When the worktree is absent (a dash branch without a
/// checkout), fall back to `git diff <base>...<branch>` in the repo root —
/// committed rounds only, which is then the whole truth. Returns `None` (and
/// logs) on a non-zero exit or spawn failure.
///
/// `worktree_abs` arrives absolute and is used as given; `repo_dir` is only the
/// fallback's working directory. Joining the two was the old shape and it
/// degraded silently — a missed join yields a path that is not a directory,
/// which reads as "this dash has no worktree" and quietly drops its dirt.
pub(crate) async fn fetch_dash_diff(
    repo_dir: &Path,
    worktree_abs: &str,
    base: &str,
    branch: &str,
) -> Option<String> {
    let worktree_abs = Path::new(worktree_abs);
    if worktree_abs.is_dir() {
        let merge_base = run_git_line(worktree_abs, &["merge-base", base, branch]).await?;
        run_git_diff_against(worktree_abs, &merge_base).await
    } else {
        run_git_diff_against(repo_dir, &format!("{base}...{branch}")).await
    }
}

/// Run `git diff -M <target>` in `dir` with the canonical hunk-identity flags,
/// returning stdout on success.
async fn run_git_diff_against(dir: &Path, target: &str) -> Option<String> {
    let dir = dir.to_string_lossy();
    let mut args: Vec<&str> = vec!["-C", &dir, "-c", "core.quotepath=false", "diff"];
    args.extend_from_slice(HUNK_DIFF_FLAGS);
    args.extend_from_slice(&["-M", target]);
    let output = Command::new("git")
        .env_remove("GIT_DIFF_OPTS")
        .args(&args)
        .output()
        .await;
    match output {
        Ok(o) if o.status.success() => Some(String::from_utf8_lossy(&o.stdout).into_owned()),
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            warn!(stderr = %stderr.trim_end(), target, "git diff (dash range) failed");
            None
        }
        Err(e) => {
            warn!(error = %e, "failed to execute git diff (dash range)");
            None
        }
    }
}

/// Run a git command expected to print a single line (e.g. `merge-base`,
/// `rev-parse HEAD`), returning the trimmed stdout on success, `None` otherwise.
pub(crate) async fn run_git_line(dir: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    let output = cmd.output().await.ok()?;
    if output.status.success() {
        let line = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if line.is_empty() { None } else { Some(line) }
    } else {
        None
    }
}

/// Run a git command that may print many lines (e.g. `log`), returning the
/// full stdout on success, `None` (with a `warn!`) otherwise. The multi-line
/// counterpart to [`run_git_line`]; serves the `git log` body.
async fn run_git_capture(dir: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    let output = cmd.output().await;
    match output {
        Ok(o) if o.status.success() => Some(String::from_utf8_lossy(&o.stdout).into_owned()),
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            warn!(stderr = %stderr.trim_end(), ?args, "git command failed");
            None
        }
        Err(e) => {
            warn!(error = %e, ?args, "failed to execute git command");
            None
        }
    }
}

/// List the untracked (non-ignored) files in `repo_dir`, optionally narrowed
/// to a pathspec — the repo-relative paths `git diff HEAD` cannot show.
async fn list_untracked_paths(repo_dir: &Path, paths: &[String]) -> Vec<String> {
    let mut args: Vec<&str> = vec![
        "-c",
        "core.quotepath=false",
        "ls-files",
        "--others",
        "--exclude-standard",
    ];
    if !paths.is_empty() {
        args.push("--");
        args.extend(paths.iter().map(String::as_str));
    }
    match run_git_capture(repo_dir, &args).await {
        Some(output) => output.lines().map(str::to_owned).collect(),
        None => Vec::new(),
    }
}

/// Synthesize a new-file unified diff for one untracked `path` via
/// `git diff --no-index -- /dev/null <path>`. Git prints the standard
/// `new file mode` / `--- /dev/null` form and exits 1 when the file has
/// content, so both 0 and 1 are success here.
async fn synthesize_untracked_diff(repo_dir: &Path, path: &str) -> Option<String> {
    let mut args: Vec<&str> = vec!["-c", "core.quotepath=false", "diff"];
    args.extend_from_slice(HUNK_DIFF_FLAGS);
    args.extend_from_slice(&["--no-index", "--", "/dev/null", path]);
    let output = Command::new("git")
        .env_remove("GIT_DIFF_OPTS")
        .arg("-C")
        .arg(repo_dir)
        .args(&args)
        .output()
        .await;
    match output {
        Ok(o) if o.status.code() == Some(0) || o.status.code() == Some(1) => {
            Some(String::from_utf8_lossy(&o.stdout).into_owned())
        }
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            warn!(stderr = %stderr.trim_end(), path, "git diff --no-index failed");
            None
        }
        Err(e) => {
            warn!(error = %e, path, "failed to execute git diff --no-index");
            None
        }
    }
}

/// The working-tree diff INCLUDING untracked files: `git diff HEAD` plus a
/// synthesized new-file diff per untracked path, so a file created but never
/// committed diffs like any other change. `None` only when the tracked diff
/// failed AND no untracked file produced output (a `HEAD`-less fresh repo
/// still yields its untracked files).
pub(crate) async fn fetch_git_diff_with_untracked(
    repo_dir: &Path,
    paths: &[String],
) -> Option<String> {
    let tracked = fetch_git_diff(repo_dir, paths).await;
    let mut combined = tracked.clone().unwrap_or_default();
    for path in list_untracked_paths(repo_dir, paths).await {
        if let Some(chunk) = synthesize_untracked_diff(repo_dir, &path).await {
            combined.push_str(&chunk);
        }
    }
    if tracked.is_none() && combined.is_empty() {
        None
    } else {
        Some(combined)
    }
}

/// Fetch the combined `git diff HEAD` output for the working tree, optionally
/// narrowed to a `-- <paths…>` pathspec. Returns `None` (and logs) on a
/// non-zero exit or spawn failure. Tracked files only — most callers want
/// [`fetch_git_diff_with_untracked`], which also covers created-but-never-
/// committed files.
pub(crate) async fn fetch_git_diff(repo_dir: &Path, paths: &[String]) -> Option<String> {
    let mut cmd = Command::new("git");
    // Same scrub as the engine's `git_output` — hunk identity ([P06]) needs
    // both readers at one context width, and GIT_DIFF_OPTS is per-process.
    cmd.env_remove("GIT_DIFF_OPTS");
    let dir = repo_dir.to_string_lossy();
    let mut args: Vec<&str> = vec!["-C", &dir, "-c", "core.quotepath=false", "diff"];
    args.extend_from_slice(HUNK_DIFF_FLAGS);
    args.extend_from_slice(&["-M", GIT_DIFF_BASE]);
    cmd.args(&args);
    if !paths.is_empty() {
        cmd.arg("--");
        cmd.args(paths);
    }
    let output = cmd.output().await;

    match output {
        Ok(o) if o.status.success() => Some(String::from_utf8_lossy(&o.stdout).into_owned()),
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            warn!(stderr = %stderr.trim_end(), "git diff command failed");
            None
        }
        Err(e) => {
            warn!(error = %e, "failed to execute git diff");
            None
        }
    }
}

/// Split combined `git diff` output into one [`GitDiffFile`] per file.
///
/// Delegates to `tugchanges_core`'s canonical
/// [`parse_unified_diff`](tugchanges_core::parse_unified_diff) ([P06]/[P08]) and
/// maps each [`DiffFile`](tugchanges_core::DiffFile) into the `tugcast_core` wire
/// type (the two structs carry identical fields — only the status enum differs).
/// The `unified` chunk text is preserved verbatim, so the frame the client
/// parses is unchanged.
///
/// Each file also carries its hunk ids ([P06] identity, computed in
/// `tugchanges_core::hunks` and nowhere else) in hunk order. Binary files have
/// no hunks; created files are left id-less on purpose — their chunk is
/// synthesized from `--no-index` rather than read out of the index, so the
/// landing engine cannot address their hunks and the client must not offer to.
pub fn parse_git_diff(output: &str) -> Vec<GitDiffFile> {
    tugchanges_core::parse_unified_diff(output)
        .into_iter()
        .map(|f| {
            let hunks = if f.binary || f.status == tugchanges_core::DiffFileStatus::Added {
                Vec::new()
            } else {
                tugchanges_core::parse_hunks(&f.unified)
                    .into_iter()
                    .map(|h| h.id)
                    .collect()
            };
            GitDiffFile {
                path: f.path,
                old_path: f.old_path,
                status: map_diff_status(f.status),
                added: f.added,
                removed: f.removed,
                binary: f.binary,
                unified: f.unified,
                hunks,
            }
        })
        .collect()
}

/// Map `tugchanges_core`'s diff status to the `tugcast_core` wire enum.
fn map_diff_status(status: tugchanges_core::DiffFileStatus) -> GitDiffFileStatus {
    match status {
        tugchanges_core::DiffFileStatus::Added => GitDiffFileStatus::Added,
        tugchanges_core::DiffFileStatus::Modified => GitDiffFileStatus::Modified,
        tugchanges_core::DiffFileStatus::Deleted => GitDiffFileStatus::Deleted,
        tugchanges_core::DiffFileStatus::Renamed => GitDiffFileStatus::Renamed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // ── parse_git_log: the Tug trailer fields and the stripped body ──────────

    const SEP: char = LOG_FIELD_SEP;

    /// One `git log -z` record. Field order mirrors the `--format` string:
    /// sha, author, date, committer, email, committer date, subject, then the
    /// three Tug trailers, then the body.
    fn log_record(
        subject: &str,
        dash: &str,
        session: &str,
        session_id: &str,
        body: &str,
    ) -> String {
        [
            "0123456789abcdef0123456789abcdef01234567",
            "Ada",
            "2026-08-08",
            "Ada",
            "ada@example.com",
            "2026-08-08T09:30:00-07:00",
            subject,
            dash,
            session,
            session_id,
            body,
        ]
        .join(&SEP.to_string())
    }

    #[test]
    fn the_session_trailers_land_in_typed_fields_and_leave_the_body() {
        const FULL_ID: &str = "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
        let record = log_record(
            "add the thing",
            "",
            "stocky-pixie (f6e43925)",
            FULL_ID,
            &format!(
                "A real explanation\nover two lines.\n\nTug-Session: stocky-pixie (f6e43925)\nTug-Session-Id: {FULL_ID}\n"
            ),
        );
        let commits = parse_git_log(&format!("{record}\0"));
        assert_eq!(commits.len(), 1);
        let c = &commits[0];
        assert_eq!(c.tug_session.as_deref(), Some("stocky-pixie (f6e43925)"));
        assert_eq!(c.tug_session_id.as_deref(), Some(FULL_ID));
        // THE assertion the `splitn` widening exists for: left at 9, both
        // trailer values glue themselves onto the front of the body and this
        // fails loudly instead of shipping trailer ink under a green suite.
        assert_eq!(c.body, "A real explanation\nover two lines.");
        assert!(!c.body.contains("Tug-Session"));
        assert_eq!(c.subject, "add the thing");
    }

    #[test]
    fn a_legacy_one_line_trailer_parses_with_no_machine_id() {
        // Legacy commits carry `<display> (<full-uuid>)` and no id trailer;
        // they live in history forever and must still resolve.
        let legacy = "web (f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f)";
        let record = log_record(
            "old commit",
            "",
            legacy,
            "",
            &format!("Body text.\n\nTug-Session: {legacy}\n"),
        );
        let commits = parse_git_log(&format!("{record}\0"));
        assert_eq!(commits[0].tug_session.as_deref(), Some(legacy));
        assert_eq!(commits[0].tug_session_id, None);
        assert_eq!(commits[0].body, "Body text.");
    }

    #[test]
    fn body_stripping_keeps_prose_and_removes_interleaved_trailers() {
        // Trailers are supposed to be one final block; a hand-edited message
        // can interleave them, and a stray line left behind is the exact ink
        // the strip exists to remove.
        let record = log_record(
            "s",
            "tugdash/x onto main",
            "stocky-pixie (f6e43925)",
            "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
            "First line.\nTug-Session: stocky-pixie (f6e43925)\n\nSecond paragraph.\n\nTug-Dash: tugdash/x onto main\nTug-Session-Id: f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f\n",
        );
        let commits = parse_git_log(&format!("{record}\0"));
        assert_eq!(commits[0].body, "First line.\n\nSecond paragraph.");
        assert_eq!(
            commits[0].tug_dash.as_deref(),
            Some("tugdash/x onto main"),
            "Tug-Dash still lands as a typed field; only its body ink goes"
        );
    }

    #[test]
    fn a_commit_with_files_keeps_them_on_its_own_record() {
        // The widened record must not disturb how path chunks are filed: they
        // belong to the record that preceded them, and a subject-less record
        // still skips its paths rather than donating them to its predecessor.
        let good = log_record("first", "", "", "", "body");
        let malformed = format!("only{SEP}three{SEP}fields");
        let second = log_record("second", "", "", "", "");
        let stream = format!(
            "{good}\0\nsrc/a.rs\0src/b.rs\0{malformed}\0\norphan.rs\0{second}\0\nsrc/c.rs\0"
        );
        let commits = parse_git_log(&stream);
        assert_eq!(commits.len(), 2, "the malformed record is skipped");
        assert_eq!(commits[0].subject, "first");
        assert_eq!(commits[0].files, vec!["src/a.rs", "src/b.rs"]);
        assert_eq!(commits[1].subject, "second");
        assert_eq!(
            commits[1].files,
            vec!["src/c.rs"],
            "the skipped record's path never lands on a neighbour"
        );
    }

    #[test]
    fn a_body_with_no_trailers_is_untouched() {
        let record = log_record("s", "", "", "", "Just prose.\n\nAnd more.\n");
        let commits = parse_git_log(&format!("{record}\0"));
        assert_eq!(commits[0].body, "Just prose.\n\nAnd more.");
        assert_eq!(commits[0].tug_session, None);
        assert_eq!(commits[0].tug_session_id, None);
    }

    #[test]
    fn test_parse_typical_output() {
        let output = "\
# branch.oid abc123def456
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -1
1 M. N... 100644 100644 100644 hash1 hash2 src/main.rs
1 .M N... 100644 100644 100644 hash3 hash4 README.md
? temp.txt
";

        let status = parse_porcelain_v2(output);
        assert_eq!(status.branch, "main");
        assert_eq!(status.ahead, 2);
        assert_eq!(status.behind, 1);
        assert_eq!(status.head_sha, "abc123def456");
        assert_eq!(status.staged.len(), 1);
        assert_eq!(status.staged[0].path, "src/main.rs");
        assert_eq!(status.staged[0].status, "M");
        assert_eq!(status.unstaged.len(), 1);
        assert_eq!(status.unstaged[0].path, "README.md");
        assert_eq!(status.unstaged[0].status, "M");
        assert_eq!(status.untracked.len(), 1);
        assert_eq!(status.untracked[0], "temp.txt");
    }

    #[test]
    fn test_parse_detached_head() {
        let output = "\
# branch.oid abc123
# branch.head (detached)
";

        let status = parse_porcelain_v2(output);
        assert_eq!(status.branch, "(detached)");
        assert_eq!(status.head_sha, "abc123");
        assert_eq!(status.ahead, 0);
        assert_eq!(status.behind, 0);
        assert_eq!(status.staged.len(), 0);
        assert_eq!(status.unstaged.len(), 0);
        assert_eq!(status.untracked.len(), 0);
    }

    #[test]
    fn test_parse_clean_repo() {
        let output = "\
# branch.oid abc123
# branch.head main
";

        let status = parse_porcelain_v2(output);
        assert_eq!(status.branch, "main");
        assert_eq!(status.head_sha, "abc123");
        assert_eq!(status.ahead, 0);
        assert_eq!(status.behind, 0);
        assert_eq!(status.staged.len(), 0);
        assert_eq!(status.unstaged.len(), 0);
        assert_eq!(status.untracked.len(), 0);
    }

    #[test]
    fn test_parse_renamed_files() {
        let output = "\
# branch.oid abc123
# branch.head main
2 R. N... 100644 100644 100644 hash1 hash2 R100 new_name.rs\told_name.rs
";

        let status = parse_porcelain_v2(output);
        assert_eq!(status.staged.len(), 1);
        assert_eq!(status.staged[0].status, "R");
        assert_eq!(status.staged[0].path, "new_name.rs");
    }

    #[test]
    fn test_parse_ahead_behind() {
        let output = "\
# branch.oid abc123
# branch.head feature
# branch.ab +5 -3
";

        let status = parse_porcelain_v2(output);
        assert_eq!(status.ahead, 5);
        assert_eq!(status.behind, 3);
    }

    #[test]
    fn test_parse_no_upstream() {
        let output = "\
# branch.oid abc123
# branch.head feature
";

        let status = parse_porcelain_v2(output);
        assert_eq!(status.ahead, 0);
        assert_eq!(status.behind, 0);
    }

    #[test]
    fn test_parse_staged_and_unstaged_same_file() {
        let output = "\
# branch.oid abc123
# branch.head main
1 MM N... 100644 100644 100644 hash1 hash2 src/lib.rs
";

        let status = parse_porcelain_v2(output);
        assert_eq!(status.staged.len(), 1);
        assert_eq!(status.staged[0].path, "src/lib.rs");
        assert_eq!(status.staged[0].status, "M");
        assert_eq!(status.unstaged.len(), 1);
        assert_eq!(status.unstaged[0].path, "src/lib.rs");
        assert_eq!(status.unstaged[0].status, "M");
    }

    #[test]
    fn test_diff_comparison_skips_unchanged() {
        let status1 = GitStatus {
            branch: "main".to_string(),
            ahead: 0,
            behind: 0,
            staged: vec![],
            unstaged: vec![],
            untracked: vec![],
            head_sha: "abc123".to_string(),
            head_message: "Initial commit".to_string(),
        };

        let status2 = GitStatus {
            branch: "main".to_string(),
            ahead: 0,
            behind: 0,
            staged: vec![],
            unstaged: vec![],
            untracked: vec![],
            head_sha: "abc123".to_string(),
            head_message: "Initial commit".to_string(),
        };

        assert_eq!(status1, status2);

        let mut status3 = status1.clone();
        status3.ahead = 1;
        assert_ne!(status1, status3);
    }

    // -- is_within_git_worktree gate (skip git poll for non-repos) --

    #[tokio::test]
    async fn test_is_within_git_worktree_false_for_plain_dir() {
        let temp = TempDir::new().unwrap();
        assert!(!is_within_git_worktree(temp.path()).await);
    }

    #[tokio::test]
    async fn test_is_within_git_worktree_true_for_repo_and_subdir() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        git_in(repo, &["init"]).await;
        assert!(is_within_git_worktree(repo).await, "repo root");

        let sub = repo.join("a").join("b");
        fs::create_dir_all(&sub).unwrap();
        assert!(
            is_within_git_worktree(&sub).await,
            "a subdir of a repo must walk up to the ancestor .git",
        );
    }

    // -- git diff sourcing ([#step-10a]) --

    const MODIFIED: &str = "\
diff --git a/src/main.rs b/src/main.rs
index 1234567..89abcde 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,3 +1,4 @@
 fn main() {
-    println!(\"old\");
+    println!(\"new\");
+    println!(\"added\");
 }
";

    const ADDED: &str = "\
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3b18e51
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+line one
+line two
";

    const DELETED: &str = "\
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 3b18e51..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-bye one
-bye two
";

    const RENAMED_PURE: &str = "\
diff --git a/old_name.txt b/new_name.txt
similarity index 100%
rename from old_name.txt
rename to new_name.txt
";

    const RENAMED_EDITED: &str = "\
diff --git a/a.txt b/b.txt
similarity index 80%
rename from a.txt
rename to b.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/b.txt
@@ -1,2 +1,2 @@
 keep
-old line
+new line
";

    const BINARY: &str = "\
diff --git a/img.png b/img.png
index 1111111..2222222 100644
Binary files a/img.png and b/img.png differ
";

    #[test]
    fn test_parse_diff_modified() {
        let files = parse_git_diff(MODIFIED);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert_eq!(f.path, "src/main.rs");
        assert_eq!(f.old_path, None);
        assert_eq!(f.status, GitDiffFileStatus::Modified);
        assert_eq!(f.added, 2);
        assert_eq!(f.removed, 1);
        assert!(!f.binary);
        // The unified chunk is preserved verbatim (preamble through hunks).
        assert!(
            f.unified
                .starts_with("diff --git a/src/main.rs b/src/main.rs")
        );
        assert!(f.unified.contains("@@ -1,3 +1,4 @@"));
    }

    #[test]
    fn test_parse_diff_added() {
        let files = parse_git_diff(ADDED);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert_eq!(f.path, "new.txt");
        assert_eq!(f.status, GitDiffFileStatus::Added);
        assert_eq!(f.added, 2);
        assert_eq!(f.removed, 0);
    }

    #[test]
    fn test_hunk_ids_are_served_in_order_and_agree_with_the_library() {
        let two_hunk = "\
diff --git a/src/main.rs b/src/main.rs
index 1111111..2222222 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,3 +1,4 @@
 fn main() {
-    let a = 1;
+    let a = 2;
+    let b = 3;
 }
@@ -20,2 +21,2 @@
 fn other() {
-    old();
+    new();
";
        let files = parse_git_diff(two_hunk);
        let f = &files[0];
        let library = tugchanges_core::parse_hunks(&f.unified);
        assert_eq!(library.len(), 2);
        assert_eq!(
            f.hunks,
            library.iter().map(|h| h.id.clone()).collect::<Vec<_>>(),
            "the feed serves exactly the library's ids, in hunk order"
        );
    }

    #[test]
    fn test_no_hunk_ids_for_created_or_binary_files() {
        // A created file's diff is synthesized, not read from the index, so no
        // hunk of it is electable at landing time.
        assert!(parse_git_diff(ADDED)[0].hunks.is_empty());
        assert!(parse_git_diff(BINARY)[0].hunks.is_empty());
    }

    #[test]
    fn test_parse_diff_deleted() {
        let files = parse_git_diff(DELETED);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        // Path comes from the `--- a/…` side; `+++ /dev/null` is skipped.
        assert_eq!(f.path, "gone.txt");
        assert_eq!(f.status, GitDiffFileStatus::Deleted);
        assert_eq!(f.added, 0);
        assert_eq!(f.removed, 2);
    }

    #[test]
    fn test_parse_diff_renamed_pure() {
        let files = parse_git_diff(RENAMED_PURE);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert_eq!(f.path, "new_name.txt");
        assert_eq!(f.old_path.as_deref(), Some("old_name.txt"));
        assert_eq!(f.status, GitDiffFileStatus::Renamed);
        assert_eq!(f.added, 0);
        assert_eq!(f.removed, 0);
    }

    #[test]
    fn test_parse_diff_renamed_with_edits() {
        let files = parse_git_diff(RENAMED_EDITED);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert_eq!(f.path, "b.txt");
        assert_eq!(f.old_path.as_deref(), Some("a.txt"));
        assert_eq!(f.status, GitDiffFileStatus::Renamed);
        assert_eq!(f.added, 1);
        assert_eq!(f.removed, 1);
    }

    #[test]
    fn test_parse_diff_binary() {
        let files = parse_git_diff(BINARY);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        // No `---`/`+++` lines — path falls back to the `diff --git` header.
        assert_eq!(f.path, "img.png");
        assert_eq!(f.status, GitDiffFileStatus::Modified);
        assert!(f.binary);
        assert_eq!(f.added, 0);
        assert_eq!(f.removed, 0);
    }

    #[test]
    fn test_parse_diff_multifile_order_preserved() {
        let combined = format!("{MODIFIED}{ADDED}{DELETED}");
        let files = parse_git_diff(&combined);
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["src/main.rs", "new.txt", "gone.txt"]);
        assert_eq!(files[0].status, GitDiffFileStatus::Modified);
        assert_eq!(files[1].status, GitDiffFileStatus::Added);
        assert_eq!(files[2].status, GitDiffFileStatus::Deleted);
    }

    #[test]
    fn test_parse_diff_empty() {
        assert!(parse_git_diff("").is_empty());
    }

    /// Run a git subcommand in `repo`, asserting success.
    async fn git_in(repo: &Path, args: &[&str]) {
        let mut full = vec!["-C", repo.to_str().unwrap()];
        full.extend_from_slice(args);
        let out = Command::new("git").args(&full).output().await.unwrap();
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// Initialize a committed git repo with three tracked files.
    async fn init_diff_fixture_repo() -> TempDir {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().to_path_buf();
        git_in(&repo, &["init"]).await;
        git_in(&repo, &["config", "user.name", "test"]).await;
        git_in(&repo, &["config", "user.email", "test@test.com"]).await;
        fs::write(repo.join("keep.txt"), "v1\n").unwrap();
        fs::write(repo.join("del.txt"), "delete me\n").unwrap();
        fs::write(repo.join("ren_src.txt"), "rename me\n").unwrap();
        git_in(&repo, &["add", "-A"]).await;
        git_in(&repo, &["commit", "-m", "init"]).await;
        temp
    }

    #[tokio::test]
    async fn test_build_git_diff_snapshot_covers_all_statuses() {
        let temp = init_diff_fixture_repo().await;
        let repo = temp.path().to_path_buf();

        // Modify, delete, rename, and add — one of each status.
        fs::write(repo.join("keep.txt"), "v2\n").unwrap();
        git_in(&repo, &["rm", "del.txt"]).await;
        git_in(&repo, &["mv", "ren_src.txt", "ren_dst.txt"]).await;
        fs::write(repo.join("new.txt"), "fresh line\n").unwrap();
        git_in(&repo, &["add", "-A"]).await;

        let snapshot = build_git_diff_snapshot(&repo, "req-42".to_string(), "ws-key", &[]).await;

        assert_eq!(snapshot.request_id, "req-42");
        assert_eq!(snapshot.workspace_key, "ws-key");
        assert_eq!(snapshot.base, "HEAD");
        assert_eq!(snapshot.file_count, 4, "modify + delete + rename + add");
        assert_eq!(snapshot.file_count as usize, snapshot.files.len());

        let by_path = |p: &str| snapshot.files.iter().find(|f| f.path == p).unwrap();
        assert_eq!(by_path("keep.txt").status, GitDiffFileStatus::Modified);
        assert_eq!(by_path("new.txt").status, GitDiffFileStatus::Added);
        assert_eq!(by_path("del.txt").status, GitDiffFileStatus::Deleted);
        let renamed = by_path("ren_dst.txt");
        assert_eq!(renamed.status, GitDiffFileStatus::Renamed);
        assert_eq!(renamed.old_path.as_deref(), Some("ren_src.txt"));

        // Summary totals equal the sum across files (header == body).
        let summed_added: u32 = snapshot.files.iter().map(|f| f.added).sum();
        let summed_removed: u32 = snapshot.files.iter().map(|f| f.removed).sum();
        assert_eq!(snapshot.total_added, summed_added);
        assert_eq!(snapshot.total_removed, summed_removed);
    }

    #[tokio::test]
    async fn test_build_git_diff_snapshot_scoped_paths_narrow_the_diff() {
        let temp = init_diff_fixture_repo().await;
        let repo = temp.path().to_path_buf();

        // Two dirty tracked files; the pathspec selects exactly one.
        fs::write(repo.join("keep.txt"), "v2\n").unwrap();
        fs::write(repo.join("ren_src.txt"), "also changed\n").unwrap();

        let scoped = build_git_diff_snapshot(
            &repo,
            "req-scoped".to_string(),
            "ws",
            &["keep.txt".to_string()],
        )
        .await;
        assert_eq!(scoped.file_count, 1, "pathspec narrows to the one file");
        assert_eq!(scoped.files[0].path, "keep.txt");

        // Totals reflect only the scoped file.
        let whole = build_git_diff_snapshot(&repo, "req-whole".to_string(), "ws", &[]).await;
        assert_eq!(whole.file_count, 2, "empty pathspec keeps the whole tree");
        assert!(scoped.total_added <= whole.total_added);
    }

    #[tokio::test]
    async fn test_build_git_diff_snapshot_includes_untracked_files() {
        let temp = init_diff_fixture_repo().await;
        let repo = temp.path().to_path_buf();

        // One tracked modification and one untracked file — NOT `git add`ed,
        // so `git diff HEAD` alone would miss it.
        fs::write(repo.join("keep.txt"), "v2\n").unwrap();
        fs::write(repo.join("fresh.txt"), "line one\nline two\n").unwrap();

        let snapshot = build_git_diff_snapshot(&repo, "req-ut".to_string(), "ws", &[]).await;
        assert_eq!(snapshot.file_count, 2, "tracked change + untracked file");
        let fresh = snapshot
            .files
            .iter()
            .find(|f| f.path == "fresh.txt")
            .unwrap();
        assert_eq!(fresh.status, GitDiffFileStatus::Added);
        assert_eq!(fresh.added, 2);
        assert_eq!(fresh.removed, 0);
        assert!(fresh.unified.contains("+line one"));

        // A pathspec narrows untracked synthesis like any other path.
        let scoped = build_git_diff_snapshot(
            &repo,
            "req-ut-scoped".to_string(),
            "ws",
            &["fresh.txt".to_string()],
        )
        .await;
        assert_eq!(scoped.file_count, 1);
        assert_eq!(scoped.files[0].path, "fresh.txt");
    }

    #[tokio::test]
    async fn a_hash_that_names_no_commit_is_an_empty_snapshot_not_an_error() {
        let temp = init_diff_fixture_repo().await;
        let repo = temp.path().to_path_buf();

        // A session id's first eight hex digits, the shape the annotator
        // asks about most.
        let missing =
            build_commit_files_snapshot(&repo, "req-m".to_string(), "ws", "580990c5").await;
        assert!(!missing.no_repo);
        assert_eq!(missing.sha, "580990c5");
        assert!(missing.files.is_empty());
        assert!(missing.subject.is_empty());
        assert!(missing.author.is_empty());
        assert!(missing.date.is_empty());

        // The same call on a real sha still describes it.
        let sha = run_git_line(&repo, &["rev-parse", "HEAD"]).await.unwrap();
        let found = build_commit_files_snapshot(&repo, "req-f".to_string(), "ws", &sha).await;
        assert!(!found.subject.is_empty());
        assert!(!found.files.is_empty());
    }

    #[tokio::test]
    async fn test_build_commit_diff_snapshot_diffs_one_commit() {
        let temp = init_diff_fixture_repo().await;
        let repo = temp.path().to_path_buf();

        // A second commit: modify one file, add another.
        fs::write(repo.join("keep.txt"), "v2\n").unwrap();
        fs::write(repo.join("born.txt"), "hello\n").unwrap();
        git_in(&repo, &["add", "-A"]).await;
        git_in(&repo, &["commit", "-m", "second"]).await;
        let sha = run_git_line(&repo, &["rev-parse", "HEAD"]).await.unwrap();

        let snapshot =
            build_commit_diff_snapshot(&repo, "req-c".to_string(), "ws", &sha, &[]).await;
        assert_eq!(snapshot.base, sha);
        assert_eq!(snapshot.file_count, 2);
        let by_path = |p: &str| snapshot.files.iter().find(|f| f.path == p).unwrap();
        assert_eq!(by_path("keep.txt").status, GitDiffFileStatus::Modified);
        assert_eq!(by_path("born.txt").status, GitDiffFileStatus::Added);

        // A pathspec scopes the commit diff to one row's file.
        let scoped = build_commit_diff_snapshot(
            &repo,
            "req-c-scoped".to_string(),
            "ws",
            &sha,
            &["born.txt".to_string()],
        )
        .await;
        assert_eq!(scoped.file_count, 1);
        assert_eq!(scoped.files[0].path, "born.txt");

        // The root commit diffs against the empty tree (`--root`).
        let root_sha = run_git_line(&repo, &["rev-list", "--max-parents=0", "HEAD"])
            .await
            .unwrap();
        let root =
            build_commit_diff_snapshot(&repo, "req-root".to_string(), "ws", &root_sha, &[]).await;
        assert_eq!(root.file_count, 3, "the three files of the init commit");
        assert!(
            root.files
                .iter()
                .all(|f| f.status == GitDiffFileStatus::Added)
        );

        // A vanished sha degrades to an empty snapshot, not an error.
        let gone = build_commit_diff_snapshot(
            &repo,
            "req-gone".to_string(),
            "ws",
            "0000000000000000000000000000000000000000",
            &[],
        )
        .await;
        assert!(!gone.no_repo);
        assert_eq!(gone.file_count, 0);
    }

    #[tokio::test]
    async fn test_build_git_diff_snapshot_clean_tree_is_empty() {
        let temp = init_diff_fixture_repo().await;
        let snapshot =
            build_git_diff_snapshot(temp.path(), "req-clean".to_string(), "ws", &[]).await;
        assert!(!snapshot.no_repo, "a real repo is not flagged no_repo");
        assert_eq!(snapshot.file_count, 0);
        assert!(snapshot.files.is_empty());
        assert_eq!(snapshot.total_added, 0);
        assert_eq!(snapshot.total_removed, 0);
    }

    #[tokio::test]
    async fn test_build_git_diff_snapshot_non_repo_flags_no_repo() {
        // A plain dir (never `git init`ed) is flagged no_repo, not "clean".
        let temp = TempDir::new().unwrap();
        let snapshot =
            build_git_diff_snapshot(temp.path(), "req-norepo".to_string(), "ws", &[]).await;
        assert!(snapshot.no_repo, "a non-git dir must set no_repo");
        assert_eq!(snapshot.file_count, 0);
        assert!(snapshot.files.is_empty());
    }

    /// A repo on `main` with a base commit, a `tugdash/demo` branch that adds
    /// `round.txt` in a checked-out worktree under `.tug/worktrees/`, tracked worktree
    /// dirt on `keep.txt`, and a later main-only commit that must stay out of
    /// the dash range (merge-base semantics).
    ///
    /// Returns the dash worktree's **absolute** path, which is what the wire
    /// carries and what `build_dash_diff_snapshot` takes.
    async fn init_dash_fixture_repo() -> (TempDir, String) {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().to_path_buf();
        git_in(&repo, &["init", "-b", "main"]).await;
        git_in(&repo, &["config", "user.name", "test"]).await;
        git_in(&repo, &["config", "user.email", "test@test.com"]).await;
        fs::write(repo.join("keep.txt"), "base\n").unwrap();
        git_in(&repo, &["add", "-A"]).await;
        git_in(&repo, &["commit", "-m", "base"]).await;

        // The dash branch + its worktree under `.tug/worktrees/`.
        git_in(&repo, &["branch", "tugdash/demo"]).await;
        git_in(&repo, &["config", "branch.tugdash/demo.tugbase", "main"]).await;
        let worktree_rel = ".tug/worktrees/demo";
        git_in(&repo, &["worktree", "add", worktree_rel, "tugdash/demo"]).await;
        let worktree_abs = repo.join(worktree_rel);

        // One committed round in the worktree: add round.txt.
        fs::write(worktree_abs.join("round.txt"), "round\n").unwrap();
        git_in(&worktree_abs, &["add", "-A"]).await;
        git_in(&worktree_abs, &["commit", "-m", "round 1"]).await;

        // Tracked worktree dirt: modify keep.txt (uncommitted).
        fs::write(worktree_abs.join("keep.txt"), "base\ndirt\n").unwrap();

        // A later commit on main only — must NOT appear in the dash range.
        fs::write(repo.join("mainonly.txt"), "upstream\n").unwrap();
        git_in(&repo, &["add", "-A"]).await;
        git_in(&repo, &["commit", "-m", "main drift"]).await;

        (temp, worktree_abs.to_string_lossy().into_owned())
    }

    #[tokio::test]
    async fn test_build_dash_diff_snapshot_rounds_plus_dirt() {
        let (temp, worktree_abs) = init_dash_fixture_repo().await;
        let snapshot = build_dash_diff_snapshot(
            temp.path(),
            "req-dash".to_string(),
            "ws-key",
            &worktree_abs,
            "main",
            "tugdash/demo",
        )
        .await;

        assert!(!snapshot.no_repo);
        assert_eq!(snapshot.request_id, "req-dash");
        assert_eq!(
            snapshot.base, "main...tugdash/demo",
            "header carries the range"
        );
        let paths: Vec<&str> = snapshot.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"round.txt"), "committed round: {paths:?}");
        assert!(paths.contains(&"keep.txt"), "worktree dirt: {paths:?}");
        assert!(
            !paths.contains(&"mainonly.txt"),
            "upstream drift on base stays out (merge-base): {paths:?}"
        );
    }

    #[tokio::test]
    async fn test_build_dash_diff_snapshot_no_worktree_falls_back_to_committed_rounds() {
        let (temp, _worktree_abs) = init_dash_fixture_repo().await;
        // A worktree path that does not exist forces the committed-only fallback.
        let snapshot = build_dash_diff_snapshot(
            temp.path(),
            "req-dash-2".to_string(),
            "ws-key",
            "/nonexistent/tugtree/does-not-exist",
            "main",
            "tugdash/demo",
        )
        .await;

        let paths: Vec<&str> = snapshot.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            ["round.txt"],
            "committed round only, no dirt: {paths:?}"
        );
    }

    /// Asked from a *linked worktree* — the configuration `just app-debug`
    /// produces and every dash build is vetted on. The old shape joined the
    /// caller's root with a relative tail, which from here resolved to a path
    /// that does not exist and degraded silently to committed rounds. Worktree
    /// dirt in the file list is what falsifies that regression.
    #[tokio::test]
    async fn test_build_dash_diff_snapshot_from_a_linked_worktree_keeps_the_dirt() {
        let (temp, worktree_abs) = init_dash_fixture_repo().await;
        let repo = temp.path().to_path_buf();
        git_in(&repo, &["branch", "sidecar"]).await;
        git_in(
            &repo,
            &["worktree", "add", ".tug/worktrees/sidecar", "sidecar"],
        )
        .await;
        let asked_from = repo.join(".tug/worktrees/sidecar");

        let snapshot = build_dash_diff_snapshot(
            &asked_from,
            "req-dash-3".to_string(),
            "ws-key",
            &worktree_abs,
            "main",
            "tugdash/demo",
        )
        .await;

        let paths: Vec<&str> = snapshot.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"round.txt"), "committed round: {paths:?}");
        assert!(
            paths.contains(&"keep.txt"),
            "worktree dirt survives a worktree-hosted caller: {paths:?}"
        );
    }

    // -- git log sourcing (Git History Lens section) --

    /// A committed repo on `main` with three commits whose subjects are, oldest
    /// to newest, `first`/`second`/`third`.
    async fn init_log_fixture_repo() -> TempDir {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().to_path_buf();
        git_in(&repo, &["init", "-b", "main"]).await;
        git_in(&repo, &["config", "user.name", "Test Author"]).await;
        git_in(&repo, &["config", "user.email", "test@test.com"]).await;
        for subject in ["first", "second", "third"] {
            fs::write(repo.join(format!("{subject}.txt")), "x\n").unwrap();
            git_in(&repo, &["add", "-A"]).await;
            git_in(&repo, &["commit", "-m", subject]).await;
        }
        temp
    }

    #[tokio::test]
    async fn test_build_git_log_snapshot_recent_commits_most_recent_first() {
        let temp = init_log_fixture_repo().await;
        let snapshot =
            build_git_log_snapshot(temp.path(), "gl-1".to_string(), "ws-key", 0, 20).await;

        assert!(!snapshot.no_repo);
        assert_eq!(snapshot.request_id, "gl-1");
        assert_eq!(snapshot.workspace_key, "ws-key");
        assert_eq!(snapshot.branch, "main");
        let subjects: Vec<&str> = snapshot
            .commits
            .iter()
            .map(|c| c.subject.as_str())
            .collect();
        assert_eq!(subjects, ["third", "second", "first"], "most-recent-first");

        let head = &snapshot.commits[0];
        assert_eq!(head.sha.len(), 40, "full 40-char sha on the wire");
        assert!(head.sha.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(head.author, "Test Author");
        // `--date=short` → fixed-width YYYY-MM-DD.
        assert_eq!(head.date.len(), 10);
        assert_eq!(head.date.as_bytes()[4], b'-');
        assert_eq!(head.date.as_bytes()[7], b'-');
    }

    #[tokio::test]
    async fn test_build_git_log_snapshot_honors_limit() {
        let temp = init_log_fixture_repo().await;
        let snapshot = build_git_log_snapshot(temp.path(), "gl-2".to_string(), "ws", 0, 2).await;
        let subjects: Vec<&str> = snapshot
            .commits
            .iter()
            .map(|c| c.subject.as_str())
            .collect();
        assert_eq!(subjects, ["third", "second"], "the newest two only");
        assert_eq!(snapshot.offset, 0);
        assert!(snapshot.has_more, "`first` is still past this page");
    }

    #[tokio::test]
    async fn test_build_git_log_snapshot_pages_by_offset() {
        let temp = init_log_fixture_repo().await;

        // Page two picks up exactly where page one stopped — no overlap, no gap.
        let page2 = build_git_log_snapshot(temp.path(), "gl-p2".to_string(), "ws", 2, 2).await;
        let subjects: Vec<&str> = page2.commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, ["first"], "the third commit back, alone");
        assert_eq!(page2.offset, 2, "the request's offset is echoed");
        assert!(!page2.has_more, "the root commit ends the walk");

        // Paging past the end is empty, not an error.
        let past = build_git_log_snapshot(temp.path(), "gl-p3".to_string(), "ws", 99, 2).await;
        assert!(past.commits.is_empty());
        assert!(!past.has_more);
        assert_eq!(past.offset, 99);
    }

    #[tokio::test]
    async fn test_build_git_log_snapshot_has_more_false_at_exact_boundary() {
        // A page that ends flush with the root commit has nothing after it —
        // the probe commit is what proves that, not arithmetic on the count.
        let temp = init_log_fixture_repo().await;
        let snapshot = build_git_log_snapshot(temp.path(), "gl-b".to_string(), "ws", 0, 3).await;
        assert_eq!(snapshot.commits.len(), 3);
        assert!(!snapshot.has_more);
    }

    #[tokio::test]
    async fn test_build_git_log_snapshot_carries_changed_paths() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().to_path_buf();
        git_in(&repo, &["init", "-b", "main"]).await;
        git_in(&repo, &["config", "user.name", "Test Author"]).await;
        git_in(&repo, &["config", "user.email", "test@test.com"]).await;

        fs::write(repo.join("alpha.txt"), "a\n").unwrap();
        git_in(&repo, &["add", "-A"]).await;
        git_in(&repo, &["commit", "-m", "add alpha"]).await;

        fs::create_dir(repo.join("src")).unwrap();
        fs::write(repo.join("src/beta.rs"), "b\n").unwrap();
        fs::write(repo.join("alpha.txt"), "a2\n").unwrap();
        git_in(&repo, &["add", "-A"]).await;
        // A multi-line body sits between the record and its path list — the
        // parser must not read its lines as paths.
        git_in(
            &repo,
            &["commit", "-m", "add beta", "-m", "with a body\nover lines"],
        )
        .await;

        git_in(&repo, &["commit", "--allow-empty", "-m", "nothing"]).await;

        let snapshot = build_git_log_snapshot(&repo, "gl-f".to_string(), "ws", 0, 20).await;
        let by_subject: Vec<(&str, Vec<&str>)> = snapshot
            .commits
            .iter()
            .map(|c| {
                (
                    c.subject.as_str(),
                    c.files.iter().map(String::as_str).collect(),
                )
            })
            .collect();
        assert_eq!(
            by_subject,
            [
                ("nothing", vec![]),
                ("add beta", vec!["alpha.txt", "src/beta.rs"]),
                ("add alpha", vec!["alpha.txt"]),
            ],
        );
        assert_eq!(
            snapshot.commits[1].body, "with a body\nover lines",
            "the body survives the path stream intact"
        );
    }

    #[tokio::test]
    async fn test_build_git_log_snapshot_empty_repo_is_not_no_repo() {
        // Fresh `git init` (unborn HEAD): a real repo with no commits.
        let temp = TempDir::new().unwrap();
        git_in(temp.path(), &["init", "-b", "trunk"]).await;
        let snapshot = build_git_log_snapshot(temp.path(), "gl-3".to_string(), "ws", 0, 20).await;
        assert!(
            !snapshot.no_repo,
            "an initialized repo is not flagged no_repo"
        );
        assert!(snapshot.commits.is_empty(), "no commits yet");
        assert_eq!(
            snapshot.branch, "trunk",
            "unborn branch name still resolves"
        );
    }

    #[tokio::test]
    async fn test_build_git_log_snapshot_non_repo_flags_no_repo() {
        let temp = TempDir::new().unwrap();
        let snapshot = build_git_log_snapshot(temp.path(), "gl-4".to_string(), "ws", 0, 20).await;
        assert!(snapshot.no_repo);
        assert!(snapshot.commits.is_empty());
        assert_eq!(snapshot.branch, "");
        assert!(!snapshot.has_more, "a non-repo has nothing more to page");
    }

    #[tokio::test]
    async fn test_build_git_log_snapshot_detached_head() {
        let temp = init_log_fixture_repo().await;
        let repo = temp.path();
        let head = run_git_line(repo, &["rev-parse", "HEAD"]).await.unwrap();
        git_in(repo, &["checkout", &head]).await;
        let snapshot = build_git_log_snapshot(repo, "gl-5".to_string(), "ws", 0, 20).await;
        assert_eq!(snapshot.branch, "(detached)");
        assert_eq!(
            snapshot.commits.len(),
            3,
            "commits still resolve when detached"
        );
    }

    #[tokio::test]
    async fn test_build_git_log_snapshot_unicode_author_and_empty_subject() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().to_path_buf();
        git_in(&repo, &["init", "-b", "main"]).await;
        git_in(&repo, &["config", "user.email", "u@x.com"]).await;
        // A unicode author name and an empty subject must parse without a
        // column shift (the `%x1f` separator keeps fields aligned).
        fs::write(repo.join("a.txt"), "x\n").unwrap();
        git_in(&repo, &["add", "-A"]).await;
        git_in(
            &repo,
            &[
                "-c",
                "user.name=Ünïcode Nàme",
                "commit",
                "--allow-empty-message",
                "-m",
                "",
            ],
        )
        .await;

        let snapshot = build_git_log_snapshot(&repo, "gl-6".to_string(), "ws", 0, 20).await;
        assert_eq!(snapshot.commits.len(), 1);
        assert_eq!(snapshot.commits[0].author, "Ünïcode Nàme");
        assert_eq!(snapshot.commits[0].subject, "", "empty subject stays empty");
        assert_eq!(snapshot.commits[0].sha.len(), 40);
    }

    /// The id-agreement contract, crossing the boundary it protects: the ids
    /// the wire serves to the deck's checkboxes must equal, element for
    /// element, the ids the landing engine computes when it filters the patch.
    ///
    /// The two run git through different process libraries against different
    /// bases, so nothing but this test says they agree. Both spellings carry
    /// `HUNK_DIFF_FLAGS`; that is what makes the equality hold.
    /// A repo whose `wide.txt` is dirty in two regions far enough apart that
    /// git emits two hunks — edits ~60 lines apart, since git merges hunks
    /// whose gap is within twice the context width.
    async fn init_two_hunk_repo() -> TempDir {
        let temp = TempDir::new().unwrap();
        let repo = temp.path().to_path_buf();
        git_in(&repo, &["init"]).await;
        git_in(&repo, &["config", "user.name", "test"]).await;
        git_in(&repo, &["config", "user.email", "test@test.com"]).await;

        let base: String = (1..=120).map(|n| format!("line {n}\n")).collect();
        fs::write(repo.join("wide.txt"), &base).unwrap();
        git_in(&repo, &["add", "-A"]).await;
        git_in(&repo, &["commit", "-m", "init"]).await;

        let dirty: String = (1..=120)
            .map(|n| match n {
                20 | 90 => format!("line {n} CHANGED\n"),
                _ => format!("line {n}\n"),
            })
            .collect();
        fs::write(repo.join("wide.txt"), &dirty).unwrap();
        temp
    }

    /// Assert the two readers produce the same ids for `wide.txt`.
    async fn assert_hunk_ids_agree(repo: &Path) {
        let wire = fetch_git_diff_with_untracked(repo, &[])
            .await
            .expect("wire diff");
        let wire_file = parse_git_diff(&wire)
            .into_iter()
            .find(|f| f.path == "wide.txt")
            .expect("the dirty file is on the wire");
        let engine_ids: Vec<String> = tugchanges_core::file_hunks(repo, "wide.txt")
            .expect("engine hunks")
            .into_iter()
            .map(|h| h.id)
            .collect();

        assert_eq!(engine_ids.len(), 2, "two well-separated edits, two hunks");
        assert_eq!(
            wire_file.hunks, engine_ids,
            "the wire's ids and the engine's ids are one contract"
        );
    }

    #[tokio::test]
    async fn hunk_ids_agree_across_the_wire_and_engine_boundary() {
        let temp = init_two_hunk_repo().await;
        assert_hunk_ids_agree(temp.path()).await;
    }

    /// The same agreement under a configured external diff driver — the
    /// condition `--no-ext-diff` exists for. A driver emits text that is not a
    /// unified diff at all, so a reader missing the flag produces no ids
    /// rather than different ones.
    #[cfg(unix)]
    #[tokio::test]
    async fn hunk_ids_agree_under_an_external_diff_driver() {
        use std::os::unix::fs::PermissionsExt;

        let temp = init_two_hunk_repo().await;
        let repo = temp.path().to_path_buf();
        let driver = repo.join("noisy-diff.sh");
        fs::write(&driver, "#!/bin/sh\necho 'not a unified diff at all'\n").unwrap();
        fs::set_permissions(&driver, fs::Permissions::from_mode(0o755)).unwrap();
        git_in(
            &repo,
            &["config", "diff.external", driver.to_str().unwrap()],
        )
        .await;

        assert_hunk_ids_agree(&repo).await;
    }
}
