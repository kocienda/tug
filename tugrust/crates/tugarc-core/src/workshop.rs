//! The workshop — one stable worktree per arc where a join is materialized.
//!
//! The ladder ([`crate::resolve`]) works a conflict as three blobs at a time,
//! off to the side, and that is enough for a re-merge but not for an agent: a
//! renamed symbol reconciled against a new call site needs the neighbors, and a
//! build needs a tree. The workshop is that tree, in a checkout nobody is
//! looking at.
//!
//! **It materializes a conflict; it does not create one.** What it opens on is
//! the commit under `refs/tug/conflict/<name>` that the ladder parked — markers
//! where the rungs gave up, their own resolutions already applied — so opening
//! is a `reset --hard` and `MERGE_HEAD` never exists in a workshop's life. That
//! inverts what the checkout is *for*: it used to be the only place an
//! in-flight conflict lived, which made a crash, a tugcast restart, or a CLI
//! join tearing the worktree down cost the resolution work. Now the conflict
//! and every checkpoint on it are committed, and the worktree is a view that
//! can be rebuilt from the ref at any time.
//!
//! **It is one stable worktree per arc, not a nonce per resolve, and that is
//! economics rather than taste.** A fresh worktree carries no `node_modules`,
//! so a typecheck or a bundle fails outright; a cold `target/`, so a
//! `cargo check` is a full dependency build; and — sharpest — a *detached*
//! worktree's app-test slug is `detached-<sha8>`, which changes with every
//! candidate, so each verification run would land in fresh DerivedData and
//! rebuild the whole app. A stable branch name gives a stable slug, which keeps
//! DerivedData, `target/`, `node_modules/`, and `dist/` warm across candidates.
//!
//! The branch lives in its own namespace, `tugworkshop/<name>`, and that is
//! load-bearing: every arc surface enumerates arcs by globbing
//! `refs/heads/tugarc/` — four sites in [`crate::ops`], the changesets feed's
//! arc-entry derivation, and the agent supervisor — so a workshop branch
//! *inside* that namespace would render as a phantom arc row on every
//! recompute. Outside it, the exclusion is by construction rather than by a
//! filter each surface must remember.
//!
//! Hydration is the project's own `[tugtool.arc].post_create` hooks, run once
//! at creation through the same [`crate::ops`] path an arc worktree uses. This
//! module knows no project's toolchain; what a verification tier needs beyond
//! those hooks is that tier's declared command to arrange.

use std::path::{Path, PathBuf};

use tugtool_core::worktree::sanitize_branch_name;

use crate::ops::{
    arc_base, branch_exists, branch_name, git_output, git_stdout, main_repo_root, run_post_create,
};
use crate::resolve::commit_tree;

/// The branch an arc's workshop is checked out on — deliberately **not** under
/// `refs/heads/tugarc/`, which every arc surface globs.
pub fn workshop_branch(name: &str) -> String {
    format!("tugworkshop/{}", sanitize_branch_name(name))
}

/// An arc's workshop path: `<repo>/.tug/workshops/<sanitized-name>`, beside the
/// arc worktree home so one ignore rule covers both.
pub fn workshop_path(repo: &Path, name: &str) -> PathBuf {
    repo.join(".tug")
        .join("workshops")
        .join(sanitize_branch_name(name))
}

/// An arc's workshop worktree, open at some tree.
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

    /// Materialize the arc's standing conflict: reset the workshop to the
    /// conflict chain's tip.
    ///
    /// **This is a checkout of committed data, not a merge.** The conflict —
    /// markers where the ladder gave up, the rungs' own resolutions already
    /// applied — is a commit under `refs/tug/conflict/`, so opening it is a
    /// reset and `MERGE_HEAD` never comes into existence. What that buys is the
    /// whole point of the ref: the workshop is now a *materialization* of
    /// durable state rather than the only place the conflict lives, so a crash,
    /// a tugcast restart, or a CLI join tearing the worktree down costs the
    /// checkout and not the work.
    ///
    /// Refuses a stale chain rather than opening it: a conflict commit encodes
    /// one merge of two specific tips, and once either has moved the tree it
    /// holds describes a merge nobody is performing.
    pub fn open_conflict(repo: &Path, name: &str) -> Result<Self, String> {
        let repo_root = main_repo_root(repo);
        let chain = crate::resolve::read_conflict(&repo_root, name).ok_or_else(|| {
            format!("no conflict is recorded for '{name}' — run the resolve ladder first")
        })?;
        if !crate::resolve::conflict_is_valid(&repo_root, name, &chain) {
            return Err(format!(
                "the recorded conflict for '{name}' is stale — its base or arc head has moved \
                 since it was written; resolve again"
            ));
        }
        let ws = Self::ensure(&repo_root, name)?;
        ws.reset_to(&chain.tip)?;
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

    /// Every path this workshop's tree differs from `baseline` on.
    ///
    /// Staging first is what makes the answer include files nobody tracked yet:
    /// a resolver that invents a file is the case this exists for, and an
    /// unstaged new file is invisible to a tree diff. The paths are what the
    /// resolver's report is then required to account for — a report that need
    /// not mention a file the resolver created is a report that cannot catch
    /// one being smuggled in.
    pub fn touched_since(&self, baseline: &str) -> Result<Vec<String>, String> {
        let out = git_output(&self.path, &["add", "-A"])?;
        if !out.status.success() {
            return Err(format!(
                "workshop add failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        crate::ops::git_paths(&self.path, &["diff", "--cached", "--name-only", baseline])
    }

    /// Whether the working tree still holds exactly what `sha` does.
    ///
    /// Asked by an audit pass that opened the workshop at a candidate the
    /// ladder already built: an audit that changed nothing must leave that
    /// commit standing rather than re-committing its tree onto the base head,
    /// which would convert a replay join into a squash as a side effect of
    /// reading it.
    pub fn matches(&self, sha: &str) -> Result<bool, String> {
        if crate::ops::has_uncommitted(&self.path)? {
            return Ok(false);
        }
        let head = git_stdout(&self.path, &["rev-parse", "HEAD"])?;
        Ok(head.trim() == sha)
    }

    /// Write the workshop's working tree as a candidate commit parented on the
    /// base head — the same shape the ladder's candidate has, so
    /// [`crate::ops::join_in`] lands it unchanged.
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
        let touched: Vec<String> = crate::ops::git_paths(
            &self.path,
            &["diff", "--cached", "--name-only", &self.base_head],
        )?;
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

    /// The paths the resolver must still finish — those carrying markers at the
    /// tree the workshop is open on.
    ///
    /// This used to read the index for unmerged stages, which only had an
    /// answer while a live merge was parked in the checkout. A materialized
    /// conflict has a clean stage-0 index by construction, so the question is
    /// now asked of the content, which is where it was always really settled:
    /// the marker scan is what `commit` already refuses on.
    pub fn unresolved(&self) -> Result<Vec<String>, String> {
        let repo_root = main_repo_root(&self.repo);
        let Some(chain) = crate::resolve::read_conflict(&repo_root, &self.name) else {
            return Ok(Vec::new());
        };
        let paths: Vec<String> = chain.record.paths.iter().map(|p| p.path.clone()).collect();
        Ok(self.marker_paths(&paths))
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
                crate::resolve::has_conflict_markers(&bytes)
            })
            .cloned()
            .collect()
    }

    /// Let the workshop go, leaving the conflict chain's tip checked out.
    ///
    /// **It parks rather than wipes, and that is the decision this round made.**
    /// Release used to reset to the base head, because what it was abandoning
    /// was a half-merged checkout with a live `MERGE_HEAD` — genuine wreckage,
    /// blocking anything that might help. Under conflicts-as-data there is no
    /// merge state, and what a failed resolve leaves behind is a chain of
    /// committed checkpoints: real work, named, auditable, and safe to resume
    /// from. Wiping it would throw away every file the run had finished and
    /// make the next resolve redo them.
    ///
    /// Nothing resumed this way can land unexamined: a candidate still has to
    /// clear the marker, stage, and report refusals in [`Self::commit`], and
    /// the audit still reads every machine decision.
    pub fn release(&self) {
        let repo_root = main_repo_root(&self.repo);
        match crate::resolve::read_conflict(&repo_root, &self.name) {
            Some(chain) => {
                let _ = self.reset_to(&chain.tip);
            }
            // No chain to park on — the resolve finished, or its conflict was
            // cleared — so the base head is the right resting place after all.
            None => {
                let _ = self.reset_to(&self.base_head);
            }
        }
    }

    /// Commit the workshop's current tree as a checkpoint on the conflict
    /// chain, and advance the ref to it.
    ///
    /// Checkpoints are what make a failed resolve cost only its last turn: each
    /// one is an ordinary commit whose parent is the chain's previous tip, so
    /// the chain reads back as the resolution's history and the ref always
    /// names how far the work got.
    ///
    /// Refuses a marker in any path the conflict record does not list. A
    /// resolver that introduced a conflict marker somewhere nobody asked it to
    /// touch is not making progress, and a checkpoint is exactly the wrong
    /// place to find that out later.
    pub fn checkpoint(&self, message: &str) -> Result<Option<String>, String> {
        let repo_root = main_repo_root(&self.repo);
        let chain = crate::resolve::read_conflict(&repo_root, &self.name)
            .ok_or_else(|| format!("no conflict chain to check point for '{}'", self.name))?;

        let add = git_output(&self.path, &["add", "-A"])?;
        if !add.status.success() {
            return Err(format!(
                "workshop checkpoint: git add failed: {}",
                String::from_utf8_lossy(&add.stderr).trim()
            ));
        }

        // Nothing moved since the tip — a turn that resolved nothing adds no
        // commit, so the chain stays a record of progress rather than of
        // attempts.
        let touched: Vec<String> =
            crate::ops::git_paths(&self.path, &["diff", "--cached", "--name-only", &chain.tip])?;
        if touched.is_empty() {
            return Ok(None);
        }

        let known: Vec<String> = chain.record.paths.iter().map(|p| p.path.clone()).collect();
        let stray: Vec<String> = self
            .marker_paths(&touched)
            .into_iter()
            .filter(|p| !known.contains(p))
            .collect();
        if !stray.is_empty() {
            return Err(format!(
                "workshop checkpoint refused: conflict markers in {}, which the conflict does \
                 not list",
                stray.join(", ")
            ));
        }

        let tree = git_stdout(&self.path, &["write-tree"])?;
        let sha = crate::resolve::commit_tree(&repo_root, &tree, &chain.tip, message)?;
        crate::resolve::advance_conflict_ref(&repo_root, &self.name, &sha)?;
        Ok(Some(sha))
    }

    // -- internals ----------------------------------------------------------

    /// The workshop, created and hydrated if it is not already there.
    fn ensure(repo: &Path, name: &str) -> Result<Self, String> {
        let repo_root = main_repo_root(repo);

        // A workshop belongs to an arc. When the arc is gone — joined, or
        // discarded — creating one leaks a worktree and a branch that nothing
        // will ever collect, because every sweeper keys off the arc that is no
        // longer there. The straggler this closes is real: a join tears the
        // workshop down while a verification that started before it is still
        // running, the verification's next `open_*` re-creates it, and the
        // orphan outlives the arc by however long the checkout survives.
        if !branch_exists(&repo_root, &branch_name(name)) {
            return Err(format!(
                "the arc {name} is gone — its workshop cannot be opened"
            ));
        }

        ensure_tug_ignored(&repo_root);

        // A workshop built before conflicts were committed can still be sitting
        // on a live merge. Nothing in this module creates one any more, so the
        // sweep runs once here rather than on every reset — and it is a sweep,
        // not a repair: the merge state is discarded, and the conflict the
        // caller wants comes from the ref.
        let path = workshop_path(&repo_root, name);
        if path.join(".git").exists() {
            let merging = git_stdout(&path, &["rev-parse", "--verify", "MERGE_HEAD"]).is_ok();
            if merging {
                let _ = git_output(&path, &["merge", "--abort"]);
            }
        }
        let branch = workshop_branch(name);
        let base = arc_base(&repo_root, name)?;
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

        // Hydrate once, through the same hooks an arc worktree runs. A failure
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
        // No `merge --abort` precedes this any more, and its absence is the
        // feature: nothing in a workshop's life starts a merge, so there is
        // never a `MERGE_HEAD` to abort. The one path that can still find one is
        // a workshop left by a build that predates conflict commits, and
        // [`Self::ensure`] sweeps that once rather than making every reset pay
        // for it.
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

/// Every workshop this repository currently has, by its sanitized name.
///
/// Both halves are read, because either can outlive the other: `worktree
/// remove` that failed leaves a directory with no branch, and a `worktree
/// prune` after a hand-deleted directory leaves a branch with no worktree. A
/// sweeper that read only one would keep re-finding the other.
pub fn existing(repo: &Path) -> Vec<String> {
    let repo_root = main_repo_root(repo);
    let mut names: Vec<String> = Vec::new();

    if let Ok(entries) = std::fs::read_dir(repo_root.join(".tug").join("workshops")) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                names.push(name.to_string());
            }
        }
    }
    if let Ok(list) = git_stdout(
        &repo_root,
        &[
            "branch",
            "--list",
            "tugworkshop/*",
            "--format=%(refname:short)",
        ],
    ) {
        for line in list.lines() {
            if let Some(name) = line.trim().strip_prefix("tugworkshop/") {
                names.push(name.to_string());
            }
        }
    }

    names.sort();
    names.dedup();
    names
}

/// Remove an arc's workshop — its worktree and its `tugworkshop/<name>` branch.
///
/// Called from arc discard and from a completed join, never from a resolve:
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
/// project's own ignore rules are what keep `.tug/` out of it. Tug ignores
/// `.tug/`; a user's project need not, and the workshop raises the stakes from
/// one worktree to a second checkout plus its build outputs — enough untracked
/// dirt to swamp the card and to trip a join preflight. `.git/info/exclude` is
/// the right instrument: per-clone, untracked, and never an edit to the user's
/// committed `.gitignore`.
fn ensure_tug_ignored(repo: &Path) {
    if crate::ops::tug_dir_is_ignored(repo) {
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

    fn git(dir: &Path, args: &[&str]) {
        let ok = tugcore::git_command()
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

    /// A repo on `main` with one conflicting round on `tugarc/demo`: base and
    /// arc both rewrite `f.txt`, so a real merge conflicts.
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
        git(repo, &["branch", "tugarc/demo"]);
        git(repo, &["config", "branch.tugarc/demo.tugbase", "main"]);

        git(repo, &["switch", "-q", "tugarc/demo"]);
        set(repo, "f.txt", "ARC\n");
        set(repo, "only-arc.txt", "arc\n");
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "arc round"]);

        git(repo, &["switch", "-q", "main"]);
        set(repo, "f.txt", "BASE\n");
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "base moved"]);
        temp
    }

    fn head(dir: &Path) -> String {
        git_stdout(dir, &["rev-parse", "HEAD"]).unwrap()
    }

    /// Record the arc's conflict, then open the workshop on it.
    ///
    /// A workshop no longer manufactures its own conflict by merging, so every
    /// fixture needs one on file first. Running the real ladder is what makes
    /// these tests exercise the shape the resolver actually meets — a tree
    /// carrying the rungs' resolutions and markers only where they gave up.
    fn open_conflicted(repo: &Path) -> Workshop {
        crate::resolve::resolve_conflicts(repo, "demo", None).expect("the ladder runs");
        Workshop::open_conflict(repo, "demo").expect("a conflict is recorded")
    }

    /// Opening a recorded conflict gives the agent the same tree a real merge
    /// did — markers in the conflicted file, the arc's other files present —
    /// without a merge ever being performed.
    #[test]
    fn open_conflict_gives_the_agent_a_real_conflicted_tree() {
        let temp = init(true);
        let repo = temp.path();
        let before = head(repo);

        let ws = open_conflicted(repo);
        let body = std::fs::read_to_string(ws.path().join("f.txt")).unwrap();
        assert!(
            body.contains("<<<<<<<"),
            "expected conflict markers: {body}"
        );
        assert!(body.contains("BASE") && body.contains("ARC"));

        assert_eq!(ws.unresolved().unwrap(), vec!["f.txt".to_string()]);
        assert!(ws.path().join("only-arc.txt").exists());

        // The user's checkouts are untouched throughout ([R01]).
        assert_eq!(head(repo), before);
        assert_eq!(
            std::fs::read_to_string(repo.join("f.txt")).unwrap(),
            "BASE\n"
        );
    }

    /// The invariant the whole round turns on: no merge is ever started, so
    /// there is never merge state to be interrupted mid-flight.
    #[test]
    fn a_materialized_workshop_never_holds_merge_state() {
        let temp = init(true);
        let repo = temp.path();
        let ws = open_conflicted(repo);
        let merging = || git_stdout(ws.path(), &["rev-parse", "--verify", "MERGE_HEAD"]).is_ok();

        assert!(!merging(), "not on open");
        set(ws.path(), "f.txt", "resolved by hand\n");
        assert!(!merging(), "not after an edit");
        ws.checkpoint("tugresolve(demo): checkpoint").unwrap();
        assert!(!merging(), "not after a checkpoint");
        // And the index is plain stage-0 throughout, which is what lets
        // `unresolved` be a question about content rather than about stages.
        let unmerged = git_stdout(ws.path(), &["diff", "--name-only", "--diff-filter=U"]).unwrap();
        assert!(unmerged.trim().is_empty(), "{unmerged}");
    }

    /// The recovery property: destroy the checkout entirely and the conflict —
    /// with every checkpoint on it — comes back from the ref.
    #[test]
    fn a_destroyed_workshop_rebuilds_from_the_conflict_ref() {
        let temp = init(true);
        let repo = temp.path();
        let ws = open_conflicted(repo);
        set(ws.path(), "f.txt", "half done\n");
        let checkpoint = ws
            .checkpoint("tugresolve(demo): checkpoint")
            .unwrap()
            .expect("the edit is a checkpoint");

        // The CLI-tears-down-the-workshop-mid-resolve case, at its most brutal.
        let mut warnings = Vec::new();
        remove(repo, "demo", &mut warnings);
        assert!(!workshop_path(repo, "demo").exists());

        let reopened = Workshop::open_conflict(repo, "demo").expect("it comes back");
        assert_eq!(
            std::fs::read_to_string(reopened.path().join("f.txt")).unwrap(),
            "half done\n",
            "the checkpointed work survived the checkout's destruction"
        );
        let chain = crate::resolve::read_conflict(repo, "demo").unwrap();
        assert_eq!(chain.tip, checkpoint);
        assert!(
            reopened.unresolved().is_ok_and(|u| u.is_empty()),
            "and the path reads as resolved, because its markers are gone"
        );
    }

    /// A stale chain is refused rather than opened: the tree it holds describes
    /// a merge of two tips that no longer exist together.
    #[test]
    fn open_conflict_refuses_a_stale_chain() {
        let temp = init(true);
        let repo = temp.path();
        open_conflicted(repo);

        set(repo, "unrelated.txt", "the base moved on\n");
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "base moves"]);

        let err = match Workshop::open_conflict(repo, "demo") {
            Err(e) => e,
            Ok(_) => panic!("a stale conflict refuses to open"),
        };
        assert!(err.contains("stale"), "{err}");
    }

    /// A turn that changed nothing adds no commit, so the chain records
    /// progress rather than attempts.
    #[test]
    fn a_checkpoint_that_changes_nothing_is_not_a_commit() {
        let temp = init(true);
        let repo = temp.path();
        let ws = open_conflicted(repo);
        let before = crate::resolve::read_conflict(repo, "demo").unwrap().tip;

        assert_eq!(ws.checkpoint("tugresolve(demo): checkpoint").unwrap(), None);

        assert_eq!(
            crate::resolve::read_conflict(repo, "demo").unwrap().tip,
            before
        );
    }

    /// A marker in a file the conflict never named is drift, not progress.
    #[test]
    fn a_checkpoint_refuses_markers_outside_the_conflict_set() {
        let temp = init(true);
        let repo = temp.path();
        let ws = open_conflicted(repo);
        set(ws.path(), "f.txt", "resolved\n");
        set(
            ws.path(),
            "only-arc.txt",
            "a\n<<<<<<< ours\nb\n=======\nc\n>>>>>>> theirs\n",
        );

        let err = ws.checkpoint("tugresolve(demo): checkpoint").unwrap_err();
        assert!(err.contains("only-arc.txt"), "{err}");
    }

    /// A workshop left on a live merge by an older build is swept once, rather
    /// than every reset paying for an abort that can no longer be needed.
    #[test]
    fn an_inherited_merge_state_is_swept_on_open() {
        let temp = init(true);
        let repo = temp.path();
        let ws = open_conflicted(repo);
        // Reproduce what a pre-conflict-commit build would have left behind.
        // The reset to the base head is part of the reproduction, not
        // scaffolding: from the conflict tip the arc is already an ancestor, so
        // git would answer "already up to date" and leave no merge state at all.
        let base = ws.base_head().to_string();
        let _ = git_output(ws.path(), &["reset", "--hard", &base]);
        let _ = git_output(
            ws.path(),
            &["merge", "--no-commit", "--no-ff", "tugarc/demo"],
        );
        assert!(
            git_stdout(ws.path(), &["rev-parse", "--verify", "MERGE_HEAD"]).is_ok(),
            "the fixture is a workshop mid-merge"
        );

        let reopened = Workshop::open_conflict(repo, "demo").expect("it opens");

        assert!(
            git_stdout(reopened.path(), &["rev-parse", "--verify", "MERGE_HEAD"]).is_err(),
            "the inherited merge state is gone"
        );
    }

    /// A commit over an unresolved index is refused, and the same workshop
    /// commits once the conflict is worked — with the base head as its parent,
    /// so the join lands it.
    #[test]
    fn commit_refuses_unresolved_and_writes_the_worked_tree() {
        let temp = init(true);
        let repo = temp.path();

        let ws = open_conflicted(repo);
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
        // The arc's own file rode along — the commit is the whole tree.
        assert_eq!(
            git_stdout(repo, &["show", &format!("{sha}:only-arc.txt")]).unwrap(),
            "arc"
        );
    }

    /// Reset discards the last use's working files but leaves ignored build
    /// outputs standing — the warmth a stable workshop exists for.
    /// Release parks on the conflict chain rather than wiping back to the base.
    ///
    /// The old contract reset to the base head, because what it was abandoning
    /// was a live `MERGE_HEAD` and a half-merged tree. There is no merge state
    /// now, and what a failed resolve leaves is committed work — so release
    /// keeps it and a later resolve resumes from it. What it still does is
    /// clean up after itself: untracked scratch goes, ignored build warmth
    /// stays.
    #[test]
    fn release_parks_on_the_chain_and_keeps_ignored_build_outputs() {
        let temp = init(true);
        let repo = temp.path();

        let ws = open_conflicted(repo);
        set(ws.path(), "f.txt", "half resolved\n");
        let checkpoint = ws
            .checkpoint("tugresolve(demo): checkpoint")
            .unwrap()
            .expect("the edit is a checkpoint");
        std::fs::create_dir_all(ws.path().join(".tug")).unwrap();
        set(ws.path(), ".tug/warm.bin", "cached\n");
        set(ws.path(), "scratch.txt", "left behind\n");

        ws.release();

        assert!(!ws.path().join("scratch.txt").exists());
        assert!(
            ws.path().join(".tug/warm.bin").exists(),
            "an ignored build output must survive the reset"
        );
        assert_eq!(
            std::fs::read_to_string(ws.path().join("f.txt")).unwrap(),
            "half resolved\n",
            "the checkpointed resolution survives the release"
        );
        assert_eq!(
            crate::resolve::read_conflict(repo, "demo").unwrap().tip,
            checkpoint
        );
    }

    /// With no chain to park on — the resolve finished, or its conflict was
    /// cleared — the base head is still the right resting place.
    #[test]
    fn release_falls_back_to_the_base_head_when_no_conflict_stands() {
        let temp = init(true);
        let repo = temp.path();

        let ws = open_conflicted(repo);
        crate::resolve::clear_conflict(repo, "demo");

        ws.release();

        assert_eq!(
            std::fs::read_to_string(ws.path().join("f.txt")).unwrap(),
            "BASE\n"
        );
        assert!(!ws.path().join("only-arc.txt").exists());
    }

    /// The workshop is reused across opens — same path, same branch — and
    /// `remove` is what tears it down.
    #[test]
    fn the_workshop_is_stable_across_opens_and_removed_only_by_remove() {
        let temp = init(true);
        let repo = temp.path();

        let first = open_conflicted(repo);
        let path = first.path().to_path_buf();
        set(first.path(), "marker.txt", "first use\n");

        let second = open_conflicted(repo);
        assert_eq!(second.path(), path);
        assert_eq!(second.branch(), "tugworkshop/demo");
        assert!(path.exists());

        let mut warnings = Vec::new();
        remove(repo, "demo", &mut warnings);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert!(!path.exists());
        assert!(!branch_exists(repo, "tugworkshop/demo"));
    }

    /// The branch is outside `refs/heads/tugarc/`, which is what keeps a
    /// workshop from rendering as a phantom arc on every surface that globs
    /// that namespace — and what gives the checkout a stable derived-data slug
    /// instead of a per-candidate `detached-<sha>`.
    #[test]
    fn the_workshop_branch_is_outside_the_arc_namespace() {
        let temp = init(true);
        let repo = temp.path();
        let ws = open_conflicted(repo);

        assert_eq!(ws.branch(), "tugworkshop/demo");
        let arc_refs = git_stdout(
            repo,
            &["for-each-ref", "--format=%(refname)", "refs/heads/tugarc/"],
        )
        .unwrap();
        assert!(
            !arc_refs.contains("tugworkshop"),
            "the workshop must not be enumerable as an arc: {arc_refs}"
        );

        // The checkout is on a named branch, never detached — the slug a warm
        // DerivedData depends on.
        let branch = git_stdout(ws.path(), &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();
        assert_eq!(branch, "tugworkshop/demo");

        // And the surface itself: `arc_detail_entries_in` is the one walk
        // behind both `tugtool arc list` and the card's snapshot ([D138]), so
        // asserting here covers every reader of either.
        let arcs = crate::ops::arc_detail_entries_in(repo);
        let names: Vec<&str> = arcs.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, vec!["demo"], "the workshop must not read as an arc");
    }

    /// In a project that does not ignore `.tug/`, creating a workshop ensures
    /// the ignore itself via `.git/info/exclude`, so a second checkout plus its
    /// build outputs never lands in the base working set.
    #[test]
    fn a_project_that_does_not_ignore_tug_still_hides_the_workshop() {
        let temp = init(false);
        let repo = temp.path();
        assert!(
            !crate::ops::tug_dir_is_ignored(repo),
            "the fixture must start with .tug/ unignored"
        );

        let _ws = open_conflicted(repo);

        let untracked = git_stdout(repo, &["ls-files", "--others", "--exclude-standard"]).unwrap();
        assert!(
            !untracked.contains(".tug"),
            "workshop paths must not reach the base working set: {untracked}"
        );
    }
}
