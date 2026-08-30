//! The landing's inspection tree — one disposable checkout per landing,
//! shared by every wire that fires on it ([P10]).
//!
//! **Read-only by mechanism, not by intent.** A probe is an arbitrary shell
//! command from a tripwire row, and a diagnosis session is a model with a
//! shell. The only honest way to run either "against the landed commit"
//! without exposing the user's checkout is to run it somewhere else: a
//! detached worktree at the landed sha *is* the commit, is not the base, and
//! is disposable. `git worktree add --detach` takes no branch and holds no
//! lease, so it appears in no dash listing and needs no `ops::create_in`.
//!
//! **One tree per landing rather than per wire, and that is the economy.** A
//! machine carrying two dozen armed wires meets one landing with a dozen
//! matches; per-wire trees would move the churn [P04] takes out of sessions
//! into worktrees and call it progress. The tree is refcounted across the
//! landing's live trips and removed when the last one settles.
//!
//! **A tree that outlives its landing is swept, not leaked** (Risk R04). A
//! crash leaves a detached worktree that nothing lists — unlike a dash, no
//! registry knows about it. So the tree is named from the landing's sha under
//! one tripwire-owned scratch root, which makes the sweep a directory listing
//! rather than a registry: any tree whose sha has no live trip is removed on
//! the engine's start and on its tick, and `git worktree prune` runs beside it
//! so git's own metadata does not keep a stale entry.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use tokio::sync::Mutex;
use tracing::{debug, warn};

/// One landing's tree, and how many live trips still need it.
struct Entry {
    path: PathBuf,
    repo_root: PathBuf,
    refs: usize,
}

/// Every inspection tree this engine has open, keyed by the landing's sha.
///
/// The lock is a tokio mutex rather than a std one because it is held across
/// the `git worktree add` that creates a tree: two wires on one landing
/// arriving together must find one tree, not race to make two, and the whole
/// point of the entry is that it is created once.
pub struct InspectionTrees {
    root: PathBuf,
    open: Mutex<std::collections::HashMap<String, Entry>>,
}

impl InspectionTrees {
    /// The scratch root every tree lives under. One directory per landing sha
    /// beneath it, which is what makes the orphan sweep a listing.
    pub fn new(root: PathBuf) -> Self {
        InspectionTrees {
            root,
            open: Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// The scratch root, so the sweep's caller can list it against the ledger.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The tree for a landing, creating it if this is the first wire to ask,
    /// and taking a reference either way.
    ///
    /// Every caller that acquires must [`release`](Self::release), including
    /// on its failure paths — a reference the settle never gave back is a tree
    /// that survives until the sweep, which costs disk rather than
    /// correctness but is still a leak with a name.
    pub async fn acquire(&self, repo_root: &Path, sha: &str) -> Result<PathBuf, String> {
        let mut open = self.open.lock().await;
        if let Some(entry) = open.get_mut(sha) {
            entry.refs += 1;
            return Ok(entry.path.clone());
        }
        let path = self.root.join(sha);
        let repo_root = repo_root.to_path_buf();
        add_worktree(&repo_root, &path, sha).await?;
        open.insert(
            sha.to_string(),
            Entry {
                path: path.clone(),
                repo_root,
                refs: 1,
            },
        );
        Ok(path)
    }

    /// Give a reference back, removing the tree when the last one goes.
    pub async fn release(&self, sha: &str) {
        let mut open = self.open.lock().await;
        let Some(entry) = open.get_mut(sha) else {
            return;
        };
        entry.refs = entry.refs.saturating_sub(1);
        if entry.refs > 0 {
            return;
        }
        let entry = open.remove(sha).expect("the entry we just read");
        remove_worktree(&entry.repo_root, &entry.path).await;
    }

    /// Remove every tree on disk whose landing has no live trip.
    ///
    /// `live` is the set of shas the ledger still has a `running` or
    /// `awaiting` trip for, read by the caller: this module knows about
    /// directories, and the ledger knows about trips. A tree this engine holds
    /// a reference to is never swept, so a sweep racing an acquire cannot pull
    /// the ground out from under a probe.
    pub async fn sweep(&self, live: &HashSet<String>, repo_of: impl Fn(&str) -> Option<PathBuf>) {
        let held: HashSet<String> = self.open.lock().await.keys().cloned().collect();
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return;
        };
        for entry in entries.flatten() {
            let Some(sha) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if live.contains(&sha) || held.contains(&sha) {
                continue;
            }
            let path = entry.path();
            match repo_of(&sha) {
                Some(repo_root) => remove_worktree(&repo_root, &path).await,
                // A tree whose landing the ledger can no longer name is still
                // a directory this engine made. Removing the bytes is the
                // whole of what can be done; the repository it was cut from
                // prunes its own stale entry the next time anything runs
                // `git worktree` there.
                None => {
                    debug!(
                        sha,
                        "tripwire: sweeping a tree whose landing the ledger cannot name"
                    );
                    let _ = tokio::fs::remove_dir_all(&path).await;
                }
            }
        }
    }
}

async fn add_worktree(repo_root: &Path, path: &Path, sha: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("the inspection tree's scratch root could not be made: {e}"))?;
    }
    // A leftover directory at this path is a tree an unclean exit left behind
    // for this very landing. Removing it first is what makes the add
    // idempotent across a restart, rather than failing on a path git already
    // knows about.
    if tokio::fs::metadata(path).await.is_ok() {
        remove_worktree(repo_root, path).await;
    }
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args(["worktree", "add", "--detach"])
        .arg(path)
        .arg(sha)
        .output()
        .await
        .map_err(|e| format!("git worktree add could not be launched: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git worktree add failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

async fn remove_worktree(repo_root: &Path, path: &Path) {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args(["worktree", "remove", "--force"])
        .arg(path)
        .output()
        .await;
    let removed = matches!(&out, Ok(out) if out.status.success());
    if !removed {
        // `remove` refuses a path git has already forgotten, which is exactly
        // the state an interrupted run leaves. The bytes still have to go.
        if let Ok(out) = &out {
            debug!(path = %path.display(), stderr = %String::from_utf8_lossy(&out.stderr).trim(),
                   "tripwire: git worktree remove declined; removing the directory");
        }
        if let Err(e) = tokio::fs::remove_dir_all(path).await
            && e.kind() != std::io::ErrorKind::NotFound
        {
            warn!(path = %path.display(), error = %e,
                  "tripwire: the inspection tree could not be removed");
        }
    }
    let _ = tokio::process::Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args(["worktree", "prune"])
        .output()
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_repo() -> (tempfile::TempDir, PathBuf, String) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&root)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {out:?}");
            out
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "t@example.com"]);
        git(&["config", "user.name", "T"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "one"]);
        let sha = String::from_utf8_lossy(&git(&["rev-parse", "HEAD"]).stdout)
            .trim()
            .to_string();
        (dir, root, sha)
    }

    /// Two wires on one landing share one tree, and it survives until the
    /// second gives its reference back ([P10]).
    #[tokio::test]
    async fn one_landing_is_one_tree_removed_after_the_last_reference() {
        let (dir, root, sha) = scratch_repo();
        let trees = InspectionTrees::new(dir.path().join("trees"));

        let first = trees.acquire(&root, &sha).await.unwrap();
        let second = trees.acquire(&root, &sha).await.unwrap();
        assert_eq!(
            first, second,
            "the second wire found the tree already there"
        );
        assert!(
            first.join("a.txt").exists(),
            "checked out at the landed sha"
        );

        trees.release(&sha).await;
        assert!(first.exists(), "one reference is still out");
        trees.release(&sha).await;
        assert!(!first.exists(), "the last release removed it");

        // And git no longer believes in it, so the next landing on this sha
        // can add a tree at the same path.
        let out = std::process::Command::new("git")
            .args(["worktree", "list"])
            .current_dir(&root)
            .output()
            .unwrap();
        let listed = String::from_utf8_lossy(&out.stdout);
        assert!(!listed.contains("trees"), "{listed}");
    }

    /// A probe may write, and where it writes is the point: the tree is a
    /// disposable checkout, so nothing it does reaches the base.
    #[tokio::test]
    async fn a_write_in_the_tree_never_reaches_the_base_checkout() {
        let (dir, root, sha) = scratch_repo();
        let trees = InspectionTrees::new(dir.path().join("trees"));
        let tree = trees.acquire(&root, &sha).await.unwrap();

        std::fs::write(tree.join("a.txt"), "clobbered\n").unwrap();
        std::fs::write(tree.join("new.txt"), "invented\n").unwrap();

        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "one\n"
        );
        assert!(!root.join("new.txt").exists());

        trees.release(&sha).await;
        assert!(!tree.exists(), "and the tree is gone afterwards");
    }

    /// An unclean exit leaves a tree nothing lists. The sweep is a directory
    /// listing against the shas that still have a live trip (Risk R04).
    #[tokio::test]
    async fn the_sweep_removes_a_tree_whose_landing_has_no_live_trip() {
        let (dir, root, sha) = scratch_repo();
        let scratch = dir.path().join("trees");
        let trees = InspectionTrees::new(scratch.clone());

        // A tree from a run that died: on disk, no reference held.
        let orphan = scratch.join(&sha);
        add_worktree(&root, &orphan, &sha).await.unwrap();
        assert!(orphan.exists());

        let repo_of = |_: &str| Some(root.clone());
        trees.sweep(&HashSet::from([sha.clone()]), repo_of).await;
        assert!(orphan.exists(), "a landing with a live trip keeps its tree");

        trees.sweep(&HashSet::new(), repo_of).await;
        assert!(!orphan.exists(), "and one with none loses it");
    }

    /// A tree this engine holds a reference to is never swept, so a sweep
    /// racing a probe cannot pull the ground out from under it.
    #[tokio::test]
    async fn the_sweep_leaves_a_held_tree_alone() {
        let (dir, root, sha) = scratch_repo();
        let trees = InspectionTrees::new(dir.path().join("trees"));
        let tree = trees.acquire(&root, &sha).await.unwrap();

        trees.sweep(&HashSet::new(), |_| Some(root.clone())).await;
        assert!(tree.exists(), "held by a live acquire");

        trees.release(&sha).await;
        assert!(!tree.exists());
    }
}
