//! The workshop — one stable worktree per dash where a join is materialized.
//!
//! The ladder ([`crate::resolve`]) works a conflict as three blobs at a time,
//! off to the side, and that is enough for a re-merge but not for an agent: a
//! renamed symbol reconciled against a new call site needs the neighbors, and a
//! build needs a tree. The workshop is that tree — `git merge --no-commit
//! --no-ff` performed for real, with markers in the files and stages in the
//! index, in a checkout nobody is looking at.
//!
//! **It is one stable worktree per dash, not a nonce per resolve, and that is
//! economics rather than taste.** A fresh worktree carries no `node_modules`,
//! so a typecheck or a bundle fails outright; a cold `target/`, so a
//! `cargo check` is a full dependency build; and — sharpest — a *detached*
//! worktree's app-test slug is `detached-<sha8>`, which changes with every
//! candidate, so each verification run would land in fresh DerivedData and
//! rebuild the whole app. A stable branch name gives a stable slug, which keeps
//! DerivedData, `target/`, `node_modules/`, and `dist/` warm across candidates.
//!
//! The branch lives in its own namespace, `tugworkshop/<name>`, and that is
//! load-bearing: every dash surface enumerates dashes by globbing
//! `refs/heads/tugdash/` — four sites in [`crate::ops`], the changesets feed's
//! dash-entry derivation, and the agent supervisor — so a workshop branch
//! *inside* that namespace would render as a phantom dash row on every
//! recompute. Outside it, the exclusion is by construction rather than by a
//! filter each surface must remember.
//!
//! Hydration is the project's own `[tugtool.dash].post_create` hooks, run once
//! at creation through the same [`crate::ops`] path a dash worktree uses. This
//! module knows no project's toolchain; what a verification tier needs beyond
//! those hooks is that tier's declared command to arrange.

use std::path::{Path, PathBuf};

use tugutil_core::worktree::sanitize_branch_name;

use crate::ops::{
    branch_exists, branch_name, dash_base, git_output, git_stdout, main_repo_root, run_post_create,
};
use crate::resolve::commit_tree;

/// The branch a dash's workshop is checked out on — deliberately **not** under
/// `refs/heads/tugdash/`, which every dash surface globs.
pub fn workshop_branch(name: &str) -> String {
    format!("tugworkshop/{}", sanitize_branch_name(name))
}

/// A dash's workshop path: `<repo>/.tug/workshops/<sanitized-name>`, beside the
/// dash worktree home so one ignore rule covers both.
pub fn workshop_path(repo: &Path, name: &str) -> PathBuf {
    repo.join(".tug")
        .join("workshops")
        .join(sanitize_branch_name(name))
}

/// A dash's workshop worktree, open at some tree.
///
/// Held by value for the duration of one resolve or one verification run;
/// dropping it leaves the worktree in place, because the warmth is the point.
/// Only [`remove`] tears one down.
pub struct Workshop {
    repo: PathBuf,
    name: String,
    path: PathBuf,
    branch: String,
    /// The base head the workshop was reset to when it opened — the parent a
    /// candidate commit takes, matching the ladder's own candidate shape.
    base_head: String,
}

impl Workshop {
    /// The workshop checkout's absolute path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The workshop's branch — `tugworkshop/<name>`.
    pub fn branch(&self) -> &str {
        &self.branch
    }

    /// The base head this workshop opened against.
    pub fn base_head(&self) -> &str {
        &self.base_head
    }

    /// Materialize the real merge: reset to the base head, then
    /// `git merge --no-commit --no-ff <dash-branch>`.
    ///
    /// A conflicting merge is the expected case, so the merge's exit status is
    /// not an error — the conflict markers and index stages it leaves behind
    /// are the whole product. Only a failure to *reach* that state is an error.
    pub fn open_merge(repo: &Path, name: &str) -> Result<Self, String> {
        let ws = Self::ensure(repo, name)?;
        ws.reset_to(&ws.base_head)?;
        let dash_branch = branch_name(name);
        let _ = git_output(&ws.path, &["merge", "--no-commit", "--no-ff", &dash_branch]);
        Ok(ws)
    }

    /// Open a workshop **without touching its tree** — for a caller that is
    /// working the tree an earlier `open_*` left, across a task boundary.
    ///
    /// The reset every other opener performs is what makes them safe to call
    /// cold; this one is the opposite promise, and exists because the resolver's
    /// edits live in the worktree between the turn that made them and the
    /// commit that captures them.
    pub fn open_existing(repo: &Path, name: &str) -> Result<Self, String> {
        Self::ensure(repo, name)
    }

    /// Reset the workshop to an existing candidate, so commands can run against
    /// the tree a join would produce.
    pub fn open_candidate(repo: &Path, name: &str, sha: &str) -> Result<Self, String> {
        let ws = Self::ensure(repo, name)?;
        ws.reset_to(sha)?;
        Ok(ws)
    }

    /// Write the workshop's working tree as a candidate commit parented on the
    /// base head — the same shape the ladder's candidate has, so
    /// [`crate::ops::join_in`] fast-forwards onto it unchanged.
    ///
    /// **Refuses a tree that still carries conflict markers**, and that is the
    /// check that matters rather than the index's.
    ///
    /// Whoever works this tree edits files; nobody stages. The resolver in
    /// particular has no shell and no git by charter, so an unmerged index at
    /// this point says nothing about whether the work was done — staging is
    /// this method's own first act. What a resolution cannot survive is
    /// markers left in the content, which is exactly what a worker that
    /// reported done without touching anything leaves behind.
    pub fn commit(&self, message: &str) -> Result<String, String> {
        let out = git_output(&self.path, &["add", "-A"])?;
        if !out.status.success() {
            return Err(format!(
                "workshop add failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        // Only what this candidate would actually change is scanned — a
        // whole-tree read would cost the project's size on every pass to
        // re-answer a question about a handful of files.
        let touched: Vec<String> = git_stdout(
            &self.path,
            &["diff", "--cached", "--name-only", &self.base_head],
        )?
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
        let markers = self.marker_paths(&touched);
        if !markers.is_empty() {
            return Err(format!(
                "the merge is unfinished — conflict markers remain in {}",
                markers.join(", ")
            ));
        }

        let tree = git_stdout(&self.path, &["write-tree"])?;
        commit_tree(&self.repo, &tree, &self.base_head, message)
    }

    /// Check the named paths out of a tree the ladder already built, staging
    /// them — which both writes the reconciled content and clears each path's
    /// conflict stages from the index.
    ///
    /// This is how the ladder's work reaches the resolver instead of being
    /// thrown away: a `rerere` replay or a driver resolution the machines
    /// already earned arrives as settled content, and the resolver's job over
    /// it is the audit ([P10]) rather than the merge.
    ///
    /// Paths that are not in the tree are skipped rather than failed — a
    /// resolution the ladder recorded for a path the merge later dropped is a
    /// mismatch to leave to the resolver, not a reason to refuse the workshop.
    pub fn apply_staged(&self, tree: &str, paths: &[String]) -> Result<(), String> {
        for path in paths {
            let _ = git_output(&self.path, &["checkout", tree, "--", path]);
        }
        Ok(())
    }

    /// The paths still holding conflict stages — what the resolver must finish.
    pub fn unresolved(&self) -> Result<Vec<String>, String> {
        Ok(
            git_stdout(&self.path, &["diff", "--name-only", "--diff-filter=U"])?
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect(),
        )
    }

    /// Which of the named paths still carry conflict markers in their content.
    ///
    /// The index answering "resolved" is not the same question: `git add` on a
    /// file whose markers were never removed clears the stages and leaves the
    /// markers, which is precisely what a resolver that did nothing but say it
    /// was done would produce.
    pub fn marker_paths(&self, paths: &[String]) -> Vec<String> {
        paths
            .iter()
            .filter(|path| {
                let Ok(bytes) = std::fs::read(self.path.join(path)) else {
                    return false;
                };
                String::from_utf8_lossy(&bytes).lines().any(|l| {
                    l.starts_with("<<<<<<<")
                        || l.starts_with("=======")
                        || l.starts_with(">>>>>>>")
                        || l.starts_with("|||||||")
                })
            })
            .cloned()
            .collect()
    }

    /// Return the workshop to a clean base checkout and leave it hydrated.
    ///
    /// Best-effort by design: a workshop that fails to reset is reset again by
    /// the next `open_*`, which is the same code path.
    pub fn release(&self) {
        let _ = self.reset_to(&self.base_head);
    }

    // -- internals ----------------------------------------------------------

    /// The workshop, created and hydrated if it is not already there.
    fn ensure(repo: &Path, name: &str) -> Result<Self, String> {
        let repo_root = main_repo_root(repo);
        ensure_tug_ignored(&repo_root);

        let path = workshop_path(&repo_root, name);
        let branch = workshop_branch(name);
        let base = dash_base(&repo_root, name)?;
        let base_head = git_stdout(&repo_root, &["rev-parse", &base])?;

        let ws = Self {
            repo: repo_root.clone(),
            name: name.to_string(),
            path: path.clone(),
            branch: branch.clone(),
            base_head,
        };

        if ws.is_live() {
            return Ok(ws);
        }

        // A half-built leftover — a directory git no longer lists, or a branch
        // with no worktree — is swept rather than worked around, so the created
        // path is the only path that can produce a live workshop.
        let mut ignored = Vec::new();
        remove(&repo_root, name, &mut ignored);

        let out = git_output(
            &repo_root,
            &[
                "worktree",
                "add",
                &path.to_string_lossy(),
                "-b",
                &branch,
                &ws.base_head,
            ],
        )?;
        if !out.status.success() {
            return Err(format!(
                "failed to create workshop for {}: {}",
                name,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }

        // Hydrate once, through the same hooks a dash worktree runs. A failure
        // rolls the workshop back so a retry creates cleanly rather than
        // reusing a half-hydrated tree forever.
        if let Err(e) = run_post_create(&repo_root, &path) {
            let mut ignored = Vec::new();
            remove(&repo_root, name, &mut ignored);
            return Err(e);
        }

        Ok(ws)
    }

    /// Whether the workshop is a checkout git currently lists at our path.
    fn is_live(&self) -> bool {
        if !self.path.join(".git").exists() {
            return false;
        }
        // Compared canonically, never as strings. `git worktree list` prints
        // the resolved path, so a repo sited under a symlink — every macOS
        // tempdir, and plenty of real checkouts — would never match its own
        // workshop, and `ensure` would tear the workshop down and rebuild it on
        // every open. That is the precise opposite of the stability this whole
        // design is built on: the warm `target/`, `node_modules/`, and
        // DerivedData would be discarded before every verification.
        let Ok(want) = self.path.canonicalize() else {
            return false;
        };
        git_stdout(&self.repo, &["worktree", "list", "--porcelain"])
            .map(|list| {
                list.lines()
                    .filter_map(|l| l.strip_prefix("worktree "))
                    .any(|p| {
                        std::path::Path::new(p.trim())
                            .canonicalize()
                            .is_ok_and(|p| p == want)
                    })
            })
            .unwrap_or(false)
    }

    /// Return the workshop to `commitish`, discarding everything a previous use
    /// left behind — but **not** ignored build outputs, which are the warmth
    /// this whole design exists to keep (`clean -fd`, never `-x`).
    fn reset_to(&self, commitish: &str) -> Result<(), String> {
        // A merge left mid-flight by an interrupted resolve outlives the
        // process; `reset --hard` alone would leave `MERGE_HEAD` standing.
        let _ = git_output(&self.path, &["merge", "--abort"]);
        let out = git_output(&self.path, &["reset", "--hard", commitish])?;
        if !out.status.success() {
            return Err(format!(
                "failed to reset workshop for {}: {}",
                self.name,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        let _ = git_output(&self.path, &["clean", "-fd"]);
        Ok(())
    }
}

/// Remove a dash's workshop — its worktree and its `tugworkshop/<name>` branch.
///
/// Called from dash discard and from a completed join, never from a resolve:
/// the whole point of a stable workshop is that it survives between them.
pub fn remove(repo: &Path, name: &str, warnings: &mut Vec<String>) {
    let repo_root = main_repo_root(repo);
    let path = workshop_path(&repo_root, name);
    let branch = workshop_branch(name);

    if path.exists() {
        let _ = git_output(
            &repo_root,
            &["worktree", "remove", "--force", &path.to_string_lossy()],
        );
        if path.exists() {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
    let _ = git_output(&repo_root, &["worktree", "prune"]);

    if branch_exists(&repo_root, &branch) {
        match git_output(&repo_root, &["branch", "-D", &branch]) {
            Ok(o) if !o.status.success() => warnings.push(format!(
                "Failed to delete workshop branch {}: {}",
                branch,
                String::from_utf8_lossy(&o.stderr).trim()
            )),
            Err(e) => warnings.push(format!("Failed to delete workshop branch {branch}: {e}")),
            _ => {}
        }
    }

    if path.exists() {
        warnings.push(format!("Failed to remove workshop: {}", path.display()));
    }
}

/// Ensure `.tug/` is ignored, per clone, before a workshop is put there.
///
/// The Changes card's untracked half is listed with `--exclude-standard`, so a
/// project's own ignore rules are what keep `.tug/` out of it. Tugtool ignores
/// `.tug/`; a user's project need not, and the workshop raises the stakes from
/// one worktree to a second checkout plus its build outputs — enough untracked
/// dirt to swamp the card and to trip a join preflight. `.git/info/exclude` is
/// the right instrument: per-clone, untracked, and never an edit to the user's
/// committed `.gitignore`.
fn ensure_tug_ignored(repo: &Path) {
    let covered = git_output(repo, &["check-ignore", "-q", ".tug/"])
        .map(|o| o.status.success())
        .unwrap_or(false);
    if covered {
        return;
    }
    let Ok(common) = git_stdout(
        repo,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ) else {
        return;
    };
    let exclude = Path::new(common.trim()).join("info").join("exclude");
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == ".tug/") {
        return;
    }
    if let Some(parent) = exclude.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut body = existing;
    if !body.is_empty() && !body.ends_with('\n') {
        body.push('\n');
    }
    body.push_str(".tug/\n");
    let _ = std::fs::write(&exclude, body);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?} failed");
    }

    fn set(dir: &Path, rel: &str, content: &str) {
        std::fs::write(dir.join(rel), content).unwrap();
    }

    /// A repo on `main` with one conflicting round on `tugdash/demo`: base and
    /// dash both rewrite `f.txt`, so a real merge conflicts.
    fn init(ignore_tug: bool) -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path();
        git(repo, &["init", "-b", "main"]);
        git(repo, &["config", "user.name", "t"]);
        git(repo, &["config", "user.email", "t@t"]);
        set(repo, "f.txt", "A\n");
        if ignore_tug {
            set(repo, ".gitignore", ".tug/\n");
        }
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "base"]);
        git(repo, &["branch", "tugdash/demo"]);
        git(repo, &["config", "branch.tugdash/demo.tugbase", "main"]);

        git(repo, &["switch", "-q", "tugdash/demo"]);
        set(repo, "f.txt", "DASH\n");
        set(repo, "only-dash.txt", "dash\n");
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "dash round"]);

        git(repo, &["switch", "-q", "main"]);
        set(repo, "f.txt", "BASE\n");
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "base moved"]);
        temp
    }

    fn head(dir: &Path) -> String {
        git_stdout(dir, &["rev-parse", "HEAD"]).unwrap()
    }

    /// `open_merge` performs the merge for real: markers in the working file,
    /// unmerged stages in the index, and the dash's non-conflicting file
    /// present — the tree an agent needs, not three blobs.
    #[test]
    fn open_merge_leaves_a_real_conflicted_tree() {
        let temp = init(true);
        let repo = temp.path();
        let before = head(repo);

        let ws = Workshop::open_merge(repo, "demo").unwrap();
        let body = std::fs::read_to_string(ws.path().join("f.txt")).unwrap();
        assert!(
            body.contains("<<<<<<<"),
            "expected conflict markers: {body}"
        );
        assert!(body.contains("BASE") && body.contains("DASH"));

        let unmerged = git_stdout(ws.path(), &["diff", "--name-only", "--diff-filter=U"]).unwrap();
        assert_eq!(unmerged.trim(), "f.txt");
        assert!(ws.path().join("only-dash.txt").exists());

        // The user's checkouts are untouched throughout ([R01]).
        assert_eq!(head(repo), before);
        assert_eq!(
            std::fs::read_to_string(repo.join("f.txt")).unwrap(),
            "BASE\n"
        );
    }

    /// A commit over an unresolved index is refused, and the same workshop
    /// commits once the conflict is worked — with the base head as its parent,
    /// so the join fast-forwards onto it.
    #[test]
    fn commit_refuses_unresolved_and_writes_the_worked_tree() {
        let temp = init(true);
        let repo = temp.path();

        let ws = Workshop::open_merge(repo, "demo").unwrap();
        // Straight off the merge the file is markers, and no amount of staging
        // changes that — the refusal is about content, not about the index.
        let err = ws.commit("candidate").unwrap_err();
        assert!(err.contains("conflict markers remain"), "{err}");
        assert!(err.contains("f.txt"), "{err}");

        // The worker edits; nobody stages. Committing is what stages.
        set(ws.path(), "f.txt", "RECONCILED\n");
        let sha = ws.commit("candidate").unwrap();

        assert_eq!(
            git_stdout(repo, &["rev-parse", &format!("{sha}^")]).unwrap(),
            ws.base_head()
        );
        assert_eq!(
            git_stdout(repo, &["show", &format!("{sha}:f.txt")]).unwrap(),
            "RECONCILED"
        );
        // The dash's own file rode along — the commit is the whole tree.
        assert_eq!(
            git_stdout(repo, &["show", &format!("{sha}:only-dash.txt")]).unwrap(),
            "dash"
        );
    }

    /// Reset discards the last use's working files but leaves ignored build
    /// outputs standing — the warmth a stable workshop exists for.
    #[test]
    fn release_cleans_the_tree_and_keeps_ignored_build_outputs() {
        let temp = init(true);
        let repo = temp.path();

        let ws = Workshop::open_merge(repo, "demo").unwrap();
        std::fs::create_dir_all(ws.path().join(".tug")).unwrap();
        set(ws.path(), ".tug/warm.bin", "cached\n");
        set(ws.path(), "scratch.txt", "left behind\n");

        ws.release();

        assert!(!ws.path().join("scratch.txt").exists());
        assert!(
            ws.path().join(".tug/warm.bin").exists(),
            "an ignored build output must survive the reset"
        );
        let body = std::fs::read_to_string(ws.path().join("f.txt")).unwrap();
        assert_eq!(body, "BASE\n", "the tree is back at the base head");
        assert!(!ws.path().join("only-dash.txt").exists());
    }

    /// The workshop is reused across opens — same path, same branch — and
    /// `remove` is what tears it down.
    #[test]
    fn the_workshop_is_stable_across_opens_and_removed_only_by_remove() {
        let temp = init(true);
        let repo = temp.path();

        let first = Workshop::open_merge(repo, "demo").unwrap();
        let path = first.path().to_path_buf();
        set(first.path(), "marker.txt", "first use\n");

        let second = Workshop::open_merge(repo, "demo").unwrap();
        assert_eq!(second.path(), path);
        assert_eq!(second.branch(), "tugworkshop/demo");
        assert!(path.exists());

        let mut warnings = Vec::new();
        remove(repo, "demo", &mut warnings);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(!path.exists());
        assert!(!branch_exists(repo, "tugworkshop/demo"));
    }

    /// The branch is outside `refs/heads/tugdash/`, which is what keeps a
    /// workshop from rendering as a phantom dash on every surface that globs
    /// that namespace — and what gives Tier 1 a stable app-test slug instead of
    /// a per-candidate `detached-<sha>`.
    #[test]
    fn the_workshop_branch_is_outside_the_dash_namespace() {
        let temp = init(true);
        let repo = temp.path();
        let ws = Workshop::open_merge(repo, "demo").unwrap();

        assert_eq!(ws.branch(), "tugworkshop/demo");
        let dash_refs = git_stdout(
            repo,
            &["for-each-ref", "--format=%(refname)", "refs/heads/tugdash/"],
        )
        .unwrap();
        assert!(
            !dash_refs.contains("tugworkshop"),
            "the workshop must not be enumerable as a dash: {dash_refs}"
        );

        // The checkout is on a named branch, never detached — the slug Tier 1's
        // warm DerivedData depends on.
        let branch = git_stdout(ws.path(), &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
        assert_eq!(branch, "tugworkshop/demo");

        // And the surface itself: `dash_detail_entries_in` is the one walk
        // behind both `tugutil dash list` and the card's snapshot ([D138]), so
        // asserting here covers every reader of either.
        let dashes = crate::ops::dash_detail_entries_in(repo);
        let names: Vec<&str> = dashes.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, vec!["demo"], "the workshop must not read as a dash");
    }

    /// In a project that does not ignore `.tug/`, creating a workshop ensures
    /// the ignore itself via `.git/info/exclude`, so a second checkout plus its
    /// build outputs never lands in the base working set.
    #[test]
    fn a_project_that_does_not_ignore_tug_still_hides_the_workshop() {
        let temp = init(false);
        let repo = temp.path();
        assert!(
            !git_output(repo, &["check-ignore", "-q", ".tug/"])
                .unwrap()
                .status
                .success(),
            "the fixture must start with .tug/ unignored"
        );

        let _ws = Workshop::open_merge(repo, "demo").unwrap();

        let untracked = git_stdout(repo, &["ls-files", "--others", "--exclude-standard"]).unwrap();
        assert!(
            !untracked.contains(".tug"),
            "workshop paths must not reach the base working set: {untracked}"
        );
    }
}
