//! Workspace registry — per-project feed bundle owner.
//!
//! A `WorkspaceEntry` owns one canonicalized project's FileWatcher,
//! FilesystemFeed, FileTreeFeed, and ChangesetFeed, plus the watch receivers main.rs
//! wires into the router. The `WorkspaceRegistry` deduplicates entries by
//! canonicalized path so concurrent callers asking for the same workspace
//! share a single feed bundle.
//!
//! W1 scope: bootstrap-only. `main.rs` calls `get_or_create` exactly once for
//! the startup `--source-tree` (formerly `--dir`). W2 adds per-session
//! `get_or_create` calls from `AgentSupervisor::spawn_session_worker` and
//! introduces `release()`.
//!
//! Multi-workspace registry: W1 bootstrap path, W2 per-session `get_or_create` + `release`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use thiserror::Error;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tugcast_core::protocol::{FeedId, Frame};
use tugcast_core::spawn_snapshot_feed;

use crate::feeds::file_watcher::FileWatcher;
use crate::feeds::filesystem::FilesystemFeed;
use crate::feeds::filetree::{FileTreeFeed, FileTreeQuery};
use crate::path_resolver::PathResolver;

/// Errors from [`WorkspaceRegistry`] operations.
///
/// W1 returned infallible `Arc<WorkspaceEntry>` because the bootstrap path
/// was the only caller and the underlying operations (canonicalize + spawn)
/// are infallible by construction. W2 introduces two real failure modes:
/// user-supplied `project_dir` paths that do not resolve to a directory
/// ([`InvalidProjectDir`]), and `release` calls on a key that is not in
/// the map ([`UnknownKey`], typically a double-close race).
///
/// [`InvalidProjectDir`]: WorkspaceError::InvalidProjectDir
/// [`UnknownKey`]: WorkspaceError::UnknownKey
#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("invalid project directory {path:?}: {reason}")]
    InvalidProjectDir { path: PathBuf, reason: &'static str },

    /// Returned from `WorkspaceRegistry::release` when the key is not
    /// present in the map. Unused in production until the supervisor's
    /// close/reset handlers are wired into `release`; exercised by
    /// `test_release_unknown_key_returns_error` in the meantime.
    #[allow(dead_code)]
    #[error("unknown workspace key: {0}")]
    UnknownKey(String),
}

/// Canonical workspace identifier — wraps an `Arc<str>` so clones are cheap
/// and the same canonical path hashes/compares equal across instances.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct WorkspaceKey(Arc<str>);

impl WorkspaceKey {
    /// Obtain a cheap `Arc<str>` handle — used by feed constructors that take `workspace_key`.
    pub fn arc(&self) -> Arc<str> {
        Arc::clone(&self.0)
    }

    /// Construct a `WorkspaceKey` directly from a string. Crate-visible so
    /// `agent_supervisor::tests` can build synthetic ledger entries without
    /// going through `WorkspaceRegistry::get_or_create` (which requires a
    /// real directory + runs the canonicalizer).
    #[cfg(test)]
    pub(crate) fn from_test_str(s: &str) -> Self {
        Self(Arc::from(s))
    }

    /// Adopt an already-canonicalized key string persisted elsewhere —
    /// specifically the `workspace_key` column on a `sessions` ledger row,
    /// which `record_spawn` wrote from this same `WorkspaceKey` when the
    /// session first bound. `rebind_from_ledger` uses this to rebuild its
    /// in-memory entries without re-running `canonical_key` (whose
    /// `std::fs::metadata` + `canonicalize` would `stat` every historical
    /// project directory on boot — enough to trip a macOS TCC prompt for any
    /// dir under Desktop / Documents / Downloads or reached via a firmlink).
    /// The caller is responsible for the string already being canonical; this
    /// performs no filesystem access.
    pub(crate) fn from_canonical(key: &str) -> Self {
        Self(Arc::from(key))
    }
}

impl AsRef<str> for WorkspaceKey {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

/// Owner of one workspace's feed bundle.
///
/// Exposes the same surface `main.rs` wires into the router today:
/// the three watch receivers, the FILETREE query sender, and the four spawned
/// task handles; see module-level docs for the workspace bundle contract.
pub struct WorkspaceEntry {
    /// Canonical key — also the map key in `WorkspaceRegistry`. Read by
    /// `AgentSupervisor::do_spawn_session` to build the `LedgerEntry`
    /// binding and by `do_close_session` / `rebind_from_tugbank` to call
    /// `release`. Production now reads this field, so the W1
    /// `#[allow(dead_code)]` annotation has been removed.
    pub workspace_key: WorkspaceKey,
    /// Original (pre-canonicalized) path input to `get_or_create`. Read in
    /// production by `WorkspaceRegistry::project_dirs()` — the enumeration the
    /// account-global `ChangesetAllFeed` composes over — and used as the
    /// `git init` target for the non-repo "Initialize git" affordance.
    pub project_dir: PathBuf,
    /// Router watch receivers.
    pub fs_watch_rx: watch::Receiver<Frame>,
    /// Bootstrap workspace's FILETREE response watch — kept on the
    /// registered snapshot list in `main.rs` because its initial empty
    /// `FileTreeSnapshot` is what unblocks a brand-new session card's
    /// `feedData.size > 0` gate (the broadcast channel carries no
    /// retained history, so a client connecting after the initial
    /// publish would otherwise see no FILETREE frame until a query
    /// is sent). Per-card workspace entries also carry this field —
    /// it's unread for them but cheap to keep symmetrical with the
    /// bootstrap.
    pub ft_watch_rx: watch::Receiver<Frame>,
    /// FILETREE_QUERY input for the adapter in main.rs.
    pub ft_query_tx: mpsc::Sender<FileTreeQuery>,
    /// Spawned task handles. Retained so tests can assert `!is_finished()`
    /// and so W2 teardown can abort/join them when `release()` lands.
    #[allow(dead_code)]
    pub file_watcher_task: JoinHandle<()>,
    #[allow(dead_code)]
    pub filesystem_task: JoinHandle<()>,
    #[allow(dead_code)]
    pub filetree_task: JoinHandle<()>,
    /// Event-driven git watch (FSEvents) — drives the changeset recompute and
    /// the GIT_HEAD signal off real filesystem events, replacing the aggregate
    /// feed's poll for this workspace.
    #[allow(dead_code)]
    pub git_watch_task: JoinHandle<()>,
    /// Cancellation token owned by this entry. Cloned into each spawned
    /// task at construction; `release` fires it when the refcount hits
    /// zero so the tasks exit cleanly. Retained on the struct
    /// (rather than only cloned into tasks) so `release` has something
    /// to fire without needing to reach into the tasks themselves.
    ///
    /// Read only by `WorkspaceRegistry::release` (and tests). Production
    /// callers do not use it until the supervisor is wired into
    /// `release`, hence the allow.
    #[allow(dead_code)]
    pub cancel: CancellationToken,
    /// Outstanding session count for this workspace. Bumped by
    /// `get_or_create` on a cache hit, decremented by `release`, and
    /// drives the teardown transition when it reaches zero. All mutations
    /// happen while the `WorkspaceRegistry::inner` mutex is held, so
    /// `Relaxed` ordering is sufficient — the atomic is belt-and-suspenders
    /// for visibility, not for cross-thread correctness ([D08]).
    pub ref_count: AtomicUsize,
    /// True when every holder of this entry acquired it only to browse the
    /// directory — the Open Quickly fallback root and its directory switcher,
    /// which need an index and a watcher but are not opening a *project*.
    ///
    /// Browse-only entries are filtered out of [`WorkspaceRegistry::project_dirs`],
    /// so they never reach the account-global changeset aggregate. Without the
    /// filter, the first ⇧⌘O on an empty deck would make `~/tug` appear in the
    /// Changes card — and, since it is usually not a repository, appear there
    /// wearing an "Initialize git" affordance. Browsing must not mutate the
    /// Changes view.
    ///
    /// The flag is one-way: a session `get_or_create` on the same directory
    /// clears it permanently, because a real project binding outranks a browse
    /// hold and the entry must show up in the aggregate from then on. Mutated
    /// only under the `WorkspaceRegistry::inner` mutex, so `Relaxed` suffices.
    pub browse_only: AtomicBool,
}

impl WorkspaceEntry {
    /// Construct a workspace entry — creates the filesystem + filetree feeds
    /// and spawns their tasks. Synchronous (does not `.await`), so it is safe
    /// to call while holding `WorkspaceRegistry::inner`'s std Mutex.
    ///
    /// Feed constructors take `workspace_key` via `workspace_key.arc()`. The
    /// two watch channels are initialized with empty-payload frames, matching
    /// `main.rs` bootstrap — seeding is not needed because the tugcast router
    /// strips empty-payload frames from the LIVE-state initial snapshot send
    /// (see `router.rs`). Changeset state is no longer per-workspace: the
    /// account-global `ChangesetAllFeed` composes every open project.
    #[allow(clippy::too_many_arguments)]
    fn new(
        project_dir: PathBuf,
        workspace_key: WorkspaceKey,
        parent_cancel: CancellationToken,
        ft_response_tx: tokio::sync::broadcast::Sender<Frame>,
        changeset_all_bump: Arc<tokio::sync::Notify>,
        gh_response_tx: tokio::sync::broadcast::Sender<Frame>,
        browse_only: bool,
    ) -> Arc<Self> {
        // Derive a per-entry child cancel token. Firing this child tears
        // down just this workspace's tasks; the parent (process-wide)
        // cancel still propagates into the child for orderly shutdown.
        // Without the child, `release` would fire the shared parent
        // token and cancel *every* workspace's tasks at once — which
        // matters when multiple workspaces coexist.
        let cancel = parent_cancel.child_token();

        let file_watcher = FileWatcher::new(project_dir.clone());
        let fs_broadcast_tx = FileWatcher::create_sender();

        // Walk before the FileWatcher task consumes `file_watcher`.
        let (initial_files, ft_truncated) = file_watcher.walk();

        // The GIT_HEAD baseline, then the OS watch — in that order, and both
        // here rather than inside the tasks below. A commit is only reported
        // when it lands after the watch is armed AND differs from the
        // baseline, so anything that arms or baselines late swallows the move
        // outright. Doing both synchronously means every write that follows
        // this constructor is reportable; a spawned task that starts late
        // costs nothing, because the events queue.
        let baseline_head = crate::feeds::git_watch::read_head_blocking(&project_dir);
        let armed_watch = file_watcher.arm();

        // FILETREE query channel.
        let (ft_query_tx, ft_query_rx) = mpsc::channel::<FileTreeQuery>(16);

        // Watch channels — empty payload, same as today's main.rs.
        let (fs_watch_tx, fs_watch_rx) = watch::channel(Frame::new(FeedId::FILESYSTEM, vec![]));
        let (ft_watch_tx, ft_watch_rx) = watch::channel(Frame::new(FeedId::FILETREE, vec![]));

        // Construct feeds — pass `workspace_key.arc()` as a cheap Arc<str>
        // clone per [D02].
        let fs_feed = FilesystemFeed::new(
            project_dir.clone(),
            fs_broadcast_tx.clone(),
            workspace_key.arc(),
        );
        let ft_feed = FileTreeFeed::new(
            project_dir.clone(),
            initial_files,
            ft_truncated,
            fs_broadcast_tx.clone(),
            ft_query_rx,
            workspace_key.arc(),
            ft_response_tx,
        );

        // The git watch is a plain subscriber to this workspace's one
        // FileWatcher stream (not a second OS watch) — take its receiver before
        // the sender moves into the watcher task.
        let git_fs_rx = fs_broadcast_tx.subscribe();

        // Spawn the watcher task directly (it is an event source, not a
        // router feed) and the snapshot feeds through the trait helper —
        // the one way a SnapshotFeed gets its task.
        let fw_cancel = cancel.clone();
        let file_watcher_task = tokio::spawn(async move {
            if let Some(armed) = armed_watch {
                file_watcher
                    .run_armed(armed, fs_broadcast_tx, fw_cancel)
                    .await;
            }
        });

        let filesystem_task = spawn_snapshot_feed(Box::new(fs_feed), fs_watch_tx, cancel.clone());
        let filetree_task = spawn_snapshot_feed(Box::new(ft_feed), ft_watch_tx, cancel.clone());

        // Event-driven git reactions: ride the FileWatcher batches to drive the
        // changeset recompute (`bump`) and the GIT_HEAD signal on HEAD moves —
        // no poll, no extra watcher.
        let gw_cancel = cancel.clone();
        let gw_dir = project_dir.clone();
        let gw_key = workspace_key.arc().to_string();
        let git_watch_task = tokio::spawn(crate::feeds::git_watch::run_git_workspace_watch(
            gw_dir,
            gw_key,
            baseline_head,
            changeset_all_bump,
            gh_response_tx,
            git_fs_rx,
            gw_cancel,
        ));

        Arc::new(Self {
            workspace_key,
            project_dir,
            fs_watch_rx,
            ft_watch_rx,
            ft_query_tx,
            file_watcher_task,
            filesystem_task,
            filetree_task,
            git_watch_task,
            cancel,
            ref_count: AtomicUsize::new(1),
            browse_only: AtomicBool::new(browse_only),
        })
    }
}

/// Dedup registry of workspace entries keyed by canonical path.
///
/// W2 introduces refcounting: `get_or_create` bumps an entry's `ref_count`
/// on a cache hit, and `release` decrements it, tearing the entry down
/// when the count reaches zero. All mutations happen under the held
/// `inner` mutex, which serializes the check-construct-insert and the
/// read-decrement-teardown sequences — two threads cannot race to both
/// construct the same workspace, nor can one thread decrement to zero
/// while another is bumping the same entry.
pub struct WorkspaceRegistry {
    /// The std Mutex is held across the check-construct-insert sequence
    /// and across the `release` decrement so that concurrent callers
    /// cannot both miss, both construct, and both insert, orphaning a
    /// set of spawned tasks. `WorkspaceEntry::new` is synchronous and
    /// never `.await`s while holding the lock.
    inner: Mutex<HashMap<WorkspaceKey, Arc<WorkspaceEntry>>>,
    /// Shared FILETREE-response broadcast channel. Cloned into each
    /// `WorkspaceEntry::new` call so every workspace's `FileTreeFeed`
    /// publishes responses to one place. The router subscribes once
    /// at the process level. Per `arc/dev-atoms.md#step-pre-4`.
    ft_response_tx: tokio::sync::broadcast::Sender<Frame>,
    /// Process-global recompute signal for the account-global CHANGESET_ALL
    /// feed. Pinged whenever the open-project set changes (`get_or_create`
    /// inserts a fresh entry, `release` tears one down) so a project's
    /// section appears/disappears immediately rather than waiting out the
    /// aggregate feed's poll backstop. Shared (cloned) with the feed and the
    /// `ChangesetBumper`.
    changeset_all_bump: Arc<tokio::sync::Notify>,
    /// Shared GIT_HEAD-signal broadcast channel. Cloned into each workspace's
    /// git watch, which broadcasts a `GitHeadSignal` when that workspace's HEAD
    /// moves. The router subscribes once at the process level (see `main.rs`).
    gh_response_tx: tokio::sync::broadcast::Sender<Frame>,
    /// Optional "a workspace just opened" signal, carrying the fresh entry's
    /// canonical key. The base-motion engine listens here because a HEAD signal
    /// is an edge and a newly-opened project may already hold an arc whose base
    /// moved while nothing was watching. Set once at boot; unset in tests and in
    /// any build without the engine, where the send is simply skipped.
    workspace_open_tx: OnceLock<mpsc::Sender<String>>,
}

impl WorkspaceRegistry {
    /// Construct a registry. `ft_response_tx` is the shared broadcast
    /// channel into which every workspace's `FileTreeFeed` publishes
    /// its responses; the router subscribes once at the process level
    /// (see `main.rs`). `changeset_all_bump` is the process-global recompute
    /// signal the registry pings when the open-project set changes.
    /// `gh_response_tx` is the shared GIT_HEAD signal channel each workspace's
    /// git watch broadcasts HEAD moves on.
    pub fn new(
        ft_response_tx: tokio::sync::broadcast::Sender<Frame>,
        changeset_all_bump: Arc<tokio::sync::Notify>,
        gh_response_tx: tokio::sync::broadcast::Sender<Frame>,
    ) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            ft_response_tx,
            changeset_all_bump,
            gh_response_tx,
            workspace_open_tx: OnceLock::new(),
        }
    }

    /// Wire the "a workspace just opened" signal. Called once at boot, beside
    /// the base-motion engine that receives it.
    pub fn set_workspace_open_signal(&self, tx: mpsc::Sender<String>) {
        let _ = self.workspace_open_tx.set(tx);
    }

    /// The process-global aggregate-changeset recompute signal, cloned for
    /// the `ChangesetBumper` (which pings it on every file-event write) and
    /// the `ChangesetAllFeed` (which awaits it).
    pub fn changeset_all_bump(&self) -> Arc<tokio::sync::Notify> {
        Arc::clone(&self.changeset_all_bump)
    }

    /// Test-only constructor that creates its own throwaway broadcast
    /// channel. Tests that don't exercise the response path (most of
    /// them — they assert on watch_rx or on routing inputs) shouldn't
    /// have to plumb one in.
    #[cfg(test)]
    pub fn new_for_test() -> Self {
        let (ft_response_tx, _) = tokio::sync::broadcast::channel(16);
        let (gh_response_tx, _) = tokio::sync::broadcast::channel(16);
        Self::new(
            ft_response_tx,
            Arc::new(tokio::sync::Notify::new()),
            gh_response_tx,
        )
    }

    /// Look up or construct the workspace entry for `project_dir`.
    ///
    /// Validates that `project_dir` exists and is a directory via
    /// `std::fs::metadata` before canonicalizing — [`PathResolver::watch_path`]
    /// is infallible by design (returns the original on failure), so
    /// validation has to happen here or nowhere. Paths that do not exist,
    /// cannot be read, or point at a non-directory are rejected with
    /// [`WorkspaceError::InvalidProjectDir`].
    ///
    /// On success, canonicalizes via `PathResolver::watch_path()` so
    /// textually-distinct paths that resolve to the same directory
    /// (macOS firmlinks, symlinks, `..`-components) share a single entry.
    /// If an entry for the canonical key already exists, bumps its
    /// refcount under the held mutex and returns the existing `Arc`. If
    /// not, constructs a fresh entry with `ref_count = 1` and inserts it.
    pub fn get_or_create(
        &self,
        project_dir: &Path,
        cancel: CancellationToken,
    ) -> Result<Arc<WorkspaceEntry>, WorkspaceError> {
        self.acquire(project_dir, cancel, false)
    }

    /// Look up or construct the workspace entry for `project_dir` as a
    /// **browse-only** hold — an index + watcher for a directory the user is
    /// searching (Open Quickly's fallback root and its directory switcher),
    /// not a project they have opened.
    ///
    /// Identical to [`get_or_create`] in every respect except that a freshly
    /// constructed entry is marked [`WorkspaceEntry::browse_only`], which keeps
    /// it out of [`project_dirs`] and therefore out of the changeset aggregate.
    /// Acquiring a directory that a session already holds does **not** demote
    /// it — the flag only ever moves from set to clear.
    ///
    /// Refcounting is shared with the session path: a browse hold and a session
    /// binding on the same directory are two references to one entry, and the
    /// entry survives until both release.
    ///
    /// [`get_or_create`]: WorkspaceRegistry::get_or_create
    /// [`project_dirs`]: WorkspaceRegistry::project_dirs
    pub fn acquire_for_browse(
        &self,
        project_dir: &Path,
        cancel: CancellationToken,
    ) -> Result<Arc<WorkspaceEntry>, WorkspaceError> {
        self.acquire(project_dir, cancel, true)
    }

    fn acquire(
        &self,
        project_dir: &Path,
        cancel: CancellationToken,
        browse_only: bool,
    ) -> Result<Arc<WorkspaceEntry>, WorkspaceError> {
        // 1. Validate existence + directory-ness.
        let metadata =
            std::fs::metadata(project_dir).map_err(|e| WorkspaceError::InvalidProjectDir {
                path: project_dir.to_path_buf(),
                reason: match e.kind() {
                    std::io::ErrorKind::NotFound => "does_not_exist",
                    std::io::ErrorKind::PermissionDenied => "permission_denied",
                    _ => "metadata_error",
                },
            })?;
        if !metadata.is_dir() {
            return Err(WorkspaceError::InvalidProjectDir {
                path: project_dir.to_path_buf(),
                reason: "not_a_directory",
            });
        }

        // 2. Canonicalize.
        let canonical: String = PathResolver::new(project_dir.to_path_buf())
            .watch_path()
            .to_string_lossy()
            .into_owned();
        let workspace_key = WorkspaceKey(Arc::from(canonical));

        // 3. Held-mutex check-or-construct.
        let mut map = self.inner.lock().expect("WorkspaceRegistry mutex poisoned");

        if let Some(existing) = map.get(&workspace_key) {
            existing.ref_count.fetch_add(1, Ordering::Relaxed);
            // A session binding promotes a browse-only entry into the open
            // project set for good; a browse hold never demotes one.
            let promoted = !browse_only && existing.browse_only.swap(false, Ordering::Relaxed);
            let entry = Arc::clone(existing);
            drop(map);
            if promoted {
                self.changeset_all_bump.notify_one();
            }
            return Ok(entry);
        }

        let entry = WorkspaceEntry::new(
            project_dir.to_path_buf(),
            workspace_key.clone(),
            cancel,
            self.ft_response_tx.clone(),
            Arc::clone(&self.changeset_all_bump),
            self.gh_response_tx.clone(),
            browse_only,
        );
        map.insert(workspace_key.clone(), Arc::clone(&entry));
        drop(map);
        // A fresh project joined the open set — recompute the aggregate now
        // so its section shows immediately instead of after the poll. A
        // browse-only entry is not in that set, so it skips the bump.
        if !browse_only {
            self.changeset_all_bump.notify_one();
            // Tell the base-motion engine to sweep this workspace's arcs: the
            // git watch it just started baselined HEAD, so it will never signal
            // about motion that happened before now. A full channel means a
            // sweep is already queued, which covers this workspace too.
            if let Some(tx) = self.workspace_open_tx.get() {
                let _ = tx.try_send(workspace_key.as_ref().to_string());
            }
        }
        Ok(entry)
    }

    /// The `(project_dir, workspace_key)` of every currently-open workspace —
    /// the input the account-global `ChangesetAllFeed` enumerates each
    /// recompute. `project_dir` is the original (pre-canonicalized) path the
    /// entry was created with (used for display and as the `git init` target);
    /// `workspace_key` is the canonical key. Sorted by `project_dir` so the
    /// aggregate frame's project order is stable for diff-suppression.
    ///
    /// Browse-only entries ([`WorkspaceEntry::browse_only`]) are excluded: a
    /// directory the user is searching through Open Quickly is not a project
    /// they have opened, and must not appear in the Changes card.
    pub fn project_dirs(&self) -> Vec<(PathBuf, String)> {
        let map = self.inner.lock().expect("WorkspaceRegistry mutex poisoned");
        let mut dirs: Vec<(PathBuf, String)> = map
            .values()
            .filter(|e| !e.browse_only.load(Ordering::Relaxed))
            .map(|e| (e.project_dir.clone(), e.workspace_key.as_ref().to_string()))
            .collect();
        dirs.sort_by(|a, b| a.0.cmp(&b.0));
        dirs
    }

    /// Look up the workspace entry whose canonical key matches `project_dir`,
    /// without creating one if missing.
    ///
    /// Uses the same canonicalization step as `get_or_create`
    /// ([`PathResolver::watch_path`]) so a textually-distinct input that
    /// resolves to the same directory (`/tmp/files` ↔ `/private/tmp/files`
    /// on macOS, symlinks, `..`-components) finds an existing entry. Does
    /// not validate that `project_dir` exists — callers (the
    /// `FILETREE_QUERY` adapter) pass paths the JS layer believes are
    /// valid, and a missing-directory case should fall through to the
    /// bootstrap fallback rather than synthesize a new registry entry.
    ///
    /// Returns `None` when no entry matches the canonical key — the
    /// caller (`main.rs`'s adapter) treats this as "fall back to
    /// bootstrap" so legacy single-workspace callers continue to work.
    ///
    /// Bumps no refcounts; the returned `Arc` carries its own reference
    /// for the duration of the caller's use. Per
    /// `arc/dev-atoms.md#step-pre-4` and the routing fix that
    /// unblocks Step 4's manual smoke.
    pub fn find_entry_by_path(&self, project_dir: &Path) -> Option<Arc<WorkspaceEntry>> {
        let canonical: String = PathResolver::new(project_dir.to_path_buf())
            .watch_path()
            .to_string_lossy()
            .into_owned();
        let key = WorkspaceKey(Arc::from(canonical));
        let map = self.inner.lock().expect("WorkspaceRegistry mutex poisoned");
        map.get(&key).map(Arc::clone)
    }

    /// Route a single `FileTreeQuery` to the workspace whose canonical
    /// key matches `ftq.root`, falling back to `bootstrap_tx` when the
    /// root is unset or unknown. Per `arc/dev-atoms.md#step-pre-4`
    /// — the FILETREE_QUERY adapter calls this once per inbound frame
    /// after JSON parsing, so the routing decision lives in one
    /// testable place rather than buried in `main.rs`'s spawned task.
    ///
    /// Behavior:
    ///  - `ftq.root = Some(path)` and the registry has a matching
    ///    entry → send to that entry's `ft_query_tx`. On send failure
    ///    (channel closed — workspace torn down mid-flight), log a
    ///    `warn!` and drop the query. Deliberately do *not* fall back
    ///    to bootstrap in this case: a stale workspace's tugtool
    ///    results would be the wrong UX for a card that's already
    ///    been disposed.
    ///  - `ftq.root = Some(path)` but no entry matches → fall through
    ///    to `bootstrap_tx`. The legacy `[D09]` retarget machinery in
    ///    `FileTreeFeed::handle_query` still runs there for callers
    ///    that haven't been updated to use per-card routing.
    ///  - `ftq.root = None` → fall through to `bootstrap_tx`. Single-
    ///    workspace and dev-loop callers continue to work unchanged.
    pub async fn route_filetree_query(
        &self,
        ftq: FileTreeQuery,
        bootstrap_tx: &mpsc::Sender<FileTreeQuery>,
    ) {
        // Resolve the routing target first (returns an owned `Arc`, so
        // it doesn't borrow from `ftq`). This frees `ftq` to be moved
        // into the subsequent `send(...)` call without a borrow
        // conflict against `ftq.root`.
        let target = ftq.root.as_ref().and_then(|p| self.find_entry_by_path(p));
        if let Some(entry) = target {
            // Capture the root for the warn-log up front — `ftq` moves
            // into `send`. `.unwrap_or_default()` is unreachable in
            // practice (target is Some only when root is Some) but
            // keeps the borrow checker happy without an unwrap.
            let root_display = ftq
                .root
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            if let Err(err) = entry.ft_query_tx.send(ftq).await {
                tracing::warn!(
                    root = %root_display,
                    error = %err,
                    "FILETREE_QUERY: matched workspace channel closed",
                );
            }
            return;
        }
        let _ = bootstrap_tx.send(ftq).await;
    }

    /// Resolve the workspace a query feed targets — the generic root → entry,
    /// else bootstrap resolver shared by GIT_DIFF and GIT_LOG.
    ///
    /// Returns the entry whose canonical key matches `root`, or `bootstrap`
    /// when `root` is `None` or matches no registered workspace — the same
    /// fall-back policy as [`route_filetree_query`], so a card bound to a
    /// per-session project reads that project while the dev-loop / unbound
    /// case reads the bootstrap `--source-tree`. Unlike the FILETREE path,
    /// these query feeds have no per-workspace channel; the caller runs the
    /// command against the returned entry's `project_dir` directly.
    pub fn resolve_diff_target(
        &self,
        root: Option<&Path>,
        bootstrap: &Arc<WorkspaceEntry>,
    ) -> Arc<WorkspaceEntry> {
        root.and_then(|p| self.find_entry_by_path(p))
            .unwrap_or_else(|| Arc::clone(bootstrap))
    }

    /// Decrement the refcount for `key` and, if it reaches zero, fire
    /// the entry's cancel token, remove it from the map, and drop the
    /// `Arc<WorkspaceEntry>`. The spawned tasks (file watcher, filesystem,
    /// filetree, git) see the cancel and exit on their own; we don't
    /// join them here — refcount and teardown trigger only, not explicit
    /// task lifetime management.
    ///
    /// Returns [`WorkspaceError::UnknownKey`] if the key is not present
    /// in the map. Callers typically log and ignore this — it indicates
    /// a double-`release` or a `release` without a matching
    /// `get_or_create`, both of which are logic errors in the caller,
    /// not error conditions to propagate.
    ///
    /// Production callers for session teardown are still being wired; unit
    /// tests exercise `release` in the meantime.
    #[allow(dead_code)]
    /// Crate-visible inspection handle for test assertions. The guard
    /// returned is a std::sync::MutexGuard, so `.len()` and other
    /// `HashMap` methods are available on deref. Not for production
    /// callers — they should use `get_or_create` / `release` instead.
    #[cfg(test)]
    pub(crate) fn inner_for_test(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<WorkspaceKey, Arc<WorkspaceEntry>>> {
        self.inner.lock().expect("WorkspaceRegistry mutex poisoned")
    }

    #[allow(dead_code)]
    pub fn release(&self, key: &WorkspaceKey) -> Result<(), WorkspaceError> {
        let mut map = self.inner.lock().expect("WorkspaceRegistry mutex poisoned");
        let Some(entry) = map.get(key) else {
            return Err(WorkspaceError::UnknownKey(key.as_ref().to_string()));
        };
        // `fetch_sub` returns the *previous* value. `prev == 1` means the
        // new count is 0 — time to tear down.
        let prev = entry.ref_count.fetch_sub(1, Ordering::Relaxed);
        if prev == 1 {
            let was_browse_only = entry.browse_only.load(Ordering::Relaxed);
            entry.cancel.cancel();
            map.remove(key);
            // The Arc<WorkspaceEntry> we just removed drops here, and
            // with it the FileWatcher OS handle. Spawned tasks exit on
            // their own as the cancel token propagates.
            drop(map);
            // A project left the open set — recompute the aggregate now so
            // its section drops immediately instead of after the poll. A
            // browse-only entry was never in that set, so it skips the bump.
            if !was_browse_only {
                self.changeset_all_bump.notify_one();
            }
        }
        Ok(())
    }

    /// Remove the named entries outright, **regardless of refcount** — the
    /// teardown half of [`Self::release`]'s zero path (cancel, remove, bump)
    /// without the decrement.
    ///
    /// This is for entries whose `project_dir` no longer exists on disk: a
    /// project deleted out from under an open card holds its refcount forever,
    /// so the refcounted path can never reap it, and until something does the
    /// ghost keeps contributing frames to the aggregate. Keys are the
    /// canonical spellings [`Self::project_dirs`] reports. A key already gone
    /// from the map is skipped silently — a concurrent `release` got there
    /// first, which is the outcome this method wanted anyway.
    pub fn sweep_missing(&self, keys: &[String]) {
        let mut bump = false;
        {
            let mut map = self.inner.lock().expect("WorkspaceRegistry mutex poisoned");
            for key in keys {
                let key = WorkspaceKey::from_canonical(key);
                if let Some(entry) = map.remove(&key) {
                    entry.cancel.cancel();
                    if !entry.browse_only.load(Ordering::Relaxed) {
                        bump = true;
                    }
                }
            }
        }
        // A project left the open set — same recompute `release`'s zero path
        // asks for, once for the whole sweep.
        if bump {
            self.changeset_all_bump.notify_one();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tempfile::TempDir;

    /// Short helper — drain the runtime briefly and drop the registry so
    /// FileWatcher OS handles are released between tests.
    async fn drain_and_drop(registry: WorkspaceRegistry, cancel: CancellationToken) {
        cancel.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            tokio::task::yield_now().await
        })
        .await;
        drop(registry);
    }

    #[tokio::test]
    async fn test_workspace_registry_bootstrap_construction() {
        let dir = TempDir::new().expect("create tempdir");
        let cancel = CancellationToken::new();

        let registry = WorkspaceRegistry::new_for_test();
        let entry = registry
            .get_or_create(dir.path(), cancel.clone())
            .expect("bootstrap tempdir is a valid workspace");

        assert!(!entry.file_watcher_task.is_finished());
        assert!(!entry.filesystem_task.is_finished());
        assert!(!entry.filetree_task.is_finished());
        let key: &str = entry.workspace_key.as_ref();
        assert!(!key.is_empty());
        assert_eq!(
            entry.ref_count.load(Ordering::Relaxed),
            1,
            "fresh entry starts at refcount 1"
        );

        drop(entry);
        drain_and_drop(registry, cancel).await;
    }

    #[tokio::test]
    async fn test_workspace_registry_deduplicates_canonical_paths() {
        let tmp = TempDir::new().expect("create tempdir");
        let cancel = CancellationToken::new();
        let registry = WorkspaceRegistry::new_for_test();

        // Two textually-distinct inputs that canonicalize to the same directory.
        let first = registry
            .get_or_create(tmp.path(), cancel.clone())
            .expect("first get_or_create");
        let indirect = tmp
            .path()
            .join("..")
            .join(tmp.path().file_name().expect("tempdir has name"));
        let second = registry
            .get_or_create(&indirect, cancel.clone())
            .expect("second get_or_create");

        assert!(
            Arc::ptr_eq(&first, &second),
            "dedup failed: registry returned a fresh entry for a path that canonicalizes to the same workspace"
        );

        {
            let map = registry.inner.lock().expect("mutex not poisoned");
            assert_eq!(map.len(), 1, "expected exactly one deduped entry");
        }
        assert_eq!(
            first.ref_count.load(Ordering::Relaxed),
            2,
            "two get_or_create calls must bump refcount to 2"
        );

        drop(first);
        drop(second);
        drain_and_drop(registry, cancel).await;
    }

    #[tokio::test]
    async fn from_canonical_agrees_with_get_or_create() {
        // rebind rebuilds its in-memory entries from the persisted
        // `workspace_key` string via `WorkspaceKey::from_canonical`, never
        // touching the filesystem. The adopted key must equal what
        // `get_or_create` canonicalizes to, so a later re-spawn against the
        // same directory reuses the rebound entry instead of duplicating it.
        let tmp = TempDir::new().expect("create tempdir");
        let cancel = CancellationToken::new();
        let registry = WorkspaceRegistry::new_for_test();

        let entry = registry
            .get_or_create(tmp.path(), cancel.clone())
            .expect("get_or_create");

        // Round-trip the canonical string the way a ledger row does.
        let persisted = entry.workspace_key.as_ref().to_string();
        let adopted = WorkspaceKey::from_canonical(&persisted);
        assert_eq!(
            adopted.as_ref(),
            entry.workspace_key.as_ref(),
            "from_canonical must reproduce get_or_create's key without fs access"
        );
        assert_eq!(
            adopted, entry.workspace_key,
            "the adopted key must hash/compare equal so the entry is reused"
        );

        drop(entry);
        drain_and_drop(registry, cancel).await;
    }

    /// Rebind rebuilds in-memory entries by adopting each ledger row's persisted
    /// `workspace_key` via `from_canonical`, never re-canonicalizing the project
    /// dir. That must hold even for a since-removed directory — so boot never
    /// stats a historical project dir (the `0400ed0f7` no-TCC-prompt property).
    #[test]
    fn rebind_does_not_canonicalize_historical_dirs() {
        let gone = "/Users/nobody/removed-project-xyz-123";
        assert!(
            !std::path::Path::new(gone).exists(),
            "precondition: the path is absent"
        );
        let key = WorkspaceKey::from_canonical(gone);
        assert_eq!(
            key.as_ref(),
            gone,
            "from_canonical adopts the persisted string verbatim, no filesystem access"
        );
    }

    // ---- find_entry_by_path (Step pre-4 routing) ----

    #[tokio::test]
    async fn test_find_entry_by_path_returns_some_for_registered_path() {
        let tmp = TempDir::new().expect("create tempdir");
        let cancel = CancellationToken::new();
        let registry = WorkspaceRegistry::new_for_test();

        let entry = registry
            .get_or_create(tmp.path(), cancel.clone())
            .expect("get_or_create");
        let found = registry.find_entry_by_path(tmp.path()).expect("found");
        assert!(
            Arc::ptr_eq(&entry, &found),
            "find_entry_by_path should return the same Arc as get_or_create",
        );

        drop(entry);
        drop(found);
        drain_and_drop(registry, cancel).await;
    }

    #[tokio::test]
    async fn test_find_entry_by_path_returns_none_for_unknown_path() {
        let tmp = TempDir::new().expect("create tempdir");
        let cancel = CancellationToken::new();
        let registry = WorkspaceRegistry::new_for_test();
        let _entry = registry
            .get_or_create(tmp.path(), cancel.clone())
            .expect("get_or_create");

        // A sibling tempdir that exists but is NOT registered.
        let other = TempDir::new().expect("create sibling tempdir");
        assert!(
            registry.find_entry_by_path(other.path()).is_none(),
            "unregistered path must miss the registry lookup",
        );

        drain_and_drop(registry, cancel).await;
    }

    #[tokio::test]
    async fn test_find_entry_by_path_canonicalizes_input() {
        // The key under which entries are stored is the
        // PathResolver-canonicalized form. A textually-distinct input
        // that canonicalizes to the same directory must still match —
        // this is the macOS /tmp ↔ /private/tmp case that breaks
        // `/tmp/files` lookups without canonicalization.
        let tmp = TempDir::new().expect("create tempdir");
        let cancel = CancellationToken::new();
        let registry = WorkspaceRegistry::new_for_test();
        let entry = registry
            .get_or_create(tmp.path(), cancel.clone())
            .expect("get_or_create");

        let indirect = tmp
            .path()
            .join("..")
            .join(tmp.path().file_name().expect("tempdir has name"));
        let found = registry
            .find_entry_by_path(&indirect)
            .expect("canonicalized lookup must hit");
        assert!(Arc::ptr_eq(&entry, &found));

        drop(entry);
        drop(found);
        drain_and_drop(registry, cancel).await;
    }

    // ---- resolve_diff_target ([#step-10a] /diff routing) ----

    #[tokio::test]
    async fn test_resolve_diff_target_matches_registered_root() {
        let bootstrap_dir = TempDir::new().expect("bootstrap tempdir");
        let card_dir = TempDir::new().expect("card tempdir");
        let cancel = CancellationToken::new();
        let registry = WorkspaceRegistry::new_for_test();

        let bootstrap = registry
            .get_or_create(bootstrap_dir.path(), cancel.clone())
            .expect("bootstrap get_or_create");
        let card = registry
            .get_or_create(card_dir.path(), cancel.clone())
            .expect("card get_or_create");

        let resolved = registry.resolve_diff_target(Some(card_dir.path()), &bootstrap);
        assert!(
            Arc::ptr_eq(&resolved, &card),
            "a known root must resolve to its own workspace, not bootstrap",
        );

        drop(bootstrap);
        drop(card);
        drop(resolved);
        drain_and_drop(registry, cancel).await;
    }

    #[tokio::test]
    async fn test_resolve_diff_target_falls_back_to_bootstrap() {
        let bootstrap_dir = TempDir::new().expect("bootstrap tempdir");
        let cancel = CancellationToken::new();
        let registry = WorkspaceRegistry::new_for_test();
        let bootstrap = registry
            .get_or_create(bootstrap_dir.path(), cancel.clone())
            .expect("bootstrap get_or_create");

        // Unknown root → bootstrap.
        let unknown = TempDir::new().expect("unknown tempdir");
        let by_unknown = registry.resolve_diff_target(Some(unknown.path()), &bootstrap);
        assert!(
            Arc::ptr_eq(&by_unknown, &bootstrap),
            "an unregistered root must fall back to bootstrap",
        );

        // Absent root → bootstrap.
        let by_none = registry.resolve_diff_target(None, &bootstrap);
        assert!(
            Arc::ptr_eq(&by_none, &bootstrap),
            "a missing root must fall back to bootstrap",
        );

        drop(bootstrap);
        drop(by_unknown);
        drop(by_none);
        drain_and_drop(registry, cancel).await;
    }

    // ---- route_filetree_query (Step pre-4 routing) ----
    //
    // Verify each branch of the FILETREE_QUERY adapter logic:
    //   - root matches a registered workspace → arrives at that entry's tx
    //   - root unknown → falls through to bootstrap
    //   - root absent → falls through to bootstrap

    #[tokio::test]
    async fn test_route_filetree_query_routes_to_registered_workspace() {
        let card_dir = TempDir::new().expect("card tempdir");
        let cancel = CancellationToken::new();
        let registry = WorkspaceRegistry::new_for_test();
        let card_entry = registry
            .get_or_create(card_dir.path(), cancel.clone())
            .expect("card workspace");
        // Drain the empty-initial-snapshot the FileTreeFeed sends before
        // the test query so the assertion below sees only the routed
        // query and nothing else queued on the channel.
        // (No drain needed for the *tx* side — we're sending to the feed
        // task's rx; the assertion uses a separate "bootstrap" channel
        // that nobody is reading from.)

        // Standalone bootstrap channel that nobody consumes — receives
        // the fallback path's queries so we can assert it stayed empty.
        let (bootstrap_tx, mut bootstrap_rx) = mpsc::channel::<FileTreeQuery>(8);

        let ftq = FileTreeQuery {
            query: "match-me".to_string(),
            root: Some(card_dir.path().to_path_buf()),
        };
        registry.route_filetree_query(ftq, &bootstrap_tx).await;

        // Bootstrap stayed empty.
        assert!(
            bootstrap_rx.try_recv().is_err(),
            "matched-root query must NOT reach the bootstrap fallback",
        );
        // The card's feed received the query — its initial empty
        // snapshot lives on the watch channel side; the query travels
        // via `ft_query_tx` to its receiver inside the spawned feed
        // task, which we can't directly inspect from here. We can still
        // assert the absence-of-bootstrap-receipt above, which proves
        // the routing decision branched correctly. (The actual feed-
        // side query handling is covered by `filetree::tests`.)

        drop(card_entry);
        drain_and_drop(registry, cancel).await;
    }

    #[tokio::test]
    async fn test_route_filetree_query_falls_back_when_root_unknown() {
        let cancel = CancellationToken::new();
        let registry = WorkspaceRegistry::new_for_test();
        let (bootstrap_tx, mut bootstrap_rx) = mpsc::channel::<FileTreeQuery>(8);

        let ftq = FileTreeQuery {
            query: "anywhere".to_string(),
            root: Some(PathBuf::from("/nonexistent/path/xyz-123")),
        };
        registry.route_filetree_query(ftq, &bootstrap_tx).await;

        let routed = bootstrap_rx
            .try_recv()
            .expect("unmatched root must fall through to bootstrap");
        assert_eq!(routed.query, "anywhere");

        drain_and_drop(registry, cancel).await;
    }

    #[tokio::test]
    async fn test_route_filetree_query_falls_back_when_root_absent() {
        let cancel = CancellationToken::new();
        let registry = WorkspaceRegistry::new_for_test();
        let (bootstrap_tx, mut bootstrap_rx) = mpsc::channel::<FileTreeQuery>(8);

        let ftq = FileTreeQuery {
            query: "bare-query".to_string(),
            root: None,
        };
        registry.route_filetree_query(ftq, &bootstrap_tx).await;

        let routed = bootstrap_rx
            .try_recv()
            .expect("root=None must fall through to bootstrap");
        assert_eq!(routed.query, "bare-query");
        assert!(routed.root.is_none());

        drain_and_drop(registry, cancel).await;
    }

    // ---- Browse-only acquisition ----

    #[tokio::test]
    async fn browse_only_entries_are_hidden_from_project_dirs() {
        let session_dir = TempDir::new().expect("session tempdir");
        let browse_dir = TempDir::new().expect("browse tempdir");
        let cancel = CancellationToken::new();
        let registry = WorkspaceRegistry::new_for_test();

        let session = registry
            .get_or_create(session_dir.path(), cancel.clone())
            .expect("session workspace");
        let browsed = registry
            .acquire_for_browse(browse_dir.path(), cancel.clone())
            .expect("browse workspace");

        assert!(!session.browse_only.load(Ordering::Relaxed));
        assert!(browsed.browse_only.load(Ordering::Relaxed));
        assert_eq!(
            registry.inner_for_test().len(),
            2,
            "both entries live in the registry and route FILETREE queries"
        );

        let dirs = registry.project_dirs();
        assert_eq!(
            dirs.len(),
            1,
            "only the session workspace reaches the changeset aggregate"
        );
        assert_eq!(dirs[0].1, session.workspace_key.as_ref());

        drop(session);
        drop(browsed);
        drain_and_drop(registry, cancel).await;
    }

    #[tokio::test]
    async fn a_browsed_directory_is_still_routable() {
        // The whole point of the full workspace route: a browse hold gets a
        // real entry, so `find_entry_by_path` (and therefore FILETREE query
        // routing) resolves it exactly like a session's project.
        let browse_dir = TempDir::new().expect("browse tempdir");
        let cancel = CancellationToken::new();
        let registry = WorkspaceRegistry::new_for_test();
        let browsed = registry
            .acquire_for_browse(browse_dir.path(), cancel.clone())
            .expect("browse workspace");

        let found = registry
            .find_entry_by_path(browse_dir.path())
            .expect("browse-only entry must still be routable");
        assert!(Arc::ptr_eq(&browsed, &found));

        drop(browsed);
        drop(found);
        drain_and_drop(registry, cancel).await;
    }

    #[tokio::test]
    async fn a_session_binding_promotes_a_browsed_directory_for_good() {
        let dir = TempDir::new().expect("create tempdir");
        let cancel = CancellationToken::new();
        let registry = WorkspaceRegistry::new_for_test();

        let browsed = registry
            .acquire_for_browse(dir.path(), cancel.clone())
            .expect("browse workspace");
        assert!(registry.project_dirs().is_empty());

        // A session opens the same directory: one entry, two refs, visible.
        let session = registry
            .get_or_create(dir.path(), cancel.clone())
            .expect("session workspace");
        assert!(Arc::ptr_eq(&browsed, &session));
        assert_eq!(session.ref_count.load(Ordering::Relaxed), 2);
        assert_eq!(registry.project_dirs().len(), 1);

        // A later browse hold must not demote it back out of the aggregate.
        let browsed_again = registry
            .acquire_for_browse(dir.path(), cancel.clone())
            .expect("second browse hold");
        assert_eq!(
            registry.project_dirs().len(),
            1,
            "browse-only is one-way: a re-browse never hides an open project"
        );

        drop(browsed);
        drop(session);
        drop(browsed_again);
        drain_and_drop(registry, cancel).await;
    }

    #[tokio::test]
    async fn releasing_a_browse_hold_tears_the_entry_down() {
        let dir = TempDir::new().expect("create tempdir");
        let cancel = CancellationToken::new();
        let registry = WorkspaceRegistry::new_for_test();

        let browsed = registry
            .acquire_for_browse(dir.path(), cancel.clone())
            .expect("browse workspace");
        let key = browsed.workspace_key.clone();
        let entry_cancel = browsed.cancel.clone();
        drop(browsed);

        registry.release(&key).expect("release to zero");
        assert_eq!(registry.inner_for_test().len(), 0);
        assert!(entry_cancel.is_cancelled());

        drain_and_drop(registry, cancel).await;
    }

    #[tokio::test]
    async fn acquire_for_browse_rejects_a_missing_directory() {
        let cancel = CancellationToken::new();
        let registry = WorkspaceRegistry::new_for_test();
        let result = registry.acquire_for_browse(
            Path::new("/nonexistent/browse-target-xyz-123"),
            cancel.clone(),
        );
        match result {
            Ok(_) => panic!("expected InvalidProjectDir"),
            Err(WorkspaceError::InvalidProjectDir { reason, .. }) => {
                assert_eq!(reason, "does_not_exist");
            }
            Err(other) => panic!("expected InvalidProjectDir, got {other:?}"),
        }
        drain_and_drop(registry, cancel).await;
    }

    // ---- Refcount + release ----

    #[tokio::test]
    async fn test_get_or_create_bumps_existing_refcount() {
        let tmp = TempDir::new().expect("create tempdir");
        let cancel = CancellationToken::new();
        let registry = WorkspaceRegistry::new_for_test();

        let first = registry
            .get_or_create(tmp.path(), cancel.clone())
            .expect("first");
        let second = registry
            .get_or_create(tmp.path(), cancel.clone())
            .expect("second");

        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(first.ref_count.load(Ordering::Relaxed), 2);
        {
            let map = registry.inner.lock().expect("mutex");
            assert_eq!(map.len(), 1);
        }

        drop(first);
        drop(second);
        drain_and_drop(registry, cancel).await;
    }

    #[tokio::test]
    async fn test_release_decrements_refcount() {
        let tmp = TempDir::new().expect("create tempdir");
        let cancel = CancellationToken::new();
        let registry = WorkspaceRegistry::new_for_test();

        let first = registry
            .get_or_create(tmp.path(), cancel.clone())
            .expect("first");
        let _second = registry
            .get_or_create(tmp.path(), cancel.clone())
            .expect("second");
        assert_eq!(first.ref_count.load(Ordering::Relaxed), 2);

        let key = first.workspace_key.clone();
        registry.release(&key).expect("first release");
        assert_eq!(first.ref_count.load(Ordering::Relaxed), 1);
        {
            let map = registry.inner.lock().expect("mutex");
            assert_eq!(map.len(), 1, "entry still present after first release");
        }

        drop(first);
        drop(_second);
        drain_and_drop(registry, cancel).await;
    }

    #[tokio::test]
    async fn test_release_triggers_teardown_at_zero() {
        let tmp = TempDir::new().expect("create tempdir");
        let cancel = CancellationToken::new();
        let registry = WorkspaceRegistry::new_for_test();

        let entry = registry
            .get_or_create(tmp.path(), cancel.clone())
            .expect("get_or_create");
        let key = entry.workspace_key.clone();
        // Grab the entry's own cancel token to observe the teardown signal
        // separately from the test-level cancel we pass in.
        let entry_cancel = entry.cancel.clone();
        drop(entry);

        registry.release(&key).expect("release to zero");
        {
            let map = registry.inner.lock().expect("mutex");
            assert_eq!(
                map.len(),
                0,
                "entry removed from map after refcount hit zero"
            );
        }
        assert!(
            entry_cancel.is_cancelled(),
            "release fires the entry's cancel token when refcount hits zero"
        );

        drain_and_drop(registry, cancel).await;
    }

    #[tokio::test]
    async fn test_release_unknown_key_returns_error() {
        let registry = WorkspaceRegistry::new_for_test();
        let bogus_key = WorkspaceKey(Arc::from("/nonexistent/canonical/path"));
        let err = registry.release(&bogus_key).unwrap_err();
        match err {
            WorkspaceError::UnknownKey(s) => {
                assert_eq!(s, "/nonexistent/canonical/path");
            }
            other => panic!("expected UnknownKey, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_get_or_create_rejects_nonexistent_path() {
        let cancel = CancellationToken::new();
        let registry = WorkspaceRegistry::new_for_test();
        let result = registry.get_or_create(
            Path::new("/nonexistent/workspace-registry-test-xyz"),
            cancel.clone(),
        );
        match result {
            Ok(_) => panic!("expected InvalidProjectDir"),
            Err(WorkspaceError::InvalidProjectDir { reason, path }) => {
                assert_eq!(reason, "does_not_exist");
                assert_eq!(
                    path,
                    PathBuf::from("/nonexistent/workspace-registry-test-xyz")
                );
            }
            Err(other) => panic!("expected InvalidProjectDir, got {other:?}"),
        }
        drain_and_drop(registry, cancel).await;
    }

    #[tokio::test]
    async fn test_get_or_create_rejects_file_path() {
        let tmp = TempDir::new().expect("create tempdir");
        let file_path = tmp.path().join("regular-file.txt");
        std::fs::write(&file_path, b"not a directory").expect("write file");

        let cancel = CancellationToken::new();
        let registry = WorkspaceRegistry::new_for_test();
        let result = registry.get_or_create(&file_path, cancel.clone());
        match result {
            Ok(_) => panic!("expected InvalidProjectDir"),
            Err(WorkspaceError::InvalidProjectDir { reason, .. }) => {
                assert_eq!(reason, "not_a_directory");
            }
            Err(other) => panic!("expected InvalidProjectDir, got {other:?}"),
        }
        drain_and_drop(registry, cancel).await;
    }

    #[tokio::test]
    async fn test_concurrent_get_or_create_serializes_construction() {
        // Two tasks race to get_or_create on the same path. The held-mutex
        // check-or-construct must guarantee exactly one construction: both
        // tasks return the same Arc, the map holds one entry, and the
        // refcount is 2.
        let tmp = TempDir::new().expect("create tempdir");
        let cancel = CancellationToken::new();
        let registry = Arc::new(WorkspaceRegistry::new_for_test());

        let path_a = tmp.path().to_path_buf();
        let path_b = tmp.path().to_path_buf();
        let reg_a = Arc::clone(&registry);
        let reg_b = Arc::clone(&registry);
        let cancel_a = cancel.clone();
        let cancel_b = cancel.clone();

        let t_a = tokio::task::spawn_blocking(move || {
            reg_a.get_or_create(&path_a, cancel_a).expect("race a")
        });
        let t_b = tokio::task::spawn_blocking(move || {
            reg_b.get_or_create(&path_b, cancel_b).expect("race b")
        });
        let entry_a = t_a.await.expect("join a");
        let entry_b = t_b.await.expect("join b");

        assert!(
            Arc::ptr_eq(&entry_a, &entry_b),
            "held-mutex must serialize construction; both tasks must observe the same Arc"
        );
        assert_eq!(entry_a.ref_count.load(Ordering::Relaxed), 2);
        {
            let map = registry.inner.lock().expect("mutex");
            assert_eq!(map.len(), 1);
        }

        drop(entry_a);
        drop(entry_b);
        // Can't `drop(registry)` on an Arc<WorkspaceRegistry> directly, but
        // the Arcs taken by the tasks are already released. Cancel + yield
        // lets the background tasks wind down.
        cancel.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            tokio::task::yield_now().await
        })
        .await;
    }
}
