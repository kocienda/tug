//! `tugutil wire …` — the verb surface over the tripwires ledger.
//!
//! End to end through `TUG_TRIPWIRES_DB`, which is how the CLI suite keeps
//! clear of the machine's real wires. What is proven here is the wire between
//! the command line and the ledger: what a person types becomes a stored Spec
//! S01 trigger, what the ledger holds is what `--json` reports, and a verb
//! that refuses leaves the record exactly as it was.
//!
//! The predicate's own semantics are proved in `tugutil-core` against pure
//! values, and the ledger's arbitration is proved there against a real file,
//! so nothing here stands up a substitute for either.

use std::path::Path;
use std::process::{Command, Output};

use assert_cmd::cargo::CommandCargoExt;

fn wire(db: &Path, args: &[&str]) -> Output {
    Command::cargo_bin("tugutil")
        .unwrap()
        .arg("wire")
        .args(args)
        .env("TUG_TRIPWIRES_DB", db)
        .output()
        .unwrap()
}

fn wire_json(db: &Path, args: &[&str]) -> serde_json::Value {
    let mut with_json = vec!["--json"];
    with_json.extend_from_slice(args);
    let out = Command::cargo_bin("tugutil")
        .unwrap()
        .args(with_json)
        .env("TUG_TRIPWIRES_DB", db)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{args:?} exited {:?}: {}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).expect("the envelope is json")
}

fn code(out: &Output) -> i32 {
    out.status.code().unwrap_or(-1)
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

fn db() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tripwires.db");
    (dir, path)
}

/// Every verb speaks the shared envelope, so a reader parses one shape.
fn assert_envelope(value: &serde_json::Value, command: &str) {
    assert_eq!(value["schema_version"], "1");
    assert_eq!(value["command"], command);
    assert_eq!(value["status"], "ok");
    assert!(value["issues"].is_array());
}

#[test]
fn a_wire_lays_and_reads_back_as_the_spec_s01_json_it_compiled_to() {
    let (_dir, db) = db();
    let laid = wire_json(
        &db,
        &[
            "wire",
            "lay",
            "tugedit",
            "--on",
            "fact:edit_failed",
            "--brief",
            "diagnose the failure",
        ],
    );
    assert_envelope(&laid, "wire lay");
    assert_eq!(laid["data"]["name"], "tugedit");
    assert_eq!(
        laid["data"]["trigger"],
        r#"{"fact":{"kind":"edit_failed"}}"#
    );
    assert_eq!(laid["data"]["tier"], "auto");
    assert_eq!(
        laid["data"]["resolved_tier"], "verdict",
        "no probe, so auto is the fast path"
    );
    assert_eq!(laid["data"]["post"], "auto");
    assert_eq!(laid["data"]["cooldown_secs"], 60);
    assert_eq!(laid["data"]["paused"], false);

    let listed = wire_json(&db, &["wire", "list"]);
    assert_envelope(&listed, "wire list");
    assert_eq!(listed["data"].as_array().unwrap().len(), 1);
    assert_eq!(listed["data"][0]["name"], "tugedit");
}

#[test]
fn the_where_spellings_compile_into_the_stored_trigger() {
    let (_dir, db) = db();
    let laid = wire_json(
        &db,
        &[
            "wire",
            "lay",
            "w",
            "--on",
            "fact:shell",
            "--where",
            "route=claude",
            "--where",
            "command~=file edit",
            "--brief",
            "b",
        ],
    );
    assert_eq!(
        laid["data"]["trigger"],
        r#"{"fact":{"kind":"shell","where":{"command":{"contains":"file edit"},"route":"claude"}}}"#
    );
}

/// A probe may write, so a wire that has one needs the dash worktree — and
/// the resolution is reported rather than left for a reader to infer.
#[test]
fn a_probe_resolves_the_auto_tier_to_work() {
    let (_dir, db) = db();
    let laid = wire_json(
        &db,
        &[
            "wire",
            "lay",
            "ci",
            "--on",
            "commit:main",
            "--probe",
            "just ci",
            "--scope",
            "/repo",
            "--brief",
            "b",
        ],
    );
    assert_eq!(laid["data"]["tier"], "auto");
    assert_eq!(laid["data"]["resolved_tier"], "work");
    assert_eq!(laid["data"]["trigger"], r#"{"commit":{"branch":"main"}}"#);
}

/// A preview is syntax and nothing else: it reports the same shape a lay
/// would, and the ledger never hears about it.
#[test]
fn a_preview_reports_the_wire_and_writes_nothing() {
    let (_dir, db) = db();
    let previewed = wire_json(
        &db,
        &[
            "wire",
            "lay",
            "ghost",
            "--on",
            "commit",
            "--probe",
            "just ci",
            "--brief",
            "b",
            "--preview",
        ],
    );
    assert_envelope(&previewed, "wire lay --preview");
    assert_eq!(previewed["data"]["name"], "ghost");
    assert_eq!(previewed["data"]["resolved_tier"], "work");

    let listed = wire_json(&db, &["wire", "list"]);
    assert!(
        listed["data"].as_array().unwrap().is_empty(),
        "a preview lays nothing: {listed}"
    );
}

#[test]
fn an_invalid_preview_refuses_without_touching_the_ledger() {
    let (_dir, db) = db();
    let out = wire(
        &db,
        &["lay", "w", "--on", "factt:x", "--brief", "b", "--preview"],
    );
    assert_eq!(code(&out), 1);
    assert!(stderr(&out).contains("factt"), "{}", stderr(&out));
    assert!(
        wire_json(&db, &["wire", "list"])["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_bad_where_spelling_names_the_clause_it_choked_on() {
    let (_dir, db) = db();
    let out = wire(
        &db,
        &[
            "lay", "w", "--on", "fact:x", "--where", "nonsense", "--brief", "b",
        ],
    );
    assert_eq!(code(&out), 1);
    assert!(stderr(&out).contains("nonsense"), "{}", stderr(&out));
}

#[test]
fn a_second_wire_under_one_name_refuses_and_leaves_the_first() {
    let (_dir, db) = db();
    wire_json(
        &db,
        &["wire", "lay", "w", "--on", "commit", "--brief", "first"],
    );
    let out = wire(&db, &["lay", "w", "--on", "commit", "--brief", "second"]);
    assert_eq!(code(&out), 1);
    assert!(stderr(&out).contains("already exists"), "{}", stderr(&out));
    assert_eq!(
        wire_json(&db, &["wire", "list"])["data"][0]["brief"],
        "first"
    );
}

#[test]
fn the_lay_pause_resume_rm_lifecycle_walks() {
    let (_dir, db) = db();
    wire_json(&db, &["wire", "lay", "w", "--on", "commit", "--brief", "b"]);

    let paused = wire_json(&db, &["wire", "pause", "w"]);
    assert_envelope(&paused, "wire pause");
    assert_eq!(paused["data"]["paused"], true);

    let resumed = wire_json(&db, &["wire", "resume", "w"]);
    assert_envelope(&resumed, "wire resume");
    assert_eq!(resumed["data"]["paused"], false);

    let removed = wire_json(&db, &["wire", "rm", "w"]);
    assert_envelope(&removed, "wire rm");
    assert!(
        wire_json(&db, &["wire", "list"])["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    let gone = wire(&db, &["rm", "w"]);
    assert_eq!(code(&gone), 1);
    assert!(
        stderr(&gone).contains("no wire named w"),
        "{}",
        stderr(&gone)
    );
}

#[test]
fn an_edit_moves_only_what_it_names_and_clear_empties_a_column() {
    let (_dir, db) = db();
    wire_json(
        &db,
        &[
            "wire", "lay", "w", "--on", "commit", "--probe", "just ci", "--scope", "/repo",
            "--brief", "b",
        ],
    );
    let edited = wire_json(&db, &["wire", "edit", "w", "--cooldown", "5"]);
    assert_envelope(&edited, "wire edit");
    assert_eq!(edited["data"]["cooldown_secs"], 5);
    assert_eq!(edited["data"]["brief"], "b", "untouched");
    assert_eq!(edited["data"]["probe"], "just ci", "untouched");

    let cleared = wire_json(&db, &["wire", "edit", "w", "--clear", "probe"]);
    assert!(cleared["data"]["probe"].is_null());
    assert_eq!(
        cleared["data"]["resolved_tier"], "verdict",
        "clearing the probe moves auto back to the fast path"
    );

    let bad = wire(&db, &["edit", "w", "--clear", "brief"]);
    assert_eq!(code(&bad), 1);
    assert!(stderr(&bad).contains("brief"), "{}", stderr(&bad));
}

/// A half-replaced predicate is the one shape nobody could reason about
/// later, so a trigger is edited whole.
#[test]
fn where_without_on_refuses_rather_than_half_replacing_a_trigger() {
    let (_dir, db) = db();
    wire_json(
        &db,
        &["wire", "lay", "w", "--on", "fact:shell", "--brief", "b"],
    );
    let out = wire(&db, &["edit", "w", "--where", "route=claude"]);
    assert_eq!(code(&out), 1);
    assert!(stderr(&out).contains("--on"), "{}", stderr(&out));
    assert_eq!(
        wire_json(&db, &["wire", "list"])["data"][0]["trigger"],
        r#"{"fact":{"kind":"shell"}}"#
    );
}

#[test]
fn a_brief_reads_from_the_file_an_at_names() {
    let (dir, db) = db();
    let brief = dir.path().join("brief.md");
    std::fs::write(&brief, "the long form\n").unwrap();
    let laid = wire_json(
        &db,
        &[
            "wire",
            "lay",
            "w",
            "--on",
            "commit",
            "--brief",
            &format!("@{}", brief.display()),
        ],
    );
    assert_eq!(laid["data"]["brief"], "the long form\n");
}

/// The verb writes a queued row and says so. There is no engine yet to serve
/// a live kick, and reporting one from a process that will do nothing with it
/// is the one answer worse than "queued".
#[test]
fn trip_queues_a_manual_row_without_a_live_instance_and_says_so() {
    let (_dir, db) = db();
    wire_json(&db, &["wire", "lay", "w", "--on", "commit", "--brief", "b"]);

    let tripped = wire_json(&db, &["wire", "trip", "w"]);
    assert_envelope(&tripped, "wire trip");
    assert_eq!(tripped["data"]["status"], "queued");
    let key = tripped["data"]["event_key"].as_str().unwrap();
    assert!(key.starts_with("manual:"), "{key}");

    let log = wire_json(&db, &["wire", "log", "w"]);
    assert_envelope(&log, "wire log");
    assert_eq!(log["data"].as_array().unwrap().len(), 1);
    assert_eq!(log["data"][0]["status"], "queued");
    assert_eq!(log["data"][0]["event_key"], key);

    let plain = wire(&db, &["trip", "w"]);
    assert_eq!(code(&plain), 0);
    assert!(
        String::from_utf8_lossy(&plain.stdout).contains("queued"),
        "{}",
        String::from_utf8_lossy(&plain.stdout)
    );
}

/// One slot per wire: firing by hand twice supersedes the older queued row
/// rather than stacking two.
#[test]
fn a_second_hand_fired_trip_supersedes_the_first() {
    let (_dir, db) = db();
    wire_json(&db, &["wire", "lay", "w", "--on", "commit", "--brief", "b"]);
    wire_json(&db, &["wire", "trip", "w"]);
    wire_json(&db, &["wire", "trip", "w"]);

    let log = wire_json(&db, &["wire", "log", "w"]);
    let statuses: Vec<&str> = log["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["status"].as_str().unwrap())
        .collect();
    assert_eq!(
        statuses,
        vec!["queued", "superseded"],
        "newest first, and the coalescing is visible: {log}"
    );
}

#[test]
fn a_log_for_a_wire_that_is_not_there_refuses() {
    let (_dir, db) = db();
    let out = wire(&db, &["log", "ghost"]);
    assert_eq!(code(&out), 1);
    assert!(
        stderr(&out).contains("no wire named ghost"),
        "{}",
        stderr(&out)
    );
}

#[test]
fn a_wire_that_never_fired_has_an_empty_log_rather_than_a_refusal() {
    let (_dir, db) = db();
    wire_json(&db, &["wire", "lay", "w", "--on", "commit", "--brief", "b"]);
    let log = wire_json(&db, &["wire", "log", "w"]);
    assert!(log["data"].as_array().unwrap().is_empty());
    let plain = wire(&db, &["log", "w"]);
    assert!(
        String::from_utf8_lossy(&plain.stdout).contains("never fired"),
        "{}",
        String::from_utf8_lossy(&plain.stdout)
    );
}
