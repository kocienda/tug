//! `tugtool apptest record` and `tugtool apptest history`.
//!
//! End to end through `TUG_APPTEST_RESULTS_DB`, which is how both the CLI
//! suite and the recipe's own integration checks keep clear of the real
//! record. What is proven here is the wire: what the recipe writes on stdin
//! becomes rows, and what the recipe reads back is the shape S03 promised.

use std::path::Path;
use std::process::{Command, Stdio};

use assert_cmd::cargo::CommandCargoExt;
use std::io::Write;

fn record(db: &Path, payload: &str) -> (i32, String) {
    let mut child = Command::cargo_bin("tugtool")
        .unwrap()
        .args(["apptest", "record"])
        .env("TUG_APPTEST_RESULTS_DB", db)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(payload.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
    )
}

fn history(db: &Path, root: &Path, files: &[&str]) -> serde_json::Value {
    let out = Command::cargo_bin("tugtool")
        .unwrap()
        .args(["apptest", "history", "--json", "--root"])
        .arg(root)
        .args(files)
        .env("TUG_APPTEST_RESULTS_DB", db)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "history exited {:?}: {}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

fn payload(root: &Path, sha: &str, at: i64, file: &str, status: &str) -> String {
    let verdict = if status == "PASS" { "PASS" } else { "FAIL" };
    serde_json::json!({
        "startedAt": at - 60, "endedAt": at,
        "runRoot": root.to_string_lossy(), "branch": "main", "headSha": sha,
        "dirty": false, "sweep": "explicit-files", "selection": "changed",
        "wallSecs": 60, "verdict": verdict,
        "files": [{"file": file, "status": status, "passed": 3, "total": 3,
                   "secs": 20, "foreground": false}]
    })
    .to_string()
}

#[test]
fn a_round_trip_flips_from_green_to_a_streak() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("apptest_results.db");
    let root = dir.path().join("checkout");
    std::fs::create_dir_all(&root).unwrap();
    let file = "at0417-join-mode.test.ts";

    let (code, out) = record(&db, &payload(&root, "0519182", 1_755_000_000, file, "PASS"));
    assert_eq!(code, 0, "record must succeed: {out}");
    let receipt: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(receipt["recorded"], true);
    assert_eq!(receipt["pruned"], 0);
    assert!(receipt["runId"].as_i64().unwrap() > 0);

    let answers = history(&db, &root, &[file]);
    assert_eq!(answers["files"][0]["answer"], "last-green");
    assert_eq!(answers["files"][0]["sha"], "0519182");
    assert_eq!(answers["files"][0]["runsAgo"], 0);

    let (code, _) = record(&db, &payload(&root, "dac7cfc", 1_755_086_400, file, "FAIL"));
    assert_eq!(code, 0);
    let answers = history(&db, &root, &[file]);
    let answer = &answers["files"][0];
    assert_eq!(answer["answer"], "red-streak");
    assert_eq!(answer["count"], 1);
    assert_eq!(answer["backToSha"], "dac7cfc");
    assert_eq!(answer["lastGreen"]["sha"], "0519182");
    assert_eq!(answer["lastGreen"]["runsAgo"], 1);
}

#[test]
fn a_file_with_no_rows_answers_no_history() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("apptest_results.db");
    let answers = history(&db, dir.path(), &["at9999-never-run.test.ts"]);
    assert_eq!(answers["files"][0]["answer"], "no-history");
    assert_eq!(answers["files"][0]["file"], "at9999-never-run.test.ts");
}

#[test]
fn a_malformed_payload_exits_nonzero_and_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("apptest_results.db");
    // Every field but `verdict`.
    let missing = serde_json::json!({
        "startedAt": 1, "endedAt": 2, "runRoot": "/tmp/x", "branch": "main",
        "headSha": "abc", "dirty": false, "sweep": "core",
        "wallSecs": 1, "files": []
    })
    .to_string();
    let (code, out) = record(&db, &missing);
    assert_ne!(code, 0, "a missing required field must refuse");
    assert!(out.is_empty(), "a refused record prints no receipt");
    assert!(!db.exists(), "a refused record leaves no database behind");
}

#[test]
fn a_missing_selection_records_as_explicit() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("apptest_results.db");
    let root = dir.path().join("checkout");
    std::fs::create_dir_all(&root).unwrap();
    let no_selection = serde_json::json!({
        "startedAt": 1, "endedAt": 2, "runRoot": root.to_string_lossy(),
        "branch": "main", "headSha": "abc", "dirty": false, "sweep": "core",
        "wallSecs": 1, "verdict": "PASS",
        "files": [{"file": "at0001.test.ts", "status": "PASS", "passed": 1,
                   "total": 1, "secs": 1}]
    })
    .to_string();
    let (code, out) = record(&db, &no_selection);
    assert_eq!(
        code, 0,
        "an absent selection is a default, not a refusal: {out}"
    );
    // The file still answers, which is the only thing the recipe reads back.
    let answers = history(&db, &root, &["at0001.test.ts"]);
    assert_eq!(answers["files"][0]["answer"], "last-green");
}

#[test]
fn history_answers_every_file_it_was_asked_about() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("apptest_results.db");
    let root = dir.path().join("checkout");
    std::fs::create_dir_all(&root).unwrap();
    record(
        &db,
        &payload(&root, "aaa", 1_755_000_000, "at0001.test.ts", "PASS"),
    );
    let answers = history(
        &db,
        &root,
        &["at0001.test.ts", "at0002.test.ts", "at0003.test.ts"],
    );
    let files = answers["files"].as_array().unwrap();
    assert_eq!(files.len(), 3, "one answer per file asked, in order");
    assert_eq!(files[0]["answer"], "last-green");
    assert_eq!(files[1]["answer"], "no-history");
    assert_eq!(files[2]["file"], "at0003.test.ts");
}
