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
        .current_dir(repo_of(db))
        .output()
        .unwrap()
}

fn tripwire_json(db: &Path, args: &[&str]) -> serde_json::Value {
    let mut with_json = vec!["--json"];
    with_json.extend_from_slice(args);
    let out = tugtool()
        .args(with_json)
        .env("TUG_TRIPWIRES_DB", db)
        .current_dir(repo_of(db))
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
    // `lay` creates the tripwire's arc ([P02]), so it needs a checkout to
    // create it in. Every verb runs with its cwd here rather than in the
    // suite's own working directory, which would put scratch arcs in the
    // developer's repository.
    init_scratch_repo(&repo_of(&path));
    (dir, path)
}

/// The checkout beside a test's ledger — one git repository per `db()`.
fn repo_of(db: &Path) -> std::path::PathBuf {
    db.parent()
        .expect("the ledger sits in a temp dir")
        .join("repo")
}

/// A git repository with one commit, and the state directory redirected beside
/// it so nothing an arc writes reaches the developer's own.
fn init_scratch_repo(repo: &Path) {
    if repo.join(".git").exists() {
        return;
    }
    std::fs::create_dir_all(repo).unwrap();
    std::fs::write(repo.join("README.md"), "scratch\n").unwrap();
    for args in [
        vec!["init", "-b", "main"],
        vec!["config", "user.name", "Test User"],
        vec!["config", "user.email", "test@example.com"],
        vec!["add", "-A"],
        vec!["commit", "-m", "first"],
    ] {
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(&args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}");
    }
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

/// The cost of laying a tripwire is knowable before it is laid, which means
/// the caps have to be readable wherever a tripwire is: at the lay, at the
/// edit, and on the roster row every surface shares.
#[test]
fn the_caps_round_trip_through_lay_edit_and_list() {
    let (_dir, db) = db();
    let defaulted = tripwire_json(
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
    assert_eq!(
        (
            defaulted["data"]["max_seconds"].as_i64(),
            defaulted["data"]["max_tool_calls"].as_i64()
        ),
        (Some(120), Some(30)),
        "a tripwire laid without naming a cap is still capped"
    );

    let edited = tripwire_json(&db, &["tripwire", "edit", "w", "--max-seconds", "300"]);
    assert_eq!(edited["data"]["max_seconds"], 300);
    assert_eq!(
        edited["data"]["max_tool_calls"], 30,
        "an edit moves only what it names"
    );

    let listed = tripwire_json(&db, &["tripwire", "list"]);
    assert_eq!(
        (
            listed["data"][0]["max_seconds"].as_i64(),
            listed["data"][0]["max_tool_calls"].as_i64()
        ),
        (Some(300), Some(30)),
        "the roster the card and the CLI share carries both: {listed}"
    );

    let laid_with_caps = tripwire_json(
        &db,
        &[
            "tripwire",
            "lay",
            "x",
            "--on",
            "fact:edit_failed",
            "--description",
            "Says what broke on the last landing",
            "--brief",
            "diagnose the failure and propose a fix",
            "--max-seconds",
            "60",
            "--max-tool-calls",
            "8",
        ],
    );
    assert_eq!(laid_with_caps["data"]["max_seconds"], 60);
    assert_eq!(laid_with_caps["data"]["max_tool_calls"], 8);
}

/// A cap is a ceiling a trip runs up against, so zero is not a spelling for
/// "no ceiling" — it is a tripwire whose every trip would fail on the instant.
#[test]
fn a_cap_of_zero_or_below_is_refused() {
    let (_dir, db) = db();
    // `--flag=value`, so a negative number is the flag's value rather than
    // something clap reads as another flag and refuses before `check_cap`
    // ever sees it.
    for (flag, arg) in [
        ("--max-seconds", "--max-seconds=0"),
        ("--max-tool-calls", "--max-tool-calls=-1"),
    ] {
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
                "diagnose the failure and propose a fix",
                arg,
            ],
        );
        assert_eq!(code(&out), 1, "{arg} was accepted");
        assert!(stderr(&out).contains(flag), "{}", stderr(&out));
    }

    let listed = tripwire_json(&db, &["tripwire", "list"]);
    assert!(
        listed["data"].as_array().unwrap().is_empty(),
        "a refused cap laid a tripwire anyway: {listed}"
    );
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

/// **The log prints the report on a `done` row, and the rounds when there are
/// any** ([P04]).
///
/// The report is what a trip amounted to, so the text rendering is where a
/// reader meets it — `--json` carrying it and the terminal not would make the
/// verb's plain output the one surface that cannot answer the question the
/// trip log exists for.
#[test]
fn the_log_prints_the_report_on_a_done_row() {
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
        ledger::record_run(&conn, trip_id, Some("sess-a"), Some("tripwire-w")).unwrap();
        ledger::record_report(&conn, trip_id, "The assertion was never updated.", 2).unwrap();
        ledger::settle(
            &conn,
            trip_id,
            ledger::TripStatus::Done,
            &ledger::Settlement::default(),
            20,
        )
        .unwrap();
        trip_id
    };

    let plain = String::from_utf8_lossy(&tripwire(&db, &["log", "w"]).stdout).into_owned();
    assert!(
        plain.contains("done") && plain.contains("The assertion was never updated."),
        "the row carries its status and its report: {plain}"
    );
    assert!(
        plain.contains("(2 rounds)"),
        "and says what it committed: {plain}"
    );

    let log = tripwire_json(&db, &["tripwire", "log", "w"]);
    let row = &log["data"][0];
    assert_eq!(row["id"], trip_id);
    assert_eq!(row["report"], "The assertion was never updated.");
    assert_eq!(row["rounds"], 2);
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
            ledger::TripStatus::Done,
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

/// **Laying a tripwire creates its arc and stamps who laid it** ([P02]).
///
/// The arc is cut at `lay` rather than at the first trip, so the hydration a
/// project declares is paid once at a gesture the user is watching — and so a
/// trip has somewhere to stand from the moment the tripwire exists.
#[test]
fn laying_a_tripwire_creates_its_arc_and_stamps_who_laid_it() {
    let (_dir, db) = db();
    let repo = repo_of(&db);
    let laid = tripwire_json(
        &db,
        &[
            "tripwire",
            "lay",
            "probe-me",
            "--on",
            "fact:shell",
            "--description",
            "Says what broke on the last landing",
            "--brief",
            "diagnose the failure and propose a fix",
        ],
    );
    assert_eq!(
        laid["data"]["repo_root"],
        std::fs::canonicalize(&repo).unwrap().display().to_string(),
        "the row records the checkout its arc lives in"
    );
    assert!(
        tugarc_core::ops::arc_exists_in(&repo, "tripwire-probe-me"),
        "the arc is cut at lay"
    );
    assert_eq!(
        tugarc_core::ops::laid_by(&repo, "tripwire-probe-me").as_deref(),
        Some("tripwire/probe-me"),
        "and stamped with who laid it, which is what tells it from a person's arc"
    );

    // And the removal takes it back off the machine.
    let removed = tripwire_json(&db, &["tripwire", "rm", "probe-me"]);
    assert_eq!(removed["data"]["arc"], "tripwire-probe-me");
    assert_eq!(removed["data"]["discarded"], true);
    assert!(
        !tugarc_core::ops::arc_exists_in(&repo, "tripwire-probe-me"),
        "removing the tripwire removes the worktree it owned"
    );
}

/// **A tripwire laid nowhere in particular refuses, and names what it tried.**
///
/// An arc needs a repository. A refusal that only said "no checkout" would
/// leave the user guessing which of the two answers — the scope or the shell's
/// directory — was the one that failed.
#[test]
fn laying_outside_a_repository_refuses_and_names_what_it_tried() {
    let (_dir, db) = db();
    let nowhere = db.parent().unwrap().join("nowhere");
    std::fs::create_dir_all(&nowhere).unwrap();

    let out = tugtool()
        .args([
            "tripwire",
            "lay",
            "homeless",
            "--on",
            "fact:shell",
            "--description",
            "Says what broke on the last landing",
            "--brief",
            "diagnose the failure and propose a fix",
        ])
        .env("TUG_TRIPWIRES_DB", &db)
        .current_dir(&nowhere)
        .output()
        .unwrap();
    assert_eq!(code(&out), 1);
    let said = stderr(&out);
    assert!(
        said.contains("checkout to live in") && said.contains("--scope"),
        "the refusal names both attempts: {said}"
    );

    let conn = tugtool_core::tripwire_ledger::open_ledger(&db).unwrap();
    assert!(
        tugtool_core::tripwire_ledger::get(&conn, "homeless")
            .unwrap()
            .is_none(),
        "and a lay that could not resolve a checkout wrote no row"
    );
}
