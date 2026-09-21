//! The machine-wide session index, watched — so a session recorded by
//! another instance becomes findable here the moment it is written.
//!
//! `session_index.db` is shared by every Tug instance on the machine, and
//! this process is only one of its writers. A reference the deck asked about
//! and got `absent` for can therefore become answerable without anything
//! happening in *this* process: another instance spawns a session, its
//! tugcast writes the index row, and the pill here is stale with no local
//! event to say so.
//!
//! **By watching, never by polling.** The answer is one `notify` watch and a
//! single CONTROL frame: the deck drops the answers that could have changed
//! and asks again. There is no timer here and no poll fallback of any kind —
//! a watch that cannot be armed logs and returns, leaving the deck with the
//! answers it already had rather than with a clock.
//!
//! # The filter is load-bearing, not cosmetic
//!
//! The index sits in `base_data_dir()`, which is the app's **hottest**
//! directory: `changes.db`, `prompt_history.db` and their `-wal` companions
//! are all there and are written on ordinary editing. So this watch wakes far
//! more often than the index changes, and the file-name test runs **inside the
//! notify callback, before the `try_send`** — a busy `changes.db` never fills
//! the channel and never reaches the broadcast task at all.
//!
//! `arc_notes.rs`, which this is modelled on, watches a directory nobody else
//! writes and so has no equivalent to get right.

use std::path::{Path, PathBuf};

use notify::Watcher;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info};

use tugcast_core::protocol::{FeedId, Frame};

/// The file name every index artefact starts with — the database, its
/// write-ahead log, and its shared-memory file.
const INDEX_STEM: &str = "session_index.db";

/// Whether one changed path is the session index or one of its companions.
///
/// A prefix test rather than an equality test, because SQLite's real writes
/// land on `session_index.db-wal` and the main file's mtime may not move at
/// all between checkpoints. Split out as a pure function so the one thing
/// that decides whether a wake is spent is testable without a filesystem.
fn is_index_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(INDEX_STEM))
}

/// Watch the machine-wide session index and tell every client when it moves.
pub async fn run_session_index_watch(
    control_tx: broadcast::Sender<Frame>,
    cancel: CancellationToken,
) {
    let index = tugcore::instance::session_index_db_path();
    let Some(dir) = index.parent().map(PathBuf::from) else {
        error!(path = %index.display(), "the session index has no parent directory to watch — a foreign session will not become findable until a reload");
        return;
    };
    // Created if absent so the watch has something to attach to before any
    // instance has written the index: a Tug that is the first on a machine
    // would otherwise arm nothing and never learn about the second.
    let _ = std::fs::create_dir_all(&dir);

    let (wake_tx, mut wake_rx) = tokio::sync::mpsc::channel::<()>(1);
    // The callback runs on notify's own thread and must not block. `try_send`
    // on a depth-1 channel is the coalescing this wants: a burst of writes
    // leaves one pending wake, and a wake already pending is a wake this
    // event is covered by.
    let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        if event.paths.iter().any(|path| is_index_path(path)) {
            let _ = wake_tx.try_send(());
        }
    });
    let mut watcher = match watcher {
        Ok(watcher) => watcher,
        Err(err) => {
            error!(error = %err, "the session-index watch could not create a watcher — a foreign session will not become findable until a reload");
            return;
        }
    };
    // Non-recursive: the index is one file in this directory, and the data
    // dir has subtrees (per-project state, logs) whose churn is none of this
    // watch's business.
    if let Err(err) = watcher.watch(&dir, notify::RecursiveMode::NonRecursive) {
        error!(dir = %dir.display(), error = %err, "the session-index watch could not watch the data dir — a foreign session will not become findable until a reload");
        return;
    }
    info!(dir = %dir.display(), "session-index watch armed");

    // `watcher` is held for the whole loop deliberately: dropping it
    // unregisters the OS watch, and a watcher bound only long enough to call
    // `watch` is the classic way to end up with no events and no error.
    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                debug!("session-index watch shutting down");
                return;
            }
            received = wake_rx.recv() => {
                if received.is_none() {
                    return;
                }
            }
        }
        // Drain whatever else arrived while this wake was in flight, so a
        // burst of index writes costs one frame rather than one per write.
        while wake_rx.try_recv().is_ok() {}
        let body = serde_json::json!({ "action": "session_index_changed" });
        let _ = control_tx.send(Frame::new(
            FeedId::CONTROL,
            serde_json::to_vec(&body).expect("session_index_changed serializes"),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_index_and_its_companions_pass_the_filter() {
        // SQLite's real writes land on the WAL, and the main file's mtime may
        // not move between checkpoints — so the WAL is the event that matters
        // most, not a curiosity the filter tolerates.
        assert!(is_index_path(Path::new("/data/session_index.db")));
        assert!(is_index_path(Path::new("/data/session_index.db-wal")));
        assert!(is_index_path(Path::new("/data/session_index.db-shm")));
    }

    #[test]
    fn the_hot_neighbours_do_not() {
        // These share the directory and are written on ordinary editing. A
        // filter that let them through would spend a wake and a broadcast on
        // every keystroke's worth of change-ledger traffic.
        assert!(!is_index_path(Path::new("/data/changes.db")));
        assert!(!is_index_path(Path::new("/data/changes.db-wal")));
        assert!(!is_index_path(Path::new("/data/prompt_history.db")));
        assert!(!is_index_path(Path::new("/data/jots.json")));
    }

    #[test]
    fn a_path_with_no_file_name_does_not() {
        assert!(!is_index_path(Path::new("/")));
    }
}
