//! `boot::bind` — claim the port, the bank path, the tmux session, the auth
//! token, and the control socket, in that order.

use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Duration;

use tokio::net::TcpListener;
use tracing::{info, warn};
use tugcore::instance as tug_instance;

use crate::auth::{self, SharedAuthState};
use crate::cli;
use crate::control;
use crate::feeds::terminal;

/// Everything the later stages read from what this one claimed.
pub(crate) struct Bound {
    /// The listener the HTTP server will accept on, bound before auth state
    /// exists so the auth allowlist names the port actually bound.
    pub(crate) listener: TcpListener,
    /// The port the listener is on — the request, unless that was 0.
    pub(crate) actual_port: u16,
    /// Where tugbank lives; opened later, by the stage that reads it.
    pub(crate) bank_path: PathBuf,
    pub(crate) auth: SharedAuthState,
    /// The token-exchange URL the ready message hands the app.
    pub(crate) auth_url: String,
    /// The app's control socket, when it launched us with one.
    pub(crate) control_socket: Option<control::ControlSocket>,
}

/// Refuse a duplicate launch, bind the listener, write the bundle-path
/// marker, resolve the bank path, check tmux and its session, create auth
/// state, and connect the control socket. Every failure here is fatal and
/// exits the process.
pub(crate) async fn bind(cli: &cli::Cli) -> Bound {
    let claimed = claim_port(
        cli.force,
        tug_instance::instance_id(),
        || requested_port(cli.port, tug_instance::instance_id),
        |id| tugcore::registry::find_by_id(id).ok().flatten(),
        mark_bundle_path,
    )
    .await;
    let (listener, actual_port) = match claimed {
        Ok(bound) => bound,
        Err(Refusal::Duplicate {
            id,
            existing,
            collision,
        }) => {
            // Exit code 73 (`EX_CANTCREAT`) signals "structurally cannot
            // create" — the Swift supervisor recognizes it as a duplicate
            // and does not retry the spawn.
            eprintln!(
                "tugcast: another '{id}' instance is already running (PID {})",
                existing.pid
            );
            let what = if collision {
                "duplicate-launch collision; exiting EX_CANTCREAT (73)"
            } else {
                "duplicate-launch refused; exiting EX_CANTCREAT (73)"
            };
            warn!(
                instance_id = %id,
                pid = existing.pid,
                port = existing.tugcast_port,
                "{what}"
            );
            std::process::exit(73);
        }
        Err(Refusal::Bind { port, error }) => {
            eprintln!("tugcast: error: failed to bind to 127.0.0.1:{port}: {error}");
            std::process::exit(1);
        }
    };
    info!(port = actual_port, "tugcast server listening");

    let bank_path = resolve_bank_path(
        cli.bank_path.clone(),
        std::env::var_os("TUGBANK_PATH"),
        tug_instance::tugbank_db_path,
    );

    // Ensure the parent directory exists. The per-instance data dir
    // (`~/Library/Application Support/Tug/instances/<id>/`) is not
    // created until first launch — TugbankClient::open would
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

    let (auth, auth_url) = auth_for(actual_port, cli.no_auth);
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

    Bound {
        listener,
        actual_port,
        bank_path,
        auth,
        auth_url,
        control_socket,
    }
}

/// Why this launch may not claim its port.
#[derive(Debug)]
enum Refusal {
    /// A live tugcast already holds this identity. `collision` when it was
    /// found only after the bind failed, rather than by the pre-bind check.
    Duplicate {
        id: String,
        existing: Box<tugcore::registry::Instance>,
        collision: bool,
    },
    /// The bind failed for any other reason.
    Bind { port: u16, error: std::io::Error },
}

/// Pass the duplicate-launch guard, bind the listener, and only then `mark`.
///
/// The guard (per [D07]) runs twice. Before binding: when the identity is
/// set and `find` lists a live tugcast for it, refuse *before* binding any
/// port, since the walker in `allocate_port` would otherwise step to the
/// next free port and let a second tugcast cohabit. `force` skips this
/// check, for harness rigs that kill the previous process first, and kills
/// whatever holds the port instead. After a failed bind: on `EADDRINUSE`,
/// `find` is consulted again, and a live entry makes it a collision.
///
/// `mark` writes the bundle-path marker and runs only once both have
/// passed and the listener is bound. A refused launch shares its identity,
/// and so its data dir, with the running instance, so writing earlier
/// would replace that instance's marker with the refused bundle's path.
///
/// The listener is bound here, before auth state is constructed, so the
/// auth allowlist and ready message name the port actually bound, which
/// differs from the request only when that was 0.
async fn claim_port(
    force: bool,
    instance_id: Option<String>,
    requested_port: impl FnOnce() -> u16,
    find: impl Fn(&str) -> Option<tugcore::registry::Instance>,
    mark: impl FnOnce(),
) -> Result<(TcpListener, u16), Refusal> {
    if !force
        && let Some(id) = &instance_id
        && let Some(existing) = find(id)
    {
        return Err(Refusal::Duplicate {
            id: id.clone(),
            existing: Box::new(existing),
            collision: false,
        });
    }

    let port = requested_port();
    if force {
        force_kill_port_holder(port);
    }

    match bind_listener(port).await {
        Ok(bound) => {
            mark();
            Ok(bound)
        }
        Err(error) => {
            if error.kind() == std::io::ErrorKind::AddrInUse
                && let Some(id) = instance_id
                && let Some(existing) = find(&id)
            {
                return Err(Refusal::Duplicate {
                    id,
                    existing: Box::new(existing),
                    collision: true,
                });
            }
            Err(Refusal::Bind { port, error })
        }
    }
}

/// Write the per-instance bundle-path marker, which anchors `tugtool host
/// instance prune`'s orphan detection. Swift passes `TUG_INSTANCE_ID` and
/// `TUG_BUNDLE_PATH`; with either unset (standalone harness launches, dev
/// iteration) nothing is written.
fn mark_bundle_path() {
    match tug_instance::write_bundle_path_marker() {
        Ok(tug_instance::MarkerWrite::Written) => info!("bundle-path marker written"),
        Ok(tug_instance::MarkerWrite::Unchanged | tug_instance::MarkerWrite::Skipped) => {}
        Err(e) => warn!(error = %e, "failed to write bundle-path marker"),
    }
}

/// Resolve the port we *want* to bind. Three branches:
/// - `--port <P>` explicit: use it (incl. 0 for OS-ephemeral)
/// - No --port + TUG_INSTANCE_ID set: derive per-instance port
///   via FNV-1a hash, walk on collision, fall back to ephemeral
/// - No --port + no identity: legacy single-instance default 55255
fn requested_port(flag: Option<u16>, instance_id: impl FnOnce() -> Option<String>) -> u16 {
    match flag {
        Some(p) => p,
        None => match instance_id() {
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
    }
}

/// Bind `127.0.0.1:<port>` and report the port actually bound, which differs
/// from the request only when the request was 0.
async fn bind_listener(port: u16) -> std::io::Result<(TcpListener, u16)> {
    let listener = TcpListener::bind(format!("127.0.0.1:{port}")).await?;
    let actual_port = listener.local_addr().map(|a| a.port()).unwrap_or(port);
    Ok((listener, actual_port))
}

/// Resolve bank path: --bank-path flag > TUGBANK_PATH env var >
/// per-instance `tugcore::instance::tugbank_db_path()` (when
/// TUG_INSTANCE_ID is set) > legacy `~/.tugbank.db`. Harness tests
/// that set TUGBANK_PATH still take precedence over the per-instance
/// path so a synthetic identity can be pointed at a temp DB. An empty
/// TUGBANK_PATH counts as unset.
fn resolve_bank_path(
    flag: Option<PathBuf>,
    env: Option<OsString>,
    instance_path: impl FnOnce() -> Option<PathBuf>,
) -> PathBuf {
    flag.or_else(|| env.map(PathBuf::from).filter(|p| !p.as_os_str().is_empty()))
        .or_else(instance_path)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()))
                .join(".tugbank.db")
        })
}

/// Create auth state for the bound port, and the token-exchange URL that
/// carries its token. With --no-auth, the token exchange and cookie still
/// work normally (so the app loads fine), but WebSocket validation is skipped
/// so external tools can connect without a session cookie.
fn auth_for(port: u16, no_auth: bool) -> (SharedAuthState, String) {
    let auth = if no_auth {
        auth::new_shared_auth_state_no_auth(port)
    } else {
        auth::new_shared_auth_state(port)
    };
    let token = auth.lock().token().unwrap().to_string();
    let auth_url = format!("http://127.0.0.1:{port}/auth?token={token}");
    (auth, auth_url)
}

/// Probe whether `127.0.0.1:port` accepts an immediate bind.
///
/// Used as the `is_free` predicate for `tugcore::ports::allocate_port`.
/// Synchronous `std::net::TcpListener` is enough — the probe happens
/// once during startup before the tokio runtime claims the port. The
/// listener drops immediately after the probe, releasing the port; a
/// successful probe is *not* a reservation, so a tight race window
/// remains between probe and the real bind. A post-bind EADDRINUSE is
/// a clean exit with registry-derived diagnostics.
fn tcp_port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn port_zero_binds_an_ephemeral_port_and_reports_it() {
        let (listener, actual_port) = bind_listener(0).await.expect("bind port 0");
        assert_ne!(actual_port, 0);
        assert_eq!(listener.local_addr().unwrap().port(), actual_port);
    }

    #[tokio::test]
    async fn a_held_port_fails_with_addr_in_use() {
        let (_held, port) = bind_listener(0).await.expect("bind port 0");
        let err = bind_listener(port)
            .await
            .expect_err("second bind must fail");
        assert_eq!(err.kind(), std::io::ErrorKind::AddrInUse);
    }

    /// A registry entry for `id`, as a running instance would have written it.
    fn running(id: &str) -> tugcore::registry::Instance {
        tugcore::registry::Instance {
            instance_id: id.to_string(),
            profile: "release".to_string(),
            branch: "main".to_string(),
            bundle_id: "dev.tugapp.app".to_string(),
            bundle_path: PathBuf::from("/Applications/Tug.app"),
            pid: 4242,
            host_pid: 4241,
            tugcast_port: 55312,
            vite_port: 0,
            tmux_session: "tug".to_string(),
            data_dir: PathBuf::from("/tmp/Tug/instances/release-main"),
            started_at: "2026-11-17T00:00:00Z".to_string(),
        }
    }

    /// A marker file holding the running instance's bundle path, and a
    /// `mark` that overwrites it with this launch's path, as the real write
    /// would.
    fn marker() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("bundle-path");
        std::fs::write(&path, "/Applications/Tug.app").expect("seed marker");
        (dir, path)
    }

    fn mark_into(path: &std::path::Path) -> impl FnOnce() + '_ {
        move || std::fs::write(path, "/Users/me/DerivedData/Tug.app").expect("write marker")
    }

    #[tokio::test]
    async fn a_launch_refused_before_binding_leaves_the_marker_untouched() {
        let (_dir, path) = marker();
        let refused = claim_port(
            false,
            Some("release-main".to_string()),
            || panic!("a refused launch must not pick a port"),
            |id| Some(running(id)),
            mark_into(&path),
        )
        .await;
        assert!(matches!(
            refused,
            Err(Refusal::Duplicate {
                collision: false,
                ..
            })
        ));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "/Applications/Tug.app"
        );
    }

    #[tokio::test]
    async fn a_launch_refused_as_a_collision_leaves_the_marker_untouched() {
        let (_dir, path) = marker();
        let (_held, port) = bind_listener(0).await.expect("bind port 0");
        // Not registered at the pre-bind check, registered by the time the
        // bind fails: the race the second check exists for.
        let lookups = std::cell::Cell::new(0);
        let refused = claim_port(
            false,
            Some("release-main".to_string()),
            || port,
            |id| {
                lookups.set(lookups.get() + 1);
                (lookups.get() > 1).then(|| running(id))
            },
            mark_into(&path),
        )
        .await;
        assert!(matches!(
            refused,
            Err(Refusal::Duplicate {
                collision: true,
                ..
            })
        ));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "/Applications/Tug.app"
        );
    }

    #[tokio::test]
    async fn an_accepted_launch_writes_the_marker_once_bound() {
        let (_dir, path) = marker();
        let (_listener, port) = claim_port(
            false,
            Some("release-main".to_string()),
            || 0,
            |_| None,
            mark_into(&path),
        )
        .await
        .expect("an unregistered identity is accepted");
        assert_ne!(port, 0);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "/Users/me/DerivedData/Tug.app"
        );
    }

    #[tokio::test]
    async fn a_held_port_without_a_registered_instance_is_a_bind_failure() {
        let (_dir, path) = marker();
        let (_held, port) = bind_listener(0).await.expect("bind port 0");
        let refused = claim_port(
            false,
            Some("release-main".to_string()),
            || port,
            |_| None,
            mark_into(&path),
        )
        .await;
        assert!(matches!(refused, Err(Refusal::Bind { port: p, .. }) if p == port));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "/Applications/Tug.app"
        );
    }

    #[test]
    fn an_explicit_port_is_used_without_consulting_the_identity() {
        let port = requested_port(Some(0), || panic!("identity must not be read"));
        assert_eq!(port, 0);
        assert_eq!(requested_port(Some(41234), || None), 41234);
    }

    #[test]
    fn no_port_and_no_identity_is_the_legacy_default() {
        assert_eq!(requested_port(None, || None), 55255);
    }

    #[test]
    fn bank_path_flag_beats_env_beats_instance() {
        let flag = Some(PathBuf::from("/flag/bank.db"));
        let env = Some(OsString::from("/env/bank.db"));
        let instance = || Some(PathBuf::from("/instance/bank.db"));
        assert_eq!(
            resolve_bank_path(flag, env.clone(), instance),
            PathBuf::from("/flag/bank.db")
        );
        assert_eq!(
            resolve_bank_path(None, env, instance),
            PathBuf::from("/env/bank.db")
        );
        assert_eq!(
            resolve_bank_path(None, None, instance),
            PathBuf::from("/instance/bank.db")
        );
    }

    #[test]
    fn an_empty_bank_env_counts_as_unset() {
        let path = resolve_bank_path(None, Some(OsString::new()), || {
            Some(PathBuf::from("/instance/bank.db"))
        });
        assert_eq!(path, PathBuf::from("/instance/bank.db"));
    }

    #[test]
    fn with_nothing_named_the_bank_is_the_legacy_home_file() {
        let path = resolve_bank_path(None, None, || None);
        assert_eq!(path.file_name().unwrap(), ".tugbank.db");
    }

    #[tokio::test]
    async fn auth_url_names_the_bound_port_and_the_token() {
        let (_listener, port) = bind_listener(0).await.expect("bind port 0");
        for no_auth in [false, true] {
            let (auth, url) = auth_for(port, no_auth);
            let token = auth.lock().token().unwrap().to_string();
            assert!(!token.is_empty());
            assert_eq!(url, format!("http://127.0.0.1:{port}/auth?token={token}"));
        }
    }
}
