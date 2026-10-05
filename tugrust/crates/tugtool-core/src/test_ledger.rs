//! The unit-test results ledger — what every recorded test-suite run leaves
//! behind.
//!
//! One row per recorded invocation (`bun test` in one directory, one
//! `cargo nextest run`), one row per test file or test binary in it, and one
//! row per failing case. The question it exists to answer is asked right after
//! a red run whose output was filtered, redirected or scrolled away: *which
//! tests failed?* [`latest_per_suite`] answers it without running the suite
//! a second time.
//!
//! Passing cases are deliberately not kept. A deck run is ten thousand of
//! them, and no reader asks which ones passed — only how many, and how long
//! each file took, which the per-file rows hold.
//!
//! **Machine-global**, beside `apptest_results.db`
//! (`tugcore::instance::test_results_db_path`), and keyed by the **resolved
//! base checkout** of the run's project root, so a run recorded from a
//! subdirectory of an arc worktree answers a read made at the root of the
//! checkout it forked from.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, params};
use serde::Serialize;

use crate::apptest_ledger::resolve_base_root;

/// Current on-disk schema version, stamped into `PRAGMA user_version`.
pub const TEST_RESULTS_SCHEMA_VERSION: i64 = 1;

/// Registered migrations, each keyed by the on-disk version it upgrades
/// *from*. A schema change adds an entry here and bumps
/// [`TEST_RESULTS_SCHEMA_VERSION`] — never edits the DDL alone.
const TEST_RESULTS_MIGRATIONS: &[(i64, &str)] = &[];

/// How many runs are kept per base root. Older runs are deleted at record
/// time, and their file and failure rows follow by cascade.
pub const MAX_RUNS_PER_ROOT: i64 = 200;

/// A failure's body is kept to this many characters. A panic with a long
/// backtrace or a snapshot diff says what it needs to in far less.
pub const DETAIL_MAX_CHARS: usize = 4_000;

const CREATE_TEST_RESULTS_SQL: &str = "
    CREATE TABLE IF NOT EXISTS runs (
        id          INTEGER PRIMARY KEY,
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER NOT NULL,
        base_root   TEXT    NOT NULL,
        run_root    TEXT    NOT NULL,
        branch      TEXT    NOT NULL,
        head_sha    TEXT    NOT NULL,
        dirty       INTEGER NOT NULL,
        suite       TEXT    NOT NULL,
        session_id  TEXT,
        command     TEXT    NOT NULL,
        exit_code   INTEGER NOT NULL,
        wall_secs   REAL    NOT NULL,
        tests       INTEGER NOT NULL,
        failed      INTEGER NOT NULL,
        skipped     INTEGER NOT NULL,
        has_record  INTEGER NOT NULL,
        verdict     TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_by_suite ON runs (base_root, suite, id);
    CREATE TABLE IF NOT EXISTS files (
        run_id      INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        file        TEXT    NOT NULL,
        tests       INTEGER NOT NULL,
        failed      INTEGER NOT NULL,
        secs        REAL    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS files_by_run ON files (run_id);
    CREATE TABLE IF NOT EXISTS failures (
        run_id      INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        file        TEXT    NOT NULL,
        name        TEXT    NOT NULL,
        classname   TEXT    NOT NULL,
        message     TEXT    NOT NULL,
        detail      TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS failures_by_run ON failures (run_id);
";

#[derive(Debug, thiserror::Error)]
pub enum TestLedgerError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("test results schema on disk is v{on_disk}, newer than this build's v{supported}")]
    SchemaTooNew { on_disk: i64, supported: i64 },
    #[error("not a junit document: {0}")]
    Junit(String),
}

/// One test file (bun) or test binary (nextest) within a run.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct JunitFile {
    pub file: String,
    pub tests: i64,
    pub failed: i64,
    pub secs: f64,
}

/// One failing or erroring case.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct JunitFailure {
    pub file: String,
    pub name: String,
    pub classname: String,
    /// The one-line reason. Empty when the document carries none — bun's
    /// junit writes a bare `<failure type="AssertionError" />`, so a bun
    /// failure's message has to come from somewhere other than the document.
    pub message: String,
    /// The failure's body, truncated to [`DETAIL_MAX_CHARS`].
    pub detail: String,
}

/// What a junit document says about one run.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct JunitRun {
    pub tests: i64,
    pub failed: i64,
    pub skipped: i64,
    pub files: Vec<JunitFile>,
    pub failures: Vec<JunitFailure>,
}

/// Parse a junit document as bun or nextest writes it.
///
/// Both put one `<testsuite>` per file (bun) or per test binary (nextest)
/// directly under `<testsuites>`, and that suite is the per-file aggregate.
/// Bun nests a further `<testsuite>` per `describe` inside it; nextest does
/// not nest. So the aggregate is always the root's child, and the cases are
/// every `<testcase>` beneath it, at whatever depth. Counts are taken from
/// the cases themselves rather than from the suites' attributes, so a
/// producer that writes no totals is read the same as one that does.
pub fn parse_junit(xml: &str) -> Result<JunitRun, TestLedgerError> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| TestLedgerError::Junit(e.to_string()))?;
    let root = doc.root_element();
    let suites: Vec<roxmltree::Node> = match root.tag_name().name() {
        "testsuites" => root
            .children()
            .filter(|n| n.has_tag_name("testsuite"))
            .collect(),
        // A producer that writes a single suite with no wrapper.
        "testsuite" => vec![root],
        other => {
            return Err(TestLedgerError::Junit(format!(
                "root element is <{other}>, not <testsuites>"
            )));
        }
    };

    let mut run = JunitRun::default();
    for suite in suites {
        let file = suite
            .attribute("file")
            .or_else(|| suite.attribute("name"))
            .unwrap_or("")
            .to_string();
        let mut tests = 0;
        let mut failed = 0;
        let mut case_secs = 0.0;
        for case in suite.descendants().filter(|n| n.has_tag_name("testcase")) {
            tests += 1;
            case_secs += seconds(case.attribute("time"));
            if case.children().any(|n| n.has_tag_name("skipped")) {
                run.skipped += 1;
                continue;
            }
            let Some(fail) = case
                .children()
                .find(|n| n.has_tag_name("failure") || n.has_tag_name("error"))
            else {
                continue;
            };
            failed += 1;
            run.failures.push(failure_of(case, fail, &file));
        }
        let secs = suite
            .attribute("time")
            .and_then(|t| t.parse::<f64>().ok())
            .unwrap_or(case_secs);
        run.tests += tests;
        run.failed += failed;
        run.files.push(JunitFile {
            file,
            tests,
            failed,
            secs,
        });
    }
    Ok(run)
}

fn seconds(attr: Option<&str>) -> f64 {
    attr.and_then(|t| t.parse::<f64>().ok()).unwrap_or(0.0)
}

fn failure_of(case: roxmltree::Node, fail: roxmltree::Node, suite_file: &str) -> JunitFailure {
    let body = text_of(fail);
    // nextest puts the panic in the failure body; a producer that writes an
    // empty body may still have said it on stderr.
    let detail = if body.trim().is_empty() {
        case.children()
            .find(|n| n.has_tag_name("system-err"))
            .map(text_of)
            .unwrap_or_default()
    } else {
        body
    };
    let message = fail
        .attribute("message")
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_string)
        .or_else(|| first_line(&detail))
        .unwrap_or_default();
    JunitFailure {
        file: case.attribute("file").unwrap_or(suite_file).to_string(),
        name: case.attribute("name").unwrap_or("").to_string(),
        // bun escapes the `>` it joins nested describes with twice, so the
        // document's `&amp;gt;` decodes to a literal `&gt;`.
        classname: case
            .attribute("classname")
            .unwrap_or("")
            .replace("&gt;", ">"),
        message,
        detail: truncate_chars(&detail, DETAIL_MAX_CHARS),
    }
}

fn text_of(node: roxmltree::Node) -> String {
    node.descendants()
        .filter(|n| n.is_text())
        .filter_map(|n| n.text())
        .collect()
}

fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

fn truncate_chars(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((idx, _)) => text[..idx].to_string(),
        None => text.to_string(),
    }
}

/// The root a run is recorded under: the **project root** of the directory it
/// ran in — the nearest `.tugtool/`, else the nearest git checkout — and the
/// directory itself when it is inside neither (a scratch directory).
///
/// Never the raw cwd. A suite run from `tugdeck/` in a main checkout would
/// otherwise be keyed under `tugdeck/`, which is its own base root, and a
/// read made from the repository root would never find it.
pub fn run_root_for(cwd: &Path) -> PathBuf {
    crate::config::find_project_root_from(cwd.to_path_buf()).unwrap_or_else(|_| cwd.to_path_buf())
}

/// The machine-global ledger path.
pub fn default_path() -> PathBuf {
    tugcore::instance::test_results_db_path()
}

/// Open (or create) the ledger, bringing the schema to the current version.
pub fn open_ledger(path: impl AsRef<Path>) -> Result<Connection, TestLedgerError> {
    if let Some(dir) = path.as_ref().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let conn = tugcore::ledger_db::open(path)?;
    prepare(&conn)?;
    Ok(conn)
}

/// Bring a connection's schema to the current version. Split out so tests can
/// exercise it against an in-memory connection.
fn prepare(conn: &Connection) -> Result<(), TestLedgerError> {
    // `files` and `failures` cascade from `runs`; SQLite leaves foreign keys
    // off per connection unless asked.
    conn.pragma_update(None, "foreign_keys", true)?;
    let on_disk: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if on_disk > TEST_RESULTS_SCHEMA_VERSION {
        return Err(TestLedgerError::SchemaTooNew {
            on_disk,
            supported: TEST_RESULTS_SCHEMA_VERSION,
        });
    }
    if on_disk > 0 && on_disk < TEST_RESULTS_SCHEMA_VERSION {
        for (from, sql) in TEST_RESULTS_MIGRATIONS {
            if *from >= on_disk {
                conn.execute_batch(sql)?;
            }
        }
    }
    conn.execute_batch(CREATE_TEST_RESULTS_SQL)?;
    conn.pragma_update(None, "user_version", TEST_RESULTS_SCHEMA_VERSION)?;
    Ok(())
}

/// One invocation, ready to record. The counts come from its junit document.
#[derive(Debug, Clone, PartialEq)]
pub struct TestRun {
    pub started_at: i64,
    pub ended_at: i64,
    /// The project root the run is recorded under ([`run_root_for`]); its
    /// base root is resolved here.
    pub run_root: String,
    pub branch: String,
    pub head_sha: String,
    pub dirty: bool,
    pub suite: String,
    /// The live session segment that ran it, when one was reachable.
    pub session_id: Option<String>,
    pub command: String,
    pub exit_code: i64,
    pub wall_secs: f64,
}

/// What a record left behind.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedRun {
    pub run_id: i64,
    /// How many runs retention removed to make room for this one.
    pub pruned: usize,
}

/// `PASS` only when the command exited 0 and the document names no failure.
pub fn verdict_of(exit_code: i64, failed: i64) -> &'static str {
    if exit_code == 0 && failed == 0 {
        "PASS"
    } else {
        "FAIL"
    }
}

/// Record one run and its document, then prune this base root's history back
/// to [`MAX_RUNS_PER_ROOT`]. `junit` is `None` when no document was readable;
/// the run is still recorded, with no per-test rows, so a reader can say the
/// record is missing rather than say nothing failed.
pub fn record_run(
    conn: &mut Connection,
    run: &TestRun,
    junit: Option<&JunitRun>,
) -> Result<RecordedRun, TestLedgerError> {
    let base_root = resolve_base_root(Path::new(&run.run_root));
    let empty = JunitRun::default();
    let doc = junit.unwrap_or(&empty);
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO runs
            (started_at, ended_at, base_root, run_root, branch, head_sha, dirty,
             suite, session_id, command, exit_code, wall_secs, tests, failed,
             skipped, has_record, verdict)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                 ?15, ?16, ?17)",
        params![
            run.started_at,
            run.ended_at,
            base_root,
            run.run_root,
            run.branch,
            run.head_sha,
            i64::from(run.dirty),
            run.suite,
            run.session_id,
            run.command,
            run.exit_code,
            run.wall_secs,
            doc.tests,
            doc.failed,
            doc.skipped,
            i64::from(junit.is_some()),
            verdict_of(run.exit_code, doc.failed),
        ],
    )?;
    let run_id = tx.last_insert_rowid();
    {
        let mut insert = tx.prepare(
            "INSERT INTO files (run_id, file, tests, failed, secs)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for f in &doc.files {
            insert.execute(params![run_id, f.file, f.tests, f.failed, f.secs])?;
        }
        let mut insert = tx.prepare(
            "INSERT INTO failures (run_id, file, name, classname, message, detail)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for f in &doc.failures {
            insert.execute(params![
                run_id,
                f.file,
                f.name,
                f.classname,
                f.message,
                truncate_chars(&f.detail, DETAIL_MAX_CHARS),
            ])?;
        }
    }
    let pruned = tx.execute(
        "DELETE FROM runs
          WHERE base_root = ?1
            AND id NOT IN (
                SELECT id FROM runs WHERE base_root = ?1
                 ORDER BY id DESC LIMIT ?2
            )",
        params![base_root, MAX_RUNS_PER_ROOT],
    )?;
    tx.commit()?;
    Ok(RecordedRun { run_id, pruned })
}

/// A suite's latest recorded run, as `test last` reads it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiteRun {
    pub run_id: i64,
    pub suite: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub run_root: String,
    pub branch: String,
    pub head_sha: String,
    pub dirty: bool,
    pub session_id: Option<String>,
    pub command: String,
    pub exit_code: i64,
    pub wall_secs: f64,
    pub tests: i64,
    pub failed: i64,
    pub skipped: i64,
    /// False when the run left no readable junit document — its counts are
    /// then zero and say nothing.
    pub has_record: bool,
    pub verdict: String,
    pub files: Vec<JunitFile>,
    pub failures: Vec<JunitFailure>,
}

/// The newest run of each suite recorded for `base_root`, newest first —
/// or of one suite, when `suite` names it.
pub fn latest_per_suite(
    conn: &Connection,
    base_root: &str,
    suite: Option<&str>,
) -> Result<Vec<SuiteRun>, TestLedgerError> {
    let mut stmt = conn.prepare(
        "SELECT r.id, r.suite, r.started_at, r.ended_at, r.run_root, r.branch,
                r.head_sha, r.dirty, r.session_id, r.command, r.exit_code,
                r.wall_secs, r.tests, r.failed, r.skipped, r.has_record, r.verdict
           FROM runs r
          WHERE r.base_root = ?1
            AND (?2 IS NULL OR r.suite = ?2)
            AND r.id = (SELECT MAX(id) FROM runs
                         WHERE base_root = ?1 AND suite = r.suite)
          ORDER BY r.id DESC",
    )?;
    let mut runs: Vec<SuiteRun> = stmt
        .query_map(params![base_root, suite], |row| {
            Ok(SuiteRun {
                run_id: row.get(0)?,
                suite: row.get(1)?,
                started_at: row.get(2)?,
                ended_at: row.get(3)?,
                run_root: row.get(4)?,
                branch: row.get(5)?,
                head_sha: row.get(6)?,
                dirty: row.get::<_, i64>(7)? != 0,
                session_id: row.get(8)?,
                command: row.get(9)?,
                exit_code: row.get(10)?,
                wall_secs: row.get(11)?,
                tests: row.get(12)?,
                failed: row.get(13)?,
                skipped: row.get(14)?,
                has_record: row.get::<_, i64>(15)? != 0,
                verdict: row.get(16)?,
                files: Vec::new(),
                failures: Vec::new(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut files = conn
        .prepare("SELECT file, tests, failed, secs FROM files WHERE run_id = ?1 ORDER BY rowid")?;
    let mut failures = conn.prepare(
        "SELECT file, name, classname, message, detail FROM failures
          WHERE run_id = ?1 ORDER BY rowid",
    )?;
    for run in &mut runs {
        run.files = files
            .query_map(params![run.run_id], |row| {
                Ok(JunitFile {
                    file: row.get(0)?,
                    tests: row.get(1)?,
                    failed: row.get(2)?,
                    secs: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        run.failures = failures
            .query_map(params![run.run_id], |row| {
                Ok(JunitFailure {
                    file: row.get(0)?,
                    name: row.get(1)?,
                    classname: row.get(2)?,
                    message: row.get(3)?,
                    detail: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
    }
    Ok(runs)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// bun 1.3.9's document, as it writes it for two files: one with a
    /// `describe` nesting another, one with a skip and a thrown error. A
    /// failure is a bare `<failure type="AssertionError" />` — no message,
    /// no body.
    const BUN_JUNIT: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="6" assertions="4" failures="2" skipped="1" time="0.011355">
  <testsuite name="b.test.ts" file="b.test.ts" tests="3" assertions="1" failures="1" skipped="1" time="0.5" hostname="h">
    <testcase name="top level" classname="" time="0" file="b.test.ts" line="2" assertions="1" />
    <testcase name="skipped" classname="" time="0" file="b.test.ts" line="3" assertions="0">
      <skipped />
    </testcase>
    <testcase name="throws" classname="" time="0" file="b.test.ts" line="4" assertions="0">
      <failure type="AssertionError" />
    </testcase>
  </testsuite>
  <testsuite name="a.test.ts" file="a.test.ts" tests="3" assertions="3" failures="1" skipped="0" time="1.25" hostname="h">
    <testsuite name="parser" file="a.test.ts" line="2" tests="3" assertions="3" failures="1" skipped="0" time="0" hostname="h">
      <testcase name="good one" classname="parser" time="0" file="a.test.ts" line="3" assertions="1" />
      <testcase name="bad two" classname="parser" time="0" file="a.test.ts" line="4" assertions="1">
        <failure message="expect(received).toBe(expected)" type="AssertionError">Expected: 2
Received: 1</failure>
      </testcase>
      <testsuite name="nested" file="a.test.ts" line="5" tests="1" assertions="1" failures="0" skipped="0" time="0" hostname="h">
        <testcase name="deep" classname="nested &amp;gt; parser" time="0" file="a.test.ts" line="5" assertions="1" />
      </testsuite>
    </testsuite>
  </testsuite>
</testsuites>
"#;

    /// nextest's document: one flat suite per test binary, no `file`
    /// attribute, the panic in the failure body.
    const NEXTEST_JUNIT: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="nextest-run" tests="3" failures="1" errors="0" time="0.4">
  <testsuite name="tugcore" tests="2" disabled="0" errors="0" failures="1">
    <testcase name="ledger_db::tests::opens" classname="tugcore" time="0.010"/>
    <testcase name="ledger_db::tests::fails" classname="tugcore" time="0.020">
      <failure type="test failure with exit code 101">thread 'ledger_db::tests::fails' panicked at crates/tugcore/src/ledger_db.rs:10:5:
assertion `left == right` failed
  left: 1
 right: 2</failure>
      <system-err>noise</system-err>
    </testcase>
  </testsuite>
  <testsuite name="tugtool::bin/tugtool" tests="1" disabled="0" errors="0" failures="0">
    <testcase name="cli::tests::parses" classname="tugtool::bin/tugtool" time="0.005"/>
  </testsuite>
</testsuites>
"#;

    fn ledger(dir: &Path) -> Connection {
        open_ledger(dir.join("test_results.db")).unwrap()
    }

    fn run(root: &str, suite: &str, at: i64, exit_code: i64) -> TestRun {
        TestRun {
            started_at: at - 10,
            ended_at: at,
            run_root: root.to_string(),
            branch: "main".into(),
            head_sha: "abc1234".into(),
            dirty: false,
            suite: suite.into(),
            session_id: None,
            command: "bun test".into(),
            exit_code,
            wall_secs: 10.0,
        }
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_bun_document_gives_one_row_per_file_and_one_per_failure() {
        let doc = parse_junit(BUN_JUNIT).unwrap();
        assert_eq!((doc.tests, doc.failed, doc.skipped), (6, 2, 1));
        assert_eq!(
            doc.files,
            vec![
                JunitFile {
                    file: "b.test.ts".into(),
                    tests: 3,
                    failed: 1,
                    secs: 0.5,
                },
                JunitFile {
                    file: "a.test.ts".into(),
                    tests: 3,
                    failed: 1,
                    secs: 1.25,
                },
            ],
            "the nested describe is part of its file, not a file of its own"
        );
        assert_eq!(doc.failures.len(), 2);
        let bare = &doc.failures[0];
        assert_eq!(
            (bare.file.as_str(), bare.name.as_str()),
            ("b.test.ts", "throws")
        );
        assert_eq!(bare.message, "", "bun writes no message; none is invented");
        let full = &doc.failures[1];
        assert_eq!(full.file, "a.test.ts");
        assert_eq!(full.name, "bad two");
        assert_eq!(full.classname, "parser");
        assert_eq!(full.message, "expect(received).toBe(expected)");
        assert_eq!(full.detail, "Expected: 2\nReceived: 1");
    }

    #[test]
    fn bun_s_doubly_escaped_describe_separator_reads_as_a_separator() {
        let doc = parse_junit(&BUN_JUNIT.replace(
            r#"<testcase name="deep" classname="nested &amp;gt; parser" time="0" file="a.test.ts" line="5" assertions="1" />"#,
            r#"<testcase name="deep" classname="nested &amp;gt; parser" time="0" file="a.test.ts" line="5" assertions="1"><failure type="AssertionError" /></testcase>"#,
        ))
        .unwrap();
        let deep = doc.failures.iter().find(|f| f.name == "deep").unwrap();
        assert_eq!(deep.classname, "nested > parser");
    }

    #[test]
    fn a_nextest_document_gives_one_row_per_binary_and_the_panic_as_message() {
        let doc = parse_junit(NEXTEST_JUNIT).unwrap();
        assert_eq!((doc.tests, doc.failed, doc.skipped), (3, 1, 0));
        assert_eq!(doc.files.len(), 2);
        assert_eq!(doc.files[0].file, "tugcore");
        assert_eq!((doc.files[0].tests, doc.files[0].failed), (2, 1));
        assert!(
            (doc.files[0].secs - 0.030).abs() < 1e-9,
            "no suite time, so the cases' times are summed"
        );
        assert_eq!(doc.files[1].file, "tugtool::bin/tugtool");
        let f = &doc.failures[0];
        assert_eq!(f.file, "tugcore");
        assert_eq!(f.name, "ledger_db::tests::fails");
        assert_eq!(f.classname, "tugcore");
        assert_eq!(
            f.message,
            "thread 'ledger_db::tests::fails' panicked at crates/tugcore/src/ledger_db.rs:10:5:"
        );
        assert!(f.detail.contains("left: 1"));
    }

    #[test]
    fn an_error_element_counts_as_a_failure_and_an_empty_body_falls_back_to_stderr() {
        let doc = parse_junit(
            r#"<testsuites><testsuite name="bin"><testcase name="t">
                 <error type="SIGSEGV"/><system-err>segfault at 0x0</system-err>
               </testcase></testsuite></testsuites>"#,
        )
        .unwrap();
        assert_eq!(doc.failed, 1);
        assert_eq!(doc.failures[0].message, "segfault at 0x0");
    }

    #[test]
    fn a_document_that_is_not_junit_is_refused() {
        assert!(matches!(
            parse_junit("<html/>"),
            Err(TestLedgerError::Junit(_))
        ));
        assert!(matches!(
            parse_junit("not xml"),
            Err(TestLedgerError::Junit(_))
        ));
    }

    #[test]
    fn a_long_body_is_truncated_on_a_character_boundary() {
        let body = "é".repeat(DETAIL_MAX_CHARS + 10);
        let doc = parse_junit(&format!(
            r#"<testsuites><testsuite name="s"><testcase name="t"><failure message="m">{body}</failure></testcase></testsuite></testsuites>"#
        ))
        .unwrap();
        assert_eq!(doc.failures[0].detail.chars().count(), DETAIL_MAX_CHARS);
    }

    #[test]
    fn the_latest_run_of_each_suite_comes_back_newest_first_with_its_failures() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let mut conn = ledger(dir.path());
        let doc = parse_junit(BUN_JUNIT).unwrap();
        let green = JunitRun {
            tests: 4,
            ..JunitRun::default()
        };
        record_run(&mut conn, &run(&root, "tugdeck", 1_000, 1), Some(&doc)).unwrap();
        record_run(&mut conn, &run(&root, "rust", 2_000, 0), Some(&green)).unwrap();
        record_run(&mut conn, &run(&root, "tugdeck", 3_000, 1), Some(&doc)).unwrap();

        let base = resolve_base_root(Path::new(&root));
        let latest = latest_per_suite(&conn, &base, None).unwrap();
        assert_eq!(
            latest
                .iter()
                .map(|r| (r.suite.as_str(), r.ended_at))
                .collect::<Vec<_>>(),
            vec![("tugdeck", 3_000), ("rust", 2_000)]
        );
        let deck = &latest[0];
        assert_eq!(deck.verdict, "FAIL");
        assert!(deck.has_record);
        assert_eq!((deck.tests, deck.failed, deck.skipped), (6, 2, 1));
        assert_eq!(deck.files.len(), 2);
        assert_eq!(
            deck.failures
                .iter()
                .map(|f| f.name.as_str())
                .collect::<Vec<_>>(),
            vec!["throws", "bad two"]
        );
        assert_eq!(latest[1].verdict, "PASS");

        let one = latest_per_suite(&conn, &base, Some("rust")).unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].suite, "rust");
    }

    #[test]
    fn a_run_with_no_document_is_recorded_as_missing_its_record() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let mut conn = ledger(dir.path());
        record_run(&mut conn, &run(&root, "tugcode", 1_000, 1), None).unwrap();
        let latest = latest_per_suite(&conn, &resolve_base_root(Path::new(&root)), None).unwrap();
        assert!(!latest[0].has_record);
        assert_eq!(latest[0].verdict, "FAIL", "the exit code still speaks");
        assert!(latest[0].failures.is_empty());
    }

    #[test]
    fn a_clean_exit_with_a_named_failure_is_still_a_fail() {
        assert_eq!(verdict_of(0, 0), "PASS");
        assert_eq!(verdict_of(0, 1), "FAIL");
        assert_eq!(verdict_of(1, 0), "FAIL");
    }

    #[test]
    fn retention_prunes_the_oldest_and_cascades_their_rows() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("a");
        let other = dir.path().join("b");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let mut conn = ledger(dir.path());
        let doc = parse_junit(BUN_JUNIT).unwrap();
        record_run(
            &mut conn,
            &run(&other.to_string_lossy(), "tugdeck", 1, 1),
            Some(&doc),
        )
        .unwrap();
        let mut pruned = 0;
        for idx in 0..=MAX_RUNS_PER_ROOT {
            pruned += record_run(
                &mut conn,
                &run(&root.to_string_lossy(), "tugdeck", 10 + idx, 1),
                Some(&doc),
            )
            .unwrap()
            .pruned;
        }
        assert_eq!(pruned, 1, "201 runs prune to 200");
        let base = resolve_base_root(&root);
        let kept: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM runs WHERE base_root = ?1",
                params![base],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kept, MAX_RUNS_PER_ROOT);
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM files WHERE run_id NOT IN (SELECT id FROM runs)"
            ),
            0,
            "file rows cascade with their run"
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM failures WHERE run_id NOT IN (SELECT id FROM runs)"
            ),
            0,
            "failure rows cascade with their run"
        );
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM failures"),
            (MAX_RUNS_PER_ROOT + 1) * 2,
            "the kept runs and the other root's run keep theirs"
        );
    }

    #[test]
    fn fresh_open_creates_schema_and_reopen_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_results.db");
        {
            let conn = open_ledger(&path).unwrap();
            assert_eq!(
                count(&conn, "PRAGMA user_version"),
                TEST_RESULTS_SCHEMA_VERSION
            );
            assert_eq!(count(&conn, "PRAGMA foreign_keys"), 1);
        }
        let again = open_ledger(&path).unwrap();
        assert_eq!(
            count(&again, "PRAGMA user_version"),
            TEST_RESULTS_SCHEMA_VERSION
        );
    }

    #[test]
    fn a_newer_schema_is_refused() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", TEST_RESULTS_SCHEMA_VERSION + 1)
            .unwrap();
        match prepare(&conn) {
            Err(TestLedgerError::SchemaTooNew { on_disk, supported }) => {
                assert_eq!(on_disk, TEST_RESULTS_SCHEMA_VERSION + 1);
                assert_eq!(supported, TEST_RESULTS_SCHEMA_VERSION);
            }
            other => panic!("expected SchemaTooNew, got {other:?}"),
        }
    }

    #[test]
    fn a_subdirectory_records_under_its_project_root() {
        let dir = tempfile::tempdir().unwrap();
        let checkout = dir.path().join("checkout");
        std::fs::create_dir_all(checkout.join(".git")).unwrap();
        std::fs::create_dir_all(checkout.join("tugdeck/src")).unwrap();
        assert_eq!(run_root_for(&checkout.join("tugdeck/src")), checkout);

        let scratch = dir.path().join("scratch");
        std::fs::create_dir_all(&scratch).unwrap();
        // The tempdir lives under the system temp dir, which is inside no
        // checkout — so a scratch directory is its own root.
        assert_eq!(run_root_for(&scratch), scratch);
    }
}
