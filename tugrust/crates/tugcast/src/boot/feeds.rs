//! `boot::feeds` — every feed, channel and query adapter the supervisor and
//! the router are built from.
//!
//! Two entry points, because the feed work is not contiguous in startup.
//! [`streams`] builds the session-scoped streams and the terminal feed, which
//! today come before tugbank and the ledgers open; [`feeds`] builds the rest
//! once the ledgers are up. Moving the first down to join the second would
//! reorder startup.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::{broadcast, mpsc, watch};
use tokio_util::sync::CancellationToken;
use tracing::warn;
use tugcast_core::{FeedId, Frame};
use tugcore::instance as tug_instance;

use crate::boot::Ledgers;
use crate::cli;
use crate::control;
use crate::dev::{self, SharedDevState};
use crate::feeds;
use crate::feeds::filetree::FileTreeQuery;
use crate::feeds::session_scoped::SessionScopedFeed;
use crate::feeds::terminal::TerminalFeed;
use crate::feeds::workspace_registry::{WorkspaceEntry, WorkspaceRegistry};
use crate::router::{BROADCAST_CAPACITY, LagPolicy};

/// The session-scoped streams, the terminal feed, and the bootstrap watch
/// directory — the feeds built before the ledgers open.
pub(crate) struct Streams {
    pub(crate) code_output_feed: SessionScopedFeed,
    /// The supervisor dispatcher's end of CODE_INPUT, fed by the relay.
    pub(crate) code_input_tx: mpsc::Sender<Frame>,
    pub(crate) code_input_rx: mpsc::Receiver<Frame>,
    /// Every CODE_INPUT frame, teed by the relay for the bridges that tap it.
    pub(crate) code_submission_tx: broadcast::Sender<Frame>,
    /// The router's CODE_INPUT sink: the relay's input.
    pub(crate) code_input_relay_tx: mpsc::Sender<Frame>,
    pub(crate) shell_output_feed: SessionScopedFeed,
    pub(crate) shell_input_tx: mpsc::Sender<Frame>,
    pub(crate) shell_input_rx: mpsc::Receiver<Frame>,
    pub(crate) refs_output_feed: SessionScopedFeed,
    pub(crate) refs_input_tx: mpsc::Sender<Frame>,
    pub(crate) refs_input_rx: mpsc::Receiver<Frame>,
    pub(crate) terminal_feed: TerminalFeed,
    /// TERMINAL_INPUT and TERMINAL_RESIZE's sink.
    pub(crate) terminal_input_tx: mpsc::Sender<Frame>,
    /// The bootstrap workspace's directory, absolute.
    pub(crate) watch_dir: PathBuf,
}

/// Build CODE_OUTPUT and the CODE_INPUT relay, SHELL and REFS, the terminal
/// feed, and resolve the bootstrap watch directory.
pub(crate) fn streams(cli: &cli::Cli) -> Streams {
    // Create the CODE_OUTPUT feed. The lag-recovery replay buffer lives
    // on the handle (P4): every frame published through it is buffered,
    // shared across sessions per [D06]; the tugdeck-side filter provides
    // isolation on replay per [D11].
    let code_output_feed = SessionScopedFeed::new(
        FeedId::CODE_OUTPUT,
        feeds::code::CODE_BROADCAST_CAPACITY,
        LagPolicy::Replay(crate::router::ReplayBuffer::new(1000)),
    );
    let (code_input_tx, code_input_rx) = mpsc::channel(256);

    // CODE_INPUT relay: the router's registered sink is the relay sender; the
    // relay tees every frame to the session synopsis's submission broadcast
    // before forwarding it verbatim to the supervisor's dispatcher. The relay
    // channel matches the dispatcher channel's capacity — a hop, not a buffer
    // cliff.
    let (code_submission_tx, _) = broadcast::channel::<Frame>(64);
    let (code_input_relay_tx, code_input_relay_rx) = mpsc::channel::<Frame>(256);
    tokio::spawn(feeds::digest_bridge::relay_code_input(
        code_input_relay_rx,
        code_submission_tx.clone(),
        code_input_tx.clone(),
    ));

    // SHELL feed — the `$` route's block-oriented shell execution. SHELL_OUTPUT
    // is a session-scoped broadcast (exchange frames tagged by tug_session_id);
    // SHELL_INPUT flows to the shell dispatcher (spawned by the supervisor
    // stage), which owns one pipe-mode shell child per session.
    let shell_output_feed = SessionScopedFeed::new(
        FeedId::SHELL_OUTPUT,
        feeds::shell::SHELL_BROADCAST_CAPACITY,
        LagPolicy::Warn,
    );
    let (shell_input_tx, shell_input_rx) = mpsc::channel(256);

    // REFS feed — the `/match` and `/search` commands. REFS_OUTPUT streams a
    // run's result rows to the card that asked; REFS_INPUT flows to the refs
    // dispatcher (spawned by the supervisor stage), which runs one search at
    // a time per session.
    let refs_output_feed = SessionScopedFeed::new(
        FeedId::REFS_OUTPUT,
        feeds::refs::REFS_BROADCAST_CAPACITY,
        LagPolicy::Warn,
    );
    let (refs_input_tx, refs_input_rx) = mpsc::channel(256);

    // Create terminal feed. Its broadcast channel is created — and its
    // task spawned — by `register_stream_feed` in the supervisor stage; only
    // the input sender is needed ahead of registration.
    let terminal_feed = TerminalFeed::new(cli.session.clone());
    let terminal_input_tx = terminal_feed.input_sender();

    // Make the watch directory absolute. PathResolver inside FileWatcher
    // handles all further resolution (symlinks, synthetic firmlinks, APFS
    // firmlinks, Linux bind mounts).
    //
    // Note: `cli.source_tree` is the transitional CLI flag name (formerly
    // `--dir`). Internally we still call the bootstrap-watched directory
    // `watch_dir` because that's what it is semantically — the Cargo walk
    // at T3.0.W3.b deletes the bootstrap entirely when the Session card lands
    // a per-card project picker.
    let watch_dir = match cli.source_tree.clone() {
        Some(p) if p.is_absolute() => p,
        Some(p) => std::env::current_dir().unwrap_or_default().join(p),
        None => {
            // Distributed app: no project is bound at startup. The bootstrap
            // workspace exists only to emit the initial empty feed snapshots
            // an unbound Session card renders against; per-card workspaces drive
            // every real feed directory at card-open time. Watch an empty
            // per-instance directory so nothing meaningful is observed.
            let dir = tug_instance::data_dir().join("bootstrap-empty");
            crate::ensure_data_dir(&dir);
            dir
        }
    };

    Streams {
        code_output_feed,
        code_input_tx,
        code_input_rx,
        code_submission_tx,
        code_input_relay_tx,
        shell_output_feed,
        shell_input_tx,
        shell_input_rx,
        refs_output_feed,
        refs_input_tx,
        refs_input_rx,
        terminal_feed,
        terminal_input_tx,
        watch_dir,
    }
}

/// Everything the supervisor stage wires into the supervisor and the router.
pub(crate) struct Feeds {
    pub(crate) streams: Streams,
    /// DEFAULTS, when tugbank opened.
    pub(crate) defaults_rx: Option<watch::Receiver<Frame>>,
    /// The process-wide token every background task runs under.
    pub(crate) cancel: CancellationToken,
    pub(crate) ft_response_tx: broadcast::Sender<Frame>,
    pub(crate) fs_event_tx: broadcast::Sender<Frame>,
    pub(crate) file_watch_tx: broadcast::Sender<Frame>,
    pub(crate) file_watch_input_tx: mpsc::Sender<Frame>,
    pub(crate) gd_response_tx: broadcast::Sender<Frame>,
    pub(crate) gl_response_tx: broadcast::Sender<Frame>,
    pub(crate) gh_response_tx: broadcast::Sender<Frame>,
    pub(crate) gcf_response_tx: broadcast::Sender<Frame>,
    pub(crate) usage_response_tx: broadcast::Sender<Frame>,
    /// The CHANGESET_ALL recompute signal.
    pub(crate) changeset_all_bump: Arc<tokio::sync::Notify>,
    pub(crate) registry: Arc<WorkspaceRegistry>,
    pub(crate) bootstrap: Arc<WorkspaceEntry>,
    pub(crate) ft_input_tx: mpsc::Sender<Frame>,
    pub(crate) gd_input_tx: mpsc::Sender<Frame>,
    pub(crate) gl_input_tx: mpsc::Sender<Frame>,
    pub(crate) gcf_input_tx: mpsc::Sender<Frame>,
    pub(crate) usage_input_tx: mpsc::Sender<Frame>,
    /// The router's handle on the shutdown channel.
    pub(crate) shutdown_tx: mpsc::Sender<u8>,
    pub(crate) shutdown_rx: mpsc::Receiver<u8>,
    /// The control socket's handle on the shutdown channel.
    pub(crate) ctl_shutdown_tx: mpsc::Sender<u8>,
    /// Client-bound CONTROL frames.
    pub(crate) client_action_tx: broadcast::Sender<Frame>,
    pub(crate) shared_dev_state: SharedDevState,
    pub(crate) control_writer: Option<control::ControlWriter>,
    pub(crate) control_reader: Option<control::ControlReader>,
    pub(crate) tugcode_path: PathBuf,
    pub(crate) session_state_feed: SessionScopedFeed,
    pub(crate) session_sideband_feed: SessionScopedFeed,
    pub(crate) activity_feed: SessionScopedFeed,
}

/// Build DEFAULTS, the shared response channels, the file-watch service, the
/// workspace registry and its bootstrap entry, the five query adapters, the
/// shutdown and CONTROL channels, the control socket's halves, the tugbank
/// notification listener, and the supervisor's session feeds — then refuse
/// to go on without tugbank.
pub(crate) fn feeds(
    cli: &cli::Cli,
    bank_path: &Path,
    control_socket: Option<control::ControlSocket>,
    ledgers: &Ledgers,
    streams: Streams,
) -> Feeds {
    let bank_client = &ledgers.bank_client;
    let ledger = &ledgers.ledger;

    // Create DEFAULTS feed from the TugbankClient.
    let defaults_rx: Option<watch::Receiver<Frame>> = bank_client
        .as_ref()
        .map(|client| feeds::defaults::defaults_feed(Arc::clone(client)));

    // Shared cancellation token for the process. Declared before the
    // WorkspaceRegistry call because `get_or_create` needs a clone to hand
    // to the feed tasks it spawns internally.
    let cancel = CancellationToken::new();

    // Shared FILETREE-response broadcast channel. Every workspace's
    // `FileTreeFeed` publishes responses here; the router subscribes
    // once (via `add_broadcast_senders`) and fans out to every
    // connected client. JS-side filtering by `workspace_key` routes the
    // response to the right card. Buffer of 64 frames is comfortable
    // for FILETREE traffic (one frame per typed character, deduplicated
    // by JS) — a Lagged slow client drops some completions but doesn't
    // crash. Per `arc/dev-atoms.md#step-pre-4`.
    let (ft_response_tx, _) = broadcast::channel::<Frame>(64);

    // The one FILESYSTEM stream, shared by every workspace. It replaces a
    // per-workspace `watch` channel of which only the bootstrap entry's was
    // ever registered: every other project's events reached nobody, and two
    // batches between forwarder wakeups coalesced into one even for that
    // one. A broadcast carries every frame, each naming its own
    // `workspace_key`, and says so when a client falls behind.
    let (fs_event_tx, _) = broadcast::channel::<Frame>(256);

    // The per-file watch pair (FILE_WATCH 0x13 / FILE_WATCH_QUERY 0x14).
    // One service for the process: a Text card watches whatever file it has
    // open, wherever that file lives, and the workspace FILESYSTEM feed
    // stops being the only way a card hears about disk. Frames are
    // broadcast to every client and filtered client-side by path, the same
    // shape `ft_response_tx` uses.
    let (file_watch_tx, _) = broadcast::channel::<Frame>(256);
    let (file_watch_service, file_watch_input_tx) =
        feeds::file_watch::FileWatchService::new(file_watch_tx.clone());
    tokio::spawn(file_watch_service.run(cancel.clone()));

    // Shared GIT_DIFF-response broadcast channel ([#step-10a]). The
    // GIT_DIFF_QUERY adapter (below) publishes one single-shot
    // `GitDiffSnapshot` here per `/diff` request; the router fans it out to
    // every client and JS filters by `request_id` + `workspace_key`. A small
    // buffer suffices — `/diff` is a user-initiated, infrequent action.
    let (gd_response_tx, _) = broadcast::channel::<Frame>(16);

    // Shared GIT_LOG-response broadcast channel. The GIT_LOG_QUERY adapter
    // (below) publishes one single-shot `GitLogSnapshot` here per Git History
    // request; the router fans it out to every client and JS filters by
    // `request_id`. A small buffer suffices — history is refreshed on mount and
    // followed-project change, not per keystroke.
    let (gl_response_tx, _) = broadcast::channel::<Frame>(16);

    // Shared GIT_HEAD-signal broadcast channel. Each workspace's event-driven
    // git watch broadcasts a `GitHeadSignal` here when that workspace's HEAD
    // moves (commit/checkout/reset, from any source); the router fans it out and
    // the git-history client re-requests its log. Cloned into the registry.
    let (gh_response_tx, _) = broadcast::channel::<Frame>(16);

    // Shared GIT_COMMIT_FILES-response broadcast channel. The
    // GIT_COMMIT_FILES_QUERY adapter (below) publishes one single-shot
    // `GitCommitFilesSnapshot` here per History-row expand; the router fans it
    // out and JS filters by `request_id`. User-initiated and infrequent (one
    // per commit expand), so a small buffer suffices.
    let (gcf_response_tx, _) = broadcast::channel::<Frame>(16);

    // Shared USAGE-response broadcast channel. The USAGE_QUERY adapter (below)
    // publishes one single-shot `UsageSnapshot` here per `/usage` request; the
    // router fans it out and JS filters by `request_id`. Account-global (one
    // `claude -p "/usage"` per request, no workspace scoping), user-initiated
    // and infrequent, so a small buffer suffices.
    let (usage_response_tx, _) = broadcast::channel::<Frame>(16);

    // Create the bootstrap WorkspaceRegistry. In W1 this holds exactly one
    // entry (the startup `--source-tree`); W2 adds per-session `get_or_create`
    // calls from AgentSupervisor::spawn_session_worker. The registry owns
    // the FileWatcher, FilesystemFeed, FileTreeFeed, and GitFeed plus their
    // spawned tasks — see feeds/workspace_registry.rs and roadmap T3.0.W1.
    // Process-global recompute signal for the account-global CHANGESET_ALL
    // feed. Created before the registry so the registry can ping it on
    // open/close and the aggregate feed (built by the supervisor stage) can
    // await it. Shared with the attribution `ChangesetBumper` so a file-event
    // write in any open project recomputes the aggregate.
    let changeset_all_bump = Arc::new(tokio::sync::Notify::new());

    // The ledger is the source of truth for sessions; wire it to publish a
    // "sessions changed" signal on the recompute bump so the account-global
    // changeset aggregate — a delegate — reflects every session-lifecycle write
    // event-drively (the source-side twin of the registry's project bump).
    ledger.set_change_signal(Arc::clone(&changeset_all_bump));

    let registry = Arc::new(WorkspaceRegistry::new(
        ft_response_tx.clone(),
        Arc::clone(&changeset_all_bump),
        gh_response_tx.clone(),
        fs_event_tx.clone(),
    ));
    let bootstrap = registry
        .get_or_create(&streams.watch_dir, cancel.clone())
        .expect("bootstrap workspace must be a valid directory");

    // Adapter: router sends raw Frames on FILETREE_QUERY; parse JSON into
    // FileTreeQuery and forward to the workspace's FileTreeFeed.
    //
    // Routing strategy (`arc/dev-atoms.md#step-pre-4`): if the JS payload
    // carries a `root` field that resolves to a registered workspace, send
    // to that workspace's `ft_query_tx`. Otherwise fall back to the
    // bootstrap (the `--source-tree` workspace) — preserves single-workspace
    // behavior for legacy callers and the dev-loop case where no per-card
    // session has registered a project yet. A `root` that does not match
    // any registered workspace falls through to bootstrap as a defensive
    // default (the legacy `[D09]` retarget machinery still works there).
    let (ft_input_tx, mut ft_input_rx) = mpsc::channel::<Frame>(16);
    let ft_adapter_registry = Arc::clone(&registry);
    let bootstrap_ft_query_tx = bootstrap.ft_query_tx.clone();
    tokio::spawn(async move {
        while let Some(frame) = ft_input_rx.recv().await {
            #[derive(serde::Deserialize)]
            struct RawQuery {
                query: String,
                root: Option<String>,
            }
            match serde_json::from_slice::<RawQuery>(&frame.payload) {
                Ok(raw) => {
                    let ftq = FileTreeQuery {
                        query: raw.query,
                        root: raw.root.map(PathBuf::from),
                    };
                    ft_adapter_registry
                        .route_filetree_query(ftq, &bootstrap_ft_query_tx)
                        .await;
                }
                Err(e) => {
                    warn!(
                        error = %e,
                        payload_len = frame.payload.len(),
                        "FILETREE_QUERY: malformed JSON payload"
                    );
                }
            }
        }
    });

    // Adapter: router sends raw Frames on GIT_DIFF_QUERY ([#step-10a]). Parse
    // `{root, requestId}`, resolve the workspace the diff belongs to (the
    // card's project dir — the Z4B chip's dir — falling back to bootstrap
    // exactly like the FILETREE adapter), then run a single `git diff HEAD`
    // there and broadcast the `GitDiffSnapshot` on GIT_DIFF. Each request is
    // serviced in its own task so a slow git invocation for one card never
    // head-of-line-blocks another's `/diff`.
    let (gd_input_tx, mut gd_input_rx) = mpsc::channel::<Frame>(16);
    let gd_registry = Arc::clone(&registry);
    let gd_bootstrap = Arc::clone(&bootstrap);
    let gd_response_tx_loop = gd_response_tx.clone();
    tokio::spawn(async move {
        #[derive(serde::Deserialize)]
        struct RawDiffQuery {
            root: Option<String>,
            #[serde(rename = "requestId")]
            request_id: Option<String>,
            /// Optional repo-relative pathspec — the changeset card scopes
            /// its diff to one file or one changeset. Absent/empty keeps
            /// the whole diff. Read by every flavor: the head flavor's
            /// whole-tree diff, the commit flavor's per-file receipt rows,
            /// and the arc range flavor's per-file and per-directory
            /// pop-outs ([P01]). Absent or empty is the whole diff in each.
            paths: Option<Vec<String>>,
            /// Arc range flavor ([P19]): a present `branch` selects
            /// `<base>...<branch>` + worktree dirt instead of `git diff HEAD`.
            /// `worktree` is the arc worktree path relative to the resolved
            /// project dir; `base` the arc's base branch.
            worktree: Option<String>,
            base: Option<String>,
            branch: Option<String>,
            /// Commit flavor ([P08]): a present `sha` selects the diff of one
            /// commit against its first parent — the `/commit` receipt's
            /// expandable file rows.
            sha: Option<String>,
        }
        while let Some(frame) = gd_input_rx.recv().await {
            let raw = match serde_json::from_slice::<RawDiffQuery>(&frame.payload) {
                Ok(raw) => raw,
                Err(e) => {
                    warn!(
                        error = %e,
                        payload_len = frame.payload.len(),
                        "GIT_DIFF_QUERY: malformed JSON payload"
                    );
                    continue;
                }
            };
            let root_pb = raw.root.map(PathBuf::from);
            let entry = gd_registry.resolve_diff_target(root_pb.as_deref(), &gd_bootstrap);
            let request_id = raw.request_id.unwrap_or_default();
            let paths = raw.paths.unwrap_or_default();
            let branch = raw.branch;
            let base = raw.base;
            let worktree = raw.worktree;
            let sha = raw.sha;
            let response_tx = gd_response_tx_loop.clone();
            tokio::spawn(async move {
                // A present `sha` routes to the commit flavor; a present
                // `branch` to the arc range flavor; otherwise the head flavor
                // (today's `git diff HEAD`, whole tree or pathspec-scoped).
                let snapshot = if let Some(sha) = sha {
                    crate::feeds::git::build_commit_diff_snapshot(
                        &entry.project_dir,
                        request_id,
                        entry.workspace_key.as_ref(),
                        &sha,
                        &paths,
                    )
                    .await
                } else {
                    match branch {
                        Some(branch) => {
                            crate::feeds::git::build_arc_diff_snapshot(
                                &entry.project_dir,
                                request_id,
                                entry.workspace_key.as_ref(),
                                worktree.as_deref().unwrap_or_default(),
                                base.as_deref().unwrap_or("main"),
                                &branch,
                                &paths,
                            )
                            .await
                        }
                        None => {
                            crate::feeds::git::build_git_diff_snapshot(
                                &entry.project_dir,
                                request_id,
                                entry.workspace_key.as_ref(),
                                &paths,
                            )
                            .await
                        }
                    }
                };
                match serde_json::to_vec(&snapshot) {
                    Ok(json) => {
                        let _ = response_tx.send(Frame::new(FeedId::GIT_DIFF, json));
                    }
                    Err(e) => {
                        warn!(error = %e, "GIT_DIFF: failed to serialize response");
                    }
                }
            });
        }
    });

    // Adapter: router sends raw Frames on GIT_LOG_QUERY. Parse `{root,
    // requestId, offset, limit}`, then run one `git log` there and broadcast the
    // `GitLogSnapshot` on GIT_LOG. Each request runs in its own task so a slow
    // git invocation never head-of-line-blocks another card's history; the
    // response is a broadcast every client sees, so correlation is entirely
    // client-side by `request_id`.
    //
    // Unlike GIT_DIFF, an explicit valid `root` is read DIRECTLY — no bootstrap
    // fallback. A read-only log needs only the path, and a followed card's
    // workspace may not be registered yet on restore (the resume spawn lands
    // after the binding); falling back to bootstrap would show the wrong repo.
    // The `workspace_key` is the canonical path (the same key a registered
    // workspace carries), so a later GIT_HEAD from that workspace's watch
    // correlates. Only an absent/invalid `root` (the dev-loop) uses bootstrap.
    let (gl_input_tx, mut gl_input_rx) = mpsc::channel::<Frame>(16);
    let gl_bootstrap = Arc::clone(&bootstrap);
    let gl_response_tx_loop = gl_response_tx.clone();
    tokio::spawn(async move {
        #[derive(serde::Deserialize)]
        struct RawLogQuery {
            root: Option<String>,
            #[serde(rename = "requestId")]
            request_id: Option<String>,
            /// How many commits back from HEAD this page starts. Absent ⇒ the
            /// first page.
            offset: Option<u32>,
            limit: Option<u32>,
        }
        while let Some(frame) = gl_input_rx.recv().await {
            let raw = match serde_json::from_slice::<RawLogQuery>(&frame.payload) {
                Ok(raw) => raw,
                Err(e) => {
                    warn!(
                        error = %e,
                        payload_len = frame.payload.len(),
                        "GIT_LOG_QUERY: malformed JSON payload"
                    );
                    continue;
                }
            };
            let root_pb = raw.root.map(PathBuf::from);
            let (project_dir, workspace_key) = match root_pb {
                Some(root) if root.is_dir() => {
                    // Canonical identity through the one gateway ([canonical-path
                    // -identity]) — the same key a registered workspace and its
                    // git watch carry, so a later GIT_HEAD correlates, and never a
                    // second ad-hoc canonicalization that could drift from it.
                    let key = crate::path_resolver::CanonicalPath::from_raw(&root)
                        .as_str()
                        .to_string();
                    (root, key)
                }
                _ => (
                    gl_bootstrap.project_dir.clone(),
                    gl_bootstrap.workspace_key.as_ref().to_string(),
                ),
            };
            let request_id = raw.request_id.unwrap_or_default();
            let offset = raw.offset.unwrap_or(0);
            // The ceiling is a page size, not a history depth — a client walks
            // as deep as it likes by paging, so this only bounds one round
            // trip. It is roomy enough for the one request that is legitimately
            // not a page: a HEAD-moved refresh re-reads everything the client
            // has already scrolled through, in one shot, so the list never
            // shrinks under the reader.
            let limit = raw.limit.unwrap_or(20).clamp(1, 1000);
            let response_tx = gl_response_tx_loop.clone();
            tokio::spawn(async move {
                let snapshot = crate::feeds::git::build_git_log_snapshot(
                    &project_dir,
                    request_id,
                    &workspace_key,
                    offset,
                    limit,
                )
                .await;
                match serde_json::to_vec(&snapshot) {
                    Ok(json) => {
                        let _ = response_tx.send(Frame::new(FeedId::GIT_LOG, json));
                    }
                    Err(e) => {
                        warn!(error = %e, "GIT_LOG: failed to serialize response");
                    }
                }
            });
        }
    });

    // Adapter: router sends raw Frames on GIT_COMMIT_FILES_QUERY. Parse `{root,
    // requestId, sha}`, then run `git show --numstat/--name-status` there and
    // broadcast the `GitCommitFilesSnapshot` on GIT_COMMIT_FILES. Each request
    // runs in its own task; the response is a broadcast every client sees, so
    // correlation is entirely client-side by `request_id`. Root resolution
    // mirrors GIT_LOG_QUERY: a valid `root` is read directly (no bootstrap
    // fallback — a followed card's workspace may not be registered yet on
    // restore), only an absent/invalid `root` uses bootstrap.
    let (gcf_input_tx, mut gcf_input_rx) = mpsc::channel::<Frame>(16);
    let gcf_bootstrap = Arc::clone(&bootstrap);
    let gcf_response_tx_loop = gcf_response_tx.clone();
    tokio::spawn(async move {
        #[derive(serde::Deserialize)]
        struct RawCommitFilesQuery {
            root: Option<String>,
            #[serde(rename = "requestId")]
            request_id: Option<String>,
            sha: Option<String>,
        }
        while let Some(frame) = gcf_input_rx.recv().await {
            let raw = match serde_json::from_slice::<RawCommitFilesQuery>(&frame.payload) {
                Ok(raw) => raw,
                Err(e) => {
                    warn!(
                        error = %e,
                        payload_len = frame.payload.len(),
                        "GIT_COMMIT_FILES_QUERY: malformed JSON payload"
                    );
                    continue;
                }
            };
            let root_pb = raw.root.map(PathBuf::from);
            let (project_dir, workspace_key) = match root_pb {
                Some(root) if root.is_dir() => {
                    let key = crate::path_resolver::CanonicalPath::from_raw(&root)
                        .as_str()
                        .to_string();
                    (root, key)
                }
                _ => (
                    gcf_bootstrap.project_dir.clone(),
                    gcf_bootstrap.workspace_key.as_ref().to_string(),
                ),
            };
            let request_id = raw.request_id.unwrap_or_default();
            let sha = raw.sha.unwrap_or_default();
            let response_tx = gcf_response_tx_loop.clone();
            tokio::spawn(async move {
                let snapshot = crate::feeds::git::build_commit_files_snapshot(
                    &project_dir,
                    request_id,
                    &workspace_key,
                    &sha,
                )
                .await;
                match serde_json::to_vec(&snapshot) {
                    Ok(json) => {
                        let _ = response_tx.send(Frame::new(FeedId::GIT_COMMIT_FILES, json));
                    }
                    Err(e) => {
                        warn!(error = %e, "GIT_COMMIT_FILES: failed to serialize response");
                    }
                }
            });
        }
    });

    // Adapter: router sends raw Frames on USAGE_QUERY. Parse `{requestId}`, run
    // one `claude -p "/usage"` (account-global — no workspace resolution), and
    // broadcast the `UsageSnapshot` on USAGE. Each request runs in its own task
    // so a slow `claude` invocation never head-of-line-blocks another card's
    // `/usage`.
    let (usage_input_tx, mut usage_input_rx) = mpsc::channel::<Frame>(16);
    let usage_response_tx_loop = usage_response_tx.clone();
    tokio::spawn(async move {
        #[derive(serde::Deserialize)]
        struct RawUsageQuery {
            #[serde(rename = "requestId")]
            request_id: Option<String>,
        }
        while let Some(frame) = usage_input_rx.recv().await {
            let request_id = serde_json::from_slice::<RawUsageQuery>(&frame.payload)
                .ok()
                .and_then(|r| r.request_id)
                .unwrap_or_default();
            let response_tx = usage_response_tx_loop.clone();
            tokio::spawn(async move {
                // Probe the login alongside the panel so the sheet can say
                // whose usage it is showing; the probe is local and fast, so
                // running it concurrently costs the fetch nothing.
                let ((ok, text, error), auth) = tokio::join!(
                    crate::feeds::claude_usage::fetch_usage_text(),
                    crate::feeds::claude_auth::probe(),
                );
                let account = match auth {
                    crate::feeds::claude_auth::AuthState::LoggedIn(info) => {
                        Some(tugcast_core::types::UsageAccount {
                            email: info.email,
                            subscription_type: info.subscription_type,
                        })
                    }
                    _ => None,
                };
                let snapshot = tugcast_core::types::UsageSnapshot {
                    request_id,
                    ok,
                    text,
                    error,
                    account,
                };
                match serde_json::to_vec(&snapshot) {
                    Ok(json) => {
                        let _ = response_tx.send(Frame::new(FeedId::USAGE, json));
                    }
                    Err(e) => {
                        warn!(error = %e, "USAGE: failed to serialize response");
                    }
                }
            });
        }
    });

    // Create shutdown channel for control commands
    let (shutdown_tx, shutdown_rx) = mpsc::channel::<u8>(1);

    // Create broadcast channel for client-bound Control frames
    let (client_action_tx, _) = broadcast::channel(BROADCAST_CAPACITY);

    // Create shared dev state (empty until runtime dev_mode control message)
    let shared_dev_state = dev::new_shared_dev_state();

    // Clone shutdown sender for control socket recv loop
    let ctl_shutdown_tx = shutdown_tx.clone();

    // Split control socket into reader and writer halves
    let mut control_writer: Option<control::ControlWriter> = None;
    let control_reader: Option<control::ControlReader> = if let Some(cs) = control_socket {
        let (writer, reader) = cs.split();
        control_writer = Some(writer);
        Some(reader)
    } else {
        None
    };

    // Start the tugbank notification socket listener.
    // Receives domain-change datagrams and calls refresh_domain() with debounce.
    if let Some(client) = bank_client {
        let notify_client = Arc::clone(client);
        let notify_cancel = cancel.clone();
        let notify_path = ledgers.notify_socket_path.clone();
        tokio::spawn(async move {
            crate::run_notify_listener(notify_path, notify_client, notify_cancel).await;
        });
    }

    // Resolve tugcode path for the supervisor's default spawner factory.
    let tugcode_path = feeds::agent_bridge::resolve_tugcode_path(cli.tugcode_path.as_deref());
    if !tugcode_path.exists() {
        panic!(
            "tugcode not found at {} — tugcode is required for tugcast to run",
            tugcode_path.display()
        );
    }

    // The multi-session supervisor's feeds. SESSION_STATE is a
    // SessionScopedFeed (created here, registered with the router by the
    // supervisor stage); SESSION_SIDEBAND's broadcast channel is created
    // here and registered there. The supervisor publishes CONTROL error
    // frames onto the same broadcast that `register_stream` wires for
    // FeedId::CONTROL so clients observe them in-band.
    let session_state_feed =
        SessionScopedFeed::new(FeedId::SESSION_STATE, BROADCAST_CAPACITY, LagPolicy::Warn);
    let session_sideband_feed = SessionScopedFeed::new(
        FeedId::SESSION_SIDEBAND,
        BROADCAST_CAPACITY,
        LagPolicy::Warn,
    );
    // ACTIVITY ([P16] byte 0x42) — a native SessionScopedFeed ([P14]). The
    // supervisor's merger diverts tugcode's `activity_delta` frames onto it
    // ([P13]); the OS subtree sampler (a later step) publishes gauge samples
    // through the same handle. `LagPolicy::Warn` per [P17]: the deck wants
    // the sample stream, and a dropped low-volume bin self-heals.
    let activity_feed =
        SessionScopedFeed::new(FeedId::ACTIVITY, BROADCAST_CAPACITY, LagPolicy::Warn);

    // Per [D15], tugbank unavailability is still a fatal startup error
    // because other tugcast subsystems (defaults, recents, layout) need it.
    if bank_client.is_none() {
        eprintln!(
            "tugcast: error: tugbank unavailable at {}, cannot start without it",
            bank_path.display()
        );
        std::process::exit(1);
    }

    Feeds {
        streams,
        defaults_rx,
        cancel,
        ft_response_tx,
        fs_event_tx,
        file_watch_tx,
        file_watch_input_tx,
        gd_response_tx,
        gl_response_tx,
        gh_response_tx,
        gcf_response_tx,
        usage_response_tx,
        changeset_all_bump,
        registry,
        bootstrap,
        ft_input_tx,
        gd_input_tx,
        gl_input_tx,
        gcf_input_tx,
        usage_input_tx,
        shutdown_tx,
        shutdown_rx,
        ctl_shutdown_tx,
        client_action_tx,
        shared_dev_state,
        control_writer,
        control_reader,
        tugcode_path,
        session_state_feed,
        session_sideband_feed,
        activity_feed,
    }
}
