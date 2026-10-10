//! `boot::shutdown` — everything that runs once the server has stopped.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use tugcore::instance as tug_instance;

use crate::control;
use crate::session_ledger::SessionLedger;

/// What shutdown needs from the running server.
pub(crate) struct Shutdown {
    /// The code the process exits with, decided by whatever ended the serve.
    pub(crate) exit_code: i32,
    /// The control socket's write channel, when the app launched us with one.
    pub(crate) response_tx: Option<mpsc::Sender<String>>,
    /// The tugbank notification socket, removed before tasks are cancelled.
    pub(crate) notify_socket_path: PathBuf,
    /// The process-wide token every background task runs under.
    pub(crate) cancel: CancellationToken,
    /// The session ledger, given its final flush last.
    pub(crate) ledger: Arc<SessionLedger>,
}

/// Tell the app why we are going, cancel the background tasks, unregister,
/// tear down an app-test tmux server, signal the process group, flush the
/// ledger, and exit.
pub(crate) async fn shutdown(s: Shutdown) -> ! {
    let Shutdown {
        exit_code,
        response_tx,
        notify_socket_path,
        cancel,
        ledger,
    } = s;

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
    // parallel — serial flushes would consume the wheel's whole drain
    // deadline with zero headroom. (Our own SIGTERM is absorbed by the
    // still-installed handler; the select in serve has already resolved.)
    info!("Killing process group before exit");
    unsafe {
        libc::kill(0, libc::SIGTERM);
    }

    // Final ledger flush (graceful-termination protocol, [LR3]/[LR9]):
    // checkpoint the WALs down to the main files so a subsequent open —
    // possibly by a different build — starts from a clean, WAL-less state
    // instead of running recovery. Bounded by the tug-quiesce flush
    // budget, enforced on ourselves: a hung checkpoint must never wedge
    // shutdown into the wheel's SIGKILL — the budget expiring means
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
