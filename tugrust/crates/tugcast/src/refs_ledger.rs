//! RefsLedger — the latest match-or-search run, per session.
//!
//! Exactly one run is kept for each `tug_session_id`: a completed run
//! replaces whatever was there. That is the model the original tools had —
//! one refs file each run overwrote — and it is what makes `/ref 3` mean
//! something definite after a reload. The deck reads it back through the
//! `list_refs` CONTROL op when a card mounts.
//!
//! Its own sqlite file, separate from `sessions.db` and from the shell
//! ledger: unrelated lifecycles, and a corrupt search history must never
//! take a session record down. Writes serialize through a single
//! `Mutex<Connection>`.
//!
//! Only a *settled, uncancelled* run is recorded. A run that was cancelled
//! or superseded holds a partial list, and restoring a partial list would
//! silently renumber what `/ref N` resolves to.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::feeds::text_ref::TextRef;

#[derive(Debug, thiserror::Error)]
pub enum RefsLedgerError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
}

/// A completed run to record.
#[derive(Debug, Clone)]
pub struct NewRefsRun {
    pub tug_session_id: String,
    /// The **line of work** this run belongs to ([P09]). Search history is
    /// the conversation's, so it survives every id change the card lives
    /// through without anything moving it.
    pub line_id: String,
    pub run_id: String,
    pub op_kind: String,
    pub command: String,
    pub refs: Vec<TextRef>,
    pub settled_at_ms: i64,
    /// The Claude assistant `message.id` this run follows in the transcript,
    /// stamped at the write gateway. `None` for a run recorded before the
    /// anchor column existed, or by a session whose JSONL holds no assistant
    /// line yet; such a run restores by timestamp, as every run once did.
    pub anchor_msg_id: Option<String>,
}

/// An anchored run as the re-anchoring repair reads it
/// ([`crate::ink_backfill::reanchor_rotated_lines`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnchoredRefsRun {
    pub line_id: String,
    pub tug_session_id: String,
    pub at_ms: i64,
    pub anchor_msg_id: String,
}

/// The persisted run, serialized into the `list_refs_ok` CONTROL response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RefsRunRow {
    pub run_id: String,
    pub op_kind: String,
    pub command: String,
    pub refs: Vec<TextRef>,
    pub settled_at_ms: i64,
    pub anchor_msg_id: Option<String>,
}

pub struct RefsLedger {
    db: Mutex<Connection>,
}

impl RefsLedger {
    /// Default db path: alongside `sessions.db` (per-instance when
    /// `TUG_INSTANCE_ID` is set), named `refs.db`.
    pub fn default_path() -> Option<PathBuf> {
        let sessions = crate::session_ledger::SessionLedger::default_path()?;
        Some(sessions.with_file_name("refs.db"))
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, RefsLedgerError> {
        // Integrity gate: quarantine a corrupt file and salvage readable
        // rows into the fresh one (see `ledger_integrity`).
        let gate = crate::ledger_integrity::integrity_gate(path.as_ref(), "refs");
        let conn = tugcore::ledger_db::open(path)?;
        let ledger = Self::from_conn(conn)?;
        if let crate::ledger_integrity::GateOutcome::Quarantined { corrupt_path } = &gate {
            let db = ledger.db.lock().expect("refs ledger poisoned");
            crate::ledger_integrity::salvage_into(
                &db,
                "main",
                corrupt_path,
                &["refs_runs"],
                "refs",
            );
        }
        Ok(ledger)
    }

    /// In-memory ledger for tests.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn open_in_memory() -> Result<Self, RefsLedgerError> {
        let conn = Connection::open_in_memory()?;
        Self::from_conn(conn)
    }

    fn from_conn(conn: Connection) -> Result<Self, RefsLedgerError> {
        tugcore::ledger_db::apply_pragmas(&conn)?;
        Self::migrate_add_anchor_msg_id(&conn)?;
        Self::migrate_refs_runs_to_line_key(&conn)?;
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS refs_runs (
                -- One run per **line** ([P09], [Q04]): nothing reads a run by
                -- segment, and `/ref N` means something definite only because
                -- there is exactly one run to number against.
                line_id        TEXT    PRIMARY KEY,
                -- The segment that ran it, kept as the transcript anchor.
                tug_session_id TEXT    NOT NULL,
                run_id         TEXT    NOT NULL,
                op_kind        TEXT    NOT NULL,
                command        TEXT    NOT NULL,
                refs_json      TEXT    NOT NULL,
                settled_at_ms  INTEGER NOT NULL,
                anchor_msg_id  TEXT
            );
            -- One-time passes this ledger has been through, by name
            -- (`ink_backfill`), so a repair that has to read transcripts
            -- runs once and not on every boot.
            CREATE TABLE IF NOT EXISTS backfills (
                name       TEXT    PRIMARY KEY,
                done_at_ms INTEGER NOT NULL
            );
            ",
        )?;
        Ok(Self {
            db: Mutex::new(conn),
        })
    }

    /// Self-healing add of `anchor_msg_id`.
    ///
    /// Runs before the DDL batch so an existing table is widened before
    /// anything reads it; a database that has no `refs_runs` table yet
    /// returns early and gets the column from `CREATE TABLE` instead.
    /// Re-key `refs_runs` from the segment to the **line** ([P09], [Q04]).
    ///
    /// A table rebuild rather than an `ALTER`, because the primary key itself
    /// moves — and a `PRIMARY KEY` cannot be added to an existing SQLite
    /// table. Rows arrive with `line_id = tug_session_id`, which is a line of
    /// one until `ink_backfill::assign_lines` resolves them: this ledger
    /// cannot see `sessions.db`, so it is the only honest placeholder.
    ///
    /// A no-op on a table that already speaks lines, and on a database with
    /// no `refs_runs` at all — the `CREATE TABLE` below then makes the right
    /// shape directly.
    fn migrate_refs_runs_to_line_key(conn: &Connection) -> Result<(), RefsLedgerError> {
        let cols = crate::ledger_integrity::table_columns(conn, "main", "refs_runs")?;
        if cols.is_empty() || cols.iter().any(|c| c == "line_id") {
            return Ok(());
        }
        conn.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE refs_runs_new (
                line_id        TEXT    PRIMARY KEY,
                tug_session_id TEXT    NOT NULL,
                run_id         TEXT    NOT NULL,
                op_kind        TEXT    NOT NULL,
                command        TEXT    NOT NULL,
                refs_json      TEXT    NOT NULL,
                settled_at_ms  INTEGER NOT NULL,
                anchor_msg_id  TEXT
             );
             INSERT INTO refs_runs_new
                (line_id, tug_session_id, run_id, op_kind, command, refs_json,
                 settled_at_ms, anchor_msg_id)
                SELECT tug_session_id, tug_session_id, run_id, op_kind, command,
                       refs_json, settled_at_ms, anchor_msg_id
                FROM refs_runs;
             DROP TABLE refs_runs;
             ALTER TABLE refs_runs_new RENAME TO refs_runs;
             COMMIT;",
        )?;
        Ok(())
    }

    fn migrate_add_anchor_msg_id(conn: &Connection) -> Result<(), RefsLedgerError> {
        let cols = crate::ledger_integrity::table_columns(conn, "main", "refs_runs")?;
        if cols.is_empty() || cols.iter().any(|c| c == "anchor_msg_id") {
            return Ok(());
        }
        match conn.execute("ALTER TABLE refs_runs ADD COLUMN anchor_msg_id TEXT", []) {
            Ok(_) => Ok(()),
            Err(err) if crate::ledger_integrity::is_duplicate_column(&err) => Ok(()),
            Err(err) => Err(err.into()),
        }
    }

    /// Record a completed run, replacing this session's previous one.
    pub fn record_run(&self, run: &NewRefsRun) -> Result<(), RefsLedgerError> {
        let refs_json = serde_json::to_string(&run.refs)?;
        let conn = self.db.lock().expect("refs ledger mutex");
        conn.execute(
            "INSERT INTO refs_runs
                (line_id, tug_session_id, run_id, op_kind, command, refs_json, settled_at_ms, anchor_msg_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(line_id) DO UPDATE SET
                tug_session_id = excluded.tug_session_id,
                run_id = excluded.run_id,
                op_kind = excluded.op_kind,
                command = excluded.command,
                refs_json = excluded.refs_json,
                settled_at_ms = excluded.settled_at_ms,
                anchor_msg_id = excluded.anchor_msg_id",
            params![
                run.line_id,
                run.tug_session_id,
                run.run_id,
                run.op_kind,
                run.command,
                refs_json,
                run.settled_at_ms,
                run.anchor_msg_id,
            ],
        )?;
        Ok(())
    }

    /// Session ids whose run still carries the placeholder key its migration
    /// wrote — the pre-lines shape [`crate::ink_backfill::assign_lines`]
    /// resolves ([P09]).
    pub fn sessions_awaiting_a_line(&self) -> Result<Vec<String>, RefsLedgerError> {
        let conn = self.db.lock().expect("refs ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT tug_session_id FROM refs_runs
             WHERE line_id = tug_session_id ORDER BY settled_at_ms ASC, tug_session_id ASC",
        )?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    }

    /// Record which line a segment's run belongs to.
    ///
    /// Two segments of one line each hold a run, and the line holds one — so
    /// this reconciles rather than moves: the newer `settled_at_ms` survives
    /// and the older is dropped. That is the table's existing semantics, not a
    /// new kind of loss; `record_run` already replaces a line's previous run
    /// outright, because one run per line is what makes `/ref N` definite.
    ///
    /// Returns how many rows it named (0 or 1).
    pub fn assign_line(&self, session_id: &str, line_id: &str) -> Result<usize, RefsLedgerError> {
        if session_id == line_id {
            // The placeholder already reads as this line; nothing to reconcile
            // and nothing to say.
            return Ok(0);
        }
        let mut conn = self.db.lock().expect("refs ledger mutex");
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let settled_at = |key: &str| -> Result<Option<i64>, rusqlite::Error> {
            tx.query_row(
                "SELECT settled_at_ms FROM refs_runs WHERE line_id = ?1",
                params![key],
                |row| row.get::<_, i64>(0),
            )
            .optional()
        };
        let Some(source) = settled_at(session_id)? else {
            return Ok(0);
        };
        match settled_at(line_id)? {
            // The line already holds a newer run: this one loses.
            Some(existing) if existing >= source => {
                tx.execute(
                    "DELETE FROM refs_runs WHERE line_id = ?1",
                    params![session_id],
                )?;
            }
            _ => {
                tx.execute("DELETE FROM refs_runs WHERE line_id = ?1", params![line_id])?;
                tx.execute(
                    "UPDATE refs_runs SET line_id = ?2 WHERE line_id = ?1",
                    params![session_id, line_id],
                )?;
            }
        }
        tx.commit()?;
        Ok(1)
    }

    /// Whether the named one-time pass has already run against this ledger.
    pub fn backfill_done(&self, name: &str) -> Result<bool, RefsLedgerError> {
        let conn = self.db.lock().expect("refs ledger mutex");
        let done = conn
            .query_row(
                "SELECT 1 FROM backfills WHERE name = ?1",
                params![name],
                |_| Ok(()),
            )
            .optional()?;
        Ok(done.is_some())
    }

    /// Record that the named one-time pass has run.
    pub fn mark_backfill(&self, name: &str, now_ms: i64) -> Result<(), RefsLedgerError> {
        let conn = self.db.lock().expect("refs ledger mutex");
        conn.execute(
            "INSERT OR REPLACE INTO backfills (name, done_at_ms) VALUES (?1, ?2)",
            params![name, now_ms],
        )?;
        Ok(())
    }

    /// Every anchored run: the line, the segment that ran it, when, and the
    /// anchor it carries. The repair's read.
    pub fn anchored_runs(&self) -> Result<Vec<AnchoredRefsRun>, RefsLedgerError> {
        let conn = self.db.lock().expect("refs ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT line_id, tug_session_id, settled_at_ms, anchor_msg_id
             FROM refs_runs
             WHERE anchor_msg_id IS NOT NULL AND line_id != tug_session_id
             ORDER BY settled_at_ms ASC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(AnchoredRefsRun {
                    line_id: row.get(0)?,
                    tug_session_id: row.get(1)?,
                    at_ms: row.get(2)?,
                    anchor_msg_id: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Rewrite a line's run anchor. Returns how many rows it touched (0 or 1).
    pub fn set_anchor(&self, line_id: &str, anchor_msg_id: &str) -> Result<usize, RefsLedgerError> {
        let conn = self.db.lock().expect("refs ledger mutex");
        let moved = conn.execute(
            "UPDATE refs_runs SET anchor_msg_id = ?2 WHERE line_id = ?1",
            params![line_id, anchor_msg_id],
        )?;
        Ok(moved)
    }

    /// The line's latest run, or `None` if it has never completed one.
    pub fn list_refs(&self, line_id: &str) -> Result<Option<RefsRunRow>, RefsLedgerError> {
        let conn = self.db.lock().expect("refs ledger mutex");
        let row = conn
            .query_row(
                "SELECT run_id, op_kind, command, refs_json, settled_at_ms, anchor_msg_id
                 FROM refs_runs WHERE line_id = ?1",
                params![line_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((run_id, op_kind, command, refs_json, settled_at_ms, anchor_msg_id)) = row else {
            return Ok(None);
        };
        Ok(Some(RefsRunRow {
            run_id,
            op_kind,
            command,
            // A row whose payload no longer parses is a row from a shape
            // that has since changed; an empty list restores nothing rather
            // than failing the whole read.
            refs: serde_json::from_str(&refs_json).unwrap_or_default(),
            settled_at_ms,
            anchor_msg_id,
        }))
    }
}

// ── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn run(session: &str, run_id: &str, paths: &[&str]) -> NewRefsRun {
        NewRefsRun {
            tug_session_id: session.into(),
            line_id: session.into(),
            run_id: run_id.into(),
            op_kind: "match".into(),
            command: format!("/match {run_id}"),
            refs: paths
                .iter()
                .enumerate()
                .map(|(i, path)| TextRef::filename(i as u32 + 1, *path))
                .collect(),
            settled_at_ms: 1_700_000_000_000,
            anchor_msg_id: None,
        }
    }

    #[test]
    fn a_new_run_clobbers_the_previous_one() {
        let ledger = RefsLedger::open_in_memory().unwrap();
        ledger
            .record_run(&run("s1", "run-1", &["a.ts", "b.ts"]))
            .unwrap();
        ledger.record_run(&run("s1", "run-2", &["c.ts"])).unwrap();

        let latest = ledger.list_refs("s1").unwrap().unwrap();
        assert_eq!(latest.run_id, "run-2");
        assert_eq!(latest.command, "/match run-2");
        assert_eq!(
            latest
                .refs
                .iter()
                .map(|r| r.path.as_str())
                .collect::<Vec<&str>>(),
            vec!["c.ts"],
        );
    }

    #[test]
    fn sessions_do_not_disturb_each_other() {
        let ledger = RefsLedger::open_in_memory().unwrap();
        ledger.record_run(&run("s1", "run-1", &["a.ts"])).unwrap();
        ledger.record_run(&run("s2", "run-2", &["b.ts"])).unwrap();
        ledger.record_run(&run("s1", "run-3", &["c.ts"])).unwrap();

        assert_eq!(ledger.list_refs("s2").unwrap().unwrap().run_id, "run-2");
        assert_eq!(ledger.list_refs("s1").unwrap().unwrap().run_id, "run-3");
    }

    #[test]
    fn a_session_with_no_run_reads_as_nothing() {
        let ledger = RefsLedger::open_in_memory().unwrap();
        assert!(ledger.list_refs("never-searched").unwrap().is_none());
    }

    #[test]
    fn content_refs_round_trip_through_storage() {
        let ledger = RefsLedger::open_in_memory().unwrap();
        let stored = NewRefsRun {
            tug_session_id: "s1".into(),
            line_id: "s1".into(),
            run_id: "run-1".into(),
            op_kind: "search".into(),
            command: "/search héllo".into(),
            refs: vec![TextRef::content(
                1,
                "src/a.ts",
                12,
                vec![(2, 7), (9, 14)],
                crate::feeds::text_ref::LinePreview::whole("  héllo and héllo"),
            )],
            settled_at_ms: 42,
            anchor_msg_id: None,
        };
        ledger.record_run(&stored).unwrap();

        let latest = ledger.list_refs("s1").unwrap().unwrap();
        assert_eq!(latest.refs, stored.refs);
        assert_eq!(latest.op_kind, "search");
        assert_eq!(latest.settled_at_ms, 42);
    }

    // ── the backfill gathers a line's run under one key ──────────────────────

    fn run_settled(session: &str, run_id: &str, settled_at_ms: i64) -> NewRefsRun {
        NewRefsRun {
            settled_at_ms,
            ..run(session, run_id, &["src/a.ts"])
        }
    }

    #[test]
    fn assigning_a_line_to_an_unclaimed_one_is_a_plain_move() {
        let ledger = RefsLedger::open_in_memory().unwrap();
        ledger
            .record_run(&run("parent", "run-1", &["src/a.ts"]))
            .unwrap();

        assert_eq!(ledger.assign_line("parent", "line-1").unwrap(), 1);
        assert_eq!(ledger.list_refs("parent").unwrap(), None);
        assert_eq!(ledger.list_refs("line-1").unwrap().unwrap().run_id, "run-1");
    }

    #[test]
    fn two_segments_of_one_line_keep_the_newer_run() {
        // `line_id` is the primary key and a line holds one run, so this is
        // the case a bare UPDATE would fail on — and the reconciliation is the
        // table's existing "one run per line" rule, not a new kind of loss.
        let ledger = RefsLedger::open_in_memory().unwrap();
        ledger
            .record_run(&run_settled("parent", "older", 100))
            .unwrap();
        ledger
            .record_run(&run_settled("fork", "newer", 200))
            .unwrap();

        ledger.assign_line("fork", "line-1").unwrap();
        assert_eq!(ledger.assign_line("parent", "line-1").unwrap(), 1);
        assert_eq!(ledger.list_refs("parent").unwrap(), None);
        assert_eq!(ledger.list_refs("line-1").unwrap().unwrap().run_id, "newer");
    }

    #[test]
    fn the_newer_run_displaces_one_the_line_already_holds() {
        let ledger = RefsLedger::open_in_memory().unwrap();
        ledger
            .record_run(&run_settled("parent", "newer", 200))
            .unwrap();
        ledger
            .record_run(&run_settled("fork", "older", 100))
            .unwrap();

        ledger.assign_line("fork", "line-1").unwrap();
        assert_eq!(ledger.assign_line("parent", "line-1").unwrap(), 1);
        assert_eq!(ledger.list_refs("line-1").unwrap().unwrap().run_id, "newer");
    }

    #[test]
    fn assigning_a_line_is_idempotent_and_never_self_collides() {
        let ledger = RefsLedger::open_in_memory().unwrap();
        ledger
            .record_run(&run("parent", "run-1", &["src/a.ts"]))
            .unwrap();

        assert_eq!(
            ledger.assign_line("parent", "parent").unwrap(),
            0,
            "the placeholder already reads as this line"
        );
        assert_eq!(ledger.list_refs("parent").unwrap().unwrap().run_id, "run-1");

        ledger.assign_line("parent", "line-1").unwrap();
        assert_eq!(
            ledger.assign_line("parent", "line-1").unwrap(),
            0,
            "a second boot finds nothing left to resolve"
        );
        assert_eq!(ledger.list_refs("line-1").unwrap().unwrap().run_id, "run-1");
    }

    // ── the anchor column ────────────────────────────────────────────────────

    /// The DDL as it stood before `anchor_msg_id` — what a database written by
    /// the previous binary actually contains.
    const PRE_ANCHOR_DDL: &str = "
        CREATE TABLE IF NOT EXISTS refs_runs (
            tug_session_id TEXT    PRIMARY KEY,
            run_id         TEXT    NOT NULL,
            op_kind        TEXT    NOT NULL,
            command        TEXT    NOT NULL,
            refs_json      TEXT    NOT NULL,
            settled_at_ms  INTEGER NOT NULL
        );
    ";

    fn anchored(session: &str, run_id: &str, anchor: &str) -> NewRefsRun {
        NewRefsRun {
            anchor_msg_id: Some(anchor.to_string()),
            ..run(session, run_id, &["src/a.ts"])
        }
    }

    #[test]
    fn an_anchor_round_trips_and_a_replacing_run_overwrites_it() {
        let ledger = RefsLedger::open_in_memory().unwrap();
        ledger
            .record_run(&anchored("s1", "run-1", "msg_01OLD"))
            .unwrap();
        assert_eq!(
            ledger
                .list_refs("s1")
                .unwrap()
                .unwrap()
                .anchor_msg_id
                .as_deref(),
            Some("msg_01OLD"),
        );

        // One run per session: the replacement's anchor is the one that stands.
        ledger
            .record_run(&anchored("s1", "run-2", "msg_01NEW"))
            .unwrap();
        assert_eq!(
            ledger
                .list_refs("s1")
                .unwrap()
                .unwrap()
                .anchor_msg_id
                .as_deref(),
            Some("msg_01NEW"),
        );

        // And an unanchored replacement clears it rather than leaving a stale
        // anchor pointing at a turn this run does not follow.
        ledger
            .record_run(&run("s1", "run-3", &["src/a.ts"]))
            .unwrap();
        assert_eq!(ledger.list_refs("s1").unwrap().unwrap().anchor_msg_id, None);
    }

    #[test]
    fn a_pre_anchor_database_is_migrated_and_its_row_reads_null() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("refs.db");

        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(PRE_ANCHOR_DDL).unwrap();
            conn.execute(
                "INSERT INTO refs_runs
                    (tug_session_id, run_id, op_kind, command, refs_json, settled_at_ms)
                 VALUES ('s1', 'run-legacy', 'match', '/match foo', '[]', 5)",
                [],
            )
            .unwrap();
        }

        let ledger = RefsLedger::open(&path).unwrap();
        let row = ledger.list_refs("s1").unwrap().unwrap();
        assert_eq!(row.run_id, "run-legacy");
        assert_eq!(row.anchor_msg_id, None);

        ledger
            .record_run(&anchored("s2", "run-new", "msg_01NEW"))
            .unwrap();
        assert_eq!(
            ledger
                .list_refs("s2")
                .unwrap()
                .unwrap()
                .anchor_msg_id
                .as_deref(),
            Some("msg_01NEW"),
        );
    }

    #[test]
    fn the_anchor_migration_is_a_no_op_on_reopen() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("refs.db");

        let ledger = RefsLedger::open(&path).unwrap();
        ledger
            .record_run(&anchored("s1", "run-1", "msg_01KEEP"))
            .unwrap();
        drop(ledger);

        let ledger = RefsLedger::open(&path).unwrap();
        assert_eq!(
            ledger
                .list_refs("s1")
                .unwrap()
                .unwrap()
                .anchor_msg_id
                .as_deref(),
            Some("msg_01KEEP"),
        );
    }
}
