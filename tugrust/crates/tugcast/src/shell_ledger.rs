//! ShellLedger — sqlite-backed persistence for shell-route exchanges.
//!
//! Each settled `$`-route command/output exchange is recorded here, keyed by
//! `tug_session_id`. The deck fetches a session's tail on restore via the
//! `list_shell_exchanges` CONTROL read so a Maker ▸ Reload (or app
//! relaunch) can reconstruct the transcript's shell rows — the *record* is
//! durable even though the live shell child is not ([Q04], [P07]).
//!
//! Its own sqlite file, separate from `sessions.db`: the two stores have
//! unrelated lifecycles (the session ledger tracks claude sessions; this
//! tracks shell output), and a corrupt shell db must never take the session
//! ledger down. Writes serialize through a single `Mutex<Connection>`.
//!
//! Only *settled* exchanges are recorded (insert-on-`exchange_complete`); an
//! exchange in flight at a crash is lost, which matches the "record of what
//! happened" doctrine — it never settled. Per session the table is capped at
//! [`MAX_EXCHANGES_PER_SESSION`]; the oldest rows past the cap are evicted on
//! insert (logged, not silent). The cap bounds chatter only — a landing
//! receipt ([`LANDING_RECEIPT_COMMANDS`]) is never evicted.

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use rusqlite::{Connection, params};
use serde::Serialize;
use tracing::warn;

/// Per-session row cap on **chatter**. Human-typed command volume is modest;
/// the tail is what the transcript needs, so old `$` exchanges age out.
///
/// Landing receipts are exempt and are neither counted against the cap nor
/// evicted by it — see [`LANDING_RECEIPT_COMMANDS`].
pub const MAX_EXCHANGES_PER_SESSION: usize = 500;

/// The `command` values a landing writes: a `/commit`, `/arc-join`, or
/// `/arc-discard` receipt.
///
/// A receipt is the user's act rather than session chatter ([D111]), and it is
/// the only record of that act the transcript will ever hold — Claude's JSONL
/// never sees one. So the cap above does not apply to it: a line of work whose
/// ink was merged from a fork could otherwise cross the cap on its next `$`
/// command and evict, oldest-first, exactly the historical receipts that merge
/// existed to rescue.
///
/// The exemption is matched by **exact equality** against the recorded
/// command, and the writers record the bare verb — `use-landing-receipts.ts`
/// appends `"/arc-join"`, `agent_supervisor.rs` records `"/arc-join"` — so no
/// prefix form belongs here.
///
/// The last three entries are **read-only** spellings nothing writes any more:
/// `/dash-join` before the join's rename, and `/dash-discard` and
/// `/dash-release` before the discard's two renames. Rows carrying them are
/// already on disk, and a receipt that loses
/// its exemption is a receipt the next `$` command can evict. A spelling that
/// ever reached a durable ledger stays a read spelling for life; see
/// `tuglaws/work-grammar.md`'s "Retired names".
pub const LANDING_RECEIPT_COMMANDS: [&str; 6] = [
    "/commit",
    "/arc-join",
    "/arc-discard",
    "/dash-discard",
    "/dash-join",
    "/dash-release",
];

/// `LANDING_RECEIPT_COMMANDS` as a SQL value list, so the eviction predicate
/// and the constant above cannot drift apart.
static RECEIPT_COMMANDS_SQL: LazyLock<String> = LazyLock::new(|| {
    LANDING_RECEIPT_COMMANDS
        .map(|command| format!("'{command}'"))
        .join(", ")
});

#[derive(Debug, thiserror::Error)]
pub enum ShellLedgerError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

/// A settled exchange to record. `tug_session_id` is the routing key; the
/// per-session `seq` is assigned on insert (monotonic within a session).
#[derive(Debug, Clone)]
pub struct NewShellExchange {
    pub tug_session_id: String,
    /// The **line of work** this exchange belongs to ([P09]). Receipts and
    /// search history are the conversation's, so they are keyed by the line
    /// and every segment of it reads them back — which is what retired the
    /// adoption passes that used to chase them from one id to the next.
    pub line_id: String,
    pub command: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub cwd: String,
    pub cwd_after: Option<String>,
    pub started_at_ms: i64,
    pub settled_at_ms: i64,
    /// The Claude assistant `message.id` this row follows in the transcript,
    /// stamped at the write gateway. `None` for a row written before the
    /// anchor column existed, or by a session whose JSONL holds no assistant
    /// line yet; such a row restores by timestamp, as every row once did.
    pub anchor_msg_id: Option<String>,
}

/// A persisted exchange row, serialized into the `list_shell_exchanges_ok`
/// CONTROL response. The deck maps these onto its `ShellExchangeMessage`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShellExchangeRow {
    pub id: i64,
    pub tug_session_id: String,
    /// The line this row belongs to ([P09]).
    pub line_id: String,
    pub seq: i64,
    pub command: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub cwd: String,
    pub cwd_after: Option<String>,
    pub started_at_ms: i64,
    pub settled_at_ms: i64,
    pub anchor_msg_id: Option<String>,
}

/// One session's ink holdings, as `GET /api/ink-census` reports them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InkCensusRow {
    pub tug_session_id: String,
    pub rows: i64,
    pub max_seq: i64,
    pub first_settled_at_ms: Option<i64>,
    pub last_settled_at_ms: Option<i64>,
}

pub struct ShellLedger {
    db: Mutex<Connection>,
}

impl ShellLedger {
    /// Default db path: alongside `sessions.db` (per-instance when
    /// `TUG_INSTANCE_ID` is set), named `shell_exchanges.db`.
    pub fn default_path() -> Option<PathBuf> {
        let sessions = crate::session_ledger::SessionLedger::default_path()?;
        Some(sessions.with_file_name("shell_exchanges.db"))
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, ShellLedgerError> {
        // Integrity gate: quarantine a corrupt file and salvage readable
        // rows into the fresh one (see `ledger_integrity`).
        let gate = crate::ledger_integrity::integrity_gate(path.as_ref(), "shell");
        let conn = tugcore::ledger_db::open(path)?;
        let ledger = Self::from_conn(conn)?;
        if let crate::ledger_integrity::GateOutcome::Quarantined { corrupt_path } = &gate {
            let db = ledger.db.lock().expect("shell ledger poisoned");
            crate::ledger_integrity::salvage_into(
                &db,
                "main",
                corrupt_path,
                &["shell_exchanges"],
                "shell",
            );
        }
        Ok(ledger)
    }

    /// In-memory ledger for tests.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn open_in_memory() -> Result<Self, ShellLedgerError> {
        let conn = Connection::open_in_memory()?;
        Self::from_conn(conn)
    }

    fn from_conn(conn: Connection) -> Result<Self, ShellLedgerError> {
        tugcore::ledger_db::apply_pragmas(&conn)?;
        Self::migrate_add_anchor_msg_id(&conn)?;
        Self::migrate_add_line_id(&conn)?;
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS shell_exchanges (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                tug_session_id TEXT    NOT NULL,
                -- The line this row belongs to ([P09]). `tug_session_id`
                -- stays beside it as the transcript anchor: which segment
                -- wrote the row is a real fact, and privacy is enforced on it.
                line_id        TEXT    NOT NULL DEFAULT '',
                seq            INTEGER NOT NULL,
                command        TEXT    NOT NULL,
                output         TEXT    NOT NULL,
                exit_code      INTEGER,
                cwd            TEXT    NOT NULL,
                cwd_after      TEXT,
                started_at_ms  INTEGER NOT NULL,
                settled_at_ms  INTEGER NOT NULL,
                anchor_msg_id  TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_shell_exchanges_line
                ON shell_exchanges(line_id, id);
            ",
        )?;
        Ok(Self {
            db: Mutex::new(conn),
        })
    }

    /// Self-healing add of `anchor_msg_id`.
    ///
    /// Runs before the DDL batch so an existing table is widened before
    /// anything reads it; a database that has no `shell_exchanges` table yet
    /// returns early and gets the column from `CREATE TABLE` instead.
    /// Self-healing add of `line_id` ([P09]).
    ///
    /// Pre-lines rows land with `''`, which matches no line and reads as
    /// nothing until `ink_backfill::assign_lines` fills them in — the one
    /// place that can, because this ledger cannot see `sessions.db`.
    fn migrate_add_line_id(conn: &Connection) -> Result<(), ShellLedgerError> {
        let cols = crate::ledger_integrity::table_columns(conn, "main", "shell_exchanges")?;
        if cols.is_empty() || cols.iter().any(|c| c == "line_id") {
            return Ok(());
        }
        match conn.execute(
            "ALTER TABLE shell_exchanges ADD COLUMN line_id TEXT NOT NULL DEFAULT ''",
            [],
        ) {
            Ok(_) => Ok(()),
            Err(err) if crate::ledger_integrity::is_duplicate_column(&err) => Ok(()),
            Err(err) => Err(err.into()),
        }
    }

    fn migrate_add_anchor_msg_id(conn: &Connection) -> Result<(), ShellLedgerError> {
        let cols = crate::ledger_integrity::table_columns(conn, "main", "shell_exchanges")?;
        if cols.is_empty() || cols.iter().any(|c| c == "anchor_msg_id") {
            return Ok(());
        }
        match conn.execute(
            "ALTER TABLE shell_exchanges ADD COLUMN anchor_msg_id TEXT",
            [],
        ) {
            Ok(_) => Ok(()),
            Err(err) if crate::ledger_integrity::is_duplicate_column(&err) => Ok(()),
            Err(err) => Err(err.into()),
        }
    }

    /// Record a settled exchange, assigning the next per-**line** `seq`, then
    /// evict the oldest rows past the per-session cap (logged).
    ///
    /// Returns the new row's `id` — the identity a restore replays it under.
    /// A landing receipt's live append rides that id back to the deck so the
    /// live copy and the restored copy of one landing are one transcript turn
    /// rather than two.
    pub fn record_exchange(&self, ex: &NewShellExchange) -> Result<i64, ShellLedgerError> {
        let conn = self.db.lock().expect("shell ledger mutex");
        let seq: i64 = conn.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM shell_exchanges WHERE line_id = ?1",
            params![ex.line_id],
            |row| row.get(0),
        )?;
        conn.execute(
            "INSERT INTO shell_exchanges
                (tug_session_id, line_id, seq, command, output, exit_code, cwd, cwd_after, started_at_ms, settled_at_ms, anchor_msg_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                ex.tug_session_id,
                ex.line_id,
                seq,
                ex.command,
                ex.output,
                ex.exit_code,
                ex.cwd,
                ex.cwd_after,
                ex.started_at_ms,
                ex.settled_at_ms,
                ex.anchor_msg_id,
            ],
        )?;
        let id = conn.last_insert_rowid();
        // Cap eviction: delete the oldest chatter rows beyond the cap for this
        // session. Landing receipts sit outside the predicate on both sides —
        // they neither fill the retained window nor become eviction
        // candidates.
        let receipts = &*RECEIPT_COMMANDS_SQL;
        let evicted = conn.execute(
            &format!(
                "DELETE FROM shell_exchanges
                 WHERE tug_session_id = ?1
                   AND command NOT IN ({receipts})
                   AND id NOT IN (
                       SELECT id FROM shell_exchanges
                       WHERE tug_session_id = ?1
                         AND command NOT IN ({receipts})
                       ORDER BY id DESC LIMIT ?2
                   )"
            ),
            params![ex.tug_session_id, MAX_EXCHANGES_PER_SESSION as i64],
        )?;
        if evicted > 0 {
            warn!(
                session = %ex.tug_session_id,
                evicted,
                cap = MAX_EXCHANGES_PER_SESSION,
                "shell ledger: evicted oldest exchanges past the per-session cap",
            );
        }
        Ok(id)
    }

    /// Distinct lines that currently own at least one exchange, for tests in
    /// other modules that drive a write gateway and need to see which line it
    /// keyed the row under.
    #[cfg(test)]
    pub fn lines_with_rows(&self) -> Result<std::collections::HashSet<String>, ShellLedgerError> {
        let conn = self.db.lock().expect("shell ledger mutex");
        let mut stmt = conn.prepare("SELECT DISTINCT line_id FROM shell_exchanges")?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<std::collections::HashSet<_>, _>>()?;
        Ok(ids)
    }

    /// Distinct session ids on rows that have no line yet — the pre-lines
    /// shape [`crate::ink_backfill::assign_lines`] resolves ([P09]).
    pub fn sessions_awaiting_a_line(&self) -> Result<Vec<String>, ShellLedgerError> {
        let conn = self.db.lock().expect("shell ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT DISTINCT tug_session_id FROM shell_exchanges
             WHERE line_id = '' ORDER BY tug_session_id",
        )?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    }

    /// Record which line a segment's line-less rows belong to. Returns how
    /// many rows it named. Touches only rows still carrying the placeholder,
    /// so it can never re-key a row that already knows its line.
    pub fn assign_line(&self, session_id: &str, line_id: &str) -> Result<usize, ShellLedgerError> {
        let conn = self.db.lock().expect("shell ledger mutex");
        let moved = conn.execute(
            "UPDATE shell_exchanges SET line_id = ?2
             WHERE tug_session_id = ?1 AND line_id = ''",
            params![session_id, line_id],
        )?;
        Ok(moved)
    }

    /// Exchanges matching a filter, newest-first — the read behind the
    /// Operator's `shell.history` verb.
    ///
    /// `query` is a substring match on the command text, not full text: a `$`
    /// command is a short line of shell, so "which invocation of `just` was
    /// that" is a containment question rather than a relevance one. Session and
    /// time bounds are all optional; with none of them this is the machine's
    /// recent command history.
    ///
    /// `exclude_sessions` drops whole sessions from the answer — the privacy
    /// exclusion, carried in rather than expressed in SQL because `sessions`
    /// lives in another database. It rides the query, not a filter over the
    /// result, so a private session's commands cannot consume the `limit` and
    /// push public ones off the end of the page.
    pub fn search_exchanges(
        &self,
        line_id: Option<&str>,
        query: Option<&str>,
        since_ms: Option<i64>,
        until_ms: Option<i64>,
        exclude_sessions: &[String],
        limit: usize,
    ) -> Result<Vec<ShellExchangeRow>, ShellLedgerError> {
        use rusqlite::types::Value as SqlValue;

        let mut sql = String::from(
            "SELECT id, tug_session_id, line_id, seq, command, output, exit_code, cwd, cwd_after,
                    started_at_ms, settled_at_ms, anchor_msg_id
             FROM shell_exchanges
             WHERE (?1 IS NULL OR line_id = ?1)
               AND (?2 IS NULL OR command LIKE ?2 ESCAPE '\\')
               AND (?3 IS NULL OR settled_at_ms >= ?3)
               AND (?4 IS NULL OR settled_at_ms <= ?4)",
        );
        if !exclude_sessions.is_empty() {
            sql.push_str(" AND tug_session_id NOT IN (");
            for i in 0..exclude_sessions.len() {
                if i > 0 {
                    sql.push(',');
                }
                // Placeholders only — the ids themselves are bound below.
                sql.push_str(&format!("?{}", i + 6));
            }
            sql.push(')');
        }
        sql.push_str(
            " ORDER BY settled_at_ms DESC, id DESC
             LIMIT ?5",
        );

        let mut binds: Vec<SqlValue> = vec![
            line_id.map_or(SqlValue::Null, |s| SqlValue::Text(s.to_owned())),
            query.map_or(SqlValue::Null, |q| SqlValue::Text(like_contains(q))),
            since_ms.map_or(SqlValue::Null, SqlValue::Integer),
            until_ms.map_or(SqlValue::Null, SqlValue::Integer),
            SqlValue::Integer(limit as i64),
        ];
        binds.extend(exclude_sessions.iter().cloned().map(SqlValue::Text));

        let conn = self.db.lock().expect("shell ledger mutex");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(binds), exchange_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// List a line's exchanges oldest-first (the transcript's natural order).
    ///
    /// `since_ms` bounds the read to exchanges that settled at or after it —
    /// the transcript's replay window, so restored ink rows describe the same
    /// span as the replayed Claude turns rather than an unbounded one.
    /// `None` reads the whole line.
    pub fn list_exchanges_since(
        &self,
        line_id: &str,
        since_ms: Option<i64>,
    ) -> Result<Vec<ShellExchangeRow>, ShellLedgerError> {
        let conn = self.db.lock().expect("shell ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT id, tug_session_id, line_id, seq, command, output, exit_code, cwd, cwd_after,
                    started_at_ms, settled_at_ms, anchor_msg_id
             FROM shell_exchanges
             WHERE line_id = ?1 AND (?2 IS NULL OR settled_at_ms >= ?2)
             ORDER BY id ASC",
        )?;
        let rows = stmt
            .query_map(params![line_id, since_ms], exchange_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Per-line ink census for `GET /api/ink-census` — rows, high-water
    /// `seq`, and the span they cover, newest activity first.
    ///
    /// The durability half of "why is this row not in my transcript". Pair it
    /// with the deck's own restore census and the two answer the question
    /// between them: rows here but not there is a restore fault; rows in
    /// neither is a write fault.
    pub fn ink_census(&self, only: Option<&str>) -> Result<Vec<InkCensusRow>, ShellLedgerError> {
        let conn = self.db.lock().expect("shell ledger mutex");
        let mut stmt = conn.prepare(
            "SELECT line_id, COUNT(*), COALESCE(MAX(seq), 0),
                    MIN(settled_at_ms), MAX(settled_at_ms)
             FROM shell_exchanges
             WHERE (?1 IS NULL OR line_id = ?1)
             GROUP BY line_id
             ORDER BY MAX(settled_at_ms) DESC",
        )?;
        let rows = stmt
            .query_map(params![only], |row| {
                Ok(InkCensusRow {
                    tug_session_id: row.get(0)?,
                    rows: row.get(1)?,
                    max_seq: row.get(2)?,
                    first_settled_at_ms: row.get(3)?,
                    last_settled_at_ms: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// How many rows the line holds in the same window, and its highest
    /// `seq` — the completeness pair the deck checks its answer against.
    ///
    /// Read on the same connection lock as the rows themselves would be, but
    /// as a separate statement: the client compares `exchanges.len()` to
    /// `total`, so a short answer (a truncated send, a mistimed request) is
    /// detectable rather than indistinguishable from an empty session.
    pub fn exchange_census(
        &self,
        line_id: &str,
        since_ms: Option<i64>,
    ) -> Result<(i64, i64), ShellLedgerError> {
        let conn = self.db.lock().expect("shell ledger mutex");
        let census = conn.query_row(
            "SELECT COUNT(*), COALESCE(MAX(seq), 0)
             FROM shell_exchanges
             WHERE line_id = ?1 AND (?2 IS NULL OR settled_at_ms >= ?2)",
            params![line_id, since_ms],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(census)
    }
}

/// A containment pattern for LIKE, with the caller's own text taken literally.
///
/// `%` and `_` are LIKE's wildcards, and a search string is data rather than a
/// pattern — `shell.history` promises a substring match, so a query for `100%`
/// must not quietly become "anything starting with 100". Escaping them (and the
/// escape character itself) keeps the promise; the statement pairs this with
/// `ESCAPE '\'`.
fn like_contains(query: &str) -> String {
    let mut pattern = String::with_capacity(query.len() + 2);
    pattern.push('%');
    for ch in query.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(ch);
    }
    pattern.push('%');
    pattern
}

/// Decode one `shell_exchanges` row. The column order matches both reads.
fn exchange_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ShellExchangeRow> {
    Ok(ShellExchangeRow {
        id: row.get(0)?,
        tug_session_id: row.get(1)?,
        line_id: row.get(2)?,
        seq: row.get(3)?,
        command: row.get(4)?,
        output: row.get(5)?,
        exit_code: row.get(6)?,
        cwd: row.get(7)?,
        cwd_after: row.get(8)?,
        started_at_ms: row.get(9)?,
        settled_at_ms: row.get(10)?,
        anchor_msg_id: row.get(11)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ex(sid: &str, cmd: &str, code: Option<i32>) -> NewShellExchange {
        NewShellExchange {
            tug_session_id: sid.to_string(),
            line_id: sid.to_string(),
            command: cmd.to_string(),
            output: format!("out:{cmd}\n"),
            exit_code: code,
            cwd: "/proj".to_string(),
            cwd_after: Some("/proj".to_string()),
            started_at_ms: 1000,
            settled_at_ms: 1012,
            anchor_msg_id: None,
        }
    }

    /// `ex` with an anchor stamped, for the ordering-fact tests.
    fn anchored(sid: &str, cmd: &str, anchor: &str) -> NewShellExchange {
        NewShellExchange {
            anchor_msg_id: Some(anchor.to_string()),
            ..ex(sid, cmd, Some(0))
        }
    }

    #[test]
    fn insert_and_list_round_trip_oldest_first() {
        let led = ShellLedger::open_in_memory().unwrap();
        led.record_exchange(&ex("s1", "echo a", Some(0))).unwrap();
        led.record_exchange(&ex("s1", "false", Some(1))).unwrap();
        let rows = led.list_exchanges_since("s1", None).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].command, "echo a");
        assert_eq!(rows[0].seq, 1);
        assert_eq!(rows[1].command, "false");
        assert_eq!(rows[1].seq, 2);
        assert_eq!(rows[1].exit_code, Some(1));
    }

    /// The completeness pair the deck checks its restore answer against. A
    /// short answer is only detectable if `total` is counted independently of
    /// the rows handed over — otherwise an empty array from a mistimed request
    /// reads exactly like a session that never ran a command.
    #[test]
    fn the_census_counts_rows_and_the_high_water_seq() {
        let led = ShellLedger::open_in_memory().unwrap();
        assert_eq!(led.exchange_census("s1", None).unwrap(), (0, 0));

        led.record_exchange(&ex("s1", "echo a", Some(0))).unwrap();
        led.record_exchange(&ex("s1", "echo b", Some(0))).unwrap();
        led.record_exchange(&ex("other", "echo c", Some(0)))
            .unwrap();

        let (total, max_seq) = led.exchange_census("s1", None).unwrap();
        assert_eq!(total, 2, "scoped to the session");
        assert_eq!(max_seq, 2);
        assert_eq!(
            led.list_exchanges_since("s1", None).unwrap().len() as i64,
            total,
            "the census and the rows must agree, or the deck cannot trust either",
        );
    }

    /// The window: ink rows restore over the same span the Claude turns
    /// replayed, so `since_ms` bounds rows and census alike. A census taken
    /// over a different window than the rows would make every windowed answer
    /// look short and retry forever.
    #[test]
    fn since_ms_bounds_the_rows_and_the_census_together() {
        let led = ShellLedger::open_in_memory().unwrap();
        let at = |cmd: &str, settled: i64| NewShellExchange {
            tug_session_id: "s1".to_string(),
            line_id: "s1".to_string(),
            command: cmd.to_string(),
            output: String::new(),
            exit_code: Some(0),
            cwd: "/proj".to_string(),
            cwd_after: None,
            started_at_ms: settled - 10,
            settled_at_ms: settled,
            anchor_msg_id: None,
        };
        led.record_exchange(&at("old", 1_000)).unwrap();
        led.record_exchange(&at("edge", 5_000)).unwrap();
        led.record_exchange(&at("new", 9_000)).unwrap();

        let rows = led.list_exchanges_since("s1", Some(5_000)).unwrap();
        let commands: Vec<&str> = rows.iter().map(|r| r.command.as_str()).collect();
        assert_eq!(commands, ["edge", "new"], "the bound is inclusive");

        let (total, max_seq) = led.exchange_census("s1", Some(5_000)).unwrap();
        assert_eq!(total, rows.len() as i64);
        assert_eq!(
            max_seq, 3,
            "seq stays the session's, not the window's index"
        );

        // Unbounded still sees everything — the window is the caller's choice.
        assert_eq!(led.exchange_census("s1", None).unwrap(), (3, 3));
    }

    /// `shell.history` promises a substring match, and LIKE's own wildcards
    /// are the one way a search string could quietly stop meaning itself.
    #[test]
    fn a_query_carrying_like_wildcards_matches_them_literally() {
        let led = ShellLedger::open_in_memory().unwrap();
        led.record_exchange(&ex("s1", "printf '100%% done'", Some(0)))
            .unwrap();
        led.record_exchange(&ex("s1", "printf '100 done'", Some(0)))
            .unwrap();
        led.record_exchange(&ex("s1", "git_status", Some(0)))
            .unwrap();
        led.record_exchange(&ex("s1", "git status", Some(0)))
            .unwrap();

        let percent = led
            .search_exchanges(None, Some("100%"), None, None, &[], 50)
            .unwrap();
        assert_eq!(percent.len(), 1, "`%` is a character, not a wildcard");
        assert!(percent[0].command.contains("100%"));

        let underscore = led
            .search_exchanges(None, Some("git_"), None, None, &[], 50)
            .unwrap();
        assert_eq!(underscore.len(), 1, "`_` is a character, not a wildcard");
        assert_eq!(underscore[0].command, "git_status");
    }

    /// The exclusion rides the query, so a private session cannot spend the
    /// row cap and push a public command off the end of the page.
    #[test]
    fn excluded_sessions_are_dropped_before_the_limit_not_after() {
        let led = ShellLedger::open_in_memory().unwrap();
        led.record_exchange(&ex("public", "the one public command", Some(0)))
            .unwrap();
        for i in 0..20 {
            let mut row = ex("private", &format!("secret {i}"), Some(0));
            // Newer than the public command, so an unfiltered page is all
            // private ones.
            row.settled_at_ms = 2_000 + i;
            led.record_exchange(&row).unwrap();
        }

        let page = led
            .search_exchanges(None, None, None, None, &["private".to_string()], 5)
            .unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].command, "the one public command");
        assert!(
            led.search_exchanges(None, None, None, None, &[], 5)
                .unwrap()
                .iter()
                .all(|row| row.tug_session_id == "private")
        );
    }
    #[test]
    fn null_exit_code_round_trips() {
        let led = ShellLedger::open_in_memory().unwrap();
        led.record_exchange(&ex("s1", "sleep 60", None)).unwrap();
        let rows = led.list_exchanges_since("s1", None).unwrap();
        assert_eq!(rows[0].exit_code, None);
    }

    #[test]
    fn per_session_isolation() {
        let led = ShellLedger::open_in_memory().unwrap();
        led.record_exchange(&ex("sa", "a1", Some(0))).unwrap();
        led.record_exchange(&ex("sb", "b1", Some(0))).unwrap();
        led.record_exchange(&ex("sa", "a2", Some(0))).unwrap();
        let a = led.list_exchanges_since("sa", None).unwrap();
        let b = led.list_exchanges_since("sb", None).unwrap();
        assert_eq!(a.len(), 2);
        assert_eq!(b.len(), 1);
        // Per-session seq is independent.
        assert_eq!(a[0].seq, 1);
        assert_eq!(a[1].seq, 2);
        assert_eq!(b[0].seq, 1);
    }

    #[test]
    fn cap_evicts_oldest() {
        let led = ShellLedger::open_in_memory().unwrap();
        for i in 0..(MAX_EXCHANGES_PER_SESSION + 5) {
            led.record_exchange(&ex("s1", &format!("cmd{i}"), Some(0)))
                .unwrap();
        }
        let rows = led.list_exchanges_since("s1", None).unwrap();
        assert_eq!(rows.len(), MAX_EXCHANGES_PER_SESSION);
        // The 5 oldest were evicted; the newest survive.
        assert_eq!(
            rows.last().unwrap().command,
            format!("cmd{}", MAX_EXCHANGES_PER_SESSION + 4)
        );
        assert_eq!(rows.first().unwrap().command, "cmd5");
    }

    #[test]
    fn the_cap_never_evicts_a_landing_receipt() {
        let led = ShellLedger::open_in_memory().unwrap();
        // The receipts go in first, where oldest-first eviction would reach
        // them, and the chatter that follows pushes the session well past the
        // cap.
        for command in LANDING_RECEIPT_COMMANDS {
            led.record_exchange(&ex("s1", command, Some(0))).unwrap();
        }
        for i in 0..(MAX_EXCHANGES_PER_SESSION + 20) {
            led.record_exchange(&ex("s1", &format!("cmd{i}"), Some(0)))
                .unwrap();
        }
        let rows = led.list_exchanges_since("s1", None).unwrap();
        for command in LANDING_RECEIPT_COMMANDS {
            assert!(
                rows.iter().any(|r| r.command == command),
                "receipt evicted: {command}"
            );
        }
        // The cap counts chatter alone, so the receipts are retained *beside*
        // a full window rather than inside it.
        let chatter = rows.iter().filter(|r| r.command.starts_with("cmd")).count();
        assert_eq!(chatter, MAX_EXCHANGES_PER_SESSION);
        assert_eq!(
            rows.len(),
            MAX_EXCHANGES_PER_SESSION + LANDING_RECEIPT_COMMANDS.len()
        );
    }

    #[test]
    fn a_session_of_receipts_alone_never_evicts() {
        let led = ShellLedger::open_in_memory().unwrap();
        let total = MAX_EXCHANGES_PER_SESSION + 10;
        for i in 0..total {
            let command = LANDING_RECEIPT_COMMANDS[i % LANDING_RECEIPT_COMMANDS.len()];
            led.record_exchange(&ex("s1", command, Some(0))).unwrap();
        }
        assert_eq!(led.list_exchanges_since("s1", None).unwrap().len(), total);
    }

    #[test]
    fn the_exemption_list_still_names_every_retired_landing_spelling() {
        // `the_cap_never_evicts_a_landing_receipt` iterates the constant, so it
        // covers whatever the constant happens to hold and would pass unchanged
        // over one that had silently lost a spelling. This is the assertion a
        // rename can fail: `/dash-join`, `/dash-discard`, and `/dash-release`
        // are read-only spellings whose rows are already on disk, and dropping
        // any of them turns every landing receipt already recorded under it
        // back into evictable chatter.
        assert!(LANDING_RECEIPT_COMMANDS.contains(&"/dash-join"));
        assert!(LANDING_RECEIPT_COMMANDS.contains(&"/dash-discard"));
        assert!(LANDING_RECEIPT_COMMANDS.contains(&"/dash-release"));
        // And the spelling the discard writes today.
        assert!(LANDING_RECEIPT_COMMANDS.contains(&"/arc-discard"));
        // And the eviction predicate derives from the constant rather than
        // repeating it — the drift this checks for is a second edit site, not a
        // second value.
        for command in LANDING_RECEIPT_COMMANDS {
            assert!(
                RECEIPT_COMMANDS_SQL.contains(&format!("'{command}'")),
                "eviction predicate does not name {command}"
            );
        }
    }

    // ── the anchor column ────────────────────────────────────────────────────

    /// The DDL as it stood before `anchor_msg_id` — what a database written by
    /// the previous binary actually contains.
    const PRE_ANCHOR_DDL: &str = "
        CREATE TABLE IF NOT EXISTS shell_exchanges (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            tug_session_id TEXT    NOT NULL,
            seq            INTEGER NOT NULL,
            command        TEXT    NOT NULL,
            output         TEXT    NOT NULL,
            exit_code      INTEGER,
            cwd            TEXT    NOT NULL,
            cwd_after      TEXT,
            started_at_ms  INTEGER NOT NULL,
            settled_at_ms  INTEGER NOT NULL
        );
    ";

    #[test]
    fn an_anchor_round_trips_through_both_reads() {
        let led = ShellLedger::open_in_memory().unwrap();
        led.record_exchange(&anchored("s1", "/arc-join", "msg_01ABC"))
            .unwrap();

        let listed = led.list_exchanges_since("s1", None).unwrap();
        assert_eq!(listed[0].anchor_msg_id.as_deref(), Some("msg_01ABC"));

        let searched = led
            .search_exchanges(Some("s1"), None, None, None, &[], 5)
            .unwrap();
        assert_eq!(searched[0].anchor_msg_id.as_deref(), Some("msg_01ABC"));
    }

    #[test]
    fn an_unanchored_row_reads_back_null() {
        let led = ShellLedger::open_in_memory().unwrap();
        led.record_exchange(&ex("s1", "ls", Some(0))).unwrap();
        assert_eq!(
            led.list_exchanges_since("s1", None).unwrap()[0].anchor_msg_id,
            None
        );
    }

    #[test]
    fn a_pre_lines_database_is_migrated_and_its_rows_await_a_line() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("shell_exchanges.db");

        // A database as the previous binary left it: old schema, one row.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(PRE_ANCHOR_DDL).unwrap();
            conn.execute(
                "INSERT INTO shell_exchanges
                    (tug_session_id, seq, command, output, exit_code, cwd, cwd_after,
                     started_at_ms, settled_at_ms)
                 VALUES ('s1', 1, '/commit', 'legacy', 0, '/proj', NULL, 1, 2)",
                [],
            )
            .unwrap();
        }

        let led = ShellLedger::open(&path).unwrap();
        // The legacy row survives, carrying the placeholder its migration
        // wrote: it has no line yet, and this ledger cannot see the one table
        // that could say which.
        assert_eq!(
            led.sessions_awaiting_a_line().unwrap(),
            vec!["s1".to_string()]
        );
        let rows = led.list_exchanges_since("", None).unwrap();
        assert_eq!(rows.len(), 1, "the legacy row survives the migration");
        assert_eq!(rows[0].command, "/commit");
        assert_eq!(rows[0].anchor_msg_id, None);

        // The backfill names its line, and from then on it reads back with
        // every other row the line holds.
        assert_eq!(led.assign_line("s1", "line-1").unwrap(), 1);
        led.record_exchange(&NewShellExchange {
            line_id: "line-1".to_string(),
            ..anchored("s1", "/arc-join", "msg_01NEW")
        })
        .unwrap();
        let rows = led.list_exchanges_since("line-1", None).unwrap();
        assert_eq!(
            rows.iter()
                .map(|r| r.anchor_msg_id.as_deref())
                .collect::<Vec<_>>(),
            vec![None, Some("msg_01NEW")],
        );
        assert!(led.sessions_awaiting_a_line().unwrap().is_empty());
    }

    #[test]
    fn the_anchor_migration_is_a_no_op_on_reopen() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("shell_exchanges.db");

        let led = ShellLedger::open(&path).unwrap();
        led.record_exchange(&anchored("s1", "/commit", "msg_01KEEP"))
            .unwrap();
        drop(led);

        // Reopening runs the migration again; it must find the column and
        // leave both the schema and the rows alone.
        let led = ShellLedger::open(&path).unwrap();
        let rows = led.list_exchanges_since("s1", None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].anchor_msg_id.as_deref(), Some("msg_01KEEP"));
    }
}
