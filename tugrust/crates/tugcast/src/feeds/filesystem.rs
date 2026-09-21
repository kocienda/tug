//! Filesystem feed implementation
//!
//! Thin broadcast consumer: subscribes to the FileWatcher broadcast channel
//! and forwards Vec<FsEvent> batches as Frame::new(FeedId::FILESYSTEM, json).
//!
//! It publishes onto a `broadcast::Sender<Frame>` shared by every workspace,
//! NOT a `watch` channel. A watch channel retains one latest value, so two
//! batches arriving between forwarder wakeups coalesced and the first was
//! simply gone — with nothing downstream able to tell that it had happened.
//! A broadcast channel delivers every frame, and when a consumer falls far
//! enough behind to drop some, it says so: the feed publishes a `resync`
//! frame carrying its workspace key, and every consumer re-asks rather than
//! believing a state it may have missed the correction to.
//!
//! `.git/` internals are dropped here, downstream of the watcher broadcast,
//! so `git_watch` and `FileTreeFeed` still see every event. A commit rewrites
//! dozens of files under `.git/` and none of them is a change to the user's
//! work; `.gitignore` at the root is NOT `.git/` and is never dropped.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use tugcast_core::types::FsEvent;
use tugcast_core::{FeedId, Frame};

/// Wrapper struct that places `workspace_key` as the first JSON field
/// ahead of the event batch. FilesystemFeed uses this instead of the
/// `splice_workspace_key` helper because its payload is a bare JSON array
/// (`Vec<FsEvent>`), which is incompatible with an object-level splice.
/// See [D08] in the W1 plan.
#[derive(Serialize)]
struct FilesystemBatch<'a> {
    workspace_key: &'a str,
    /// Set only on the frame that says "I lost some events; ask again".
    /// Skipped when false, so an ordinary batch is byte-identical to what
    /// this feed has always sent — including `workspace_key` first.
    #[serde(skip_serializing_if = "is_false")]
    resync: bool,
    events: &'a [FsEvent],
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// True for an event that names something inside `.git/`.
///
/// Exactly `.git` or a path beginning `.git/` — `.gitignore`, `.github/` and
/// a file called `git` are all the user's work and all stay.
fn is_git_internal(path: &str) -> bool {
    path == ".git" || path.starts_with(".git/")
}

/// Whether this event should reach clients at all.
fn event_is_visible(event: &FsEvent) -> bool {
    match event {
        FsEvent::Created { path } | FsEvent::Modified { path } | FsEvent::Removed { path } => {
            !is_git_internal(path)
        }
        // A rename is dropped only when BOTH ends are internal. A file moved
        // out of `.git/` really did appear in the user's tree.
        FsEvent::Renamed { from, to } => !is_git_internal(from) || !is_git_internal(to),
    }
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

    /// The feed id every frame this feed publishes carries.
    pub fn feed_id(&self) -> FeedId {
        FeedId::FILESYSTEM
    }

    /// This feed's name, for logs and stats.
    pub fn name(&self) -> &str {
        "filesystem"
    }

    /// Forward watcher batches onto the shared `FILESYSTEM` sender until
    /// `cancel` fires.
    pub async fn run(self, tx: broadcast::Sender<Frame>, cancel: CancellationToken) {
        let mut rx = self.event_tx.subscribe();
        info!(feed = self.name(), dir = ?self.watch_dir, "filesystem feed started");

        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    info!("filesystem feed shutting down");
                    break;
                }
                result = rx.recv() => {
                    match result {
                        Ok(batch) => {
                            let visible: Vec<FsEvent> =
                                batch.into_iter().filter(event_is_visible).collect();
                            // A batch that was nothing but `.git/` churn is
                            // not an empty change — it is no change at all.
                            if visible.is_empty() {
                                continue;
                            }
                            let _ = tx.send(self.frame(false, &visible));
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            warn!(skipped = n, "filesystem feed lagged, skipping messages");
                            // Events this feed will never see again. Say so:
                            // a consumer that silently missed a delete keeps
                            // showing a file that is gone.
                            let _ = tx.send(self.frame(true, &[]));
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

    /// One `FILESYSTEM` frame under this feed's workspace key.
    fn frame(&self, resync: bool, events: &[FsEvent]) -> Frame {
        let json = serde_json::to_vec(&FilesystemBatch {
            workspace_key: &self.workspace_key,
            resync,
            events,
        })
        .unwrap_or_default();
        Frame::new(self.feed_id(), json)
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

    /// Decode a frame's payload into the fields the wire actually carries.
    #[derive(serde::Deserialize)]
    struct BatchOwned {
        workspace_key: String,
        #[serde(default)]
        resync: bool,
        events: Vec<FsEvent>,
    }
    fn decode(frame: &Frame) -> BatchOwned {
        serde_json::from_slice(&frame.payload).expect("a FILESYSTEM frame decodes")
    }

    fn feed(key: &str, event_tx: broadcast::Sender<Vec<FsEvent>>) -> FilesystemFeed {
        FilesystemFeed::new(
            PathBuf::from("/unused-in-this-test"),
            event_tx,
            Arc::from(key),
        )
    }

    /// Let a spawned feed reach its `subscribe()` before anything is sent.
    async fn let_it_subscribe() {
        tokio::task::yield_now().await;
        sleep(Duration::from_millis(20)).await;
    }

    #[test]
    fn test_feed_id_and_name() {
        let (tx, _) = broadcast::channel(256);
        let feed = feed("test-workspace", tx);
        assert_eq!(feed.feed_id(), FeedId::FILESYSTEM);
        assert_eq!(feed.name(), "filesystem");
    }

    /// Integration test: FilesystemFeed produces correct wire format when
    /// consuming FileWatcher broadcast.
    #[tokio::test]
    async fn test_filesystem_feed_integration() {
        let temp_dir = TempDir::new().unwrap();
        let watch_path = temp_dir.path().to_path_buf();

        let (broadcast_tx, _) = broadcast::channel::<Vec<FsEvent>>(256);
        let file_watcher = FileWatcher::new(watch_path.clone());
        let armed = file_watcher.arm().expect("arm the watch");

        // Derive the fixture workspace_key from the real TempDir path —
        // mirrors how WorkspaceRegistry builds the key in production.
        let fixture_key: Arc<str> = Arc::from(watch_path.to_string_lossy().as_ref());
        let feed = FilesystemFeed::new(
            watch_path.clone(),
            broadcast_tx.clone(),
            fixture_key.clone(),
        );

        let (frame_tx, mut frame_rx) = broadcast::channel::<Frame>(64);
        let cancel = CancellationToken::new();
        let watcher_cancel = cancel.clone();
        let watcher_broadcast_tx = broadcast_tx.clone();
        tokio::spawn(async move {
            file_watcher
                .run_armed(armed, watcher_broadcast_tx, watcher_cancel)
                .await;
        });
        let feed_cancel = cancel.clone();
        let feed_task = tokio::spawn(async move { feed.run(frame_tx, feed_cancel).await });

        // Wait for watcher to initialize
        sleep(Duration::from_millis(150)).await;

        let test_file = watch_path.join("test.txt");
        fs::write(&test_file, "hello").unwrap();
        sleep(Duration::from_millis(50)).await;
        fs::write(&test_file, "hello world").unwrap();
        sleep(Duration::from_millis(50)).await;
        fs::remove_file(&test_file).unwrap();

        let frame = tokio::time::timeout(Duration::from_secs(5), frame_rx.recv())
            .await
            .expect("a frame within five seconds")
            .expect("the sender is live");
        assert_eq!(frame.feed_id, FeedId::FILESYSTEM);
        let parsed = decode(&frame);
        assert_eq!(parsed.workspace_key, fixture_key.as_ref());
        assert!(
            !parsed.events.is_empty(),
            "should have received filesystem events"
        );

        cancel.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(2), feed_task).await;
    }

    /// W1: the wire payload keeps `workspace_key` as its FIRST field, and an
    /// ordinary batch carries no `resync` key at all — the byte shape every
    /// existing client parses.
    #[tokio::test]
    async fn test_workspace_key_spliced_into_filesystem_frame() {
        let fixture_key: Arc<str> = Arc::from("test-workspace");
        let (broadcast_tx, _) = broadcast::channel::<Vec<FsEvent>>(16);
        let (frame_tx, mut frame_rx) = broadcast::channel::<Frame>(16);
        let cancel = CancellationToken::new();
        let feed = feed(&fixture_key, broadcast_tx.clone());
        let feed_cancel = cancel.clone();
        let feed_task = tokio::spawn(async move { feed.run(frame_tx, feed_cancel).await });
        let_it_subscribe().await;

        broadcast_tx
            .send(vec![FsEvent::Created {
                path: "hello.rs".to_string(),
            }])
            .unwrap();
        let frame = frame_rx.recv().await.unwrap();

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
        assert!(
            parsed.get("resync").is_none(),
            "an ordinary batch carries no resync key: {parsed}"
        );

        cancel.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(2), feed_task).await;
    }

    /// The loss this arc exists to fix: fifty batches sent back-to-back
    /// arrive as fifty frames. On the old `watch` channel the reader saw
    /// only the last, and nothing said the others had happened.
    #[tokio::test]
    async fn fifty_back_to_back_batches_all_arrive() {
        let (broadcast_tx, _) = broadcast::channel::<Vec<FsEvent>>(256);
        let (frame_tx, mut frame_rx) = broadcast::channel::<Frame>(256);
        let cancel = CancellationToken::new();
        let feed = feed("w", broadcast_tx.clone());
        let feed_cancel = cancel.clone();
        let feed_task = tokio::spawn(async move { feed.run(frame_tx, feed_cancel).await });
        let_it_subscribe().await;

        for i in 0..50 {
            broadcast_tx
                .send(vec![FsEvent::Modified {
                    path: format!("file-{i}.rs"),
                }])
                .unwrap();
        }

        let mut seen = Vec::new();
        for _ in 0..50 {
            let frame = tokio::time::timeout(Duration::from_secs(5), frame_rx.recv())
                .await
                .expect("fifty frames within five seconds")
                .expect("the sender is live");
            seen.push(decode(&frame).events);
        }
        assert_eq!(seen.len(), 50);
        assert_eq!(
            seen[0],
            vec![FsEvent::Modified {
                path: "file-0.rs".to_string()
            }],
            "the FIRST batch is the one a latest-value channel lost"
        );

        cancel.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(2), feed_task).await;
    }

    /// A feed that fell behind says so, under its own key — and two
    /// workspaces' feeds sharing one sender each say it under theirs.
    #[tokio::test]
    async fn a_lagging_feed_publishes_resync_under_its_own_key() {
        // Capacity 1 so two sends without a read overflow the receiver.
        let (broadcast_tx, _) = broadcast::channel::<Vec<FsEvent>>(1);
        let (frame_tx, mut frame_rx) = broadcast::channel::<Frame>(64);
        let cancel = CancellationToken::new();
        let mut tasks = Vec::new();
        for key in ["alpha", "beta"] {
            let feed = feed(key, broadcast_tx.clone());
            let feed_tx = frame_tx.clone();
            let feed_cancel = cancel.clone();
            tasks.push(tokio::spawn(
                async move { feed.run(feed_tx, feed_cancel).await },
            ));
        }
        let_it_subscribe().await;

        // Overrun both feeds' receivers before either gets scheduled.
        for i in 0..8 {
            broadcast_tx
                .send(vec![FsEvent::Modified {
                    path: format!("f{i}"),
                }])
                .unwrap();
        }

        let mut resync_keys = Vec::new();
        while resync_keys.len() < 2 {
            let frame = tokio::time::timeout(Duration::from_secs(5), frame_rx.recv())
                .await
                .expect("a resync from each feed")
                .expect("the sender is live");
            let parsed = decode(&frame);
            if parsed.resync {
                assert!(parsed.events.is_empty(), "a resync carries no events");
                if !resync_keys.contains(&parsed.workspace_key) {
                    resync_keys.push(parsed.workspace_key);
                }
            }
        }
        resync_keys.sort();
        assert_eq!(resync_keys, vec!["alpha".to_string(), "beta".to_string()]);

        cancel.cancel();
        for task in tasks {
            let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
        }
    }

    /// `.git/` churn is invisible; everything that merely looks like it is not.
    #[test]
    fn git_internals_are_dropped_and_lookalikes_are_not() {
        for path in [".git", ".git/HEAD", ".git/refs/heads/main"] {
            assert!(
                !event_is_visible(&FsEvent::Modified {
                    path: path.to_string()
                }),
                "{path} is git's own"
            );
        }
        for path in [
            ".gitignore",
            ".github/workflows/ci.yml",
            "git",
            "src/.git-notes",
        ] {
            assert!(
                event_is_visible(&FsEvent::Modified {
                    path: path.to_string()
                }),
                "{path} is the user's work"
            );
        }
        // A rename out of `.git/` is a file appearing in the tree.
        assert!(event_is_visible(&FsEvent::Renamed {
            from: ".git/ORIG_HEAD".to_string(),
            to: "notes.txt".to_string(),
        }));
        assert!(!event_is_visible(&FsEvent::Renamed {
            from: ".git/a".to_string(),
            to: ".git/b".to_string(),
        }));
    }

    /// A batch of nothing but `.git/` events publishes nothing at all; a
    /// mixed batch publishes only the rest of it.
    #[tokio::test]
    async fn a_git_only_batch_publishes_nothing() {
        let (broadcast_tx, _) = broadcast::channel::<Vec<FsEvent>>(64);
        let (frame_tx, mut frame_rx) = broadcast::channel::<Frame>(64);
        let cancel = CancellationToken::new();
        let feed = feed("w", broadcast_tx.clone());
        let feed_cancel = cancel.clone();
        let feed_task = tokio::spawn(async move { feed.run(frame_tx, feed_cancel).await });
        let_it_subscribe().await;

        broadcast_tx
            .send(vec![
                FsEvent::Modified {
                    path: ".git/HEAD".to_string(),
                },
                FsEvent::Created {
                    path: ".git/index.lock".to_string(),
                },
            ])
            .unwrap();
        broadcast_tx
            .send(vec![
                FsEvent::Modified {
                    path: ".git/index".to_string(),
                },
                FsEvent::Modified {
                    path: "src/main.rs".to_string(),
                },
                FsEvent::Modified {
                    path: ".gitignore".to_string(),
                },
            ])
            .unwrap();

        // The FIRST frame to arrive is the mixed batch's: the git-only batch
        // published nothing, so there is nothing of it to skip past.
        let frame = tokio::time::timeout(Duration::from_secs(5), frame_rx.recv())
            .await
            .expect("the mixed batch arrives")
            .expect("the sender is live");
        assert_eq!(
            decode(&frame).events,
            vec![
                FsEvent::Modified {
                    path: "src/main.rs".to_string()
                },
                FsEvent::Modified {
                    path: ".gitignore".to_string()
                },
            ]
        );

        cancel.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(2), feed_task).await;
    }
}
