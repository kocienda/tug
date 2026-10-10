//! `boot::serve` — announce ourselves, serve HTTP, and wait for whatever ends
//! the run.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use tugbank_core::TugbankClient;
use tugcore::instance as tug_instance;

use crate::auth::SharedAuthState;
use crate::boot::Shutdown;
use crate::control;
use crate::dev::SharedDevState;
use crate::jots::JotsState;
use crate::prompt_ledger::PromptLedger;
use crate::router::FeedRouter;
use crate::server;
use crate::session_ledger::SessionLedger;

/// The running server: everything [`serve`] hands to the HTTP server and the
/// control socket, and everything [`Shutdown`] needs once it stops.
pub(crate) struct Runtime {
    pub(crate) listener: TcpListener,
    pub(crate) actual_port: u16,
    /// The tmux session name, recorded in the instance registry.
    pub(crate) tmux_session: String,
    pub(crate) auth: SharedAuthState,
    pub(crate) auth_url: String,
    pub(crate) control_writer: Option<control::ControlWriter>,
    pub(crate) control_reader: Option<control::ControlReader>,
    /// The control socket's handle on the shutdown channel.
    pub(crate) ctl_shutdown_tx: mpsc::Sender<u8>,
    /// Receives the exit code a control command or the router asks for.
    pub(crate) shutdown_rx: mpsc::Receiver<u8>,
    pub(crate) feed_router: FeedRouter,
    pub(crate) shared_dev_state: SharedDevState,
    pub(crate) bank_client: Option<Arc<TugbankClient>>,
    pub(crate) jots_state: Option<Arc<JotsState>>,
    pub(crate) prompt_ledger: Option<Arc<PromptLedger>>,
    pub(crate) ledger: Arc<SessionLedger>,
    pub(crate) notify_socket_path: PathBuf,
    pub(crate) cancel: CancellationToken,
}

/// Register with the instance registry, tell the app we are ready, wire the
/// control socket, and serve until the server fails, a shutdown is
/// requested, a signal arrives, or the parent dies. Returns what shutdown
/// needs, carrying the exit code that end decided.
pub(crate) async fn serve(runtime: Runtime) -> Shutdown {
    let Runtime {
        listener,
        actual_port,
        tmux_session,
        auth,
        auth_url,
        mut control_writer,
        control_reader,
        ctl_shutdown_tx,
        mut shutdown_rx,
        feed_router,
        shared_dev_state,
        bank_client,
        jots_state,
        prompt_ledger,
        ledger,
        notify_socket_path,
        cancel,
    } = runtime;

    // Register with the per-host instance registry. Best-effort: if the
    // registry write fails we log and continue — `tugtool host tell` will
    // not find us, but the runtime is otherwise unaffected.
    register_with_registry(actual_port, &tmux_session);

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
        prompt_ledger.map(|prompts| server::PromptHistoryDeps {
            ledger: prompts,
            sessions: Some(Arc::clone(&ledger)),
        }),
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

    Shutdown {
        exit_code,
        response_tx,
        notify_socket_path,
        cancel,
        ledger,
    }
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
        // tugcast. Recording it lets `tugtool host instance stop` tear down
        // the host app — tugcast then follows via its parent-watch
        // (see the parent_watch loop in `serve`). `0` if somehow already
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
