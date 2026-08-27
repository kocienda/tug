//! Filesystem feed implementation
//!
//! Thin broadcast consumer: subscribes to the FileWatcher broadcast channel
//! and forwards Vec<FsEvent> batches as Frame::new(FeedId::FILESYSTEM, json).

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;
use tokio::sync::{broadcast, watch};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use tugcast_core::types::FsEvent;
use tugcast_core::{FeedId, Frame, SnapshotFeed};

/// Wrapper struct that places `workspace_key` as the first JSON field
/// ahead of the event batch. FilesystemFeed uses this instead of the
/// `splice_workspace_key` helper because its payload is a bare JSON array
/// (`Vec<FsEvent>`), which is incompatible with an object-level splice.
/// See [D08] in the W1 plan.
#[derive(Serialize)]
struct FilesystemBatch<'a> {
    workspace_key: &'a str,
    events: &'a [FsEvent],
}

/// Filesystem feed — thin consumer of the FileWatcher broadcast channel.
pub struct FilesystemFeed {
    watch_dir: PathBuf,
    event_tx: broadcast::Sender<Vec<FsEvent>>,
    workspace_key: Arc<str>,
}

impl FilesystemFeed {
    /// Create a new filesystem feed.
    ///
    /// `watch_dir` is used only for logging. `event_tx` is the broadcast sender
    /// created by the FileWatcher; `run()` calls `subscribe()` on it to get its
    /// own receiver. `workspace_key` is the canonical workspace identifier
    /// written as the first field of every emitted FILESYSTEM frame.
    pub fn new(
        watch_dir: PathBuf,
        event_tx: broadcast::Sender<Vec<FsEvent>>,
        workspace_key: Arc<str>,
    ) -> Self {
        Self {
            watch_dir,
            event_tx,
            workspace_key,
        }
    }
}

#[async_trait]
impl SnapshotFeed for FilesystemFeed {
    fn feed_id(&self) -> FeedId {
        FeedId::FILESYSTEM
    }

    fn name(&self) -> &str {
        "filesystem"
    }

    async fn run(self: Box<Self>, tx: watch::Sender<Frame>, cancel: CancellationToken) {
        let mut rx = self.event_tx.subscribe();
        info!(dir = ?self.watch_dir, "filesystem feed started");

        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    info!("filesystem feed shutting down");
                    break;
                }
                result = rx.recv() => {
                    match result {
                        Ok(batch) => {
                            let json = serde_json::to_vec(&FilesystemBatch {
                                workspace_key: &self.workspace_key,
                                events: &batch,
                            })
                            .unwrap_or_default();
                            let frame = Frame::new(FeedId::FILESYSTEM, json);
                            let _ = tx.send(frame);
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            warn!(skipped = n, "filesystem feed lagged, skipping messages");
                            // Continue — the watcher is still running and we'll receive future batches
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            info!("filesystem feed broadcast closed, shutting down");
                            break;
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;
    use tempfile::TempDir;
    use tokio::time::sleep;

    use crate::feeds::file_watcher::FileWatcher;

    #[test]
    fn test_feed_id_and_name() {
        let (tx, _) = broadcast::channel(256);
        let feed = FilesystemFeed::new(
            PathBuf::from("/unused-in-this-test"),
            tx,
            Arc::from("test-workspace"),
        );
        assert_eq!(feed.feed_id(), FeedId::FILESYSTEM);
        assert_eq!(feed.name(), "filesystem");
    }

    /// Integration test: FilesystemFeed produces correct wire format when consuming
    /// FileWatcher broadcast.
    #[tokio::test]
    async fn test_filesystem_feed_integration() {
        let temp_dir = TempDir::new().unwrap();
        let watch_path = temp_dir.path().to_path_buf();

        // Create the broadcast channel and FileWatcher
        let (broadcast_tx, _) = broadcast::channel::<Vec<FsEvent>>(256);
        let file_watcher = FileWatcher::new(watch_path.clone());
        let armed = file_watcher.arm().expect("arm the watch");

        // Derive the fixture workspace_key from the real TempDir path —
        // mirrors how WorkspaceRegistry builds the key in production.
        let fixture_key: Arc<str> = Arc::from(watch_path.to_string_lossy().as_ref());

        // Create the FilesystemFeed (subscribes to broadcast_tx)
        let feed = FilesystemFeed::new(
            watch_path.clone(),
            broadcast_tx.clone(),
            fixture_key.clone(),
        );

        // Create watch channel
        let (fs_watch_tx, mut fs_watch_rx) = watch::channel(Frame::new(FeedId::FILESYSTEM, vec![]));

        // Spawn the FileWatcher in the background
        let cancel = CancellationToken::new();
        let watcher_cancel = cancel.clone();
        let watcher_broadcast_tx = broadcast_tx.clone();
        tokio::spawn(async move {
            file_watcher
                .run_armed(armed, watcher_broadcast_tx, watcher_cancel)
                .await;
        });

        // Spawn the FilesystemFeed in the background
        let feed_cancel = cancel.clone();
        let feed_task = tokio::spawn(async move {
            Box::new(feed).run(fs_watch_tx, feed_cancel).await;
        });

        // Wait for watcher to initialize
        sleep(Duration::from_millis(150)).await;

        // Create a file
        let test_file = watch_path.join("test.txt");
        fs::write(&test_file, "hello").unwrap();

        // Modify the file
        sleep(Duration::from_millis(50)).await;
        fs::write(&test_file, "hello world").unwrap();

        // Remove the file
        sleep(Duration::from_millis(50)).await;
        fs::remove_file(&test_file).unwrap();

        // Wait for debounce and processing
        sleep(Duration::from_millis(400)).await;

        // Check for events
        fs_watch_rx.changed().await.unwrap();
        let frame = fs_watch_rx.borrow_and_update().clone();

        assert_eq!(frame.feed_id, FeedId::FILESYSTEM);

        #[derive(serde::Deserialize)]
        struct FilesystemBatchOwned {
            workspace_key: String,
            events: Vec<FsEvent>,
        }
        let parsed: FilesystemBatchOwned = serde_json::from_slice(&frame.payload).unwrap();

        assert_eq!(parsed.workspace_key, fixture_key.as_ref());
        assert!(
            !parsed.events.is_empty(),
            "should have received filesystem events"
        );

        // Cancel and wait for cleanup
        cancel.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(2), feed_task).await;
    }

    /// W1: FilesystemFeed's wire payload is a `FilesystemBatch` wrapper with
    /// `workspace_key` as the first field, produced directly via serde rather
    /// than via the `splice_workspace_key` helper (see [D08]).
    #[tokio::test]
    async fn test_workspace_key_spliced_into_filesystem_frame() {
        use tugcast_core::types::FsEvent;

        // Synthetic label — this test does not touch the real filesystem, so
        // the workspace_key is a pure string label (not a canonicalized path).
        let fixture_key: Arc<str> = Arc::from("test-workspace");

        let (broadcast_tx, _) = broadcast::channel::<Vec<FsEvent>>(16);
        let feed = FilesystemFeed::new(
            PathBuf::from("/unused-in-this-test"),
            broadcast_tx.clone(),
            fixture_key.clone(),
        );

        let (fs_watch_tx, mut fs_watch_rx) = watch::channel(Frame::new(FeedId::FILESYSTEM, vec![]));
        let cancel = CancellationToken::new();
        let feed_cancel = cancel.clone();
        let feed_task = tokio::spawn(async move {
            Box::new(feed).run(fs_watch_tx, feed_cancel).await;
        });

        // Give the feed a moment to subscribe before we publish.
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(20)).await;

        broadcast_tx
            .send(vec![FsEvent::Created {
                path: "hello.rs".to_string(),
            }])
            .unwrap();

        fs_watch_rx.changed().await.unwrap();
        let frame = fs_watch_rx.borrow_and_update().clone();

        // Field ordering check is done on the raw bytes because
        // `serde_json::Value` normalizes object key order (BTreeMap).
        let expected_prefix = format!(r#"{{"workspace_key":"{}","#, fixture_key);
        assert!(
            frame.payload.starts_with(expected_prefix.as_bytes()),
            "workspace_key must be the first field; got: {}",
            String::from_utf8_lossy(&frame.payload)
        );
        let parsed: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(parsed["workspace_key"], fixture_key.as_ref());
        assert!(parsed["events"].is_array());

        cancel.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(2), feed_task).await;
    }
}
