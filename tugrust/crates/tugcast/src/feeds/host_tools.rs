//! tugcast's side of the host-tools probe: the async wrappers the actions call,
//! and the watch that settles the row once Apple's installer finishes.
//!
//! The probe itself and the offer live in [`tugcore::host_tools`], because the
//! `tugtool arc` verbs preflight against the same answer and the order the
//! probe takes is load-bearing — see that module's docs for why it must not be
//! simplified into a bare `git --version` ([D171]). One implementation, two
//! callers.
//!
//! What is here rather than there is the part that needs an event loop: the
//! filesystem watch. `tugcore` depends on no async runtime and no `notify`, and
//! a CLI that exits in milliseconds has nothing to wait on anyway.

use std::path::{Path, PathBuf};
use std::time::Duration;

pub use tugcore::host_tools::{COMMAND_LINE_TOOLS_DIR, GIT_VERSION_FLOOR, HostTools};

/// How long the post-offer watch stays armed. Apple's installer is a GUI the
/// backend cannot await, and the tools are ~3 GB, so the window has to cover a
/// slow download without leaving a watch registered for the lifetime of the
/// process when the user never finishes. The **Recheck** CTA is what covers the
/// user who takes longer than this, or who installs by hand later.
const WATCH_HORIZON: Duration = Duration::from_secs(45 * 60);

/// Probe the host's git off the runtime's blocking pool — the core probe spawns
/// up to two short-lived processes, which is exactly what that pool is for.
pub async fn probe() -> HostTools {
    tokio::task::spawn_blocking(tugcore::host_tools::probe)
        .await
        .unwrap_or_default()
}

/// Ask macOS to install the Command Line Tools. Success means Apple's panel came
/// up, not that git arrived; [`await_command_line_tools`] is what settles that.
pub async fn offer_developer_tools() -> (bool, Option<String>) {
    tokio::task::spawn_blocking(tugcore::host_tools::offer_developer_tools)
        .await
        .unwrap_or_else(|e| (false, Some(e.to_string())))
}

/// Wait for the Command Line Tools to appear, by watching for them.
///
/// Returns `true` when the directory exists, `false` when [`WATCH_HORIZON`]
/// runs out first, or when no watch could be armed at all. There is no timer
/// asking "is git here yet?" — the house forbids polling and a two-second
/// re-probe would be exactly that. The watch registers on the deepest ancestor
/// of the target that exists (`/Library` always does), re-arms one level deeper
/// as the intermediate directories are created by the installer, and settles
/// the moment the target itself is there.
pub async fn await_command_line_tools() -> bool {
    matches!(
        tokio::time::timeout(
            WATCH_HORIZON,
            watch_for_path(Path::new(COMMAND_LINE_TOOLS_DIR)),
        )
        .await,
        Ok(true)
    )
}

/// Resolve `true` once `target` exists. Re-arms as the path fills in from the
/// root down, so a watch registered on `/Library` still fires for a
/// `/Library/Developer/CommandLineTools` that arrives two levels below it, and
/// resolves `false` when the watch could not be armed — a watcher that was
/// never listening has not seen the tools arrive and must not say it did.
async fn watch_for_path(target: &Path) -> bool {
    use notify::{RecursiveMode, Watcher};

    loop {
        if target.exists() {
            return true;
        }
        let Some(anchor) = existing_ancestor(target) else {
            // Nothing on the path exists, not even `/`. Nothing to watch and
            // nothing this function can do about it.
            return false;
        };
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        let mut watcher = match notify::recommended_watcher(move |_res| {
            let _ = tx.send(());
        }) {
            Ok(watcher) => watcher,
            Err(e) => {
                tracing::warn!("host_tools: could not create developer-tools watcher: {e}");
                return false;
            }
        };
        if let Err(e) = watcher.watch(&anchor, RecursiveMode::NonRecursive) {
            tracing::warn!("host_tools: could not watch {}: {e}", anchor.display());
            return false;
        }
        // The target may have appeared between the existence test and the
        // watch being armed, in which case no event is ever coming.
        if target.exists() {
            return true;
        }
        while rx.recv().await.is_some() {
            if target.exists() {
                return true;
            }
            if existing_ancestor(target).as_deref() != Some(anchor.as_path()) {
                // The path filled in a level; re-arm deeper.
                break;
            }
        }
    }
}

/// The deepest ancestor of `target` (inclusive) that exists on disk.
fn existing_ancestor(target: &Path) -> Option<PathBuf> {
    target
        .ancestors()
        .find(|candidate| candidate.exists())
        .map(Path::to_path_buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_deepest_existing_ancestor_is_what_gets_watched() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("Developer/CommandLineTools");
        assert_eq!(existing_ancestor(&missing).as_deref(), Some(dir.path()));
        std::fs::create_dir(dir.path().join("Developer")).expect("mkdir");
        assert_eq!(
            existing_ancestor(&missing).as_deref(),
            Some(dir.path().join("Developer").as_path())
        );
    }

    #[tokio::test]
    async fn the_watch_settles_when_the_directory_lands() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("Developer/CommandLineTools");
        let creating = target.clone();
        let planted = tokio::task::spawn_blocking(move || {
            std::thread::sleep(Duration::from_millis(150));
            std::fs::create_dir_all(&creating).expect("create the tools");
        });
        let settled = tokio::time::timeout(Duration::from_secs(20), watch_for_path(&target))
            .await
            .expect("the watch should settle once the directory exists");
        assert!(
            settled,
            "the watch should report the directory it saw arrive"
        );
        planted.await.expect("planting task");
        assert!(target.exists());
    }
}
