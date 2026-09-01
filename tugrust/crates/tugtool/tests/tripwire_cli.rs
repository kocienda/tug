//! `tugtool tripwire …` — the verb surface over the tripwires ledger.
//!
//! End to end through `TUG_TRIPWIRES_DB`, which is how the CLI suite keeps
//! clear of the machine's real tripwires. What is proven here is the tripwire between
//! the command line and the ledger: what a person types becomes a stored Spec
//! S01 trigger, what the ledger holds is what `--json` reports, and a verb
//! that refuses leaves the record exactly as it was.
//!
//! The predicate's own semantics are proved in `tugtool-core` against pure
//! values, and the ledger's arbitration is proved there against a real file,
//! so nothing here stands up a substitute for either.

mod common;
use common::tugtool;

use std::path::Path;
use std::process::{Command, Output};

fn tripwire(db: &Path, args: &[&str]) -> Output {
    tugtool()
        .arg("tripwire")
        .args(args)
        .env("TUG_TRIPWIRES_DB", db)
        .output()
        .unwrap()
}

fn tripwire_json(db: &Path, args: &[&str]) -> serde_json::Value {
    let mut with_json = vec!["--json"];
    with_json.extend_from_slice(args);
    let out = tugtool()
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
    assert_eq!(
        laid["data"]["branch"], "main",
        "no --branch given, so the checkout's default branch is the sugar"
    );
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
            "diagnose the failure and propose a fix",
        ],
    );
    assert_eq!(
        laid["data"]["trigger"],
        r#"{"fact":{"kind":"shell","where":{"command":{"contains":"file edit"},"route":"claude"}}}"#
    );
}

/// The branch is a column the wire carries, and `--branch` is what sets it.
#[test]
fn a_named_branch_is_stored_on_the_wire_and_reported_back() {
    let (_dir, db) = db();
    let laid = tripwire_json(
        &db,
        &[
            "tripwire",
            "lay",
            "ci",
            "--on",
            "fact:edit_failed",
            "--branch",
            "release",
            "--probe",
            "just ci",
            "--scope",
            "/repo",
            "--brief",
            "diagnose the failure and propose a fix",
        ],
    );
    assert_eq!(laid["data"]["branch"], "release");
    assert_eq!(laid["data"]["probe"], "just ci");
    assert_eq!(
        laid["data"]["trigger"],
        r#"{"fact":{"kind":"edit_failed"}}"#
    );
}

/// The branch sugar reads the scope's repository, and a scope that is not one
/// leaves nothing to read — so the lay refuses rather than writing a wire that
/// nothing could ever trip ([P02]).
#[test]
fn a_lay_with_no_resolvable_branch_refuses_and_writes_nothing() {
    let (_dir, db) = db();
    let outside = tempfile::tempdir().unwrap();
    let out = tripwire(
        &db,
        &[
            "lay",
            "w",
            "--on",
            "fact:edit_failed",
            "--scope",
            &outside.path().display().to_string(),
            "--brief",
            "diagnose the failure and propose a fix",
        ],
    );
    assert_eq!(code(&out), 1);
    assert!(stderr(&out).contains("--branch"), "{}", stderr(&out));

    let listed = tripwire_json(&db, &["tripwire", "list"]);
    assert!(
        listed["data"].as_array().unwrap().is_empty(),
        "a refused lay writes nothing: {listed}"
    );
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
            "fact:edit_failed",
            "--probe",
            "just ci",
            "--brief",
            "diagnose the failure and propose a fix",
            "--preview",
        ],
    );
    assert_envelope(&previewed, "tripwire lay --preview");
    assert_eq!(previewed["data"]["name"], "ghost");
    assert_eq!(previewed["data"]["probe"], "just ci");

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
        &[
            "lay",
            "w",
            "--on",
            "factt:x",
            "--brief",
            "diagnose the failure and propose a fix",
            "--preview",
        ],
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
            "lay",
            "w",
            "--on",
            "fact:x",
            "--where",
            "nonsense",
            "--brief",
            "diagnose the failure and propose a fix",
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
        &[
            "tripwire",
            "lay",
            "w",
            "--on",
            "fact:edit_failed",
            "--brief",
            "diagnose the failure and propose a fix",
        ],
    );
    let out = tripwire(
        &db,
        &[
            "lay",
            "w",
            "--on",
            "fact:edit_failed",
            "--brief",
            "report anything that looks wrong",
        ],
    );
    assert_eq!(code(&out), 1);
    assert!(stderr(&out).contains("already exists"), "{}", stderr(&out));
    assert_eq!(
        tripwire_json(&db, &["tripwire", "list"])["data"][0]["brief"],
        "diagnose the failure and propose a fix"
    );
}

/// A brief that gives the AI nothing to do is refused, and the refusal says
/// what is wrong rather than exiting 1 with a shrug — this is the whole point
/// of catching it here instead of in a trip log full of a model politely
/// reporting that it was told nothing.
#[test]
fn a_placeholder_brief_is_refused_at_the_lay_and_at_the_preview() {
    let (_dir, db) = db();
    let out = tripwire(
        &db,
        &["lay", "w", "--on", "fact:edit_failed", "--brief", "b"],
    );
    assert_eq!(code(&out), 1);
    assert!(
        stderr(&out).contains("says nothing for the AI to do"),
        "{}",
        stderr(&out)
    );
    assert!(
        stderr(&out).contains("say what to look at"),
        "{}",
        stderr(&out)
    );
    assert!(
        tripwire_json(&db, &["tripwire", "list"])["data"]
            .as_array()
            .unwrap()
            .is_empty(),
        "a refused lay writes no row"
    );

    // The preview refuses on the same terms. A preview that showed a tripwire
    // the lay would refuse would be a preview of something that cannot happen.
    let previewed = tripwire(
        &db,
        &[
            "lay",
            "w",
            "--on",
            "fact:edit_failed",
            "--brief",
            "b",
            "--preview",
        ],
    );
    assert_eq!(code(&previewed), 1);
    assert!(
        stderr(&previewed).contains("says nothing for the AI to do"),
        "{}",
        stderr(&previewed)
    );
}

#[test]
fn the_lay_pause_resume_rm_lifecycle_walks() {
    let (_dir, db) = db();
    tripwire_json(
        &db,
        &[
            "tripwire",
            "lay",
            "w",
            "--on",
            "fact:edit_failed",
            "--brief",
            "diagnose the failure and propose a fix",
        ],
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
            "tripwire",
            "lay",
            "w",
            "--on",
            "fact:edit_failed",
            "--probe",
            "just ci",
            "--scope",
            "/repo",
            "--branch",
            "main",
            "--brief",
            "diagnose the failure and propose a fix",
        ],
    );
    let edited = tripwire_json(&db, &["tripwire", "edit", "w", "--branch", "release"]);
    assert_envelope(&edited, "tripwire edit");
    assert_eq!(edited["data"]["branch"], "release");
    assert_eq!(
        edited["data"]["brief"], "diagnose the failure and propose a fix",
        "untouched"
    );
    assert_eq!(edited["data"]["probe"], "just ci", "untouched");

    let cleared = tripwire_json(&db, &["tripwire", "edit", "w", "--clear", "probe"]);
    assert!(cleared["data"]["probe"].is_null());

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
        &[
            "tripwire",
            "lay",
            "w",
            "--on",
            "fact:shell",
            "--brief",
            "diagnose the failure and propose a fix",
        ],
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
            "fact:edit_failed",
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
        &[
            "tripwire",
            "lay",
            "w",
            "--on",
            "fact:edit_failed",
            "--brief",
            "diagnose the failure and propose a fix",
        ],
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
        &[
            "tripwire",
            "lay",
            "w",
            "--on",
            "fact:edit_failed",
            "--brief",
            "diagnose the failure and propose a fix",
        ],
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
        &[
            "tripwire",
            "lay",
            "w",
            "--on",
            "fact:edit_failed",
            "--brief",
            "diagnose the failure and propose a fix",
        ],
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

/// A dismissal discards the dash the awaiting trip was holding, and it finds
/// that dash in the **landing's** repository rather than in the wire's scope
/// ([P07], [P09]).
///
/// The wire here is unscoped, which is the ordinary shape for a watch on the
/// machine and the case a scope-addressed discard cannot serve at all: the
/// engine cuts the dash where the commit landed, and a dismissal that looked
/// somewhere else would settle the row and leave the worktree standing —
/// exactly the leak the no-hand-back rebuild exists to close.
#[test]
fn a_dismissal_discards_the_dash_in_the_repository_the_landing_named() {
    use tugtool_core::tripwire_ledger as ledger;

    let (_dir, db) = db();
    let repo = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let root = repo.path().canonicalize().unwrap();
    for args in [
        vec!["init", "-q", "-b", "main", "."],
        vec!["config", "user.email", "t@example.com"],
        vec!["config", "user.name", "T"],
    ] {
        assert!(
            Command::new("git")
                .args(&args)
                .current_dir(&root)
                .status()
                .unwrap()
                .success()
        );
    }
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    for args in [vec!["add", "-A"], vec!["commit", "-qm", "one"]] {
        assert!(
            Command::new("git")
                .args(&args)
                .current_dir(&root)
                .status()
                .unwrap()
                .success()
        );
    }

    let dash = "tripwire-w-abcd1234";
    // No ambient session, and no ambient instance registry. A `dash create`
    // claims the dash for its calling session, and this fixture runs from
    // inside a Session card as often as not — an unscrubbed run reaches the
    // developer's own live instance and posts a bind naming a scratch dash in
    // a temp repo. That is the hazard `dash_api::bind`'s same-project guard
    // was added for, met here from the other side.
    let created = tugtool()
        .args(["dash", "create", dash, "--json"])
        .current_dir(&root)
        .env("TUG_DATA_DIR", data.path())
        .env("TMPDIR", data.path())
        .env_remove("TUG_SESSION_ID")
        .env_remove("TUG_INSTANCE_ID")
        .output()
        .unwrap();
    assert!(created.status.success(), "{}", stderr(&created));
    let worktree = root.join(".tug/worktrees").join(dash);
    assert!(worktree.exists(), "the dash's worktree is standing");

    // An unscoped wire: nothing on the row says which checkout the dash is in.
    let out = tugtool()
        .args([
            "tripwire",
            "lay",
            "w",
            "--on",
            "fact:edit_failed",
            "--branch",
            "main",
            "--brief",
            "diagnose the failure and propose a fix",
        ])
        .env("TUG_TRIPWIRES_DB", &db)
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", stderr(&out));

    // The trip the engine would have written: claimed on a landing, holding
    // the dash, awaiting the user.
    {
        let conn = ledger::open_ledger(&db).unwrap();
        let wire = ledger::get(&conn, "w").unwrap().unwrap();
        let ledger::Claim::Claimed { trip_id } =
            ledger::claim_trip(&conn, wire.id, "landing:abc", 10, "inst", None).unwrap()
        else {
            panic!("the claim is uncontested");
        };
        let payload = serde_json::json!({
            "landing": { "kind": "commit", "branch": "main", "sha": "abc",
                         "repo_root": root.display().to_string(), "sessions": [] }
        })
        .to_string();
        ledger::record_event_payload(&conn, trip_id, Some(&payload)).unwrap();
        ledger::record_run(&conn, trip_id, Some("sess-a"), Some(dash)).unwrap();
        ledger::settle(
            &conn,
            trip_id,
            ledger::TripStatus::Awaiting,
            &ledger::Settlement {
                headline: Some("the migration drops a column nothing backfills".to_string()),
                ..ledger::Settlement::default()
            },
            20,
        )
        .unwrap();
    }

    let out = tugtool()
        .args(["--json", "tripwire", "dismiss", "w"])
        .env("TUG_TRIPWIRES_DB", &db)
        .env("TUG_DATA_DIR", data.path())
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", stderr(&out));
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_envelope(&value, "tripwire dismiss");
    assert_eq!(value["data"]["dash"], dash);
    assert_eq!(
        value["data"]["discarded"], true,
        "the dash was found and removed: {value}"
    );
    assert!(
        value["data"]["discard_error"].is_null(),
        "and nothing had to be reported: {value}"
    );
    assert!(!worktree.exists(), "the worktree is gone");
}
