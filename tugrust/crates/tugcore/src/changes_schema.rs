//! The schema of the machine-global `changes.db`, in one place.
//!
//! `changes.db` is written by tugcast's ledger and, under `TUG_CHANGES_DB`
//! isolation, by tugtool's `draft` verbs, and its tables are read by
//! tugarc-core and tugchanges-core. tugtool cannot link tugcast, so the
//! DDL, its version, and its registered migrations live here, and every
//! writer creates the schema through [`bootstrap`] — the same precedent as
//! `session_index`.
//!
//! The schema is versioned ([D112]): an instance may only create the
//! current shape on a fresh database, stamp a pre-versioning one, or apply
//! a *registered* migration. Bumping [`CHANGES_SCHEMA_VERSION`] REQUIRES a
//! registered entry in [`CHANGES_MIGRATIONS`] and human review of the
//! migration SQL — an individual instance must never reshape the
//! machine-global schema on its own. A build seeing a *newer* on-disk
//! version writes nothing; what that costs it is the caller's to decide.
//!
//! Every statement names its tables `changes.<table>`: the database is
//! always reached as an attach under [`ATTACH_NAME`], beside tugcast's
//! per-instance `sessions.db` or, for a CLI writer, beside an empty
//! in-memory main ([`open`]).

use std::path::Path;

use rusqlite::Connection;

use crate::ledger_db::{self, LedgerSchema, Migrated};

/// The schema name `changes.db` is attached under on every connection that
/// writes it, and the qualifier every statement here uses.
pub const ATTACH_NAME: &str = "changes";

/// Version stamp of the **shared** `changes.db` schema (`PRAGMA
/// changes.user_version`). See the module doc for what bumping it requires.
pub const CHANGES_SCHEMA_VERSION: i64 = 4;

/// Registered, human-approved migrations for the shared changes schema:
/// `(from_version, sql)` applied in order to reach `from_version + 1`.
/// Version 1 was the first stamped shape; version 2 adds the additive
/// `file_event_spans` child table ([P10]) and touches nothing existing;
/// version 3 adds the nullable `file_events.line_id` column ([P01]) —
/// stamped at write time, so a row stays attributed to its line of work
/// even after the `sessions` row it would have joined through is evicted
/// or lives in another instance's ledger ([Q01]).
/// Version 4 rewrites `changeset_drafts` owner spellings from the retired
/// owner kind and `tugdash/` to `arc` / `tugarc/` ([P03]) — the branch prefix moved
/// in the same arc, so a row keyed on the old one names a branch that no
/// longer exists.
pub const CHANGES_MIGRATIONS: &[(i64, &str)] = &[
    (1, CREATE_FILE_EVENT_SPANS_SQL),
    (2, ADD_FILE_EVENTS_LINE_ID_SQL),
    (3, RENAME_ARC_OWNERS_SQL),
];

/// The `file_events` table and its index.
pub const CREATE_FILE_EVENTS_SQL: &str = "
    -- Authoritative per-session file attribution — one row per
    -- (tug_session_id, tool_use_id, file_path). Written from the
    -- agent-bridge relay loop at the moment a tool call that
    -- changed a file lands: exact for Write/Edit/MultiEdit/
    -- NotebookEdit (straight from the tool input), bracketed for
    -- Bash (working-tree fingerprint delta). This concentrates a
    -- session's file knowledge down to the point of change rather
    -- than reconstructing the session file list from conversation
    -- context (which is blind to Bash-mediated edits like sed,
    -- perl, or git mv).
    --
    -- Keyed by the tug session id — the card-bound identity that
    -- survives resumes (claude ids rotate underneath it), so
    -- attribution gets resume-lineage for free. The PK is the
    -- idempotency contract: resume replays the full history and
    -- subagent-tail re-streams background-agent children from
    -- offset 0, so a frame may be seen twice; `record_file_event`
    -- upserts with ON CONFLICT DO NOTHING, making the repeat a
    -- no-op. Cascade-on-DELETE mirrors the `turns` journal so
    -- evicting a `sessions` row takes its attribution with it.
    CREATE TABLE IF NOT EXISTS changes.file_events (
        tug_session_id      TEXT NOT NULL,
        tool_use_id         TEXT NOT NULL,
        file_path           TEXT NOT NULL,
        tool_name           TEXT NOT NULL,
        op                  TEXT NOT NULL,
        origin              TEXT NOT NULL,
        ambiguous           INTEGER NOT NULL DEFAULT 0,
        parent_tool_use_id  TEXT,
        project_dir         TEXT NOT NULL,
        at                  INTEGER NOT NULL,
        -- The line of work the writing session belonged to ([P01]),
        -- stamped at write time from the writer's `sessions` row.
        -- First-choice owner key at read time; the sessions join is
        -- the fallback for rows written before v3 (or by a session
        -- the writer's ledger had never seen, where it is NULL).
        line_id             TEXT,
        PRIMARY KEY (tug_session_id, tool_use_id, file_path)
    );

    CREATE INDEX IF NOT EXISTS changes.file_events_project
        ON file_events(project_dir, at);
";

/// The `changeset_drafts` table.
pub const CREATE_CHANGESET_DRAFTS_SQL: &str = "
    -- Maintained changeset drafts — machine-global like file_events
    -- ([D112]): the working tree is machine-global, so the truth
    -- about its proposed landing must be too. Two app instances on
    -- one checkout see one draft.
    CREATE TABLE IF NOT EXISTS changes.changeset_drafts (
        owner_kind   TEXT NOT NULL,
        owner_id     TEXT NOT NULL,
        project_dir  TEXT NOT NULL,
        fingerprint  TEXT NOT NULL,
        message      TEXT NOT NULL,
        updated_at   INTEGER NOT NULL,
        edited       INTEGER NOT NULL DEFAULT 0,
        selection    TEXT,
        PRIMARY KEY (owner_kind, owner_id, project_dir)
    );
";

/// The `file_event_spans` DDL, in one place: the v1→v2 migration and the
/// idempotent bootstrap block both run it, so a migrated database and a
/// fresh one cannot end up with different shapes.
pub const CREATE_FILE_EVENT_SPANS_SQL: &str = "
    -- Sub-file evidence for a `file_events` row (Spec S04): what the tool
    -- call wrote *inside* the file, so two sessions editing disjoint
    -- regions of one path read as disjoint rather than contested. Rows are
    -- children of `file_events` — same first three key columns plus a
    -- per-row ordinal — and every applier that moves or removes the parent
    -- carries them along. `anchor` is content, never a line number ([P11]).
    CREATE TABLE IF NOT EXISTS changes.file_event_spans (
        tug_session_id TEXT NOT NULL,
        tool_use_id    TEXT NOT NULL,
        file_path      TEXT NOT NULL,
        seq            INTEGER NOT NULL,
        kind           TEXT NOT NULL,
        anchor         TEXT NOT NULL,
        PRIMARY KEY (tug_session_id, tool_use_id, file_path, seq)
    );
";

/// The v2→v3 column add, in one place with the conditional bootstrap arm
/// that covers pre-versioning databases.
const ADD_FILE_EVENTS_LINE_ID_SQL: &str =
    "ALTER TABLE changes.file_events ADD COLUMN line_id TEXT;";

/// The v3→v4 owner rewrite, in one place with the idempotent bootstrap arm
/// that covers a pre-versioning database whose table is already on disk.
///
/// Both statements are safe to re-run: the second pass matches no rows, so a
/// crash between the DDL and the version stamp costs nothing. The prefix
/// rewrite is injective — `tugdash/` and `tugarc/` are the same length and
/// differ byte for byte after the prefix — so no primary-key collision is
/// possible however many rows either spelling holds.
const RENAME_ARC_OWNERS_SQL: &str = "
    UPDATE changes.changeset_drafts SET owner_kind = 'arc' WHERE owner_kind = 'dash';
    UPDATE changes.changeset_drafts SET owner_id = 'tugarc/' || substr(owner_id, 9)
        WHERE owner_id LIKE 'tugdash/%';
";

/// The errors a re-run [`CHANGES_MIGRATIONS`] entry may raise that mean it
/// already ran. A crash between a migration's DDL and the version stamp
/// re-runs the migration on the next open; an `ALTER TABLE … ADD COLUMN` is
/// not idempotent the way `CREATE TABLE IF NOT EXISTS` is, so the one error
/// that means "already applied" is absorbed.
///
/// A migration that touches a table the bootstrap has not created yet is
/// absorbed on the same footing: it ran against a database that has no such
/// rows to move, and the idempotent arm after the DDL is what covers a
/// database that does.
fn migration_already_applied(err: &rusqlite::Error) -> bool {
    let message = err.to_string();
    message.contains("duplicate column name") || message.contains("no such table")
}

/// Bring the `changes` schema attached on `conn` to [`CHANGES_SCHEMA_VERSION`]
/// through [`ledger_db::migrate`]: the registered migrations above the
/// on-disk version, then the idempotent current shape, then the stamp.
///
/// [`Migrated::TooNew`] means a newer build owns the shape and nothing was
/// touched; the caller decides what it may still do.
pub fn bootstrap(conn: &Connection) -> rusqlite::Result<Migrated> {
    let schema = LedgerSchema {
        db: rusqlite::DatabaseName::Attached(ATTACH_NAME),
        version: CHANGES_SCHEMA_VERSION,
        migrations: CHANGES_MIGRATIONS,
        already_applied: migration_already_applied,
    };
    ledger_db::migrate(conn, &schema, create_current_shape)
}

/// The current shape, created idempotently on a fresh (0) or older
/// database, plus the repairs a pre-versioning database needs because it
/// takes no registered migration.
fn create_current_shape(conn: &Connection) -> rusqlite::Result<()> {
    // A pre-versioning database with a *drifted* shape is left intact —
    // never dropped — and its insert failures surface through the
    // corruption/write guards for a human-reviewed migration.
    conn.execute_batch(CREATE_FILE_EVENTS_SQL)?;
    conn.execute_batch(CREATE_CHANGESET_DRAFTS_SQL)?;
    conn.execute_batch(CREATE_FILE_EVENT_SPANS_SQL)?;
    // A pre-versioning database (version 0 with the table already on
    // disk) takes no registered migration, and `CREATE TABLE IF NOT
    // EXISTS` leaves its shape alone — so the v3 column add runs
    // conditionally here, the one shape it could still be missing.
    let has_line_id = {
        let mut stmt = conn.prepare("PRAGMA changes.table_info(file_events)")?;
        let cols = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        cols.iter().any(|name| name == "line_id")
    };
    if !has_line_id {
        conn.execute_batch(ADD_FILE_EVENTS_LINE_ID_SQL)?;
    }
    // Same reasoning as the column add above, and the same shape: a
    // pre-versioning database takes no registered migration, and these
    // two UPDATEs match nothing on a database that has already had them.
    conn.execute_batch(RENAME_ARC_OWNERS_SQL)?;
    Ok(())
}

/// Open `changes.db` for a writer that has no `sessions.db` to attach it
/// beside — tugtool's isolated `draft` path, and test fixtures. The main
/// database is an empty in-memory one and `changes.db` is attached under
/// [`ATTACH_NAME`] through [`ledger_db::attach`], so the connection carries
/// the unified pragma set, the statements here resolve, and an unqualified
/// table name reaches the attached table because main has none. The schema
/// is not bootstrapped; call [`bootstrap`] next.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    ledger_db::apply_pragmas(&conn)?;
    ledger_db::attach(&conn, ATTACH_NAME, path)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA changes.user_version", [], |r| r.get(0))
            .unwrap()
    }

    fn table_count(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM changes.sqlite_master WHERE type = 'table'
             AND name IN ('file_events', 'file_event_spans', 'changeset_drafts')",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn bootstrap_creates_and_stamps_a_fresh_database() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("changes.db")).unwrap();
        assert_eq!(bootstrap(&conn).unwrap(), Migrated::Current);
        assert_eq!(version(&conn), CHANGES_SCHEMA_VERSION);
        assert_eq!(table_count(&conn), 3);
        // Idempotent on a current database.
        assert_eq!(bootstrap(&conn).unwrap(), Migrated::Current);
        assert_eq!(version(&conn), CHANGES_SCHEMA_VERSION);
    }

    #[test]
    fn bootstrap_reaches_the_attached_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("changes.db");
        bootstrap(&open(&path).unwrap()).unwrap();
        let reopened = ledger_db::open(&path).unwrap();
        let v: i64 = reopened
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, CHANGES_SCHEMA_VERSION);
    }

    #[test]
    fn bootstrap_refuses_a_newer_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("changes.db");
        ledger_db::open(&path)
            .unwrap()
            .execute_batch(&format!(
                "PRAGMA user_version = {};",
                CHANGES_SCHEMA_VERSION + 1
            ))
            .unwrap();
        let conn = open(&path).unwrap();
        assert_eq!(
            bootstrap(&conn).unwrap(),
            Migrated::TooNew {
                on_disk: CHANGES_SCHEMA_VERSION + 1
            }
        );
        assert_eq!(table_count(&conn), 0);
    }

    #[test]
    fn bootstrap_migrates_a_v1_database_to_the_current_shape() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("changes.db");
        ledger_db::open(&path)
            .unwrap()
            .execute_batch(
                "CREATE TABLE file_events (
                    tug_session_id TEXT NOT NULL, tool_use_id TEXT NOT NULL,
                    file_path TEXT NOT NULL, tool_name TEXT NOT NULL, op TEXT NOT NULL,
                    origin TEXT NOT NULL, ambiguous INTEGER NOT NULL DEFAULT 0,
                    parent_tool_use_id TEXT, project_dir TEXT NOT NULL, at INTEGER NOT NULL,
                    PRIMARY KEY (tug_session_id, tool_use_id, file_path));
                 CREATE TABLE changeset_drafts (
                    owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, project_dir TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, message TEXT NOT NULL, updated_at INTEGER NOT NULL,
                    edited INTEGER NOT NULL DEFAULT 0, selection TEXT,
                    PRIMARY KEY (owner_kind, owner_id, project_dir));
                 INSERT INTO changeset_drafts VALUES ('dash', 'tugdash/x', '/p', '', 'm', 0, 0, NULL);
                 PRAGMA user_version = 1;",
            )
            .unwrap();
        let conn = open(&path).unwrap();
        assert_eq!(bootstrap(&conn).unwrap(), Migrated::Current);
        assert_eq!(version(&conn), CHANGES_SCHEMA_VERSION);
        assert_eq!(table_count(&conn), 3);
        let (kind, id): (String, String) = conn
            .query_row(
                "SELECT owner_kind, owner_id FROM changeset_drafts",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((kind.as_str(), id.as_str()), ("arc", "tugarc/x"));
        let line_id: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('file_events', 'changes')
                 WHERE name = 'line_id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(line_id, 1);
    }
}
