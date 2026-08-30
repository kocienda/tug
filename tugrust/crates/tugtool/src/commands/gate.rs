//! `tugtool host gate` — machine-wide mutual exclusion via a localhost port.
//!
//! The mutex is a `TcpListener` bound to one well-known port
//! (`tugcore::ports::gate_port`). Binding is exclusive by kernel
//! construction; the kernel frees the port on any holder death,
//! including SIGKILL — there is no lock file and no stale state to
//! recover.
//!
//! While holding, an accept loop answers every incoming connection
//! with one JSON greeting line (`{"gate","label","pid","since"}`) and
//! then keeps the connection open. A would-be acquirer that loses the
//! bind race connects, reads the greeting (live holder metadata — it
//! cannot be stale: readable implies alive), prints a single wait
//! line, and then blocks reading the open connection until EOF. The
//! holder's exit closes every connection, so waiters wake
//! event-driven, with no polling, and race to re-bind.
//!
//! A listener that answers with anything other than a valid greeting
//! for the requested gate name is an unrelated process squatting the
//! port: the acquirer fails fast naming the port and what it read —
//! it never waits on a non-gate listener.
//!
//! `SO_REUSEADDR` is set on the bind: on macOS/BSD it lets a fresh
//! holder bind past `TIME_WAIT` remnants from waiter connections
//! without permitting a second simultaneous listener (that would take
//! `SO_REUSEPORT`, which is never set).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::os::fd::FromRawFd;
use std::process::Command;
use std::time::Duration;

use clap::Subcommand;
use serde::{Deserialize, Serialize};

#[derive(Subcommand, Debug)]
pub enum GateCommands {
    /// Run a command while holding the named gate exclusively.
    ///
    /// Acquires the gate's well-known localhost port, runs the
    /// command with inherited stdio, and exits with the command's
    /// exit code. If the gate is held, waits for release (or fails
    /// immediately with --no-wait).
    Run {
        /// Gate name (resolves to a reserved port, e.g. `apptest`).
        #[arg(long)]
        name: String,

        /// Holder label shown to waiters (e.g. the worktree slug).
        #[arg(long, default_value = "")]
        label: String,

        /// Fail immediately (exit 2) instead of waiting when the
        /// gate is held.
        #[arg(long)]
        no_wait: bool,

        /// The command to run while holding the gate.
        #[arg(last = true, required = true)]
        command: Vec<String>,
    },
}

/// The one-line JSON greeting a holder serves to every connection.
#[derive(Serialize, Deserialize, Debug)]
struct Greeting {
    gate: String,
    label: String,
    pid: u32,
    since: String,
}

/// Exit code when `--no-wait` finds the gate held. Distinct from the
/// child's own exit codes only by convention — callers that need to
/// distinguish should use `--no-wait` + `--json`.
const EXIT_HELD: i32 = 2;
const EXIT_USAGE: i32 = 64;

pub fn run_gate(cmd: GateCommands, json: bool, _quiet: bool) -> i32 {
    match cmd {
        GateCommands::Run {
            name,
            label,
            no_wait,
            command,
        } => run_gated(&name, &label, no_wait, &command, json),
    }
}

fn run_gated(name: &str, label: &str, no_wait: bool, command: &[String], json: bool) -> i32 {
    // Test hook: integration tests gate on a scratch port so they can
    // never contend with a real `apptest` gate on this machine.
    let override_port = std::env::var("TUG_GATE_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok());
    let Some(port) = override_port.or_else(|| tugcore::ports::gate_port(name)) else {
        eprintln!("tugtool host gate: unknown gate name '{name}' (known: apptest)");
        return EXIT_USAGE;
    };

    loop {
        match bind_reuseaddr(port) {
            Ok(listener) => return hold_and_run(listener, name, label, command),
            Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
                match read_holder(port) {
                    HolderProbe::Holder(greeting) if greeting.gate == name => {
                        if no_wait {
                            report_held(&greeting, json);
                            return EXIT_HELD;
                        }
                        // `read_holder` left the connection open inside
                        // the greeting; wait_for_release consumed it.
                        // (We re-connect here for clarity of ownership.)
                        eprintln!(
                            "gate '{}' held by {} (pid {}, since {}) — waiting…",
                            name,
                            display_label(&greeting.label),
                            greeting.pid,
                            greeting.since
                        );
                        wait_for_release(port);
                        // Loop back and race to bind.
                    }
                    HolderProbe::Holder(other) => {
                        eprintln!(
                            "tugtool host gate: port {port} is held by gate '{}' (expected '{name}') — refusing to wait",
                            other.gate
                        );
                        return 1;
                    }
                    HolderProbe::NotAGate(detail) => {
                        eprintln!(
                            "tugtool host gate: port {port} is held by something that is not a tugtool gate ({detail}) — refusing to wait"
                        );
                        return 1;
                    }
                    HolderProbe::Vanished => {
                        // Holder exited between our bind attempt and the
                        // probe — race to bind again immediately.
                    }
                }
            }
            Err(err) => {
                eprintln!("tugtool host gate: bind 127.0.0.1:{port} failed: {err}");
                return 1;
            }
        }
    }
}

/// Bind `127.0.0.1:<port>` with `SO_REUSEADDR`, via libc so the option
/// is set BEFORE the bind (std's `TcpListener::bind` offers no hook).
fn bind_reuseaddr(port: u16) -> std::io::Result<TcpListener> {
    unsafe {
        let fd = libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0);
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // FD_CLOEXEC is load-bearing: without it the gated child
        // inherits this listener, and a SIGKILLed gate would leave the
        // port bound by its orphaned child — a wedged gate, the exact
        // failure mode the port design exists to make impossible.
        if libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) < 0 {
            let err = std::io::Error::last_os_error();
            libc::close(fd);
            return Err(err);
        }
        let one: libc::c_int = 1;
        if libc::setsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_REUSEADDR,
            std::ptr::addr_of!(one).cast(),
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        ) < 0
        {
            let err = std::io::Error::last_os_error();
            libc::close(fd);
            return Err(err);
        }
        // `sockaddr_in` is laid out differently across platforms: the BSDs
        // (incl. macOS) carry a leading `sin_len` byte that Linux lacks.
        // Zero-init and set only the portable fields; `sin_len`, when present,
        // is set behind a cfg so the struct literal stays cross-platform.
        let mut addr: libc::sockaddr_in = std::mem::zeroed();
        addr.sin_family = libc::AF_INET as libc::sa_family_t;
        addr.sin_port = port.to_be();
        addr.sin_addr = libc::in_addr {
            s_addr: u32::from(Ipv4Addr::LOCALHOST).to_be(),
        };
        #[cfg(any(
            target_os = "macos",
            target_os = "ios",
            target_os = "freebsd",
            target_os = "openbsd",
            target_os = "netbsd",
            target_os = "dragonfly"
        ))]
        {
            addr.sin_len = std::mem::size_of::<libc::sockaddr_in>() as u8;
        }
        if libc::bind(
            fd,
            std::ptr::addr_of!(addr).cast(),
            std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t,
        ) < 0
        {
            let err = std::io::Error::last_os_error();
            libc::close(fd);
            return Err(err);
        }
        if libc::listen(fd, 16) < 0 {
            let err = std::io::Error::last_os_error();
            libc::close(fd);
            return Err(err);
        }
        Ok(TcpListener::from_raw_fd(fd))
    }
}

/// Hold the gate: serve greetings on a background thread, run the
/// command, propagate its exit code. Everything closes when this
/// process exits — the kernel releases the port unconditionally.
fn hold_and_run(listener: TcpListener, name: &str, label: &str, command: &[String]) -> i32 {
    let greeting = Greeting {
        gate: name.to_string(),
        label: label.to_string(),
        pid: std::process::id(),
        since: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    };
    let line = serde_json::to_string(&greeting).expect("greeting serializes");

    std::thread::spawn(move || {
        // Held connections accumulate here so waiters stay connected
        // (their EOF *is* our exit). Bounded by the number of
        // concurrent waiters — single digits in practice.
        let mut held: Vec<TcpStream> = Vec::new();
        for conn in listener.incoming() {
            let Ok(mut stream) = conn else { continue };
            let _ = stream.write_all(line.as_bytes());
            let _ = stream.write_all(b"\n");
            let _ = stream.flush();
            held.push(stream);
        }
    });

    let (program, args) = command.split_first().expect("clap enforces non-empty");
    match Command::new(program).args(args).status() {
        Ok(status) => {
            if let Some(code) = status.code() {
                code
            } else {
                // Killed by a signal: conventional 128 + signo.
                use std::os::unix::process::ExitStatusExt;
                128 + status.signal().unwrap_or(0)
            }
        }
        Err(err) => {
            eprintln!("tugtool host gate: failed to spawn '{program}': {err}");
            127
        }
    }
}

enum HolderProbe {
    Holder(Greeting),
    NotAGate(String),
    Vanished,
}

/// Connect to the gate port and read the holder's greeting line.
fn read_holder(port: u16) -> HolderProbe {
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let stream = match TcpStream::connect_timeout(&addr.into(), Duration::from_secs(2)) {
        Ok(s) => s,
        Err(_) => return HolderProbe::Vanished,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(0) | Err(_) => return HolderProbe::NotAGate("no greeting line".to_string()),
        Ok(_) => {}
    }
    match serde_json::from_str::<Greeting>(line.trim_end()) {
        Ok(greeting) => HolderProbe::Holder(greeting),
        Err(_) => HolderProbe::NotAGate(format!("read {:?}", truncate(line.trim_end(), 80))),
    }
}

/// Block until the current holder exits: connect, swallow the
/// greeting, then read until EOF (the kernel closes the connection
/// with the holder). Connection failures mean the holder is already
/// gone — return immediately and let the caller race to bind.
fn wait_for_release(port: u16) {
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let Ok(mut stream) = TcpStream::connect_timeout(&addr.into(), Duration::from_secs(2)) else {
        return;
    };
    // No read timeout: this read IS the wait.
    let _ = stream.set_read_timeout(None);
    let mut sink = [0u8; 256];
    loop {
        match stream.read(&mut sink) {
            Ok(0) | Err(_) => return, // EOF or reset: holder gone.
            Ok(_) => {}
        }
    }
}

fn report_held(greeting: &Greeting, json: bool) {
    if json {
        let body = serde_json::json!({
            "schema_version": "1",
            "command": "gate run",
            "status": "held",
            "data": {
                "gate": greeting.gate,
                "label": greeting.label,
                "pid": greeting.pid,
                "since": greeting.since,
            },
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&body).expect("serializes")
        );
    } else {
        eprintln!(
            "gate '{}' held by {} (pid {}, since {})",
            greeting.gate,
            display_label(&greeting.label),
            greeting.pid,
            greeting.since
        );
    }
}

fn display_label(label: &str) -> &str {
    if label.is_empty() {
        "<unlabeled>"
    } else {
        label
    }
}

fn truncate(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Bind an ephemeral port the same way the gate does, returning
    /// the listener and its port.
    fn bind_ephemeral() -> (TcpListener, u16) {
        let listener = bind_reuseaddr(0).expect("ephemeral bind");
        let port = listener.local_addr().expect("addr").port();
        (listener, port)
    }

    #[test]
    fn reuseaddr_bind_is_exclusive_against_live_listener() {
        let (_listener, port) = bind_ephemeral();
        let second = bind_reuseaddr(port);
        assert!(second.is_err(), "second live listener must be refused");
        assert_eq!(second.unwrap_err().kind(), std::io::ErrorKind::AddrInUse);
    }

    #[test]
    fn holder_greeting_round_trips() {
        let (listener, port) = bind_ephemeral();
        let line = serde_json::to_string(&Greeting {
            gate: "apptest".into(),
            label: "wt".into(),
            pid: 42,
            since: "2026-01-01T00:00:00Z".into(),
        })
        .unwrap();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut s) = conn else { continue };
                let _ = s.write_all(line.as_bytes());
                let _ = s.write_all(b"\n");
                break;
            }
        });
        match read_holder(port) {
            HolderProbe::Holder(g) => {
                assert_eq!(g.gate, "apptest");
                assert_eq!(g.label, "wt");
                assert_eq!(g.pid, 42);
            }
            other => panic!("expected holder, got {}", probe_name(&other)),
        }
    }

    #[test]
    fn non_gate_listener_is_rejected_not_waited_on() {
        let (listener, port) = bind_ephemeral();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut s) = conn else { continue };
                let _ = s.write_all(b"HTTP/1.1 400 Bad Request\r\n");
                break;
            }
        });
        match read_holder(port) {
            HolderProbe::NotAGate(_) => {}
            other => panic!("expected NotAGate, got {}", probe_name(&other)),
        }
    }

    #[test]
    fn vanished_holder_reports_vanished() {
        // Nothing listening on this port: bind ephemeral, learn the
        // port, drop the listener.
        let port = {
            let (listener, port) = bind_ephemeral();
            drop(listener);
            port
        };
        match read_holder(port) {
            HolderProbe::Vanished => {}
            other => panic!("expected vanished, got {}", probe_name(&other)),
        }
    }

    #[test]
    fn waiter_wakes_on_holder_exit_eof() {
        let (listener, port) = bind_ephemeral();
        let handle = std::thread::spawn(move || {
            // Accept one connection, hold it briefly, then drop
            // listener + connection (simulates holder exit).
            let (mut stream, _) = listener.accept().expect("accept");
            let _ =
                stream.write_all(b"{\"gate\":\"t\",\"label\":\"\",\"pid\":1,\"since\":\"now\"}\n");
            std::thread::sleep(Duration::from_millis(150));
            // stream + listener drop here → waiter sees EOF.
        });
        let start = std::time::Instant::now();
        wait_for_release(port);
        handle.join().expect("holder thread");
        // The waiter must have blocked until the holder dropped —
        // i.e. roughly the hold duration, not an immediate return.
        assert!(start.elapsed() >= Duration::from_millis(100));
    }

    fn probe_name(p: &HolderProbe) -> &'static str {
        match p {
            HolderProbe::Holder(_) => "Holder",
            HolderProbe::NotAGate(_) => "NotAGate",
            HolderProbe::Vanished => "Vanished",
        }
    }
}
