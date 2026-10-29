//! `tugtool arc bind|unbind` and the `arc_gone` broadcast a landing fires
//! ([P04], [P05], Spec S04).
//!
//! The `arc_gone` test is the CLI-side face of the [L23] hazard: `git branch
//! -D` deletes the branch's `tugid` along with the branch, so the owner key
//! must be resolved *before* the join and carried through. The test asserts
//! the key in the request body the CLI actually sent, after the branch it came
//! from is gone — which no amount of resolving afterwards could produce.

mod common;
use common::tugtool;
use tugcore::test_fixtures::git::{GitFixture, git};

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::Command;
use std::sync::mpsc;

/// A one-shot stand-in for a running tugcast: accepts POSTs, hands each JSON
/// body back over a channel, and answers `{"status":"ok"}`.
fn fake_tugcast() -> (u16, mpsc::Receiver<serde_json::Value>) {
    fake_tugcast_with(ResolveAnswer::Generic)
}

/// The same, but answering `unknown op` to the identity chokepoint's
/// `resolve` — a tugcast older than the chokepoint, which is what every
/// machine has for the minutes between installing a build and restarting the
/// app.
fn fake_tugcast_predating_resolve() -> (u16, mpsc::Receiver<serde_json::Value>) {
    fake_tugcast_with(ResolveAnswer::UnknownOp)
}

/// A tugcast that answers `resolve` by naming a *different* live segment —
/// the shape a rotation leaves, and the one a session asks `--dry-run` about.
fn fake_tugcast_resolving_to(
    session_id: &str,
    state: &str,
    line_id: &str,
) -> (u16, mpsc::Receiver<serde_json::Value>) {
    fake_tugcast_with(ResolveAnswer::Rotated {
        body: format!(
            r#"{{"status":"ok","session_id":"{session_id}","state":"{state}","line_id":"{line_id}"}}"#
        ),
    })
}

/// A tugcast that places the calling session in `project_dir` — so the claim
/// is one it *could* have made — and then refuses the bind.
///
/// The project matters: a claim skips itself when the session works another
/// checkout, because that claim was never its to make. This is the other case,
/// the one a verb must fail on.
fn fake_tugcast_refusing_bind(
    project_dir: &Path,
    reason: &str,
) -> (u16, mpsc::Receiver<serde_json::Value>) {
    fake_tugcast_with(ResolveAnswer::RefusingBind {
        resolve: format!(
            r#"{{"status":"ok","session_id":"seg-1","state":"live","project_dir":"{}"}}"#,
            project_dir.display()
        ),
        refusal: format!(r#"{{"status":"error","message":"{reason}"}}"#),
    })
}

/// How the stand-in answers the identity chokepoint's `resolve` op.
enum ResolveAnswer {
    /// Whatever the generic handler says — `{"status":"ok","cleared":1}`,
    /// which carries no `session_id`, so the posted id stands.
    Generic,
    /// A tugcast older than the chokepoint, which is what every machine has
    /// for the minutes between installing a build and restarting the app.
    UnknownOp,
    /// A named live segment, with its ledger state and line.
    Rotated { body: String },
    /// Resolve answers with `resolve`; anything else is refused with
    /// `refusal`.
    RefusingBind { resolve: String, refusal: String },
    /// Every instance says "not mine" — the walk's shrug, answered to
    /// everything. Legitimately transient: the ledger row a card's spawn
    /// writes lands a moment after the card does, so a caller that binds into
    /// that window must be able to tell this refusal from a permanent one and
    /// wait it out.
    UnknownSession,
}

fn fake_tugcast_with(resolve: ResolveAnswer) -> (u16, mpsc::Receiver<serde_json::Value>) {
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
                let is_resolve = value.get("op").and_then(|o| o.as_str()) == Some("resolve");
                let _ = tx.send(value);
                match &resolve {
                    ResolveAnswer::UnknownOp if is_resolve => {
                        let payload = br#"{"status":"error","message":"unknown op 'resolve'"}"#;
                        let _ = write!(
                            stream,
                            "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            payload.len()
                        );
                        let _ = stream.write_all(payload);
                        let _ = stream.flush();
                        continue;
                    }
                    ResolveAnswer::Rotated { body } if is_resolve => {
                        let _ = write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = stream.write_all(body.as_bytes());
                        let _ = stream.flush();
                        continue;
                    }
                    ResolveAnswer::RefusingBind { resolve, refusal } => {
                        let (status, body) = if is_resolve {
                            ("200 OK", resolve)
                        } else {
                            ("400 Bad Request", refusal)
                        };
                        let _ = write!(
                            stream,
                            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = stream.write_all(body.as_bytes());
                        let _ = stream.flush();
                        continue;
                    }
                    ResolveAnswer::UnknownSession => {
                        let payload = br#"{"status":"error","message":"unknown_session"}"#;
                        let _ = write!(
                            stream,
                            "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            payload.len()
                        );
                        let _ = stream.write_all(payload);
                        let _ = stream.flush();
                        continue;
                    }
                    _ => {}
                }
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
    let mut cmd = tugtool();
    cmd.env_remove("TUG_INSTANCE_ID");
    cmd.env_remove("TUG_SESSION_ID");
    cmd.env("TMPDIR", tmp);
    cmd.env("TUG_DATA_DIR", tmp.join("state"));
    cmd
}

/// A repo with an arc that has one round, and a known creation id.
fn repo_with_arc(root: &Path, name: &str) -> String {
    GitFixture::init(root);
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
            &format!("tugarc/{name}"),
            worktree.to_str().unwrap(),
        ],
    );
    std::fs::write(worktree.join("b.txt"), "work\n").unwrap();
    git(&worktree, &["add", "-A"]);
    git(&worktree, &["commit", "-m", "round"]);

    git(
        root,
        &["config", &format!("branch.tugarc/{name}.tugbase"), "main"],
    );
    git(
        root,
        &[
            "config",
            &format!("branch.tugarc/{name}.tugid"),
            "1723500000000-a1b2c3",
        ],
    );
    format!("tugarc/{name}#1723500000000-a1b2c3")
}

/// **The CLI-side [L23] pin.** A join broadcasts `arc_gone` with the
/// id-qualified owner key — resolved before the teardown, and therefore still
/// nameable after `git branch -D` has taken the `tugid` with the branch.
#[test]
fn a_join_broadcasts_arc_gone_with_the_key_captured_before_teardown() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    let owner_key = repo_with_arc(&root, "demo");

    let (port, requests) = fake_tugcast();
    register_fake_instance(&tmp_path, port);

    let mut join = tug(&tmp_path);
    join.current_dir(&root);
    // The subject is the arc-gone broadcast, not the join itself.
    join.args(["arc", "join", "demo"]);
    let out = join.output().unwrap();
    assert!(
        out.status.success(),
        "join failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    // The teardown really happened: nothing could re-derive the key now.
    assert_eq!(
        git(&root, &["branch", "--list", "tugarc/demo"])
            .trim()
            .to_string(),
        "",
        "the branch is gone"
    );
    assert_eq!(
        // `config --get` exits 1 when the key is absent.
        tugcore::test_fixtures::git::command()
            .arg("-C")
            .arg(&root)
            .args(["config", "--get", "branch.tugarc/demo.tugid"])
            .output()
            .unwrap()
            .status
            .code(),
        Some(1),
        "and its config with it"
    );

    let body = requests
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("the CLI broadcast arc_gone");
    assert_eq!(body["op"], "arc_gone");
    assert_eq!(
        body["arc_id"], owner_key,
        "the broadcast carries the id-qualified key, not the legacy one a \
         post-teardown resolution would have produced"
    );
}

/// The join stopped resolving conflicts, and the flag that asked it to is a
/// retired spelling: it lands on a sentence naming the replay, exits as a
/// refusal, and touches nothing. `--break-lease` is accepted and ignored,
/// since there is no lease left to break.
#[test]
fn arc_join_resolve_is_a_retired_spelling_that_refuses_and_touches_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    repo_with_arc(&root, "demo");
    let arc_before = git(&root, &["rev-parse", "tugarc/demo"]);
    let base_before = git(&root, &["rev-parse", "main"]);

    let mut refused = tug(&tmp_path);
    refused.current_dir(&root);
    refused.args(["arc", "join", "demo", "--resolve"]);
    let out = refused.output().unwrap();
    assert_eq!(out.status.code(), Some(3), "a refusal");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("The join no longer resolves conflicts")
            && stderr.contains("tugtool arc replay demo"),
        "{stderr}"
    );
    assert_eq!(git(&root, &["rev-parse", "tugarc/demo"]), arc_before);
    assert_eq!(git(&root, &["rev-parse", "main"]), base_before);

    let mut preview = tug(&tmp_path);
    preview.current_dir(&root);
    preview.args([
        "arc",
        "join",
        "demo",
        "--preview",
        "--break-lease",
        "--json",
    ]);
    let out = preview.output().unwrap();
    assert!(
        out.status.success(),
        "--break-lease is accepted and changes nothing: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// `bind` names the calling session, so without one it fails with an
/// actionable message rather than binding something arbitrary.
#[test]
fn arc_bind_without_a_session_fails_with_an_actionable_message() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    repo_with_arc(&root, "demo");

    let mut bind = tug(&tmp_path);
    bind.current_dir(&root);
    bind.args(["arc", "bind", "demo"]);
    let out = bind.output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("TUG_SESSION_ID"),
        "the error says what to do: {stderr}"
    );
}

/// `bind` and `unbind` round-trip through `/api/arc`, and `--json` emits the
/// shared envelope.
#[test]
fn arc_bind_and_unbind_post_to_the_instance_and_emit_envelopes() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    let owner_key = repo_with_arc(&root, "demo");

    let (port, requests) = fake_tugcast();
    register_fake_instance(&tmp_path, port);

    let mut bind = tug(&tmp_path);
    bind.current_dir(&root);
    bind.env("TUG_SESSION_ID", "sess-1");
    bind.args(["arc", "bind", "demo", "--json"]);
    let out = bind.output().unwrap();
    assert!(
        out.status.success(),
        "bind failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let envelope: serde_json::Value =
        serde_json::from_slice(&out.stdout).expect("valid JSON envelope");
    assert_eq!(envelope["command"], "arc bind");
    assert_eq!(envelope["status"], "ok");

    let body = requests
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("a bind request");
    // **Resolution comes first, always.** Every session-addressed verb asks
    // the instance for the live segment of its line before it uses the id it
    // was spawned with ([P01]) — that ordering is the workstream, so the test
    // asserts it rather than skipping past it.
    assert_eq!(body["op"], "resolve");
    assert_eq!(body["tug_session_id"], "sess-1");
    let body = requests
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("a bind request");
    assert_eq!(body["op"], "bind");
    assert_eq!(body["tug_session_id"], "sess-1");
    assert_eq!(body["arc"], "demo");
    // The CLI ships its own spelling — the server is the [L29] gateway.
    assert_eq!(body["project_dir"], root.to_string_lossy().as_ref());
    // The key itself is the server's to mint ([P02]); the CLI names the arc.
    assert!(owner_key.contains('#'));

    let mut unbind = tug(&tmp_path);
    unbind.current_dir(&root);
    unbind.env("TUG_SESSION_ID", "sess-1");
    unbind.args(["arc", "unbind", "--json"]);
    let out = unbind.output().unwrap();
    assert!(
        out.status.success(),
        "unbind failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let body = requests
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("an unbind request");
    assert_eq!(body["op"], "resolve");
    let body = requests
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("an unbind request");
    assert_eq!(body["op"], "unbind");
    assert_eq!(body["tug_session_id"], "sess-1");
}

/// **`arc documents --ensure --bind` is the door's first act.** It makes the
/// directory and binds the calling session in one verb, through the same
/// `bind` op `arc bind` posts — and a bare `--ensure` posts nothing at all,
/// which is what keeps every stage skill's ensure from re-binding.
#[test]
fn arc_documents_ensure_bind_posts_the_bind_and_bare_ensure_does_not() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    GitFixture::init(&root);

    let (port, requests) = fake_tugcast();
    register_fake_instance(&tmp_path, port);

    let mut bare = tug(&tmp_path);
    bare.current_dir(&root);
    bare.env("TUG_SESSION_ID", "sess-1");
    bare.args(["arc", "documents", "plain", "--ensure", "--json"]);
    let out = bare.output().unwrap();
    assert!(
        out.status.success(),
        "bare ensure failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(root.join(".tug/arcs/plain").is_dir());
    let envelope: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(
        envelope["data"].get("bound_session").is_none(),
        "a bare ensure names no binding: {envelope}"
    );
    assert!(
        requests
            .recv_timeout(std::time::Duration::from_millis(300))
            .is_err(),
        "a bare ensure posts nothing to the instance"
    );

    let mut bound = tug(&tmp_path);
    bound.current_dir(&root);
    bound.env("TUG_SESSION_ID", "sess-1");
    bound.args(["arc", "documents", "demo", "--ensure", "--bind", "--json"]);
    let out = bound.output().unwrap();
    assert!(
        out.status.success(),
        "ensure --bind failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(root.join(".tug/arcs/demo").is_dir());
    let envelope: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(envelope["command"], "arc documents");
    assert_eq!(envelope["data"]["bound_session"], "sess-1");

    let body = requests
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("a resolve request");
    assert_eq!(body["op"], "resolve");
    let body = requests
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("a bind request");
    assert_eq!(body["op"], "bind");
    assert_eq!(body["tug_session_id"], "sess-1");
    assert_eq!(body["arc"], "demo");
    assert_eq!(body["project_dir"], root.to_string_lossy().as_ref());

    // `--bind` without `--ensure` is refused at the parser: the bind rides
    // the ensure, and a binding to a directory nobody made is the old order.
    let mut alone = tug(&tmp_path);
    alone.current_dir(&root);
    alone.env("TUG_SESSION_ID", "sess-1");
    alone.args(["arc", "documents", "demo", "--bind"]);
    let out = alone.output().unwrap();
    assert!(!out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("--ensure"),
        "the refusal names the flag it needs"
    );
}

/// **A tugcast that predates the chokepoint still binds.**
///
/// The resolver asks an instance to expand the calling session, and an
/// instance that has not restarted since the build was installed does not
/// know the op. Refusing there would break every session-addressed verb on
/// every machine for the minutes between install and restart — and it is not
/// needed: `/api/arc` resolves at its own door, so the bind still lands on
/// the live segment. Only this side's ability to *name* the resolution is
/// lost, and a receipt is not a write.
#[test]
fn arc_bind_survives_an_instance_that_does_not_know_the_resolve_op() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    repo_with_arc(&root, "demo");

    let (port, requests) = fake_tugcast_predating_resolve();
    register_fake_instance(&tmp_path, port);

    let mut bind = tug(&tmp_path);
    bind.current_dir(&root);
    bind.env("TUG_SESSION_ID", "sess-1");
    bind.args(["arc", "bind", "demo"]);
    let out = bind.output().unwrap();
    assert!(
        out.status.success(),
        "bind must not fail on an older instance: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    let body = requests
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("a resolve request");
    assert_eq!(body["op"], "resolve", "it still asks");
    let body = requests
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("a bind request");
    assert_eq!(body["op"], "bind");
    assert_eq!(
        body["tug_session_id"], "sess-1",
        "and falls back to the posted id, which the server's own door expands",
    );
}

/// The undo/redo pair driven end to end through the CLI: a redo re-applies the
/// join, a second one has nothing left, and `--list` reports the log the same
/// way whichever verb asks for it.
#[test]
fn arc_redo_reverses_an_undo_and_then_says_there_is_nothing_left() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    repo_with_arc(&root, "cli");

    let run = |args: &[&str]| {
        let mut cmd = tug(&tmp_path);
        cmd.current_dir(&root);
        cmd.args(args);
        cmd.output().unwrap()
    };

    assert!(run(&["arc", "join", "cli"]).status.success());
    let landed = git(&root, &["rev-parse", "main"]).trim().to_string();
    assert!(run(&["arc", "undo"]).status.success());
    assert_ne!(
        git(&root, &["rev-parse", "main"]).trim().to_string(),
        landed
    );

    let redo = run(&["arc", "redo"]);
    assert!(
        redo.status.success(),
        "redo failed: {}",
        String::from_utf8_lossy(&redo.stderr)
    );
    assert_eq!(
        git(&root, &["rev-parse", "main"]).trim().to_string(),
        landed,
        "the redo re-landed the join"
    );
    assert!(String::from_utf8_lossy(&redo.stdout).contains("Redid the join"));

    // Nothing is left to redo, and the refusal says which state this is.
    let again = run(&["arc", "redo"]);
    assert!(!again.status.success(), "a second redo must exit non-zero");
    let err = String::from_utf8_lossy(&again.stderr).to_string();
    assert!(
        err.contains("already-redone") || err.contains("nothing-to-redo"),
        "{err}"
    );

    // One printer, two flags: the log reads identically from either verb.
    let via_undo = run(&["arc", "undo", "--list"]);
    let via_redo = run(&["arc", "redo", "--list"]);
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

// ---------------------------------------------------------------------------
// A join killed mid-teardown, and resumed
// ---------------------------------------------------------------------------

/// A `git` that forwards every call to the real one, except the call it was
/// told to stop at — where it announces itself and then blocks, and never runs
/// git at all.
///
/// The paused call dies with the process that made it, so nothing the test
/// asserts survived the kill can be undone behind its back. It dies two ways:
/// [`kill_join_at`] kills `tugtool`'s whole process group, which takes the
/// shim with it in the same signal; and should the shim ever escape that
/// group, it watches the process that called it and exits the moment that
/// process is gone. An earlier shim waited on a gate the test opened after
/// the kill and then ran the real git, so an orphan finished the `branch -D`
/// the test was asserting never happened — on a slow runner, after the
/// assertion's own `git` had lost the race (nightly `40184770963`).
///
/// A pause point outside the product is what makes this a *crash* test rather
/// than a crash-hook test: nothing in `tugarc-core` knows it is being watched,
/// and the process really is killed, mid-teardown, by a signal it cannot catch.
const GIT_SHIM: &str = r#"#!/bin/sh
case "$*" in
  *"branch -D"*) : > "$SHIM_SEEN_BRANCH_D" ;;
esac
pause=no
if [ "$SHIM_PAUSE_ON" = "after-branch-delete" ]; then
  case "$*" in
    *"rev-parse --short"*) [ -f "$SHIM_SEEN_BRANCH_D" ] && pause=yes ;;
  esac
else
  case "$*" in
    *"$SHIM_PAUSE_ON"*) pause=yes ;;
  esac
fi
if [ "$pause" = yes ] && [ ! -f "$SHIM_PAUSED" ]; then
  caller=$PPID
  : > "$SHIM_PAUSED"
  while kill -0 "$caller" 2>/dev/null; do sleep 0.05; done
  exit 137
fi
exec "$SHIM_REAL_GIT" "$@"
"#;

/// Run `tugtool arc join <name>` under the shim and SIGKILL its process group
/// — `tugtool` and the paused `git` together — the moment the teardown reaches
/// `pause_on`.
fn kill_join_at(tmp: &Path, root: &Path, name: &str, pause_on: &str) {
    let shim_dir = tmp.join(format!("shim-{pause_on}").replace(' ', "-"));
    std::fs::create_dir_all(&shim_dir).unwrap();
    let shim = shim_dir.join("git");
    std::fs::write(&shim, GIT_SHIM).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let real_git = String::from_utf8(Command::new("which").arg("git").output().unwrap().stdout)
        .unwrap()
        .trim()
        .to_string();
    let paused = shim_dir.join("paused");

    let mut cmd = tug(tmp);
    cmd.current_dir(root);
    cmd.args(["arc", "join", name]);
    cmd.env(
        "PATH",
        format!(
            "{}:{}",
            shim_dir.to_string_lossy(),
            std::env::var("PATH").unwrap_or_default()
        ),
    );
    cmd.env("SHIM_REAL_GIT", &real_git);
    cmd.env("SHIM_PAUSE_ON", pause_on);
    cmd.env("SHIM_PAUSED", &paused);
    cmd.env("SHIM_SEEN_BRANCH_D", shim_dir.join("saw-branch-d"));
    // Its own process group, so one signal reaches every process the join
    // started, the paused `git` included.
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().unwrap();

    // Bounded wait, no fixed sleep: the shim announces the pause by creating a
    // file, so the test proceeds the instant the teardown is where it wants it.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while !paused.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "the join never reached `{pause_on}`"
        );
        if let Some(status) = child.try_wait().unwrap() {
            panic!("the join exited ({status}) before reaching `{pause_on}`");
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let group = libc::pid_t::try_from(child.id()).unwrap();
    // SAFETY: `kill` with a negative pid signals the process group `group`,
    // which `process_group(0)` made this child's own; it touches no memory.
    let killed = unsafe { libc::kill(-group, libc::SIGKILL) };
    assert_eq!(killed, 0, "SIGKILL the join's process group");
    let _ = child.wait();
}

fn oplog_list(tmp: &Path, root: &Path) -> String {
    let mut cmd = tug(tmp);
    cmd.current_dir(root);
    cmd.args(["arc", "undo", "--list"]);
    let out = cmd.output().unwrap();
    assert!(out.status.success());
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn continue_join(tmp: &Path, root: &Path, name: &str) {
    let mut cmd = tug(tmp);
    cmd.current_dir(root);
    cmd.args(["arc", "join", name, "--continue"]);
    let out = cmd.output().unwrap();
    assert!(
        out.status.success(),
        "--continue failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// What every one of these tests asserts once the resume has run: the teardown
/// finished, the record closed, and no journal file exists anywhere.
fn assert_finished(tmp: &Path, root: &Path, name: &str) {
    let worktree = root.join(".tug/worktrees").join(name);
    assert!(!worktree.exists(), "worktree removed");
    assert!(
        !branch_exists(root, &format!("tugarc/{name}")),
        "branch deleted"
    );
    let listing = oplog_list(tmp, root);
    assert!(
        !listing.contains("incomplete"),
        "the record closed: {listing}"
    );
    assert!(
        journal_files(tmp).is_empty(),
        "no join journal is written by any path"
    );

    let mut undo = tug(tmp);
    undo.current_dir(root);
    undo.args(["arc", "undo", name]);
    let out = undo.output().unwrap();
    assert!(
        out.status.success(),
        "and the finished join is undoable: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn branch_exists(root: &Path, branch: &str) -> bool {
    tugcore::test_fixtures::git::command()
        .current_dir(root)
        .args(["rev-parse", "--verify", "--quiet", branch])
        .status()
        .unwrap()
        .success()
}

/// Every `join-journal-*.json` under the redirected state dir.
fn journal_files(tmp: &Path) -> Vec<std::path::PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![tmp.join("state")];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("join-journal-"))
            {
                found.push(path);
            }
        }
    }
    found
}

/// The directory the op payloads landed in — the project's state dir, found by
/// what is in it rather than by recomputing the slug.
fn state_dir_with_payloads(tmp: &Path) -> std::path::PathBuf {
    let mut stack = vec![tmp.join("state")];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("oplog-"))
            {
                return dir;
            }
        }
    }
    panic!("no op payload was written");
}

#[test]
fn a_join_killed_before_its_worktree_goes_is_resumed_by_continue() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    repo_with_arc(&root, "demo");

    kill_join_at(&tmp_path, &root, "demo", "worktree remove");

    assert!(
        root.join(".tug/worktrees/demo").exists(),
        "worktree still there"
    );
    assert!(branch_exists(&root, "tugarc/demo"), "branch still there");
    let listing = oplog_list(&tmp_path, &root);
    assert!(
        listing.contains("incomplete (teardown at Integrated)"),
        "the record says how far it got: {listing}"
    );

    continue_join(&tmp_path, &root, "demo");
    assert_finished(&tmp_path, &root, "demo");
}

#[test]
fn a_join_killed_before_its_branch_goes_is_resumed_by_continue() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    repo_with_arc(&root, "demo");

    kill_join_at(&tmp_path, &root, "demo", "branch -D");

    assert!(!root.join(".tug/worktrees/demo").exists(), "worktree gone");
    assert!(branch_exists(&root, "tugarc/demo"), "branch still there");
    let listing = oplog_list(&tmp_path, &root);
    assert!(
        listing.contains("incomplete (teardown at WorktreeRemoved)"),
        "{listing}"
    );

    continue_join(&tmp_path, &root, "demo");
    assert_finished(&tmp_path, &root, "demo");
}

/// The boundary that had no resume at all before the fold: with the branch
/// already deleted, a `--continue` used to be refused as `Arc not found`.
#[test]
fn a_join_killed_after_its_branch_goes_is_resumed_by_continue() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    repo_with_arc(&root, "demo");

    kill_join_at(&tmp_path, &root, "demo", "after-branch-delete");

    assert!(!branch_exists(&root, "tugarc/demo"), "branch gone");
    let listing = oplog_list(&tmp_path, &root);
    assert!(
        listing.contains("incomplete (teardown at BranchDeleted)"),
        "{listing}"
    );

    continue_join(&tmp_path, &root, "demo");
    assert_finished(&tmp_path, &root, "demo");
}

/// A journal an older build left behind is folded onto the op log by the first
/// verb that reads it, and finished by `--continue` — no upgrade step, and the
/// file is gone afterwards.
#[test]
fn a_legacy_journal_on_disk_is_folded_and_continued_by_the_binary() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    repo_with_arc(&root, "demo");

    // Reach the same state an old build would have been killed in, then
    // rewrite that state the way the old build recorded it: a journal file and
    // no operation at all.
    kill_join_at(&tmp_path, &root, "demo", "worktree remove");
    let state = state_dir_with_payloads(&tmp_path);
    let head = git(&root, &["rev-parse", "HEAD"]).trim().to_string();
    for entry in std::fs::read_dir(&state).unwrap().flatten() {
        let path = entry.path();
        if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("oplog-"))
        {
            std::fs::remove_file(path).unwrap();
        }
    }
    let journal = state.join("join-journal-demo.json");
    std::fs::write(
        &journal,
        format!(
            r#"{{"name":"demo","base_branch":"main","strategy":"squash",
                 "commit_hash":"{head}","phase":"Integrated","message":"old build"}}"#
        ),
    )
    .unwrap();

    continue_join(&tmp_path, &root, "demo");
    assert!(!journal.exists(), "the journal is read out of existence");
    assert_finished(&tmp_path, &root, "demo");
}

/// `arc bind --dry-run` answers "which session am I, really" and writes
/// nothing.
///
/// Before it, a session whose `$TUG_SESSION_ID` was frozen at spawn had one
/// way to find out whether that id still named anything: bind, and read the
/// receipt. That is a write standing in for a question — and it is the gesture
/// the postmortem found reporting success in both failure modes.
#[test]
fn arc_bind_dry_run_names_the_segment_and_writes_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    repo_with_arc(&root, "demo");

    let (port, requests) = fake_tugcast_resolving_to("seg-new", "live", "line-1");
    register_fake_instance(&tmp_path, port);

    let mut dry = tug(&tmp_path);
    dry.current_dir(&root);
    dry.env("TUG_SESSION_ID", "seg-old");
    dry.args(["--json", "arc", "bind", "demo", "--dry-run"]);
    let out = dry.output().unwrap();
    assert!(
        out.status.success(),
        "dry run failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let document: serde_json::Value =
        serde_json::from_slice(&out.stdout).expect("the dry run prints one JSON document");
    let data = &document["data"];
    assert_eq!(data["dry_run"], true);
    assert_eq!(data["posted_session_id"], "seg-old");
    assert_eq!(
        data["tug_session_id"], "seg-new",
        "it reports the segment a real bind would land on, not the frozen one",
    );
    assert_eq!(data["state"], "live");
    assert_eq!(data["line_id"], "line-1");
    assert_eq!(data["rotated"], true);

    let body = requests
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("it resolves through the same chokepoint a real bind does");
    assert_eq!(body["op"], "resolve");
    assert!(
        requests
            .recv_timeout(std::time::Duration::from_millis(500))
            .is_err(),
        "and posts nothing else — a dry run is a read",
    );
}

/// The plain-text half of the same read, for a person at a prompt.
#[test]
fn arc_bind_dry_run_says_it_wrote_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    repo_with_arc(&root, "demo");

    let (port, _requests) = fake_tugcast_resolving_to("seg-new", "live", "line-1");
    register_fake_instance(&tmp_path, port);

    let mut dry = tug(&tmp_path);
    dry.current_dir(&root);
    dry.env("TUG_SESSION_ID", "seg-old");
    dry.args(["arc", "bind", "demo", "--dry-run"]);
    let out = dry.output().unwrap();
    assert!(out.status.success());
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("Would bind session seg-new"), "{text}");
    assert!(text.contains("State: live"), "{text}");
    assert!(text.contains("which has rotated"), "{text}");
    assert!(text.contains("Nothing was written."), "{text}");
}

/// A refused claim fails the verb that made it.
///
/// `arc create` mints a worktree *and* records who is working it. When the
/// second half is refused by an instance that could have done it, the verb
/// used to print a stderr warning and exit 0 — so a script, and a skill, read
/// the run as wholly successful and went on. The worktree still exists and the
/// receipt still says so; what changed is that the exit code and the JSON both
/// carry the half that did not happen.
#[test]
fn a_refused_claim_fails_arc_create_and_says_so_in_the_json() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    GitFixture::init(&root);
    std::fs::create_dir_all(root.join(".tugtool")).unwrap();
    std::fs::write(root.join(".tugtool/config.toml"), "").unwrap();
    std::fs::write(root.join("a.txt"), "base\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-m", "base"]);

    let (port, _requests) = fake_tugcast_refusing_bind(&root, "card runs another-arc");
    register_fake_instance(&tmp_path, port);

    let mut create = tug(&tmp_path);
    create.current_dir(&root);
    create.env("TUG_SESSION_ID", "seg-1");
    create.args(["--json", "arc", "create", "demo"]);
    let out = create.output().unwrap();

    assert!(
        !out.status.success(),
        "a claim that did not happen must not read as a clean run"
    );

    let document: serde_json::Value =
        serde_json::from_slice(&out.stdout).expect("the receipt is still a document");
    // Under `--json` the reason rides the envelope rather than stderr: the
    // receipt is an error envelope whose first issue is the refusal.
    assert_eq!(document["status"], "error", "{document}");
    assert_eq!(document["issues"][0]["code"], "claim_refused", "{document}");
    assert!(
        document["issues"][0]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("card runs another-arc"),
        "the refusal names the instance's own reason: {document}"
    );
    assert_eq!(document["data"]["claimed"], false);
    assert!(
        document["data"]["claim_error"]
            .as_str()
            .unwrap_or_default()
            .contains("card runs another-arc"),
        "{}",
        document["data"]
    );
    assert_eq!(
        document["data"]["created"], true,
        "and the half that did happen is still reported as done",
    );
    assert!(
        root.join(".tug/worktrees/demo").is_dir(),
        "the worktree is on disk; the verb failed about the claim, not the create",
    );
}

/// A run with no calling session claims nothing, and that is not a failure.
///
/// Headless runs and fixtures have no session to record, and never had. The
/// JSON says which of the three happened rather than leaving a reader to infer
/// it from an exit code that is the same either way.
#[test]
fn a_run_with_no_session_reports_the_claim_skipped_and_succeeds() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    GitFixture::init(&root);
    std::fs::create_dir_all(root.join(".tugtool")).unwrap();
    std::fs::write(root.join(".tugtool/config.toml"), "").unwrap();
    std::fs::write(root.join("a.txt"), "base\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-m", "base"]);

    // No registry, no session: `tug()` already removes TUG_SESSION_ID.
    let mut create = tug(&tmp_path);
    create.current_dir(&root);
    create.args(["--json", "arc", "create", "demo"]);
    let out = create.output().unwrap();
    assert!(
        out.status.success(),
        "a headless create is not a failure: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    let document: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(document["data"]["claimed"], false);
    assert_eq!(document["data"]["claim_skipped"], "no calling session");
}

/// A claim the calling session was never entitled to make is skipped, not
/// failed on.
///
/// A session may only bind an arc in its own checkout. When a CLI fixture
/// creates a scratch arc in a temp repo from inside a card — the everyday
/// shape in this very test suite — the bind would be refused for a reason that
/// says nothing about whether a claim was lost. It is a no-op of the same kind
/// as having no session at all, and the JSON names it as one.
#[test]
fn a_session_in_another_checkout_skips_the_claim_and_succeeds() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let elsewhere = elsewhere.path().canonicalize().unwrap();
    GitFixture::init(&root);
    std::fs::create_dir_all(root.join(".tugtool")).unwrap();
    std::fs::write(root.join(".tugtool/config.toml"), "").unwrap();
    std::fs::write(root.join("a.txt"), "base\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-m", "base"]);

    // The session works `elsewhere`; the arc is being made in `root`.
    let (port, requests) = fake_tugcast_refusing_bind(&elsewhere, "it cannot bind an arc in");
    register_fake_instance(&tmp_path, port);

    let mut create = tug(&tmp_path);
    create.current_dir(&root);
    create.env("TUG_SESSION_ID", "seg-1");
    create.args(["--json", "arc", "create", "demo"]);
    let out = create.output().unwrap();
    assert!(
        out.status.success(),
        "a claim that was never this session's to make is not a failure: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    let document: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(document["data"]["claimed"], false);
    assert_eq!(
        document["data"]["claim_skipped"],
        "the calling session works another checkout",
    );

    let body = requests
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("it resolves to find out");
    assert_eq!(body["op"], "resolve");
    assert!(
        requests
            .recv_timeout(std::time::Duration::from_millis(500))
            .is_err(),
        "and posts no bind it already knows would be refused",
    );
}

/// An instance older than the resolve's `project_dir` cannot be asked, so a
/// refusal from it warns rather than failing the verb.
///
/// The version-skew rule W1 paid for: a new `tugtool` against a tugcast that
/// has not restarted must degrade to what it did before, never refuse
/// wholesale.
#[test]
fn a_refusal_from_an_instance_that_cannot_place_the_session_only_warns() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    GitFixture::init(&root);
    std::fs::create_dir_all(root.join(".tugtool")).unwrap();
    std::fs::write(root.join(".tugtool/config.toml"), "").unwrap();
    std::fs::write(root.join("a.txt"), "base\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-m", "base"]);

    // A resolve answer with no `project_dir` — the older instance's shape.
    let (port, _requests) = fake_tugcast_with(ResolveAnswer::RefusingBind {
        resolve: r#"{"status":"ok","session_id":"seg-1","state":"live"}"#.to_string(),
        refusal: r#"{"status":"error","message":"card runs another-arc"}"#.to_string(),
    });
    register_fake_instance(&tmp_path, port);

    let mut create = tug(&tmp_path);
    create.current_dir(&root);
    create.env("TUG_SESSION_ID", "seg-1");
    create.args(["--json", "arc", "create", "demo"]);
    let out = create.output().unwrap();
    assert!(
        out.status.success(),
        "an unclassifiable refusal must not refuse the build: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("card runs another-arc"),
        "but it is still said out loud",
    );

    let document: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(document["data"]["claimed"], false);
}

/// **The walk's shrug stays branchable.** When every instance answers
/// `unknown_session`, the refusal is prose — but it still carries the token,
/// because that refusal has one legitimately transient cause and a caller
/// sitting out that window has nothing else to branch on.
///
/// A card's ledger row lands a moment after the card itself, so a bind issued
/// in between is refused by a machine that will know the session in half a
/// second. `tests/app-test/arc-fixture.ts`'s `bin` polls through exactly
/// that window on the token. Turning the walk's raw message into prose without
/// it broke that loop silently, and the breakage surfaced three workstreams
/// later as `at0475` failing at `arc bind`. This test is what makes the next
/// rewrite of the sentence a red `cargo nextest` instead.
#[test]
fn the_unknown_session_refusal_keeps_its_branchable_token() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    repo_with_arc(&root, "demo");

    let (port, _requests) = fake_tugcast_with(ResolveAnswer::UnknownSession);
    register_fake_instance(&tmp_path, port);

    let mut bind = tug(&tmp_path);
    bind.current_dir(&root);
    bind.env("TUG_SESSION_ID", "sess-not-yet-recorded");
    bind.args(["arc", "bind", "demo"]);
    let out = bind.output().unwrap();
    assert_eq!(out.status.code(), Some(1), "the bind is refused");

    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("no running Tug instance knows session sess-not-yet-recorded"),
        "a person reads a sentence: {stderr}"
    );
    assert!(
        stderr.contains("unknown_session"),
        "and a caller waiting out the spawn window reads the token: {stderr}"
    );
}

/// **Under `--json` the shrug is a code.** The same refusal as above, read
/// the way `tests/app-test/arc-fixture.ts` reads it: `issues[0].code` is
/// `unknown_session`, so the retry branches on a name rather than a sentence.
#[test]
fn the_unknown_session_refusal_is_a_code_under_json() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    repo_with_arc(&root, "demo");

    let (port, _requests) = fake_tugcast_with(ResolveAnswer::UnknownSession);
    register_fake_instance(&tmp_path, port);

    for args in [
        vec!["arc", "bind", "demo", "--json"],
        vec!["arc", "documents", "demo", "--ensure", "--bind", "--json"],
    ] {
        let mut cmd = tug(&tmp_path);
        cmd.current_dir(&root);
        cmd.env("TUG_SESSION_ID", "sess-not-yet-recorded");
        cmd.args(&args);
        let out = cmd.output().unwrap();
        assert_eq!(out.status.code(), Some(1), "{args:?} is refused");
        let envelope: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(envelope["status"], "error", "{args:?}: {envelope}");
        assert_eq!(
            envelope["issues"][0]["code"], "unknown_session",
            "{args:?}: {envelope}"
        );
    }
}
