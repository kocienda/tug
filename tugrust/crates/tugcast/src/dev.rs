//! Dev mode: file watcher and compiled binary polling

use arc_swap::ArcSwap;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;
use tracing::{debug, info, warn};
use tugcast_core::{FeedId, Frame};

/// Dev mode state: source tree path for the dev session
#[derive(Clone, Debug)]
pub(crate) struct DevState {
    /// Absolute path to the source tree root (parent of tugdeck/).
    /// Read in tests; production code uses it indirectly via enable_dev_mode locals.
    #[allow(dead_code)]
    pub source_tree: PathBuf,
}

/// Shared dev state type for lock-free runtime swapping
pub(crate) type SharedDevState = Arc<ArcSwap<Option<DevState>>>;

/// Tracks file change state across two watcher categories.
///
/// Per-category dirty flags indicate which categories have pending changes.
/// `code_count` is a counter for backend changes, incremented by `mark_backend()`.
/// `app_count` is a separate counter for app (app sources).
#[derive(Debug, Default)]
pub(crate) struct DevChangeTracker {
    pub backend_dirty: bool,
    pub app_dirty: bool,
    pub code_count: u32,
    pub app_count: u32,
}

/// Shared change tracker type for thread-safe access from watcher tasks
pub(crate) type SharedChangeTracker = Arc<std::sync::Mutex<DevChangeTracker>>;

impl DevChangeTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mark a backend (tugcast binary) change. Increments the shared code_count.
    pub fn mark_backend(&mut self) {
        self.backend_dirty = true;
        self.code_count += 1;
    }

    /// Mark an app source (.swift) change.
    pub fn mark_app(&mut self) {
        self.app_dirty = true;
        self.app_count += 1;
    }

    /// Take a snapshot of the current dirty state for notification payloads.
    /// Returns (changes_vec, code_count, app_count).
    pub fn snapshot(&self) -> (Vec<&'static str>, u32, u32) {
        let mut changes = Vec::new();
        if self.backend_dirty {
            changes.push("backend");
        }
        if self.app_dirty {
            changes.push("app");
        }
        (changes, self.code_count, self.app_count)
    }

    /// Clear backend state after a restart operation.
    /// Preserves app state.
    #[allow(dead_code)]
    pub fn clear_restart(&mut self) {
        self.backend_dirty = false;
        self.code_count = 0;
    }

    /// Clear all state after a relaunch or full reset.
    #[allow(dead_code)]
    pub fn clear_all(&mut self) {
        self.backend_dirty = false;
        self.app_dirty = false;
        self.code_count = 0;
        self.app_count = 0;
    }
}

/// Dev runtime: holds file watcher and change tracker for RAII cleanup
pub(crate) struct DevRuntime {
    pub(crate) _compiled_watcher: tokio::task::JoinHandle<()>,
    pub(crate) _app_watcher: RecommendedWatcher,
    pub(crate) _rust_source_watcher: RecommendedWatcher,
    #[allow(dead_code)]
    pub(crate) change_tracker: SharedChangeTracker,
}

/// Create a new shared dev state initialized to None
pub(crate) fn new_shared_dev_state() -> SharedDevState {
    Arc::new(ArcSwap::from_pointee(None))
}

/// Enable dev mode: start backend binary watcher and app source watcher
pub(crate) async fn enable_dev_mode(
    source_tree: PathBuf,
    shared_state: &SharedDevState,
    client_action_tx: broadcast::Sender<Frame>,
) -> Result<DevRuntime, String> {
    // Resolve symlinks without canonicalize(), which on macOS resolves through
    // the /Users firmlink to /System/Volumes/Data/Users — a path FSEvents ignores.
    let source_tree = resolve_symlinks(&source_tree).map_err(|e| {
        format!(
            "failed to resolve source_tree {}: {}",
            source_tree.display(),
            e
        )
    })?;

    // Create change tracker
    let change_tracker = Arc::new(std::sync::Mutex::new(DevChangeTracker::new()));

    // Create compiled watcher: backend binary mtime poller.
    let backend_path = source_tree.join("tugrust/target/debug/tugcast");
    let compiled_watcher = dev_compiled_watcher(
        backend_path,
        change_tracker.clone(),
        client_action_tx.clone(),
    );

    // Create app watcher: app sources (.swift files) notify watcher
    let app_sources_dir = source_tree.join("tugapp/Sources");
    let app_watcher = dev_app_watcher(
        app_sources_dir,
        change_tracker.clone(),
        client_action_tx.clone(),
    )?;

    // Create rust source watcher: tugcode Rust source files notify watcher
    let rust_sources_dir = source_tree.join("tugcode");
    let rust_source_watcher =
        dev_rust_source_watcher(rust_sources_dir, change_tracker.clone(), client_action_tx)?;

    // Store loaded DevState into shared state
    shared_state.store(Arc::new(Some(DevState {
        source_tree: source_tree.clone(),
    })));

    info!(source_tree = ?source_tree, "dev mode enabled");

    Ok(DevRuntime {
        _compiled_watcher: compiled_watcher,
        _app_watcher: app_watcher,
        _rust_source_watcher: rust_source_watcher,
        change_tracker,
    })
}

/// Disable dev mode: clear shared state, drop file watchers
pub(crate) fn disable_dev_mode(runtime: DevRuntime, shared_state: &SharedDevState) {
    // Clear shared state
    shared_state.store(Arc::new(None));

    // Abort the compiled watcher polling task (drop alone does not abort spawned tokio tasks)
    runtime._compiled_watcher.abort();

    // Drop runtime (stops file watchers for app)
    drop(runtime);

    info!("dev mode disabled");
}

/// Resolve symlinks in a path, producing a path FSEvents can watch.
///
/// On macOS, `canonicalize()` resolves through the `/Users` firmlink to
/// `/System/Volumes/Data/Users`, producing paths that FSEvents ignores.
/// This function resolves symlinks and then normalizes the firmlink
/// prefix back to `/Users/` so FSEvents works correctly.
pub(crate) fn resolve_symlinks(path: &Path) -> std::io::Result<PathBuf> {
    let mut resolved = PathBuf::new();
    for component in path.components() {
        resolved.push(component);
        if resolved.symlink_metadata()?.file_type().is_symlink() {
            let target = std::fs::read_link(&resolved)?;
            if target.is_absolute() {
                resolved = target;
            } else {
                resolved.pop();
                resolved.push(target);
            }
        }
    }

    // macOS firmlink normalization: FSEvents expects the user-visible form
    // (`/Users/...`), not the data-volume expansion (`/System/Volumes/Data/
    // Users/...`) that `read_link` may produce. Strip the `/System/Volumes/
    // Data` prefix generically — not just `/Users`, but every firmlink
    // (`/opt`, `/private`, …) — so any firmlinked source tree collapses
    // correctly. This is the same Claude form the crate's canonical
    // `path_resolver::resolve_to_claude_form` produces; this function does
    // NOT call it because FSEvents needs a path resolved
    // component-by-component (canonicalize over-resolves), and dev-mode init
    // runs before any ledger/claude context exists.
    #[cfg(target_os = "macos")]
    {
        const FIRMLINK_PREFIX: &str = "/System/Volumes/Data";
        if let Some(path_str) = resolved.to_str() {
            if let Some(rest) = path_str.strip_prefix(FIRMLINK_PREFIX) {
                // Only when the prefix ends at a path boundary (next char is
                // `/`) — never a longer name like `/System/Volumes/DataFoo`.
                if rest.starts_with('/') {
                    resolved = PathBuf::from(rest);
                }
            }
        }
    }

    Ok(resolved)
}

/// Shorten a path by reversing macOS `/etc/synthetic.conf` firmlinks.
///
/// On macOS, synthetic.conf maps short names to real paths, e.g.:
///   `u\t/Users/kocienda/Mounts/u`
/// This function reverses that mapping for display: given
/// `/Users/kocienda/Mounts/u/src/tugtool`, it returns `/u/src/tugtool`.
///
/// On non-macOS platforms, returns the path unchanged.
#[allow(dead_code)]
pub(crate) fn shorten_synthetic_path(path: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Ok(contents) = std::fs::read_to_string("/etc/synthetic.conf") {
            for line in contents.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                // Format: name<TAB>target
                let parts: Vec<&str> = line.splitn(2, '\t').collect();
                if parts.len() == 2 {
                    let name = parts[0].trim();
                    let raw_target = parts[1].trim();
                    // Normalize the target through resolve_symlinks so it matches
                    // the same form as the input path
                    let target = resolve_symlinks(Path::new(raw_target))
                        .unwrap_or_else(|_| PathBuf::from(raw_target));
                    if let Some(suffix) = path
                        .to_str()
                        .and_then(|p| p.strip_prefix(target.to_str().unwrap_or("")))
                    {
                        return PathBuf::from(format!("/{}{}", name, suffix));
                    }
                }
            }
        }
    }
    path.to_path_buf()
}

/// Build and send a dev_notification Control frame.
///
/// For `"restart_available"` type: includes `changes` array, `count`, and `timestamp` from tracker snapshot
/// For `"relaunch_available"` type: includes `changes` array, `count`, and `timestamp` from tracker snapshot
pub(crate) fn send_dev_notification(
    notification_type: &str,
    tracker: &SharedChangeTracker,
    client_action_tx: &broadcast::Sender<Frame>,
) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let guard = tracker.lock().unwrap();
    let (changes, code_count, app_count) = guard.snapshot();
    let count = if notification_type == "restart_available" {
        code_count
    } else {
        app_count
    };
    let json = serde_json::json!({
        "action": "dev_notification",
        "type": notification_type,
        "changes": changes,
        "count": count,
        "timestamp": timestamp,
    });
    let payload = serde_json::to_vec(&json).unwrap_or_default();

    debug!(
        "dev: send_dev_notification type={} count={} timestamp={}",
        notification_type, count, timestamp
    );

    let frame = Frame::new(FeedId::CONTROL, payload);
    match client_action_tx.send(frame) {
        Ok(receivers) => debug!(
            "dev: send_dev_notification sent to {} receiver(s)",
            receivers
        ),
        Err(_) => debug!("dev: send_dev_notification had no receivers"),
    }
}

/// Read mtime for a file path. Returns None if file does not exist or is unreadable.
fn read_mtime(path: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Check if mtime has changed and stabilize. Returns Some(new_mtime) if change confirmed.
async fn check_and_stabilize(
    path: &Path,
    last_mtime: &Option<std::time::SystemTime>,
) -> Option<std::time::SystemTime> {
    let current_mtime = read_mtime(path);

    // No change if mtime is the same
    if current_mtime == *last_mtime {
        return None;
    }

    // Mtime changed (or file appeared/disappeared). Enter stabilization.
    let mut stabilizing_mtime = current_mtime;
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let new_mtime = read_mtime(path);

        // If mtime changed during stabilization, restart the wait
        if new_mtime != stabilizing_mtime {
            stabilizing_mtime = new_mtime;
            continue;
        }

        // Mtime stable for 500ms
        // Return the stabilized mtime if it's different from the last known value
        if new_mtime != *last_mtime {
            return new_mtime;
        } else {
            // Stabilized back to the original value (should not happen, but handle it)
            return None;
        }
    }
}

/// Check whether a notify event contains paths with .swift extension
fn has_swift_extension(event: &notify::Event) -> bool {
    event
        .paths
        .iter()
        .any(|p| p.extension().is_some_and(|ext| ext == "swift"))
}

/// Check whether a notify event contains paths with .rs extension or named Cargo.toml or Cargo.lock
fn has_rust_extension(event: &notify::Event) -> bool {
    event.paths.iter().any(|p| {
        p.extension().is_some_and(|ext| ext == "rs")
            || p.file_name()
                .is_some_and(|name| name == "Cargo.toml" || name == "Cargo.lock")
    })
}

/// Check whether a notify event contains paths that are inside a `/target/` directory.
///
/// Returns `true` if any path in the event has `/target/` as a path component, which
/// indicates a build artifact change that should not trigger restart notifications.
fn is_target_path(event: &notify::Event) -> bool {
    event
        .paths
        .iter()
        .any(|p| p.components().any(|c| c.as_os_str() == "target"))
}

/// Start Rust source watcher using notify events
///
/// Watches `tugrust/` recursively for `.rs` file, `Cargo.toml`, and `Cargo.lock` changes.
/// Events from paths containing a `/target/` component are excluded to prevent build
/// artifact changes from triggering restart notifications. Uses a quiet-period debounce
/// (100ms silence window). On change, marks the backend tracker category and sends a
/// restart_available notification.
pub(crate) fn dev_rust_source_watcher(
    rust_sources_dir: PathBuf,
    tracker: SharedChangeTracker,
    client_action_tx: broadcast::Sender<Frame>,
) -> Result<RecommendedWatcher, String> {
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();

    let mut watcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            let _ = event_tx.send(res);
        })
        .map_err(|e| format!("failed to create dev rust source watcher: {}", e))?;

    // Watch rust sources directory if it exists
    if rust_sources_dir.exists() {
        watcher
            .watch(&rust_sources_dir, RecursiveMode::Recursive)
            .map_err(|e| format!("failed to watch {}: {}", rust_sources_dir.display(), e))?;
        info!("dev: watching rust sources {}", rust_sources_dir.display());
    } else {
        warn!(
            "dev: rust sources directory {} does not exist, skipping rust source watcher",
            rust_sources_dir.display()
        );
    }

    // Quiet-period debounce task
    tokio::spawn(async move {
        let quiet_period = Duration::from_millis(100);
        loop {
            // Phase 1: Wait for a .rs, Cargo.toml, or Cargo.lock event that is not
            // inside a /target/ directory (to exclude build artifacts).
            loop {
                match event_rx.recv().await {
                    Some(Ok(event)) if has_rust_extension(&event) && !is_target_path(&event) => {
                        break;
                    }
                    Some(_) => continue,
                    None => return,
                }
            }

            // Phase 2: Consume events until quiet
            loop {
                match tokio::time::timeout(quiet_period, event_rx.recv()).await {
                    Ok(Some(_)) => continue,
                    Ok(None) => return,
                    Err(_) => break,
                }
            }

            // Phase 3: Mark and notify
            tracker.lock().unwrap().mark_backend();
            send_dev_notification("restart_available", &tracker, &client_action_tx);
            info!("dev: sent dev_notification type=restart_available (rust source)");
        }
    });

    Ok(watcher)
}

/// Start compiled code watcher (backend only) using mtime polling
///
/// Polls the backend binary path every 2 seconds.
/// On stable mtime change (after 500ms stabilization), marks the backend tracker category
/// and sends a restart_available notification.
pub(crate) fn dev_compiled_watcher(
    backend_path: PathBuf,
    tracker: SharedChangeTracker,
    client_action_tx: broadcast::Sender<Frame>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        // Read initial mtime (None if file does not exist)
        let mut backend_mtime = read_mtime(&backend_path);

        info!(
            "dev: compiled watcher monitoring backend={}",
            backend_path.display(),
        );

        loop {
            interval.tick().await;

            // Check backend path
            if let Some(new_mtime) = check_and_stabilize(&backend_path, &backend_mtime).await {
                backend_mtime = Some(new_mtime);
                debug!(
                    "dev: compiled watcher mtime changed for {}",
                    backend_path.display()
                );
                tracker.lock().unwrap().mark_backend();
                send_dev_notification("restart_available", &tracker, &client_action_tx);
                info!("dev: compiled watcher detected backend change");
            }
        }
    })
}

/// Start app sources watcher (app) using notify events
///
/// Watches tugapp/Sources/ recursively for .swift file changes. Uses a
/// quiet-period debounce (100ms silence window). On change, marks
/// the app tracker category and sends a relaunch_available notification.
pub(crate) fn dev_app_watcher(
    app_sources_dir: PathBuf,
    tracker: SharedChangeTracker,
    client_action_tx: broadcast::Sender<Frame>,
) -> Result<RecommendedWatcher, String> {
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();

    let mut watcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            let _ = event_tx.send(res);
        })
        .map_err(|e| format!("failed to create dev app watcher: {}", e))?;

    // Watch app sources directory if it exists
    if app_sources_dir.exists() {
        watcher
            .watch(&app_sources_dir, RecursiveMode::Recursive)
            .map_err(|e| format!("failed to watch {}: {}", app_sources_dir.display(), e))?;
        info!("dev: watching app sources {}", app_sources_dir.display());
    } else {
        warn!(
            "dev: app sources directory {} does not exist, skipping app watcher",
            app_sources_dir.display()
        );
    }

    // Quiet-period debounce task
    tokio::spawn(async move {
        let quiet_period = Duration::from_millis(100);
        loop {
            // Phase 1: Wait for a .swift file event
            loop {
                match event_rx.recv().await {
                    Some(Ok(event)) if has_swift_extension(&event) => break,
                    Some(_) => continue,
                    None => return,
                }
            }

            // Phase 2: Consume events until quiet
            loop {
                match tokio::time::timeout(quiet_period, event_rx.recv()).await {
                    Ok(Some(_)) => continue,
                    Ok(None) => return,
                    Err(_) => break,
                }
            }

            // Phase 3: Mark and notify
            tracker.lock().unwrap().mark_app();
            send_dev_notification("relaunch_available", &tracker, &client_action_tx);
            info!("dev: sent dev_notification type=relaunch_available");
        }
    });

    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_shared_dev_state_is_none() {
        let shared = new_shared_dev_state();
        assert!(shared.load().is_none());
    }

    #[test]
    fn test_shared_dev_state_store_load() {
        use tempfile::TempDir;

        let temp_dir = TempDir::new().unwrap();

        let state = DevState {
            source_tree: temp_dir.path().to_path_buf(),
        };
        let shared = new_shared_dev_state();

        // Store the state
        shared.store(Arc::new(Some(state)));

        // Load and verify
        assert!(shared.load().is_some());
    }

    #[tokio::test]
    async fn test_enable_dev_mode_valid() {
        use tempfile::TempDir;

        // enable_dev_mode only requires source_tree to resolve symlinks — no dist/ needed
        let temp_dir = TempDir::new().unwrap();

        let shared = new_shared_dev_state();
        let (client_action_tx, _) = broadcast::channel(16);

        let result =
            enable_dev_mode(temp_dir.path().to_path_buf(), &shared, client_action_tx).await;

        assert!(result.is_ok());
        assert!(shared.load().is_some());

        // Drop runtime to clean up the watcher
        drop(result.unwrap());
    }

    #[tokio::test]
    async fn test_enable_dev_mode_invalid_path() {
        // A path that doesn't exist cannot be resolved by resolve_symlinks
        let nonexistent = std::path::PathBuf::from("/nonexistent/path/that/does/not/exist");

        let shared = new_shared_dev_state();
        let (client_action_tx, _) = broadcast::channel(16);

        let result = enable_dev_mode(nonexistent, &shared, client_action_tx).await;

        assert!(result.is_err());
        assert!(shared.load().is_none());
    }

    #[tokio::test]
    async fn test_disable_dev_mode_clears_state() {
        use tempfile::TempDir;

        let temp_dir = TempDir::new().unwrap();

        let shared = new_shared_dev_state();
        let (client_action_tx, _) = broadcast::channel(16);

        let runtime = enable_dev_mode(temp_dir.path().to_path_buf(), &shared, client_action_tx)
            .await
            .unwrap();

        assert!(shared.load().is_some());

        // Disable dev mode
        disable_dev_mode(runtime, &shared);

        assert!(shared.load().is_none());
    }

    #[tokio::test]
    async fn test_enable_disable_enable_different_path() {
        use tempfile::TempDir;

        let temp_dir1 = TempDir::new().unwrap();
        let temp_dir2 = TempDir::new().unwrap();

        let shared = new_shared_dev_state();
        let (client_action_tx, _) = broadcast::channel(16);

        // Enable with path1
        let runtime1 = enable_dev_mode(
            temp_dir1.path().to_path_buf(),
            &shared,
            client_action_tx.clone(),
        )
        .await
        .unwrap();
        assert!(shared.load().is_some());

        // Disable
        disable_dev_mode(runtime1, &shared);

        // Enable with path2
        let runtime2 = enable_dev_mode(temp_dir2.path().to_path_buf(), &shared, client_action_tx)
            .await
            .unwrap();

        // Verify the source_tree in the loaded state matches path2 (resolved)
        let expected = resolve_symlinks(temp_dir2.path()).unwrap();
        let guard = shared.load();
        if let Some(ref state) = **guard {
            assert_eq!(state.source_tree, expected);
        } else {
            panic!("Expected Some(DevState) after enable");
        }

        drop(runtime2);
    }

    #[test]
    fn test_change_tracker_new_is_clean() {
        let tracker = DevChangeTracker::new();
        assert!(!tracker.backend_dirty);
        assert!(!tracker.app_dirty);
        assert_eq!(tracker.code_count, 0);
        assert_eq!(tracker.app_count, 0);
    }

    #[test]
    fn test_change_tracker_mark_backend() {
        let mut tracker = DevChangeTracker::new();
        tracker.mark_backend();
        assert!(tracker.backend_dirty);
        assert!(!tracker.app_dirty);
        assert_eq!(tracker.code_count, 1);
        assert_eq!(tracker.app_count, 0);
    }

    #[test]
    fn test_change_tracker_combined_count() {
        let mut tracker = DevChangeTracker::new();
        tracker.mark_backend();
        tracker.mark_backend();
        assert!(tracker.backend_dirty);
        assert!(!tracker.app_dirty);
        assert_eq!(tracker.code_count, 2);
        assert_eq!(tracker.app_count, 0);
    }

    #[test]
    fn test_change_tracker_mark_app() {
        let mut tracker = DevChangeTracker::new();
        tracker.mark_app();
        assert!(!tracker.backend_dirty);
        assert!(tracker.app_dirty);
        assert_eq!(tracker.code_count, 0);
        assert_eq!(tracker.app_count, 1);
    }

    #[test]
    fn test_change_tracker_clear_restart() {
        let mut tracker = DevChangeTracker::new();
        tracker.mark_backend();
        tracker.mark_app();
        assert_eq!(tracker.code_count, 1);
        assert_eq!(tracker.app_count, 1);

        tracker.clear_restart();
        assert!(!tracker.backend_dirty);
        assert!(tracker.app_dirty); // app state preserved
        assert_eq!(tracker.code_count, 0);
        assert_eq!(tracker.app_count, 1); // app count preserved
    }

    #[test]
    fn test_change_tracker_clear_all() {
        let mut tracker = DevChangeTracker::new();
        tracker.mark_backend();
        tracker.mark_app();

        tracker.clear_all();
        assert!(!tracker.backend_dirty);
        assert!(!tracker.app_dirty);
        assert_eq!(tracker.code_count, 0);
        assert_eq!(tracker.app_count, 0);
    }

    #[test]
    fn test_change_tracker_snapshot() {
        let mut tracker = DevChangeTracker::new();
        tracker.mark_backend();
        assert_eq!(tracker.code_count, 1);

        let (changes, code_count, app_count) = tracker.snapshot();
        assert_eq!(changes, vec!["backend"]);
        assert_eq!(code_count, 1);
        assert_eq!(app_count, 0);

        // Add app change
        tracker.mark_app();
        let (changes, code_count, app_count) = tracker.snapshot();
        assert_eq!(changes, vec!["backend", "app"]);
        assert_eq!(code_count, 1);
        assert_eq!(app_count, 1);
    }

    #[tokio::test]
    async fn test_send_dev_notification_restart_available() {
        let tracker = Arc::new(std::sync::Mutex::new(DevChangeTracker::new()));
        {
            let mut guard = tracker.lock().unwrap();
            guard.mark_backend();
        }

        let (client_action_tx, mut rx) = broadcast::channel(16);
        send_dev_notification("restart_available", &tracker, &client_action_tx);

        let frame = rx.recv().await.unwrap();
        assert_eq!(frame.feed_id, FeedId::CONTROL);

        let json: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(json["action"], "dev_notification");
        assert_eq!(json["type"], "restart_available");
        assert_eq!(json["changes"], serde_json::json!(["backend"]));
        assert_eq!(json["count"], 1);
        assert!(json.get("timestamp").is_some());
        assert!(json["timestamp"].as_u64().unwrap() > 0);
    }

    #[tokio::test]
    async fn test_send_dev_notification_relaunch_available() {
        let tracker = Arc::new(std::sync::Mutex::new(DevChangeTracker::new()));
        {
            let mut guard = tracker.lock().unwrap();
            guard.mark_app();
        }

        let (client_action_tx, mut rx) = broadcast::channel(16);
        send_dev_notification("relaunch_available", &tracker, &client_action_tx);

        let frame = rx.recv().await.unwrap();
        assert_eq!(frame.feed_id, FeedId::CONTROL);

        let json: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(json["action"], "dev_notification");
        assert_eq!(json["type"], "relaunch_available");
        assert_eq!(json["changes"], serde_json::json!(["app"]));
        assert_eq!(json["count"], 1);
        assert!(json.get("timestamp").is_some());
        assert!(json["timestamp"].as_u64().unwrap() > 0);
    }

    #[test]
    fn test_has_swift_extension() {
        use notify::{Event, EventKind};
        use std::path::PathBuf;

        let swift_event = Event {
            kind: EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Any,
            )),
            paths: vec![PathBuf::from("test.swift")],
            attrs: Default::default(),
        };
        assert!(has_swift_extension(&swift_event));

        let other_event = Event {
            kind: EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Any,
            )),
            paths: vec![PathBuf::from("test.rs")],
            attrs: Default::default(),
        };
        assert!(!has_swift_extension(&other_event));
    }

    #[test]
    fn test_has_rust_extension_rs_file() {
        use notify::{Event, EventKind};
        use std::path::PathBuf;

        let event = Event {
            kind: EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Any,
            )),
            paths: vec![PathBuf::from("test.rs")],
            attrs: Default::default(),
        };
        assert!(has_rust_extension(&event));
    }

    #[test]
    fn test_has_rust_extension_cargo_toml() {
        use notify::{Event, EventKind};
        use std::path::PathBuf;

        let event = Event {
            kind: EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Any,
            )),
            paths: vec![PathBuf::from("some/path/Cargo.toml")],
            attrs: Default::default(),
        };
        assert!(has_rust_extension(&event));
    }

    #[test]
    fn test_has_rust_extension_swift_false() {
        use notify::{Event, EventKind};
        use std::path::PathBuf;

        let event = Event {
            kind: EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Any,
            )),
            paths: vec![PathBuf::from("test.swift")],
            attrs: Default::default(),
        };
        assert!(!has_rust_extension(&event));
    }

    #[test]
    fn test_has_rust_extension_ts_false() {
        use notify::{Event, EventKind};
        use std::path::PathBuf;

        let event = Event {
            kind: EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Any,
            )),
            paths: vec![PathBuf::from("test.ts")],
            attrs: Default::default(),
        };
        assert!(!has_rust_extension(&event));
    }

    #[test]
    fn test_has_rust_extension_cargo_lock() {
        use notify::{Event, EventKind};
        use std::path::PathBuf;

        let event = Event {
            kind: EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Any,
            )),
            paths: vec![PathBuf::from("tugrust/Cargo.lock")],
            attrs: Default::default(),
        };
        assert!(has_rust_extension(&event));
    }

    #[test]
    fn test_is_target_path_true() {
        use notify::{Event, EventKind};
        use std::path::PathBuf;

        let event = Event {
            kind: EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Any,
            )),
            paths: vec![PathBuf::from("tugrust/target/debug/tugcast")],
            attrs: Default::default(),
        };
        assert!(is_target_path(&event));
    }

    #[test]
    fn test_is_target_path_false() {
        use notify::{Event, EventKind};
        use std::path::PathBuf;

        let event = Event {
            kind: EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Any,
            )),
            paths: vec![PathBuf::from("tugrust/crates/tugcast/src/main.rs")],
            attrs: Default::default(),
        };
        assert!(!is_target_path(&event));
    }

    #[tokio::test]
    async fn test_rust_source_watcher_ignores_target_dir() {
        use std::fs;
        use tempfile::TempDir;

        let temp_dir = TempDir::new().unwrap();
        let tugcode_dir = temp_dir.path().join("tugcode");
        let target_dir = tugcode_dir.join("target").join("debug");
        fs::create_dir_all(&target_dir).unwrap();

        let tracker = Arc::new(std::sync::Mutex::new(DevChangeTracker::new()));
        let (client_action_tx, mut rx) = broadcast::channel(16);

        let _watcher =
            dev_rust_source_watcher(tugcode_dir.clone(), tracker.clone(), client_action_tx)
                .unwrap();

        // Create a file inside target/ — this should NOT trigger a notification
        let artifact = target_dir.join("tugcast");
        fs::write(&artifact, b"binary content").unwrap();

        // Wait longer than the debounce window — no notification expected
        match tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
            Ok(_) => panic!("Expected no notification for /target/ path change, but got one"),
            Err(_) => {
                // Timeout means no notification was sent — correct behavior
            }
        }
    }

    #[tokio::test]
    async fn test_rust_source_watcher_detects_rs_change() {
        use std::fs;
        use tempfile::TempDir;

        let temp_dir = TempDir::new().unwrap();
        let crates_dir = temp_dir.path().join("crates");
        fs::create_dir_all(&crates_dir).unwrap();

        let tracker = Arc::new(std::sync::Mutex::new(DevChangeTracker::new()));
        let (client_action_tx, mut rx) = broadcast::channel(16);

        let _watcher =
            dev_rust_source_watcher(crates_dir.clone(), tracker.clone(), client_action_tx).unwrap();

        let rs_file = crates_dir.join("main.rs");

        // Keep touching the file until the notification lands. The watcher's
        // FSEvents stream is not necessarily delivering by the time watch()
        // returns, so a single write can be missed outright — and under a full
        // nextest run the debounce task is competing for the CPU besides.
        let writer = tokio::spawn(async move {
            loop {
                fs::write(&rs_file, "fn main() {}").unwrap();
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        });

        let received = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await;
        writer.abort();

        match received {
            Ok(Ok(frame)) => {
                assert_eq!(frame.feed_id, FeedId::CONTROL);
                let json: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
                assert_eq!(json["action"], "dev_notification");
                assert_eq!(json["type"], "restart_available");

                // Verify tracker was marked
                let guard = tracker.lock().unwrap();
                assert!(guard.backend_dirty);
                assert!(guard.code_count >= 1);
            }
            Ok(Err(e)) => panic!("broadcast recv error: {}", e),
            Err(_) => panic!("Timeout waiting for rust source watcher notification"),
        }
    }

    #[tokio::test]
    async fn test_compiled_watcher_detects_mtime_change() {
        use std::fs;
        use tempfile::TempDir;

        let temp_dir = TempDir::new().unwrap();
        let backend_path = temp_dir.path().join("tugcast");

        // Create the backend file
        fs::write(&backend_path, b"initial content").unwrap();

        let tracker = Arc::new(std::sync::Mutex::new(DevChangeTracker::new()));
        let (client_action_tx, mut rx) = broadcast::channel(16);

        let _handle = dev_compiled_watcher(backend_path.clone(), tracker.clone(), client_action_tx);

        // Wait for initial scan
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Modify the backend file
        tokio::time::sleep(Duration::from_millis(100)).await;
        fs::write(&backend_path, b"modified content").unwrap();

        // Wait for detection (2s poll + 500ms stabilization + buffer)
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Ok(frame)) => {
                assert_eq!(frame.feed_id, FeedId::CONTROL);
                let json: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
                assert_eq!(json["action"], "dev_notification");
                assert_eq!(json["type"], "restart_available");

                // Verify tracker was marked
                let guard = tracker.lock().unwrap();
                assert!(guard.backend_dirty);
                assert_eq!(guard.code_count, 1);
            }
            Ok(Err(e)) => panic!("broadcast recv error: {}", e),
            Err(_) => panic!("Timeout waiting for compiled watcher notification"),
        }
    }

    #[tokio::test]
    async fn test_compiled_watcher_missing_at_start() {
        use std::fs;
        use tempfile::TempDir;

        let temp_dir = TempDir::new().unwrap();
        let backend_path = temp_dir.path().join("tugcast");

        // File does not exist initially
        let tracker = Arc::new(std::sync::Mutex::new(DevChangeTracker::new()));
        let (client_action_tx, mut rx) = broadcast::channel(16);

        let _handle = dev_compiled_watcher(backend_path.clone(), tracker.clone(), client_action_tx);

        // Wait a bit - should not panic, no notification
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert!(
            rx.try_recv().is_err(),
            "Expected no notification while files missing"
        );

        // Create the backend file
        fs::write(&backend_path, b"new content").unwrap();

        // Wait for detection
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Ok(frame)) => {
                assert_eq!(frame.feed_id, FeedId::CONTROL);
                let json: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
                assert_eq!(json["type"], "restart_available");
            }
            Ok(Err(e)) => panic!("broadcast recv error: {}", e),
            Err(_) => panic!("Timeout waiting for notification after file appears"),
        }
    }

    #[tokio::test]
    async fn test_compiled_watcher_stabilization() {
        use std::fs;
        use tempfile::TempDir;

        let temp_dir = TempDir::new().unwrap();
        let backend_path = temp_dir.path().join("tugcast");

        // Create the backend file
        fs::write(&backend_path, b"initial").unwrap();

        let tracker = Arc::new(std::sync::Mutex::new(DevChangeTracker::new()));
        let (client_action_tx, mut rx) = broadcast::channel(16);

        let _handle = dev_compiled_watcher(backend_path.clone(), tracker.clone(), client_action_tx);

        // Wait for initial scan
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Modify the file
        fs::write(&backend_path, b"modified1").unwrap();

        // Quickly modify again (within stabilization window)
        tokio::time::sleep(Duration::from_millis(200)).await;
        fs::write(&backend_path, b"modified2").unwrap();

        // Should receive only one notification after stabilization
        match tokio::time::timeout(Duration::from_secs(6), rx.recv()).await {
            Ok(Ok(frame)) => {
                assert_eq!(frame.feed_id, FeedId::CONTROL);
                // Verify only one notification (try_recv should fail)
                tokio::time::sleep(Duration::from_millis(100)).await;
                assert!(
                    rx.try_recv().is_err(),
                    "Expected only one notification after stabilization"
                );
            }
            Ok(Err(e)) => panic!("broadcast recv error: {}", e),
            Err(_) => panic!("Timeout waiting for stabilized notification"),
        }
    }

    #[tokio::test]
    async fn test_app_watcher_detects_swift_change() {
        use std::fs;
        use tempfile::TempDir;

        let temp_dir = TempDir::new().unwrap();
        let app_sources_dir = temp_dir.path().join("Sources");
        fs::create_dir_all(&app_sources_dir).unwrap();

        let tracker = Arc::new(std::sync::Mutex::new(DevChangeTracker::new()));
        let (client_action_tx, mut rx) = broadcast::channel(16);

        let _watcher =
            dev_app_watcher(app_sources_dir.clone(), tracker.clone(), client_action_tx).unwrap();

        let swift_file = app_sources_dir.join("Test.swift");

        // Keep touching the file until the notification lands — see the rust
        // source watcher test for why one write is not enough.
        let writer = tokio::spawn(async move {
            loop {
                fs::write(&swift_file, "struct Test {}").unwrap();
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        });

        let received = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await;
        writer.abort();

        match received {
            Ok(Ok(frame)) => {
                assert_eq!(frame.feed_id, FeedId::CONTROL);
                let json: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
                assert_eq!(json["action"], "dev_notification");
                assert_eq!(json["type"], "relaunch_available");

                // Verify tracker was marked
                let guard = tracker.lock().unwrap();
                assert!(guard.app_dirty);
                assert!(guard.app_count >= 1);
            }
            Ok(Err(e)) => panic!("broadcast recv error: {}", e),
            Err(_) => panic!("Timeout waiting for app watcher notification"),
        }
    }
}
