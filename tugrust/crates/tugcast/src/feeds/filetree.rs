//! FileTreeFeed — query/response file completion feed.
//!
//! Maintains a `BTreeSet<String>` of relative file paths from the project tree.
//! Receives queries via mpsc, scores them with the fuzzy scorer, and responds
//! with top-N scored results via a watch channel.
//!
//! A `SnapshotFeed` implementor: the trait's consuming `run(self: Box<Self>)`
//! carries the feed's owned mutable state (index, query receiver, secret
//! filter) directly — the dual inputs (query channel + file events) are
//! constructor-injected fields, not extra `run` parameters.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::{broadcast, mpsc, watch};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use tugcast_core::types::{FsEvent, ScoredResult};
use tugcast_core::{FeedId, FileTreeSnapshot, Frame, SnapshotFeed};

use crate::path_resolver::CanonicalPath;

use super::code::splice_workspace_key;
use super::fuzzy_scorer::score_file_path;
use super::secret_filter::{SecretFilter, TUGATTACHIGNORE_FILENAME};

/// Maximum number of results returned per query.
const MAX_RESULTS: usize = 8;

/// Parsed query from FILETREE_QUERY payload.
#[derive(Debug, Clone)]
pub struct FileTreeQuery {
    pub query: String,
    pub root: Option<PathBuf>,
}

/// File tree feed that maintains an index and responds to scored queries.
pub struct FileTreeFeed {
    /// Canonical identity of the root the FileWatcher observes — the
    /// comparand for `watcher_aligned`. [L29]
    original_key: CanonicalPath,
    /// Canonical identity of the currently indexed root. Retarget
    /// decisions compare against this, never against a raw spelling:
    /// `--source-tree /u/src/tugtool` and the card's canonical
    /// `/Users/…/Mounts/u/src/tugtool` name one directory, and a raw
    /// comparison reads them as two. [L29]
    current_key: CanonicalPath,
    /// The current indexed root, as a path to hand to the walker and the
    /// `SecretFilter`. Identity lives in `current_key`.
    current_root: PathBuf,
    /// The file index.
    files: BTreeSet<String>,
    /// Whether the file index exceeded the cap.
    truncated: bool,
    /// True when current_root matches original_root (safe to apply FileWatcher events).
    watcher_aligned: bool,
    /// Broadcast sender to subscribe for FileWatcher events.
    event_tx: broadcast::Sender<Vec<FsEvent>>,
    /// Receives queries from the router.
    query_rx: mpsc::Receiver<FileTreeQuery>,
    /// Canonical workspace identifier, spliced as the first field of every
    /// emitted FILETREE frame.
    workspace_key: Arc<str>,
    /// Secret-file matcher applied to the index at insertion time and to
    /// off-board (`/...` / `~/...`) results per-entry. Built once at
    /// `new` from the workspace root; rebuilt whenever a
    /// `.tugattachignore` event arrives in the watcher batch (analogous
    /// to the existing `.gitignore` re-walk). Per
    /// `arc/dev-atoms.md#step-4` and [D06].
    secret_filter: SecretFilter,
    /// Shared FILETREE-response broadcast channel. Every workspace's
    /// `FileTreeFeed` publishes its response frames here; the router
    /// subscribes once at the process level and forwards every frame to
    /// every connected client. JS-side filtering by `workspace_key`
    /// (spliced into each frame's JSON via `splice_workspace_key`)
    /// routes the response to the right card.
    ///
    /// This is the multi-workspace response path. The per-workspace
    /// `watch_tx` (the `watch_tx` argument to `run`) is still written
    /// for back-compat / test introspection, but the router no longer
    /// consumes it — see `main.rs`'s FILETREE wiring and
    /// `arc/dev-atoms.md#step-pre-4`.
    ft_response_tx: broadcast::Sender<Frame>,
}

impl FileTreeFeed {
    pub fn new(
        root: PathBuf,
        initial_files: BTreeSet<String>,
        truncated: bool,
        event_tx: broadcast::Sender<Vec<FsEvent>>,
        query_rx: mpsc::Receiver<FileTreeQuery>,
        workspace_key: Arc<str>,
        ft_response_tx: broadcast::Sender<Frame>,
    ) -> Self {
        // Build the secret-file matcher first so we can sweep the
        // freshly-walked initial set through it. The `walk_directory`
        // call upstream applied `.gitignore` — we apply the additive
        // built-in denylist + optional `.tugattachignore` here. Both
        // layers feed the same `BTreeSet<String>` invariant: every
        // entry in `files` is something the user may legitimately see
        // in `@`-completion.
        let secret_filter = SecretFilter::new(&root);
        let files = Self::sweep_secrets(initial_files, &secret_filter);
        let key = CanonicalPath::from_raw(&root);
        Self {
            original_key: key.clone(),
            current_key: key,
            current_root: root,
            files,
            truncated,
            watcher_aligned: true,
            event_tx,
            query_rx,
            workspace_key,
            secret_filter,
            ft_response_tx,
        }
    }

    /// Drop entries from `files` that match the secret filter. Called
    /// at construction time and after every walk-rebuild so the index
    /// invariant ("nothing in `files` is denylisted") holds.
    fn sweep_secrets(files: BTreeSet<String>, filter: &SecretFilter) -> BTreeSet<String> {
        files.into_iter().filter(|p| !filter.is_secret(p)).collect()
    }
}

#[async_trait]
impl SnapshotFeed for FileTreeFeed {
    fn feed_id(&self) -> FeedId {
        FeedId::FILETREE
    }

    fn name(&self) -> &str {
        "filetree"
    }

    /// Run the feed loop.
    async fn run(mut self: Box<Self>, watch_tx: watch::Sender<Frame>, cancel: CancellationToken) {
        let mut event_rx = self.event_tx.subscribe();

        // Send empty initial response.
        let initial = FileTreeSnapshot {
            query: String::new(),
            results: vec![],
            truncated: self.truncated,
        };
        let _ = self.send_response(&watch_tx, &initial);

        loop {
            tokio::select! {
                biased;

                _ = cancel.cancelled() => {
                    debug!("FileTreeFeed: cancelled");
                    break;
                }

                // FileWatcher events — only when aligned.
                result = event_rx.recv(), if self.watcher_aligned => {
                    match result {
                        Ok(events) => {
                            self.apply_events(&events);
                            // A `.tugattachignore` edit must rebuild the
                            // secret matcher before the re-walk so the
                            // sweep below sees the updated patterns.
                            // Checking first means a single batch that
                            // touches both `.gitignore` and
                            // `.tugattachignore` does only one re-walk.
                            if events.iter().any(Self::is_tugattachignore_change) {
                                info!("FileTreeFeed: .tugattachignore changed, rebuilding secret filter");
                                self.secret_filter = SecretFilter::new(&self.current_root);
                            }
                            // If a .gitignore OR .tugattachignore changed,
                            // re-walk to reconcile the BTreeSet with the
                            // new ignore rules; the sweep keeps the
                            // secret-filter invariant after the walk.
                            if events.iter().any(Self::is_gitignore_change)
                                || events.iter().any(Self::is_tugattachignore_change)
                            {
                                info!("FileTreeFeed: ignore rules changed, re-walking");
                                let (fresh_files, truncated) =
                                    super::file_watcher::walk_directory(&self.current_root);
                                self.files = Self::sweep_secrets(fresh_files, &self.secret_filter);
                                self.truncated = truncated;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            warn!("FileTreeFeed: lagged by {n} batches, index may be stale");
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            debug!("FileTreeFeed: broadcast closed");
                            break;
                        }
                    }
                }

                // Query input.
                Some(query) = self.query_rx.recv() => {
                    let response = self.handle_query(&query);
                    let _ = self.send_response(&watch_tx, &response);
                }
            }
        }
    }
}

impl FileTreeFeed {
    /// Check if an FsEvent touches a .gitignore file.
    fn is_gitignore_change(event: &FsEvent) -> bool {
        let path = match event {
            FsEvent::Created { path } | FsEvent::Modified { path } | FsEvent::Removed { path } => {
                path
            }
            FsEvent::Renamed { to, .. } => to,
        };
        path == ".gitignore" || path.ends_with("/.gitignore")
    }

    /// Check if an FsEvent touches the workspace-root `.tugattachignore`.
    /// Per [D06], only the root-level file is honored (no nested
    /// support); a nested path like `subdir/.tugattachignore` is
    /// ignored. Per Step 4 in `arc/dev-atoms.md`.
    fn is_tugattachignore_change(event: &FsEvent) -> bool {
        let path = match event {
            FsEvent::Created { path } | FsEvent::Modified { path } | FsEvent::Removed { path } => {
                path
            }
            FsEvent::Renamed { to, .. } => to,
        };
        path == TUGATTACHIGNORE_FILENAME
    }

    /// Apply filesystem events to the BTreeSet. Filtered through the
    /// secret matcher on insertion paths (Create / Rename-to) so a
    /// freshly-dropped `.env` never sneaks into the completion index.
    /// Removal paths are unconditional — if a path was somehow in the
    /// set, a remove event always evicts it.
    ///
    /// Event paths never carry the trailing-`/` directory marker (they
    /// come from `notify` verbatim), so insertions probe the live
    /// filesystem to classify, and removals evict both spellings plus
    /// — for a removed directory — every indexed child, since the
    /// watcher is not guaranteed to emit per-child events.
    fn apply_events(&mut self, events: &[FsEvent]) {
        for event in events {
            match event {
                FsEvent::Created { path } => {
                    self.insert_path(path);
                }
                FsEvent::Removed { path } => {
                    self.remove_path(path);
                }
                FsEvent::Renamed { from, to } => {
                    self.remove_path(from);
                    self.insert_path(to);
                }
                FsEvent::Modified { .. } => {
                    // File saves don't change the file list.
                }
            }
        }
    }

    /// Insert an event path in its index form (trailing `/` for a
    /// directory), unless the secret filter rejects it.
    fn insert_path(&mut self, path: &str) {
        let entry = if self.current_root.join(path).is_dir() {
            format!("{path}/")
        } else {
            path.to_string()
        };
        if !self.secret_filter.is_secret(&entry) {
            self.files.insert(entry);
        }
    }

    /// Evict an event path — both file and directory spellings — and,
    /// for a directory, everything indexed beneath it.
    fn remove_path(&mut self, path: &str) {
        self.files.remove(path);
        let dir = format!("{path}/");
        if self.files.remove(&dir) {
            let children: Vec<String> = self
                .files
                .range(dir.clone()..)
                .take_while(|p| p.starts_with(&dir))
                .cloned()
                .collect();
            for child in children {
                self.files.remove(&child);
            }
        }
    }

    /// Handle a query and produce a response.
    fn handle_query(&mut self, ftq: &FileTreeQuery) -> FileTreeSnapshot {
        // Retarget if requested [D09]. The client's `root` is a raw
        // spelling — canonicalize before comparing, or a card whose
        // project dir reaches us under a different spelling than the one
        // the workspace was created with retargets on its first
        // keystroke and never re-aligns. [L29]
        if let Some(ref new_root) = ftq.root {
            let new_key = CanonicalPath::from_raw(new_root);
            if new_key != self.current_key {
                self.retarget(new_root, new_key);
            }
        }
        self.dispatch_query(&ftq.query)
    }

    /// Dispatch a query string to the appropriate handler.
    fn dispatch_query(&self, query: &str) -> FileTreeSnapshot {
        // Off-board completion [D10]: absolute paths bypass the index.
        if query.starts_with('/') || query.starts_with('~') {
            return self.off_board_query(query);
        }

        // Empty query: root-level files alphabetically.
        if query.is_empty() {
            return self.empty_query();
        }

        // Normal query: pre-filter + fuzzy score.
        self.scored_query(query)
    }

    /// Retarget to a new root directory [D09]. Rebuilds the secret
    /// filter from the new root's `.tugattachignore` (or just the
    /// built-in denylist if no file is present) before sweeping the
    /// fresh walk through it.
    fn retarget(&mut self, new_root: &Path, new_key: CanonicalPath) {
        let (files, truncated) = super::file_watcher::walk_directory(new_root);
        self.secret_filter = SecretFilter::new(new_root);
        self.files = Self::sweep_secrets(files, &self.secret_filter);
        self.truncated = truncated;
        self.current_root = new_root.to_path_buf();
        self.watcher_aligned = new_key == self.original_key;
        self.current_key = new_key;
        info!(
            "FileTreeFeed: retargeted to {} ({} files, aligned={})",
            self.current_key.as_str(),
            self.files.len(),
            self.watcher_aligned,
        );
    }

    /// Off-board completion: readdir + prefix match [D10].
    fn off_board_query(&self, query: &str) -> FileTreeSnapshot {
        let expanded = if let Some(rest) = query.strip_prefix('~') {
            if let Ok(home) = std::env::var("HOME") {
                format!("{}{}", home, rest)
            } else {
                query.to_string()
            }
        } else {
            query.to_string()
        };

        let (parent_dir, name_prefix) = match expanded.rfind('/') {
            Some(i) => {
                let dir = if i == 0 { "/" } else { &expanded[..i] };
                let prefix = &expanded[i + 1..];
                (dir.to_string(), prefix.to_lowercase())
            }
            None => {
                return FileTreeSnapshot {
                    query: query.to_string(),
                    results: vec![],
                    truncated: self.truncated,
                };
            }
        };

        let mut entries: Vec<String> = Vec::new();
        if let Ok(read_dir) = std::fs::read_dir(&parent_dir) {
            for entry in read_dir.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    if name_prefix.is_empty() || name.to_lowercase().starts_with(&name_prefix) {
                        // Off-board paths are outside the workspace
                        // root, so we cannot evaluate them as
                        // workspace-relative paths against the filter.
                        // The denylist patterns are filename-shaped
                        // (`.env`, `*.pem`, `id_rsa*`, etc.) — match
                        // against the bare filename so a secret file
                        // in `~/projects/other-repo/.env` doesn't leak
                        // into completion. Per Step 4 in
                        // `arc/dev-atoms.md`.
                        if self.secret_filter.is_secret(name) {
                            continue;
                        }
                        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
                        let full_path = if parent_dir == "/" {
                            format!("/{name}")
                        } else {
                            format!("{parent_dir}/{name}")
                        };
                        entries.push(if is_dir {
                            format!("{full_path}/")
                        } else {
                            full_path
                        });
                    }
                }
            }
        }

        entries.sort();
        entries.truncate(MAX_RESULTS);

        FileTreeSnapshot {
            query: query.to_string(),
            results: entries
                .into_iter()
                .map(|path| {
                    let is_dir = path.ends_with('/');
                    ScoredResult {
                        path,
                        score: 0,
                        matches: vec![],
                        is_dir,
                    }
                })
                .collect(),
            truncated: self.truncated,
        }
    }

    /// Empty query: return root-level entries (no `/` except a
    /// directory's trailing marker).
    fn empty_query(&self) -> FileTreeSnapshot {
        let results: Vec<ScoredResult> = self
            .files
            .iter()
            .filter(|p| !p.trim_end_matches('/').contains('/'))
            .take(MAX_RESULTS)
            .map(|p| ScoredResult {
                path: p.clone(),
                score: 0,
                matches: vec![],
                is_dir: p.ends_with('/'),
            })
            .collect();

        FileTreeSnapshot {
            query: String::new(),
            results,
            truncated: self.truncated,
        }
    }

    /// Normal scored query: pre-filter + fuzzy score + top N.
    fn scored_query(&self, query: &str) -> FileTreeSnapshot {
        let mut scored: Vec<ScoredResult> = self
            .files
            .iter()
            .filter_map(|path| {
                let m = score_file_path(query, path)?;
                Some(ScoredResult {
                    path: path.clone(),
                    score: m.score,
                    matches: m.matches,
                    is_dir: path.ends_with('/'),
                })
            })
            .collect();

        // Sort by descending score, then ascending path length, then lexicographic.
        scored.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then_with(|| a.path.len().cmp(&b.path.len()))
                .then_with(|| a.path.cmp(&b.path))
        });
        scored.truncate(MAX_RESULTS);

        FileTreeSnapshot {
            query: query.to_string(),
            results: scored,
            truncated: self.truncated,
        }
    }

    /// Serialize and broadcast a response frame.
    ///
    /// Splices `workspace_key` as the first field of the serialized
    /// `FileTreeSnapshot` payload, per [D03]. Publishes to two places:
    ///   - The shared `ft_response_tx` broadcast channel — the
    ///     production path. The router subscribes once at the process
    ///     level, fans out to every connected client; JS filters by
    ///     `workspace_key`.
    ///   - The per-workspace `watch_tx` argument — back-compat with the
    ///     pre-multi-workspace test surface (`test_workspace_key_spliced_into_filetree_frame`
    ///     inspects this watch). The router stopped reading per-workspace
    ///     watches at Step pre-4; this write is now test-only and can
    ///     be removed in a follow-on cleanup.
    fn send_response(
        &self,
        watch_tx: &watch::Sender<Frame>,
        snapshot: &FileTreeSnapshot,
    ) -> Result<(), ()> {
        let json = serde_json::to_vec(snapshot).map_err(|_| ())?;
        let json = splice_workspace_key(&json, &self.workspace_key);
        let frame = Frame::new(FeedId::FILETREE, json.clone());
        // Broadcast first: this is the production path. Send errors
        // (no active subscribers) are non-fatal — clients may not be
        // connected yet (e.g., bootstrap publishes its empty initial
        // snapshot before any client connects). Workspace responses
        // arrive on demand, so missing-subscriber here is the same
        // shape as before.
        let _ = self.ft_response_tx.send(frame.clone());
        // Vestigial: per-workspace watch. Kept for tests.
        watch_tx.send_modify(|f| {
            *f = frame;
        });
        Ok(())
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Off-board query [D10]
    // -----------------------------------------------------------------------

    #[test]
    fn off_board_with_nonexistent_parent_returns_empty() {
        let feed = test_feed(BTreeSet::new());
        let response = feed.off_board_query("/nonexistent_dir_xyz_123/te");
        assert!(response.results.is_empty());
        assert_eq!(response.query, "/nonexistent_dir_xyz_123/te");
    }

    #[test]
    fn off_board_paths_are_absolute() {
        let feed = test_feed(BTreeSet::new());
        // /tmp should exist on macOS/Linux.
        let response = feed.off_board_query("/tmp/");
        for r in &response.results {
            assert!(
                r.path.starts_with('/'),
                "off-board path should be absolute: {}",
                r.path
            );
            assert_eq!(r.score, 0);
            assert!(r.matches.is_empty());
        }
    }

    #[test]
    fn off_board_prefix_filters() {
        // Create a temp dir with known contents.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("test_alpha.txt"), "").unwrap();
        std::fs::write(tmp.path().join("test_beta.txt"), "").unwrap();
        std::fs::write(tmp.path().join("other.txt"), "").unwrap();

        let feed = test_feed(BTreeSet::new());
        let query = format!("{}/test_", tmp.path().display());
        let response = feed.off_board_query(&query);
        assert_eq!(response.results.len(), 2);
        for r in &response.results {
            assert!(r.path.contains("test_"));
        }
    }

    #[test]
    fn off_board_tilde_expansion() {
        let feed = test_feed(BTreeSet::new());
        let response = feed.off_board_query("~/");
        // Should expand ~ to $HOME and list entries.
        // We can't assert specific contents, but it shouldn't panic.
        assert_eq!(response.query, "~/");
    }

    // -----------------------------------------------------------------------
    // Response serialization
    // -----------------------------------------------------------------------

    #[test]
    fn response_serializes_to_spec_s01b() {
        let snapshot = FileTreeSnapshot {
            query: "sms".to_string(),
            results: vec![ScoredResult {
                path: "src/lib/session-metadata-store.ts".to_string(),
                score: 72,
                matches: vec![(0, 1), (8, 9), (17, 18)],
                is_dir: false,
            }],
            truncated: false,
        };
        let json = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(json["query"], "sms");
        assert!(json["results"].is_array());
        assert_eq!(
            json["results"][0]["path"],
            "src/lib/session-metadata-store.ts"
        );
        assert_eq!(json["results"][0]["score"], 72);
        assert_eq!(json["truncated"], false);
    }

    fn test_feed(files: BTreeSet<String>) -> FileTreeFeed {
        let (tx, _) = broadcast::channel(16);
        let (_qtx, qrx) = mpsc::channel(16);
        let (ft_response_tx, _) = broadcast::channel::<Frame>(16);
        FileTreeFeed::new(
            PathBuf::from("/unused-in-this-test"),
            files,
            false,
            tx,
            qrx,
            Arc::from("test-workspace"),
            ft_response_tx,
        )
    }

    // -----------------------------------------------------------------------
    // Secret-file filtering (Step 4: arc/dev-atoms.md#step-4)
    // -----------------------------------------------------------------------

    /// Construct a feed rooted at `workspace_root` with `initial_files`
    /// — exercises the real `SecretFilter` path that production uses.
    fn test_feed_rooted(workspace_root: PathBuf, files: BTreeSet<String>) -> FileTreeFeed {
        let (tx, _) = broadcast::channel(16);
        let (_qtx, qrx) = mpsc::channel(16);
        let (ft_response_tx, _) = broadcast::channel::<Frame>(16);
        FileTreeFeed::new(
            workspace_root,
            files,
            false,
            tx,
            qrx,
            Arc::from("test-workspace"),
            ft_response_tx,
        )
    }

    #[test]
    fn initial_files_sweep_drops_secrets() {
        let tmp = tempfile::tempdir().unwrap();
        let mut files = BTreeSet::new();
        files.insert("src/main.rs".to_string());
        files.insert(".env".to_string());
        files.insert(".env.local".to_string());
        files.insert("README.md".to_string());
        files.insert("server.pem".to_string());
        files.insert("id_rsa".to_string());

        let feed = test_feed_rooted(tmp.path().to_path_buf(), files);
        // Empty query should return root-level non-secret files only.
        let response = feed.empty_query();
        let paths: Vec<&str> = response.results.iter().map(|r| r.path.as_str()).collect();
        assert!(paths.contains(&"README.md"));
        assert!(!paths.contains(&".env"));
        assert!(!paths.contains(&".env.local"));
        assert!(!paths.contains(&"server.pem"));
        assert!(!paths.contains(&"id_rsa"));
    }

    #[test]
    fn scored_query_excludes_secret_matches() {
        let tmp = tempfile::tempdir().unwrap();
        let mut files = BTreeSet::new();
        files.insert(".env".to_string());
        files.insert("envoy.yaml".to_string());
        files.insert("environment.ts".to_string());

        let feed = test_feed_rooted(tmp.path().to_path_buf(), files);
        let response = feed.scored_query("env");
        let paths: Vec<&str> = response.results.iter().map(|r| r.path.as_str()).collect();
        // `.env` is denylisted; `envoy.yaml` and `environment.ts` are ordinary.
        assert!(!paths.contains(&".env"));
        assert!(paths.contains(&"envoy.yaml"));
        assert!(paths.contains(&"environment.ts"));
    }

    #[test]
    fn tugattachignore_excludes_user_patterns_from_query() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join(".tugattachignore"),
            "local-secrets/\n*.draft\n",
        )
        .unwrap();

        let mut files = BTreeSet::new();
        files.insert("src/main.rs".to_string());
        files.insert("local-secrets/api.txt".to_string());
        files.insert("notes.draft".to_string());
        files.insert("notes.md".to_string());
        files.insert(".env".to_string());

        let feed = test_feed_rooted(tmp.path().to_path_buf(), files);
        let response = feed.scored_query("notes");
        let paths: Vec<&str> = response.results.iter().map(|r| r.path.as_str()).collect();
        assert!(paths.contains(&"notes.md"));
        assert!(!paths.contains(&"notes.draft"));

        // Built-in still fires alongside the user patterns.
        let env_response = feed.scored_query("env");
        let env_paths: Vec<&str> = env_response
            .results
            .iter()
            .map(|r| r.path.as_str())
            .collect();
        assert!(!env_paths.contains(&".env"));

        // User-pattern directory match excludes children.
        let local_response = feed.scored_query("api");
        let local_paths: Vec<&str> = local_response
            .results
            .iter()
            .map(|r| r.path.as_str())
            .collect();
        assert!(!local_paths.contains(&"local-secrets/api.txt"));
    }

    #[test]
    fn apply_events_skips_secret_creations() {
        let tmp = tempfile::tempdir().unwrap();
        let mut feed = test_feed_rooted(tmp.path().to_path_buf(), BTreeSet::new());
        feed.apply_events(&[
            FsEvent::Created {
                path: "src/lib.rs".to_string(),
            },
            FsEvent::Created {
                path: ".env".to_string(),
            },
            FsEvent::Created {
                path: "config/api.pem".to_string(),
            },
        ]);
        let response = feed.empty_query();
        let paths: Vec<&str> = response.results.iter().map(|r| r.path.as_str()).collect();
        // Root-level lib.rs is not present (the only root-level file
        // would have to lack `/`); `src/lib.rs` is nested. Confirm
        // `.env` did NOT enter the set even though the create event
        // was applied — by scoring with `env` we'd see it if it
        // leaked.
        assert!(!paths.contains(&".env"));
        let scored = feed.scored_query("api");
        let scored_paths: Vec<&str> = scored.results.iter().map(|r| r.path.as_str()).collect();
        assert!(!scored_paths.contains(&"config/api.pem"));
    }

    #[test]
    fn off_board_query_filters_secret_filenames() {
        // Synthesize a temp dir containing one ordinary file and one
        // denylisted file, then off-board-query its absolute path. The
        // feed itself can be rooted anywhere — off-board reads bypass
        // the workspace BTreeSet.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("ordinary.txt"), "").unwrap();
        std::fs::write(tmp.path().join(".env"), "").unwrap();
        std::fs::write(tmp.path().join("server.pem"), "").unwrap();

        let feed = test_feed_rooted(tmp.path().to_path_buf(), BTreeSet::new());
        let query = format!("{}/", tmp.path().display());
        let response = feed.off_board_query(&query);
        let names: Vec<&str> = response
            .results
            .iter()
            .filter_map(|r| r.path.rsplit('/').next())
            .collect();
        assert!(names.contains(&"ordinary.txt"));
        assert!(!names.contains(&".env"));
        assert!(!names.contains(&"server.pem"));
    }

    // -----------------------------------------------------------------------
    // Directory entries
    // -----------------------------------------------------------------------

    #[test]
    fn empty_query_includes_root_level_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let mut files = BTreeSet::new();
        files.insert("README.md".to_string());
        files.insert("src/".to_string());
        files.insert("src/main.rs".to_string());

        let feed = test_feed_rooted(tmp.path().to_path_buf(), files);
        let response = feed.empty_query();
        let paths: Vec<&str> = response.results.iter().map(|r| r.path.as_str()).collect();
        assert!(paths.contains(&"README.md"));
        assert!(
            paths.contains(&"src/"),
            "root-level dir belongs in empty query"
        );
        assert!(
            !paths.contains(&"src/main.rs"),
            "nested file is not root-level"
        );
        let dir = response.results.iter().find(|r| r.path == "src/").unwrap();
        assert!(dir.is_dir);
        let file = response
            .results
            .iter()
            .find(|r| r.path == "README.md")
            .unwrap();
        assert!(!file.is_dir);
    }

    #[test]
    fn scored_query_matches_directories_by_basename() {
        let tmp = tempfile::tempdir().unwrap();
        let mut files = BTreeSet::new();
        files.insert("arc/".to_string());
        files.insert("arc/dev-atoms.md".to_string());

        let feed = test_feed_rooted(tmp.path().to_path_buf(), files);
        let response = feed.scored_query("arc");
        let dir = response
            .results
            .iter()
            .find(|r| r.path == "arc/")
            .expect("directory should match its own name");
        assert!(dir.is_dir);
    }

    #[test]
    fn tugattachignore_directory_pattern_excludes_the_directory_entry() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(".tugattachignore"), "local-secrets/\n").unwrap();

        let mut files = BTreeSet::new();
        files.insert("local-secrets/".to_string());
        files.insert("local-secrets/api.txt".to_string());
        files.insert("locale.ts".to_string());

        let feed = test_feed_rooted(tmp.path().to_path_buf(), files);
        let response = feed.scored_query("local");
        let paths: Vec<&str> = response.results.iter().map(|r| r.path.as_str()).collect();
        assert!(paths.contains(&"locale.ts"));
        assert!(
            !paths.contains(&"local-secrets/"),
            "dir entry itself must be filtered"
        );
        assert!(!paths.contains(&"local-secrets/api.txt"));
    }

    #[test]
    fn removed_directory_evicts_children() {
        let tmp = tempfile::tempdir().unwrap();
        let mut files = BTreeSet::new();
        files.insert("src/".to_string());
        files.insert("src/a.rs".to_string());
        files.insert("src/deep/".to_string());
        files.insert("src/deep/b.rs".to_string());
        files.insert("srcfile.rs".to_string());

        let mut feed = test_feed_rooted(tmp.path().to_path_buf(), files);
        feed.apply_events(&[FsEvent::Removed {
            path: "src".to_string(),
        }]);

        let response = feed.scored_query("src");
        let paths: Vec<&str> = response.results.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(paths, vec!["srcfile.rs"], "dir and all children evicted");
    }

    #[test]
    fn created_directory_indexes_with_trailing_slash() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("newdir")).unwrap();

        let mut feed = test_feed_rooted(tmp.path().to_path_buf(), BTreeSet::new());
        feed.apply_events(&[FsEvent::Created {
            path: "newdir".to_string(),
        }]);

        let response = feed.empty_query();
        let dir = response
            .results
            .iter()
            .find(|r| r.path == "newdir/")
            .expect("created dir should index in trailing-slash form");
        assert!(dir.is_dir);
    }

    /// [L29]: a query naming the workspace root under a different spelling
    /// (here a symlinked parent, the shape `/u` → `/Users/…/Mounts/u` takes
    /// on a real machine) must not read as a new root. A raw comparison
    /// retargets, drops `watcher_aligned`, and freezes the index at that
    /// instant — every file created afterwards silently stops completing.
    #[test]
    fn symlinked_spelling_of_the_same_root_does_not_retarget() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        // Root the feed at the symlinked spelling, the way a tugcast
        // launched with `--source-tree /u/src/tugtool` is rooted.
        let mut feed = test_feed_rooted(link.clone(), BTreeSet::new());
        feed.files.insert("arc/plan.md".to_string());
        assert!(feed.watcher_aligned);

        // The card sends the canonical spelling the server handed it.
        feed.handle_query(&FileTreeQuery {
            query: "plan.md".to_string(),
            root: Some(real.clone()),
        });

        assert!(
            feed.watcher_aligned,
            "same directory under two spellings must stay watcher-aligned",
        );
        assert!(
            feed.files.contains("arc/plan.md"),
            "index must survive — a retarget would re-walk the empty dir",
        );
    }

    /// The retarget path still fires for a genuinely different directory:
    /// canonicalizing the comparison must not disable [D09].
    #[test]
    fn genuinely_different_root_still_retargets() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        std::fs::create_dir(&a).unwrap();
        std::fs::create_dir(&b).unwrap();
        std::fs::write(b.join("beta.txt"), "").unwrap();

        let mut feed = test_feed_rooted(a, BTreeSet::new());
        let response = feed.handle_query(&FileTreeQuery {
            query: "beta".to_string(),
            root: Some(b),
        });

        assert!(!feed.watcher_aligned, "a foreign root unaligns the watcher");
        assert_eq!(
            response.results.first().map(|r| r.path.as_str()),
            Some("beta.txt"),
            "retarget must re-walk into the new root",
        );
    }

    /// W1: FileTreeFeed splices `workspace_key` as the first field of every
    /// emitted frame, including the initial empty snapshot published at the
    /// start of `run()`.
    #[tokio::test]
    async fn test_workspace_key_spliced_into_filetree_frame() {
        // Synthetic label — this test drives the feed without touching the
        // real filesystem, so workspace_key is a pure string label.
        let fixture_key: Arc<str> = Arc::from("test-workspace");

        let (event_tx, _) = broadcast::channel(16);
        let (_qtx, qrx) = mpsc::channel(16);
        let (ft_response_tx, _) = broadcast::channel::<Frame>(16);
        let feed = FileTreeFeed::new(
            PathBuf::from("/unused-in-this-test"),
            BTreeSet::new(),
            false,
            event_tx,
            qrx,
            fixture_key.clone(),
            ft_response_tx,
        );

        let (watch_tx, mut watch_rx) = watch::channel(Frame::new(FeedId::FILETREE, vec![]));
        let cancel = CancellationToken::new();
        let feed_cancel = cancel.clone();
        let feed_task = tokio::spawn(async move {
            Box::new(feed).run(watch_tx, feed_cancel).await;
        });

        // The initial snapshot is published as the first action of run().
        watch_rx.changed().await.unwrap();
        let frame = watch_rx.borrow_and_update().clone();

        // Field ordering check is done on the raw bytes because
        // `serde_json::Value` normalizes object key order (BTreeMap).
        let expected_prefix = format!(r#"{{"workspace_key":"{}","#, fixture_key);
        assert!(
            frame.payload.starts_with(expected_prefix.as_bytes()),
            "workspace_key must be the first field of FILETREE frames; got: {}",
            String::from_utf8_lossy(&frame.payload)
        );
        let parsed: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(parsed["workspace_key"], fixture_key.as_ref());

        cancel.cancel();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), feed_task).await;
    }
}
