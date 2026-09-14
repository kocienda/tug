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

/// A `running` trip, written the way the engine writes one ([P03]) — there is
/// no CLI verb that mints a row any more, so a test that needs one goes
/// through the ledger's own verb.
fn fire(conn: &rusqlite::Connection, tripwire_id: i64, repo_root: Option<&str>) -> i64 {
    use tugtool_core::tripwire_ledger as ledger;
    ledger::insert_trip(
        conn,
        &ledger::NewTrip {
            tripwire_id,
            event_key: "fact:inst:1".to_string(),
            at_ms: 10,
            instance: "inst".to_string(),
            status: ledger::TripStatus::Running,
            reason: None,
            event_payload: None,
            repo_root: repo_root.map(str::to_owned),
        },
    )
    .unwrap()
    .expect("this tripwire has no row for that key yet")
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
            "--description",
            "Says what broke on the last landing",
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
        laid["data"]["paused"], false,
        "a tripwire is armed the moment it is laid"
    );

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
            "--description",
            "Says what broke on the last landing",
            "--brief",
            "diagnose the failure and propose a fix",
        ],
    );
    assert_eq!(
        laid["data"]["trigger"],
        r#"{"fact":{"kind":"shell","where":{"command":{"contains":"file edit"},"route":"claude"}}}"#
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
            "--description",
            "Says what broke on the last landing",
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
            "--description",
            "Says what broke on the last landing",
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
            "fact:shell",
            "--where",
            "nonsense",
            "--description",
            "Says what broke on the last landing",
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
            "--description",
            "Says what broke on the last landing",
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
            "--description",
            "Says what broke on the last landing",
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
        &[
            "lay",
            "w",
            "--on",
            "fact:edit_failed",
            "--description",
            "Says what broke on the last landing",
            "--brief",
            "b",
        ],
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
            "--description",
            "Says what broke on the last landing",
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
            "--description",
            "Says what broke on the last landing",
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
            "--description",
            "Says what broke on the last landing",
            "--brief",
            "diagnose the failure and propose a fix",
        ],
    );
    let edited = tripwire_json(&db, &["tripwire", "edit", "w", "--probe", "just test"]);
    assert_envelope(&edited, "tripwire edit");
    assert_eq!(edited["data"]["probe"], "just test");
    assert_eq!(
        edited["data"]["brief"], "diagnose the failure and propose a fix",
        "untouched"
    );

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
            "--description",
            "Says what broke on the last landing",
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
            "--description",
            "Says what broke on the last landing",
            "--brief",
            &format!("@{}", brief.display()),
        ],
    );
    assert_eq!(laid["data"]["brief"], "the long form\n");
}

/// The verb writes no row and refuses ([P08]). With no queue there is nothing
/// a later engine could pick up, so a row written here would be one nobody
/// would ever see fire — the refusal is the honest answer.
#[test]
fn trip_refuses_without_a_live_instance_and_says_so() {
    let (_dir, db) = db();
    tripwire_json(
        &db,
        &[
            "tripwire",
            "lay",
            "w",
            "--on",
            "fact:edit_failed",
            "--description",
            "Says what broke on the last landing",
            "--brief",
            "diagnose the failure and propose a fix",
        ],
    );

    let out = tripwire(&db, &["trip", "w"]);
    assert_eq!(code(&out), 1);
    assert!(
        stderr(&out).contains("no Tug instance is running"),
        "{}",
        stderr(&out)
    );

    let log = tripwire_json(&db, &["tripwire", "log", "w"]);
    assert_envelope(&log, "tripwire log");
    assert!(
        log["data"].as_array().unwrap().is_empty(),
        "a refused firing writes nothing: {log}"
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
            "--description",
            "Says what broke on the last landing",
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

/// A dismissal discards the arc the awaiting trip was holding, and it finds
/// that arc in the **landing's** repository rather than in the wire's scope
/// ([P07], [P09]).
///
/// The wire here is unscoped, which is the ordinary shape for a watch on the
/// machine and the case a scope-addressed discard cannot serve at all: the
/// engine cuts the arc where the commit landed, and a dismissal that looked
/// somewhere else would settle the row and leave the worktree standing —
/// exactly the leak the no-hand-back rebuild exists to close.
#[test]
fn a_dismissal_discards_the_arc_in_the_repository_the_landing_named() {
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

    let arc = "tripwire-w-abcd1234";
    // No ambient session, and no ambient instance registry. A `arc create`
    // claims the arc for its calling session, and this fixture runs from
    // inside a Session card as often as not — an unscrubbed run reaches the
    // developer's own live instance and posts a bind naming a scratch arc in
    // a temp repo. That is the hazard `arc_api::bind`'s same-project guard
    // was added for, met here from the other side.
    let created = tugtool()
        .args(["arc", "create", arc, "--json"])
        .current_dir(&root)
        .env("TUG_DATA_DIR", data.path())
        .env("TMPDIR", data.path())
        .env_remove("TUG_SESSION_ID")
        .env_remove("TUG_INSTANCE_ID")
        .output()
        .unwrap();
    assert!(created.status.success(), "{}", stderr(&created));
    let worktree = root.join(".tug/worktrees").join(arc);
    assert!(worktree.exists(), "the arc's worktree is standing");

    // An unscoped wire: nothing on the row says which checkout the arc is in.
    let out = tugtool()
        .args([
            "tripwire",
            "lay",
            "w",
            "--on",
            "fact:edit_failed",
            "--description",
            "Says what broke on the last landing",
            "--brief",
            "diagnose the failure and propose a fix",
        ])
        .env("TUG_TRIPWIRES_DB", &db)
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", stderr(&out));

    // The trip the engine would have written: fired on a fact, holding the
    // arc, awaiting the user.
    {
        let conn = ledger::open_ledger(&db).unwrap();
        let wire = ledger::get(&conn, "w").unwrap().unwrap();
        let trip_id = fire(&conn, wire.id, Some(&root.display().to_string()));
        ledger::record_run(&conn, trip_id, Some("sess-a"), Some(arc)).unwrap();
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
    assert_eq!(value["data"]["arc"], arc);
    assert_eq!(
        value["data"]["discarded"], true,
        "the arc was found and removed: {value}"
    );
    assert!(
        value["data"]["discard_error"].is_null(),
        "and nothing had to be reported: {value}"
    );
    assert!(!worktree.exists(), "the worktree is gone");
}

/// Lay a tripwire and leave it holding one `adopted` trip — the row the engine
/// writes when a card takes the session over. Answers the trip's id.
fn adopted_trip(db: &Path, name: &str) -> i64 {
    use tugtool_core::tripwire_ledger as ledger;

    let out = tripwire(
        db,
        &[
            "lay",
            name,
            "--on",
            "fact:edit_failed",
            "--description",
            "Says what broke on the last landing",
            "--brief",
            "diagnose the failure and propose a fix",
        ],
    );
    assert!(out.status.success(), "{}", stderr(&out));

    let conn = ledger::open_ledger(db).unwrap();
    let wire = ledger::get(&conn, name).unwrap().unwrap();
    let trip_id = fire(&conn, wire.id, None);
    ledger::record_run(&conn, trip_id, Some("sess-a"), None).unwrap();
    ledger::adopt_if_running(&conn, trip_id, "a card took the session over", 20).unwrap();
    trip_id
}

/// A session a user took over can still run the resolution verb: `resolve`
/// finds no running trip, falls through to the adopted one, and settles it.
#[test]
fn resolve_settles_an_adopted_trip() {
    use tugtool_core::tripwire_ledger as ledger;

    let (_dir, db) = db();
    let trip_id = adopted_trip(&db, "w");

    let out = tripwire(&db, &["resolve", "w", "--quiet"]);
    assert!(out.status.success(), "{}", stderr(&out));

    let conn = ledger::open_ledger(&db).unwrap();
    let settled = ledger::trip(&conn, trip_id).unwrap().unwrap();
    assert_eq!(settled.status, "quiet");
    assert!(settled.settled_at_ms.is_some());
}

/// And dismissing one is the user's door out of a hold they no longer want.
#[test]
fn dismiss_settles_an_adopted_trip() {
    use tugtool_core::tripwire_ledger as ledger;

    let (_dir, db) = db();
    let trip_id = adopted_trip(&db, "w");

    let out = tripwire(&db, &["dismiss", "w"]);
    assert!(out.status.success(), "{}", stderr(&out));

    let conn = ledger::open_ledger(&db).unwrap();
    let settled = ledger::trip(&conn, trip_id).unwrap().unwrap();
    assert_eq!(settled.status, "quiet");
    assert_eq!(settled.headline.as_deref(), Some("dismissed"));
}

/// With nothing live and nothing adopted, each verb refuses naming both of the
/// states it looked for — a reader told only "refused" cannot tell which.
#[test]
fn each_verb_names_both_states_it_looked_for() {
    let (_dir, db) = db();
    let laid = tripwire(
        &db,
        &[
            "lay",
            "w",
            "--on",
            "fact:edit_failed",
            "--description",
            "Says what broke on the last landing",
            "--brief",
            "diagnose the failure and propose a fix",
        ],
    );
    assert!(laid.status.success(), "{}", stderr(&laid));

    // Never fired: there is no state to name, so neither verb invents one.
    let resolved = tripwire(&db, &["resolve", "w", "--quiet"]);
    assert_eq!(code(&resolved), 1);
    assert!(
        stderr(&resolved).contains("has never fired"),
        "{}",
        stderr(&resolved)
    );

    // Fired and settled: the refusal names both states it looked for and the
    // one it found instead.
    {
        use tugtool_core::tripwire_ledger as ledger;
        let conn = ledger::open_ledger(&db).unwrap();
        let wire = ledger::get(&conn, "w").unwrap().unwrap();
        let trip_id = fire(&conn, wire.id, None);
        ledger::record_run(&conn, trip_id, Some("sess-a"), None).unwrap();
        ledger::settle(
            &conn,
            trip_id,
            ledger::TripStatus::Quiet,
            &ledger::Settlement::default(),
            20,
        )
        .unwrap();
    }

    let resolved = tripwire(&db, &["resolve", "w", "--quiet"]);
    assert_eq!(code(&resolved), 1);
    assert!(
        stderr(&resolved).contains("no running or adopted trip to resolve"),
        "{}",
        stderr(&resolved)
    );

    let dismissed = tripwire(&db, &["dismiss", "w"]);
    assert_eq!(code(&dismissed), 1);
    assert!(
        stderr(&dismissed).contains("no awaiting or adopted trip to dismiss"),
        "{}",
        stderr(&dismissed)
    );
}

/// **The description is stored, echoed, and carried to every reader.**
///
/// `lay --description` is required alongside `--brief` because the card leads
/// with it ([B02]), and the three readers of a tripwire — the lay's own
/// receipt, a preview that writes nothing, and `list --json`, which is the
/// projection the card and the feed read — have to agree about what it says.
#[test]
fn a_description_is_stored_and_reported_by_every_reader() {
    let (_dir, db) = db();
    let laid = tripwire_json(
        &db,
        &[
            "tripwire",
            "lay",
            "ci",
            "--on",
            "fact:edit_failed",
            "--description",
            "Runs `just lint` after every landing on main and says what went red",
            "--brief",
            "Did the landing break the suite? Say which check went red.",
        ],
    );
    assert_envelope(&laid, "tripwire lay");
    assert_eq!(
        laid["data"]["description"],
        "Runs `just lint` after every landing on main and says what went red"
    );

    let listed = tripwire_json(&db, &["tripwire", "list"]);
    assert_eq!(
        listed["data"][0]["description"],
        "Runs `just lint` after every landing on main and says what went red",
        "the roster the card reads carries it too: {listed}"
    );
    assert_eq!(
        listed["data"][0]["brief"], "Did the landing break the suite? Say which check went red.",
        "and the brief stays in the projection, for the skill's revision read"
    );

    let previewed = tripwire_json(
        &db,
        &[
            "tripwire",
            "lay",
            "other",
            "--on",
            "fact:edit_failed",
            "--description",
            "Says what broke on the last landing",
            "--brief",
            "diagnose the failure and propose a fix",
            "--preview",
        ],
    );
    assert_eq!(
        previewed["data"]["description"], "Says what broke on the last landing",
        "a preview echoes what would be stored, field for field"
    );
}

/// **A lay with no description, or a placeholder one, is refused.**
///
/// The two refusals arrive from different places and both matter: the flag is
/// required, so clap stops a lay that names none at all, and the ledger's
/// guard stops the `--description d` that clears the flag but says nothing.
#[test]
fn a_lay_with_no_description_or_a_placeholder_one_is_refused() {
    let (_dir, db) = db();

    let missing = tripwire(
        &db,
        &[
            "lay",
            "w",
            "--on",
            "fact:edit_failed",
            "--brief",
            "diagnose the failure and propose a fix",
        ],
    );
    assert_ne!(code(&missing), 0);
    assert!(
        stderr(&missing).contains("--description"),
        "{}",
        stderr(&missing)
    );

    let placeholder = tripwire(
        &db,
        &[
            "lay",
            "w",
            "--on",
            "fact:edit_failed",
            "--description",
            "d",
            "--brief",
            "diagnose the failure and propose a fix",
        ],
    );
    assert_eq!(code(&placeholder), 1);
    assert!(
        stderr(&placeholder).contains("says nothing a person could recognise it by"),
        "{}",
        stderr(&placeholder)
    );

    let listed = tripwire_json(&db, &["tripwire", "list"]);
    assert_eq!(
        listed["data"].as_array().unwrap().len(),
        0,
        "a refused lay writes nothing: {listed}"
    );
}

/// **`edit --description` rewrites the line, and no `--clear` takes it away.**
///
/// Settable and not clearable is the decision ([B02]): the card leads with the
/// description, so a tripwire that had lost it would be one the rail cannot
/// name.
#[test]
fn a_description_is_editable_and_never_clearable() {
    let (_dir, db) = db();
    tripwire_json(
        &db,
        &[
            "tripwire",
            "lay",
            "w",
            "--on",
            "fact:edit_failed",
            "--description",
            "Says what broke on the last landing",
            "--brief",
            "diagnose the failure and propose a fix",
        ],
    );

    let edited = tripwire_json(
        &db,
        &[
            "tripwire",
            "edit",
            "w",
            "--description",
            "Reports which check went red and whether the landing broke it",
        ],
    );
    assert_envelope(&edited, "tripwire edit");
    assert_eq!(
        edited["data"]["description"],
        "Reports which check went red and whether the landing broke it"
    );

    let previewed = tripwire_json(
        &db,
        &[
            "tripwire",
            "edit",
            "w",
            "--description",
            "Watches the suite and speaks when it breaks",
            "--preview",
        ],
    );
    assert_eq!(
        previewed["data"]["changes"]["description"], "Watches the suite and speaks when it breaks",
        "a preview names the column it would move: {previewed}"
    );

    let blanked = tripwire(&db, &["edit", "w", "--description", "   "]);
    assert_eq!(code(&blanked), 1);
    assert!(
        stderr(&blanked).contains("says nothing a person could recognise it by"),
        "{}",
        stderr(&blanked)
    );

    let cleared = tripwire(&db, &["edit", "w", "--clear", "description"]);
    assert_eq!(code(&cleared), 1);
    assert!(
        stderr(&cleared).contains("not a clearable column"),
        "{}",
        stderr(&cleared)
    );

    let listed = tripwire_json(&db, &["tripwire", "list"]);
    assert_eq!(
        listed["data"][0]["description"],
        "Reports which check went red and whether the landing broke it",
        "the two refusals moved nothing: {listed}"
    );
}

/// **`rm` is refused while a trip is running, and the tripwire stays.**
///
/// The verb goes through `tugarc_core::tripwire_remove` rather than the
/// ledger's delete, so the rule the card enforces and the rule the terminal
/// enforces are one rule ([B07]). A running trip is a headless session working
/// in an inspection tree; removing the row out from under it would orphan the
/// arc it holds.
#[test]
fn rm_is_refused_while_a_trip_is_running() {
    use tugtool_core::tripwire_ledger as ledger;

    let (_dir, db) = db();
    tripwire_json(
        &db,
        &[
            "tripwire",
            "lay",
            "w",
            "--on",
            "fact:edit_failed",
            "--description",
            "Says what broke on the last landing",
            "--brief",
            "diagnose the failure and propose a fix",
        ],
    );

    let trip_id = {
        let conn = ledger::open_ledger(&db).unwrap();
        let wire = ledger::get(&conn, "w").unwrap().unwrap();
        let trip_id = fire(&conn, wire.id, None);
        ledger::record_run(&conn, trip_id, Some("sess-a"), Some("tripwire-w-abcd1234")).unwrap();
        trip_id
    };

    let refused = tripwire(&db, &["rm", "w"]);
    assert_eq!(code(&refused), 1);
    assert!(
        stderr(&refused).contains("has a trip running"),
        "{}",
        stderr(&refused)
    );

    let conn = ledger::open_ledger(&db).unwrap();
    assert!(
        ledger::get(&conn, "w").unwrap().is_some(),
        "a refused removal leaves the tripwire standing"
    );
    assert_eq!(
        ledger::trip(&conn, trip_id).unwrap().unwrap().status,
        "running",
        "and leaves the trip it was protecting alone"
    );
    drop(conn);

    // Settled, the same verb removes it.
    {
        let conn = ledger::open_ledger(&db).unwrap();
        ledger::settle(
            &conn,
            trip_id,
            ledger::TripStatus::Quiet,
            &ledger::Settlement::default(),
            20,
        )
        .unwrap();
    }
    let removed = tripwire_json(&db, &["tripwire", "rm", "w"]);
    assert_envelope(&removed, "tripwire rm");
    assert_eq!(removed["data"]["removed"], true);
    let conn = ledger::open_ledger(&db).unwrap();
    assert!(ledger::get(&conn, "w").unwrap().is_none());
}
