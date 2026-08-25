mod actions;
mod attachments;
mod auth;
mod changes_journal;
mod changes_writer;
mod cli;
mod control;
mod dash_api;
mod dead_branch;
mod defaults;
mod dev;
mod draft_gc;
mod external_sessions;
mod feeds;
mod fs_blob;
mod fs_complete;
mod fs_mkdir;
mod fs_read;
mod fs_stat;
mod fs_write;
mod git_exclude;
mod host;
mod ink_adoption;
mod jots;
mod ledger_integrity;
/// Crate-root path utilities (firmlink/synthetic/symlink resolution). Lives
/// at the root, not under `feeds/`, because both `feeds` (file watching) and
/// `session_ledger` (storage) depend on it — keeping it a leaf avoids a
/// storage→feeds back-reference.
mod path_resolver;
mod permissions;
mod prompt_history_api;
mod prompt_ledger;
mod refs_ledger;
mod resources;
mod router;
mod scribe;
/// Sub-word vocabulary for the facts library's full-text indexes. A leaf with
/// no dependencies, shared by `session_ledger` (write-time derivation and the
/// backfill) and `feeds::operator` (query-time expansion).
mod search_tokens;
mod server;
mod session_ledger;
mod session_metadata_merge;
mod session_tag_lexicon;
mod shared_agent;
mod shell_ledger;
mod terminal_registry;
mod turn_engine;
mod workspace_api;

#[cfg(test)]
mod integration_tests;
#[cfg(test)]
mod live_corpus;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};
use tugbank_core::TugbankClient;
use tugbank_core::notify as tugbank_notify;
use tugcast_core::{FeedId, Frame};
use tugcore::instance as tug_instance;

use crate::auth::new_shared_auth_state;
use crate::feeds::agent_supervisor::{
    AgentSupervisor, AgentSupervisorConfig, LedgerSessionsRecorder, SessionsRecorder,
    SpawnerFactory, default_spawner_factory,
};
use crate::feeds::filetree::FileTreeQuery;
#[cfg(debug_assertions)]
use crate::feeds::stats::BuildStatusCollector;
use crate::feeds::stats::{ProcessInfoCollector, TokenUsageCollector};
use crate::feeds::terminal::{self, TerminalFeed};
use crate::feeds::workspace_registry::WorkspaceRegistry;
use crate::router::{BROADCAST_CAPACITY, FeedRouter};
use crate::session_ledger::SessionLedger;

#[tokio::main]
async fn main() {
    let _log_guard = tuglog::init("tugcast");

    // Write the per-instance bundle-path marker. When Swift launched
    // us it passed TUG_INSTANCE_ID and TUG_BUNDLE_PATH; the marker
    // anchors `tugutil host instance prune` orphan detection. When either
    // var is unset (standalone harness launches, dev iteration) the
    // helper no-ops.
    match tug_instance::write_bundle_path_marker() {
        Ok(tug_instance::MarkerWrite::Written) => info!("bundle-path marker written"),
        Ok(tug_instance::MarkerWrite::Unchanged | tug_instance::MarkerWrite::Skipped) => {}
        Err(e) => warn!(error = %e, "failed to write bundle-path marker"),
    }

    // Bring installed packs' recorded catalog ranks back in line with the
    // catalog. The rank is stamped at install time so the Swift service can
    // order packs without knowing the catalog, which means reordering the
    // catalog does not reorder what is already on disk — and `auto` reads the
    // recorded one, so without this a user keeps being routed to a pack the
    // catalog has since retired.
    //
    // Only for a real instance. The models directory is shared by every
    // instance on the machine, and the integration tests spawn this binary —
    // a test run must not rewrite what the user has installed. Same reasoning,
    // and same signal, as the bundle-path marker above.
    // Reclaim leaked runtime debris machine-wide. A dev/release launch is
    // the only routine event on a machine where app-tests never run, so
    // hooking it means merely using Tug keeps the machine clean —
    // otherwise nothing runs and dead sockets accumulate by the thousand.
    //
    // Detached: the sweep must never delay serving. Gated the same way as
    // the reconcile above (a test-spawned tugcast has no instance id), and
    // additionally excluded for app-test instances — there are dozens per
    // run, and mid-run sweeps of sibling instances are risk without gain.
    //
    // This runs before we register ourselves, which is harmless: only
    // `apptest-` data dirs are candidates, so a dev/release instance is
    // never its own. An app-test instance booting elsewhere is protected
    // by the janitor's minimum-age floor.
    if tugcore::instance::instance_id().is_some_and(|id| !tugcore::ports::is_apptest_id(&id)) {
        std::thread::spawn(|| {
            let r = tugcore::janitor::sweep_all(tugcore::janitor::SweepMode::Apply);
            if !r.is_empty() {
                info!(
                    sockets = r.dead_sockets.len(),
                    tmux_servers = r.tmux_servers_killed.len(),
                    tmux_sockets = r.tmux_sockets_unlinked.len(),
                    tmp_files = r.tmp_files_removed.len(),
                    tmp_dirs = r.tmp_dirs_removed.len(),
                    data_dirs = r.apptest_data_dirs_removed.len(),
                    processes = r.processes_killed.len(),
                    legacy_sessions = r.legacy_sessions_killed.len(),
                    "janitor: swept leaked runtime debris"
                );
            }
        });
    }

    // Create own process group so the app can kill tugcast + all children
    // (tugcode, bun) with a single kill(-pgid, SIGTERM). Without this,
    // children become orphans when the app force-kills tugcast.
    unsafe {
        libc::setpgid(0, 0);
    }

    // Parse CLI arguments
    let cli = cli::Cli::parse();

    // Developer subcommands run before anything the server owns is claimed —
    // no port bound, no instance registered, no ledger writer taken — so one
    // can be run against a machine with a live tugcast on it without the two
    // ever meeting.
    if let Some(command) = cli.command.as_ref() {
        let code = match command {
            cli::Command::OverviewReplay(args) => {
                let opts = feeds::overview_replay::ReplayOptions::from_args(args);
                feeds::overview_replay::run(&args.jsonl, &opts).await
            }
            cli::Command::OperatorAsk(args) => feeds::operator_ask::run(args).await,
        };
        // `process::exit` runs no destructors, and the log writer is
        // non-blocking — without this drop every line a subcommand logged is
        // still in the buffer when the process disappears, which is how a run
        // that logged one INFO line per verb leaves an empty log file.
        drop(_log_guard);
        std::process::exit(code);
    }

    // Ledger seeding runs before everything else and never returns — it must
    // not bind a port, register an instance, or touch tmux.
    if let Some(spec) = cli.seed_ledger.as_deref() {
        seed_ledger(spec);
    }

    // Duplicate-launch guard (per [D07]). When TUG_INSTANCE_ID is
    // set and the registry already lists a live tugcast for this
    // identity, bail out *before* binding any port. The walker in
    // `allocate_port` would otherwise quietly step to the next free
    // port and let a second tugcast cohabit, defeating the
    // single-instance semantics LaunchServices provides for the GUI
    // app. `--force` overrides the check — useful for harness rigs
    // that kill the previous process first.
    if !cli.force
        && let Some(id) = tug_instance::instance_id()
        && let Ok(Some(existing)) = tugcore::registry::find_by_id(&id)
    {
        eprintln!(
            "tugcast: another '{id}' instance is already running (PID {})",
            existing.pid
        );
        warn!(
            instance_id = %id,
            pid = existing.pid,
            port = existing.tugcast_port,
            "duplicate-launch refused; exiting EX_CANTCREAT (73)"
        );
        std::process::exit(73);
    }

    // Resolve the port we *want* to bind. Three branches:
    // - `--port <P>` explicit: use it (incl. 0 for OS-ephemeral)
    // - No --port + TUG_INSTANCE_ID set: derive per-instance port
    //   via FNV-1a hash, walk on collision, fall back to ephemeral
    // - No --port + no identity: legacy single-instance default 55255
    let requested_port: u16 = match cli.port {
        Some(p) => p,
        None => match tug_instance::instance_id() {
            Some(id) => {
                // App-test instances draw from a dedicated window so their
                // ports never overlap a live dev/release instance's.
                let (base, window) = tugcore::ports::tugcast_window_for(&id);
                match tugcore::ports::allocate_port(&id, base, window, tcp_port_is_free) {
                    tugcore::ports::AllocatedPort::Window { port, walk_offset } => {
                        if walk_offset > 0 {
                            info!(
                                port,
                                walk_offset, "derived tugcast port via walk-on-collision"
                            );
                        }
                        port
                    }
                    tugcore::ports::AllocatedPort::EphemeralFallback => {
                        warn!(
                            "tugcast port window {}..{} exhausted; falling back to OS-ephemeral",
                            base,
                            base + window
                        );
                        0
                    }
                }
            }
            None => 55255,
        },
    };

    // --force: kill any existing process holding the TCP port before we try to bind.
    if cli.force {
        force_kill_port_holder(requested_port);
    }

    // Bind the listener *now*, before auth state is constructed, so
    // we can use the actually-bound port (which may differ from the
    // request when port==0) in the auth allowlist and ready message.
    let listener = match TcpListener::bind(format!("127.0.0.1:{requested_port}")).await {
        Ok(l) => l,
        Err(e) => {
            // On EADDRINUSE, consult the registry: if a live tugcast
            // for the same instance ID is already registered, this is
            // a duplicate-launch collision (per [D07]). Exit code 73
            // (`EX_CANTCREAT`) signals "structurally cannot create"
            // — the Swift supervisor recognizes it as a duplicate and
            // does not retry the spawn.
            if e.kind() == std::io::ErrorKind::AddrInUse
                && let Some(id) = tug_instance::instance_id()
                && let Ok(Some(existing)) = tugcore::registry::find_by_id(&id)
            {
                eprintln!(
                    "tugcast: another '{id}' instance is already running (PID {})",
                    existing.pid
                );
                warn!(
                    instance_id = %id,
                    pid = existing.pid,
                    port = existing.tugcast_port,
                    "duplicate-launch collision; exiting EX_CANTCREAT (73)"
                );
                std::process::exit(73);
            }
            eprintln!("tugcast: error: failed to bind to 127.0.0.1:{requested_port}: {e}");
            std::process::exit(1);
        }
    };
    let actual_port: u16 = listener
        .local_addr()
        .map(|a| a.port())
        .unwrap_or(requested_port);
    info!(port = actual_port, "tugcast server listening");

    // Resolve bank path: --bank-path flag > TUGBANK_PATH env var >
    // per-instance `tugcore::instance::tugbank_db_path()` (when
    // TUG_INSTANCE_ID is set) > legacy `~/.tugbank.db`. Harness tests
    // that set TUGBANK_PATH still take precedence over the per-instance
    // path so a synthetic identity can be pointed at a temp DB.
    let bank_path: PathBuf = cli
        .bank_path
        .clone()
        .or_else(|| {
            std::env::var_os("TUGBANK_PATH")
                .map(PathBuf::from)
                .filter(|p| !p.as_os_str().is_empty())
        })
        .or_else(tug_instance::tugbank_db_path)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()))
                .join(".tugbank.db")
        });

    // Ensure the parent directory exists. The per-instance data dir
    // (`~/Library/Application Support/Tug/instances/<id>/`) is not
    // created until first launch — TugbankClient::open below would
    // otherwise fail with ENOENT.
    if let Some(parent) = bank_path.parent()
        && let Err(e) = std::fs::create_dir_all(parent)
    {
        warn!(
            path = %parent.display(),
            error = %e,
            "failed to create tugbank parent directory (continuing)"
        );
    }

    info!(
        session = %cli.session,
        port = actual_port,
        source_tree = ?cli.source_tree,
        "tugcast starting"
    );

    // Verify tmux version
    match terminal::check_tmux_version().await {
        Ok(version) => info!("tmux version: {}", version),
        Err(e) => {
            eprintln!(
                "tugcast: error: tmux not found or version too old (requires 3.x+): {}",
                e
            );
            std::process::exit(1);
        }
    }

    // Ensure tmux session exists
    if let Err(e) = terminal::ensure_session(&cli.session).await {
        eprintln!(
            "tugcast: error: failed to create tmux session '{}': {}",
            cli.session, e
        );
        std::process::exit(1);
    }

    // Create auth state. With --no-auth, the token exchange and cookie still
    // work normally (so the app loads fine), but WebSocket validation is skipped
    // so external tools can connect without a session cookie.
    let auth = if cli.no_auth {
        auth::new_shared_auth_state_no_auth(actual_port)
    } else {
        new_shared_auth_state(actual_port)
    };

    let token = auth.lock().unwrap().token().unwrap().to_string();
    let auth_url = format!("http://127.0.0.1:{actual_port}/auth?token={token}");
    info!("Auth URL: {}", auth_url);

    // Connect to control socket if specified
    let control_socket = if let Some(ref path) = cli.control_socket {
        match control::ControlSocket::connect(path).await {
            Ok(cs) => Some(cs),
            Err(e) => {
                eprintln!("tugcast: error: failed to connect to control socket: {}", e);
                std::process::exit(1);
            }
        }
    } else {
        None
    };

    // Create the CODE_OUTPUT feed. The lag-recovery replay buffer lives
    // on the handle (P4): every frame published through it is buffered,
    // shared across sessions per [D06]; the tugdeck-side filter provides
    // isolation on replay per [D11].
    let code_output_feed = feeds::session_scoped::SessionScopedFeed::new(
        FeedId::CODE_OUTPUT,
        feeds::code::CODE_BROADCAST_CAPACITY,
        crate::router::LagPolicy::Replay(crate::router::ReplayBuffer::new(1000)),
    );
    let (code_input_tx, code_input_rx) = mpsc::channel(256);

    // CODE_INPUT relay: the router's registered sink is the relay sender; the
    // relay tees every frame to the session synopsis's submission broadcast
    // before forwarding it verbatim to the supervisor's dispatcher. The relay
    // channel matches the dispatcher channel's capacity — a hop, not a buffer
    // cliff.
    let (code_submission_tx, _) = broadcast::channel::<Frame>(64);
    let (code_input_relay_tx, code_input_relay_rx) = mpsc::channel::<Frame>(256);
    tokio::spawn(feeds::session_synopsis::relay_code_input(
        code_input_relay_rx,
        code_submission_tx.clone(),
        code_input_tx.clone(),
    ));

    // SHELL feed — the `$` route's block-oriented shell execution. SHELL_OUTPUT
    // is a session-scoped broadcast (exchange frames tagged by tug_session_id);
    // SHELL_INPUT flows to the shell dispatcher (spawned below), which owns one
    // pipe-mode shell child per session.
    let shell_output_feed = feeds::session_scoped::SessionScopedFeed::new(
        FeedId::SHELL_OUTPUT,
        feeds::shell::SHELL_BROADCAST_CAPACITY,
        LagPolicy::Warn,
    );
    let (shell_input_tx, shell_input_rx) = mpsc::channel(256);

    // REFS feed — the `/match` and `/search` commands. REFS_OUTPUT streams a
    // run's result rows to the card that asked; REFS_INPUT flows to the refs
    // dispatcher (spawned below), which runs one search at a time per session.
    let refs_output_feed = feeds::session_scoped::SessionScopedFeed::new(
        FeedId::REFS_OUTPUT,
        feeds::refs::REFS_BROADCAST_CAPACITY,
        LagPolicy::Warn,
    );
    let (refs_input_tx, refs_input_rx) = mpsc::channel(256);

    // Create terminal feed. Its broadcast channel is created — and its
    // task spawned — by `register_stream_feed` below; only the input
    // sender is needed ahead of registration.
    let terminal_feed = TerminalFeed::new(cli.session.clone());
    let input_tx = terminal_feed.input_sender();

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
            let _ = std::fs::create_dir_all(&dir);
            dir
        }
    };

    // Open the TugbankClient. On success, wrap in Arc for shared ownership between
    // migration, the defaults feed, and the HTTP server. On failure, log a warning
    // and continue without tugbank -- this preserves graceful degradation when the
    // bank path is inaccessible.
    let bank_client: Option<Arc<TugbankClient>> = match TugbankClient::open(&bank_path) {
        Ok(client) => Some(Arc::new(client)),
        Err(e) => {
            warn!(
                path = %bank_path.display(),
                error = %e,
                "failed to open TugbankClient — defaults endpoints and feed disabled"
            );
            None
        }
    };

    // App-test launches suppress the ConfigureTug wizard: the harness marker
    // (TUGAPP_TEST_SOCKET, inherited app → tugexec → tugcast) seeds the
    // tugbank default the deck reads synchronously at mount, so a fresh
    // per-instance bank never opens the blocking first-run wizard under a
    // focus-driven test. TUGAPP_TEST_KEEP_SETUP opts a ConfigureTug-specific
    // test back in — seeded `false` explicitly so a reused bank cannot
    // leak suppression into it. Written before the server accepts
    // connections, so the deck can never load ahead of the seed.
    if std::env::var_os("TUGAPP_TEST_SOCKET").is_some() {
        let keep_setup = std::env::var_os("TUGAPP_TEST_KEEP_SETUP").is_some();
        if let Some(bank) = bank_client.as_ref() {
            if let Err(e) = bank.set(
                "dev.tugtool.app",
                "suppress-setup",
                tugbank_core::Value::Bool(!keep_setup),
            ) {
                warn!(error = %e, "failed to seed app-test suppress-setup default");
            }
        }
    }

    let notify_socket_path = tugbank_notify::socket_path();

    // Open the session ledger BEFORE the DEFAULTS feed. A failure here is
    // fatal: the supervisor depends on the ledger to track session lifecycle,
    // and limping along with no session metadata would make every future
    // picker open misleading. Opening it here (rather than later) lets the
    // orphaned-prompt-history prune below run before the feed builds its
    // initial frame — keeping that frame clean and avoiding a frame rebuild
    // per deleted key.
    let ledger_path = SessionLedger::default_path().unwrap_or_else(|| {
        eprintln!("tugcast: error: cannot resolve user data dir for session ledger");
        std::process::exit(1);
    });
    if let Some(parent) = ledger_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!(
                "tugcast: error: failed to create ledger data dir {}: {}",
                parent.display(),
                e
            );
            std::process::exit(1);
        }
    }
    let ledger = match SessionLedger::open(&ledger_path, actual_port) {
        Ok(l) => Arc::new(l),
        Err(e) => {
            eprintln!(
                "tugcast: error: failed to open session ledger at {}: {}",
                ledger_path.display(),
                e
            );
            std::process::exit(1);
        }
    };

    // Checkpoint-health watchdog. A WAL that keeps growing while
    // checkpoints move nothing is the silent precursor of ledger
    // corruption (sessions.db sat three days un-checkpointed before the
    // 2026-07-27 incident, with nothing logged). Passive-checkpoint both
    // databases periodically and alarm on two consecutive stalls or any
    // pragma failure.
    {
        let ledger = Arc::clone(&ledger);
        let sessions_db_path = ledger_path.clone();
        let changes_db_path = tugcore::instance::changes_db_path();
        tokio::spawn(async move {
            const WATCHDOG_PERIOD: std::time::Duration = std::time::Duration::from_secs(300);
            // A healthy busy checkpoint leaves a short WAL; alarm only when
            // the backlog is real (~4 MB of 4 KB pages).
            const STALL_FRAMES: i64 = 1000;
            // Snapshot backups (`VACUUM INTO`, retained 5-deep beside each
            // db) on startup and every 6 hours of watchdog ticks.
            const BACKUP_EVERY_TICKS: u64 = 72;
            // Snapshotting the shared database belongs to whoever holds
            // the writer claim; a forwarding instance would duplicate the
            // owner's backups beside the same file.
            let backup_targets = |ledger: &session_ledger::SessionLedger| {
                let mut targets: Vec<(&str, &std::path::Path)> =
                    vec![("main", sessions_db_path.as_path())];
                if ledger.owns_changes_writer() {
                    targets.push(("changes", changes_db_path.as_path()));
                }
                ledger_integrity::snapshot_backups(ledger, &targets);
            };
            backup_targets(&ledger);
            let mut strikes: std::collections::HashMap<&'static str, u32> =
                std::collections::HashMap::new();
            let mut tick: u64 = 0;
            loop {
                tokio::time::sleep(WATCHDOG_PERIOD).await;
                tick += 1;
                // A forwarding instance whose owner died while nothing was
                // being written takes over here rather than waiting for
                // the next attribution event.
                ledger.retry_changes_takeover();
                // The inverse duty: an owner whose lockfile identity
                // drifted (publish failed at claim time) heals it here so
                // forwarders never route to a stale owner. No-op when the
                // content already matches.
                ledger.republish_writer_identity();
                if tick % BACKUP_EVERY_TICKS == 0 {
                    backup_targets(&ledger);
                }
                for health in ledger.checkpoint_health() {
                    let count = strikes.entry(health.db).or_insert(0);
                    if let Some(err) = &health.error {
                        *count += 1;
                        error!(
                            db = health.db,
                            error = %err,
                            "ledger WAL checkpoint pragma failed — database may be corrupt or locked out"
                        );
                        // Two consecutive failures is the incident's
                        // silent signature; the deck must show it, not
                        // just the log ([LR4]).
                        if *count >= 2 {
                            ledger_integrity::health::note_degraded("checkpoint-error");
                        }
                        continue;
                    }
                    let stalled = health.log_frames >= STALL_FRAMES
                        && health.checkpointed_frames < health.log_frames;
                    if stalled {
                        *count += 1;
                        if *count >= 2 {
                            error!(
                                db = health.db,
                                log_frames = health.log_frames,
                                checkpointed_frames = health.checkpointed_frames,
                                busy = health.busy,
                                "ledger WAL checkpoint stalled — WAL growing without being applied"
                            );
                            ledger_integrity::health::note_degraded("checkpoint-stall");
                        }
                    } else {
                        if *count >= 2 {
                            info!(db = health.db, "ledger WAL checkpointing recovered");
                        }
                        *count = 0;
                    }
                }
            }
        });
    }

    // Demote any rows still marked `live` from a previous run that didn't
    // shut down cleanly. The subprocesses they pointed at are gone; their
    // ledger state is stale.
    match ledger.demote_live_to_closed() {
        Ok(0) => {}
        Ok(n) => info!(count = n, "demoted stale live ledger rows on startup"),
        Err(e) => warn!(error = %e, "failed to demote stale live ledger rows"),
    }

    // Prompt-history ledger — the composer's durable prompt corpus. Non-fatal:
    // a failure leaves the recall routes unregistered, which the deck reports
    // to the user rather than swallowing, and must not take tugcast down.
    let prompt_ledger: Option<Arc<prompt_ledger::PromptLedger>> = {
        let path = prompt_ledger::PromptLedger::default_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match prompt_ledger::PromptLedger::open(&path) {
            Ok(l) => Some(Arc::new(l)),
            Err(e) => {
                warn!(error = %e, path = %path.display(), "failed to open prompt-history ledger (prompt recall disabled)");
                None
            }
        }
    };

    // Move whatever prompt history still lives in tugbank into the ledger. This
    // runs before the DEFAULTS feed builds the boot frame out of those domains,
    // and before the attachment sweep below reads the ledger as a root — an
    // entry mid-migration is referenced by neither home, so a sweep between the
    // two would see an attachment nothing claims.
    if let (Some(bank), Some(pl)) = (bank_client.as_ref(), prompt_ledger.as_ref()) {
        // The migration logs its own count; nothing to report here.
        prompt_ledger::migrate_prompt_history(bank, pl);
    }

    // Startup hygiene: reclaim composer attachments nothing references any
    // more. Runs after the migration above so every history reference lives in
    // a root the sweep can see, and before the DEFAULTS feed registers its
    // change callback so the deletions don't each rebuild the boot frame.
    if let Some(bank) = bank_client.as_ref() {
        crate::draft_gc::sweep_at_startup(bank, prompt_ledger.as_deref());
    }

    // Create DEFAULTS feed from the TugbankClient.
    let defaults_rx: Option<tokio::sync::watch::Receiver<Frame>> = bank_client
        .as_ref()
        .map(|client| feeds::defaults::defaults_feed(Arc::clone(client)));

    // Shared cancellation token for the process. Declared before the
    // WorkspaceRegistry call because `get_or_create` needs a clone to hand
    // to the feed tasks it spawns internally.
    let cancel = CancellationToken::new();

    // Shared FILETREE-response broadcast channel. Every workspace's
    // `FileTreeFeed` publishes responses here; the router subscribes
    // once (below, via `add_broadcast_senders`) and fans out to every
    // connected client. JS-side filtering by `workspace_key` routes the
    // response to the right card. Buffer of 64 frames is comfortable
    // for FILETREE traffic (one frame per typed character, deduplicated
    // by JS) — a Lagged slow client drops some completions but doesn't
    // crash. Per `dash/dev-atoms.md#step-pre-4`.
    let (ft_response_tx, _) = broadcast::channel::<Frame>(64);

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
    // open/close and the aggregate feed (built below) can await it. Shared
    // with the attribution `ChangesetBumper` so a file-event write in any
    // open project recomputes the aggregate.
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
    ));
    let bootstrap = registry
        .get_or_create(&watch_dir, cancel.clone())
        .expect("bootstrap workspace must be a valid directory");

    // Adapter: router sends raw Frames on FILETREE_QUERY; parse JSON into
    // FileTreeQuery and forward to the workspace's FileTreeFeed.
    //
    // Routing strategy (`dash/dev-atoms.md#step-pre-4`): if the JS payload
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
            /// the whole-tree diff (session card `/diff`). Head flavor only.
            paths: Option<Vec<String>>,
            /// Dash range flavor ([P19]): a present `branch` selects
            /// `<base>...<branch>` + worktree dirt instead of `git diff HEAD`.
            /// `worktree` is the dash worktree path relative to the resolved
            /// project dir; `base` the dash's base branch.
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
                // `branch` to the dash range flavor; otherwise the head flavor
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
                            crate::feeds::git::build_dash_diff_snapshot(
                                &entry.project_dir,
                                request_id,
                                entry.workspace_key.as_ref(),
                                worktree.as_deref().unwrap_or_default(),
                                base.as_deref().unwrap_or("main"),
                                &branch,
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
                let (ok, text, error) = crate::feeds::claude_usage::fetch_usage_text().await;
                let snapshot = tugcast_core::types::UsageSnapshot {
                    request_id,
                    ok,
                    text,
                    error,
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

    // Create stats collectors
    let process_info =
        Arc::new(ProcessInfoCollector::new()) as Arc<dyn crate::feeds::stats::StatCollector>;
    let token_usage = Arc::new(TokenUsageCollector::new(cli.session.clone()))
        as Arc<dyn crate::feeds::stats::StatCollector>;
    // BuildStatusCollector is dev-only: it reads tugrust/target/, which
    // does not exist in a bundled Tug.app. Release tugcast skips both
    // construction and feed registration.
    #[cfg(debug_assertions)]
    let build_status = Arc::new(BuildStatusCollector::new(
        resources::source_tree().join("target"),
    )) as Arc<dyn crate::feeds::stats::StatCollector>;

    // Stats run through the unified stats surface: the subsystem creates
    // its own channels and spawns its tasks; the router receives only the
    // watch receivers (registered with the other snapshot watches below).
    // BuildStatusCollector is dev-only, so release skips the push and
    // `collectors.len()` still matches senders inside `StatsRunner::run`.
    #[allow(unused_mut)]
    let mut stats_collectors: Vec<Arc<dyn crate::feeds::stats::StatCollector>> =
        vec![process_info, token_usage];
    #[cfg(debug_assertions)]
    stats_collectors.push(build_status);
    let stats_watch_rxs = feeds::stats::spawn_stats_feeds(stats_collectors, cancel.clone());

    // Create shutdown channel for control commands
    let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<u8>(1);

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
    if let Some(ref client) = bank_client {
        let notify_client = Arc::clone(client);
        let notify_cancel = cancel.clone();
        let notify_path = notify_socket_path.clone();
        tokio::spawn(async move {
            run_notify_listener(notify_path, notify_client, notify_cancel).await;
        });
    }

    // Create replay buffer for CodeOutput lag recovery (P4). Correctness
    // on replay relies on the client-side session filter per [D06]/[D11]:
    // the buffer is shared across sessions, and clients subscribed to
    // SESSION_STATE/SESSION_SIDEBAND filter frames by `tug_session_id`.
    use crate::router::LagPolicy;

    // Resolve tugcode path for the supervisor's default spawner factory.
    let tugcode_path = feeds::agent_bridge::resolve_tugcode_path(cli.tugcode_path.as_deref());
    if !tugcode_path.exists() {
        panic!(
            "tugcode not found at {} — tugcode is required for tugcast to run",
            tugcode_path.display()
        );
    }

    // Construct the multi-session supervisor. SESSION_STATE is a
    // SessionScopedFeed (created here, registered with the router below);
    // SESSION_SIDEBAND's broadcast channel is created here and registered
    // below. The supervisor publishes CONTROL error frames onto the same
    // broadcast that `register_stream` wires for FeedId::CONTROL so
    // clients observe them in-band.
    let session_state_feed = feeds::session_scoped::SessionScopedFeed::new(
        FeedId::SESSION_STATE,
        BROADCAST_CAPACITY,
        LagPolicy::Warn,
    );
    let session_sideband_feed = feeds::session_scoped::SessionScopedFeed::new(
        FeedId::SESSION_SIDEBAND,
        BROADCAST_CAPACITY,
        LagPolicy::Warn,
    );
    // ACTIVITY ([P16] byte 0x42) — a native SessionScopedFeed ([P14]). The
    // supervisor's merger diverts tugcode's `activity_delta` frames onto it
    // ([P13]); the OS subtree sampler (a later step) publishes gauge samples
    // through the same handle. `LagPolicy::Warn` per [P17]: the deck wants
    // the sample stream, and a dropped low-volume bin self-heals.
    let activity_feed = feeds::session_scoped::SessionScopedFeed::new(
        FeedId::ACTIVITY,
        BROADCAST_CAPACITY,
        LagPolicy::Warn,
    );

    // Per [D15], tugbank unavailability is still a fatal startup error
    // because other tugcast subsystems (defaults, recents, layout) need it.
    if bank_client.is_none() {
        eprintln!(
            "tugcast: error: tugbank unavailable at {}, cannot start without it",
            bank_path.display()
        );
        std::process::exit(1);
    }

    // Shell-exchange ledger — non-fatal: a failure means the `$` route just
    // won't persist exchanges (the deck degrades to no shell restore), which
    // must not take tugcast down.
    let shell_ledger: Option<Arc<shell_ledger::ShellLedger>> = shell_ledger::ShellLedger::default_path()
        .and_then(|path| {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            match shell_ledger::ShellLedger::open(&path) {
                Ok(l) => Some(Arc::new(l)),
                Err(e) => {
                    warn!(error = %e, path = %path.display(), "failed to open shell ledger (shell persistence disabled)");
                    None
                }
            }
        });

    // Refs ledger — non-fatal on the same grounds: without it `/match` and
    // `/search` still run, they just don't survive a reload.
    let refs_ledger: Option<Arc<refs_ledger::RefsLedger>> = refs_ledger::RefsLedger::default_path()
        .and_then(|path| {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            match refs_ledger::RefsLedger::open(&path) {
                Ok(l) => Some(Arc::new(l)),
                Err(e) => {
                    warn!(error = %e, path = %path.display(), "failed to open refs ledger (refs restore disabled)");
                    None
                }
            }
        });

    // Ink adoption, ahead of the card-shaped reconciler below. A fork's ink
    // transfer spans two databases with no shared transaction, so anything an
    // interruption or a race left under a superseded id is repaired here,
    // before the supervisor serves its first restore read.
    //
    // The order matters: `reconcile_orphaned_rows` moves rows onto whichever
    // session a card currently holds, which is a heuristic predating fork
    // provenance. A provenance edge is direct evidence, so it decides first.
    {
        let ink = ink_adoption::InkStores {
            shell: shell_ledger.as_deref(),
            refs: refs_ledger.as_deref(),
        };
        ink_adoption::adopt_by_lineage(&ledger, ink);
    }

    // The pre-provenance backfill: the forks that happened before the
    // provenance columns existed left no edge for the sweep above to follow,
    // so their ink is adopted on transcript evidence instead. In the
    // background, because a large corpus must never delay serving, and at
    // most once per machine — the watermark it writes ends it.
    {
        let backfill_sessions = Arc::clone(&ledger);
        let backfill_shell = shell_ledger.clone();
        let backfill_refs = refs_ledger.clone();
        let backfill_bank = bank_client.clone();
        tokio::task::spawn_blocking(move || {
            ink_adoption::adopt_pre_provenance_orphans(
                &backfill_sessions,
                ink_adoption::InkStores {
                    shell: backfill_shell.as_deref(),
                    refs: backfill_refs.as_deref(),
                },
                backfill_bank.as_deref(),
            );
        });
    }

    // Recover shell rows orphaned by the pre-F1 fresh-spawn bug: move a lost
    // zero-turn session's exchanges onto the card's current (empty) session so
    // shell-only sessions that were re-spawned under a fresh id before the fix
    // show their history again. Conservative + idempotent (see
    // `reconcile_orphaned_rows`); non-fatal.
    if let Some(sl) = shell_ledger.as_ref() {
        match ledger.list_with_card_id() {
            Ok(rows) => {
                let sessions: Vec<shell_ledger::SessionForReconcile> = rows
                    .into_iter()
                    .filter_map(|r| {
                        r.card_id.map(|card_id| shell_ledger::SessionForReconcile {
                            session_id: r.session_id,
                            card_id,
                            turn_count: r.turn_count,
                        })
                    })
                    .collect();
                match sl.reconcile_orphaned_rows(&sessions) {
                    Ok(n) if n > 0 => {
                        info!(
                            recovered = n,
                            "shell ledger: reconciled orphaned exchanges onto current sessions"
                        )
                    }
                    Ok(_) => {}
                    Err(e) => warn!(error = %e, "shell ledger: orphan reconciliation failed"),
                }
            }
            Err(e) => {
                warn!(error = %e, "shell ledger: could not list card sessions for reconciliation")
            }
        }
    }

    let ledger_recorder = Arc::new(LedgerSessionsRecorder::with_broadcast(
        Arc::clone(&ledger),
        client_action_tx.clone(),
    ));

    // Age sweep: drop every non-live row whose `last_used_at` is older
    // than the configured cap. Runs after `demote_live_to_closed` so the
    // demoted rows have a chance to be swept too if they're already old.
    // Broadcasts go nowhere yet — there are no clients connected — but
    // the recorder's broadcast call is harmless against an empty
    // subscriber set.
    let max_age_ms = crate::session_ledger::DEV_LEDGER_MAX_AGE_DAYS * 86_400_000;
    ledger_recorder.sweep_expired_with_broadcast(max_age_ms, crate::session_ledger::now_millis());

    // Trash sweep: walk every workspace's `.tug-trash/<deletedAt>/`
    // under `~/.claude/projects/` and remove any deletedAt subdir older
    // than 7 days. Runs after the age sweep so freshly-trashed JSONLs
    // (recoverable for 7 days) aren't immediately lost.
    let trash_max_age_ms = crate::session_ledger::DEV_TRASH_SWEEP_AGE_DAYS * 86_400_000;
    let trash_swept = ledger.sweep_trash(trash_max_age_ms, crate::session_ledger::now_millis());
    if trash_swept > 0 {
        info!(
            count = trash_swept,
            "swept stale trash directories on startup"
        );
    }

    // Background warm scan: pre-populate the external-session scan cache
    // for every project dir that already has ledger rows, so the picker's
    // first open after launch finds terminal-created sessions already
    // cached (a warm, stat-only scan) instead of paying the multi-second
    // cold JSONL parse on the user's timeline. Detached and best-effort:
    // it never blocks startup, and an empty/failed scan is harmless. The
    // scan itself fans out across cores (rayon), and `scan_*_cached` is
    // idempotent, so a concurrent picker scan during warm-up only
    // duplicates work, never corrupts.
    {
        let ledger = Arc::clone(&ledger);
        tokio::task::spawn_blocking(move || {
            let dirs = match ledger.distinct_workspaces() {
                Ok(dirs) => dirs,
                Err(err) => {
                    warn!(error = %err, "warm scan: distinct_workspaces failed");
                    return;
                }
            };
            for dir in dirs {
                let outcome =
                    crate::external_sessions::scan_external_sessions_cached(&ledger, &dir);
                if outcome.parsed > 0 {
                    info!(
                        project_dir = %dir,
                        parsed = outcome.parsed,
                        cache_hits = outcome.cache_hits,
                        "warm scan populated external-session cache",
                    );
                }
            }
        });
    }

    let sessions_recorder: Arc<dyn SessionsRecorder> = ledger_recorder;

    let supervisor_config = AgentSupervisorConfig {
        tugcode_path: tugcode_path.clone(),
        ..Default::default()
    };
    let spawner_factory: SpawnerFactory = default_spawner_factory(&supervisor_config);

    let (mut supervisor, merger_register_rx) = AgentSupervisor::new_with_ledger(
        session_state_feed.clone(),
        session_sideband_feed.clone(),
        code_output_feed.clone(),
        activity_feed.clone(),
        client_action_tx.clone(),
        sessions_recorder,
        Some(Arc::clone(&ledger)),
        spawner_factory,
        supervisor_config,
        Arc::clone(&registry),
        cancel.clone(),
    );
    // Give the supervisor the shell ledger so `list_shell_exchanges` can read
    // the tail the shell dispatcher writes.
    if let Some(sl) = shell_ledger.as_ref() {
        supervisor.set_shell_ledger(Arc::clone(sl));
    }
    // Same for the refs ledger, which backs the `list_refs` restore read.
    if let Some(rl) = refs_ledger.as_ref() {
        supervisor.set_refs_ledger(Arc::clone(rl));
    }

    // The changeset scribe ([P11]/[P22]): the maintained-draft engine runs a
    // headless `claude -p` with the model from
    // the tugbank default `dev.tugtool.changeset`/`scribe_model` (resolved per
    // request, so a settings change applies immediately), falling back to
    // `sonnet` — the fingerprint gate ([P22]) bounds how often it runs, so the
    // model choice is a quality call, not a cost one.
    let scribe_model: Arc<dyn Fn() -> String + Send + Sync> = {
        let bank = bank_client.clone();
        Arc::new(move || {
            bank.as_ref()
                .and_then(|b| {
                    b.get("dev.tugtool.changeset", "scribe_model")
                        .ok()
                        .flatten()
                })
                .and_then(|v| match v {
                    tugbank_core::Value::String(s) if !s.trim().is_empty() => Some(s),
                    _ => None,
                })
                .unwrap_or_else(|| "sonnet".to_string())
        })
    };
    supervisor.set_scribe(feeds::agent_supervisor::ScribeContext {
        spawner: Arc::new(scribe::ClaudeScribeSpawner),
        model: scribe_model,
    });

    // The Haiku SharedAgent ([P02]): one app-scoped pool serving the jobs that
    // used to run on the on-device pack. Building it spawns nothing — the first
    // job of a class is what spawns that class's worker, so a machine that never
    // types a shell candidate never pays for a classify worker.
    let shared_agent_model: Arc<dyn Fn() -> String + Send + Sync> = {
        let bank = bank_client.clone();
        Arc::new(move || {
            bank.as_ref()
                .and_then(|b| {
                    b.get(shared_agent::SHARED_AGENT_DOMAIN, shared_agent::MODEL_KEY)
                        .ok()
                        .flatten()
                })
                .and_then(|v| match v {
                    tugbank_core::Value::String(s) if !s.trim().is_empty() => Some(s),
                    _ => None,
                })
                // A full id, never a bare alias ([P03]) — aliases drift, and a
                // drifting aux model is a silent behavior change.
                .unwrap_or_else(|| shared_agent::HAIKU_MODEL.to_string())
        })
    };
    let max_workers = bank_client
        .as_ref()
        .and_then(|b| {
            b.get(
                shared_agent::SHARED_AGENT_DOMAIN,
                shared_agent::MAX_WORKERS_KEY,
            )
            .ok()
            .flatten()
        })
        .and_then(|v| match v {
            tugbank_core::Value::I64(n) if n > 0 => Some(n as usize),
            _ => None,
        })
        .unwrap_or(shared_agent::DEFAULT_MAX_WORKERS);
    let haiku_agent = shared_agent::SharedAgentPool::new(
        shared_agent::AgentSpec {
            name: "haiku",
            model: shared_agent_model,
            jobs: shared_agent::HAIKU_AGENT_JOBS,
            max_workers,
        },
        Arc::new(shared_agent::ClaudeAgentWorkerSpawner),
    );

    // The Overview's Sonnet agent: a second `AgentSpec` on the same pool
    // machinery, carrying the Observer's digests and both halves of the
    // Operator. Like the Haiku pool, building it spawns nothing — the first
    // job of a class spawns that class's worker, so an instance where nobody
    // opens the Overview never pays for one.
    //
    // Model and worker cap are read per spawn from the `dev.tugtool.overview`
    // defaults, so both apply without a restart.
    if let Some(bank) = bank_client.as_ref() {
        feeds::overview_agent::carry_legacy_defaults_forward(bank);
    }
    let overview_model: Arc<dyn Fn() -> String + Send + Sync> = {
        let bank = bank_client.clone();
        Arc::new(move || {
            bank.as_ref()
                .and_then(|b| {
                    b.get(
                        feeds::overview_agent::OVERVIEW_DOMAIN,
                        feeds::overview_agent::MODEL_KEY,
                    )
                    .ok()
                    .flatten()
                })
                .and_then(|v| match v {
                    tugbank_core::Value::String(s) if !s.trim().is_empty() => Some(s),
                    _ => None,
                })
                .unwrap_or_else(|| feeds::overview_agent::DEFAULT_MODEL.to_string())
        })
    };
    let overview_max_workers = bank_client
        .as_ref()
        .and_then(|b| {
            b.get(
                feeds::overview_agent::OVERVIEW_DOMAIN,
                feeds::overview_agent::MAX_WORKERS_KEY,
            )
            .ok()
            .flatten()
        })
        .and_then(|v| match v {
            tugbank_core::Value::I64(n) if n > 0 => Some(n as usize),
            _ => None,
        })
        .unwrap_or(feeds::overview_agent::DEFAULT_MAX_WORKERS);
    let overview_agent = feeds::overview_agent::build_pool(overview_model, overview_max_workers);

    // OVERVIEW — the Observer's live bridge. It taps the same CODE_OUTPUT
    // frames the Pulse narrates from plus the submission wire and
    // SESSION_STATE, buffers them per session, and wakes the Sonnet pool at
    // structural moments. What a wake *means* lives in `observer_wake`, the
    // pure core the offline replay harness drives too — which is what makes
    // the cadence tuned against real transcripts the cadence that ships.
    //
    // Every knob is a closure read at the moment it is used, so turning one
    // in tugbank reaches the next wake with no restart.
    let overview_knob = {
        let bank = bank_client.clone();
        move |key: &'static str, fallback: i64| -> Arc<dyn Fn() -> i64 + Send + Sync> {
            let bank = bank.clone();
            Arc::new(move || {
                bank.as_ref()
                    .and_then(|b| {
                        b.get(feeds::overview_agent::OVERVIEW_DOMAIN, key)
                            .ok()
                            .flatten()
                    })
                    .and_then(|v| match v {
                        tugbank_core::Value::I64(n) if n >= 0 => Some(n),
                        _ => None,
                    })
                    .unwrap_or(fallback)
            })
        }
    };
    let overview_sitrep = overview_knob(
        feeds::overview_agent::SITREP_SECS_KEY,
        feeds::overview_agent::DEFAULT_SITREP_SECS,
    );
    let overview_token_wake = overview_knob(
        feeds::overview_agent::TOKEN_WAKE_TOKENS_KEY,
        feeds::overview_agent::DEFAULT_TOKEN_WAKE_TOKENS,
    );
    let overview_last_k = overview_knob(
        feeds::overview_agent::LAST_K_POSTS_KEY,
        feeds::overview_agent::DEFAULT_LAST_K_POSTS as i64,
    );
    let overview_buffer_frames = overview_knob(
        feeds::overview_agent::BUFFER_MAX_FRAMES_KEY,
        feeds::overview_agent::DEFAULT_BUFFER_MAX_FRAMES as i64,
    );
    let observer_bridge =
        feeds::observer::ObserverBridge::new(feeds::observer::ObserverBridgeConfig {
            code_tx: code_output_feed.sender(),
            submission_tx: code_submission_tx.clone(),
            session_state_tx: session_state_feed.sender(),
            ledger: Some(Arc::clone(&ledger)),
            agent: Some(Arc::clone(&overview_agent)),
            sitrep_secs: overview_sitrep,
            token_wake_tokens: overview_token_wake,
            last_k_posts: Arc::new(move || overview_last_k().max(0) as usize),
            buffer_max_frames: Arc::new(move || overview_buffer_frames().max(1) as usize),
        });

    // PULSE — app-wide color commentary. One bridge per process: it
    // taps the shared CODE_OUTPUT broadcast for the allowlisted frame
    // subset, lazily spawns/supervises the tugpulse daemon (gated on
    // the `pulse/enabled` tugbank default, ON by default), and the
    // daemon's lines land in the capped ledger + the PULSE broadcast.
    // A StreamFeed: its channel, lag policy, and task come from
    // `register_stream_feed` below.
    let tugpulse_path = feeds::pulse::resolve_tugpulse_path(&tugcode_path);
    let pulse_enabled: Arc<dyn Fn() -> bool + Send + Sync> = {
        let bank = bank_client.clone();
        Arc::new(move || {
            let Some(bank) = bank.as_ref() else {
                return true;
            };
            match bank.get(
                feeds::pulse::PULSE_ENABLED_DOMAIN,
                feeds::pulse::PULSE_ENABLED_KEY,
            ) {
                Ok(Some(tugbank_core::Value::Bool(enabled))) => enabled,
                // Absent / other-typed / unreadable all read as the
                // default-ON posture ([P06]).
                _ => true,
            }
        })
    };
    let pulse_bridge = feeds::pulse::PulseBridge::new(feeds::pulse::PulseBridgeConfig {
        spawner: Arc::new(feeds::pulse::TugpulseSpawner { tugpulse_path }),
        enabled: Arc::clone(&pulse_enabled),
        ledger: Some(Arc::clone(&ledger)),
        code_tx: code_output_feed.sender(),
    });

    let supervisor = Arc::new(supervisor);

    // Rebind persisted ledger rows. Per [F15] this only populates the
    // in-memory ledger — `client_sessions` is left untouched and real
    // clients connecting after startup send their own `spawn_session`
    // CONTROL frames.
    // The join pilot reaches the supervisor through a process-global handle,
    // registered once the supervisor is in its Arc ([P01]).
    supervisor.register_pilot_runner();

    match supervisor.rebind_from_ledger().await {
        Ok(count) if count > 0 => info!(count, "rebound ledger rows on startup"),
        Ok(_) => {}
        Err(e) => warn!(error = %e, "rebind_from_ledger failed (non-fatal)"),
    }

    // Spawn the supervisor's dispatcher task (consumes CODE_INPUT, routes
    // to per-session workers) and merger task (fans in per-session stdout
    // streams and publishes system_metadata to SESSION_SIDEBAND).
    let dispatcher_supervisor = Arc::clone(&supervisor);
    tokio::spawn(async move {
        dispatcher_supervisor.dispatcher_task(code_input_rx).await;
    });
    // Shell dispatcher: routes SHELL_INPUT to per-session pipe-mode shell
    // children, publishes exchange frames on SHELL_OUTPUT, and records each
    // settled exchange to the shell ledger for restore.
    let shell_dispatch_feed = shell_output_feed.clone();
    let shell_dispatch_ledger = shell_ledger.clone();
    // The `$` route's handle on the facts library ([P06]) — the settle site
    // records a `shell` fact, and a `test_run` fact when the command was one.
    let shell_dispatch_sessions = Some(Arc::clone(&ledger));
    let shell_dispatch_agent = Some(Arc::clone(&haiku_agent));
    let shell_dispatch_cancel = cancel.clone();
    tokio::spawn(async move {
        feeds::shell::shell_dispatcher_task(
            shell_input_rx,
            shell_dispatch_feed,
            shell_dispatch_ledger,
            shell_dispatch_sessions,
            shell_dispatch_agent,
            shell_dispatch_cancel,
        )
        .await;
    });
    // Refs dispatcher: routes REFS_INPUT to the match/search ops and streams
    // their numbered result rows back on REFS_OUTPUT.
    let refs_dispatch_feed = refs_output_feed.clone();
    let refs_dispatch_ledger = refs_ledger.clone();
    let refs_dispatch_sessions = Some(Arc::clone(&ledger));
    let refs_dispatch_cancel = cancel.clone();
    tokio::spawn(async move {
        feeds::refs::refs_dispatcher_task(
            refs_input_rx,
            refs_dispatch_feed,
            refs_dispatch_ledger,
            refs_dispatch_sessions,
            refs_dispatch_cancel,
        )
        .await;
    });
    let merger_cancel = cancel.clone();
    let merger_supervisor = Arc::clone(&supervisor);
    tokio::spawn(async move {
        merger_supervisor
            .merger_task(merger_register_rx, merger_cancel)
            .await;
    });

    // Spawn the OS resource sampler: at 1 Hz (gated to live sessions) it
    // walks each session's tugcode subtree and publishes CPU/memory gauge
    // samples onto the ACTIVITY feed ([P08]-[P10], [P20]).
    let sampler_supervisor = Arc::clone(&supervisor);
    let sampler_activity = activity_feed.clone();
    let sampler_cancel = cancel.clone();
    tokio::spawn(async move {
        feeds::activity::resource::run_resource_sampler(
            sampler_supervisor,
            sampler_activity,
            sampler_cancel,
        )
        .await;
    });

    // Build feed router with dynamic registration
    let mut feed_router = FeedRouter::new(
        cli.session.clone(),
        auth.clone(),
        shutdown_tx,
        shared_dev_state.clone(),
    );
    feed_router.shared_agent = Some(Arc::clone(&haiku_agent));

    // Register stream feeds through the trait-mediated path — each feed
    // self-describes its id, lag policy, and channel capacity, and the
    // router creates the channel and spawns the task.
    feed_router.register_stream_feed(Box::new(terminal_feed), cancel.clone());
    // PULSE commentary lines fan out to every connected deck; the tail
    // a reconnecting deck needs comes from the `list_pulse_lines`
    // CONTROL read, not feed replay ([P09]).
    feed_router.register_stream_feed(Box::new(pulse_bridge), cancel.clone());
    // OVERVIEW posts fan out to every connected deck; the tail a reconnecting
    // deck needs comes from the `list_overview_posts` CONTROL read. This call's
    // return value is the only source of the OVERVIEW sender, so the Operator
    // adapter — which publishes user questions and answers on the same feed —
    // is constructed after it.
    let overview_tx = feed_router.register_stream_feed(Box::new(observer_bridge), cancel.clone());

    // Adapter: router sends raw Frames on OVERVIEW_INPUT. Parse `{body,
    // requestId}` and run the Operator pipeline — user post persisted and
    // broadcast first ([P08]), then retrieve → verbs → answer, then the
    // answer post with the request id echoed so the card's pending row can
    // clear. Each question runs in its own task, the USAGE_QUERY shape: two
    // people asking at once are two pipelines, not a queue, and the pool's
    // worker cap is what actually bounds the concurrency.
    let (gz_input_tx, mut gz_input_rx) = mpsc::channel::<Frame>(16);
    let operator_pipeline = Arc::new(feeds::operator::OperatorPipeline {
        ctx: Arc::new(feeds::operator::OperatorContext {
            ledger: Arc::clone(&ledger),
            // The same handle the shell dispatcher records exchanges through;
            // `shell.history` reads them back.
            shell_ledger: shell_ledger.clone(),
            bootstrap_project_dir: bootstrap.project_dir.clone(),
            // Beside the ledger the posts live in, so an instance's history
            // and the pictures in it are one thing to keep or to throw away.
            attachments_dir: tugcore::instance::data_dir().join("overview-attachments"),
            // The search ladder's last rung ([P09]). The same pool the shell
            // classifier and the session headlines use — warm workers, one
            // reviewed job table, and nothing spawned until a search actually
            // comes back empty twice.
            haiku: Some(Arc::clone(&haiku_agent)),
        }),
        pool: Arc::clone(&overview_agent),
        overview_tx: overview_tx.clone(),
    });
    tokio::spawn(async move {
        #[derive(serde::Deserialize)]
        struct RawOverviewInput {
            body: Option<String>,
            #[serde(rename = "requestId", alias = "request_id")]
            request_id: Option<String>,
            /// Images composed with the question — the deck's already
            /// downsampled bytes. Absent on every question typed without one.
            #[serde(default)]
            attachments: Vec<feeds::operator::QuestionAttachment>,
            /// The files the asker pointed at with an `@` atom. Absent on
            /// every question typed without one, and on an older deck's
            /// payload — which is what `default` keeps working.
            #[serde(default)]
            refs: Vec<feeds::operator::QuestionRef>,
        }
        while let Some(frame) = gz_input_rx.recv().await {
            let raw = match serde_json::from_slice::<RawOverviewInput>(&frame.payload) {
                Ok(raw) => raw,
                Err(e) => {
                    warn!(
                        error = %e,
                        payload_len = frame.payload.len(),
                        "OVERVIEW_INPUT: malformed JSON payload"
                    );
                    continue;
                }
            };
            // A question can be a picture and nothing else — "what is this?"
            // is what the screenshot is for — so a missing body is only
            // malformed when nothing was attached either.
            let body = raw.body.unwrap_or_default();
            if body.trim().is_empty() && raw.attachments.is_empty() {
                warn!("OVERVIEW_INPUT: payload carried no body");
                continue;
            }
            let pipeline = Arc::clone(&operator_pipeline);
            tokio::spawn(async move {
                pipeline
                    .handle(body, raw.request_id, raw.attachments, raw.refs)
                    .await;
            });
        }
    });

    // Session synopsis — the SharedAgent's second tenant: one sentence per
    // session saying what it is about, written to the session's ledger row and
    // pushed to every surface showing it. Its own tap on CODE_OUTPUT, its own
    // pacing, and no path back into anything — the digest and the sentence are
    // the whole feature. Every missing precondition (no model, tenant off, an
    // unresolvable session identity) ends the tick silently.
    {
        if let Some(bank) = bank_client.as_ref() {
            shared_agent::carry_synopsis_tenant_forward(bank);
        }
        let synopsis_tenant: Arc<dyn Fn() -> bool + Send + Sync> = {
            let bank = bank_client.clone();
            Arc::new(move || {
                shared_agent::tenant_enabled(bank.as_deref(), shared_agent::SYNOPSIS_KEY)
            })
        };
        let identity = feeds::session_synopsis::SessionIdentity {
            resolver: supervisor.session_resolver(),
            project_dir: {
                let ledger = Arc::clone(&ledger);
                Arc::new(move |tug_id: &str| {
                    ledger.get(tug_id).ok().flatten().map(|row| row.project_dir)
                })
            },
            claude_projects_root: ledger.claude_projects_root().to_path_buf(),
        };
        let synopsis_config = feeds::session_synopsis::SessionSynopsisConfig {
            code_tx: code_output_feed.sender(),
            shell_tx: shell_output_feed.sender(),
            submission_tx: code_submission_tx.clone(),
            ledger: Some(Arc::clone(&ledger)),
            control_tx: Some(client_action_tx.clone()),
            tenant_enabled: synopsis_tenant,
            shared_agent: feed_router.shared_agent.clone(),
            identity,
            clocks: feeds::session_synopsis::Clocks::default(),
        };
        let synopsis_cancel = cancel.clone();
        tokio::spawn(async move {
            feeds::session_synopsis::session_synopsis_task(synopsis_config, synopsis_cancel).await;
        });
    }

    feed_router.register_session_feed(&code_output_feed);
    // SHELL_OUTPUT — session-scoped exchange frames; the reconnect tail comes
    // from the ledger CONTROL read, not feed replay (like PULSE).
    feed_router.register_session_feed(&shell_output_feed);
    // REFS_OUTPUT — session-scoped result frames; like SHELL_OUTPUT, the
    // reconnect state comes from the ledger CONTROL read, not feed replay.
    feed_router.register_session_feed(&refs_output_feed);
    // CONTROL stays a channel-registered stream: router-internal,
    // bidirectional, and the sink for router-emitted error frames — one
    // of the two named exemptions from the feed abstraction.
    feed_router.register_stream(FeedId::CONTROL, client_action_tx, LagPolicy::Warn);
    // SESSION_STATE / SESSION_SIDEBAND are broadcast streams (not snapshot
    // watches) per [D14]: a single watch slot would clobber concurrent
    // per-session updates. Per-session replay on reconnect is handled
    // event-driven inside `AgentSupervisor::handle_control("spawn_session")`
    // — there is no snapshot-watch registration for either feed.
    feed_router.register_session_feed(&session_state_feed);
    feed_router.register_session_feed(&session_sideband_feed);
    // ACTIVITY ([P16]) — a native SessionScopedFeed client. The merger
    // publishes diverted `activity_delta` samples through the handle; the
    // router wires the same broadcast channel into client delivery.
    feed_router.register_session_feed(&activity_feed);

    // Register input sinks (client → server backends). CODE_INPUT points
    // at the supervisor's dispatcher (spawned above); the dispatcher
    // parses `tug_session_id`, consults the ledger, and routes to the
    // per-session worker.
    feed_router.register_input(FeedId::TERMINAL_INPUT, input_tx.clone());
    feed_router.register_input(FeedId::TERMINAL_RESIZE, input_tx);
    feed_router.register_input(FeedId::CODE_INPUT, code_input_relay_tx);
    feed_router.register_input(FeedId::SHELL_INPUT, shell_input_tx);
    feed_router.register_input(FeedId::REFS_INPUT, refs_input_tx);
    feed_router.register_input(FeedId::FILETREE_QUERY, ft_input_tx);
    feed_router.register_input(FeedId::GIT_DIFF_QUERY, gd_input_tx);
    feed_router.register_input(FeedId::GIT_LOG_QUERY, gl_input_tx);
    feed_router.register_input(FeedId::GIT_COMMIT_FILES_QUERY, gcf_input_tx);
    feed_router.register_input(FeedId::USAGE_QUERY, usage_input_tx);
    feed_router.register_input(FeedId::OVERVIEW_INPUT, gz_input_tx);

    // Attach the supervisor to the router so `handle_client` can intercept
    // session-lifecycle CONTROL frames and cross-check CODE_INPUT P5
    // ownership claims against `client_sessions`.
    feed_router.set_supervisor(Arc::clone(&supervisor));

    // Register snapshot watches. `stats_build_rx` is pushed only in debug
    // builds since BuildStatusCollector is gated out of release.
    //
    // `bootstrap.ft_watch_rx` is INCLUDED here even though FILETREE
    // responses now flow primarily through the shared broadcast
    // channel: the watch carries the bootstrap's initial empty
    // `FileTreeSnapshot`, and the router's "deliver latest value on
    // connect" pass for snapshot_watches is what causes the session card
    // to see *any* FILETREE frame before a query has been sent. The
    // session card gates rendering on `feedData.size > 0` across
    // `[CODE_INPUT, CODE_OUTPUT, SESSION_SIDEBAND, FILETREE]`; without
    // this initial empty frame, a brand-new card with no session
    // bound hangs at "Loading..." indefinitely. The broadcast does
    // not solve this on its own — broadcast carries no retained
    // history, so clients connecting after the initial publish miss
    // the empty snapshot.
    //
    // Bootstrap's *subsequent* responses (when a card is bound to the
    // tugtool repo) are written to BOTH the watch and the broadcast,
    // so JS receives them twice. Idempotent — the second parse
    // produces the same snapshot. Per-card workspaces write only to
    // the broadcast (their watches are never registered with the
    // router), so they don't double-publish.
    // Account-global aggregate changeset feed (CHANGESET_ALL, 0x24). One
    // process-level feed composing every open project into a single frame,
    // delivered like the other snapshot feeds (registered once, retained
    // latest value delivered on connect). Replaces the per-workspace
    // CHANGESET delivery, which only ever reached the bootstrap workspace.
    let (changeset_all_tx, changeset_all_rx) =
        tokio::sync::watch::channel(Frame::new(FeedId::CHANGESET_ALL, vec![]));
    let changeset_all_feed = feeds::changeset_all::ChangesetAllFeed::new(
        Arc::clone(&registry),
        Some(Arc::clone(&ledger)),
        Arc::clone(&changeset_all_bump),
    );
    tugcast_core::spawn_snapshot_feed(
        Box::new(changeset_all_feed),
        changeset_all_tx,
        cancel.clone(),
    );

    // The maintained-draft engine ([P21], #draft-engine) taps a CLONE of the
    // aggregate watch receiver — never the bump `Notify` (single waiter) — so
    // it sees every recompute the router does.
    supervisor.start_draft_engine(changeset_all_rx.clone(), cancel.clone());

    // The base-motion engine: replay a dash onto its base the moment the base
    // moves and it is safe to. It subscribes to the same GIT_HEAD broadcast the
    // router fans out, so no new watcher exists; the other two wakes are a
    // workspace opening (the registry) and a turn ending (the supervisor),
    // because a HEAD signal is an edge and the gate refuses to act mid-turn.
    let (workspace_open_tx, workspace_open_rx) = mpsc::channel::<String>(16);
    let (turn_complete_tx, turn_complete_rx) = mpsc::channel::<String>(64);
    registry.set_workspace_open_signal(workspace_open_tx);
    let _ = supervisor.turn_complete_tx.set(turn_complete_tx);
    tokio::spawn(feeds::base_motion::run_base_motion_engine(
        feeds::base_motion::BaseMotionContext {
            registry: Arc::clone(&registry),
            supervisor_ledger: Arc::clone(&supervisor.ledger),
            session_ledger: Some(Arc::clone(&ledger)),
            bump: Arc::clone(&changeset_all_bump),
            // A conflicted replay becomes an ordinary turn: the submission goes
            // down the same CODE_INPUT queue the router feeds, and the opener
            // that makes it visible goes out on CODE_OUTPUT.
            code_input_tx: Some(code_input_tx.clone()),
            code_output: Some(supervisor.code_output.clone()),
            cancel: cancel.clone(),
        },
        gh_response_tx.subscribe(),
        workspace_open_rx,
        turn_complete_rx,
    ));

    // The arc runner: rotate a server-driven dash arc's next stage onto the
    // card it is bound to. Its primary wake is the same idle transition
    // base-motion takes, on a sibling channel because an mpsc has one consumer
    // ([P05]); the aggregate changeset watch is the slower floor, for a stage
    // that died without ever ending a turn.
    let (arc_tick_tx, arc_tick_rx) = mpsc::channel::<String>(64);
    let _ = supervisor.arc_tick_tx.set(arc_tick_tx);
    tokio::spawn(feeds::dash_arc_runner::run_arc_engine(
        feeds::dash_arc_runner::ArcContext {
            supervisor: Arc::clone(&supervisor),
            session_ledger: Arc::clone(&ledger),
            cancel: cancel.clone(),
        },
        arc_tick_rx,
        changeset_all_rx.clone(),
    ));

    // JOTS feed — watches the machine-global `jots.json` and pushes the whole
    // document to every client. The nudge lets `PUT /api/jots` force an
    // immediate rebuild. The migration runs first so a user arriving from a
    // pre-rename build sees their phrasebook in the very first frame.
    let jots_file_path = tug_instance::jots_path();
    jots::migrate_from_snippets(&jots_file_path);
    let (jots_rx, jots_nudge) = feeds::jots::jots_feed(jots_file_path.clone());
    let jots_state = Some(jots::JotsState::new(jots_file_path, jots_nudge));

    let mut snapshot_watches = vec![
        bootstrap.fs_watch_rx.clone(),
        bootstrap.ft_watch_rx.clone(),
        changeset_all_rx,
    ];
    snapshot_watches.extend(stats_watch_rxs);
    if let Some(rx) = defaults_rx {
        snapshot_watches.push(rx);
    }
    snapshot_watches.push(jots_rx);
    // SESSION_SIDEBAND and session_init snapshots moved to supervisor (Step 8).
    feed_router.add_snapshot_watches(snapshot_watches);
    // Multi-workspace FILETREE response stream — registered once. Every
    // connected client subscribes its own broadcast receiver in
    // `ClientState::Live` and forwards every frame to the socket. JS
    // filters by `workspace_key` to dispatch responses to the right
    // card. Per `dash/dev-atoms.md#step-pre-4`.
    feed_router.add_broadcast_senders(vec![
        ft_response_tx,
        gd_response_tx,
        gl_response_tx,
        gh_response_tx,
        gcf_response_tx,
        usage_response_tx,
    ]);

    // Filesystem, filetree, and git feed tasks are owned by the
    // WorkspaceRegistry's bootstrap entry — spawned inside
    // `WorkspaceEntry::new` above; their tasks (and the stats subsystem's,
    // spawned by `spawn_stats_feeds` above) all run through the feed
    // abstraction's spawn paths.

    // The TCP listener is already bound above (right after CLI parse)
    // so the auth state and auth_url could use the actually-bound port.

    // Register with the per-host instance registry. Best-effort: if the
    // registry write fails we log and continue — `tugutil host tell` will
    // not find us, but the runtime is otherwise unaffected.
    register_with_registry(actual_port, &cli.session);

    // Send ready message over control socket
    if let Some(ref mut writer) = control_writer {
        if let Err(e) = writer
            .send_ready(&auth_url, actual_port, std::process::id())
            .await
        {
            eprintln!("tugcast: warning: failed to send ready message: {}", e);
            // Non-fatal: continue without control socket
        }
    }

    // Create response channel and draining task for control socket writes
    let response_tx = if let Some(writer) = control_writer.take() {
        let (tx, mut rx) = mpsc::channel::<String>(4);
        let mut raw_writer = writer.into_inner();

        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            while let Some(msg) = rx.recv().await {
                let _ = raw_writer.write_all(msg.as_bytes()).await;
                let _ = raw_writer.write_all(b"\n").await;
                let _ = raw_writer.flush().await;
            }
            // Channel closed -- task exits
        });

        Some(tx)
    } else {
        None
    };

    // Spawn control socket receive loop
    if let Some(reader) = control_reader {
        let dev_state = shared_dev_state.clone();
        let ctl_stream_outputs = feed_router.stream_outputs.clone();
        let tx = response_tx
            .clone()
            .expect("response_tx must exist when control_reader exists");
        let ctl_pending_evals = feed_router.pending_evals.clone();
        let ctl_pending_asks = feed_router.pending_asks.clone();
        let ctl_shared_agent = feed_router.shared_agent.clone();
        tokio::spawn(reader.run_recv_loop(
            ctl_shutdown_tx,
            ctl_stream_outputs,
            dev_state,
            tx,
            auth.clone(),
            ctl_pending_evals,
            ctl_pending_asks,
            ctl_shared_agent,
        ));
    }

    // Start server and select! on shutdown channel + SIGTERM
    let server_future = server::run_server(
        listener,
        feed_router,
        shared_dev_state,
        bank_client,
        jots_state,
        prompt_ledger,
    );

    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("failed to register SIGTERM handler");
    let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .expect("failed to register SIGINT handler");

    // Watch for parent death (e.g. kill -9 on Tug.app). When our parent PID
    // changes to 1 (launchd/init), the parent is gone and we should exit.
    let parent_pid = unsafe { libc::getppid() };
    let parent_watch = async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let current_ppid = unsafe { libc::getppid() };
            if current_ppid != parent_pid {
                info!(
                    "Parent died (ppid {} → {}), shutting down",
                    parent_pid, current_ppid
                );
                break;
            }
        }
    };

    let exit_code = tokio::select! {
        result = server_future => {
            if let Err(e) = result {
                eprintln!("tugcast: error: server error: {}", e);
                1
            } else {
                0
            }
        }
        Some(code) = shutdown_rx.recv() => {
            info!("shutdown requested with exit code {}", code);
            code as i32
        }
        _ = sigterm.recv() => {
            info!("SIGTERM received, shutting down");
            0
        }
        _ = sigint.recv() => {
            info!("SIGINT received, shutting down");
            0
        }
        _ = parent_watch => {
            0
        }
    };

    // Send shutdown message via response channel (draining task writes to socket)
    if let Some(tx) = response_tx {
        let reason = shutdown_reason_for_exit_code(exit_code);
        let shutdown_json = control::make_shutdown_message(reason, std::process::id());
        let _ = tx.send(shutdown_json).await;
        drop(tx); // Close channel -- draining task exits after writing
    }

    // Clean up the notification socket before shutting down tasks.
    if let Err(e) = std::fs::remove_file(&notify_socket_path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            warn!(error = %e, "failed to remove notification socket");
        }
    }

    // Signal shutdown for background tasks
    cancel.cancel();

    // Remove our entry from the per-host instance registry. Best-effort.
    if let Some(id) = tug_instance::instance_id()
        && let Err(e) = tugcore::registry::unregister(&id)
    {
        warn!(error = %e, "failed to unregister from tug-instances.json");
    }

    // App-test instances own an ephemeral private tmux server
    // (`tmux -L tug-<token>`). Tear it down on shutdown so each throwaway
    // `apptest-<uuid>` launch self-cleans instead of leaking a whole tmux
    // server per run. Dev/release instances deliberately KEEP their
    // server across restarts (tmux session persistence is a feature), so
    // this is gated on the app-test family. Best-effort.
    if let Some(id) = tug_instance::instance_id()
        && tugcore::ports::is_apptest_id(&id)
        && let Some(label) = tug_instance::tmux_socket_label()
    {
        info!(%label, "tearing down ephemeral app-test tmux server");
        let _ = std::process::Command::new(tug_instance::tmux_bin())
            .args(["-L", &label, "kill-server"])
            .status();
    }

    // Kill our entire process group (tugcast + tugcode + children).
    // `std::process::exit` doesn't run destructors, so `kill_on_drop`
    // and async cancellation can't be relied upon — sending SIGTERM
    // to our own pgid is the only mechanism that guarantees tugcode
    // children are signalled regardless of how we got here. tugcode's
    // SIGTERM handler then shuts claude down and exits cleanly. Signalled
    // BEFORE our own ledger flush so every service's flush window runs in
    // parallel — serial flushes would consume the conductor's whole drain
    // deadline with zero headroom. (Our own SIGTERM is absorbed by the
    // still-installed handler; the select above has already resolved.)
    info!("Killing process group before exit");
    unsafe {
        libc::kill(0, libc::SIGTERM);
    }

    // Final ledger flush (graceful-termination protocol, [LR3]/[LR9]):
    // checkpoint the WALs down to the main files so a subsequent open —
    // possibly by a different build — starts from a clean, WAL-less state
    // instead of running recovery. Bounded by the tug-quiesce flush
    // budget, enforced on ourselves: a hung checkpoint must never wedge
    // shutdown into the conductor's SIGKILL — the budget expiring means
    // exit anyway, loudly.
    let (flush_done_tx, flush_done_rx) = std::sync::mpsc::channel::<()>();
    let flush_ledger = Arc::clone(&ledger);
    std::thread::spawn(move || {
        flush_ledger.final_flush();
        let _ = flush_done_tx.send(());
    });
    if flush_done_rx
        .recv_timeout(Duration::from_millis(tugcore::quiesce::FLUSH_BUDGET_MS))
        .is_err()
    {
        tracing::error!(
            budget_ms = tugcore::quiesce::FLUSH_BUDGET_MS,
            "final ledger flush exceeded the quiesce budget; exiting without it"
        );
    }

    info!("tugcast shut down");
    std::process::exit(exit_code);
}

/// One session row to seed. Mirrors `record_spawn`'s arguments.
#[derive(serde::Deserialize)]
struct SeedSession {
    session_id: String,
    workspace_key: String,
    project_dir: String,
    #[serde(default)]
    card_id: String,
    /// Display name for the entry's title, applied via `rename`.
    #[serde(default)]
    name: Option<String>,
    /// The session's callsign. Written by `record_spawn` exactly as the real
    /// spawn path writes it, so a seeded session is addressable by the name a
    /// citation or a session atom carries.
    #[serde(default)]
    tag: Option<String>,
    /// The dash this session is mated to, as `(owner key, short name)`.
    ///
    /// Applied through the same `set_dash_binding` a real `bind_dash` uses, so
    /// the seeded row is indistinguishable from a bound one — which is what
    /// makes it possible to stand up "another live session is holding this
    /// dash" without launching a second card and a second agent.
    #[serde(default)]
    dash_id: Option<String>,
    #[serde(default)]
    dash_name: Option<String>,
    /// The session this one was rewind-forked from, written through the same
    /// `set_fork_provenance` the fork arc uses. This is the edge every durable
    /// ink read resolves along, so seeding it is how a test can stand up the
    /// post-fork ledger state a relaunch actually binds to — without needing a
    /// live `claude` to perform a real fork.
    #[serde(default)]
    forked_from_session_id: Option<String>,
    /// The prompt uuid of the rewind point. Only meaningful alongside
    /// `forked_from_session_id`; a placeholder is fine, since nothing reads it
    /// except a human looking at the row.
    #[serde(default)]
    fork_point: Option<String>,
}

/// One file event to seed, with the sub-file evidence that decides whether
/// two owners of the path contend ([P12]). `spans` is optional and flattened
/// alongside the row's own fields, so a spec written before spans existed
/// still reads.
#[derive(serde::Deserialize)]
struct SeedFileEvent {
    #[serde(flatten)]
    row: session_ledger::FileEventRow,
    #[serde(default)]
    spans: Vec<session_ledger::FileEventSpan>,
}

/// The seed spec's whole shape: live sessions and the file events that make
/// them own something.
#[derive(serde::Deserialize)]
struct SeedSpec {
    #[serde(default)]
    sessions: Vec<SeedSession>,
    #[serde(default)]
    file_events: Vec<SeedFileEvent>,
}

/// Seed this instance's ledger from a JSON spec and exit.
///
/// The app-test harness's pre-launch hook, and the answer to a gap that had
/// been recorded as unreachable: a `sessions` row is written only by the real
/// spawn path (`session_init` from a live tugcode subprocess), so an app-test
/// could compose *unattributed* changeset rows but never a **session entry** —
/// leaving every affordance that hangs off one uncovered.
///
/// Writing through the real [`SessionLedger`] rather than raw SQL is the whole
/// point: the schema, the migrations, and the change journal come along, so a
/// seeded ledger is one the server would have written itself. A hand-mirrored
/// `CREATE TABLE` in the harness would drift the first time the schema moved.
///
/// **Refused outside an app-test instance.** The gate is the instance id, the
/// same signal the janitor and the startup sweep already trust: seeding is a
/// test affordance, and pointing it at a developer's real ledger would forge
/// attribution rows in the ledger the Changes card reads.
fn seed_ledger(spec_path: &std::path::Path) -> ! {
    let instance = tugcore::instance::instance_id();
    if !instance
        .as_deref()
        .is_some_and(tugcore::ports::is_apptest_id)
    {
        eprintln!(
            "tugcast: error: --seed-ledger requires an app-test instance \
             (TUG_INSTANCE_ID is {:?}); refusing to seed a real ledger",
            instance.as_deref().unwrap_or("<unset>")
        );
        std::process::exit(2);
    }

    let raw = match std::fs::read_to_string(spec_path) {
        Ok(raw) => raw,
        Err(e) => {
            eprintln!(
                "tugcast: error: cannot read seed spec {}: {e}",
                spec_path.display()
            );
            std::process::exit(1);
        }
    };
    let spec: SeedSpec = match serde_json::from_str(&raw) {
        Ok(spec) => spec,
        Err(e) => {
            eprintln!("tugcast: error: malformed seed spec: {e}");
            std::process::exit(1);
        }
    };

    let Some(path) = SessionLedger::default_path() else {
        eprintln!("tugcast: error: cannot resolve the session ledger path");
        std::process::exit(1);
    };
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("tugcast: error: cannot create {}: {e}", parent.display());
            std::process::exit(1);
        }
    }
    // Port 0: the seeder serves nothing, and the value only rides the row's
    // liveness bookkeeping.
    let ledger = match SessionLedger::open(&path, 0) {
        Ok(l) => l,
        Err(e) => {
            eprintln!(
                "tugcast: error: cannot open the ledger at {}: {e}",
                path.display()
            );
            std::process::exit(1);
        }
    };

    let now = session_ledger::now_millis();
    for session in &spec.sessions {
        if let Err(e) = ledger.record_spawn(
            &session.session_id,
            &session.workspace_key,
            &session.project_dir,
            &session.card_id,
            now,
            session.tag.as_deref(),
        ) {
            eprintln!("tugcast: error: record_spawn failed: {e}");
            std::process::exit(1);
        }
        if let Some(name) = session.name.as_deref() {
            if let Err(e) = ledger.rename(&session.session_id, Some(name)) {
                eprintln!("tugcast: error: rename failed: {e}");
                std::process::exit(1);
            }
        }
        if let Some(parent) = session.forked_from_session_id.as_deref() {
            // A seeded row's fork point passes through as it was given,
            // including absent: the column takes `NULL` now, so a stand-in
            // value would be inventing a branch point the seed never named.
            if let Err(e) = ledger.set_fork_provenance(
                &session.session_id,
                parent,
                session.fork_point.as_deref(),
            ) {
                eprintln!("tugcast: error: set_fork_provenance failed: {e}");
                std::process::exit(1);
            }
        }
        if let Some(dash_id) = session.dash_id.as_deref() {
            let dash_name = session.dash_name.as_deref().unwrap_or(dash_id);
            if let Err(e) = ledger.set_dash_binding(&session.session_id, Some((dash_id, dash_name)))
            {
                eprintln!("tugcast: error: set_dash_binding failed: {e}");
                std::process::exit(1);
            }
        }
    }
    for event in &spec.file_events {
        if let Err(e) = ledger.record_file_event_with_spans(&event.row, &event.spans) {
            eprintln!("tugcast: error: record_file_event failed: {e}");
            std::process::exit(1);
        }
    }

    println!(
        "seeded {} session(s) and {} file event(s) into {}",
        spec.sessions.len(),
        spec.file_events.len(),
        path.display()
    );
    std::process::exit(0);
}

/// Run the tugbank notification socket listener.
///
/// Binds a Unix datagram socket at `path`, receives domain names as datagrams,
/// and calls `client.refresh_domain()` with 50ms per-domain debounce.
async fn run_notify_listener(path: PathBuf, client: Arc<TugbankClient>, cancel: CancellationToken) {
    // Remove stale socket from a previous run.
    let _ = std::fs::remove_file(&path);

    // Bind the socket (std UnixDatagram, then wrap for tokio).
    let std_sock = match std::os::unix::net::UnixDatagram::bind(&path) {
        Ok(s) => s,
        Err(e) => {
            warn!(error = %e, path = %path.display(), "failed to bind notification socket");
            return;
        }
    };
    std_sock.set_nonblocking(true).unwrap();
    let sock = match tokio::net::UnixDatagram::from_std(std_sock) {
        Ok(s) => s,
        Err(e) => {
            warn!(error = %e, "failed to convert notification socket to tokio");
            return;
        }
    };

    info!(path = %path.display(), "tugbank notification socket listening");

    let mut buf = [0u8; 512];
    let debounce_ms = Duration::from_millis(50);
    let mut pending: HashMap<String, tokio::time::Instant> = HashMap::new();

    loop {
        // Wait for the next datagram or a debounce timer to fire.
        let next_deadline = pending.values().copied().min();

        tokio::select! {
            _ = cancel.cancelled() => {
                info!("notification listener shutting down");
                break;
            }
            result = sock.recv(&mut buf) => {
                match result {
                    Ok(n) => {
                        if let Ok(domain) = std::str::from_utf8(&buf[..n]) {
                            let domain = domain.to_owned();
                            // Reset the debounce timer for this domain.
                            pending.insert(domain, tokio::time::Instant::now() + debounce_ms);
                        }
                    }
                    Err(e) => {
                        warn!(error = %e, "notification socket recv error");
                    }
                }
            }
            _ = async {
                match next_deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                // At least one debounce timer has fired. Drain all ready domains.
            }
        }

        // Drain any domains whose debounce timer has expired.
        let now = tokio::time::Instant::now();
        let ready: Vec<String> = pending
            .iter()
            .filter(|(_, deadline)| **deadline <= now)
            .map(|(domain, _)| domain.clone())
            .collect();
        for domain in ready {
            pending.remove(&domain);
            info!(domain = %domain, "tugbank domain changed — refreshing");
            client.refresh_domain(&domain);
        }
    }
}

/// Probe whether `127.0.0.1:port` accepts an immediate bind.
///
/// Used as the `is_free` predicate for `tugcore::ports::allocate_port`.
/// Synchronous `std::net::TcpListener` is enough — the probe happens
/// once during startup before the tokio runtime claims the port. The
/// listener drops immediately after the probe, releasing the port; a
/// successful probe is *not* a reservation, so a tight race window
/// remains between probe and the real bind. That race is acceptable
/// at Step 11; Step 12 turns the post-bind EADDRINUSE into a clean
/// exit with registry-derived diagnostics.
fn tcp_port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Register the running tugcast instance with the per-host registry.
///
/// Best-effort: a write failure is logged but does not abort startup.
/// The registry is read-only metadata for external tools — its
/// absence is recoverable, its corruption never blocks tugcast.
fn register_with_registry(actual_port: u16, tmux_session: &str) {
    let Some(id) = tug_instance::instance_id() else {
        return; // Standalone launch; no registry entry.
    };
    let bundle_path = tug_instance::bundle_path_from_env().unwrap_or_default();
    // Best-effort split of `<profile>-<branch-slug>`.
    let (profile, branch) = id
        .split_once('-')
        .map(|(p, b)| (p.to_owned(), b.to_owned()))
        .unwrap_or_else(|| (id.clone(), String::new()));
    let instance = tugcore::registry::Instance {
        instance_id: id.clone(),
        profile,
        branch,
        bundle_id: std::env::var("TUG_BUNDLE_ID").unwrap_or_default(),
        bundle_path,
        pid: std::process::id() as i32,
        // The parent process is the GUI host (`Tug.app`) that spawned
        // tugcast. Recording it lets `tugutil host instance stop` tear down
        // the host app — tugcast then follows via its parent-watch
        // (see the parent_watch loop in `run`). `0` if somehow already
        // reparented (no live GUI host to signal).
        host_pid: {
            let ppid = unsafe { libc::getppid() };
            if ppid > 1 { ppid } else { 0 }
        },
        tugcast_port: actual_port,
        vite_port: 0,
        tmux_session: tmux_session.to_owned(),
        data_dir: tug_instance::data_dir(),
        started_at: tugcore::registry::now_rfc3339(),
    };
    if let Err(e) = tugcore::registry::register(instance) {
        warn!(error = %e, "failed to register with tug-instances.json (continuing)");
    } else {
        info!(instance_id = %id, "registered with tug-instances.json");
    }
}

/// Reclaim our derived port from a stale *same-instance* tugcast zombie.
///
/// Identity-gated on purpose: we kill the port holder ONLY when the
/// registry confirms it is our own (same `TUG_INSTANCE_ID`) previously
/// registered tugcast that failed to unregister. A holder belonging to
/// another instance, or any unrelated process that merely happens to sit
/// on the port, is never signalled — that blind `kill` was a
/// cross-instance footgun (an app-test launch could SIGKILL a live dev
/// instance). When we can't prove ownership we leave the holder alone
/// and let the normal `allocate_port` walk / EADDRINUSE path handle it.
fn force_kill_port_holder(port: u16) {
    // Without an identity we can't prove a holder is ours — do nothing.
    let Some(our_id) = tug_instance::instance_id() else {
        return;
    };
    // The only PID we're entitled to reclaim is the one the registry
    // recorded for THIS instance id (a stale/zombie self).
    let our_pid = match tugcore::registry::find_by_id(&our_id) {
        Ok(Some(entry)) => entry.pid,
        _ => return, // nothing registered for us → nothing to reclaim
    };

    let output = std::process::Command::new("lsof")
        .args(["-ti", &format!("tcp:{}", port)])
        .output();
    let pids = match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => return, // No process holding the port, or lsof not available.
    };

    for pid_str in pids.lines() {
        let Ok(pid) = pid_str.trim().parse::<i32>() else {
            continue;
        };
        if pid == our_pid {
            eprintln!(
                "tugcast: --force: reclaiming port {port} from our stale instance (PID {pid})"
            );
            reclaim_stale_process(pid);
        } else {
            warn!(
                pid,
                port,
                instance_id = %our_id,
                "--force: port holder is not our registered instance; not killing"
            );
        }
    }

    // Brief wait for the port to be released.
    std::thread::sleep(Duration::from_millis(100));
}

/// Reclaim a stale same-instance tugcast on the `tug-quiesce` ladder:
/// SIGTERM first so it runs its own shutdown (the ledger flush in
/// particular), then SIGKILL only what is still alive after
/// [`tugcore::quiesce::STALE_RECLAIM_GRACE_MS`]. Kill-first was the last
/// place in tugcast that denied a Tug service its flush window.
fn reclaim_stale_process(pid: i32) {
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
    let deadline =
        std::time::Instant::now() + Duration::from_millis(tugcore::quiesce::STALE_RECLAIM_GRACE_MS);
    while std::time::Instant::now() < deadline {
        // `kill(pid, 0)` sends no signal; only ESRCH means it is gone —
        // any other errno (EPERM) means the process still exists.
        if unsafe { libc::kill(pid, 0) } != 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            eprintln!("tugcast: --force: stale instance (PID {pid}) exited on SIGTERM");
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    eprintln!(
        "tugcast: --force: stale instance (PID {pid}) still alive after {}ms — SIGKILL",
        tugcore::quiesce::STALE_RECLAIM_GRACE_MS
    );
    unsafe {
        libc::kill(pid, libc::SIGKILL);
    }
}

/// Map exit code to shutdown reason string
fn shutdown_reason_for_exit_code(code: i32) -> &'static str {
    match code {
        0 => "normal",
        42 => "restart",
        43 => "reset",
        45 => "relaunch",
        _ => "error",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shutdown_reason_for_exit_code_normal() {
        assert_eq!(shutdown_reason_for_exit_code(0), "normal");
    }

    #[test]
    fn test_shutdown_reason_for_exit_code_restart() {
        assert_eq!(shutdown_reason_for_exit_code(42), "restart");
    }

    #[test]
    fn test_shutdown_reason_for_exit_code_reset() {
        assert_eq!(shutdown_reason_for_exit_code(43), "reset");
    }

    #[test]
    fn test_shutdown_reason_for_exit_code_relaunch() {
        assert_eq!(shutdown_reason_for_exit_code(45), "relaunch");
    }

    #[test]
    fn test_shutdown_reason_for_exit_code_error() {
        assert_eq!(shutdown_reason_for_exit_code(1), "error");
        assert_eq!(shutdown_reason_for_exit_code(-1), "error");
        assert_eq!(shutdown_reason_for_exit_code(99), "error");
    }
}
