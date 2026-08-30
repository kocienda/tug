//! The `tugtool file gate` decision as the PreToolUse hook actually gets it:
//! by running the binary and reading its JSON.
//!
//! The grammar's own judgments are unit-tested where the grammar lives, and the
//! gate's mapping from refusal to steering text is tested inline in
//! `commands/file.rs`. What only a process can show is the whole path — a
//! command in, one line of JSON out, exit 0 whatever happens — which is what
//! the hook depends on and what a broken gate would take down silently.

use std::path::Path;
use std::process::{Command, Output};

/// The gate resolves a path against a checkout, so the test needs a real one.
/// `git init` rather than a hand-written `.git` because this is the process
/// tier: the thing under test is what happens on a real tree.
fn checkout() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temp");
    let out = Command::new("git")
        .args(["init", "-q", "-b", "main"])
        .current_dir(dir.path())
        .output()
        .expect("git init");
    assert!(out.status.success(), "git init failed");
    dir
}

fn gate(root: &Path, command: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_tugtool"))
        .args(["file", "gate", "--command", command, "--base-dir"])
        .arg(root)
        .output()
        .expect("run tugtool file gate")
}

fn decision(out: &Output) -> serde_json::Value {
    assert_eq!(
        out.status.code(),
        Some(0),
        "the gate must always exit 0 — a crashed gate has to fail open"
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(stdout.trim()).unwrap_or_else(|e| panic!("not JSON: {stdout} ({e})"))
}

#[test]
fn an_interpreter_writing_a_repo_file_is_denied_and_steered_at_the_rev() {
    let dir = checkout();
    let out = gate(
        dir.path(),
        "python3 - <<'PY'\nimport pathlib\npathlib.Path('src/main.tsx').write_text('x')\nPY",
    );
    let decision = decision(&out);
    assert_eq!(decision["decision"], "deny");
    let reason = decision["reason"].as_str().expect("a reason");
    assert!(reason.contains("tugtool file edit"), "{reason}");
    assert!(reason.contains("src/main.tsx"), "{reason}");
    assert!(
        reason.contains('\n'),
        "the steer shows the shape, which needs its own lines: {reason}"
    );
}

#[test]
fn a_read_only_heredoc_and_a_script_file_are_allowed() {
    let dir = checkout();
    for command in [
        "python3 - <<'PY'\nprint(open('src/main.tsx').read())\nPY",
        "python3 tools/analyze.py src/main.tsx",
        "python3 - <<'PY'\nopen('/tmp/scratch.json','w').write('x')\nPY",
    ] {
        let decision = decision(&gate(dir.path(), command));
        assert_eq!(decision["decision"], "allow", "for `{command}`");
        assert!(decision.get("reason").is_none(), "for `{command}`");
    }
}

#[test]
fn the_older_refusals_still_reach_their_own_verbs() {
    let dir = checkout();
    let lifecycle = decision(&gate(dir.path(), "rm -rf apptest-*"));
    assert_eq!(lifecycle["decision"], "deny");
    assert!(
        lifecycle["reason"]
            .as_str()
            .expect("a reason")
            .contains("rm|mv|cp")
    );

    let edit = decision(&gate(dir.path(), "sed -i '' 's/a/b/' src/*.ts"));
    assert_eq!(edit["decision"], "deny");
    assert!(
        edit["reason"]
            .as_str()
            .expect("a reason")
            .contains("tugtool file edit")
    );

    assert_eq!(decision(&gate(dir.path(), "rm a.ts"))["decision"], "allow");
}

#[test]
fn an_edit_program_is_never_gated_against_itself() {
    let dir = checkout();
    let out = gate(
        dir.path(),
        "tugtool file edit <<'EDIT'\nfile src/main.tsx\n  delete 166\nEDIT",
    );
    assert_eq!(decision(&out)["decision"], "allow");
}

/// The hook is the only consumer of the gate's JSON, and the steer's whole
/// value is the shape it shows — a reason flattened on the way through would
/// leave the model a paragraph instead of an example. So the test drives the
/// real script.
///
/// It runs the repo's copy. The one the app actually executes lives in the
/// bundle (`Contents/Resources/tugplug/hooks/`), which is a deployment fact no
/// test can stand in for.
#[test]
fn the_hook_renders_the_steer_with_its_example_intact() {
    let dir = checkout();
    let hook = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tugplug/hooks/pre-tool-use.sh")
        .canonicalize()
        .expect("the hook is in the tree");
    let tools = Path::new(env!("CARGO_BIN_EXE_tugtool"))
        .parent()
        .expect("a bin dir")
        .to_path_buf();
    let path = format!(
        "{}:{}",
        tools.display(),
        std::env::var("PATH").unwrap_or_default()
    );

    let payload = serde_json::json!({
        "tool_name": "Bash",
        "tool_input": {
            "command": "python3 - <<'PY'\nimport pathlib\npathlib.Path('src/main.tsx').write_text('x')\nPY"
        }
    })
    .to_string();

    let mut child = Command::new("bash")
        .arg(&hook)
        .current_dir(dir.path())
        .env("PATH", path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("run the hook");
    use std::io::Write;
    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(payload.as_bytes())
        .expect("write payload");
    let out = child.wait_with_output().expect("wait");

    let stdout = String::from_utf8_lossy(&out.stdout);
    let decision: serde_json::Value =
        serde_json::from_str(stdout.trim()).unwrap_or_else(|e| panic!("not JSON: {stdout} ({e})"));
    let hook_output = &decision["hookSpecificOutput"];
    assert_eq!(hook_output["permissionDecision"], "deny");
    let reason = hook_output["permissionDecisionReason"]
        .as_str()
        .expect("a reason");
    assert!(reason.contains("tugtool file edit <<'EDIT'"), "{reason}");
    assert!(reason.contains("\n  file tugdeck/src/main.tsx"), "{reason}");
    assert!(reason.contains("--preview"), "{reason}");
}
