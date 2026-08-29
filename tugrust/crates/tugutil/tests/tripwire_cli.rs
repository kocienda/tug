//! `tugutil tripwire …` — the verb surface over the tripwires ledger.
//!
//! End to end through `TUG_TRIPWIRES_DB`, which is how the CLI suite keeps
//! clear of the machine's real tripwires. What is proven here is the tripwire between
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

fn tripwire(db: &Path, args: &[&str]) -> Output {
    Command::cargo_bin("tugutil")
        .unwrap()
        .arg("tripwire")
        .args(args)
        .env("TUG_TRIPWIRES_DB", db)
        .output()
        .unwrap()
}

fn tripwire_json(db: &Path, args: &[&str]) -> serde_json::Value {
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
fn a_tripwire_lays_and_reads_back_as_the_spec_s01_json_it_compiled_to() {
    let (_dir, db) = db();
    let laid = tripwire_json(
        &db,
        &[
            "tripwire",
            "lay",
            "tugedit",
            "--on",
            "fact:edit_failed",
            "--brief",
            "diagnose the failure",
        ],
    );
    assert_envelope(&laid, "tripwire lay");
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

    let listed = tripwire_json(&db, &["tripwire", "list"]);
    assert_envelope(&listed, "tripwire list");
    assert_eq!(listed["data"].as_array().unwrap().len(), 1);
    assert_eq!(listed["data"][0]["name"], "tugedit");
}

#[test]
fn the_where_spellings_compile_into_the_stored_trigger() {
    let (_dir, db) = db();
    let laid = tripwire_json(
        &db,
        &[
            "tripwire",
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

/// A probe may write, so a tripwire that has one needs the dash worktree — and
/// the resolution is reported rather than left for a reader to infer.
#[test]
fn a_probe_resolves_the_auto_tier_to_work() {
    let (_dir, db) = db();
    let laid = tripwire_json(
        &db,
        &[
            "tripwire",
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
fn a_preview_reports_the_tripwire_and_writes_nothing() {
    let (_dir, db) = db();
    let previewed = tripwire_json(
        &db,
        &[
            "tripwire",
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
    assert_envelope(&previewed, "tripwire lay --preview");
    assert_eq!(previewed["data"]["name"], "ghost");
    assert_eq!(previewed["data"]["resolved_tier"], "work");

    let listed = tripwire_json(&db, &["tripwire", "list"]);
    assert!(
        listed["data"].as_array().unwrap().is_empty(),
        "a preview lays nothing: {listed}"
    );
}

#[test]
fn an_invalid_preview_refuses_without_touching_the_ledger() {
    let (_dir, db) = db();
    let out = tripwire(
        &db,
        &["lay", "w", "--on", "factt:x", "--brief", "b", "--preview"],
    );
    assert_eq!(code(&out), 1);
    assert!(stderr(&out).contains("factt"), "{}", stderr(&out));
    assert!(
        tripwire_json(&db, &["tripwire", "list"])["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_bad_where_spelling_names_the_clause_it_choked_on() {
    let (_dir, db) = db();
    let out = tripwire(
        &db,
        &[
            "lay", "w", "--on", "fact:x", "--where", "nonsense", "--brief", "b",
        ],
    );
    assert_eq!(code(&out), 1);
    assert!(stderr(&out).contains("nonsense"), "{}", stderr(&out));
}

#[test]
fn a_second_tripwire_under_one_name_refuses_and_leaves_the_first() {
    let (_dir, db) = db();
    tripwire_json(
        &db,
        &["tripwire", "lay", "w", "--on", "commit", "--brief", "first"],
    );
    let out = tripwire(&db, &["lay", "w", "--on", "commit", "--brief", "second"]);
    assert_eq!(code(&out), 1);
    assert!(stderr(&out).contains("already exists"), "{}", stderr(&out));
    assert_eq!(
        tripwire_json(&db, &["tripwire", "list"])["data"][0]["brief"],
        "first"
    );
}

#[test]
fn the_lay_pause_resume_rm_lifecycle_walks() {
    let (_dir, db) = db();
    tripwire_json(
        &db,
        &["tripwire", "lay", "w", "--on", "commit", "--brief", "b"],
    );

    let paused = tripwire_json(&db, &["tripwire", "pause", "w"]);
    assert_envelope(&paused, "tripwire pause");
    assert_eq!(paused["data"]["paused"], true);

    let resumed = tripwire_json(&db, &["tripwire", "resume", "w"]);
    assert_envelope(&resumed, "tripwire resume");
    assert_eq!(resumed["data"]["paused"], false);

    let removed = tripwire_json(&db, &["tripwire", "rm", "w"]);
    assert_envelope(&removed, "tripwire rm");
    assert!(
        tripwire_json(&db, &["tripwire", "list"])["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    let gone = tripwire(&db, &["rm", "w"]);
    assert_eq!(code(&gone), 1);
    assert!(
        stderr(&gone).contains("no tripwire named w"),
        "{}",
        stderr(&gone)
    );
}

#[test]
fn an_edit_moves_only_what_it_names_and_clear_empties_a_column() {
    let (_dir, db) = db();
    tripwire_json(
        &db,
        &[
            "tripwire", "lay", "w", "--on", "commit", "--probe", "just ci", "--scope", "/repo",
            "--brief", "b",
        ],
    );
    let edited = tripwire_json(&db, &["tripwire", "edit", "w", "--cooldown", "5"]);
    assert_envelope(&edited, "tripwire edit");
    assert_eq!(edited["data"]["cooldown_secs"], 5);
    assert_eq!(edited["data"]["brief"], "b", "untouched");
    assert_eq!(edited["data"]["probe"], "just ci", "untouched");

    let cleared = tripwire_json(&db, &["tripwire", "edit", "w", "--clear", "probe"]);
    assert!(cleared["data"]["probe"].is_null());
    assert_eq!(
        cleared["data"]["resolved_tier"], "verdict",
        "clearing the probe moves auto back to the fast path"
    );

    let bad = tripwire(&db, &["edit", "w", "--clear", "brief"]);
    assert_eq!(code(&bad), 1);
    assert!(stderr(&bad).contains("brief"), "{}", stderr(&bad));
}

/// A half-replaced predicate is the one shape nobody could reason about
/// later, so a trigger is edited whole.
#[test]
fn where_without_on_refuses_rather_than_half_replacing_a_trigger() {
    let (_dir, db) = db();
    tripwire_json(
        &db,
        &["tripwire", "lay", "w", "--on", "fact:shell", "--brief", "b"],
    );
    let out = tripwire(&db, &["edit", "w", "--where", "route=claude"]);
    assert_eq!(code(&out), 1);
    assert!(stderr(&out).contains("--on"), "{}", stderr(&out));
    assert_eq!(
        tripwire_json(&db, &["tripwire", "list"])["data"][0]["trigger"],
        r#"{"fact":{"kind":"shell"}}"#
    );
}

#[test]
fn a_brief_reads_from_the_file_an_at_names() {
    let (dir, db) = db();
    let brief = dir.path().join("brief.md");
    std::fs::write(&brief, "the long form\n").unwrap();
    let laid = tripwire_json(
        &db,
        &[
            "tripwire",
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
    tripwire_json(
        &db,
        &["tripwire", "lay", "w", "--on", "commit", "--brief", "b"],
    );

    let tripped = tripwire_json(&db, &["tripwire", "trip", "w"]);
    assert_envelope(&tripped, "tripwire trip");
    assert_eq!(tripped["data"]["status"], "queued");
    let key = tripped["data"]["event_key"].as_str().unwrap();
    assert!(key.starts_with("manual:"), "{key}");

    let log = tripwire_json(&db, &["tripwire", "log", "w"]);
    assert_envelope(&log, "tripwire log");
    assert_eq!(log["data"].as_array().unwrap().len(), 1);
    assert_eq!(log["data"][0]["status"], "queued");
    assert_eq!(log["data"][0]["event_key"], key);

    let plain = tripwire(&db, &["trip", "w"]);
    assert_eq!(code(&plain), 0);
    assert!(
        String::from_utf8_lossy(&plain.stdout).contains("queued"),
        "{}",
        String::from_utf8_lossy(&plain.stdout)
    );
}

/// One slot per tripwire: firing by hand twice supersedes the older queued row
/// rather than stacking two.
#[test]
fn a_second_hand_fired_trip_supersedes_the_first() {
    let (_dir, db) = db();
    tripwire_json(
        &db,
        &["tripwire", "lay", "w", "--on", "commit", "--brief", "b"],
    );
    tripwire_json(&db, &["tripwire", "trip", "w"]);
    tripwire_json(&db, &["tripwire", "trip", "w"]);

    let log = tripwire_json(&db, &["tripwire", "log", "w"]);
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
fn a_log_for_a_tripwire_that_is_not_there_refuses() {
    let (_dir, db) = db();
    let out = tripwire(&db, &["log", "ghost"]);
    assert_eq!(code(&out), 1);
    assert!(
        stderr(&out).contains("no tripwire named ghost"),
        "{}",
        stderr(&out)
    );
}

#[test]
fn a_tripwire_that_never_fired_has_an_empty_log_rather_than_a_refusal() {
    let (_dir, db) = db();
    tripwire_json(
        &db,
        &["tripwire", "lay", "w", "--on", "commit", "--brief", "b"],
    );
    let log = tripwire_json(&db, &["tripwire", "log", "w"]);
    assert!(log["data"].as_array().unwrap().is_empty());
    let plain = tripwire(&db, &["log", "w"]);
    assert!(
        String::from_utf8_lossy(&plain.stdout).contains("never fired"),
        "{}",
        String::from_utf8_lossy(&plain.stdout)
    );
}
