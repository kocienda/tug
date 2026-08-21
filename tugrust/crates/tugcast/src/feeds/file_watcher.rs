//! Shared FileWatcher service
//!
//! Owns the notify watcher and directory walk. Uses `PathResolver` for robust
//! path resolution across symlinks, firmlinks, and mount aliases.
//! Broadcasts `Vec<FsEvent>` batches to all subscribers via a broadcast channel.
//! Both FilesystemFeed and FileTreeFeed consume a clone of the broadcast sender.
//!
//! Gitignore filtering is NOT done here — events flow through unfiltered.
//! FileTreeFeed's initial walk (via `WalkBuilder`) respects gitignore, and
//! re-walks on `.gitignore` changes to reconcile.

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc as std_mpsc;
use std::time::Duration;

use ignore::WalkBuilder;
use notify::event::{ModifyKind, RenameMode};
use notify::{Event, EventKind, RecursiveMode, Watcher};
use tokio::sync::broadcast;
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use tugcast_core::types::FsEvent;

use crate::path_resolver::PathResolver;

/// Broadcast channel buffer capacity
const BROADCAST_CAPACITY: usize = 256;

/// Debounce window for batching filesystem events
pub(crate) const DEBOUNCE_MILLIS: u64 = 100;

/// Poll interval when no events are available
pub(crate) const POLL_MILLIS: u64 = 50;

/// Maximum number of files returned by walk()
const WALK_CAP: usize = 50_000;

/// Shared filesystem watcher service.
///
/// Owns the notify watcher and initial directory walk.
/// Broadcasts `Vec<FsEvent>` batches to all subscribers.
/// Uses `PathResolver` for robust path resolution across symlinks,
/// synthetic firmlinks (macOS), APFS firmlinks, and Linux bind mounts.
pub struct FileWatcher {
    /// Resolved watch directory — always use resolver.watch_path() for the
    /// form to register with FSEvents/inotify.
    resolver: PathResolver,
}

impl FileWatcher {
    /// Create a new FileWatcher for the given directory.
    ///
    /// The `PathResolver` handles all path resolution: symlinks, synthetic
    /// firmlinks (macOS synthetic.conf), APFS data volume firmlinks, and
    /// Linux bind mounts. The resolved path is the form that the OS file
    /// watching API actually accepts (proven by spike testing).
    pub fn new(watch_dir: PathBuf) -> Self {
        let resolver = PathResolver::new(watch_dir);
        Self { resolver }
    }

    /// Create a broadcast sender for distributing events to multiple consumers.
    ///
    /// Call this once, then pass clones of the returned sender to each feed.
    pub fn create_sender() -> broadcast::Sender<Vec<FsEvent>> {
        broadcast::channel(BROADCAST_CAPACITY).0
    }

    /// Walk the directory tree and return a sorted set of relative paths —
    /// files as-is, directories with a trailing `/`.
    ///
    /// Uses `ignore::WalkBuilder` for proper nested `.gitignore` support.
    /// Skips `.git/` directories. Returns at most `WALK_CAP` entries.
    ///
    /// Returns `(paths, truncated)` where `truncated` is true if the cap was hit.
    pub fn walk(&self) -> (BTreeSet<String>, bool) {
        self.walk_with_cap(WALK_CAP)
    }

    /// Walk the directory tree with an explicit entry count cap.
    ///
    /// This is the implementation backing `walk()`. Exposed for testing so that
    /// the truncation path can be exercised without creating 50,000 real files.
    pub(crate) fn walk_with_cap(&self, cap: usize) -> (BTreeSet<String>, bool) {
        let mut files: BTreeSet<String> = BTreeSet::new();
        let mut truncated = false;

        let walker = WalkBuilder::new(self.resolver.watch_path())
            .hidden(false)
            .git_ignore(true)
            .git_global(false)
            .git_exclude(false)
            .require_git(false)
            .build();

        for entry in walker {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    warn!(error = %e, "error walking directory");
                    continue;
                }
            };

            let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
            let path = entry.path();

            // Strip the watch directory prefix to get the relative path
            let relative = match self.resolver.to_relative(path) {
                Some(rel) => rel,
                None => continue,
            };

            // The walk root itself relativizes to "" — not an entry.
            if relative.is_empty() {
                continue;
            }

            // Skip .git/ contents (WalkBuilder should handle this via git_ignore,
            // but be explicit for safety)
            if relative.starts_with(".git/") || relative == ".git" {
                continue;
            }

            if files.len() >= cap {
                truncated = true;
                break;
            }

            files.insert(dir_form(relative, is_dir));
        }

        (files, truncated)
    }

    /// Start the filesystem watcher and broadcast events to all subscribers.
    ///
    /// Creates a `notify::RecommendedWatcher`, debounces events (100ms),
    /// converts to `Vec<FsEvent>`, filters via gitignore, detects `.gitignore`
    /// changes and rebuilds the matcher, then broadcasts batches.
    pub async fn run(self, tx: broadcast::Sender<Vec<FsEvent>>, cancel: CancellationToken) {
        let watch_path = self.resolver.watch_path().to_path_buf();

        // Create std::sync::mpsc channel for notify watcher
        let (event_tx, event_rx) = std_mpsc::channel();

        // Create watcher (must stay alive for the duration)
        let mut watcher = match notify::recommended_watcher(event_tx) {
            Ok(w) => w,
            Err(e) => {
                error!(error = %e, "failed to create filesystem watcher");
                return;
            }
        };

        // Start watching — use the resolved path that FSEvents/inotify accepts
        if let Err(e) = watcher.watch(&watch_path, RecursiveMode::Recursive) {
            error!(dir = ?watch_path, error = %e, "failed to watch directory");
            return;
        }
        info!(dir = ?watch_path, "file watcher started");

        let debounce_duration = Duration::from_millis(DEBOUNCE_MILLIS);
        let poll_duration = Duration::from_millis(POLL_MILLIS);
        let mut batch: Vec<FsEvent> = Vec::new();

        loop {
            if cancel.is_cancelled() {
                info!("file watcher shutting down");
                break;
            }

            // Drain all available events from the std channel (non-blocking)
            let mut received_events = false;

            loop {
                match event_rx.try_recv() {
                    Ok(Ok(event)) => {
                        received_events = true;
                        let fs_events = convert_event(&event, &self);
                        for ev in fs_events {
                            batch.push(ev);
                        }
                    }
                    Ok(Err(e)) => {
                        warn!(error = %e, "filesystem watcher error");
                    }
                    Err(std_mpsc::TryRecvError::Empty) => break,
                    Err(std_mpsc::TryRecvError::Disconnected) => {
                        error!("filesystem watcher channel disconnected");
                        return;
                    }
                }
            }

            if received_events && !batch.is_empty() {
                sleep(debounce_duration).await;

                // Drain any more events that arrived during debounce
                loop {
                    match event_rx.try_recv() {
                        Ok(Ok(event)) => {
                            let fs_events = convert_event(&event, &self);
                            for ev in fs_events {
                                batch.push(ev);
                            }
                        }
                        Ok(Err(e)) => {
                            warn!(error = %e, "filesystem watcher error");
                        }
                        Err(std_mpsc::TryRecvError::Empty) => break,
                        Err(std_mpsc::TryRecvError::Disconnected) => {
                            error!("filesystem watcher channel disconnected");
                            return;
                        }
                    }
                }

                // Deduplicate redundant Modified events
                deduplicate_batch(&mut batch, &watch_path);

                if !batch.is_empty() {
                    let _ = tx.send(batch.clone());
                    batch.clear();
                }
            } else {
                sleep(poll_duration).await;
            }
        }
    }
}

/// The index form of a relative path: directories carry a trailing `/`
/// so a single `BTreeSet<String>` holds both kinds and every consumer
/// (scorer, secret filter, client) can tell them apart.
pub(crate) fn dir_form(relative: String, is_dir: bool) -> String {
    if is_dir {
        let mut s = relative;
        s.push('/');
        s
    } else {
        relative
    }
}

/// Walk a directory and return a sorted set of relative paths — files
/// as-is, directories with a trailing `/`.
///
/// Standalone function for use by FileTreeFeed's re-walk on `.gitignore`
/// change. Creates a PathResolver internally for path resolution.
/// Uses `ignore::WalkBuilder` for gitignore support.
pub fn walk_directory(dir: &Path) -> (BTreeSet<String>, bool) {
    let resolver = PathResolver::new(dir.to_path_buf());
    let mut files = BTreeSet::new();
    let mut truncated = false;

    let walker = WalkBuilder::new(resolver.watch_path())
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(false)
        .require_git(false)
        .build();

    for entry in walker.flatten() {
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        let Some(relative) = resolver.to_relative(entry.path()) else {
            continue;
        };
        if relative.is_empty() {
            continue;
        }
        if relative.starts_with(".git/") || relative == ".git" {
            continue;
        }
        if files.len() >= WALK_CAP {
            truncated = true;
            break;
        }
        files.insert(dir_form(relative, is_dir));
    }

    (files, truncated)
}

/// Collapse a same-path `Removed` + `Created` pair into a single `Modified`.
///
/// A writer that replaces a file by unlinking and recreating it — git checkout,
/// `git merge`, an atomic temp-and-rename save — surfaces as `Removed{p}` and
/// `Created{p}` for the same `p` in one batch. The content at `p` changed; the
/// file did not go away. The pair is replaced by one `Modified{p}`, positioned
/// where the first event for `p` was, and any raw `Modified{p}` in the batch is
/// folded into it so exactly one survives.
///
/// Directories are left uncollapsed: `FileTreeFeed::remove_path` uses a
/// directory `Removed` to evict every path indexed beneath it, and it treats
/// `Modified` as a no-op, so collapsing a directory pair would strand those
/// children in the index. `root` is the watch directory, against which a
/// relative path is classified.
///
/// A genuine rename pair (`Removed{a}` + `Created{b}`, `a != b`) and explicit
/// `Renamed` events are untouched.
fn collapse_same_path_replacements(batch: &mut Vec<FsEvent>, root: &Path) {
    let mut created: HashSet<&str> = HashSet::new();
    let mut removed: HashSet<&str> = HashSet::new();
    for ev in batch.iter() {
        match ev {
            FsEvent::Created { path } => {
                created.insert(path.as_str());
            }
            FsEvent::Removed { path } => {
                removed.insert(path.as_str());
            }
            _ => {}
        }
    }

    let collapsed: HashSet<String> = created
        .intersection(&removed)
        .filter(|path| !path.is_empty() && !root.join(path).is_dir())
        .map(|path| (*path).to_string())
        .collect();

    if collapsed.is_empty() {
        return;
    }

    let mut out: Vec<FsEvent> = Vec::with_capacity(batch.len());
    let mut emitted: HashSet<String> = HashSet::new();

    for ev in batch.drain(..) {
        let path = match &ev {
            FsEvent::Created { path } | FsEvent::Removed { path } | FsEvent::Modified { path } => {
                path.clone()
            }
            FsEvent::Renamed { .. } => {
                out.push(ev);
                continue;
            }
        };

        if !collapsed.contains(&path) {
            out.push(ev);
            continue;
        }

        if emitted.insert(path.clone()) {
            out.push(FsEvent::Modified { path });
        }
    }

    *batch = out;
}

/// Remove redundant Modified events from a batch.
///
/// First collapses same-path remove+create replacements for files
/// (`collapse_same_path_replacements`), then drops the remaining redundant
/// Modified events: macOS FSEvents fires modify events for parent directories
/// when their contents change, and also fires redundant modify events alongside
/// create/remove events for the same path. A Modified is dropped when its path
/// also carries a Created, Removed, or Renamed in the same batch, and when its
/// path is empty (the watch root itself).
///
/// `root` is the watch directory, used to tell a file from a directory.
pub(crate) fn deduplicate_batch(batch: &mut Vec<FsEvent>, root: &Path) {
    collapse_same_path_replacements(batch, root);

    // Collect paths that have a Created, Removed, or Renamed event
    let mut non_modify_paths: HashSet<String> = HashSet::new();
    for ev in batch.iter() {
        match ev {
            FsEvent::Created { path } | FsEvent::Removed { path } => {
                non_modify_paths.insert(path.clone());
            }
            FsEvent::Renamed { from, to } => {
                non_modify_paths.insert(from.clone());
                non_modify_paths.insert(to.clone());
            }
            FsEvent::Modified { .. } => {}
        }
    }

    // Drop Modified events for paths that already have create/remove/rename,
    // and drop Modified events for the watch root (empty path = directory itself)
    batch.retain(|ev| {
        if let FsEvent::Modified { path } = ev {
            if path.is_empty() || non_modify_paths.contains(path.as_str()) {
                return false;
            }
        }
        true
    });
}

/// Convert notify Event to FsEvent values.
///
/// Matches by category (Create/Remove/Modify) rather than specific platform
/// variants, so this works on macOS (FSEvents), Linux (inotify), and Windows
/// (ReadDirectoryChangesW) without platform-specific branches.
pub(crate) fn convert_event(event: &Event, watcher: &FileWatcher) -> Vec<FsEvent> {
    let to_relative = |p: &Path| -> String {
        if let Some(rel) = watcher.resolver.to_relative(p) {
            return rel;
        }
        warn!(path = ?p, "could not relativize event path");
        p.to_string_lossy().to_string()
    };

    match &event.kind {
        EventKind::Create(_) => event
            .paths
            .iter()
            .map(|p| FsEvent::Created {
                path: to_relative(p),
            })
            .collect(),

        EventKind::Remove(_) => event
            .paths
            .iter()
            .map(|p| FsEvent::Removed {
                path: to_relative(p),
            })
            .collect(),

        // File content changed. Only Data changes are real modifications.
        // Metadata (timestamps, permissions) are noise.
        EventKind::Modify(ModifyKind::Data(_)) => event
            .paths
            .iter()
            .map(|p| FsEvent::Modified {
                path: to_relative(p),
            })
            .collect(),

        // Renames/moves. Different platforms report these differently:
        // - Linux (inotify): RenameMode::From + RenameMode::To as paired events,
        //   or RenameMode::Both when both sides are in the watched directory.
        // - macOS (FSEvents): RenameMode::Any — cannot distinguish direction.
        // - Windows: RenameMode::From + RenameMode::To paired.
        //
        // Handle all variants uniformly:
        // - Both with 2 paths: emit a proper Renamed event (from, to).
        // - From: the old path — treat as Removed.
        // - To: the new path — treat as Created.
        // - Any/Other: direction unknown — check if the path still exists on
        //   disk. If yes → Created (moved in). If no → Removed (moved out).
        EventKind::Modify(ModifyKind::Name(rename_mode)) => {
            match rename_mode {
                RenameMode::Both => {
                    if event.paths.len() >= 2 {
                        vec![FsEvent::Renamed {
                            from: to_relative(&event.paths[0]),
                            to: to_relative(&event.paths[1]),
                        }]
                    } else {
                        vec![]
                    }
                }
                RenameMode::From => event
                    .paths
                    .iter()
                    .map(|p| FsEvent::Removed {
                        path: to_relative(p),
                    })
                    .collect(),
                RenameMode::To => event
                    .paths
                    .iter()
                    .map(|p| FsEvent::Created {
                        path: to_relative(p),
                    })
                    .collect(),
                // Any, Other, or future variants — probe the filesystem.
                _ => event
                    .paths
                    .iter()
                    .map(|p| {
                        if p.exists() {
                            FsEvent::Created {
                                path: to_relative(p),
                            }
                        } else {
                            FsEvent::Removed {
                                path: to_relative(p),
                            }
                        }
                    })
                    .collect(),
            }
        }

        // Rescan: the watcher's event buffer overflowed or it detected
        // inconsistency. Log a warning — the file index may be stale until
        // the next full walk (e.g., on retarget or restart).
        EventKind::Other => {
            warn!("filesystem watcher flagged rescan — events may have been dropped");
            vec![]
        }

        // Access, Modify(Metadata/Any), and unknown future kinds are noise.
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // ── walk() tests ─────────────────────────────────────────────────────────

    #[test]
    fn test_walk_returns_relative_paths() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path().to_path_buf();

        fs::write(root.join("Cargo.toml"), "[package]").unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(root.join("src/lib.rs"), "pub fn hello() {}").unwrap();

        let watcher = FileWatcher::new(root);
        let (files, truncated) = watcher.walk();

        assert!(!truncated);
        assert!(files.contains("Cargo.toml"), "should contain Cargo.toml");
        assert!(files.contains("src/main.rs"), "should contain src/main.rs");
        assert!(files.contains("src/lib.rs"), "should contain src/lib.rs");
        // Directories are indexed in their trailing-slash form only.
        assert!(!files.contains("src"), "bare dir name must not appear");
        assert!(
            files.contains("src/"),
            "dir should appear with trailing slash"
        );
    }

    #[test]
    fn test_walk_indexes_directories_with_trailing_slash() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path().to_path_buf();

        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::write(root.join("src/nested/a.rs"), "").unwrap();

        let watcher = FileWatcher::new(root);
        let (files, _) = watcher.walk();

        assert!(files.contains("src/"));
        assert!(files.contains("src/nested/"));
        assert!(files.contains("src/nested/a.rs"));
        // The walk root itself is not an entry.
        assert!(!files.contains("/"));
        assert!(!files.contains(""));
    }

    #[test]
    fn test_walk_excludes_gitignored_directories() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path().to_path_buf();

        fs::write(root.join(".gitignore"), "target/\n").unwrap();
        fs::create_dir(root.join("target")).unwrap();
        fs::write(root.join("target/binary"), "").unwrap();
        fs::create_dir(root.join("src")).unwrap();

        let watcher = FileWatcher::new(root);
        let (files, _) = watcher.walk();

        assert!(files.contains("src/"));
        assert!(
            !files.contains("target/"),
            "ignored dir must not be indexed"
        );
    }

    #[test]
    fn test_walk_respects_gitignore() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path().to_path_buf();

        // Create .gitignore
        fs::write(root.join(".gitignore"), "target/\nnode_modules/\n").unwrap();

        // Create ignored and non-ignored files
        fs::create_dir(root.join("target")).unwrap();
        fs::create_dir(root.join("target/debug")).unwrap();
        fs::write(root.join("target/debug/binary"), "").unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/foo.js"), "").unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();

        let watcher = FileWatcher::new(root);
        let (files, truncated) = watcher.walk();

        assert!(!truncated);
        assert!(files.contains("src/main.rs"), "should include src/main.rs");
        assert!(
            !files.contains("target/debug/binary"),
            "should not include target/ contents"
        );
        assert!(
            !files.contains("node_modules/foo.js"),
            "should not include node_modules/ contents"
        );
    }

    #[test]
    fn test_walk_respects_nested_gitignore() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path().to_path_buf();

        // Root .gitignore
        fs::write(root.join(".gitignore"), "*.log\n").unwrap();

        // Subdirectory with its own .gitignore that unignores *.log
        fs::create_dir(root.join("logs")).unwrap();
        fs::write(root.join("logs/.gitignore"), "!*.log\n").unwrap();
        fs::write(root.join("logs/app.log"), "log content").unwrap();
        fs::write(root.join("debug.log"), "debug").unwrap();

        // A normal file that should always be included
        fs::write(root.join("README.md"), "readme").unwrap();

        let watcher = FileWatcher::new(root);
        let (files, truncated) = watcher.walk();

        assert!(!truncated);
        assert!(files.contains("README.md"), "should include README.md");
        // Root-level .log file is ignored by root .gitignore
        assert!(!files.contains("debug.log"), "should not include debug.log");
        // logs/app.log is re-included by nested .gitignore
        assert!(
            files.contains("logs/app.log"),
            "should include logs/app.log (nested gitignore override)"
        );
    }

    #[test]
    fn test_walk_skips_git_directory() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path().to_path_buf();

        // Simulate a .git directory
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join(".git/HEAD"), "ref: refs/heads/main").unwrap();
        fs::write(root.join("README.md"), "readme").unwrap();

        let watcher = FileWatcher::new(root);
        let (files, truncated) = watcher.walk();

        assert!(!truncated);
        assert!(files.contains("README.md"));
        assert!(
            !files.iter().any(|f| f.starts_with(".git")),
            "should not include .git/ contents"
        );
    }

    #[test]
    fn test_walk_with_cap_truncates_when_exceeded() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path().to_path_buf();

        // Create 5 files
        for i in 0..5u32 {
            fs::write(root.join(format!("file{i}.txt")), "data").unwrap();
        }

        let watcher = FileWatcher::new(root);

        // Cap of 3 with 5 files: should return exactly 3 files and truncated=true
        let (files, truncated) = watcher.walk_with_cap(3);
        assert!(
            truncated,
            "expected truncated=true when file count exceeds cap"
        );
        assert_eq!(files.len(), 3, "expected exactly cap files returned");

        // Cap of 10 with 5 files: should return all 5 and truncated=false
        let (files, truncated) = watcher.walk_with_cap(10);
        assert!(
            !truncated,
            "expected truncated=false when file count is within cap"
        );
        assert_eq!(files.len(), 5, "expected all 5 files returned");
    }

    // ── deduplicate_batch() tests ──────────────────────────────────────────────

    /// A watch root holding one real file and one real directory, so the
    /// collapse can classify the paths the batches below name.
    fn dedup_root() -> TempDir {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();
        fs::write(root.join("file.txt"), "data").unwrap();
        fs::write(root.join("real.txt"), "data").unwrap();
        fs::write(root.join("changed.txt"), "data").unwrap();
        fs::create_dir(root.join("adir")).unwrap();
        temp_dir
    }

    fn paths_of(batch: &[FsEvent]) -> Vec<String> {
        batch
            .iter()
            .map(|ev| match ev {
                FsEvent::Created { path } => format!("created:{path}"),
                FsEvent::Removed { path } => format!("removed:{path}"),
                FsEvent::Modified { path } => format!("modified:{path}"),
                FsEvent::Renamed { from, to } => format!("renamed:{from}->{to}"),
            })
            .collect()
    }

    #[test]
    fn test_deduplicate_removes_modified_when_created() {
        let temp_dir = dedup_root();
        let mut batch = vec![
            FsEvent::Created {
                path: "file.txt".to_string(),
            },
            FsEvent::Modified {
                path: "file.txt".to_string(),
            },
        ];
        deduplicate_batch(&mut batch, temp_dir.path());
        assert_eq!(batch.len(), 1);
        assert!(matches!(batch[0], FsEvent::Created { .. }));
    }

    #[test]
    fn test_deduplicate_removes_modified_when_removed() {
        let temp_dir = dedup_root();
        let mut batch = vec![
            FsEvent::Modified {
                path: "gone.txt".to_string(),
            },
            FsEvent::Removed {
                path: "gone.txt".to_string(),
            },
        ];
        deduplicate_batch(&mut batch, temp_dir.path());
        assert_eq!(batch.len(), 1);
        assert!(matches!(batch[0], FsEvent::Removed { .. }));
    }

    #[test]
    fn test_deduplicate_keeps_standalone_modified() {
        let temp_dir = dedup_root();
        let mut batch = vec![FsEvent::Modified {
            path: "changed.txt".to_string(),
        }];
        deduplicate_batch(&mut batch, temp_dir.path());
        assert_eq!(batch.len(), 1);
    }

    #[test]
    fn test_deduplicate_removes_empty_path_modified() {
        let temp_dir = dedup_root();
        let mut batch = vec![
            FsEvent::Modified {
                path: "".to_string(),
            },
            FsEvent::Created {
                path: "real.txt".to_string(),
            },
        ];
        deduplicate_batch(&mut batch, temp_dir.path());
        assert_eq!(batch.len(), 1);
        assert!(matches!(batch[0], FsEvent::Created { .. }));
    }

    #[test]
    fn test_deduplicate_collapses_file_replacement_to_modified() {
        let temp_dir = dedup_root();
        let mut batch = vec![
            FsEvent::Removed {
                path: "file.txt".to_string(),
            },
            FsEvent::Created {
                path: "file.txt".to_string(),
            },
            FsEvent::Modified {
                path: "file.txt".to_string(),
            },
        ];
        deduplicate_batch(&mut batch, temp_dir.path());
        assert_eq!(paths_of(&batch), vec!["modified:file.txt"]);
    }

    #[test]
    fn test_deduplicate_collapses_replacement_without_raw_modified() {
        let temp_dir = dedup_root();
        let mut batch = vec![
            FsEvent::Removed {
                path: "file.txt".to_string(),
            },
            FsEvent::Created {
                path: "file.txt".to_string(),
            },
        ];
        deduplicate_batch(&mut batch, temp_dir.path());
        assert_eq!(paths_of(&batch), vec!["modified:file.txt"]);
    }

    #[test]
    fn test_deduplicate_leaves_directory_replacement_uncollapsed() {
        let temp_dir = dedup_root();
        let mut batch = vec![
            FsEvent::Removed {
                path: "adir".to_string(),
            },
            FsEvent::Created {
                path: "adir".to_string(),
            },
        ];
        deduplicate_batch(&mut batch, temp_dir.path());
        assert_eq!(
            paths_of(&batch),
            vec!["removed:adir", "created:adir"],
            "a directory Removed must survive so FileTreeFeed evicts its children"
        );
    }

    #[test]
    fn test_deduplicate_leaves_rename_pair_intact() {
        let temp_dir = dedup_root();
        let mut batch = vec![
            FsEvent::Removed {
                path: "a.txt".to_string(),
            },
            FsEvent::Created {
                path: "b.txt".to_string(),
            },
        ];
        deduplicate_batch(&mut batch, temp_dir.path());
        assert_eq!(paths_of(&batch), vec!["removed:a.txt", "created:b.txt"]);
    }

    #[test]
    fn test_deduplicate_collapses_within_a_mixed_batch() {
        let temp_dir = dedup_root();
        let mut batch = vec![
            FsEvent::Removed {
                path: "file.txt".to_string(),
            },
            FsEvent::Created {
                path: "real.txt".to_string(),
            },
            FsEvent::Created {
                path: "file.txt".to_string(),
            },
            FsEvent::Renamed {
                from: "x.txt".to_string(),
                to: "y.txt".to_string(),
            },
            FsEvent::Modified {
                path: "file.txt".to_string(),
            },
        ];
        deduplicate_batch(&mut batch, temp_dir.path());
        assert_eq!(
            paths_of(&batch),
            vec![
                "modified:file.txt",
                "created:real.txt",
                "renamed:x.txt->y.txt",
            ],
            "the collapse lands where the first event for the path was"
        );
    }
}
