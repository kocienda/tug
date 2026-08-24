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

/// Park a real conflict chain on `name` and mark a resolve begun on it, as a
/// resolver in another process would have left it. Returns the marker commit.
fn park_a_leased_conflict(root: &Path, name: &str) -> String {
    let worktree = root.join(".tug/worktrees").join(name);
    std::fs::write(worktree.join("a.txt"), "dash side\n").unwrap();
    git(&worktree, &["commit", "-am", "the dash edits a"]);
    std::fs::write(root.join("a.txt"), "base side\n").unwrap();
    git(root, &["add", "-A"]);
    git(root, &["commit", "-m", "the base edits a"]);

    let outcome = tugdash_core::resolve::resolve_conflicts(root, name, None).unwrap();
    assert!(
        !outcome.unresolved.is_empty(),
        "the fixture must actually conflict"
    );
    tugdash_core::resolve::mark_resolve_begun(root, name).expect("the begin marker lands")
}

fn conflict_tip(root: &Path, name: &str) -> Option<String> {
    tugdash_core::resolve::read_conflict(root, name).map(|c| c.tip)
}

/// The lease reaches every CLI door: the preview names it, the join refuses on
/// it, and `--break-lease` proceeds with a receipt the op log holds.
#[test]
fn dash_join_names_a_live_resolve_and_break_lease_lands_it() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    repo_with_dash(&root, "demo");
    let marker = park_a_leased_conflict(&root, "demo");

    let mut preview = tug(&tmp_path);
    preview.current_dir(&root);
    preview.args(["dash", "join", "demo", "--preview", "--json"]);
    let out = preview.output().unwrap();
    assert!(out.status.success(), "a preview reports, never refuses");
    let body: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let blockers = body["data"]["blockers"].as_array().expect("blockers");
    assert!(
        blockers.iter().any(|b| b["kind"] == "live-resolve"),
        "{body}"
    );

    let mut refused = tug(&tmp_path);
    refused.current_dir(&root);
    refused.args(["dash", "join", "demo"]);
    let out = refused.output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("A resolve may still be running"), "{stderr}");
    assert_eq!(conflict_tip(&root, "demo").as_deref(), Some(marker.as_str()));

    // The base takes its own edit back, so the dash merges cleanly; the chain
    // is stale but the lease reads the tip, not validity.
    std::fs::write(root.join("a.txt"), "base\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-m", "the base backs its edit out"]);

    let mut broke = tug(&tmp_path);
    broke.current_dir(&root);
    broke.args(["dash", "join", "demo", "--break-lease", "--json"]);
    let out = broke.output().unwrap();
    assert!(
        out.status.success(),
        "the break lands the join: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let body: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let warnings = body["data"]["warnings"].as_array().expect("warnings");
    assert!(
        warnings
            .iter()
            .any(|w| w.as_str().unwrap_or_default().contains("Broke the resolve lease")),
        "{body}"
    );

    let mut list = tug(&tmp_path);
    list.current_dir(&root);
    list.args(["dash", "undo", "--list"]);
    let out = list.output().unwrap();
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("broke lease"), "{stdout}");
}

/// `--resolve` is the third cross-process door: the ladder would clear the
/// chain outright, so it is refused before it runs ([P06]).
#[test]
fn dash_join_resolve_refuses_over_a_live_chain_and_leaves_it_standing() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    repo_with_dash(&root, "demo");
    let marker = park_a_leased_conflict(&root, "demo");

    let mut resolve = tug(&tmp_path);
    resolve.current_dir(&root);
    resolve.args(["dash", "join", "demo", "--resolve"]);
    let out = resolve.output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("A resolve may still be running"), "{stderr}");
    assert!(stderr.contains("to resolve anyway"), "{stderr}");

    assert_eq!(
        conflict_tip(&root, "demo").as_deref(),
        Some(marker.as_str()),
        "the ladder never ran, so the resolver's chain is exactly as it was"
    );
    assert!(
        tugdash_core::resolve::read_candidate(&root, "demo").is_none(),
        "and no candidate was built over it"
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

// ---------------------------------------------------------------------------
// A join killed mid-teardown, and resumed
// ---------------------------------------------------------------------------

/// A `git` that forwards every call to the real one, except the call it was
/// told to stop at — where it announces itself and then blocks until the test
/// opens the gate.
///
/// A pause point outside the product is what makes this a *crash* test rather
/// than a crash-hook test: nothing in `tugdash-core` knows it is being watched,
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
  : > "$SHIM_PAUSED"
  while [ ! -f "$SHIM_GATE" ]; do sleep 0.05; done
fi
exec "$SHIM_REAL_GIT" "$@"
"#;

/// Run `tugutil dash join <name>` under the shim and SIGKILL it the moment the
/// teardown reaches `pause_on`.
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
    let real_git = String::from_utf8(
        Command::new("which")
            .arg("git")
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_string();
    let paused = shim_dir.join("paused");
    let gate = shim_dir.join("gate");

    let mut cmd = tug(tmp);
    cmd.current_dir(root);
    cmd.args(["dash", "join", name]);
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
    cmd.env("SHIM_GATE", &gate);
    cmd.env("SHIM_SEEN_BRANCH_D", shim_dir.join("saw-branch-d"));
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
    child.kill().unwrap();
    let _ = child.wait();
    std::fs::write(&gate, "go").unwrap();
}

fn oplog_list(tmp: &Path, root: &Path) -> String {
    let mut cmd = tug(tmp);
    cmd.current_dir(root);
    cmd.args(["dash", "undo", "--list"]);
    let out = cmd.output().unwrap();
    assert!(out.status.success());
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn continue_join(tmp: &Path, root: &Path, name: &str) {
    let mut cmd = tug(tmp);
    cmd.current_dir(root);
    cmd.args(["dash", "join", name, "--continue"]);
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
        !branch_exists(root, &format!("tugdash/{name}")),
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
    undo.args(["dash", "undo", name]);
    let out = undo.output().unwrap();
    assert!(
        out.status.success(),
        "and the finished join is undoable: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn branch_exists(root: &Path, branch: &str) -> bool {
    Command::new("git")
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
    repo_with_dash(&root, "demo");

    kill_join_at(&tmp_path, &root, "demo", "worktree remove");

    assert!(root.join(".tug/worktrees/demo").exists(), "worktree still there");
    assert!(branch_exists(&root, "tugdash/demo"), "branch still there");
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
    repo_with_dash(&root, "demo");

    kill_join_at(&tmp_path, &root, "demo", "branch -D");

    assert!(!root.join(".tug/worktrees/demo").exists(), "worktree gone");
    assert!(branch_exists(&root, "tugdash/demo"), "branch still there");
    let listing = oplog_list(&tmp_path, &root);
    assert!(
        listing.contains("incomplete (teardown at WorktreeRemoved)"),
        "{listing}"
    );

    continue_join(&tmp_path, &root, "demo");
    assert_finished(&tmp_path, &root, "demo");
}

/// The boundary that had no resume at all before the fold: with the branch
/// already deleted, a `--continue` used to be refused as `Dash not found`.
#[test]
fn a_join_killed_after_its_branch_goes_is_resumed_by_continue() {
    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().canonicalize().unwrap();
    let repo_dir = tempfile::tempdir().unwrap();
    let root = repo_dir.path().canonicalize().unwrap();
    repo_with_dash(&root, "demo");

    kill_join_at(&tmp_path, &root, "demo", "after-branch-delete");

    assert!(!branch_exists(&root, "tugdash/demo"), "branch gone");
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
    repo_with_dash(&root, "demo");

    // Reach the same state an old build would have been killed in, then
    // rewrite that state the way the old build recorded it: a journal file and
    // no operation at all.
    kill_join_at(&tmp_path, &root, "demo", "worktree remove");
    let state = state_dir_with_payloads(&tmp_path);
    let head = git_stdout(&root, &["rev-parse", "HEAD"]);
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
