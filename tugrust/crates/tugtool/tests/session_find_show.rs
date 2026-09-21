//! `tugtool session find` and `tugtool session show` — the model's door to
//! a session other than the one it is running in.
//!
//! Every spawn goes through `common::tugtool()` and points `TUG_SESSIONS_DB`,
//! `TUG_SESSION_INDEX_DB` and `HOME` into the test's own temp dir, so the
//! three places the finder looks are all the test's: this instance's ledger,
//! the machine-wide index, and `~/.claude/projects`. Nothing here can read or
//! write the developer's real sessions.

mod common;

use common::tugtool;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::process::Command;

/// A session this instance's ledger holds.
const HERE_UUID: &str = "11111111-aaaa-bbbb-cccc-000000000001";
/// One only the machine-wide index knows, recorded by another instance.
const FOREIGN_UUID: &str = "22222222-aaaa-bbbb-cccc-000000000002";
/// One nothing on this machine answers to.
const NOWHERE_UUID: &str = "99999999-aaaa-bbbb-cccc-000000000099";

/// The directory name claude gives a project — every character that is not
/// ASCII alphanumeric or `-` becomes `-`.
fn encode(project_dir: &str) -> String {
    project_dir
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// A temp dir holding a `sessions.db` with one live session on a named
/// line, an empty projects root, and room for an index the tests seed
/// through the hidden `index-put`.
fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let conn = Connection::open(dir.path().join("sessions.db")).unwrap();
    conn.execute_batch(
        "CREATE TABLE sessions (
             session_id TEXT PRIMARY KEY, line_id TEXT, project_dir TEXT,
             state TEXT, created_at INTEGER, forked_from_session_id TEXT);
         CREATE TABLE lines (line_id TEXT PRIMARY KEY, tag TEXT, name TEXT);",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO lines (line_id, tag, name) VALUES ('l1', 'curly-apple', 'The parser work')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO sessions (session_id, line_id, project_dir, state, created_at)
         VALUES (?1, 'l1', '/u/src/tug', 'live', 1)",
        rusqlite::params![HERE_UUID],
    )
    .unwrap();
    std::fs::create_dir_all(dir.path().join(".claude/projects")).unwrap();
    dir
}

/// Write a transcript where claude would put one, and return its path.
fn transcript(dir: &Path, project_dir: &str, uuid: &str, body: &str) -> PathBuf {
    let project = dir.join(".claude/projects").join(encode(project_dir));
    std::fs::create_dir_all(&project).unwrap();
    let path = project.join(format!("{uuid}.jsonl"));
    std::fs::write(&path, body).unwrap();
    path
}

/// The two-turn transcript most tests read.
fn two_turns() -> String {
    [
        serde_json::json!({
            "type": "user",
            "timestamp": "2026-09-21T10:00:00.000Z",
            "message": { "role": "user", "content": "what does the parser do" },
        })
        .to_string(),
        serde_json::json!({
            "type": "assistant",
            "message": { "role": "assistant", "content": [
                { "type": "thinking", "thinking": "never printed" },
                { "type": "text", "text": "it parses" },
                { "type": "tool_use", "name": "Read", "input": { "file_path": "/u/src/tug/parse.rs" } },
            ]},
        })
        .to_string(),
        // A tool-result carrier: the transport for a tool's answer, not a
        // thing the user said, so it must not open a turn.
        serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "tool_result", "content": "fn main" }] },
        })
        .to_string(),
        serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [
                { "type": "text", "text": "and the lexer" },
                { "type": "text", "text": "<!-- tug:session-refs -->\n- @session:tug/curly-apple — verdict: here" },
            ]},
        })
        .to_string(),
        serde_json::json!({
            "type": "assistant",
            "timestamp": "2026-09-21T10:05:00.000Z",
            "message": { "role": "assistant", "content": [{ "type": "text", "text": "it lexes" }] },
        })
        .to_string(),
    ]
    .join("\n")
}

/// A `tugtool` with all three of the finder's places pointed at `dir`.
fn tug(dir: &Path) -> Command {
    let mut cmd = tugtool();
    cmd.env("TUG_SESSIONS_DB", dir.join("sessions.db"));
    cmd.env("TUG_SESSION_INDEX_DB", dir.join("session_index.db"));
    cmd.env("HOME", dir);
    cmd
}

fn run_cmd(cmd: &mut Command) -> (i32, String, String) {
    let out = cmd.output().unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

/// Seed one foreign index row, as another instance's tugcast would have.
fn index_put(dir: &Path, uuid: &str, callsign: &str, project_dir: &str) {
    let (code, _, stderr) = run_cmd(tug(dir).args([
        "session",
        "index-put",
        "--uuid",
        uuid,
        "--callsign",
        callsign,
        "--project-dir",
        project_dir,
        "--instance",
        "debug-other",
        "--title",
        "Somebody else's work",
    ]));
    assert_eq!(code, 0, "index-put failed: {stderr}");
}

// ── find ─────────────────────────────────────────────────────────────────────

#[test]
fn find_places_a_session_this_instance_holds() {
    let dir = fixture();
    let (code, stdout, stderr) = run_cmd(tug(dir.path()).args(["session", "find", HERE_UUID]));
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(stdout.trim(), format!("here {HERE_UUID} /u/src/tug"));

    // The callsign and the short id reach the same session.
    let (code, stdout, _) = run_cmd(tug(dir.path()).args(["session", "find", "curly-apple"]));
    assert_eq!(code, 0);
    assert_eq!(stdout.trim(), format!("here {HERE_UUID} /u/src/tug"));
    let (code, stdout, _) = run_cmd(tug(dir.path()).args(["session", "find", &HERE_UUID[..8]]));
    assert_eq!(code, 0);
    assert_eq!(stdout.trim(), format!("here {HERE_UUID} /u/src/tug"));
}

#[test]
fn find_places_a_foreign_session_as_elsewhere_and_names_its_instance() {
    let dir = fixture();
    index_put(dir.path(), FOREIGN_UUID, "curly-apple", "/u/src/eucit");

    // The project half is what distinguishes it: `curly-apple` also names a
    // session *here*, under `tug`.
    let (code, stdout, stderr) =
        run_cmd(tug(dir.path()).args(["session", "find", "eucit/curly-apple"]));
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(
        stdout.trim(),
        format!("elsewhere {FOREIGN_UUID} /u/src/eucit instance debug-other")
    );
    let (_, stdout, _) = run_cmd(tug(dir.path()).args(["session", "find", "tug/curly-apple"]));
    assert_eq!(
        stdout.trim(),
        format!("here {HERE_UUID} /u/src/tug"),
        "the same callsign under the project it does live in stays here"
    );
}

#[test]
fn find_says_absent_with_its_own_exit_code_and_refuses_a_non_reference() {
    let dir = fixture();
    let (code, stdout, _) = run_cmd(tug(dir.path()).args(["session", "find", NOWHERE_UUID]));
    assert_eq!(code, 3, "absent is a third answer, not a failure");
    assert_eq!(stdout.trim(), "absent");

    // A spelling that is not a reference at all is the caller's mistake,
    // and exits 1 so it cannot be read as "no such session".
    let (code, _, stderr) = run_cmd(tug(dir.path()).args(["session", "find", "not a reference"]));
    assert_eq!(code, 1);
    assert!(stderr.contains("not a session reference"), "{stderr}");
}

#[test]
fn find_json_carries_the_whole_finding() {
    let dir = fixture();
    let (code, stdout, _) = run_cmd(tug(dir.path()).args(["--json", "session", "find", HERE_UUID]));
    assert_eq!(code, 0);
    let value: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(value["data"]["verdict"], "here");
    assert_eq!(value["data"]["session_id"], HERE_UUID);
    assert_eq!(value["data"]["callsign"], "curly-apple");
    assert_eq!(value["data"]["title"], "The parser work");

    let (code, stdout, _) =
        run_cmd(tug(dir.path()).args(["--json", "session", "find", NOWHERE_UUID]));
    assert_eq!(code, 3);
    let value: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(value["data"]["verdict"], "absent");
}

// ── show ─────────────────────────────────────────────────────────────────────

#[test]
fn show_prints_a_header_and_the_turns() {
    let dir = fixture();
    transcript(dir.path(), "/u/src/tug", HERE_UUID, &two_turns());

    let (code, stdout, stderr) = run_cmd(tug(dir.path()).args(["session", "show", HERE_UUID]));
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.starts_with("# The parser work\n"), "{stdout}");
    assert!(stdout.contains("project: /u/src/tug\n"), "{stdout}");
    assert!(
        stdout.contains(&format!("session: {HERE_UUID}\n")),
        "{stdout}"
    );
    assert!(stdout.contains("verdict: here\n"), "{stdout}");
    // Two turns, not three: the tool-result carrier continued the first.
    assert!(
        stdout.contains("turns: 2   last updated: 2026-09-21T10:05:00Z\n"),
        "{stdout}"
    );
    assert!(
        stdout.contains("## Turn 1 — user\nwhat does the parser do\n"),
        "{stdout}"
    );
    assert!(
        stdout.contains("## Turn 1 — assistant\nit parses\n→ Read(/u/src/tug/parse.rs)\n"),
        "{stdout}"
    );
    assert!(
        stdout.contains("## Turn 2 — user\nand the lexer\n"),
        "{stdout}"
    );
    // The model's scratch and Tug's own machinery are both swallowed.
    assert!(!stdout.contains("never printed"), "{stdout}");
    assert!(!stdout.contains("tug:session-refs"), "{stdout}");
}

#[test]
fn show_narrows_by_last_turn_and_grep() {
    let dir = fixture();
    transcript(dir.path(), "/u/src/tug", HERE_UUID, &two_turns());

    let (code, stdout, _) =
        run_cmd(tug(dir.path()).args(["session", "show", HERE_UUID, "--last", "1"]));
    assert_eq!(code, 0);
    assert!(!stdout.contains("## Turn 1 —"), "{stdout}");
    assert!(stdout.contains("## Turn 2 — user"), "{stdout}");

    let (_, stdout, _) =
        run_cmd(tug(dir.path()).args(["session", "show", HERE_UUID, "--turn", "1"]));
    assert!(stdout.contains("## Turn 1 — user"), "{stdout}");
    assert!(!stdout.contains("## Turn 2 —"), "{stdout}");

    // Case-insensitive, and it searches the assistant's lines too.
    let (_, stdout, _) =
        run_cmd(tug(dir.path()).args(["session", "show", HERE_UUID, "--grep", "IT LEXES"]));
    assert!(stdout.contains("## Turn 2 — user"), "{stdout}");
    assert!(!stdout.contains("## Turn 1 — user"), "{stdout}");
}

#[test]
fn show_reads_a_foreign_transcript_and_writes_nothing() {
    let dir = fixture();
    index_put(dir.path(), FOREIGN_UUID, "zany-ghost", "/u/src/eucit");
    let path = transcript(dir.path(), "/u/src/eucit", FOREIGN_UUID, &two_turns());
    let before = std::fs::metadata(&path).unwrap().modified().unwrap();
    let before_len = std::fs::metadata(&path).unwrap().len();

    let (code, stdout, stderr) = run_cmd(tug(dir.path()).args(["session", "show", FOREIGN_UUID]));
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("verdict: elsewhere\n"), "{stdout}");
    assert!(stdout.contains("## Turn 1 — user"), "{stdout}");

    // Read-only in the only sense that matters: a session belonging to
    // another instance is not touched by having been read.
    let after = std::fs::metadata(&path).unwrap();
    assert_eq!(after.modified().unwrap(), before);
    assert_eq!(after.len(), before_len);
}

#[test]
fn show_says_so_when_the_transcript_is_not_on_disk() {
    let dir = fixture();
    let (code, stdout, stderr) = run_cmd(tug(dir.path()).args(["session", "show", HERE_UUID]));
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("transcript: not on disk\n"), "{stdout}");
    assert!(stdout.contains("verdict: here\n"), "{stdout}");
}

#[test]
fn show_exits_3_on_absent_and_says_so_on_stderr() {
    let dir = fixture();
    let (code, stdout, stderr) = run_cmd(tug(dir.path()).args(["session", "show", NOWHERE_UUID]));
    assert_eq!(code, 3);
    assert_eq!(stderr.trim(), "absent");
    assert!(
        stdout.is_empty(),
        "a caller piping a transcript gets an empty pipe, not the word absent: {stdout}"
    );
}

// ── the surface itself ───────────────────────────────────────────────────────

#[test]
fn no_verb_lists_sessions_and_index_put_is_hidden() {
    let dir = fixture();
    let (code, stdout, _) = run_cmd(tug(dir.path()).args(["session", "--help"]));
    assert_eq!(code, 0);
    assert!(stdout.contains("find"), "{stdout}");
    assert!(stdout.contains("show"), "{stdout}");
    assert!(
        !stdout.contains("index-put"),
        "the fixture verb is not part of the surface: {stdout}"
    );
    assert!(
        !stdout.contains("list"),
        "no verb enumerates sessions — find answers about one reference: {stdout}"
    );

    // Hidden is not absent: the fixtures still reach it.
    let (code, _, _) = run_cmd(tug(dir.path()).args(["session", "index-put", "--help"]));
    assert_eq!(code, 0);
}
