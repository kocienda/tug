//! The `--json` envelope on the failure path, one dispatcher at a time.
//!
//! `--json` means one JSON document on stdout whether the verb succeeded or
//! failed (`tuglaws/tugtool-json.md`). Each test here forces a dispatcher's
//! failure in a scratch directory that is no project, no repository, and no
//! instance, and reads the one document back: `status: "error"`, a named
//! `issues[0].code`, and the exit code the failure always had.
//!
//! The last test is the fence around the printers: nothing outside
//! `src/output.rs` builds or prints an envelope, so a new verb cannot grow a
//! hand-rolled one that drifts from the contract.

mod common;
use common::tugtool;

use std::path::Path;
use std::process::Command;

/// A spawn that can reach nothing of the developer's: no session, no
/// instance registry (it lives under `$TMPDIR`), no data root, no session
/// index — and a cwd that is no checkout.
fn scratch(dir: &Path) -> Command {
    let mut cmd = tugtool();
    cmd.current_dir(dir);
    cmd.env("TMPDIR", dir);
    cmd.env("TUG_DATA_DIR", dir.join("data"));
    cmd.env("TUG_SESSION_INDEX_DB", dir.join("session_index.db"));
    cmd.env_remove("TUG_INSTANCE");
    cmd
}

/// Run `args` and return the envelope, having checked it is the one document
/// on stdout, that it failed with a named cause, and the exit code.
fn failed(args: &[&str], command: &str, exit: i32) -> serde_json::Value {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let out = scratch(&root).args(args).output().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let envelope: serde_json::Value = serde_json::from_str(&stdout)
        .unwrap_or_else(|e| panic!("{args:?}: stdout is not one JSON document ({e}): {stdout}"));
    assert_eq!(out.status.code(), Some(exit), "{args:?}: {envelope}");
    assert_eq!(envelope["schema_version"], "1", "{envelope}");
    assert_eq!(envelope["command"], command, "{envelope}");
    assert_eq!(envelope["status"], "error", "{envelope}");
    let code = envelope["issues"][0]["code"].as_str().unwrap_or("");
    assert!(
        !code.is_empty(),
        "{args:?}: issues[0].code is the cause: {envelope}"
    );
    assert_eq!(envelope["issues"][0]["severity"], "error", "{envelope}");
    assert!(
        !envelope["issues"][0]["message"]
            .as_str()
            .unwrap_or("")
            .is_empty(),
        "{envelope}"
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        !stderr.contains("error: "),
        "{args:?}: the envelope carries the message, so stderr does not repeat it: {stderr}"
    );
    envelope
}

fn code(envelope: &serde_json::Value) -> &str {
    envelope["issues"][0]["code"].as_str().unwrap()
}

/// The shared `finish` path: `changes`, `commit`, `claim`, `draft`, and the rest.
#[test]
fn changes_without_a_session_fails_in_the_envelope() {
    let envelope = failed(&["changes", "--json"], "changes", 2);
    assert_eq!(code(&envelope), "no_session_id");
}

#[test]
fn draft_without_an_owner_fails_in_the_envelope() {
    failed(&["draft", "show", "--json"], "draft show", 1);
}

#[test]
fn an_arc_verb_outside_a_repository_fails_in_the_envelope() {
    let envelope = failed(&["arc", "show", "demo", "--json"], "arc show", 3);
    assert_eq!(code(&envelope), "arc_refused");
}

#[test]
fn a_plan_that_does_not_resolve_fails_in_the_envelope() {
    let envelope = failed(
        &["plan", "status", "no-such-plan.md", "--json"],
        "plan status",
        2,
    );
    assert_eq!(code(&envelope), "unresolved");
}

#[test]
fn brief_dir_outside_a_project_fails_in_the_envelope() {
    failed(&["brief", "dir", "--json"], "brief dir", 1);
}

#[test]
fn a_mistyped_session_reference_fails_in_the_envelope() {
    let envelope = failed(
        &["session", "show", "00000000-dead", "--json"],
        "session show",
        1,
    );
    assert_eq!(code(&envelope), "not_a_session_reference");
}

#[test]
fn showing_an_absent_session_fails_in_the_envelope() {
    let envelope = failed(
        &[
            "session",
            "show",
            "0f3c1e5a-0000-0000-0000-000000000000",
            "--json",
        ],
        "session show",
        3,
    );
    assert_eq!(code(&envelope), "session_absent");
}

#[test]
fn a_deck_verb_with_no_instance_fails_in_the_envelope() {
    failed(
        &[
            "deck", "motion", "slide", "--from", "a", "--to", "b", "--json",
        ],
        "deck motion slide",
        1,
    );
}

#[test]
fn an_unknown_gate_fails_in_the_envelope() {
    let envelope = failed(
        &[
            "host", "gate", "run", "--json", "--name", "bogus", "--", "true",
        ],
        "host gate run",
        64,
    );
    assert_eq!(code(&envelope), "unknown_gate");
}

/// The `host` dispatcher's own failure path: a verb that needs an instance,
/// with none to find.
#[test]
fn a_host_verb_with_no_instance_fails_in_the_envelope() {
    failed(&["host", "changesets", "--json"], "host changesets", 1);
}

/// The groups whose verbs share one dispatcher name each verb in full, the
/// same name its success envelope carries.
#[test]
fn a_grouped_verb_names_itself_in_full() {
    failed(&["file", "mv", "no-such-file", "x", "--json"], "file mv", 1);
}

/// **Only `src/output.rs` makes an envelope.** Its printers — `print_ok`,
/// `print_error`, `print_error_with`, `print_receipt`, `print_held`,
/// `print_diagnosed` — are the one way a verb answers `--json`. A
/// `JsonResponse` named anywhere else, or an envelope spelled by hand with a
/// `"schema_version"` key, is a print site that can drift from the contract.
#[test]
fn only_the_output_printers_make_an_envelope() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut offenders = Vec::new();
    let mut stack = vec![src.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("rs")
                || path == src.join("output.rs")
            {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            for (n, line) in text.lines().enumerate() {
                let code = line.split("//").next().unwrap_or("");
                if code.contains("JsonResponse") || code.contains("\"schema_version\"") {
                    offenders.push(format!("{}:{}: {}", path.display(), n + 1, line.trim()));
                }
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "an envelope is made only by src/output.rs's printers:\n{}",
        offenders.join("\n")
    );
}
