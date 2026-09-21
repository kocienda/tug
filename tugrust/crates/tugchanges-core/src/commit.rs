//! The `commit` operation — stage → commit → structured receipt ([P04]/[P05]).
//!
//! `commit` can no longer silently narrow the working tree ([P03]). With no
//! explicit disposition, a dirty tree carrying **unattributed** files (dirty,
//! no ledger rows anywhere — [P01]) is a refusal: [`commit`] returns
//! [`CommitError::UnattributedPresent`] and commits nothing. The disposition
//! flags on [`CommitOptions`] resolve it (Table T01): `include_unattributed`
//! folds them in, `leave_unattributed` proceeds without them (the receipt's
//! `left_behind` then names them), `tree` commits the whole dirty tree except
//! foreign-claimed paths, and `paths` overrides everything with an explicit set
//! (the Session card's commit button takes this path, so it never hits the
//! refusal). `all` adds shared files (paths other sessions also hold live
//! rows for) to the non-`--tree` sets.
//!
//! Staging is by construction: `git add -- <files>` then
//! `git commit -m <message> -- <files>` — never `git add .` — so anything else
//! already in the index stays out of the commit, and the receipt can't disagree
//! with what was staged. `hunks` elects a subset of one file's hunks and
//! switches staging into the [P07] mode: a clean index is required, elected
//! files are staged by piping a filtered patch to `git apply --cached`, and the
//! commit takes no pathspec (a pathspec commits working-tree content, which
//! would drag the unelected hunks in).
//!
//! The result is a structured [`CommitReceipt`] (Spec S03), not scraped text,
//! with a raw `numstat` field retained as the transition bridge ([Q01]) and a
//! `left_behind` bucket list (Spec S04).

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::changes::{ChangesOptions, resolve_changes};
use crate::git::{self, FileStat, repo_root_for};
use crate::hunks::{HunkDrift, file_diff_hunks, file_header, filtered_patch};

/// Options for [`commit`]. `message` is required. Disposition precedence
/// ([P04], Table T01): `paths` > `tree` > (`include_unattributed` /
/// `leave_unattributed` / `all`). Without `paths` or `tree`, the base set is the
/// session's non-shared attributed changes; `all` adds shared ones;
/// `include_unattributed` adds unattributed ones; `leave_unattributed`
/// acknowledges unattributed files and proceeds without them.
#[derive(Debug, Clone, Default)]
pub struct CommitOptions {
    pub session: Option<String>,
    pub project: Option<PathBuf>,
    pub message: String,
    pub paths: Option<Vec<String>>,
    pub all: bool,
    pub include_unattributed: bool,
    pub leave_unattributed: bool,
    pub tree: bool,
    /// Per-path hunk election: repo-relative path → the ids of the hunks to
    /// land ([P06] identity). Every key must also be in the resolved file set.
    /// Absent or empty means whole-file staging for everything — the pathspec
    /// path this module has always taken.
    pub hunks: Option<BTreeMap<String, Vec<String>>>,
}

/// The typed outcome of a failed [`commit`] (Spec S03). `UnattributedPresent` is
/// the [P03] refusal the CLI maps to **exit 3** — distinct from a real error
/// (exit 1) and session resolution (exit 2) — so a caller can branch on it
/// without sniffing strings. `Other` is every real error (git/sqlite/io/blank
/// message).
#[derive(Debug, Clone)]
pub enum CommitError {
    /// Unattributed dirty files were present with no explicit disposition —
    /// nothing was committed. Carries the offending repo-relative paths.
    UnattributedPresent { paths: Vec<String> },
    /// An elected hunk is no longer in the file's diff — the content moved
    /// under the election. Nothing was staged and nothing committed.
    HunkDrift { path: String, ids: Vec<String> },
    /// A real error (git/sqlite/io/blank message) — exit 1.
    Other(String),
}

impl CommitError {
    /// Whether this is the [P03] refusal (exit 3) rather than a real error.
    pub fn is_refusal(&self) -> bool {
        matches!(self, CommitError::UnattributedPresent { .. })
    }
}

impl fmt::Display for CommitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CommitError::UnattributedPresent { paths } => write!(
                f,
                "{} unattributed dirty file(s) present with no disposition: {}",
                paths.len(),
                paths.join(", ")
            ),
            CommitError::HunkDrift { path, ids } => {
                write!(f, "hunk drift: {path} no longer has {}", ids.join(", "))
            }
            CommitError::Other(msg) => write!(f, "{msg}"),
        }
    }
}

impl From<String> for CommitError {
    fn from(msg: String) -> Self {
        CommitError::Other(msg)
    }
}

/// Roll-up totals across the committed files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Aggregate {
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
}

/// Still-dirty files per bucket after the commit lands (Spec S04). Empty vectors
/// when the tree is clean. A partial commit is visible here immediately.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct LeftBehind {
    pub unattributed: Vec<String>,
    pub foreign: Vec<String>,
    pub shared: Vec<String>,
}

/// The structured commit receipt (Spec S03). `numstat` is the raw
/// `git show --numstat --format= HEAD` text, kept as the compatibility bridge
/// until the deck consumes `files` directly ([Q01]). `left_behind` names the
/// still-dirty files per bucket after the commit (Spec S04).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommitReceipt {
    pub sha: String,
    pub branch: String,
    pub message: String,
    pub files: Vec<FileStat>,
    pub aggregate: Aggregate,
    pub numstat: String,
    pub left_behind: LeftBehind,
}

/// Run the `commit` operation (Spec S03). Refuses unattributed files with no
/// disposition ([P03] — [`CommitError::UnattributedPresent`], nothing
/// committed), an empty file set, and a blank message; other errors carry git's
/// stderr so the caller can surface the real reason.
pub fn commit(opts: CommitOptions) -> Result<CommitReceipt, CommitError> {
    if opts.message.trim().is_empty() {
        return Err(CommitError::Other("empty commit message".to_string()));
    }

    let (repo_root, files) = derive_file_set(&opts)?;
    if files.is_empty() {
        return Err(CommitError::Other("no files selected".to_string()));
    }

    let elections = normalize_elections(opts.hunks.as_ref(), &files)?;
    stage_and_commit(&repo_root, &files, &opts.message, &elections)?;
    let mut receipt = build_receipt(&repo_root, &opts.message).map_err(CommitError::Other)?;
    receipt.left_behind = compute_left_behind(&opts);
    Ok(receipt)
}

/// Resolve the repo root and the repo-relative file set to commit, per the
/// disposition matrix (Table T01). `paths` wins outright (bypasses bucketing).
/// `tree` commits everything dirty but foreign. Otherwise the base is the
/// session's non-shared attributed files (`all` adds shared);
/// `include_unattributed` folds unattributed in, and if unattributed files are
/// present with neither `include_unattributed` nor `leave_unattributed`, refuse
/// ([P03]) — even when the attributed set is empty.
fn derive_file_set(opts: &CommitOptions) -> Result<(PathBuf, Vec<String>), CommitError> {
    if let Some(paths) = &opts.paths {
        let project_dir = match &opts.project {
            Some(p) => p.clone(),
            None => std::env::current_dir()
                .map_err(|e| CommitError::Other(format!("cannot resolve cwd: {e}")))?,
        };
        return Ok((repo_root_for(&project_dir), paths.clone()));
    }

    let resolved = resolve_changes(&ChangesOptions {
        session: opts.session.clone(),
        project: opts.project.clone(),
        all: false,
        diff: false,
    })
    .map_err(|e| CommitError::Other(e.to_string()))?;

    let attributed: Vec<(String, bool)> = resolved
        .files
        .iter()
        .map(|f| (f.path.clone(), f.shared))
        .collect();
    let unattributed: Vec<String> = resolved
        .unattributed
        .iter()
        .map(|c| c.path.clone())
        .collect();

    let files = select_from_buckets(&attributed, &unattributed, opts)?;
    Ok((resolved.repo_root, files))
}

/// Apply the disposition matrix (Table T01) to already-classified buckets —
/// pure flag precedence, no git or ledger. `attributed` pairs each path with its
/// `shared` bit; `foreign` is never passed (never committed except via
/// explicit `--paths`, handled upstream). `--tree` takes the whole dirty set
/// (attributed ∪ unattributed ∪ shared); otherwise the base is non-shared
/// attributed (`all` adds shared), `include_unattributed` folds unattributed
/// in, and unattributed present with neither `include_unattributed` nor
/// `leave_unattributed` is the [P03] refusal — even when the base set is empty.
fn select_from_buckets(
    attributed: &[(String, bool)],
    unattributed: &[String],
    opts: &CommitOptions,
) -> Result<Vec<String>, CommitError> {
    if opts.tree {
        let mut files: Vec<String> = attributed.iter().map(|(p, _)| p.clone()).collect();
        files.extend(unattributed.iter().cloned());
        return Ok(files);
    }

    let mut files: Vec<String> = attributed
        .iter()
        .filter(|(_, shared)| opts.all || !shared)
        .map(|(p, _)| p.clone())
        .collect();

    if opts.include_unattributed {
        files.extend(unattributed.iter().cloned());
    } else if !unattributed.is_empty() && !opts.leave_unattributed {
        return Err(CommitError::UnattributedPresent {
            paths: unattributed.to_vec(),
        });
    }

    Ok(files)
}

/// Re-run the [P02] bucketing after the commit and list every still-dirty path
/// per bucket (Spec S04). Best-effort: if the session can't be resolved (a
/// `--paths` commit with no session, as the Session card issues), the buckets
/// are all empty rather than an error.
fn compute_left_behind(opts: &CommitOptions) -> LeftBehind {
    match resolve_changes(&ChangesOptions {
        session: opts.session.clone(),
        project: opts.project.clone(),
        all: false,
        diff: false,
    }) {
        Ok(resolved) => LeftBehind {
            unattributed: resolved
                .unattributed
                .iter()
                .map(|c| c.path.clone())
                .collect(),
            foreign: resolved.foreign.iter().map(|f| f.path.clone()).collect(),
            shared: resolved
                .files
                .iter()
                .filter(|f| f.shared)
                .map(|f| f.path.clone())
                .collect(),
        },
        Err(_) => LeftBehind::default(),
    }
}

/// Stage exactly `files` and commit exactly them: `git add -- <files>` then
/// `git commit -m <message> -- <files>`. The `-- <files>` pathspec on both keeps
/// anything else already in the index out of the commit.
///
/// Two shapes need the pathspecs adjusted before either step runs, or the
/// commit aborts or lands wrong:
///
/// * A path whose deletion is **already staged** is gone from both the worktree
///   and the index, so `git add -- <it>` matches nothing and exits 128
///   (`pathspec … did not match any files`), failing the whole commit. Such
///   paths are dropped from the `add` pathspec — the index already holds their
///   removal, and the `commit` pathspec still carries them, so the deletion
///   lands.
/// * A **staged rename**'s source path is not in `files` (the ledger names the
///   destination), so committing the destination alone records an addition and
///   strands the source's deletion in the index. Rename sources whose
///   destination is in `files` join the `commit` pathspec, and the commit
///   records the rename.
///
/// When any file carries a hunk election the shape changes ([P07]): the index
/// must start clean, the elected files are staged by piping a filtered patch to
/// `git apply --cached`, and the commit runs with **no** pathspec — a pathspec
/// would commit working-tree content for those paths and drag the unelected
/// hunks in with it. See [`stage_partial_and_commit`].
fn stage_and_commit(
    repo_root: &Path,
    files: &[String],
    message: &str,
    elections: &BTreeMap<String, BTreeSet<String>>,
) -> Result<(), CommitError> {
    if !elections.is_empty() {
        return stage_partial_and_commit(repo_root, files, message, elections);
    }

    let stageable = stageable_paths(repo_root, files);
    if !stageable.is_empty() {
        let mut add_args: Vec<&str> = vec!["add", "--"];
        add_args.extend(stageable.iter().map(String::as_str));
        run_git_step(repo_root, &add_args, "git add failed")?;
    }

    let commit_paths = with_rename_sources(repo_root, files);
    let mut commit_args: Vec<&str> = vec!["commit", "-m", message, "--"];
    commit_args.extend(commit_paths.iter().map(String::as_str));
    run_git_step(repo_root, &commit_args, "git commit failed")?;
    Ok(())
}

/// Validate the caller's hunk map against the resolved file set and drop the
/// no-op cases, so the staging code sees only genuine partial elections.
///
/// A key naming a path outside `files`, or electing no hunks at all, is a
/// caller bug rather than drift — it would make the receipt disagree with the
/// request, so it is refused up front.
fn normalize_elections(
    hunks: Option<&BTreeMap<String, Vec<String>>>,
    files: &[String],
) -> Result<BTreeMap<String, BTreeSet<String>>, CommitError> {
    let Some(hunks) = hunks else {
        return Ok(BTreeMap::new());
    };
    let mut out: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (path, ids) in hunks {
        if !files.iter().any(|f| f == path) {
            return Err(CommitError::Other(format!(
                "hunk election names {path}, which is not in the commit's file set"
            )));
        }
        if ids.is_empty() {
            return Err(CommitError::Other(format!(
                "hunk election for {path} selects no hunks"
            )));
        }
        out.insert(path.clone(), ids.iter().cloned().collect());
    }
    Ok(out)
}

/// The partial-staging branch ([P07]).
///
/// Every filtered patch is built *before* anything is staged, so drift is a
/// clean refusal that never touched the index. Staging then runs whole-file
/// paths through `git add` and elected paths through `git apply --cached`; if
/// any step after that fails, the whole staged set — whole-file paths included
/// — is reset, or our own residue would trip the next attempt's index-clean
/// precondition.
fn stage_partial_and_commit(
    repo_root: &Path,
    files: &[String],
    message: &str,
    elections: &BTreeMap<String, BTreeSet<String>>,
) -> Result<(), CommitError> {
    require_clean_index(repo_root)?;

    let tracked = tracked_paths(repo_root, files);
    let mut patches: Vec<(&String, String)> = Vec::new();
    for (path, selected) in elections {
        if !tracked.contains(path) {
            return Err(CommitError::Other(format!(
                "{path} is not tracked; a created file has no electable hunks and stages whole or not at all"
            )));
        }
        let (diff, parsed) = file_diff_hunks(repo_root, path).map_err(CommitError::Other)?;
        let patch =
            filtered_patch(&file_header(&diff), &parsed, selected).map_err(|e| match e {
                HunkDrift::Missing(ids) => CommitError::HunkDrift {
                    path: path.clone(),
                    ids,
                },
                HunkDrift::EmptySelection => CommitError::HunkDrift {
                    path: path.clone(),
                    ids: selected.iter().cloned().collect(),
                },
            })?;
        patches.push((path, patch));
    }

    let whole: Vec<String> = files
        .iter()
        .filter(|f| !elections.contains_key(*f))
        .cloned()
        .collect();
    let stageable = stageable_paths(repo_root, &whole);
    if !stageable.is_empty() {
        let mut add_args: Vec<&str> = vec!["add", "--"];
        add_args.extend(stageable.iter().map(String::as_str));
        run_git_step(repo_root, &add_args, "git add failed").inspect_err(|_| {
            reset_index(repo_root, files);
        })?;
    }

    for (path, patch) in &patches {
        if let Err(e) = git_apply_cached(repo_root, patch) {
            reset_index(repo_root, files);
            return Err(CommitError::Other(format!(
                "git apply --cached failed for {path}: {e}"
            )));
        }
    }

    run_git_step(repo_root, &["commit", "-m", message], "git commit failed").inspect_err(|_| {
        reset_index(repo_root, files);
    })?;
    Ok(())
}

/// Refuse unless the index holds nothing, naming what is staged. Partial
/// staging commits the whole index without a pathspec, so pre-existing staged
/// content would silently ride along in the receipt's blind spot.
fn require_clean_index(repo_root: &Path) -> Result<(), CommitError> {
    let output =
        git::git_output(repo_root, &["diff", "--cached", "--quiet"]).map_err(CommitError::Other)?;
    if output.status.success() {
        return Ok(());
    }
    let staged = git::git_stdout(repo_root, &["diff", "--cached", "--name-only"])
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    Err(CommitError::Other(format!(
        "hunk election needs a clean index; these paths are already staged:\n{staged}"
    )))
}

/// Which of `files` git already tracks. An untracked path has no diff against
/// the index, so no hunk of it can be elected ([P07]).
fn tracked_paths(repo_root: &Path, files: &[String]) -> BTreeSet<String> {
    let mut ls_args: Vec<&str> = vec!["ls-files", "--"];
    ls_args.extend(files.iter().map(String::as_str));
    match git::git_stdout(repo_root, &ls_args) {
        Ok(out) => out.lines().map(str::to_string).collect(),
        Err(_) => files.iter().cloned().collect(),
    }
}

/// Whether any hunk in `patch` carries no context lines. `git apply` refuses
/// a zero-context hunk without `--unidiff-zero`, and a machine with
/// `diff.context = 0` produces nothing else — the flag is passed exactly when
/// the patch needs it, keeping git's context checks on everywhere they can
/// run.
fn patch_has_zero_context_hunk(patch: &str) -> bool {
    let mut in_hunk = false;
    let mut hunk_has_context = false;
    for line in patch.lines() {
        if line.starts_with("@@") {
            if in_hunk && !hunk_has_context {
                return true;
            }
            in_hunk = true;
            hunk_has_context = false;
        } else if in_hunk {
            if line.starts_with(' ') {
                hunk_has_context = true;
            } else if !line.starts_with('+') && !line.starts_with('-') && !line.starts_with('\\') {
                // A new file header ends the current hunk.
                if !hunk_has_context {
                    return true;
                }
                in_hunk = false;
            }
        }
    }
    in_hunk && !hunk_has_context
}

/// Pipe `patch` to `git apply --cached`, returning git's stderr on refusal.
fn git_apply_cached(repo_root: &Path, patch: &str) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut args: Vec<&str> = vec!["apply", "--cached"];
    if patch_has_zero_context_hunk(patch) {
        args.push("--unidiff-zero");
    }
    args.push("-");
    let mut child = tugcore::git_command()
        .arg("-C")
        .arg(repo_root)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to execute git apply: {e}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "git apply stdin unavailable".to_string())?
        .write_all(patch.as_bytes())
        .map_err(|e| format!("failed to write patch to git apply: {e}"))?;
    let output = child
        .wait_with_output()
        .map_err(|e| format!("git apply did not complete: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if detail.is_empty() {
        "git apply --cached failed".to_string()
    } else {
        detail
    })
}

/// Unstage `paths`, best-effort — this runs on a failure path whose real error
/// is the one worth reporting.
fn reset_index(repo_root: &Path, paths: &[String]) {
    let mut args: Vec<&str> = vec!["reset", "--quiet", "--"];
    args.extend(paths.iter().map(String::as_str));
    let _ = git::git_output(repo_root, &args);
}

/// The subset of `files` `git add` can match: present in the worktree, or still
/// tracked in the index (a worktree-only deletion, whose removal `add` stages).
/// A path in neither is an already-staged deletion — see [`stage_and_commit`].
fn stageable_paths(repo_root: &Path, files: &[String]) -> Vec<String> {
    let mut ls_args: Vec<&str> = vec!["ls-files", "--"];
    ls_args.extend(files.iter().map(String::as_str));
    let tracked: Vec<String> = match git::git_stdout(repo_root, &ls_args) {
        Ok(out) => out.lines().map(str::to_string).collect(),
        // Can't tell — stage everything, as before.
        Err(_) => return files.to_vec(),
    };

    files
        .iter()
        .filter(|path| repo_root.join(path).exists() || tracked.iter().any(|t| t == *path))
        .cloned()
        .collect()
}

/// `files` plus the source path of every staged rename whose destination is in
/// `files` — see [`stage_and_commit`]. Best-effort: a failing `git diff` leaves
/// the set untouched.
fn with_rename_sources(repo_root: &Path, files: &[String]) -> Vec<String> {
    let Ok(name_status) = git::git_stdout(
        repo_root,
        &["diff", "--cached", "--name-status", "--find-renames"],
    ) else {
        return files.to_vec();
    };

    let mut paths = files.to_vec();
    for line in name_status.lines() {
        let mut fields = line.split('\t');
        let Some(status) = fields.next() else {
            continue;
        };
        if !status.starts_with('R') {
            continue;
        }
        let (Some(source), Some(destination)) = (fields.next(), fields.next()) else {
            continue;
        };
        if files.iter().any(|f| f == destination) && !paths.iter().any(|p| p == source) {
            paths.push(source.to_string());
        }
    }
    paths
}

/// Run one git step, mapping a non-zero exit to its stderr detail (or `fallback`
/// when stderr is empty).
fn run_git_step(repo_root: &Path, args: &[&str], fallback: &str) -> Result<(), String> {
    let output = git::git_output(repo_root, args)?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if detail.is_empty() {
        fallback.to_string()
    } else {
        detail
    })
}

/// Assemble the [`CommitReceipt`] for the just-made HEAD commit: sha, branch,
/// the raw `--numstat` text plus its parsed `files` (statuses joined from
/// `--name-status`), and aggregate totals.
fn build_receipt(repo_root: &Path, message: &str) -> Result<CommitReceipt, String> {
    let sha = git::git_stdout(repo_root, &["rev-parse", "HEAD"])?
        .trim()
        .to_string();
    let branch = git::git_stdout(repo_root, &["branch", "--show-current"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let numstat = git::git_stdout(repo_root, &["show", "--numstat", "--format=", "HEAD"])?;
    let name_status = git::git_stdout(repo_root, &["show", "--name-status", "--format=", "HEAD"])?;

    let files = git::file_stats(&numstat, &name_status);
    let insertions: u32 = files.iter().map(|f| f.added.unwrap_or(0)).sum();
    let deletions: u32 = files.iter().map(|f| f.deleted.unwrap_or(0)).sum();
    let aggregate = Aggregate {
        files_changed: files.len() as u32,
        insertions,
        deletions,
    };

    Ok(CommitReceipt {
        sha,
        branch,
        message: message.to_string(),
        files,
        aggregate,
        numstat,
        // Filled by `commit` after the bucketing re-run (Spec S04).
        left_behind: LeftBehind::default(),
    })
}

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

    fn init_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        git(root, &["init", "-q", "-b", "main"]);
        git(root, &["config", "user.email", "t@t.test"]);
        git(root, &["config", "user.name", "t"]);
        std::fs::write(root.join("base.txt"), "base\n").unwrap();
        git(root, &["add", "base.txt"]);
        git(root, &["commit", "-q", "-m", "init"]);
        dir
    }

    #[test]
    fn commits_only_listed_files_and_receipt_matches_numstat() {
        let repo = init_repo();
        let root = repo.path();
        // Two edited files plus a third dirty file that must stay out.
        std::fs::write(root.join("a.txt"), "a1\na2\n").unwrap();
        std::fs::write(root.join("b.txt"), "b1\n").unwrap();
        std::fs::write(root.join("c.txt"), "c-untouched\n").unwrap();

        let opts = CommitOptions {
            project: Some(root.to_path_buf()),
            message: "commit a and b".to_string(),
            paths: Some(vec!["a.txt".to_string(), "b.txt".to_string()]),
            ..Default::default()
        };
        let receipt = commit(opts).expect("commit succeeds");

        assert_eq!(receipt.sha.len(), 40);
        assert_eq!(receipt.branch, "main");
        assert_eq!(receipt.message, "commit a and b");

        // Receipt files match `git show --numstat` — a.txt (created, 2 added)
        // and b.txt (created, 1 added).
        let by_path = |p: &str| receipt.files.iter().find(|f| f.path == p).unwrap();
        assert_eq!(receipt.files.len(), 2);
        assert_eq!(by_path("a.txt").status, "created");
        assert_eq!(by_path("a.txt").added, Some(2));
        assert_eq!(by_path("b.txt").added, Some(1));
        assert_eq!(receipt.aggregate.files_changed, 2);
        assert_eq!(receipt.aggregate.insertions, 3);

        // The numstat text lists exactly the two committed files.
        let numstat_paths: Vec<&str> = receipt
            .numstat
            .lines()
            .filter_map(|l| l.split('\t').nth(2))
            .collect();
        assert_eq!(numstat_paths, ["a.txt", "b.txt"]);

        // c.txt stayed untracked (out of the commit).
        let status = git::git_stdout(root, &["status", "--porcelain"]).unwrap();
        assert!(status.contains("?? c.txt"), "c.txt untouched: {status}");
    }

    #[test]
    fn empty_message_and_empty_file_set_each_error() {
        let repo = init_repo();
        let root = repo.path();

        // Blank message.
        let err = commit(CommitOptions {
            project: Some(root.to_path_buf()),
            message: "   ".to_string(),
            paths: Some(vec!["base.txt".to_string()]),
            ..Default::default()
        })
        .unwrap_err();
        assert!(err.to_string().contains("empty commit message"), "{err}");

        // Empty explicit file set.
        let err = commit(CommitOptions {
            project: Some(root.to_path_buf()),
            message: "x".to_string(),
            paths: Some(vec![]),
            ..Default::default()
        })
        .unwrap_err();
        assert!(err.to_string().contains("no files selected"), "{err}");
    }

    #[test]
    fn modified_and_deleted_statuses_land_in_receipt() {
        let repo = init_repo();
        let root = repo.path();
        std::fs::write(root.join("base.txt"), "base\nmore\n").unwrap();
        std::fs::write(root.join("gone.txt"), "temp\n").unwrap();
        git(root, &["add", "gone.txt"]);
        git(root, &["commit", "-q", "-m", "add gone"]);
        std::fs::remove_file(root.join("gone.txt")).unwrap();

        let receipt = commit(CommitOptions {
            project: Some(root.to_path_buf()),
            message: "modify base, delete gone".to_string(),
            paths: Some(vec!["base.txt".to_string(), "gone.txt".to_string()]),
            ..Default::default()
        })
        .expect("commit");

        let by_path = |p: &str| receipt.files.iter().find(|f| f.path == p).unwrap();
        assert_eq!(by_path("base.txt").status, "modified");
        assert_eq!(by_path("gone.txt").status, "deleted");
        assert_eq!(by_path("gone.txt").added, Some(0));
        assert_eq!(by_path("gone.txt").deleted, Some(1));
    }

    #[test]
    fn already_staged_deletion_commits_instead_of_aborting_the_add() {
        let repo = init_repo();
        let root = repo.path();
        std::fs::write(root.join("gone.txt"), "temp\n").unwrap();
        git(root, &["add", "gone.txt"]);
        git(root, &["commit", "-q", "-m", "add gone"]);
        // `git rm` stages the removal: the path is in neither the worktree nor
        // the index, so `git add -- gone.txt` alone would exit 128.
        git(root, &["rm", "-q", "gone.txt"]);
        std::fs::write(root.join("base.txt"), "base\nmore\n").unwrap();

        let receipt = commit(CommitOptions {
            project: Some(root.to_path_buf()),
            message: "modify base, drop gone".to_string(),
            paths: Some(vec!["base.txt".to_string(), "gone.txt".to_string()]),
            ..Default::default()
        })
        .expect("commit");

        let by_path = |p: &str| receipt.files.iter().find(|f| f.path == p).unwrap();
        assert_eq!(by_path("base.txt").status, "modified");
        assert_eq!(by_path("gone.txt").status, "deleted");
        let status = git::git_stdout(root, &["status", "--porcelain"]).unwrap();
        assert!(
            status.trim().is_empty(),
            "tree clean after commit: {status}"
        );
    }

    #[test]
    fn staged_rename_commits_its_source_deletion_too() {
        let repo = init_repo();
        let root = repo.path();
        std::fs::write(root.join("old.txt"), "one\ntwo\nthree\n").unwrap();
        git(root, &["add", "old.txt"]);
        git(root, &["commit", "-q", "-m", "add old"]);
        git(root, &["mv", "old.txt", "new.txt"]);
        std::fs::write(root.join("new.txt"), "one\ntwo\nthree\nfour\n").unwrap();

        // The ledger names only the destination — the source rides along.
        let receipt = commit(CommitOptions {
            project: Some(root.to_path_buf()),
            message: "rename old to new".to_string(),
            paths: Some(vec!["new.txt".to_string()]),
            ..Default::default()
        })
        .expect("commit");

        assert_eq!(receipt.files.len(), 1);
        assert_eq!(receipt.files[0].path, "new.txt");
        let status = git::git_stdout(root, &["status", "--porcelain"]).unwrap();
        assert!(
            status.trim().is_empty(),
            "tree clean after commit: {status}"
        );
    }

    #[test]
    fn error_carries_git_stderr() {
        let repo = init_repo();
        let root = repo.path();
        let err = commit(CommitOptions {
            project: Some(root.to_path_buf()),
            message: "msg".to_string(),
            paths: Some(vec!["no-such-file.txt".to_string()]),
            ..Default::default()
        })
        .unwrap_err();
        assert!(
            err.to_string().contains("no-such-file.txt"),
            "stderr detail: {err}"
        );
    }

    // --- Table T01 disposition matrix (pure `select_from_buckets`) ------------
    // These cover every flag row without a git/ledger round-trip; the CLI
    // integration suite (`changes_cli.rs`) proves the exit codes end-to-end.

    fn attributed(paths: &[(&str, bool)]) -> Vec<(String, bool)> {
        paths.iter().map(|(p, a)| (p.to_string(), *a)).collect()
    }

    fn opts_with(f: impl FnOnce(&mut CommitOptions)) -> CommitOptions {
        let mut o = CommitOptions {
            message: "m".to_string(),
            ..Default::default()
        };
        f(&mut o);
        o
    }

    #[test]
    fn default_refuses_when_unattributed_present_even_with_empty_base() {
        let att = attributed(&[]);
        let un = vec!["u1.rs".to_string(), "u2.rs".to_string()];
        let err = select_from_buckets(&att, &un, &opts_with(|_| {})).unwrap_err();
        match err {
            CommitError::UnattributedPresent { paths } => {
                assert_eq!(paths, vec!["u1.rs".to_string(), "u2.rs".to_string()]);
            }
            other => panic!("expected refusal, got {other}"),
        }
    }

    #[test]
    fn default_commits_attributed_non_shared_when_no_unattributed() {
        let att = attributed(&[("a.rs", false), ("shared.rs", true)]);
        let files = select_from_buckets(&att, &[], &opts_with(|_| {})).unwrap();
        assert_eq!(files, vec!["a.rs".to_string()]);
    }

    #[test]
    fn all_adds_shared_to_the_base() {
        let att = attributed(&[("a.rs", false), ("shared.rs", true)]);
        let files = select_from_buckets(&att, &[], &opts_with(|o| o.all = true)).unwrap();
        assert_eq!(files, vec!["a.rs".to_string(), "shared.rs".to_string()]);
    }

    #[test]
    fn include_unattributed_folds_them_in() {
        let att = attributed(&[("a.rs", false)]);
        let un = vec!["u.rs".to_string()];
        let files =
            select_from_buckets(&att, &un, &opts_with(|o| o.include_unattributed = true)).unwrap();
        assert_eq!(files, vec!["a.rs".to_string(), "u.rs".to_string()]);
    }

    #[test]
    fn leave_unattributed_proceeds_without_them() {
        let att = attributed(&[("a.rs", false)]);
        let un = vec!["u.rs".to_string()];
        let files =
            select_from_buckets(&att, &un, &opts_with(|o| o.leave_unattributed = true)).unwrap();
        // Attributed only — the held-back file surfaces later in `left_behind`.
        assert_eq!(files, vec!["a.rs".to_string()]);
    }

    #[test]
    fn tree_takes_the_whole_dirty_set_including_shared() {
        let att = attributed(&[("a.rs", false), ("shared.rs", true)]);
        let un = vec!["u.rs".to_string()];
        let files = select_from_buckets(&att, &un, &opts_with(|o| o.tree = true)).unwrap();
        assert_eq!(
            files,
            vec![
                "a.rs".to_string(),
                "shared.rs".to_string(),
                "u.rs".to_string()
            ]
        );
    }

    #[test]
    fn tree_and_paths_dispositions_land_a_real_commit() {
        // End-to-end through git (no ledger): `--paths` commits exactly its set,
        // and the receipt now carries an (empty, no-session) `left_behind`.
        let repo = init_repo();
        let root = repo.path();
        std::fs::write(root.join("x.txt"), "x\n").unwrap();
        let receipt = commit(CommitOptions {
            project: Some(root.to_path_buf()),
            message: "add x".to_string(),
            paths: Some(vec!["x.txt".to_string()]),
            ..Default::default()
        })
        .expect("commit");
        assert_eq!(receipt.files.len(), 1);
        assert_eq!(receipt.left_behind, LeftBehind::default());
    }

    // ── hunk-elected landing ([P07]) ───────────────────────────────────────

    fn git_out(root: &Path, args: &[&str]) -> String {
        let out = tugcore::git_command()
            .args(args)
            .current_dir(root)
            .output()
            .expect("git");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// Commit `f.txt` with 60 numbered lines, then dirty it in three regions
    /// far enough apart that git emits three hunks. Returns the edited text.
    fn seed_three_hunk_file(root: &Path, name: &str) -> String {
        let original: String = (1..=60).map(|n| format!("line{n}\n")).collect();
        std::fs::write(root.join(name), &original).unwrap();
        git(root, &["add", name]);
        git(root, &["commit", "-q", "-m", "seed"]);
        let edited = original
            .replace("line2\n", "line2\nINSERTED-A\n")
            .replace("line30\n", "CHANGED-B\n")
            .replace("line58\n", "");
        std::fs::write(root.join(name), &edited).unwrap();
        edited
    }

    fn hunk_ids(root: &Path, path: &str) -> Vec<String> {
        let (diff, hunks) = file_diff_hunks(root, path).expect("file diff");
        let ids: Vec<String> = hunks.into_iter().map(|h| h.id).collect();
        assert_eq!(ids.len(), 3, "expected three hunks; diff was: {diff}");
        ids
    }

    #[test]
    fn file_hunks_on_a_clean_path_is_empty_not_an_error() {
        let repo = init_repo();
        assert_eq!(
            crate::hunks::file_hunks(repo.path(), "base.txt"),
            Ok(Vec::new()),
            "no changes is an empty list, not a failure"
        );
    }

    fn elect(path: &str, ids: &[&str]) -> Option<BTreeMap<String, Vec<String>>> {
        let mut map = BTreeMap::new();
        map.insert(
            path.to_string(),
            ids.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        );
        Some(map)
    }

    #[test]
    fn elected_hunk_lands_alone_and_the_rest_stays_dirty() {
        let repo = init_repo();
        let root = repo.path();
        let edited = seed_three_hunk_file(root, "f.txt");
        let ids = hunk_ids(root, "f.txt");

        let receipt = commit(CommitOptions {
            project: Some(root.to_path_buf()),
            message: "land the middle hunk".to_string(),
            paths: Some(vec!["f.txt".to_string()]),
            hunks: elect("f.txt", &[&ids[1]]),
            ..Default::default()
        })
        .expect("partial commit succeeds");

        assert_eq!(receipt.files.len(), 1);
        let shown = git_out(root, &["show", "--no-color", "HEAD"]);
        assert!(shown.contains("+CHANGED-B"), "commit was: {shown}");
        assert!(!shown.contains("INSERTED-A"), "commit was: {shown}");
        assert!(!shown.contains("-line58"), "commit was: {shown}");

        // The working tree still carries all three edits, so the unelected two
        // are still dirty.
        assert_eq!(std::fs::read_to_string(root.join("f.txt")).unwrap(), edited);
        let after = git_out(root, &["diff", "--no-color", "--", "f.txt"]);
        assert!(after.contains("INSERTED-A"), "worktree diff was: {after}");
        assert!(after.contains("-line58"), "worktree diff was: {after}");
        assert!(!after.contains("CHANGED-B"), "worktree diff was: {after}");
        assert!(git_out(root, &["diff", "--cached", "--name-only"]).is_empty());
    }

    /// `diff.context = 0` makes every diff zero-context, which `git apply`
    /// refuses without `--unidiff-zero` — a machine-config setting must not
    /// brick partial landing.
    #[test]
    fn elected_hunk_lands_under_zero_context_config() {
        let repo = init_repo();
        let root = repo.path();
        git(root, &["config", "diff.context", "0"]);
        seed_three_hunk_file(root, "f.txt");
        let (_, hunks) = file_diff_hunks(root, "f.txt").expect("file diff");
        // With no context, "CHANGED-B" is its own hunk wherever it falls.
        let target = hunks
            .iter()
            .find(|h| h.body.contains("CHANGED-B"))
            .expect("a hunk holds the middle edit")
            .id
            .clone();

        let receipt = commit(CommitOptions {
            project: Some(root.to_path_buf()),
            message: "land the middle hunk, zero context".to_string(),
            paths: Some(vec!["f.txt".to_string()]),
            hunks: elect("f.txt", &[&target]),
            ..Default::default()
        })
        .expect("zero-context partial commit succeeds");

        assert_eq!(receipt.files.len(), 1);
        let shown = git_out(root, &["show", "--no-color", "HEAD"]);
        assert!(shown.contains("+CHANGED-B"), "commit was: {shown}");
        assert!(!shown.contains("INSERTED-A"), "commit was: {shown}");
        assert!(git_out(root, &["diff", "--cached", "--name-only"]).is_empty());
    }

    #[test]
    fn a_whole_file_and_a_partial_file_land_together() {
        let repo = init_repo();
        let root = repo.path();
        seed_three_hunk_file(root, "f.txt");
        std::fs::write(root.join("whole.txt"), "all of me\n").unwrap();
        let ids = hunk_ids(root, "f.txt");

        commit(CommitOptions {
            project: Some(root.to_path_buf()),
            message: "mixed landing".to_string(),
            paths: Some(vec!["f.txt".to_string(), "whole.txt".to_string()]),
            hunks: elect("f.txt", &[&ids[0]]),
            ..Default::default()
        })
        .expect("mixed commit succeeds");

        let shown = git_out(root, &["show", "--no-color", "--name-only", "HEAD"]);
        assert!(shown.contains("f.txt"));
        assert!(shown.contains("whole.txt"));
        let body = git_out(root, &["show", "--no-color", "HEAD"]);
        assert!(body.contains("+INSERTED-A"), "commit was: {body}");
        assert!(body.contains("+all of me"), "commit was: {body}");
        assert!(!body.contains("CHANGED-B"), "commit was: {body}");
    }

    #[test]
    fn drift_refuses_and_leaves_the_index_untouched() {
        let repo = init_repo();
        let root = repo.path();
        seed_three_hunk_file(root, "f.txt");
        // A second, whole-file path so the refusal has to unwind a mixed set.
        std::fs::write(root.join("whole.txt"), "all of me\n").unwrap();

        let head_before = git_out(root, &["rev-parse", "HEAD"]);
        let err = commit(CommitOptions {
            project: Some(root.to_path_buf()),
            message: "elect a hunk that moved".to_string(),
            paths: Some(vec!["f.txt".to_string(), "whole.txt".to_string()]),
            hunks: elect("f.txt", &["0000000000000000"]),
            ..Default::default()
        })
        .expect_err("drift refuses");

        match err {
            CommitError::HunkDrift { path, ids } => {
                assert_eq!(path, "f.txt");
                assert_eq!(ids, vec!["0000000000000000".to_string()]);
            }
            other => panic!("expected HunkDrift, got {other:?}"),
        }
        assert_eq!(git_out(root, &["rev-parse", "HEAD"]), head_before);
        assert!(
            git_out(root, &["diff", "--cached", "--name-only"]).is_empty(),
            "a refusal must leave nothing staged"
        );
    }

    #[test]
    fn a_dirty_index_refuses_a_hunk_election() {
        let repo = init_repo();
        let root = repo.path();
        seed_three_hunk_file(root, "f.txt");
        let ids = hunk_ids(root, "f.txt");
        std::fs::write(root.join("preexisting.txt"), "staged by hand\n").unwrap();
        git(root, &["add", "preexisting.txt"]);

        let err = commit(CommitOptions {
            project: Some(root.to_path_buf()),
            message: "land the middle hunk".to_string(),
            paths: Some(vec!["f.txt".to_string()]),
            hunks: elect("f.txt", &[&ids[1]]),
            ..Default::default()
        })
        .expect_err("a dirty index refuses");
        let detail = err.to_string();
        assert!(detail.contains("clean index"), "detail was: {detail}");
        assert!(detail.contains("preexisting.txt"), "detail was: {detail}");
    }

    #[test]
    fn a_created_file_has_no_electable_hunks() {
        let repo = init_repo();
        let root = repo.path();
        std::fs::write(root.join("brand-new.txt"), "one\ntwo\n").unwrap();

        let err = commit(CommitOptions {
            project: Some(root.to_path_buf()),
            message: "elect a hunk of a created file".to_string(),
            paths: Some(vec!["brand-new.txt".to_string()]),
            hunks: elect("brand-new.txt", &["0000000000000000"]),
            ..Default::default()
        })
        .expect_err("an untracked path refuses");
        assert!(err.to_string().contains("not tracked"), "detail was: {err}");
        assert!(git_out(root, &["diff", "--cached", "--name-only"]).is_empty());
    }

    #[test]
    fn an_election_outside_the_file_set_refuses() {
        let repo = init_repo();
        let root = repo.path();
        seed_three_hunk_file(root, "f.txt");

        let err = commit(CommitOptions {
            project: Some(root.to_path_buf()),
            message: "elect a path we are not committing".to_string(),
            paths: Some(vec!["f.txt".to_string()]),
            hunks: elect("elsewhere.txt", &["0000000000000000"]),
            ..Default::default()
        })
        .expect_err("an out-of-set election refuses");
        assert!(
            err.to_string().contains("not in the commit's file set"),
            "detail was: {err}"
        );
    }

    #[test]
    fn an_empty_election_refuses() {
        let repo = init_repo();
        let root = repo.path();
        seed_three_hunk_file(root, "f.txt");

        let err = commit(CommitOptions {
            project: Some(root.to_path_buf()),
            message: "elect nothing".to_string(),
            paths: Some(vec!["f.txt".to_string()]),
            hunks: elect("f.txt", &[]),
            ..Default::default()
        })
        .expect_err("an empty election refuses");
        assert!(
            err.to_string().contains("selects no hunks"),
            "detail was: {err}"
        );
    }
}
