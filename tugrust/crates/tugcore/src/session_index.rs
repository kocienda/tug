//! SessionIndex — the machine-wide index of where sessions live.
//!
//! One row per session **segment** (one claude session uuid), holding only
//! the facts needed to *find* that session from outside the instance that
//! owns it: its uuid, the line it belongs to, its callsign, the project
//! directory it was opened on, and the instance that recorded it. Nothing
//! about its state, its transcript, or its work.
//!
//! **Machine-global**, beside `changes.db` and `prompt_history.db` rather
//! than inside an instance directory
//! (`tugcore::instance::session_index_db_path`). That placement is the
//! whole feature: a session's real ledger, `sessions.db`, is per-instance,
//! and a callsign is unique only within one of those, so a reference to a
//! session recorded by another instance — or in a project this instance
//! has never opened — is unanswerable from inside. The index is what lets
//! a reference resolve to "elsewhere on this machine" instead of to
//! nothing. Instance isolation of `sessions.db` is untouched: this file
//! holds the finding facts and never the session's truth.
//!
//! It lives in tugcore, not tugcast, because tugtool reads it and cannot
//! link tugcast (a binary crate).
//!
//! **Writers are tugcast only**, at spawn, rename, auto-title, and trash,
//! and their writes are telemetry-grade: a failed index write is logged
//! and never fails the ledger operation it rides. **Readers open
//! read-only** — the free functions at the bottom of this module — and a
//! missing file, a missing table, or an unreadable row is an empty answer
//! rather than an error, because a machine that has never run a build
//! carrying this index is exactly the machine a reference may be asked
//! about.
//!
//! The schema is gated on `PRAGMA user_version` with a registered
//! migration list, the regime of `tugcast::prompt_ledger`: a schema change
//! adds a migration and bumps [`SESSION_INDEX_SCHEMA_VERSION`], never
//! edits the DDL alone.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, OpenFlags, params};

/// Current on-disk schema version, stamped into `PRAGMA user_version`.
pub const SESSION_INDEX_SCHEMA_VERSION: i64 = 1;

/// Registered migrations, each keyed by the on-disk version it upgrades
/// *from*. Every migration whose `from` is at or above the version found
/// on disk is applied in order.
const SESSION_INDEX_MIGRATIONS: &[(i64, &str)] = &[];

const CREATE_SESSION_INDEX_SQL: &str = "
    CREATE TABLE IF NOT EXISTS session_index (
        session_id    TEXT PRIMARY KEY,
        line_id       TEXT NOT NULL DEFAULT '',
        callsign      TEXT,
        project_dir   TEXT NOT NULL,
        project_leaf  TEXT NOT NULL,
        instance      TEXT NOT NULL,
        title         TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS session_index_callsign ON session_index(callsign);
";

/// The column list, spelled once so the reads and the row decoder cannot
/// drift apart in order.
const INDEX_COLUMNS: &str = "session_id, line_id, callsign, project_dir, project_leaf, \
     instance, title, created_at_ms, updated_at_ms";

#[derive(Debug, thiserror::Error)]
pub enum SessionIndexError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("session index schema on disk is v{on_disk}, newer than this build's v{supported}")]
    SchemaTooNew { on_disk: i64, supported: i64 },
}

/// One indexed session segment.
///
/// `project_leaf` is **derived, never supplied**: [`SessionIndex::upsert`]
/// computes it from `project_dir` and writes that, so a caller building an
/// entry to write can leave it empty. It is a field on the struct because
/// reads return it, and a reader wants the basename the callsign half of a
/// `<project>/<callsign>` reference is compared against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexEntry {
    /// Full claude session uuid, lowercase.
    pub session_id: String,
    /// The line of work this segment belongs to; empty when unknown.
    pub line_id: String,
    /// `lines.tag` — the callsign. `None` on a row recorded without one.
    pub callsign: Option<String>,
    /// The project directory, as the recording ledger held it.
    pub project_dir: String,
    /// Basename of `project_dir`, trailing `/` ignored. Derived by `upsert`.
    pub project_leaf: String,
    /// `TUG_INSTANCE_ID` of the recording instance, or `""` when unset.
    pub instance: String,
    /// User-given name, else the auto title, else `None`.
    pub title: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// Basename of a project directory, ignoring any trailing separators.
/// An empty or separator-only path has no leaf and yields `""`.
pub fn project_leaf_of(project_dir: &str) -> String {
    let trimmed = project_dir.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some((_, leaf)) => leaf.to_string(),
        None => trimmed.to_string(),
    }
}

/// Milliseconds since the Unix epoch — the clock index writers stamp with.
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A writable handle on the index. Held by tugcast; every other reader
/// goes through the read-only free functions below.
#[derive(Debug)]
pub struct SessionIndex {
    db: Mutex<Connection>,
}

impl SessionIndex {
    /// The machine-global index path.
    pub fn default_path() -> PathBuf {
        crate::instance::session_index_db_path()
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, SessionIndexError> {
        if let Some(dir) = path.as_ref().parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = crate::ledger_db::open(path)?;
        Self::from_conn(conn)
    }

    /// In-memory index for tests.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, SessionIndexError> {
        let conn = Connection::open_in_memory()?;
        Self::from_conn(conn)
    }

    fn from_conn(conn: Connection) -> Result<Self, SessionIndexError> {
        crate::ledger_db::apply_pragmas(&conn)?;
        // A version newer than this build means a newer instance owns the
        // shape: refuse the open rather than write rows against a schema
        // this build cannot describe. Callers treat an unopenable index as
        // absent, which costs a verdict its `elsewhere` arm and nothing
        // more.
        let on_disk: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if on_disk > SESSION_INDEX_SCHEMA_VERSION {
            return Err(SessionIndexError::SchemaTooNew {
                on_disk,
                supported: SESSION_INDEX_SCHEMA_VERSION,
            });
        }
        if on_disk > 0 && on_disk < SESSION_INDEX_SCHEMA_VERSION {
            for (from, sql) in SESSION_INDEX_MIGRATIONS {
                if *from >= on_disk {
                    conn.execute_batch(sql)?;
                }
            }
        }
        conn.execute_batch(CREATE_SESSION_INDEX_SQL)?;
        conn.pragma_update(None, "user_version", SESSION_INDEX_SCHEMA_VERSION)?;
        Ok(Self {
            db: Mutex::new(conn),
        })
    }

    /// Record a segment, or update the one already recorded under its uuid.
    ///
    /// An update keeps `created_at_ms` — when the segment was first seen is
    /// a fact about the past — and takes everything else from `entry`,
    /// because a rename, an auto-title, and a re-scan all arrive this way.
    /// `project_leaf` is computed here from `project_dir`, whatever the
    /// entry carries.
    pub fn upsert(&self, entry: &IndexEntry) -> Result<(), SessionIndexError> {
        let leaf = project_leaf_of(&entry.project_dir);
        let conn = self.db.lock().expect("session index mutex");
        conn.execute(
            "INSERT INTO session_index
                (session_id, line_id, callsign, project_dir, project_leaf,
                 instance, title, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(session_id) DO UPDATE SET
                line_id       = excluded.line_id,
                callsign      = excluded.callsign,
                project_dir   = excluded.project_dir,
                project_leaf  = excluded.project_leaf,
                instance      = excluded.instance,
                title         = excluded.title,
                updated_at_ms = excluded.updated_at_ms",
            params![
                entry.session_id,
                entry.line_id,
                entry.callsign,
                entry.project_dir,
                leaf,
                entry.instance,
                entry.title,
                entry.created_at_ms,
                entry.updated_at_ms,
            ],
        )?;
        Ok(())
    }

    /// Retitle every segment of one line. Scoped by `(instance, line_id)`
    /// because a line id is unique within the instance that minted it, and
    /// a bare `line_id` match could retitle a stranger's line.
    pub fn retitle_line(
        &self,
        instance: &str,
        line_id: &str,
        title: Option<&str>,
    ) -> Result<usize, SessionIndexError> {
        let conn = self.db.lock().expect("session index mutex");
        let touched = conn.execute(
            "UPDATE session_index SET title = ?3, updated_at_ms = ?4
             WHERE instance = ?1 AND line_id = ?2",
            params![instance, line_id, title, now_ms()],
        )?;
        Ok(touched)
    }

    /// Forget one segment. The only delete there is — trash is what calls
    /// it, and the index carries no retention policy.
    pub fn remove(&self, session_id: &str) -> Result<usize, SessionIndexError> {
        let conn = self.db.lock().expect("session index mutex");
        let removed = conn.execute(
            "DELETE FROM session_index WHERE session_id = ?1",
            params![session_id],
        )?;
        Ok(removed)
    }

    #[cfg(test)]
    fn all(&self) -> Vec<IndexEntry> {
        let conn = self.db.lock().expect("session index mutex");
        let sql = format!("SELECT {INDEX_COLUMNS} FROM session_index ORDER BY session_id");
        let mut stmt = conn.prepare(&sql).expect("prepare");
        stmt.query_map([], |r| Ok(decode(r)))
            .expect("query")
            .filter_map(|r| r.ok())
            .collect()
    }
}

fn decode(row: &rusqlite::Row<'_>) -> IndexEntry {
    IndexEntry {
        session_id: row.get(0).unwrap_or_default(),
        line_id: row.get(1).unwrap_or_default(),
        callsign: row.get(2).ok().flatten(),
        project_dir: row.get(3).unwrap_or_default(),
        project_leaf: row.get(4).unwrap_or_default(),
        instance: row.get(5).unwrap_or_default(),
        title: row.get(6).ok().flatten(),
        created_at_ms: row.get(7).unwrap_or_default(),
        updated_at_ms: row.get(8).unwrap_or_default(),
    }
}

/// Open the index read-only, or `None` when there is nothing to read.
///
/// Read-only is the contract for every reader outside tugcast: a second
/// writable connection on a shared WAL file is the failure neighborhood
/// `tugcore::ledger_db` exists to close, and nothing outside the recording
/// instance has business writing here. A file that does not exist yet is
/// not an error — it is the state of every machine before its first
/// session is recorded.
fn open_reader(path: &Path) -> Option<Connection> {
    if !path.exists() {
        return None;
    }
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()
}

fn query(path: &Path, sql: &str, args: &[&dyn rusqlite::ToSql]) -> Vec<IndexEntry> {
    let Some(conn) = open_reader(path) else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare(sql) else {
        // A missing table is an index written by a build that had none —
        // the same empty answer as a missing file.
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(args, |r| Ok(decode(r))) else {
        return Vec::new();
    };
    rows.filter_map(|r| r.ok()).collect()
}

/// The row for one full session uuid: at most one, by primary key.
pub fn lookup_uuid(path: &Path, uuid: &str) -> Vec<IndexEntry> {
    let sql = format!("SELECT {INDEX_COLUMNS} FROM session_index WHERE session_id = ?1");
    query(path, &sql, &[&uuid])
}

/// Every row whose uuid starts with `prefix` — the short-id arm, which is
/// ambiguous by construction and so answers with all of them.
pub fn lookup_prefix(path: &Path, prefix: &str) -> Vec<IndexEntry> {
    let sql = format!(
        "SELECT {INDEX_COLUMNS} FROM session_index \
         WHERE session_id LIKE ?1 ESCAPE '\\' ORDER BY session_id"
    );
    let pattern = format!("{}%", escape_like(prefix));
    query(path, &sql, &[&pattern])
}

/// Every row carrying `callsign`, narrowed to one project leaf when the
/// reference named one. A callsign is unique per ledger, not per machine,
/// so more than one row is the ordinary ambiguous case rather than a fault.
pub fn lookup_callsign(path: &Path, callsign: &str, project_leaf: Option<&str>) -> Vec<IndexEntry> {
    match project_leaf {
        Some(leaf) => {
            let sql = format!(
                "SELECT {INDEX_COLUMNS} FROM session_index \
                 WHERE callsign = ?1 AND project_leaf = ?2 ORDER BY session_id"
            );
            query(path, &sql, &[&callsign, &leaf])
        }
        None => {
            let sql = format!(
                "SELECT {INDEX_COLUMNS} FROM session_index \
                 WHERE callsign = ?1 ORDER BY session_id"
            );
            query(path, &sql, &[&callsign])
        }
    }
}

/// Escape the `LIKE` metacharacters so a prefix carrying one matches
/// literally. Paired with `ESCAPE '\'` in the query.
fn escape_like(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(uuid: &str, callsign: &str, project_dir: &str) -> IndexEntry {
        IndexEntry {
            session_id: uuid.into(),
            line_id: "line-1".into(),
            callsign: Some(callsign.into()),
            project_dir: project_dir.into(),
            project_leaf: String::new(),
            instance: "debug-a".into(),
            title: None,
            created_at_ms: 1_000,
            updated_at_ms: 1_000,
        }
    }

    fn on_disk() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session_index.db");
        (dir, path)
    }

    #[test]
    fn upsert_round_trips_and_derives_the_project_leaf() {
        let (_dir, path) = on_disk();
        let index = SessionIndex::open(&path).unwrap();
        index
            .upsert(&entry("aaaa1111", "curly-apple", "/u/src/eucit/"))
            .unwrap();

        let found = lookup_uuid(&path, "aaaa1111");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].project_leaf, "eucit");
        assert_eq!(found[0].callsign.as_deref(), Some("curly-apple"));
        assert_eq!(found[0].instance, "debug-a");
    }

    #[test]
    fn a_second_upsert_updates_title_and_keeps_created_at() {
        let (_dir, path) = on_disk();
        let index = SessionIndex::open(&path).unwrap();
        index
            .upsert(&entry("aaaa1111", "curly-apple", "/u/src/eucit"))
            .unwrap();

        let mut again = entry("aaaa1111", "curly-apple", "/u/src/eucit");
        again.title = Some("Session Atom Reach".into());
        again.created_at_ms = 9_999; // ignored on an update
        again.updated_at_ms = 5_000;
        index.upsert(&again).unwrap();

        let found = lookup_uuid(&path, "aaaa1111");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title.as_deref(), Some("Session Atom Reach"));
        assert_eq!(
            found[0].created_at_ms, 1_000,
            "created_at is a fact about the past"
        );
        assert_eq!(found[0].updated_at_ms, 5_000);
    }

    #[test]
    fn lookup_callsign_with_and_without_a_project_half() {
        let (_dir, path) = on_disk();
        let index = SessionIndex::open(&path).unwrap();
        index
            .upsert(&entry("aaaa1111", "curly-apple", "/u/src/eucit"))
            .unwrap();
        index
            .upsert(&entry("bbbb2222", "curly-apple", "/u/src/tug"))
            .unwrap();

        let both = lookup_callsign(&path, "curly-apple", None);
        assert_eq!(
            both.len(),
            2,
            "a callsign is unique per ledger, not per machine"
        );

        let narrowed = lookup_callsign(&path, "curly-apple", Some("eucit"));
        assert_eq!(narrowed.len(), 1);
        assert_eq!(narrowed[0].session_id, "aaaa1111");

        assert!(lookup_callsign(&path, "curly-apple", Some("nosuch")).is_empty());
    }

    #[test]
    fn lookup_prefix_returns_every_row_sharing_it() {
        let (_dir, path) = on_disk();
        let index = SessionIndex::open(&path).unwrap();
        index
            .upsert(&entry("abcd1234ffff", "one", "/u/src/a"))
            .unwrap();
        index
            .upsert(&entry("abcd1234eeee", "two", "/u/src/b"))
            .unwrap();
        index
            .upsert(&entry("99991234eeee", "three", "/u/src/c"))
            .unwrap();

        let shared = lookup_prefix(&path, "abcd1234");
        assert_eq!(shared.len(), 2);
        assert_eq!(shared[0].session_id, "abcd1234eeee");
        assert_eq!(shared[1].session_id, "abcd1234ffff");

        // A prefix carrying a LIKE metacharacter matches literally.
        assert!(lookup_prefix(&path, "abcd%").is_empty());
    }

    #[test]
    fn retitle_line_touches_only_that_instance_and_line() {
        let (_dir, path) = on_disk();
        let index = SessionIndex::open(&path).unwrap();
        index
            .upsert(&entry("aaaa1111", "curly-apple", "/u/src/eucit"))
            .unwrap();

        let mut other_line = entry("bbbb2222", "zany-ghost", "/u/src/eucit");
        other_line.line_id = "line-2".into();
        index.upsert(&other_line).unwrap();

        let mut other_instance = entry("cccc3333", "warm-grit", "/u/src/tug");
        other_instance.instance = "debug-b".into();
        index.upsert(&other_instance).unwrap();

        let touched = index
            .retitle_line("debug-a", "line-1", Some("Named"))
            .unwrap();
        assert_eq!(touched, 1);

        for row in index.all() {
            let expected = if row.session_id == "aaaa1111" {
                Some("Named")
            } else {
                None
            };
            assert_eq!(row.title.as_deref(), expected, "row {}", row.session_id);
        }
    }

    #[test]
    fn remove_forgets_one_segment() {
        let (_dir, path) = on_disk();
        let index = SessionIndex::open(&path).unwrap();
        index
            .upsert(&entry("aaaa1111", "curly-apple", "/u/src/eucit"))
            .unwrap();
        assert_eq!(index.remove("aaaa1111").unwrap(), 1);
        assert!(lookup_uuid(&path, "aaaa1111").is_empty());
        assert_eq!(index.remove("aaaa1111").unwrap(), 0);
    }

    #[test]
    fn a_newer_schema_refuses_to_open() {
        let (_dir, path) = on_disk();
        {
            let conn = crate::ledger_db::open(&path).unwrap();
            conn.pragma_update(None, "user_version", 999i64).unwrap();
        }
        let err = SessionIndex::open(&path).unwrap_err();
        assert!(
            matches!(
                err,
                SessionIndexError::SchemaTooNew {
                    on_disk: 999,
                    supported: SESSION_INDEX_SCHEMA_VERSION
                }
            ),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn a_lookup_against_a_missing_file_is_empty_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let nowhere = dir.path().join("never-written.db");
        assert!(lookup_uuid(&nowhere, "aaaa1111").is_empty());
        assert!(lookup_prefix(&nowhere, "aaaa1111").is_empty());
        assert!(lookup_callsign(&nowhere, "curly-apple", None).is_empty());
    }

    #[test]
    fn an_in_memory_index_takes_the_same_writes() {
        let index = SessionIndex::open_in_memory().unwrap();
        index
            .upsert(&entry("aaaa1111", "curly-apple", "/u/src/eucit"))
            .unwrap();
        let rows = index.all();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].project_leaf, "eucit");
    }

    #[test]
    fn project_leaf_of_ignores_trailing_separators() {
        assert_eq!(project_leaf_of("/u/src/tug"), "tug");
        assert_eq!(project_leaf_of("/u/src/tug/"), "tug");
        assert_eq!(project_leaf_of("/u/src/tug///"), "tug");
        assert_eq!(project_leaf_of("tug"), "tug");
        assert_eq!(project_leaf_of("/"), "");
        assert_eq!(project_leaf_of(""), "");
    }
}
