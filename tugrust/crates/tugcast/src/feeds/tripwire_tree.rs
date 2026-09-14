//! A trip's inspection tree — one disposable checkout per `HEAD` sha, shared
//! by every tripwire standing there ([P06]).
//!
//! **Read-only by mechanism, not by intent.** A probe is an arbitrary shell
//! command from a tripwire row, and a diagnosis session is a model with a
//! shell. The only honest way to run either against the state a fact happened
//! in, without exposing the user's checkout, is to run it somewhere else: a
//! detached worktree at that checkout's `HEAD` *is* the commit, is not the
//! base, and is disposable. `git worktree add --detach` takes no branch and
//! holds no lease, so it appears in no arc listing and needs no
//! `ops::create_in`. What the user had not committed yet travels beside the
//! tree as a file rather than in it ([B02]).
//!
//! **One tree per sha rather than per tripwire, and that is the economy.** A
//! machine carrying two dozen armed tripwires can meet one fact with a dozen
//! matches; per-tripwire trees would move the churn [P04] takes out of sessions
//! into worktrees and call it progress. The tree is refcounted across every
//! live trip standing at that sha and removed when the last one settles.
//!
//! **A tree that outlives its trips is swept, not leaked** (Risk R04). A
//! crash leaves a detached worktree that nothing lists — unlike an arc, no
//! registry knows about it. So the tree is named from the sha under
//! one tripwire-owned scratch root, which makes the sweep a directory listing
//! rather than a registry: any tree whose sha has no live trip is removed on
//! the engine's start and on its tick, and `git worktree prune` runs beside it
//! so git's own metadata does not keep a stale entry. The diff files beside
//! the trees are swept the same way, against the live **trip** ids: a diff
//! belongs to one trip and a tree to one sha, so the two passes read two sets.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use tokio::sync::Mutex;
use tracing::{debug, warn};

/// One sha's tree, and how many live trips still need it.
struct Entry {
    path: PathBuf,
    repo_root: PathBuf,
    refs: usize,
}

/// Every inspection tree this engine has open, keyed by the `HEAD` sha it
/// stands at.
///
/// The lock is a tokio mutex rather than a std one because it is held across
/// the `git worktree add` that creates a tree: two tripwires at one sha
/// arriving together must find one tree, not race to make two, and the whole
/// point of the entry is that it is created once.
pub struct InspectionTrees {
    root: PathBuf,
    open: Mutex<std::collections::HashMap<String, Entry>>,
}

impl InspectionTrees {
    /// The scratch root every tree lives under. One directory per `HEAD` sha
    /// beneath it, which is what makes the orphan sweep a listing, and one
    /// `<trip_id>.diff` file per trip that had uncommitted work to carry.
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

    /// Where a trip's uncommitted diff is written — beside the trees rather
    /// than in one ([B02]).
    ///
    /// Per **trip** while the tree is per sha, because two trips standing at
    /// one sha were cut at two different moments and the user's working copy
    /// is not the same thing twice.
    pub fn diff_path(&self, trip_id: i64) -> PathBuf {
        self.root.join(format!("{trip_id}.diff"))
    }

    /// The tree for a sha, creating it if this is the first tripwire to ask,
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
    ///
    /// The trip's diff file goes first and unconditionally: it is this trip's
    /// alone, while the tree may still be held by another trip standing at the
    /// same sha, so a removal after the `refs > 0` return would leave one diff
    /// per contended sha behind for the sweep to find.
    pub async fn release(&self, trip_id: i64, sha: &str) {
        let _ = tokio::fs::remove_file(self.diff_path(trip_id)).await;
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

    /// Remove every tree on disk whose sha has no live trip, and every diff
    /// file whose trip is gone.
    ///
    /// `live` is the set of shas the ledger still has a `running` or
    /// `awaiting` trip for, read by the caller: this module knows about
    /// directories, and the ledger knows about trips. A tree this engine holds
    /// a reference to is never swept, so a sweep racing an acquire cannot pull
    /// the ground out from under a probe.
    ///
    /// `live_trips` is the matching set of trip ids, which is what the diff
    /// pass reads: a diff is per trip and a tree is per sha, so neither set
    /// answers for the other.
    pub async fn sweep(
        &self,
        live: &HashSet<String>,
        live_trips: &HashSet<i64>,
        repo_of: impl Fn(&str) -> Option<PathBuf>,
    ) {
        let held: HashSet<String> = self.open.lock().await.keys().cloned().collect();
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return;
        };
        for entry in entries.flatten() {
            // Only a directory is a tree. Without this the `<trip_id>.diff`
            // files beside the trees are offered to the loop as candidate
            // shas — never live, never held — costing a ledger query each per
            // tick and logging about trips that are running perfectly. The
            // diff pass below is what answers for them.
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let Some(sha) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if live.contains(&sha) || held.contains(&sha) {
                continue;
            }
            let path = entry.path();
            match repo_of(&sha) {
                Some(repo_root) => remove_worktree(&repo_root, &path).await,
                // A tree whose repository the ledger can no longer name is still
                // a directory this engine made. Removing the bytes is the
                // whole of what can be done; the repository it was cut from
                // prunes its own stale entry the next time anything runs
                // `git worktree` there.
                None => {
                    debug!(
                        sha,
                        "tripwire: sweeping a tree whose repository the ledger cannot name"
                    );
                    let _ = tokio::fs::remove_dir_all(&path).await;
                }
            }
        }
        self.sweep_diffs(live_trips).await;
    }

    /// Every `<trip_id>.diff` whose trip is no longer live.
    ///
    /// The ordinary end of a diff file is [`release`](Self::release); this is
    /// for the unclean one, where the process died between writing the file
    /// and settling the trip. A name that is not a number is left alone —
    /// this root is the trees' and the diffs', and a sweep that deleted
    /// whatever else it found would be a sweep nobody could put anything
    /// beside.
    async fn sweep_diffs(&self, live_trips: &HashSet<i64>) {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("diff") {
                continue;
            }
            let Some(trip_id) = path
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.parse::<i64>().ok())
            else {
                continue;
            };
            if live_trips.contains(&trip_id) {
                continue;
            }
            let _ = tokio::fs::remove_file(&path).await;
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
    // for this very sha. Removing it first is what makes the add
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

    /// Two tripwires at one sha share one tree, and it survives until the
    /// second gives its reference back ([P10]).
    #[tokio::test]
    async fn one_sha_is_one_tree_removed_after_the_last_reference() {
        let (dir, root, sha) = scratch_repo();
        let trees = InspectionTrees::new(dir.path().join("trees"));

        let first = trees.acquire(&root, &sha).await.unwrap();
        let second = trees.acquire(&root, &sha).await.unwrap();
        assert_eq!(
            first, second,
            "the second tripwire found the tree already there"
        );
        assert!(first.join("a.txt").exists(), "checked out at HEAD");

        trees.release(1, &sha).await;
        assert!(first.exists(), "one reference is still out");
        trees.release(2, &sha).await;
        assert!(!first.exists(), "the last release removed it");

        // And git no longer believes in it, so the next trip at this sha
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

        trees.release(1, &sha).await;
        assert!(!tree.exists(), "and the tree is gone afterwards");
    }

    /// An unclean exit leaves a tree nothing lists. The sweep is a directory
    /// listing against the shas that still have a live trip (Risk R04).
    #[tokio::test]
    async fn the_sweep_removes_a_tree_whose_sha_has_no_live_trip() {
        let (dir, root, sha) = scratch_repo();
        let scratch = dir.path().join("trees");
        let trees = InspectionTrees::new(scratch.clone());

        // A tree from a run that died: on disk, no reference held.
        let orphan = scratch.join(&sha);
        add_worktree(&root, &orphan, &sha).await.unwrap();
        assert!(orphan.exists());

        let repo_of = |_: &str| Some(root.clone());
        trees
            .sweep(&HashSet::from([sha.clone()]), &HashSet::new(), repo_of)
            .await;
        assert!(orphan.exists(), "a sha with a live trip keeps its tree");

        trees.sweep(&HashSet::new(), &HashSet::new(), repo_of).await;
        assert!(!orphan.exists(), "and one with none loses it");
    }

    /// A tree this engine holds a reference to is never swept, so a sweep
    /// racing a probe cannot pull the ground out from under it.
    #[tokio::test]
    async fn the_sweep_leaves_a_held_tree_alone() {
        let (dir, root, sha) = scratch_repo();
        let trees = InspectionTrees::new(dir.path().join("trees"));
        let tree = trees.acquire(&root, &sha).await.unwrap();

        trees
            .sweep(&HashSet::new(), &HashSet::new(), |_| Some(root.clone()))
            .await;
        assert!(tree.exists(), "held by a live acquire");

        trees.release(1, &sha).await;
        assert!(!tree.exists());
    }

    /// A trip's diff goes when the trip does, whether or not the tree it sat
    /// beside survives — the diff is the trip's and the tree is the sha's.
    #[tokio::test]
    async fn a_released_trip_takes_its_diff_file_with_it() {
        let (dir, root, sha) = scratch_repo();
        let trees = InspectionTrees::new(dir.path().join("trees"));
        trees.acquire(&root, &sha).await.unwrap();
        trees.acquire(&root, &sha).await.unwrap();

        std::fs::write(trees.diff_path(1), "one\n").unwrap();
        std::fs::write(trees.diff_path(2), "two\n").unwrap();

        trees.release(1, &sha).await;
        assert!(!trees.diff_path(1).exists(), "the released trip's diff");
        assert!(
            trees.diff_path(2).exists(),
            "and not the other trip's, which is still standing at this sha"
        );

        trees.release(2, &sha).await;
        assert!(!trees.diff_path(2).exists());
    }

    /// The unclean end: a process that died between writing a diff and
    /// settling its trip leaves a file only the sweep can answer for.
    #[tokio::test]
    async fn the_sweep_removes_a_diff_whose_trip_is_dead_and_keeps_a_live_one() {
        let (dir, root, sha) = scratch_repo();
        let trees = InspectionTrees::new(dir.path().join("trees"));
        trees.acquire(&root, &sha).await.unwrap();

        std::fs::write(trees.diff_path(7), "live\n").unwrap();
        std::fs::write(trees.diff_path(8), "dead\n").unwrap();
        // Not a trip's, so not the sweep's to decide about.
        let note = trees.root().join("notes.txt");
        std::fs::write(&note, "kept\n").unwrap();

        trees
            .sweep(&HashSet::from([sha.clone()]), &HashSet::from([7]), |_| {
                Some(root.clone())
            })
            .await;

        assert!(trees.diff_path(7).exists(), "its trip is still live");
        assert!(!trees.diff_path(8).exists(), "and this one's is not");
        assert!(note.exists(), "a file that is not a diff is left alone");
    }

    /// The sha loop is directory-only, so a diff file beside the trees is
    /// never a sweep candidate — and, as much to the point, never a ledger
    /// query. The count is the assertion: the file surviving would also be
    /// true of a loop that asked about it and was told to keep it.
    #[tokio::test]
    async fn the_sha_loop_never_considers_a_file_in_the_trees_root() {
        let (dir, root, sha) = scratch_repo();
        let trees = InspectionTrees::new(dir.path().join("trees"));
        let tree = trees.acquire(&root, &sha).await.unwrap();
        std::fs::write(trees.diff_path(7), "live\n").unwrap();

        let asked = std::sync::Mutex::new(Vec::<String>::new());
        trees
            .sweep(&HashSet::from([sha.clone()]), &HashSet::from([7]), |s| {
                asked.lock().unwrap().push(s.to_string());
                Some(root.clone())
            })
            .await;

        assert!(tree.exists());
        assert!(trees.diff_path(7).exists());
        assert!(
            asked.lock().unwrap().is_empty(),
            "the diff was never offered to the sha loop: {:?}",
            asked.lock().unwrap()
        );
    }
}
