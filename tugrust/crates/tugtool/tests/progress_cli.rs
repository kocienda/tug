//! `tugtool progress`, driven through the real binary against a stand-in
//! tugcast.
//!
//! What is pinned is the telemetry contract: the report reaches the instance
//! as the `run_progress` op with every field, and in every other case — no
//! calling session, an instance that never answers, an instance too old to
//! know the op — the verb is silent and exits 0, quickly. A recipe that
//! reports must never be slowed or failed by reporting.

mod common;
use common::tugtool;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Output};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// How the stand-in answers.
#[derive(Clone, Copy)]
enum Answer {
    /// `ok`, attached to a block.
    Ok,
    /// Accepts the connection, reads the request, and never answers.
    Never,
    /// An instance older than the op.
    UnknownOp,
}

/// A stand-in tugcast answering as `answer` says, handing every request
/// body back over a channel.
fn fake_tugcast(answer: Answer) -> (u16, mpsc::Receiver<serde_json::Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut held = Vec::new();
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut length = 0usize;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    break;
                }
                if let Some(value) = line
                    .to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .and_then(|v| v.trim().parse::<usize>().ok())
                {
                    length = value;
                }
                if line == "\r\n" || line == "\n" {
                    break;
                }
            }
            let mut body = vec![0u8; length];
            let _ = reader.read_exact(&mut body);
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&body) {
                let _ = tx.send(value);
            }
            let (status, payload) = match answer {
                Answer::Ok => (
                    "200 OK",
                    r#"{"status":"ok","session_id":"seg-1","attached":"block","tool_use_id":"toolu_X"}"#,
                ),
                Answer::UnknownOp => (
                    "400 Bad Request",
                    r#"{"status":"error","message":"unknown op 'run_progress'"}"#,
                ),
                Answer::Never => {
                    held.push(stream);
                    continue;
                }
            };
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                payload.len()
            );
            let _ = stream.write_all(payload.as_bytes());
            let _ = stream.flush();
        }
    });
    (port, rx)
}

/// Write an instance registry naming `port` under `tmp` (the child's
/// `$TMPDIR`). The pid is this test's own, so the liveness filter keeps it.
fn register_fake_instance(tmp: &Path, port: u16) {
    let registry = serde_json::json!({
        "version": 1,
        "instances": [{
            "instance_id": "debug-test",
            "profile": "debug",
            "branch": "main",
            "bundle_id": "com.example.test",
            "bundle_path": tmp.join("Tug.app"),
            "pid": std::process::id(),
            "host_pid": 0,
            "tugcast_port": port,
            "vite_port": 0,
            "tmux_session": "cc-debug-test",
            "data_dir": tmp.join("data"),
            "started_at": "2026-08-13T00:00:00Z",
        }],
    });
    std::fs::write(
        tmp.join("tug-instances.json"),
        serde_json::to_vec(&registry).unwrap(),
    )
    .unwrap();
}

/// `tugtool progress` isolated to `tmp`'s registry, with no inherited session
/// or tool-use id — each test says which it has.
fn progress(tmp: &Path) -> Command {
    let mut cmd = tugtool();
    cmd.env("TMPDIR", tmp);
    cmd.env("TUG_DATA_DIR", tmp.join("state"));
    cmd.env_remove("TUG_SESSION_ID");
    cmd.env_remove("TUG_TOOL_USE_ID");
    cmd.env_remove("CLAUDE_CODE_TOOL_USE_ID");
    cmd.current_dir(tmp);
    cmd.arg("progress");
    cmd
}

/// Run it, and assert the contract every case shares: exit 0, nothing said.
fn silent(cmd: &mut Command) -> (Output, Duration) {
    let started = Instant::now();
    let out = cmd.output().unwrap();
    let took = started.elapsed();
    assert_eq!(out.status.code(), Some(0), "progress always exits 0");
    assert!(
        out.stdout.is_empty() && out.stderr.is_empty(),
        "progress never prints: {:?} / {:?}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    (out, took)
}

fn scratch() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap();
    (dir, path)
}

#[test]
fn a_report_reaches_the_instance_with_every_field() {
    let (_dir, tmp) = scratch();
    let (port, requests) = fake_tugcast(Answer::Ok);
    register_fake_instance(&tmp, port);

    silent(progress(&tmp).env("TUG_SESSION_ID", "seg-0").args([
        "--label",
        "app-test",
        "--done",
        "7",
        "--total",
        "20",
        "--needle",
        "just app-test",
        "at0603 PASS",
    ]));

    let body = requests.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        body,
        serde_json::json!({
            "op": "run_progress",
            "tug_session_id": "seg-0",
            "label": "app-test",
            "text": "at0603 PASS",
            "done": 7,
            "total": 20,
            "needles": ["just app-test"],
        })
    );
}

#[test]
fn a_tool_use_id_in_the_environment_rides_the_report() {
    let (_dir, tmp) = scratch();
    let (port, requests) = fake_tugcast(Answer::Ok);
    register_fake_instance(&tmp, port);

    silent(
        progress(&tmp)
            .env("TUG_SESSION_ID", "seg-0")
            .env("TUG_TOOL_USE_ID", "toolu_X")
            .arg("compiling tugcast"),
    );

    let body = requests.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(body["tool_use_id"], "toolu_X");
}

/// A plain terminal, a fixture, a foreign project: nobody to report to, so
/// nothing is sent and nothing is waited on.
///
/// The stand-in never answers, so a verb that called it at all would sit out
/// the whole bounded timeout. Wall time alone cannot prove "no I/O" here: a
/// spawned process costs most of half a second under a parallel run.
#[test]
fn with_no_calling_session_nothing_is_sent() {
    let (_dir, tmp) = scratch();
    let (port, requests) = fake_tugcast(Answer::Never);
    register_fake_instance(&tmp, port);

    let (_, took) = silent(progress(&tmp).arg("compiling tugcast"));
    assert!(
        took < Duration::from_millis(1500),
        "no session, yet it waited on an instance: took {took:?}"
    );
    assert!(
        requests.recv_timeout(Duration::from_millis(200)).is_err(),
        "the stand-in saw a request"
    );
}

#[test]
fn an_instance_that_never_answers_cannot_stall_the_reporter() {
    let (_dir, tmp) = scratch();
    let (port, _requests) = fake_tugcast(Answer::Never);
    register_fake_instance(&tmp, port);

    let (_, took) = silent(
        progress(&tmp)
            .env("TUG_SESSION_ID", "seg-0")
            .arg("compiling tugcast"),
    );
    assert!(took < Duration::from_secs(2), "took {took:?}");
}

#[test]
fn an_instance_too_old_to_know_the_op_is_shrugged_off() {
    let (_dir, tmp) = scratch();
    let (port, requests) = fake_tugcast(Answer::UnknownOp);
    register_fake_instance(&tmp, port);

    silent(
        progress(&tmp)
            .env("TUG_SESSION_ID", "seg-0")
            .arg("compiling tugcast"),
    );
    assert_eq!(
        requests.recv_timeout(Duration::from_secs(5)).unwrap()["op"],
        "run_progress"
    );
}

/// `build-app`'s phase calls, as the recipe makes them, against a stand-in
/// instance: one line per phase, and the verb posts the whole run as phase
/// rows each time — what the recipe's own JSON builder used to send.
#[test]
fn build_app_phase_calls_post_the_run_as_phase_rows() {
    let (_dir, tmp) = scratch();
    let (port, requests) = fake_tugcast(Answer::Ok);
    register_fake_instance(&tmp, port);
    let phases = ["Rust debug binaries", "tugdeck build", "re-sign"];
    let phase = |n: usize| {
        let name = phases.get(n).copied().unwrap_or("built");
        let mut cmd = progress(&tmp);
        cmd.env("TUG_SESSION_ID", "seg-0")
            .args(["phase", "build-app", &n.to_string(), name, "--of"])
            .args(phases)
            .args(["--needle", "just build-app", "--needle", "just app-test"]);
        silent(&mut cmd);
        requests.recv_timeout(Duration::from_secs(5)).unwrap()
    };

    let body = phase(0);
    assert_eq!(body["op"], "run_progress");
    assert_eq!(body["label"], "build-app");
    assert_eq!(body["unit"], "phase");
    assert_eq!(body["text"], "Rust debug binaries");
    assert_eq!(
        (body["done"].as_u64(), body["total"].as_u64()),
        (Some(0), Some(3))
    );
    assert_eq!(
        body["needles"],
        serde_json::json!(["just build-app", "just app-test"])
    );
    let units = body["units"].as_array().unwrap();
    assert_eq!(units.len(), 3);
    assert_eq!(units[0]["status"], "running");
    assert!(units[0]["started_at_ms"].as_i64().unwrap() > 0);
    assert_eq!(
        units[1],
        serde_json::json!({"name": "tugdeck build", "status": "pending", "index": 1})
    );

    let body = phase(1);
    let units = body["units"].as_array().unwrap();
    assert_eq!(body["done"], 1);
    assert_eq!(units[0]["status"], "pass");
    assert!(units[0]["secs"].is_number(), "{units:?}");
    assert_eq!(units[1]["status"], "running");
    assert_eq!(units[2]["status"], "pending");

    let body = phase(3);
    assert_eq!(body["text"], "built");
    assert_eq!(body["done"], 3);
    let statuses: Vec<&str> = body["units"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["status"].as_str().unwrap())
        .collect();
    assert_eq!(statuses, ["pass", "pass", "pass"]);

    // The recipe run again under the same label starts a fresh run.
    let body = phase(0);
    assert_eq!(body["done"], 0);
    assert_eq!(body["units"][1]["status"], "pending");
}

/// A loop over items, as a shell script writes it: one `progress unit` line
/// per move, and every call posts the whole run as rows.
#[test]
fn a_unit_loop_posts_the_run_as_rows_on_every_call() {
    let (_dir, tmp) = scratch();
    let (port, requests) = fake_tugcast(Answer::Ok);
    register_fake_instance(&tmp, port);
    let call = |args: &[&str]| {
        let mut cmd = progress(&tmp);
        cmd.env("TUG_SESSION_ID", "seg-0").arg("unit").args(args);
        silent(&mut cmd);
        requests.recv_timeout(Duration::from_secs(5)).unwrap()
    };

    let body = call(&[
        "plan",
        "checks",
        "--unit",
        "file",
        "--jobs",
        "2",
        "--needle",
        "make check",
        "--medians",
        "4",
        "-",
        "--of",
        "a.sh",
        "b.sh",
    ]);
    assert_eq!(body["op"], "run_progress");
    assert_eq!(body["label"], "checks");
    assert_eq!(body["text"], "2 files");
    assert_eq!(body["unit"], "file");
    assert_eq!(body["jobs"], 2);
    assert_eq!(body["needles"], serde_json::json!(["make check"]));
    assert_eq!(
        (
            body["done"].as_u64(),
            body["total"].as_u64(),
            body["failures"].as_u64()
        ),
        (Some(0), Some(2), Some(0))
    );
    assert_eq!(
        body["units"],
        serde_json::json!([
            {"name": "a.sh", "status": "pending", "index": 0, "median": 4.0},
            {"name": "b.sh", "status": "pending", "index": 1},
        ])
    );

    let body = call(&["start", "checks", "a.sh"]);
    assert_eq!(body["text"], "a.sh started");
    assert_eq!(body["units"][0]["status"], "running");
    assert!(body["units"][0]["started_at_ms"].as_i64().unwrap() > 0);
    assert_eq!(body["units"][0]["median"], 4.0);

    let body = call(&[
        "done",
        "checks",
        "a.sh",
        "fail",
        "--secs",
        "3",
        "--passed",
        "1",
        "--total",
        "2",
        "--title",
        "b breaks",
        "--message",
        "expected 1",
    ]);
    assert_eq!(body["text"], "a.sh FAIL (1/2) 3s");
    assert_eq!(
        (body["done"].as_u64(), body["failures"].as_u64()),
        (Some(1), Some(1))
    );
    let row = &body["units"][0];
    assert_eq!(row["status"], "fail");
    assert_eq!(
        (row["passed"].as_u64(), row["total"].as_u64()),
        (Some(1), Some(2))
    );
    assert_eq!(row["secs"], 3);
    assert_eq!(row["title"], "b breaks");
    assert_eq!(row["message"], "expected 1");
    assert_eq!(body["units"][1]["status"], "pending");

    let body = call(&["finish", "checks", "1 failed"]);
    assert_eq!(body["text"], "1 failed");
    assert_eq!(body["unit"], "file");
    assert_eq!(body["jobs"], 2);
    assert_eq!(body["needles"], serde_json::json!(["make check"]));
    assert_eq!(
        (
            body["done"].as_u64(),
            body["total"].as_u64(),
            body["failures"].as_u64()
        ),
        (Some(1), Some(2), Some(1))
    );
    assert_eq!(body["units"].as_array().unwrap().len(), 2);
}

/// With no calling session a unit loop keeps nothing and sends nothing.
#[test]
fn a_unit_loop_with_no_calling_session_keeps_nothing() {
    let (_dir, tmp) = scratch();
    let (port, requests) = fake_tugcast(Answer::Never);
    register_fake_instance(&tmp, port);
    for args in [
        &["plan", "checks", "--of", "a", "b"][..],
        &["start", "checks", "a"],
        &["done", "checks", "a", "wedged"],
        &["amend", "checks", "a", "--history", "red before"],
        &["finish", "checks"],
    ] {
        silent(progress(&tmp).arg("unit").args(args));
    }
    assert!(
        !tmp.join("tug-progress-unit").exists(),
        "state was kept with nobody to report to"
    );
    assert!(
        requests.recv_timeout(Duration::from_millis(200)).is_err(),
        "the stand-in saw a request"
    );
}

/// `progress gaps` reads the machine-global record tugcast writes, through
/// the same redirect every harness sets, ranking heads by count then time.
#[test]
fn gaps_lists_the_record_by_head_and_an_absent_record_is_empty() {
    use tugcore::run_gaps::{GapRow, RunGaps};
    let (_dir, tmp) = scratch();
    let db = tmp.join("run_gaps.db");

    let empty = progress(&tmp)
        .env("TUG_RUN_GAPS_DB", &db)
        .arg("gaps")
        .output()
        .unwrap();
    assert!(empty.status.success());
    assert!(String::from_utf8_lossy(&empty.stdout).contains("no long unreported runs"));

    let gaps = RunGaps::open(&db).unwrap();
    let row = |head: &str, wall_ms: i64| GapRow {
        head: head.into(),
        command: format!("{head} …"),
        project_dir: "/proj".into(),
        session_id: "seg-0".into(),
        wall_ms,
        ended_at_ms: 1_000,
    };
    gaps.record(&row("just build-app", 125_000)).unwrap();
    gaps.record(&row("cargo nextest", 30_000)).unwrap();
    gaps.record(&row("cargo nextest", 45_000)).unwrap();
    drop(gaps);

    let out = progress(&tmp)
        .env("TUG_RUN_GAPS_DB", &db)
        .arg("gaps")
        .output()
        .unwrap();
    assert!(out.status.success());
    let text = String::from_utf8_lossy(&out.stdout);
    let lines: Vec<&str> = text.lines().collect();
    assert!(lines[1].starts_with("2 "), "{text}");
    assert!(lines[1].ends_with("cargo nextest"), "{text}");
    assert!(lines[1].contains(" 75s "), "{text}");
    assert!(lines[2].contains(" 2m 05s "), "{text}");
    assert!(lines[2].ends_with("just build-app"), "{text}");

    let out = progress(&tmp)
        .env("TUG_RUN_GAPS_DB", &db)
        .args(["--json", "gaps"])
        .output()
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(json["data"]["gaps"][0]["head"], "cargo nextest");
    assert_eq!(json["data"]["gaps"][0]["count"], 2);
    assert_eq!(json["data"]["gaps"][0]["totalMs"], 75_000);
}
