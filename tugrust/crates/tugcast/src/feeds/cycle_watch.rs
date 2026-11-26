//! The watch that carries a cycle write to the aggregate changeset feed.
//!
//! A cycle is written by `tugtool cycle` (and by the skills that drive it) to
//! `<data>/projects/<state>/cycles/<id>/cycle.json`, out of process and under
//! the data dir, where no workspace watcher looks. An entry's state is derived
//! from the project's arc log, so a write to that file moves a cycle too. This
//! watches both by file name, recursively over the project state dirs, and
//! fires the aggregate's bump: the next frame carries the cycle as it now is.
//!
//! A cycle appearing is something the user watches for, so its file is
//! watched rather than stat'd on a timer — the reason `arc_notes.rs` gives for
//! the same watch over the arc log. A watch that cannot be armed logs at
//! `error` and stops; there is no poll fallback. A burst of events coalesces
//! into one pending wake on a depth-1 channel, and the feed's own floor
//! coalesces the bumps again.
//!
//! The aggregate's 2 s probe still stats each open project's arc log, for the
//! other facts that rely on it; this watch does not replace it.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use notify::Watcher;
use tokio::sync::Notify;
use tokio::sync::mpsc::Sender;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info};

/// The cycle record's file name.
const CYCLE_JSON: &str = tugarc_core::cycle::CYCLE_JSON;

/// The arc log's file name, whose writes move an entry's state.
const ARC_LOG: &str = tugtool_core::paths::ARC_LOG;

/// The directory every project's state lives under, created if absent so the
/// watch has something to attach to before the first cycle exists.
fn projects_root() -> PathBuf {
    let root = tugcore::instance::base_data_dir().join("projects");
    let _ = std::fs::create_dir_all(&root);
    root
}

/// Whether a write to `path` can change what a cycle reads as.
fn moves_a_cycle(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name == CYCLE_JSON || name == ARC_LOG)
}

/// The watcher's callback body: leave one pending wake when the event names a
/// cycle record or an arc log. Runs on notify's own thread, so it never
/// blocks — a wake already pending covers this event.
fn on_event(event: notify::Result<notify::Event>, wake: &Sender<()>) {
    let Ok(event) = event else { return };
    if event.paths.iter().any(|path| moves_a_cycle(path)) {
        let _ = wake.try_send(());
    }
}

/// Watch every project's cycle records and arc log, and bump the aggregate
/// changeset feed on each write.
pub async fn run_cycle_watch(bump: Arc<Notify>, cancel: CancellationToken) {
    let root = projects_root();
    let (wake_tx, wake_rx) = tokio::sync::mpsc::channel::<()>(1);
    let watcher = notify::recommended_watcher(move |event| on_event(event, &wake_tx));
    let mut watcher = match watcher {
        Ok(watcher) => watcher,
        Err(err) => {
            error!(error = %err, "the cycle watch could not create a watcher — a cycle write will not reach the deck until something else recomposes");
            return;
        }
    };
    if let Err(err) = watcher.watch(&root, notify::RecursiveMode::Recursive) {
        error!(dir = %root.display(), error = %err, "the cycle watch could not watch the project state dirs — a cycle write will not reach the deck until something else recomposes");
        return;
    }
    info!(dir = %root.display(), "cycle watch armed");

    // `watcher` is held for the whole loop: dropping it unregisters the OS
    // watch, and nothing would say so.
    forward(wake_rx, &bump, &cancel).await;
    drop(watcher);
}

/// Turn each pending wake into one bump of the aggregate, until cancelled or
/// until the watcher's side of the channel is gone.
async fn forward(
    mut wake_rx: tokio::sync::mpsc::Receiver<()>,
    bump: &Notify,
    cancel: &CancellationToken,
) {
    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                debug!("cycle watch shutting down");
                return;
            }
            received = wake_rx.recv() => {
                if received.is_none() {
                    return;
                }
                bump.notify_one();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event_at(path: &str) -> notify::Result<notify::Event> {
        Ok(notify::Event::new(notify::EventKind::Any).add_path(PathBuf::from(path)))
    }

    #[test]
    fn a_cycle_record_or_an_arc_log_write_leaves_a_wake() {
        for path in [
            "/data/projects/abc/cycles/3f9a1c2e/cycle.json",
            "/data/projects/abc/arc-log.md",
        ] {
            let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(1);
            on_event(event_at(path), &tx);
            assert!(rx.try_recv().is_ok(), "{path} wakes the aggregate");
        }
    }

    #[test]
    fn any_other_write_leaves_none() {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(1);
        for path in [
            "/data/projects/abc/cycles/3f9a1c2e/cycle.json.tmp",
            "/data/projects/abc/sketches/0a1b2c3d/v1.md",
            "/data/projects/abc/arc-log.md.lock",
        ] {
            on_event(event_at(path), &tx);
        }
        on_event(Err(notify::Error::generic("lost")), &tx);
        assert!(rx.try_recv().is_err(), "nothing else wakes it");
    }

    #[test]
    fn a_burst_coalesces_into_one_pending_wake() {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(1);
        for _ in 0..5 {
            on_event(event_at("/data/projects/abc/arc-log.md"), &tx);
        }
        assert!(rx.try_recv().is_ok());
        assert!(rx.try_recv().is_err(), "one wake, not five");
    }

    /// A predicate over a name nothing writes would arm a watch that never
    /// fires.
    #[test]
    fn the_watched_names_are_the_ones_the_writers_use() {
        assert_eq!(CYCLE_JSON, "cycle.json");
        assert_eq!(ARC_LOG, "arc-log.md");
    }

    /// A matched event, carried through the forwarding loop, fires the bump;
    /// an unmatched one does not.
    #[tokio::test]
    async fn a_matched_event_fires_the_bump_and_an_unmatched_one_does_not() {
        use futures::FutureExt;
        let cancel = CancellationToken::new();

        let bump = Notify::new();
        let (tx, rx) = tokio::sync::mpsc::channel::<()>(1);
        on_event(event_at("/data/projects/abc/cycles/x/cycle.json"), &tx);
        drop(tx);
        forward(rx, &bump, &cancel).await;
        // The bump left a stored permit, which the feed's `notified()` takes.
        assert!(bump.notified().now_or_never().is_some(), "the bump fired");

        let bump = Notify::new();
        let (tx, rx) = tokio::sync::mpsc::channel::<()>(1);
        on_event(event_at("/data/projects/abc/notes.md"), &tx);
        drop(tx);
        forward(rx, &bump, &cancel).await;
        assert!(bump.notified().now_or_never().is_none(), "no bump");
    }
}
