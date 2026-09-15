//! Event-driven git reactions — no polling, no extra OS watch.
//!
//! This does NOT open its own filesystem watcher. It rides the workspace's one
//! and only `FileWatcher` (FSEvents on macOS / inotify on Linux), whose event
//! batches flow unfiltered — including `.git` writes. Consuming that single
//! stream, a debounced batch drives two things:
//!
//!  - the account-global CHANGESET_ALL recompute (`bump`): any change under the
//!    workspace root can alter `git status`, so every batch pings the
//!    process-global recompute signal — this is what replaced the aggregate
//!    feed's periodic poll.
//!  - the GIT_HEAD signal (`gh_tx`): only when a batch touched the `.git` dir
//!    (a commit / checkout / reset / merge / rebase, from ANY source) do we
//!    re-read HEAD; if it actually moved, a `GitHeadSignal` is broadcast so a
//!    git-log consumer scoped to this `workspace_key` re-requests its log.
//!
//! One watcher per unique workspace (the registry dedups workspaces by
//! canonical path and refcounts them across cards), and this task is a plain
//! subscriber to it — so ten cards on one directory still cost exactly one OS
//! file-watch.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::{Notify, broadcast};
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use tugcast_core::types::{FsEvent, GitHeadSignal};
use tugcast_core::{FeedId, Frame};

use super::git::run_git_line;

/// True when any event in the batch touched the repo's `.git` dir — the cheap
/// gate that keeps `git rev-parse HEAD` off the hot path of plain working-tree
/// saves. Paths are relative to the workspace root (see `FileWatcher`).
fn batch_touches_git(batch: &[FsEvent]) -> bool {
    let is_git = |p: &str| p == ".git" || p.starts_with(".git/");
    batch.iter().any(|ev| match ev {
        FsEvent::Created { path } | FsEvent::Modified { path } | FsEvent::Removed { path } => {
            is_git(path)
        }
        FsEvent::Renamed { from, to } => is_git(from) || is_git(to),
    })
}

/// Read the workspace's current HEAD sha, or `""` when unborn / not a repo.
async fn read_head(repo_dir: &Path) -> String {
    run_git_line(repo_dir, &["rev-parse", "HEAD"])
        .await
        .unwrap_or_default()
}

/// The same read, blocking — the baseline a workspace takes at construction,
/// where the constructor is synchronous by contract (it runs under the
/// registry mutex, alongside the equally blocking initial directory walk).
///
/// The baseline has an ordering obligation the async read cannot meet: it must
/// be taken BEFORE the OS watch arms. Read it after, and a commit that lands
/// in between is seen by the watch but compares equal to the baseline — the
/// move is swallowed and no `GIT_HEAD` ever fires for it, leaving the client's
/// log stale with nothing to correct it.
pub fn read_head_blocking(repo_dir: &Path) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_dir)
        .args(["rev-parse", "HEAD"])
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => String::new(),
    }
}

/// React to the workspace's `FileWatcher` batches per the module docs. Runs
/// until `cancel` fires or the watcher's broadcast closes. `workspace_key` is
/// stamped into every `GitHeadSignal` so the client correlates the signal to
/// the workspace it is showing.
pub async fn run_git_workspace_watch(
    repo_dir: PathBuf,
    workspace_key: String,
    baseline_head: String,
    bump: Arc<Notify>,
    gh_tx: broadcast::Sender<Frame>,
    mut fs_rx: broadcast::Receiver<Vec<FsEvent>>,
    cancel: CancellationToken,
) {
    // Baseline HEAD so only a *move* past the current value emits a signal.
    // Read by the caller before it armed the watch — see
    // [`read_head_blocking`] for why that order is the whole point.
    let mut last_head = baseline_head;

    loop {
        // `check_git` is set when we must re-read HEAD: a batch that touched
        // `.git`, or a lag (we may have dropped a git op — re-read to be safe).
        let check_git = tokio::select! {
            _ = cancel.cancelled() => {
                debug!(dir = ?repo_dir, "git watch shutting down");
                break;
            }
            recv = fs_rx.recv() => match recv {
                Ok(batch) => batch_touches_git(&batch),
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    debug!(dir = ?repo_dir, dropped = n, "git watch lagged; re-checking HEAD");
                    true
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        };

        // Any change under the root may alter git status → recompute.
        bump.notify_one();

        if check_git {
            let head = read_head(&repo_dir).await;
            if head != last_head {
                last_head.clone_from(&head);
                let signal = GitHeadSignal {
                    workspace_key: workspace_key.clone(),
                    head,
                };
                match serde_json::to_vec(&signal) {
                    Ok(json) => {
                        let _ = gh_tx.send(Frame::new(FeedId::GIT_HEAD, json));
                    }
                    Err(e) => {
                        warn!(error = %e, "git watch: failed to serialize GIT_HEAD");
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tempfile::TempDir;
    use tokio::process::Command;

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

    fn spawn_committed_repo() -> TempDir {
        TempDir::new().unwrap()
    }

    #[test]
    fn batch_touches_git_detects_dot_git_paths() {
        assert!(batch_touches_git(&[FsEvent::Modified {
            path: ".git/logs/HEAD".to_string()
        }]));
        assert!(batch_touches_git(&[FsEvent::Renamed {
            from: ".git/index.lock".to_string(),
            to: ".git/index".to_string(),
        }]));
        assert!(!batch_touches_git(&[FsEvent::Modified {
            path: "src/main.rs".to_string()
        }]));
        // A file literally named `.gitignore` is not the `.git` dir.
        assert!(!batch_touches_git(&[FsEvent::Modified {
            path: ".gitignore".to_string()
        }]));
    }

    /// A `.git`-touching batch that moved HEAD fires GIT_HEAD + bump; a
    /// working-tree-only batch bumps without a signal — all off one fed stream.
    #[tokio::test]
    async fn head_move_signals_working_edit_only_bumps() {
        let temp = spawn_committed_repo();
        let repo = temp.path().to_path_buf();
        git_in(&repo, &["init", "-b", "main"]).await;
        git_in(&repo, &["config", "user.name", "test"]).await;
        git_in(&repo, &["config", "user.email", "test@test.com"]).await;
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git_in(&repo, &["add", "-A"]).await;
        git_in(&repo, &["commit", "-m", "first"]).await;
        let head1 = run_git_line(&repo, &["rev-parse", "HEAD"]).await.unwrap();

        let bump = Arc::new(Notify::new());
        let (gh_tx, mut gh_rx) = broadcast::channel::<Frame>(16);
        let (fs_tx, fs_rx) = broadcast::channel::<Vec<FsEvent>>(16);
        let cancel = CancellationToken::new();
        let handle = tokio::spawn(run_git_workspace_watch(
            repo.clone(),
            "ws".to_string(),
            head1.clone(),
            Arc::clone(&bump),
            gh_tx,
            fs_rx,
            cancel.clone(),
        ));

        // A working-tree-only batch → bump, no HEAD signal.
        fs_tx
            .send(vec![FsEvent::Modified {
                path: "a.txt".to_string(),
            }])
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), bump.notified())
            .await
            .expect("bump on a working-tree edit");
        let none = tokio::time::timeout(Duration::from_millis(500), gh_rx.recv()).await;
        assert!(none.is_err(), "a non-.git batch must not signal HEAD");

        // Now actually move HEAD, then feed a `.git`-touching batch.
        std::fs::write(repo.join("b.txt"), "two\n").unwrap();
        git_in(&repo, &["add", "-A"]).await;
        git_in(&repo, &["commit", "-m", "second"]).await;
        let head2 = run_git_line(&repo, &["rev-parse", "HEAD"]).await.unwrap();
        assert_ne!(head1, head2);

        fs_tx
            .send(vec![FsEvent::Modified {
                path: ".git/logs/HEAD".to_string(),
            }])
            .unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(5), gh_rx.recv())
            .await
            .expect("GIT_HEAD within timeout")
            .expect("broadcast frame");
        assert_eq!(frame.feed_id, FeedId::GIT_HEAD);
        let signal: GitHeadSignal = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(signal.workspace_key, "ws");
        assert_eq!(signal.head, head2);

        cancel.cancel();
        let _ = handle.await;
    }

    /// The channel is a broadcast, and a second subscriber may stand on it
    /// beside the base-motion engine. One HEAD move has to reach both — a
    /// `Sender::send` that fanned out to only the first receiver would leave
    /// whichever engine happened to subscribe later
    /// blind, with nothing in either engine's own code to show for it.
    #[tokio::test]
    async fn every_subscriber_on_the_shared_channel_sees_one_head_move() {
        let temp = spawn_committed_repo();
        let repo = temp.path().to_path_buf();
        git_in(&repo, &["init", "-b", "main"]).await;
        git_in(&repo, &["config", "user.name", "test"]).await;
        git_in(&repo, &["config", "user.email", "test@test.com"]).await;
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git_in(&repo, &["add", "-A"]).await;
        git_in(&repo, &["commit", "-m", "first"]).await;
        let head1 = run_git_line(&repo, &["rev-parse", "HEAD"]).await.unwrap();

        let bump = Arc::new(Notify::new());
        let (gh_tx, mut first_rx) = broadcast::channel::<Frame>(16);
        // The second subscription, taken exactly as `main.rs` takes the
        // base-motion engine's: off the shared sender, before the watch runs.
        let mut second_rx = gh_tx.subscribe();
        let (fs_tx, fs_rx) = broadcast::channel::<Vec<FsEvent>>(16);
        let cancel = CancellationToken::new();
        let handle = tokio::spawn(run_git_workspace_watch(
            repo.clone(),
            "ws".to_string(),
            head1.clone(),
            Arc::clone(&bump),
            gh_tx,
            fs_rx,
            cancel.clone(),
        ));

        std::fs::write(repo.join("b.txt"), "two\n").unwrap();
        git_in(&repo, &["add", "-A"]).await;
        git_in(&repo, &["commit", "-m", "second"]).await;
        let head2 = run_git_line(&repo, &["rev-parse", "HEAD"]).await.unwrap();

        fs_tx
            .send(vec![FsEvent::Modified {
                path: ".git/logs/HEAD".to_string(),
            }])
            .unwrap();

        for (label, rx) in [("first", &mut first_rx), ("second", &mut second_rx)] {
            let frame = tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .unwrap_or_else(|_| panic!("{label} subscriber saw no GIT_HEAD"))
                .expect("broadcast frame");
            assert_eq!(frame.feed_id, FeedId::GIT_HEAD);
            let signal: GitHeadSignal = serde_json::from_slice(&frame.payload).unwrap();
            assert_eq!(signal.workspace_key, "ws", "{label}");
            assert_eq!(signal.head, head2, "{label}");
        }

        cancel.cancel();
        let _ = handle.await;
    }
}
