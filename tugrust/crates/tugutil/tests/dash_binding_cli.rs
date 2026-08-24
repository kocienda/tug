//! `tugutil dash bind|unbind` and the `dash_gone` broadcast a landing fires
//! ([P04], [P05], Spec S04).
//!
//! The `dash_gone` test is the CLI-side face of the [L23] hazard: `git branch
//! -D` deletes the branch's `tugid` along with the branch, so the owner key
//! must be resolved *before* the join and carried through. The test asserts
//! the key in the request body the CLI actually sent, after the branch it came
//! from is gone — which no amount of resolving afterwards could produce.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::Command;
use std::sync::mpsc;

use assert_cmd::cargo::CommandCargoExt;

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .current_dir(dir)
        .args(args)
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?} failed");
}

fn git_stdout(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A one-shot stand-in for a running tugcast: accepts POSTs, hands each JSON
/// body back over a channel, and answers `{"status":"ok"}`.
fn fake_tugcast() -> (u16, mpsc::Receiver<serde_json::Value>) {
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
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&body) {
                let _ = tx.send(value);
            }
            let payload = br#"{"status":"ok","cleared":1}"#;
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                payload.len()
            );
            let _ = stream.write_all(payload);
            let _ = stream.flush();
        }
    });
    (port, rx)
}

/// Write an instance registry naming `port`, under `tmp` (which the child
/// process sees as `$TMPDIR`). The pid is this test's own, so the registry's
/// liveness filter keeps the entry.
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

fn tug(tmp: &Path) -> Command {
    let mut cmd = Command::cargo_bin("tugutil").unwrap();
    cmd.env_remove("TUG_INSTANCE_ID");
    cmd.env_remove("TUG_SESSION_ID");
    cmd.env("TMPDIR", tmp);
    cmd.env("TUG_DATA_DIR", tmp.join("state"));
    cmd
}

/// A repo with a dash that has one round, and a known creation id.
fn repo_with_dash(root: &Path, name: &str) -> String {
    git(root, &["init", "-b", "main"]);
    git(root, &["config", "user.name", "t"]);
    git(root, &["config", "user.email", "t@t"]);
    std::fs::create_dir_all(root.join(".tugtool")).unwrap();
    std::fs::write(root.join(".tugtool/config.toml"), "").unwrap();
    std::fs::write(root.join("a.txt"), "base\n").unwrap();
    git(root, &["add", "-A"]);
    git(root, &["commit", "-m", "base"]);

    let worktree = root.join(".tug/worktrees").join(name);
    git(
        root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            &format!("tugdash/{name}"),
            worktree.to_str().unwrap(),
        ],
    );
    std::fs::write(worktree.join("b.txt"), "work\n").unwrap();
    git(&worktree, &["add", "-A"]);
    git(&worktree, &["commit", "-m", "round"]);

    git(
        root,
        &["config", &format!("branch.tugdash/{name}.tugbase"), "main"],
    );
    git(
        root,
        &[
            "config",
            &format!("branch.tugdash/{name}.tugid"),
            "1723500000000-a1b2c3",
        ],
    );
    format!("tugdash/{name}#1723500000000-a1b2c3")
}

/// **The CLI-side [L23] pin.** A join broadcasts `dash_gone` with the
/// id-qualified owner key — resolved before the teardown, and therefore still
/// nameable after `git branch -D` has taken the `tugid` with the branch.
#[test]
fn a_join_broadcasts_dash_gone_with_the_key_captured_before_teardown() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    let owner_key = repo_with_dash(&root, "demo");

    let (port, requests) = fake_tugcast();
    register_fake_instance(&tmp_path, port);

    let mut join = tug(&tmp_path);
    join.current_dir(&root);
    // The subject is the dash-gone broadcast, not the join itself.
    join.args(["dash", "join", "demo"]);
    let out = join.output().unwrap();
    assert!(
        out.status.success(),
        "join failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    // The teardown really happened: nothing could re-derive the key now.
    assert_eq!(
        git_stdout(&root, &["branch", "--list", "tugdash/demo"]),
        "",
        "the branch is gone"
    );
    assert_eq!(
        git_stdout(&root, &["config", "--get", "branch.tugdash/demo.tugid"]),
        "",
        "and its config with it"
    );

    let body = requests
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("the CLI broadcast dash_gone");
    assert_eq!(body["op"], "dash_gone");
    assert_eq!(
        body["dash_id"], owner_key,
        "the broadcast carries the id-qualified key, not the legacy one a \
         post-teardown resolution would have produced"
    );
}

/// `bind` names the calling session, so without one it fails with an
/// actionable message rather than binding something arbitrary.
#[test]
fn dash_bind_without_a_session_fails_with_an_actionable_message() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    repo_with_dash(&root, "demo");

    let mut bind = tug(&tmp_path);
    bind.current_dir(&root);
    bind.args(["dash", "bind", "demo"]);
    let out = bind.output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("TUG_SESSION_ID"),
        "the error says what to do: {stderr}"
    );
}

/// `bind` and `unbind` round-trip through `/api/dash`, and `--json` emits the
/// shared envelope.
#[test]
fn dash_bind_and_unbind_post_to_the_instance_and_emit_envelopes() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    let owner_key = repo_with_dash(&root, "demo");

    let (port, requests) = fake_tugcast();
    register_fake_instance(&tmp_path, port);

    let mut bind = tug(&tmp_path);
    bind.current_dir(&root);
    bind.env("TUG_SESSION_ID", "sess-1");
    bind.args(["dash", "bind", "demo", "--json"]);
    let out = bind.output().unwrap();
    assert!(
        out.status.success(),
        "bind failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let envelope: serde_json::Value =
        serde_json::from_slice(&out.stdout).expect("valid JSON envelope");
    assert_eq!(envelope["command"], "dash bind");
    assert_eq!(envelope["status"], "ok");

    let body = requests
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("a bind request");
    assert_eq!(body["op"], "bind");
    assert_eq!(body["tug_session_id"], "sess-1");
    assert_eq!(body["dash"], "demo");
    // The CLI ships its own spelling — the server is the [L29] gateway.
    assert_eq!(body["project_dir"], root.to_string_lossy().as_ref());
    // The key itself is the server's to mint ([P02]); the CLI names the dash.
    assert!(owner_key.contains('#'));

    let mut unbind = tug(&tmp_path);
    unbind.current_dir(&root);
    unbind.env("TUG_SESSION_ID", "sess-1");
    unbind.args(["dash", "unbind", "--json"]);
    let out = unbind.output().unwrap();
    assert!(
        out.status.success(),
        "unbind failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let body = requests
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("an unbind request");
    assert_eq!(body["op"], "unbind");
    assert_eq!(body["tug_session_id"], "sess-1");
}

/// The undo/redo pair driven end to end through the CLI: a redo re-applies the
/// join, a second one has nothing left, and `--list` reports the log the same
/// way whichever verb asks for it.
#[test]
fn dash_redo_reverses_an_undo_and_then_says_there_is_nothing_left() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    repo_with_dash(&root, "cli");

    let run = |args: &[&str]| {
        let mut cmd = tug(&tmp_path);
        cmd.current_dir(&root);
        cmd.args(args);
        cmd.output().unwrap()
    };

    assert!(run(&["dash", "join", "cli"]).status.success());
    let landed = git_stdout(&root, &["rev-parse", "main"]);
    assert!(run(&["dash", "undo"]).status.success());
    assert_ne!(git_stdout(&root, &["rev-parse", "main"]), landed);

    let redo = run(&["dash", "redo"]);
    assert!(
        redo.status.success(),
        "redo failed: {}",
        String::from_utf8_lossy(&redo.stderr)
    );
    assert_eq!(
        git_stdout(&root, &["rev-parse", "main"]),
        landed,
        "the redo re-landed the join"
    );
    assert!(String::from_utf8_lossy(&redo.stdout).contains("Redid the join"));

    // Nothing is left to redo, and the refusal says which state this is.
    let again = run(&["dash", "redo"]);
    assert!(!again.status.success(), "a second redo must exit non-zero");
    let err = String::from_utf8_lossy(&again.stderr).to_string();
    assert!(
        err.contains("already-redone") || err.contains("nothing-to-redo"),
        "{err}"
    );

    // One printer, two flags: the log reads identically from either verb.
    let via_undo = run(&["dash", "undo", "--list"]);
    let via_redo = run(&["dash", "redo", "--list"]);
    assert!(via_undo.status.success() && via_redo.status.success());
    assert_eq!(
        String::from_utf8_lossy(&via_undo.stdout),
        String::from_utf8_lossy(&via_redo.stdout),
        "`undo --list` and `redo --list` are the same question"
    );
    assert!(
        String::from_utf8_lossy(&via_undo.stdout).contains("redo"),
        "and the redo operation is in it: {}",
        String::from_utf8_lossy(&via_undo.stdout)
    );
}
