//! JOTS feed for tugcast.
//!
//! Reads the machine-global `jots.json` and pushes it — the whole document
//! plus its content hash — to every WebSocket client via a `watch::Sender<Frame>`,
//! republishing on every file change. Because each running build's tugcast
//! watches the same file, a write by any build (via `PUT /api/jots`)
//! propagates to every running frontend, giving cross-build live sync for free.
//!
//! # Frame format (Spec S02)
//!
//! ```json
//! { "doc": { "version": 1, "jots": [...] }, "hash": "<sha256 hex>", "error": null }
//! ```
//!
//! On a corrupt / unreadable file the last good document is retained and the
//! frame carries `hash: null` and a human-readable `error`.
//!
//! # Watching
//!
//! The feed task polls `jots.json` **by path**, comparing `(mtime, len)`
//! each tick and re-reading only when that stamp moves. Polling by path is
//! immune to the atomic writes that replace the file via `rename`: every tick
//! stats whatever currently lives at the path, so a replaced inode is a
//! non-event. It is also robust across sandboxes and the `/private/var`
//! firmlink, which is why this feed polls rather than taking OS file events.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde_json::json;
use tokio::sync::{Notify, watch};
use tokio::time::MissedTickBehavior;
use tracing::debug;
use tugcast_core::{FeedId, Frame};

use crate::jots::{JotsDoc, ReadOutcome, read_jots};

/// Debounce window coalescing a burst of writes into one rebuild.
const DEBOUNCE_MILLIS: u64 = 100;

/// Poll interval for the file stamp. 250 ms is comfortably inside the ~1 s
/// cross-build sync budget. The `PUT` nudge gives the writing build instant
/// feedback, so this interval only governs how fast *other* builds see a
/// change.
const POLL_MILLIS: u64 = 250;

/// Last observed `(mtime, len)` of the polled file. `None` — the file is
/// absent or its metadata is unreadable — is a stamp of its own, so the file
/// appearing or disappearing is a change like any other.
type FileStamp = Option<(SystemTime, u64)>;

/// Stat `path` and reduce it to the change-detection stamp.
fn file_stamp(path: &Path) -> FileStamp {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

/// Build a JOTS frame from a read outcome, retaining the last good
/// document when the on-disk file is unreadable (`error` present).
fn frame_from_outcome(outcome: &ReadOutcome, last_good: &mut JotsDoc) -> Frame {
    let payload = if outcome.error.is_some() {
        json!({ "doc": &*last_good, "hash": serde_json::Value::Null, "error": outcome.error })
    } else {
        *last_good = outcome.doc.clone();
        json!({ "doc": outcome.doc, "hash": outcome.hash, "error": serde_json::Value::Null })
    };
    let bytes = serde_json::to_vec(&payload).unwrap_or_default();
    Frame::new(FeedId::JOTS, bytes)
}

/// Start the JOTS feed.
///
/// Reads `jots.json` at `path`, sends an initial frame, and returns the
/// `watch::Receiver<Frame>` for wiring into `snapshot_watches` plus a
/// [`Notify`] the `PUT` handler pulses to force an immediate rebuild (so the
/// writer's own frontend doesn't wait on the poll interval).
///
/// The spawned task holds the `watch::Sender`; it exits when all receivers are
/// dropped (`tx.closed()`), mirroring `defaults_feed`. That arm is the task's
/// only exit — a rebuild whose content is unchanged publishes nothing, so the
/// send path can stay quiet indefinitely.
pub fn jots_feed(path: PathBuf) -> (watch::Receiver<Frame>, Arc<Notify>) {
    let mut last_good = JotsDoc::empty();
    // Stamp before reading, and before the task spawns: a write landing in
    // either window leaves the stamp behind the bytes, so the next tick
    // re-reads. The reverse order could stamp bytes that were never published.
    let initial_stamp = file_stamp(&path);
    let initial_outcome = read_jots(&path);
    // Seed from the frame subscribers already hold, so the first rebuild does
    // not republish a duplicate of it.
    let mut published_hash = initial_outcome.hash.clone();
    let initial = frame_from_outcome(&initial_outcome, &mut last_good);
    let (tx, rx) = watch::channel(initial);
    let nudge = Arc::new(Notify::new());

    let task_nudge = Arc::clone(&nudge);
    tokio::spawn(async move {
        let mut stamp = initial_stamp;
        let mut ticker = tokio::time::interval(Duration::from_millis(POLL_MILLIS));
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = tx.closed() => {
                    debug!("jots_feed: all receivers dropped, task exiting");
                    break;
                }
                _ = task_nudge.notified() => {}
                _ = ticker.tick() => {
                    let observed = file_stamp(&path);
                    if observed == stamp {
                        continue;
                    }
                    // Let a burst of writes settle, then take the stamp the
                    // read below actually sees.
                    tokio::time::sleep(Duration::from_millis(DEBOUNCE_MILLIS)).await;
                    stamp = file_stamp(&path);
                }
            }

            let outcome = read_jots(&path);
            // Republish only on a content change. An error outcome always
            // publishes — its message is the payload.
            if outcome.error.is_none() && outcome.hash.is_some() && outcome.hash == published_hash {
                continue;
            }
            published_hash = outcome.hash.clone();
            let frame = frame_from_outcome(&outcome, &mut last_good);
            if tx.send(frame).is_err() {
                break;
            }
        }
    });

    (rx, nudge)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jots::{Jot, write_jots_atomic};

    fn parse_frame(frame: &Frame) -> serde_json::Value {
        assert_eq!(frame.feed_id, FeedId::JOTS);
        serde_json::from_slice(&frame.payload).expect("frame payload is JSON")
    }

    fn sample_doc() -> JotsDoc {
        JotsDoc {
            version: 1,
            jots: vec![Jot {
                id: "sn_a".into(),
                text: "body".into(),
                origins: Vec::new(),
                atoms: Vec::new(),
            }],
        }
    }

    #[tokio::test]
    async fn initial_frame_reflects_existing_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("jots.json");
        write_jots_atomic(&path, &sample_doc()).unwrap();

        let (rx, _nudge) = jots_feed(path);
        let frame = rx.borrow();
        let json = parse_frame(&frame);
        assert_eq!(json["doc"]["jots"][0]["id"], "sn_a");
        assert!(json["hash"].is_string());
        assert!(json["error"].is_null());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn external_write_triggers_new_frame() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("jots.json");

        let (mut rx, _nudge) = jots_feed(path.clone());
        // Initial frame is the empty document.
        assert!(parse_frame(&rx.borrow_and_update())["error"].is_null());

        // An external writer creates the file: the absent → present stamp move.
        write_jots_atomic(&path, &sample_doc()).unwrap();

        // The watcher fires; wait for the next frame (bounded).
        tokio::time::timeout(Duration::from_secs(10), rx.changed())
            .await
            .expect("frame within timeout")
            .expect("sender alive");
        let json = parse_frame(&rx.borrow());
        assert_eq!(json["doc"]["jots"][0]["id"], "sn_a");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn external_rewrite_of_existing_file_triggers_new_frame() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("jots.json");
        write_jots_atomic(&path, &sample_doc()).unwrap();

        let (mut rx, _nudge) = jots_feed(path.clone());
        assert_eq!(
            parse_frame(&rx.borrow_and_update())["doc"]["jots"][0]["id"],
            "sn_a"
        );

        // A second write to a file that already existed at feed start: the
        // present → present stamp move, which no rename-based watch would see
        // on the inode it first opened.
        let mut doc = sample_doc();
        doc.jots[0].id = "sn_b".into();
        write_jots_atomic(&path, &doc).unwrap();

        tokio::time::timeout(Duration::from_secs(10), rx.changed())
            .await
            .expect("frame within timeout")
            .expect("sender alive");
        let json = parse_frame(&rx.borrow());
        assert_eq!(json["doc"]["jots"][0]["id"], "sn_b");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn unchanged_content_publishes_no_frame() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("jots.json");
        write_jots_atomic(&path, &sample_doc()).unwrap();

        let (mut rx, nudge) = jots_feed(path.clone());
        rx.borrow_and_update();

        // A rebuild that reads identical bytes must not republish what
        // subscribers already hold.
        nudge.notify_one();
        assert!(
            tokio::time::timeout(Duration::from_millis(750), rx.changed())
                .await
                .is_err(),
            "identical content should publish no frame"
        );
    }

    #[tokio::test]
    async fn nudge_forces_rebuild() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("jots.json");

        let (mut rx, nudge) = jots_feed(path.clone());
        rx.borrow_and_update();

        // Write, then pulse the nudge — the rebuild should not depend on the
        // filesystem watcher's debounce.
        write_jots_atomic(&path, &sample_doc()).unwrap();
        nudge.notify_one();

        tokio::time::timeout(Duration::from_secs(5), rx.changed())
            .await
            .expect("frame within timeout")
            .expect("sender alive");
        let json = parse_frame(&rx.borrow());
        assert_eq!(json["doc"]["jots"][0]["id"], "sn_a");
    }

    #[tokio::test]
    async fn corrupt_file_retains_last_good_doc() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("jots.json");
        write_jots_atomic(&path, &sample_doc()).unwrap();

        let (mut rx, nudge) = jots_feed(path.clone());
        rx.borrow_and_update();

        // Corrupt the file, then force a rebuild.
        std::fs::write(&path, b"{ not json").unwrap();
        nudge.notify_one();

        tokio::time::timeout(Duration::from_secs(5), rx.changed())
            .await
            .expect("frame within timeout")
            .expect("sender alive");
        let json = parse_frame(&rx.borrow());
        // Last good doc retained; error set; hash null.
        assert_eq!(json["doc"]["jots"][0]["id"], "sn_a");
        assert!(json["error"].is_string());
        assert!(json["hash"].is_null());
    }
}
