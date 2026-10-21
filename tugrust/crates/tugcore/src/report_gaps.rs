//! ReportGaps — the record of long Bash calls that reported nothing.
//!
//! The Bash block's report panel draws for a command that reports with a unit
//! (`tugtool report unit`, `tugtool test run`), and nothing draws for
//! one that does not. This ledger is the feedback loop that says where the
//! next report is due: one row per Bash call that ran past
//! [`GAP_THRESHOLD_MS`] and ended with no unit report attached to it,
//! carrying the command's head, the project it ran in and its wall time.
//! `tugtool report gaps` ranks the heads by count and total time.
//!
//! Beside the gaps it keeps every foreground call's head and wall time, long
//! or short, in `call_times`, which is what a head's median is read from: a
//! head whose calls are honestly quick and one of which sat for minutes is a
//! stalled call — a hang — rather than a gap where a report is due.
//!
//! **Machine-global**, beside `changes.db` and `session_index.db`
//! (`tugcore::instance::report_gaps_db_path`): the question it answers — which
//! long runs go unreported — is about the user's habits across every
//! project, not about one instance.
//!
//! It lives in tugcore because tugtool reads it and cannot link tugcast.
//! **tugcast is the only writer**, at the `tool_result` that ends a call,
//! and its writes are telemetry: a failed write is logged and never touches
//! the call it was about. **Readers open read-only**, and a missing file or
//! table is an empty answer rather than an error.
//!
//! Retention is bounded: the most recent [`RETAINED_ROWS`] rows are kept,
//! pruned at record time. The schema is gated on `PRAGMA user_version` with
//! a registered migration list, the regime of every shared ledger here.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, params};

/// Current on-disk schema version, stamped into `PRAGMA user_version`.
pub const REPORT_GAPS_SCHEMA_VERSION: i64 = 2;

/// Registered migrations, each keyed by the on-disk version it upgrades
/// *from*.
const REPORT_GAPS_MIGRATIONS: &[(i64, &str)] = &[(1, CREATE_CALL_TIMES_SQL)];

/// How long a Bash call runs before its silence is worth a row.
pub const GAP_THRESHOLD_MS: i64 = 20_000;

/// The most rows kept; the oldest go first.
pub const RETAINED_ROWS: i64 = 5_000;

/// The most call times kept; the oldest go first. Every foreground call
/// leaves one, so this holds more than the gaps do.
pub const RETAINED_CALL_TIMES: i64 = 20_000;

/// How long a call of a head whose median is short must run to be a stalled
/// call rather than a gap: a command that is honestly quick, and that once
/// sat for a minute or more, hung — it wants a look, not a report.
pub const STALLED_MAX_MS: i64 = 60_000;

/// The most of a command's text one row keeps.
const COMMAND_KEPT: usize = 500;

const CREATE_REPORT_GAPS_SQL: &str = "
    CREATE TABLE IF NOT EXISTS report_gaps (
        id          INTEGER PRIMARY KEY,
        head        TEXT NOT NULL,
        command     TEXT NOT NULL,
        project_dir TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        wall_ms     INTEGER NOT NULL,
        ended_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS report_gaps_head ON report_gaps(head);
";

/// Every foreground call's head and wall time, long or short, reported or
/// not: what a head's median is read from, since the gap rows alone are all
/// past the threshold by construction.
const CREATE_CALL_TIMES_SQL: &str = "
    CREATE TABLE IF NOT EXISTS call_times (
        id          INTEGER PRIMARY KEY,
        head        TEXT NOT NULL,
        wall_ms     INTEGER NOT NULL,
        ended_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS call_times_head ON call_times(head);
";

/// One long, unreported Bash call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GapRow {
    /// The command's head, as [`command_head`] reads it.
    pub head: String,
    /// The command as the call spelled it, cut to [`COMMAND_KEPT`] chars.
    pub command: String,
    pub project_dir: String,
    pub session_id: String,
    pub wall_ms: i64,
    pub ended_at_ms: i64,
}

/// One of a session's dark calls, as the Session card's Jobs popover lists
/// it: what ran, for how long, and when it ended.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGap {
    pub head: String,
    pub wall_ms: i64,
    pub ended_at_ms: i64,
}

/// How many of a session's dark calls the card is handed, newest first.
pub const SESSION_GAPS_SHOWN: i64 = 20;

/// One head's standing in the record.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GapSummary {
    pub head: String,
    pub count: i64,
    pub total_ms: i64,
    pub last_ended_at_ms: i64,
    /// The longest gap.
    pub max_ms: i64,
    /// The head's median wall time over every call it made, long or short,
    /// from the call times; over its gaps alone when it has none recorded.
    pub median_ms: i64,
    /// How many calls the median was read from.
    pub calls: i64,
    /// The latest gap's command and the project it ran in, for a reader that
    /// asks what the hook would have made of it.
    pub last_command: String,
    pub last_project_dir: String,
}

impl GapSummary {
    /// A stalled call rather than a gap: the head is honestly quick — its
    /// median is under the threshold — and a call of it sat for
    /// [`STALLED_MAX_MS`] or more. That is a hang, and the adoption list is no
    /// place for it.
    pub fn stalled(&self) -> bool {
        self.median_ms < GAP_THRESHOLD_MS && self.max_ms >= STALLED_MAX_MS
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ReportGapsError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("report gaps schema on disk is v{on_disk}, newer than this build's v{supported}")]
    SchemaTooNew { on_disk: i64, supported: i64 },
}

/// The hook's prefix on every readable Bash call: `export TUG_TOOL_USE_ID=<id>; `
/// (`tugtool hook pre-tool-use`). Every reader of a call's command — this
/// record's head, the deck's block — reads past it, so the head and the
/// header show what the model wrote.
pub const CALL_ID_EXPORT: &str = "export TUG_TOOL_USE_ID=";

/// The head of a command: its first two words, read past the hook's call-id
/// export, a leading `cd <dir> &&` and environment assignments, so
/// `export TUG_TOOL_USE_ID=x; cd tugrust && cargo nextest run` and
/// `RUST_LOG=x cargo nextest run` both group under `cargo nextest`, and
/// `just app-test x.test.ts` under `just app-test`.
pub fn command_head(command: &str) -> String {
    command_words(command)
        .into_iter()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Every word of a command past what [`command_head`] reads past: the hook's
/// call-id export, a leading `cd <dir> &&` and environment assignments.
pub fn command_words(command: &str) -> Vec<&str> {
    let mut rest = command.trim();
    if rest.starts_with(CALL_ID_EXPORT)
        && let Some((_, tail)) = rest.split_once(';')
    {
        rest = tail.trim();
    }
    while let Some(after) = rest.strip_prefix("cd ")
        && let Some((_, tail)) = after.split_once("&&")
    {
        rest = tail.trim();
    }
    rest.split_whitespace()
        .skip_while(|w| is_assignment(w))
        .collect()
}

/// `NAME=value`, where the name is a shell variable name.
fn is_assignment(word: &str) -> bool {
    match word.split_once('=') {
        Some((name, _)) => {
            !name.is_empty()
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && !name.starts_with(|c: char| c.is_ascii_digit())
        }
        None => false,
    }
}

/// Cut a command to what a row keeps, on a char boundary.
pub fn command_kept(command: &str) -> String {
    command.chars().take(COMMAND_KEPT).collect()
}

/// A writable handle on the record. Held by tugcast; every other reader
/// goes through [`summarize`].
#[derive(Debug)]
pub struct ReportGaps {
    db: Mutex<Connection>,
}

impl ReportGaps {
    /// The machine-global record path.
    pub fn default_path() -> PathBuf {
        crate::instance::report_gaps_db_path()
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, ReportGapsError> {
        if let Some(dir) = path.as_ref().parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = crate::ledger_db::open(path)?;
        Self::from_conn(conn)
    }

    fn from_conn(conn: Connection) -> Result<Self, ReportGapsError> {
        crate::ledger_db::apply_pragmas(&conn)?;
        let schema = crate::ledger_db::LedgerSchema {
            db: rusqlite::DatabaseName::Main,
            version: REPORT_GAPS_SCHEMA_VERSION,
            migrations: REPORT_GAPS_MIGRATIONS,
            already_applied: crate::ledger_db::no_migration_error_absorbed,
        };
        let migrated = crate::ledger_db::migrate(&conn, &schema, |conn| {
            conn.execute_batch(CREATE_REPORT_GAPS_SQL)?;
            conn.execute_batch(CREATE_CALL_TIMES_SQL)
        })?;
        if let crate::ledger_db::Migrated::TooNew { on_disk } = migrated {
            return Err(ReportGapsError::SchemaTooNew {
                on_disk,
                supported: REPORT_GAPS_SCHEMA_VERSION,
            });
        }
        Ok(Self {
            db: Mutex::new(conn),
        })
    }

    /// Record one gap, and prune the record to [`RETAINED_ROWS`].
    pub fn record(&self, row: &GapRow) -> Result<(), ReportGapsError> {
        let conn = self.db.lock();
        conn.execute(
            "INSERT INTO report_gaps (head, command, project_dir, session_id, wall_ms, ended_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                row.head,
                command_kept(&row.command),
                row.project_dir,
                row.session_id,
                row.wall_ms,
                row.ended_at_ms,
            ],
        )?;
        conn.execute(
            "DELETE FROM report_gaps WHERE id NOT IN
                (SELECT id FROM report_gaps ORDER BY id DESC LIMIT ?1)",
            params![RETAINED_ROWS],
        )?;
        Ok(())
    }

    /// Record one foreground call's wall time under its head, and prune the
    /// call times to [`RETAINED_CALL_TIMES`].
    pub fn time(&self, head: &str, wall_ms: i64, ended_at_ms: i64) -> Result<(), ReportGapsError> {
        let conn = self.db.lock();
        conn.execute(
            "INSERT INTO call_times (head, wall_ms, ended_at_ms) VALUES (?1, ?2, ?3)",
            params![head, wall_ms, ended_at_ms],
        )?;
        conn.execute(
            "DELETE FROM call_times WHERE id NOT IN
                (SELECT id FROM call_times ORDER BY id DESC LIMIT ?1)",
            params![RETAINED_CALL_TIMES],
        )?;
        Ok(())
    }

    /// One session's dark calls, newest first, at most
    /// [`SESSION_GAPS_SHOWN`] of them. A read that fails answers with
    /// nothing: the list is a view, never a reason to fail the card.
    pub fn session(&self, session_id: &str) -> Vec<SessionGap> {
        let conn = self.db.lock();
        let Ok(mut stmt) = conn.prepare(
            "SELECT head, wall_ms, ended_at_ms FROM report_gaps
             WHERE session_id = ?1 ORDER BY id DESC LIMIT ?2",
        ) else {
            return Vec::new();
        };
        let Ok(rows) = stmt.query_map(params![session_id, SESSION_GAPS_SHOWN], |r| {
            Ok(SessionGap {
                head: r.get(0)?,
                wall_ms: r.get(1)?,
                ended_at_ms: r.get(2)?,
            })
        }) else {
            return Vec::new();
        };
        rows.filter_map(|r| r.ok()).collect()
    }

    #[cfg(test)]
    fn count(&self) -> i64 {
        self.db
            .lock()
            .query_row("SELECT COUNT(*) FROM report_gaps", [], |r| r.get(0))
            .unwrap_or(0)
    }
}

const SUMMARY_SQL: &str = "
    SELECT head, COUNT(*), SUM(wall_ms), MAX(ended_at_ms), MAX(wall_ms),
           (SELECT command FROM report_gaps g WHERE g.head = report_gaps.head ORDER BY id DESC LIMIT 1),
           (SELECT project_dir FROM report_gaps g WHERE g.head = report_gaps.head ORDER BY id DESC LIMIT 1)
    FROM report_gaps
    GROUP BY head
    ORDER BY COUNT(*) DESC, SUM(wall_ms) DESC, head ASC
";

/// The middle of a set of wall times; the lower middle of an even set, so a
/// head with one quick call and one hang reads as quick.
fn median(mut times: Vec<i64>) -> i64 {
    times.sort_unstable();
    times
        .get(times.len().saturating_sub(1) / 2)
        .copied()
        .unwrap_or(0)
}

/// Each head's wall times in `table`: `call_times`, or `report_gaps` for a
/// head with none there. A record from before a table, or one that will not
/// answer, has none.
fn times_by_head(conn: &Connection, table: &str) -> HashMap<String, Vec<i64>> {
    let mut times: HashMap<String, Vec<i64>> = HashMap::new();
    let Ok(mut stmt) = conn.prepare(&format!("SELECT head, wall_ms FROM {table}")) else {
        return times;
    };
    let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))) else {
        return times;
    };
    for (head, wall_ms) in rows.flatten() {
        times.entry(head).or_default().push(wall_ms);
    }
    times
}

/// Every head in the record, most frequent first. Read-only; a missing
/// file or table answers with nothing.
pub fn summarize(path: &Path) -> Vec<GapSummary> {
    if !path.exists() {
        return Vec::new();
    }
    let Ok(conn) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare(SUMMARY_SQL) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |r| {
        Ok(GapSummary {
            head: r.get(0)?,
            count: r.get(1)?,
            total_ms: r.get(2)?,
            last_ended_at_ms: r.get(3)?,
            max_ms: r.get(4)?,
            median_ms: 0,
            calls: 0,
            last_command: r.get(5)?,
            last_project_dir: r.get(6)?,
        })
    }) else {
        return Vec::new();
    };
    let mut summaries: Vec<GapSummary> = rows.filter_map(|r| r.ok()).collect();
    drop(stmt);
    let mut calls = times_by_head(&conn, "call_times");
    let mut gaps = times_by_head(&conn, "report_gaps");
    for summary in &mut summaries {
        let times = calls
            .remove(&summary.head)
            .or_else(|| gaps.remove(&summary.head))
            .unwrap_or_default();
        summary.calls = times.len() as i64;
        summary.median_ms = median(times);
    }
    summaries
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(head: &str, wall_ms: i64, ended_at_ms: i64) -> GapRow {
        GapRow {
            head: head.to_string(),
            command: format!("{head} --flag"),
            project_dir: "/proj".into(),
            session_id: "sess".into(),
            wall_ms,
            ended_at_ms,
        }
    }

    #[test]
    fn the_head_reads_past_cd_and_assignments() {
        assert_eq!(command_head("cargo nextest run -p x"), "cargo nextest");
        assert_eq!(
            command_head("export TUG_TOOL_USE_ID=toolu_01A; cd tugrust && cargo nextest run"),
            "cargo nextest"
        );
        assert_eq!(
            command_head("export TUG_TOOL_USE_ID=toolu_01A; just app-test at0707.test.ts"),
            "just app-test"
        );
        assert_eq!(
            command_head("cd tugrust && cargo nextest run"),
            "cargo nextest"
        );
        assert_eq!(
            command_head("RUST_LOG=debug FOO=1 cargo test"),
            "cargo test"
        );
        assert_eq!(
            command_head("just app-test at0001.test.ts"),
            "just app-test"
        );
        assert_eq!(command_head("  sleep 30"), "sleep 30");
        assert_eq!(command_head("make"), "make");
        assert_eq!(command_head("a=b"), "");
        // `2>&1` is not an assignment, and neither is a path.
        assert_eq!(command_head("./run.sh 2>&1"), "./run.sh 2>&1");
    }

    #[test]
    fn a_sessions_dark_calls_are_its_own_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let gaps = ReportGaps::open(dir.path().join("report_gaps.db")).unwrap();
        gaps.record(&row("cargo nextest", 30_000, 100)).unwrap();
        gaps.record(&GapRow {
            session_id: "other".into(),
            ..row("just build-app", 90_000, 150)
        })
        .unwrap();
        gaps.record(&row("just app-test", 45_000, 200)).unwrap();
        assert_eq!(
            gaps.session("sess"),
            vec![
                SessionGap {
                    head: "just app-test".into(),
                    wall_ms: 45_000,
                    ended_at_ms: 200,
                },
                SessionGap {
                    head: "cargo nextest".into(),
                    wall_ms: 30_000,
                    ended_at_ms: 100,
                },
            ]
        );
        assert!(gaps.session("nobody").is_empty());
    }

    #[test]
    fn rows_are_recorded_summarized_and_pruned() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("report_gaps.db");
        let gaps = ReportGaps::open(&path).unwrap();
        gaps.record(&row("cargo nextest", 30_000, 100)).unwrap();
        gaps.record(&row("cargo nextest", 50_000, 200)).unwrap();
        gaps.record(&row("just build-app", 120_000, 150)).unwrap();
        let summary = summarize(&path);
        assert_eq!(
            summary,
            vec![
                GapSummary {
                    head: "cargo nextest".into(),
                    count: 2,
                    total_ms: 80_000,
                    last_ended_at_ms: 200,
                    max_ms: 50_000,
                    // No call times: the median is the gaps' own, lower middle.
                    median_ms: 30_000,
                    calls: 2,
                    last_command: "cargo nextest --flag".into(),
                    last_project_dir: "/proj".into(),
                },
                GapSummary {
                    head: "just build-app".into(),
                    count: 1,
                    total_ms: 120_000,
                    last_ended_at_ms: 150,
                    max_ms: 120_000,
                    median_ms: 120_000,
                    calls: 1,
                    last_command: "just build-app --flag".into(),
                    last_project_dir: "/proj".into(),
                },
            ]
        );
        for i in 0..(RETAINED_ROWS + 10) {
            gaps.record(&row("sleep 60", 60_000, 1_000 + i)).unwrap();
        }
        assert_eq!(gaps.count(), RETAINED_ROWS, "the oldest rows are pruned");
    }

    #[test]
    fn a_quick_head_that_hung_is_stalled_and_a_slow_one_is_a_gap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("report_gaps.db");
        let gaps = ReportGaps::open(&path).unwrap();
        // `grep -rn` answers in a second, nine times, and once sat 7 minutes.
        for i in 0..9 {
            gaps.time("grep -rn", 900, i).unwrap();
        }
        gaps.time("grep -rn", 420_000, 10).unwrap();
        gaps.record(&row("grep -rn", 420_000, 10)).unwrap();
        // `just build-app` takes two minutes every time.
        for i in 0..3 {
            gaps.time("just build-app", 120_000, 20 + i).unwrap();
            gaps.record(&row("just build-app", 120_000, 20 + i))
                .unwrap();
        }
        let summary = summarize(&path);
        let grep = summary.iter().find(|g| g.head == "grep -rn").unwrap();
        assert_eq!(
            (grep.median_ms, grep.calls, grep.max_ms),
            (900, 10, 420_000)
        );
        assert!(grep.stalled());
        let build = summary.iter().find(|g| g.head == "just build-app").unwrap();
        assert_eq!(build.median_ms, 120_000);
        assert!(!build.stalled());
    }

    #[test]
    fn a_version_one_record_upgrades_and_keeps_its_gaps() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("report_gaps.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(CREATE_REPORT_GAPS_SQL).unwrap();
            conn.execute(
                "INSERT INTO report_gaps (head, command, project_dir, session_id, wall_ms, ended_at_ms)
                 VALUES ('cargo nextest', 'cargo nextest run', '/p', 's', 30000, 1)",
                [],
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 1i64).unwrap();
        }
        // A reader of the old record has no call times and still answers.
        assert_eq!(summarize(&path)[0].median_ms, 30_000);
        let gaps = ReportGaps::open(&path).unwrap();
        gaps.time("cargo nextest", 25_000, 2).unwrap();
        let summary = summarize(&path);
        assert_eq!((summary[0].count, summary[0].calls), (1, 1));
        assert_eq!(summary[0].median_ms, 25_000);
    }

    #[test]
    fn a_missing_record_is_an_empty_answer() {
        let dir = tempfile::tempdir().unwrap();
        assert!(summarize(&dir.path().join("none.db")).is_empty());
        // A file that is not a ledger — no table — reads the same way.
        let other = dir.path().join("other.db");
        Connection::open(&other)
            .unwrap()
            .execute_batch("CREATE TABLE x (a)")
            .unwrap();
        assert!(summarize(&other).is_empty());
    }

    #[test]
    fn a_newer_schema_refuses_the_open() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("report_gaps.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "user_version", 999i64).unwrap();
        }
        assert!(matches!(
            ReportGaps::open(&path),
            Err(ReportGapsError::SchemaTooNew { on_disk: 999, .. })
        ));
    }
}
