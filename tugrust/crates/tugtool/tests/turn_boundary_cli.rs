//! The course's turn boundary, driven through the real binaries against a
//! stand-in tugcast (W8).
//!
//! The incident this pins: on the course machinery's first live run a stage
//! did everything right through the first boundary — `step start 1`, work,
//! `dash commit`, `step done 1` — and then, instead of ending its turn, kept
//! working straight into step 2. The Wheel acts only *between* turns, so an
//! unended turn locks it out of pacing, `/compact`, rotation and the idle
//! clock alike. Both the skill and the wheel's opening prompt commanded the
//! boundary in prose and the stage rolled through both.
//!
//! Two halves, because the answer is two things.
//!
//! **The gate** (`tugtool hook pre-tool-use`) is the behaviour table: course ×
//! step-closed-this-turn × server age. The one row that denies is the overrun;
//! every other row must leave ordinary work untouched, because a gate that
//! bricks editing on a mixed install or on somebody else's project costs more
//! than the overrun it prevents.
//!
//! **The verb** (`tugtool dash step …`) is the other half: under a course it
//! ends with the sentence naming what the discipline demands next, off one it
//! stays plain, and either way it announces the gesture on the card and tells
//! the server which turn closed a step.

mod common;
use common::tugtool;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;

/// How the stand-in answers `POST /api/session {op:"turn_facts"}`.
#[derive(Clone)]
enum Facts {
    /// A course stage whose turn has already closed step `n`.
    OnCourseClosed(u32),
    /// A course stage with the turn's step still open.
    OnCourseOpen,
    /// Bound to no course at all — an ordinary card.
    OffCourse,
    /// An instance older than W8: it does not know the op.
    PredatingTheOp,
}

impl Facts {
    fn body(&self) -> (&'static str, String) {
        match self {
            Facts::OnCourseClosed(step) => (
                "200 OK",
                format!(
                    r#"{{"status":"ok","session_id":"seg-1","on_course":true,"step_closed_this_turn":{step}}}"#
                ),
            ),
            Facts::OnCourseOpen => (
                "200 OK",
                r#"{"status":"ok","session_id":"seg-1","on_course":true,"step_closed_this_turn":null}"#
                    .to_string(),
            ),
            Facts::OffCourse => (
                "200 OK",
                r#"{"status":"ok","session_id":"seg-1","on_course":false,"step_closed_this_turn":3}"#
                    .to_string(),
            ),
            Facts::PredatingTheOp => (
                "400 Bad Request",
                r#"{"status":"error","message":"unknown op 'turn_facts'"}"#.to_string(),
            ),
        }
    }
}

/// A stand-in tugcast that answers `turn_facts` as `facts` says and everything
/// else with a bare ok, handing every request body back over a channel.
fn fake_tugcast(facts: Facts) -> (u16, mpsc::Receiver<serde_json::Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
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
            let mut status = "200 OK";
            let mut payload = r#"{"status":"ok"}"#.to_string();
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&body) {
                if value.get("op").and_then(|o| o.as_str()) == Some("turn_facts") {
                    let (s, b) = facts.body();
                    status = s;
                    payload = b;
                }
                let _ = tx.send(value);
            }
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

/// Write an instance registry naming `port`, under `tmp` (the child's
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

fn hook(tmp: &Path) -> Command {
    let mut cmd = tugtool();
    cmd.env("TMPDIR", tmp);
    cmd.env("TUG_DATA_DIR", tmp.join("state"));
    // The gate's cheap pre-filter: a card that was not spawned into a course
    // is not asked about at all. Every test below that expects a round trip
    // is a course stage, and the one that does not clears this.
    cmd.env("TUG_DASH_COURSE", "demo");
    cmd.args(["hook", "pre-tool-use"]);
    cmd
}

/// Run the hook over one payload and return what it printed.
fn decide(cmd: &mut Command, payload: serde_json::Value) -> String {
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(serde_json::to_string(&payload).unwrap().as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "the hook always exits 0 — a crashed gate would block work: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// The decision, or `None` for the empty stdout that means "no opinion".
fn verdict(stdout: &str) -> Option<(String, String)> {
    let value: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;
    let specific = value.get("hookSpecificOutput")?;
    Some((
        specific["permissionDecision"].as_str()?.to_string(),
        specific["permissionDecisionReason"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
    ))
}

fn edit_of(cwd: &Path) -> serde_json::Value {
    serde_json::json!({
        "tool_name": "Edit",
        "tool_input": { "file_path": "src/deck-manager.ts", "old_string": "a", "new_string": "b" },
        "cwd": cwd.to_string_lossy(),
    })
}

// ── The row that denies ─────────────────────────────────────────────────────

#[test]
fn a_stage_that_closed_a_step_this_turn_cannot_edit_again() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp = tmp.path().canonicalize().unwrap();
    let (port, _requests) = fake_tugcast(Facts::OnCourseClosed(1));
    register_fake_instance(&tmp, port);

    let mut cmd = hook(&tmp);
    cmd.env("TUG_SESSION_ID", "seg-1");
    let (decision, reason) = verdict(&decide(&mut cmd, edit_of(&tmp))).expect("a decision");

    assert_eq!(decision, "deny");
    assert!(
        reason.contains("step 1 closed this turn — end the turn; the course prompts the next step"),
        "the refusal names the gesture and the way out: {reason}"
    );
}

#[test]
fn and_cannot_open_the_next_step_either() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp = tmp.path().canonicalize().unwrap();
    let (port, _requests) = fake_tugcast(Facts::OnCourseClosed(2));
    register_fake_instance(&tmp, port);

    let mut cmd = hook(&tmp);
    cmd.env("TUG_SESSION_ID", "seg-1");
    let payload = serde_json::json!({
        "tool_name": "Bash",
        "tool_input": { "command": "tugtool dash step demo start 3 --through 7" },
        "cwd": tmp.to_string_lossy(),
    });
    let (decision, reason) = verdict(&decide(&mut cmd, payload)).expect("a decision");

    assert_eq!(decision, "deny", "{reason}");
    assert!(reason.contains("Opening the next step"), "{reason}");
}

#[test]
fn but_the_reads_and_the_ledger_verbs_are_untouched() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp = tmp.path().canonicalize().unwrap();
    let (port, _requests) = fake_tugcast(Facts::OnCourseClosed(1));
    register_fake_instance(&tmp, port);

    for payload in [
        serde_json::json!({
            "tool_name": "Read",
            "tool_input": { "file_path": "/anywhere/a.rs" },
            "cwd": tmp.to_string_lossy(),
        }),
        serde_json::json!({
            "tool_name": "Bash",
            "tool_input": { "command": "tugtool dash status demo" },
            "cwd": tmp.to_string_lossy(),
        }),
        serde_json::json!({
            "tool_name": "Bash",
            "tool_input": { "command": "tugtool dash doctor demo" },
            "cwd": tmp.to_string_lossy(),
        }),
        serde_json::json!({
            "tool_name": "Bash",
            "tool_input": { "command": "tugtool draft set --json" },
            "cwd": tmp.to_string_lossy(),
        }),
    ] {
        let mut cmd = hook(&tmp);
        cmd.env("TUG_SESSION_ID", "seg-1");
        let stdout = decide(&mut cmd, payload.clone());
        let decision = verdict(&stdout).map(|(d, _)| d);
        assert_ne!(
            decision.as_deref(),
            Some("deny"),
            "a closed boundary refuses the next step's work, not the report of \
             the last one's: {payload}"
        );
    }
}

// ── The rows that must not ──────────────────────────────────────────────────

#[test]
fn the_same_session_with_the_step_still_open_edits_freely() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp = tmp.path().canonicalize().unwrap();
    let (port, _requests) = fake_tugcast(Facts::OnCourseOpen);
    register_fake_instance(&tmp, port);

    let mut cmd = hook(&tmp);
    cmd.env("TUG_SESSION_ID", "seg-1");
    let stdout = decide(&mut cmd, edit_of(&tmp));
    assert_eq!(verdict(&stdout).map(|(d, _)| d), None, "{stdout}");
}

#[test]
fn a_card_on_no_course_is_never_paced() {
    // The server answers with a closed step *and* `on_course: false` — a shape
    // the machine will not produce, spelled here so the gate's own reading of
    // "under a course" is what is being asserted rather than the server's.
    let tmp = tempfile::tempdir().unwrap();
    let tmp = tmp.path().canonicalize().unwrap();
    let (port, _requests) = fake_tugcast(Facts::OffCourse);
    register_fake_instance(&tmp, port);

    let mut cmd = hook(&tmp);
    cmd.env("TUG_SESSION_ID", "seg-1");
    let stdout = decide(&mut cmd, edit_of(&tmp));
    assert_eq!(verdict(&stdout).map(|(d, _)| d), None, "{stdout}");
}

#[test]
fn an_old_server_degrades_open_and_is_not_even_asked_twice() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp = tmp.path().canonicalize().unwrap();
    let (port, requests) = fake_tugcast(Facts::PredatingTheOp);
    register_fake_instance(&tmp, port);

    let mut cmd = hook(&tmp);
    cmd.env("TUG_SESSION_ID", "seg-1");
    let stdout = decide(&mut cmd, edit_of(&tmp));

    // Whatever it printed, it did not deny: a gate that bricked editing on a
    // mixed install would cost more than the overrun it prevents.
    assert_ne!(
        verdict(&stdout).map(|(d, _)| d).as_deref(),
        Some("deny"),
        "{stdout}"
    );
    let asked = requests
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap();
    assert_eq!(asked["op"], "turn_facts");
}

#[test]
fn a_foreign_project_with_no_calling_session_asks_nothing_at_all() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp = tmp.path().canonicalize().unwrap();
    let (port, requests) = fake_tugcast(Facts::OnCourseClosed(1));
    register_fake_instance(&tmp, port);

    // The standalone contract: `Tug.app` ships this hook to people whose
    // projects have nothing to do with a course. No `TUG_SESSION_ID` means
    // there is no calling session to ask about, and the gate must not so much
    // as open a socket.
    let mut cmd = hook(&tmp);
    cmd.env_remove("TUG_SESSION_ID");
    let stdout = decide(&mut cmd, edit_of(&tmp));

    assert_eq!(verdict(&stdout).map(|(d, _)| d), None, "{stdout}");
    assert!(
        requests
            .recv_timeout(std::time::Duration::from_millis(500))
            .is_err(),
        "a project with no course running is not a thing to ask about",
    );
}

#[test]
fn a_card_never_spawned_into_a_course_opens_no_socket() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp = tmp.path().canonicalize().unwrap();
    let (port, requests) = fake_tugcast(Facts::OnCourseClosed(1));
    register_fake_instance(&tmp, port);

    // Without this filter every edit on every Session card would pay a
    // localhost round trip to be told that nothing is being paced.
    let mut cmd = hook(&tmp);
    cmd.env_remove("TUG_DASH_COURSE");
    cmd.env_remove("TUG_DASH_ARC");
    cmd.env("TUG_SESSION_ID", "seg-1");
    let stdout = decide(&mut cmd, edit_of(&tmp));

    assert_eq!(verdict(&stdout).map(|(d, _)| d), None, "{stdout}");
    assert!(
        requests
            .recv_timeout(std::time::Duration::from_millis(500))
            .is_err(),
        "an ordinary card is not a course stage, and is not asked about",
    );
}

#[test]
fn no_instance_running_at_all_denies_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp = tmp.path().canonicalize().unwrap();
    // No registry written: nothing to walk.
    let mut cmd = hook(&tmp);
    cmd.env("TUG_SESSION_ID", "seg-1");
    let stdout = decide(&mut cmd, edit_of(&tmp));
    assert_eq!(verdict(&stdout).map(|(d, _)| d), None, "{stdout}");
}

// ── The verb's own voice, and what it tells the server ──────────────────────

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .current_dir(dir)
        .args(args)
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?} failed");
}

fn tug(tmp: &Path, root: &Path) -> Command {
    let mut cmd = tugtool();
    cmd.current_dir(root);
    cmd.env("TMPDIR", tmp);
    cmd.env("TUG_DATA_DIR", tmp.join("state"));
    cmd.env("TUG_SESSION_ID", "seg-1");
    cmd
}

/// A checkout holding a dash named `demo` with a two-row ledger.
fn repo_with_a_two_step_plan(root: &Path) {
    git(root, &["init", "-b", "main"]);
    git(root, &["config", "user.name", "t"]);
    git(root, &["config", "user.email", "t@t"]);
    std::fs::create_dir_all(root.join(".tugtool")).unwrap();
    std::fs::write(root.join(".tugtool/config.toml"), "").unwrap();
    std::fs::write(root.join("a.txt"), "base\n").unwrap();
    git(root, &["add", "-A"]);
    git(root, &["commit", "-m", "base"]);
}

fn write_plan(root: &Path) {
    let dir = root.join(".tug/dashes/demo");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("plan.md"),
        "## A plan {#a-plan}\n\n### Execution Steps {#execution-steps}\n\n\
         #### Step Status Ledger {#step-status-ledger}\n\n\
         | Step | Title | Status | Commit |\n|---|---|---|---|\n\
         | #step-1 | The first step | pending | — |\n\
         | #step-2 | The second step | pending | — |\n\n\
         #### Step 1: The first step {#step-1}\n\nBody.\n\n\
         #### Step 2: The second step {#step-2}\n\nBody.\n",
    )
    .unwrap();
}

fn run(cmd: &mut Command, args: &[&str]) -> (bool, String) {
    let out = cmd.args(args).output().unwrap();
    (
        out.status.success(),
        format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ),
    )
}

#[test]
fn a_step_verb_speaks_the_boundary_only_under_a_course() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp = tmp.path().canonicalize().unwrap();
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path().canonicalize().unwrap();
    let (port, requests) = fake_tugcast(Facts::OnCourseOpen);
    register_fake_instance(&tmp, port);
    repo_with_a_two_step_plan(&root);

    let (ok, out) = run(&mut tug(&tmp, &root), &["dash", "create", "demo"]);
    assert!(ok, "{out}");
    write_plan(&root);

    // Off a course, the read-out is plain: a person at a terminal moving their
    // own ledger needs no marching orders.
    let (ok, out) = run(
        &mut tug(&tmp, &root),
        &["dash", "step", "demo", "start", "1", "--through", "2"],
    );
    assert!(ok, "{out}");
    assert!(out.contains("Step 1/2 of"), "{out}");
    assert!(
        !out.contains("This turn closes"),
        "no course is running, so nothing is being paced: {out}"
    );

    // Under one, every step verb ends with what the discipline demands next.
    let (ok, out) = run(&mut tug(&tmp, &root), &["dash", "run", "demo"]);
    assert!(ok, "{out}");

    let (ok, out) = run(
        &mut tug(&tmp, &root),
        &["dash", "step", "demo", "done", "1"],
    );
    assert!(ok, "{out}");
    assert!(
        out.contains("Step 1 closed. End your turn now — the course prompts Step 2."),
        "the close names the boundary and what comes after it: {out}"
    );

    let (ok, out) = run(
        &mut tug(&tmp, &root),
        &["dash", "step", "demo", "start", "2", "--through", "2"],
    );
    assert!(ok, "{out}");
    assert!(
        out.contains("Step 2 open. This turn closes step 2 and nothing else."),
        "and an open says what the turn is for: {out}"
    );

    let (ok, out) = run(
        &mut tug(&tmp, &root),
        &["dash", "step", "demo", "done", "2"],
    );
    assert!(ok, "{out}");
    assert!(
        out.contains("Step 2 closed. End your turn now — the course takes the run from here."),
        "the run's last step names no next one: {out}"
    );

    // And the whole run announced itself on the card, and told the server
    // which turns closed a step.
    let mut notes = Vec::new();
    let mut closes = Vec::new();
    while let Ok(body) = requests.recv_timeout(std::time::Duration::from_millis(500)) {
        match body.get("op").and_then(|o| o.as_str()) {
            Some("note") => notes.push((
                body["command"].as_str().unwrap_or_default().to_string(),
                body["note"].as_str().unwrap_or_default().to_string(),
            )),
            Some("step_closed") => closes.push(body["step"].as_u64().unwrap_or_default()),
            _ => {}
        }
    }
    assert!(
        notes.contains(&(
            "dash create demo".into(),
            "demo: dash created on tugdash/demo".into()
        )),
        "{notes:?}"
    );
    assert!(
        notes.contains(&(
            "dash step demo start 1 --through 2".into(),
            "demo: run declared through step 2 of 2".into()
        )),
        "the run is declared once, by the start that declared it: {notes:?}"
    );
    assert!(
        notes.contains(&(
            "dash step demo start 1".into(),
            "demo: step 1/2 started".into()
        )),
        "{notes:?}"
    );
    assert!(
        notes
            .iter()
            .any(|(command, note)| command == "dash step demo done 1"
                && note.starts_with("demo: step 1/2 closed (")),
        "a close names the round it recorded: {notes:?}"
    );
    assert!(
        !notes.contains(&(
            "dash step demo start 2 --through 2".into(),
            "demo: run declared through step 2 of 2".into()
        )),
        "and never again by a step that merely inherits it: {notes:?}"
    );
    assert_eq!(
        closes,
        vec![1, 2],
        "each close is reported against the turn that made it",
    );
}
