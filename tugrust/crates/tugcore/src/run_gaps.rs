//! RunGaps — the record of long Bash calls that reported no progress.
//!
//! The Bash block's run panel draws for a command that reports with a unit
//! (`tugtool progress --unit …`, `tugtool test run`), and nothing draws for
//! one that does not. This ledger is the feedback loop that says where the
//! next report is due: one row per Bash call that ran past
//! [`GAP_THRESHOLD_MS`] and ended with no unit report attached to it,
//! carrying the command's head, the project it ran in and its wall time.
//! `tugtool progress gaps` ranks the heads by count and total time.
//!
//! **Machine-global**, beside `changes.db` and `session_index.db`
//! (`tugcore::instance::run_gaps_db_path`): the question it answers — which
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
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, params};

/// Current on-disk schema version, stamped into `PRAGMA user_version`.
pub const RUN_GAPS_SCHEMA_VERSION: i64 = 1;

/// Registered migrations, each keyed by the on-disk version it upgrades
/// *from*.
const RUN_GAPS_MIGRATIONS: &[(i64, &str)] = &[];

/// How long a Bash call runs before its silence is worth a row.
pub const GAP_THRESHOLD_MS: i64 = 20_000;

/// The most rows kept; the oldest go first.
pub const RETAINED_ROWS: i64 = 5_000;

/// The most of a command's text one row keeps.
const COMMAND_KEPT: usize = 500;

const CREATE_RUN_GAPS_SQL: &str = "
    CREATE TABLE IF NOT EXISTS run_gaps (
        id          INTEGER PRIMARY KEY,
        head        TEXT NOT NULL,
        command     TEXT NOT NULL,
        project_dir TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        wall_ms     INTEGER NOT NULL,
        ended_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS run_gaps_head ON run_gaps(head);
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

/// One head's standing in the record.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GapSummary {
    pub head: String,
    pub count: i64,
    pub total_ms: i64,
    pub last_ended_at_ms: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum RunGapsError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("run gaps schema on disk is v{on_disk}, newer than this build's v{supported}")]
    SchemaTooNew { on_disk: i64, supported: i64 },
}

/// The head of a command: its first two words, read past a leading
/// `cd <dir> &&` and past environment assignments, so `cd tugrust && cargo
/// nextest run` and `RUST_LOG=x cargo nextest run` both group under
/// `cargo nextest`, and `just app-test x.test.ts` under `just app-test`.
pub fn command_head(command: &str) -> String {
    let mut rest = command.trim();
    while let Some(after) = rest.strip_prefix("cd ")
        && let Some((_, tail)) = after.split_once("&&")
    {
        rest = tail.trim();
    }
    let words: Vec<&str> = rest
        .split_whitespace()
        .skip_while(|w| is_assignment(w))
        .take(2)
        .collect();
    words.join(" ")
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
pub struct RunGaps {
    db: Mutex<Connection>,
}

impl RunGaps {
    /// The machine-global record path.
    pub fn default_path() -> PathBuf {
        crate::instance::run_gaps_db_path()
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, RunGapsError> {
        if let Some(dir) = path.as_ref().parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = crate::ledger_db::open(path)?;
        Self::from_conn(conn)
    }

    fn from_conn(conn: Connection) -> Result<Self, RunGapsError> {
        crate::ledger_db::apply_pragmas(&conn)?;
        let schema = crate::ledger_db::LedgerSchema {
            db: rusqlite::DatabaseName::Main,
            version: RUN_GAPS_SCHEMA_VERSION,
            migrations: RUN_GAPS_MIGRATIONS,
            already_applied: crate::ledger_db::no_migration_error_absorbed,
        };
        let migrated = crate::ledger_db::migrate(&conn, &schema, |conn| {
            conn.execute_batch(CREATE_RUN_GAPS_SQL)
        })?;
        if let crate::ledger_db::Migrated::TooNew { on_disk } = migrated {
            return Err(RunGapsError::SchemaTooNew {
                on_disk,
                supported: RUN_GAPS_SCHEMA_VERSION,
            });
        }
        Ok(Self {
            db: Mutex::new(conn),
        })
    }

    /// Record one gap, and prune the record to [`RETAINED_ROWS`].
    pub fn record(&self, row: &GapRow) -> Result<(), RunGapsError> {
        let conn = self.db.lock();
        conn.execute(
            "INSERT INTO run_gaps (head, command, project_dir, session_id, wall_ms, ended_at_ms)
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
            "DELETE FROM run_gaps WHERE id NOT IN
                (SELECT id FROM run_gaps ORDER BY id DESC LIMIT ?1)",
            params![RETAINED_ROWS],
        )?;
        Ok(())
    }

    #[cfg(test)]
    fn count(&self) -> i64 {
        self.db
            .lock()
            .query_row("SELECT COUNT(*) FROM run_gaps", [], |r| r.get(0))
            .unwrap_or(0)
    }
}

const SUMMARY_SQL: &str = "
    SELECT head, COUNT(*), SUM(wall_ms), MAX(ended_at_ms)
    FROM run_gaps
    GROUP BY head
    ORDER BY COUNT(*) DESC, SUM(wall_ms) DESC, head ASC
";

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
        })
    }) else {
        return Vec::new();
    };
    rows.filter_map(|r| r.ok()).collect()
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
    fn rows_are_recorded_summarized_and_pruned() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("run_gaps.db");
        let gaps = RunGaps::open(&path).unwrap();
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
                },
                GapSummary {
                    head: "just build-app".into(),
                    count: 1,
                    total_ms: 120_000,
                    last_ended_at_ms: 150,
                },
            ]
        );
        for i in 0..(RETAINED_ROWS + 10) {
            gaps.record(&row("sleep 60", 60_000, 1_000 + i)).unwrap();
        }
        assert_eq!(gaps.count(), RETAINED_ROWS, "the oldest rows are pruned");
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
        let path = dir.path().join("run_gaps.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "user_version", 999i64).unwrap();
        }
        assert!(matches!(
            RunGaps::open(&path),
            Err(RunGapsError::SchemaTooNew { on_disk: 999, .. })
        ));
    }
}
