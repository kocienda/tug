mod actions;
mod arc_api;
mod attachments;
mod auth;
mod background_session;
mod boot;
mod changes_journal;
mod changes_writer;
mod cli;
mod client_fault;
mod control;
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
mod ink_backfill;
mod jots;
mod ledger_integrity;
mod panic_hook;
/// Crate-root path utilities (firmlink/synthetic/symlink resolution). Lives
/// at the root, not under `feeds/`, because both `feeds` (file watching) and
/// `session_ledger` (storage) depend on it — keeping it a leaf avoids a
/// storage→feeds back-reference.
mod path_resolver;
mod permissions;
mod prompt_history_api;
mod prompt_ledger;
mod prompt_lineage;
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
mod wheel;
mod workspace_api;

#[cfg(test)]
mod integration_tests;
#[cfg(test)]
mod live_corpus;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};
use tugbank_core::TugbankClient;

/// tugcast's startup, as the sequence of its stages. Each stage takes what
/// the ones before it produced; the order is the server's (see `boot`).
#[tokio::main]
async fn main() {
    let boot::Early {
        log_guard: _log_guard,
        cli,
    } = boot::early(tuglog::init("tugcast")).await;
    let mut bound = boot::bind(&cli).await;
    let streams = boot::streams(&cli);
    let ledgers = boot::ledgers(bound.actual_port, &bound.bank_path);
    let feeds = boot::feeds(
        &cli,
        &bound.bank_path,
        bound.control_socket.take(),
        &ledgers,
        streams,
    );
    let ink = boot::ink_ledgers(&ledgers.ledger);
    let runtime = boot::supervisor(&cli, bound, ledgers, ink, feeds).await;
    let shutdown = boot::serve(runtime).await;
    boot::shutdown(shutdown).await
}

/// Create a directory tugcast is about to write into, reporting a failure
/// once, at startup, with the path.
///
/// A data directory that cannot be created is a startup fault. Discarding the
/// error only defers it to the first write into the directory, which then
/// fails with a message that names a file and not the cause.
fn ensure_data_dir(dir: &std::path::Path) {
    if let Err(e) = std::fs::create_dir_all(dir) {
        error!(error = %e, path = %dir.display(), "cannot create data directory");
    }
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
