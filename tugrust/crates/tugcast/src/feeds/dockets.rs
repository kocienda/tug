//! The account-global dockets feed (DOCKETS, 0x2A): every open project's
//! dockets, each with the threads derived from what is filed on it.
//!
//! One process-level snapshot feed, delivered like CHANGESET_ALL: registered
//! once, its latest frame handed to every deck on connect. Each recompute
//! enumerates `WorkspaceRegistry::project_dirs()` and, for a project whose
//! state dir holds a docket store, lists its dockets and derives each one's
//! threads through `tugarc_core::docket_threads` — off the reactor, because
//! the derivation reads the arc log, the archive, the sketches and git.
//!
//! The feed is watched, never polled. Three things wake it, and nothing else:
//!
//! - its own recursive `notify` watch of `<data root>/projects/`, filtered by
//!   [`is_docket_input_path`] to the files a thread is derived from — a
//!   docket written by a CONTROL verb or by any other process, an archive
//!   entry, a sketch, an arc-log line;
//! - the process-wide `GIT_HEAD` broadcast every workspace's git watch sends
//!   on, because a main-lane commit by a filed session lands in its thread;
//! - the registry's `dockets_bump`, because a project opening or closing
//!   changes which sections the frame carries.
//!
//! Wakes coalesce behind a short floor, and emission is suppressed when the
//! frame's bytes have not changed. A watch that cannot be armed is logged at
//! `error` and the feed goes on serving what the other two wakes give it.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::{Notify, broadcast, mpsc, watch};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info};

use tugarc_core::docket;
use tugarc_core::docket_threads::{derive_threads, gather_inputs};
use tugcast_core::types::{DocketEntry, DocketsSnapshot, ProjectDockets};
use tugcast_core::{FeedId, Frame, SnapshotFeed};
use tugcore::instance::Paths;

use super::workspace_registry::WorkspaceRegistry;

/// How long a wake waits before recomposing, so a burst of writes — a
/// docket and its brief snapshot, an archive entry's files — costs one
/// recompute. The same floor the aggregate changeset feed keeps.
const BUMP_FLOOR: std::time::Duration = std::time::Duration::from_millis(150);

/// Whether a filesystem event at `path` can change a docket's threads.
///
/// A path under a `dockets`, `arc-archive` or `sketches` directory, or an
/// `arc-log.md`, is an input; a dot-named leaf never is, which keeps the
/// store's `.lock` and every atomic write's temp file out. Everything else
/// under the data root — operation logs, ledgers, a project's other state —
/// is not, and a working-tree save never reaches this watch at all.
pub(crate) fn is_docket_input_path(path: &Path) -> bool {
    let Some(leaf) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if leaf.starts_with('.') {
        return false;
    }
    if leaf == "arc-log.md" {
        return true;
    }
    path.components().any(|c| match c {
        Component::Normal(name) => name == "dockets" || name == "arc-archive" || name == "sketches",
        _ => false,
    })
}

/// The DOCKETS feed.
pub struct DocketsFeed {
    /// The open projects each recompute enumerates.
    registry: Arc<WorkspaceRegistry>,
    /// The data root the store, archive and sketches are read under.
    paths: Paths,
    /// The process-wide `GIT_HEAD` broadcast.
    head_rx: broadcast::Receiver<Frame>,
    /// The registry's open-set signal.
    bump: Arc<Notify>,
}

impl DocketsFeed {
    pub fn new(
        registry: Arc<WorkspaceRegistry>,
        paths: Paths,
        head_rx: broadcast::Receiver<Frame>,
    ) -> Self {
        let bump = registry.dockets_bump();
        Self {
            registry,
            paths,
            head_rx,
            bump,
        }
    }
}

/// Compose one snapshot over the registry's open projects. Blocking: call it
/// from `spawn_blocking`.
pub(crate) fn compose_dockets(registry: &WorkspaceRegistry, paths: &Paths) -> DocketsSnapshot {
    let projects = registry
        .project_dirs()
        .into_iter()
        .map(|(project_dir, workspace_key)| {
            // A project that has never had a docket has no store, and costs
            // a stat rather than a log read or a git call.
            let dockets = if docket::docket_root(paths, &project_dir).is_dir() {
                docket::dockets(paths, &project_dir, true)
                    .into_iter()
                    .map(|d| {
                        let threads = derive_threads(&gather_inputs(paths, &project_dir, &d))
                            .into_iter()
                            .filter_map(|t| serde_json::to_value(t).ok())
                            .collect();
                        DocketEntry {
                            retired: d.retired(),
                            id: d.id,
                            name: d.name,
                            created: d.created,
                            threads,
                        }
                    })
                    .collect()
            } else {
                Vec::new()
            };
            ProjectDockets {
                project_dir: project_dir.to_string_lossy().into_owned(),
                workspace_key,
                dockets,
            }
        })
        .collect();
    DocketsSnapshot { projects }
}

/// Arm the recursive watch of `root`, sending one coalesced wake per burst of
/// docket-input events. `None` when it could not be armed; the caller keeps
/// the watcher alive for as long as it wants events.
fn arm_watch(root: &Path, wake_tx: mpsc::Sender<()>) -> Option<notify::RecommendedWatcher> {
    use notify::Watcher;
    let _ = std::fs::create_dir_all(root);
    // The callback runs on notify's own thread and must not block; a depth-1
    // channel's `try_send` leaves one pending wake per burst.
    let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        if event.paths.iter().any(|p| is_docket_input_path(p)) {
            let _ = wake_tx.try_send(());
        }
    });
    let mut watcher = match watcher {
        Ok(watcher) => watcher,
        Err(err) => {
            error!(error = %err, "the dockets feed could not create a watcher — dockets will refresh only on HEAD moves and project changes");
            return None;
        }
    };
    if let Err(err) = watcher.watch(root, notify::RecursiveMode::Recursive) {
        error!(dir = %root.display(), error = %err, "the dockets feed could not watch the project state dirs — dockets will refresh only on HEAD moves and project changes");
        return None;
    }
    info!(dir = %root.display(), "dockets feed watching");
    Some(watcher)
}

#[async_trait]
impl SnapshotFeed for DocketsFeed {
    fn feed_id(&self) -> FeedId {
        FeedId::DOCKETS
    }

    fn name(&self) -> &str {
        "dockets"
    }

    async fn run(self: Box<Self>, tx: watch::Sender<Frame>, cancel: CancellationToken) {
        let DocketsFeed {
            registry,
            paths,
            mut head_rx,
            bump,
        } = *self;
        let root: PathBuf = paths.base_data_dir.join("projects");
        let (wake_tx, mut wake_rx) = mpsc::channel::<()>(1);
        // Held for the whole loop: dropping the watcher unregisters the watch.
        let _watcher = arm_watch(&root, wake_tx);
        let mut head_open = true;
        let mut previous: Option<Vec<u8>> = None;

        loop {
            let started = std::time::Instant::now();
            let (registry_c, paths_c) = (Arc::clone(&registry), paths.clone());
            let snapshot =
                match tokio::task::spawn_blocking(move || compose_dockets(&registry_c, &paths_c))
                    .await
                {
                    Ok(snapshot) => snapshot,
                    Err(err) => {
                        error!(error = %err, "dockets compose task failed");
                        DocketsSnapshot::default()
                    }
                };
            debug!(
                projects = snapshot.projects.len(),
                millis = started.elapsed().as_millis() as u64,
                "dockets recomputed"
            );
            let bytes = serde_json::to_vec(&snapshot).unwrap_or_default();
            if previous.as_deref() != Some(bytes.as_slice()) {
                let _ = tx.send(Frame::new(FeedId::DOCKETS, bytes.clone()));
                previous = Some(bytes);
            }

            tokio::select! {
                _ = cancel.cancelled() => {
                    info!("dockets feed shutting down");
                    return;
                }
                _ = wake_rx.recv() => {}
                _ = bump.notified() => {}
                received = head_rx.recv(), if head_open => {
                    if let Err(broadcast::error::RecvError::Closed) = received {
                        head_open = false;
                        continue;
                    }
                }
            }
            tokio::select! {
                _ = cancel.cancelled() => {
                    info!("dockets feed shutting down");
                    return;
                }
                _ = tokio::time::sleep(BUMP_FLOOR) => {}
            }
            // Whatever landed during the floor is folded into the recompute
            // about to run: drain it, so it does not spend a second compose
            // on an identical frame.
            while wake_rx.try_recv().is_ok() {}
            while head_open {
                match head_rx.try_recv() {
                    Ok(_) | Err(broadcast::error::TryRecvError::Lagged(_)) => {}
                    Err(broadcast::error::TryRecvError::Empty) => break,
                    Err(broadcast::error::TryRecvError::Closed) => head_open = false,
                }
            }
            let _ = tokio::time::timeout(std::time::Duration::ZERO, bump.notified()).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tugcore::test_fixtures::git::{GitFixture, git};

    #[test]
    fn docket_inputs_are_the_store_the_archive_the_sketches_and_the_log() {
        let root = "/data/Tug/projects/u-src-tug";
        for path in [
            format!("{root}/dockets/3f9a1c2e/docket.json"),
            format!("{root}/dockets/3f9a1c2e/briefs/9f2c0a1b2c3d.md"),
            format!("{root}/arc-archive/rail/20261101T000000Z/arc.json"),
            format!("{root}/sketches/0a1b2c3d/sketch.json"),
            format!("{root}/arc-log.md"),
        ] {
            assert!(is_docket_input_path(Path::new(&path)), "{path}");
        }
        for path in [
            format!("{root}/oplog-001043.json"),
            format!("{root}/dockets/.lock"),
            format!("{root}/dockets/3f9a1c2e/.docket.json.tmp-1234"),
            format!("{root}/changes.db"),
            "/u/src/tug/src/main.rs".to_string(),
            "/u/src/tug/briefs/docket-loop-brief.md".to_string(),
        ] {
            assert!(!is_docket_input_path(Path::new(&path)), "{path}");
        }
    }

    #[tokio::test]
    async fn a_docket_written_on_disk_reaches_the_feed() {
        let repo_dir = tempfile::tempdir().unwrap();
        let state_dir = tempfile::tempdir().unwrap();
        let repo = repo_dir.path().canonicalize().unwrap();
        GitFixture::init(&repo);
        std::fs::write(repo.join("a.txt"), "a\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "base"]);
        let paths = Paths::under(&state_dir.path().canonicalize().unwrap());

        let cancel = CancellationToken::new();
        let registry = Arc::new(WorkspaceRegistry::new_for_test());
        let _entry = registry.get_or_create(&repo, cancel.clone()).unwrap();
        let (_head_tx, head_rx) = broadcast::channel::<Frame>(4);
        let (tx, mut rx) = watch::channel(Frame::new(FeedId::DOCKETS, vec![]));
        let feed = DocketsFeed::new(Arc::clone(&registry), paths.clone(), head_rx);
        tokio::spawn(Box::new(feed).run(tx, cancel.clone()));

        let frame_names = |frame: &Frame| -> Vec<String> {
            let snapshot: DocketsSnapshot = serde_json::from_slice(&frame.payload).unwrap();
            snapshot
                .projects
                .iter()
                .flat_map(|p| p.dockets.iter().map(|d| d.name.clone()))
                .collect()
        };

        // The initial frame: the project, with no dockets yet.
        tokio::time::timeout(std::time::Duration::from_secs(10), rx.changed())
            .await
            .expect("an initial frame")
            .unwrap();
        let initial: DocketsSnapshot =
            serde_json::from_slice(&rx.borrow_and_update().payload).unwrap();
        assert_eq!(initial.projects.len(), 1);
        assert!(initial.projects[0].dockets.is_empty());

        // A write from outside the feed reaches it through the watch alone.
        let made = docket::create_docket(&paths, &repo, "Rail work").unwrap();
        let seen = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                rx.changed().await.unwrap();
                let names = frame_names(&rx.borrow_and_update());
                if !names.is_empty() {
                    return names;
                }
            }
        })
        .await
        .expect("a frame carrying the new docket");
        assert_eq!(seen, vec!["Rail work".to_string()]);
        let last: DocketsSnapshot = serde_json::from_slice(&rx.borrow().payload).unwrap();
        assert_eq!(last.projects[0].dockets[0].id, made.id);
        cancel.cancel();
    }
}
