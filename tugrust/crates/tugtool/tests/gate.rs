//! Process-level tests for `tugtool host gate run` — exclusivity, exit-code
//! propagation, and kernel-owned release on holder death.
//!
//! Every test gates on its own scratch port via the `TUG_GATE_PORT`
//! hook so the suite can never contend with a real `apptest` gate (or
//! with itself across parallel test threads).

use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

mod common;
use common::tugtool;

/// Find a free port by binding an ephemeral listener and dropping it.
/// Racy in principle; fine for a test that uses it immediately.
fn scratch_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("ephemeral bind");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);
    port
}

fn gate_cmd(port: u16, extra: &[&str], command: &[&str]) -> Command {
    let mut cmd = tugtool();
    cmd.env("TUG_GATE_PORT", port.to_string())
        .args(["host", "gate", "run", "--name", "apptest"])
        .args(extra)
        .arg("--")
        .args(command)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

/// Poll until something is listening on `port` (the holder is up).
fn wait_for_listener(port: u16) {
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr.into(), Duration::from_millis(200)).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("holder never started listening on {port}");
}

fn spawn_holder(port: u16, hold_secs: &str) -> Child {
    let child = gate_cmd(port, &["--label", "holder-wt"], &["sleep", hold_secs])
        .spawn()
        .expect("spawn holder");
    wait_for_listener(port);
    child
}

#[test]
fn propagates_child_exit_code() {
    let port = scratch_port();
    let status = gate_cmd(port, &[], &["sh", "-c", "exit 7"])
        .status()
        .expect("run");
    assert_eq!(status.code(), Some(7));

    let ok = gate_cmd(port, &[], &["true"]).status().expect("run");
    assert_eq!(ok.code(), Some(0));
}

#[test]
fn no_wait_fails_fast_and_names_the_holder() {
    let port = scratch_port();
    let mut holder = spawn_holder(port, "5");

    let out = gate_cmd(port, &["--no-wait"], &["true"])
        .output()
        .expect("run no-wait");
    assert_eq!(out.status.code(), Some(2), "held gate must exit 2");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("holder-wt"),
        "stderr must name the holder label, got: {stderr}"
    );

    holder.kill().expect("kill holder");
    let _ = holder.wait();
}

#[test]
fn blocking_acquirer_proceeds_after_holder_exits() {
    let port = scratch_port();
    let mut holder = spawn_holder(port, "0.4");

    let start = Instant::now();
    let status = gate_cmd(port, &[], &["true"]).status().expect("run waiter");
    assert_eq!(status.code(), Some(0));
    // The waiter must have actually queued behind the holder.
    assert!(
        start.elapsed() >= Duration::from_millis(200),
        "waiter returned too fast to have waited: {:?}",
        start.elapsed()
    );

    let _ = holder.wait();
}

#[test]
fn sigkill_releases_the_gate_immediately() {
    let port = scratch_port();
    let mut holder = spawn_holder(port, "60");

    holder.kill().expect("SIGKILL holder");
    let _ = holder.wait();

    // The kernel closed the listener with the process: a fresh
    // acquirer binds without any cleanup step.
    let start = Instant::now();
    let status = gate_cmd(port, &[], &["true"]).status().expect("run");
    assert_eq!(status.code(), Some(0));
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "acquire after SIGKILL should be immediate, took {:?}",
        start.elapsed()
    );
}

#[test]
fn non_gate_listener_is_rejected_not_waited_on() {
    let port = scratch_port();
    // A squatter that says nothing gate-shaped.
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("squatter bind");
    std::thread::spawn(move || {
        use std::io::Write;
        for conn in listener.incoming() {
            let Ok(mut s) = conn else { continue };
            let _ = s.write_all(b"HTTP/1.1 400 nope\r\n");
        }
    });

    let start = Instant::now();
    let out = gate_cmd(port, &[], &["true"]).output().expect("run");
    assert_eq!(
        out.status.code(),
        Some(1),
        "squatted port must fail, not wait"
    );
    assert!(
        start.elapsed() < Duration::from_secs(5),
        "must fail fast, took {:?}",
        start.elapsed()
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("not a tugtool gate"),
        "stderr must explain the squatter, got: {stderr}"
    );
}
