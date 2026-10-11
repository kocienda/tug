//! The ledger fixture — a `changes.db` and a `sessions.db` built from the
//! schema production builds, for tests outside tugcast that read them.
//!
//! tugarc-core, tugchanges-core, tugtool, and `session_finder` read tables
//! tugcast writes. A test that pastes the `CREATE TABLE` it needs is a copy
//! that drifts the moment a column is added; this fixture is the one way to
//! have the tables instead. `changes.db` is created through
//! [`changes_schema::bootstrap`] — the same versioned bootstrap tugcast and
//! tugtool run, so it is stamped and shaped exactly as a real one is — and
//! `sessions.db` carries the three tables other crates read, from the
//! [`session_schema`] strings tugcast creates them from.
//!
//! A test that means to exercise an *older* shape — a pre-spans database, a
//! pre-lines one — builds that shape by hand, because that is the point of
//! it. Everything else asks here.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, params};

use crate::{changes_schema, ledger_db, session_schema};

/// Both ledgers, created in a directory the test owns.
pub struct Ledgers {
    dir: PathBuf,
}

/// Create `changes.db` and `sessions.db` in `dir`, each at the current shape
/// and empty.
pub fn ledgers(dir: &Path) -> Ledgers {
    let ledgers = Ledgers {
        dir: dir.to_path_buf(),
    };
    let changes = changes_schema::open(&ledgers.changes_db()).expect("open changes.db");
    let migrated = changes_schema::bootstrap(&changes).expect("bootstrap changes.db");
    assert_eq!(migrated, ledger_db::Migrated::Current);
    let sessions = ledgers.sessions();
    for sql in [
        session_schema::CREATE_LINES_SQL,
        session_schema::CREATE_SESSIONS_SQL,
        session_schema::CREATE_MINTED_TAGS_SQL,
    ] {
        sessions.execute_batch(sql).expect("create sessions.db tables");
    }
    ledgers
}

impl Ledgers {
    /// The ledgers an earlier [`ledgers`] created in `dir`, for a test that
    /// kept only the directory. Creates nothing.
    pub fn at(dir: &Path) -> Ledgers {
        Ledgers {
            dir: dir.to_path_buf(),
        }
    }

    /// The directory both files live in.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// `<dir>/changes.db` — what `TUG_CHANGES_DB` points at.
    pub fn changes_db(&self) -> PathBuf {
        self.dir.join("changes.db")
    }

    /// `<dir>/sessions.db` — what `TUG_SESSIONS_DB` points at.
    pub fn sessions_db(&self) -> PathBuf {
        self.dir.join("sessions.db")
    }

    /// A writable connection to `changes.db`. Its tables are reachable both
    /// unqualified and as `changes.<table>`.
    pub fn changes(&self) -> Connection {
        changes_schema::open(&self.changes_db()).expect("open changes.db")
    }

    /// A writable connection to `sessions.db`.
    pub fn sessions(&self) -> Connection {
        ledger_db::open(self.sessions_db()).expect("open sessions.db")
    }

    /// Record a line of work under `tag`, seated nowhere, in `/p`. Already
    /// recorded is left as it is.
    pub fn add_line(&self, line_id: &str, tag: &str) {
        self.sessions()
            .execute(
                "INSERT OR IGNORE INTO lines (line_id, tag, project_dir, created_at, last_used_at)
                 VALUES (?1, ?2, '/p', 0, 0)",
                params![line_id, tag],
            )
            .expect("insert line");
    }

    /// Record a live session segment of `line_id`, recording the line too
    /// (tagged with its own id) when it is not already; a segment already
    /// recorded is left as it is. Every column the schema requires gets a
    /// plain default; a test that cares about one updates it afterwards.
    pub fn add_session(&self, session_id: &str, line_id: &str) {
        self.add_line(line_id, line_id);
        self.sessions()
            .execute(
                "INSERT OR IGNORE INTO sessions
                    (session_id, workspace_key, project_dir, created_at, last_used_at, state, line_id)
                 VALUES (?1, '/p', '/p', 0, 0, 'live', ?2)",
                params![session_id, line_id],
            )
            .expect("insert session");
    }
}
