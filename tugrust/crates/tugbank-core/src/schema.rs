//! Schema bootstrap and migration logic for tugbank-core.

use rusqlite::Connection;

use crate::Error;

/// The current schema version produced by [`bootstrap_schema`].
const CURRENT_SCHEMA_VERSION: u64 = 2;

/// The domain-name prefix every tugbank domain wore before schema v2.
const V1_DOMAIN_PREFIX: &str = "dev.tugtool.";

/// The prefix those domains wear from schema v2 onward.
const V2_DOMAIN_PREFIX: &str = "dev.tugapp.";

/// Apply required SQLite pragmas to a connection.
///
/// Sets `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`,
/// and `synchronous=NORMAL`. Called unconditionally on every database open.
pub(crate) fn apply_pragmas(conn: &Connection) -> Result<(), Error> {
    // The unified ledger pragma set (WAL, busy_timeout, synchronous,
    // cell_size_check) from the chokepoint, plus tugbank's foreign keys.
    tugcore::ledger_db::apply_pragmas(conn)?;
    conn.pragma_update(None, "foreign_keys", 1i64)?;
    Ok(())
}

/// Bootstrap the schema on a fresh database.
///
/// Creates the `meta`, `domains`, and `entries` tables plus the domain index,
/// then stamps [`CURRENT_SCHEMA_VERSION`] into the `meta` table.
/// Uses `CREATE TABLE IF NOT EXISTS` and `INSERT OR REPLACE`, so calling
/// this function on a database that already has the schema is safe (idempotent).
pub(crate) fn bootstrap_schema(conn: &Connection) -> Result<(), Error> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS domains (
            name        TEXT PRIMARY KEY,
            generation  INTEGER NOT NULL DEFAULT 0,
            updated_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS entries (
            domain       TEXT NOT NULL,
            key          TEXT NOT NULL,
            value_kind   INTEGER NOT NULL,
            value_i64    INTEGER,
            value_f64    REAL,
            value_text   TEXT,
            value_blob   BLOB,
            updated_at   TEXT NOT NULL,
            PRIMARY KEY (domain, key),
            FOREIGN KEY (domain) REFERENCES domains(name) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_entries_domain ON entries(domain);
        ",
    )?;
    stamp_schema_version(conn)?;
    Ok(())
}

/// Write [`CURRENT_SCHEMA_VERSION`] into the `meta` table.
fn stamp_schema_version(conn: &Connection) -> Result<(), Error> {
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?1)",
        [CURRENT_SCHEMA_VERSION.to_string()],
    )?;
    Ok(())
}

/// Read the current schema version from the `meta` table.
///
/// Returns `None` if the table doesn't exist or the key is absent.
fn read_schema_version(conn: &Connection) -> Option<u64> {
    conn.query_row(
        "SELECT value FROM meta WHERE key = 'schema_version'",
        [],
        |row| {
            let s: String = row.get(0)?;
            Ok(s)
        },
    )
    .ok()
    .and_then(|s: String| s.parse::<u64>().ok())
}

/// Ensure the schema is up to date.
///
/// Reads `schema_version` from the `meta` table. If missing, calls
/// [`bootstrap_schema`] to create the full schema. If present and older
/// than [`CURRENT_SCHEMA_VERSION`], runs versioned migrations inside a
/// transaction so failures roll back cleanly.
///
/// This function is called on every [`DefaultsStore::open`](crate::DefaultsStore::open).
pub(crate) fn migrate_schema(conn: &Connection) -> Result<(), Error> {
    let version = read_schema_version(conn);

    match version {
        None => {
            // Fresh database — bootstrap everything.
            bootstrap_schema(conn)?;
        }
        Some(v) if v < CURRENT_SCHEMA_VERSION => {
            // Run incremental migrations inside a transaction so a failure
            // rolls back cleanly and the version stamp moves with the data.
            conn.execute_batch("BEGIN;")?;
            let result = run_migrations(conn, v);
            match result {
                Ok(()) => {
                    conn.execute_batch("COMMIT;")?;
                }
                Err(e) => {
                    conn.execute_batch("ROLLBACK;").ok();
                    return Err(e);
                }
            }
        }
        Some(_) => {
            // Already at current version — nothing to do.
        }
    }

    Ok(())
}

/// Apply any schema migrations needed to bring `from_version` up to
/// [`CURRENT_SCHEMA_VERSION`].
///
/// Called inside a transaction by [`migrate_schema`].
fn run_migrations(conn: &Connection, from_version: u64) -> Result<(), Error> {
    if from_version < 2 {
        migrate_domain_prefix_v2(conn)?;
    }
    stamp_schema_version(conn)?;
    Ok(())
}

/// v1 → v2: refile every `dev.tugtool.*` domain under `dev.tugapp.*`.
///
/// `entries.domain` references `domains(name)` with `ON DELETE CASCADE` and no
/// `ON UPDATE CASCADE`, so the rename is three statements rather than one
/// `UPDATE domains`: copy the rows across under their new names, move the
/// entries onto them, then delete the originals — the cascade sweeping up
/// whatever the move left behind.
///
/// A destination domain that somehow already exists wins. Its row is not
/// overwritten (`INSERT OR IGNORE`) and neither are its entries
/// (`UPDATE OR IGNORE`), so a value written since the rename is the value that
/// survives. Copied domains take `generation + 1`, so every DEFAULTS subscriber
/// reads the domain as changed on first boot.
fn migrate_domain_prefix_v2(conn: &Connection) -> Result<(), Error> {
    let now = crate::domain::now_rfc3339();
    let old_like = format!("{V1_DOMAIN_PREFIX}%");
    // `substr()` is 1-based, so the suffix starts one past the old prefix.
    let suffix_start = V1_DOMAIN_PREFIX.len() as i64 + 1;

    conn.execute(
        "INSERT OR IGNORE INTO domains (name, generation, updated_at)
         SELECT ?1 || substr(name, ?2), generation + 1, ?3
         FROM domains WHERE name LIKE ?4",
        rusqlite::params![V2_DOMAIN_PREFIX, suffix_start, now, old_like],
    )?;
    conn.execute(
        "UPDATE OR IGNORE entries SET domain = ?1 || substr(domain, ?2)
         WHERE domain LIKE ?3",
        rusqlite::params![V2_DOMAIN_PREFIX, suffix_start, old_like],
    )?;
    conn.execute(
        "DELETE FROM domains WHERE name LIKE ?1",
        rusqlite::params![old_like],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(test)]
    use tempfile::NamedTempFile;

    fn open_in_memory() -> Connection {
        Connection::open_in_memory().expect("in-memory connection failed")
    }

    fn table_exists(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
            > 0
    }

    #[test]
    fn test_bootstrap_creates_all_tables() {
        let conn = open_in_memory();
        bootstrap_schema(&conn).expect("bootstrap should succeed");

        assert!(table_exists(&conn, "meta"), "meta table missing");
        assert!(table_exists(&conn, "domains"), "domains table missing");
        assert!(table_exists(&conn, "entries"), "entries table missing");

        // schema_version row should be present
        let version = read_schema_version(&conn);
        assert_eq!(version, Some(CURRENT_SCHEMA_VERSION));
    }

    #[test]
    fn test_bootstrap_is_idempotent() {
        let conn = open_in_memory();
        bootstrap_schema(&conn).expect("first bootstrap should succeed");
        bootstrap_schema(&conn).expect("second bootstrap should succeed");

        // Still exactly one schema_version row
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM meta WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_migrate_schema_bootstraps_fresh_db() {
        let conn = open_in_memory();
        // No meta table yet — migrate_schema should detect this and bootstrap.
        migrate_schema(&conn).expect("migrate on fresh db should succeed");

        assert!(table_exists(&conn, "meta"));
        assert!(table_exists(&conn, "domains"));
        assert!(table_exists(&conn, "entries"));
        assert_eq!(read_schema_version(&conn), Some(CURRENT_SCHEMA_VERSION));
    }

    #[test]
    fn test_apply_pragmas_sets_wal_mode() {
        let conn = open_in_memory();
        apply_pragmas(&conn).expect("apply_pragmas should succeed");

        // In-memory databases always report "memory" for journal_mode,
        // but the pragma call itself must not error. We verify it
        // completes cleanly; WAL is confirmed on a file-backed DB below.
        let journal_mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("journal_mode query failed");
        assert!(
            journal_mode == "memory" || journal_mode == "wal",
            "unexpected journal_mode: {journal_mode}"
        );
    }

    #[test]
    fn test_apply_pragmas_sets_wal_mode_file_backed() {
        // Use a real file to confirm WAL mode is actually applied.
        let tmp = NamedTempFile::new().expect("temp file failed");
        let conn = Connection::open(tmp.path()).expect("open failed");
        apply_pragmas(&conn).expect("apply_pragmas should succeed");

        let journal_mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("journal_mode query failed");
        assert_eq!(journal_mode, "wal", "file-backed DB should be in WAL mode");
    }

    /// A v1 database: the same tables, stamped back to `schema_version = '1'`.
    fn open_v1() -> Connection {
        let conn = open_in_memory();
        apply_pragmas(&conn).expect("pragmas should apply");
        bootstrap_schema(&conn).expect("bootstrap should succeed");
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1')",
            [],
        )
        .expect("stamping v1 should succeed");
        conn
    }

    fn seed_domain(conn: &Connection, name: &str, generation: i64) {
        conn.execute(
            "INSERT INTO domains (name, generation, updated_at)
             VALUES (?1, ?2, '2020-01-01T00:00:00Z')",
            rusqlite::params![name, generation],
        )
        .expect("seeding a domain should succeed");
    }

    fn seed_entry(conn: &Connection, domain: &str, key: &str, text: &str) {
        conn.execute(
            "INSERT INTO entries (domain, key, value_kind, value_text, updated_at)
             VALUES (?1, ?2, 4, ?3, '2020-01-01T00:00:00Z')",
            rusqlite::params![domain, key, text],
        )
        .expect("seeding an entry should succeed");
    }

    fn entry_text(conn: &Connection, domain: &str, key: &str) -> Option<String> {
        conn.query_row(
            "SELECT value_text FROM entries WHERE domain = ?1 AND key = ?2",
            rusqlite::params![domain, key],
            |row| row.get::<_, String>(0),
        )
        .ok()
    }

    fn generation_of(conn: &Connection, domain: &str) -> Option<i64> {
        conn.query_row(
            "SELECT generation FROM domains WHERE name = ?1",
            [domain],
            |row| row.get::<_, i64>(0),
        )
        .ok()
    }

    fn domain_names(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT name FROM domains ORDER BY name")
            .expect("prepare should succeed");
        stmt.query_map([], |row| row.get::<_, String>(0))
            .expect("query should succeed")
            .map(|r| r.expect("row should read"))
            .collect()
    }

    #[test]
    fn test_v2_refiles_every_domain_under_the_new_prefix() {
        let conn = open_v1();
        seed_domain(&conn, "dev.tugtool.app", 3);
        seed_domain(&conn, "dev.tugtool.overview", 1);
        seed_entry(&conn, "dev.tugtool.app", "theme", "brio");
        seed_entry(&conn, "dev.tugtool.app", "font-size", "14");
        seed_entry(&conn, "dev.tugtool.overview", "layout", "wide");

        migrate_schema(&conn).expect("v1 -> v2 migration should succeed");

        assert_eq!(read_schema_version(&conn), Some(CURRENT_SCHEMA_VERSION));
        assert_eq!(
            domain_names(&conn),
            vec!["dev.tugapp.app", "dev.tugapp.overview"]
        );
        assert_eq!(
            entry_text(&conn, "dev.tugapp.app", "theme").as_deref(),
            Some("brio")
        );
        assert_eq!(
            entry_text(&conn, "dev.tugapp.app", "font-size").as_deref(),
            Some("14")
        );
        assert_eq!(
            entry_text(&conn, "dev.tugapp.overview", "layout").as_deref(),
            Some("wide")
        );
        assert_eq!(entry_text(&conn, "dev.tugtool.app", "theme"), None);

        // The copy advances the generation so subscribers see a change.
        assert_eq!(generation_of(&conn, "dev.tugapp.app"), Some(4));
        assert_eq!(generation_of(&conn, "dev.tugapp.overview"), Some(2));
    }

    #[test]
    fn test_v2_leaves_an_existing_destination_domain_alone() {
        let conn = open_v1();
        seed_domain(&conn, "dev.tugtool.app", 3);
        seed_entry(&conn, "dev.tugtool.app", "theme", "old");
        seed_entry(&conn, "dev.tugtool.app", "only-in-old", "carried");
        seed_domain(&conn, "dev.tugapp.app", 9);
        seed_entry(&conn, "dev.tugapp.app", "theme", "new");

        migrate_schema(&conn).expect("v1 -> v2 migration should succeed");

        assert_eq!(domain_names(&conn), vec!["dev.tugapp.app"]);
        // The newer row keeps its generation; the copy is skipped.
        assert_eq!(generation_of(&conn, "dev.tugapp.app"), Some(9));
        // A value written since the rename wins over the one being carried.
        assert_eq!(
            entry_text(&conn, "dev.tugapp.app", "theme").as_deref(),
            Some("new")
        );
        // A key only the old domain had still moves across.
        assert_eq!(
            entry_text(&conn, "dev.tugapp.app", "only-in-old").as_deref(),
            Some("carried")
        );
    }

    #[test]
    fn test_v2_leaves_domains_outside_the_prefix_untouched() {
        let conn = open_v1();
        seed_domain(&conn, "com.example.settings", 2);
        seed_entry(&conn, "com.example.settings", "theme", "dark");
        // A near miss: the prefix has to match to the dot.
        seed_domain(&conn, "dev.tugtoolbox", 1);

        migrate_schema(&conn).expect("v1 -> v2 migration should succeed");

        assert_eq!(
            domain_names(&conn),
            vec!["com.example.settings", "dev.tugtoolbox"]
        );
        assert_eq!(generation_of(&conn, "com.example.settings"), Some(2));
        assert_eq!(
            entry_text(&conn, "com.example.settings", "theme").as_deref(),
            Some("dark")
        );
    }

    #[test]
    fn test_v2_migration_does_not_run_twice() {
        let conn = open_v1();
        seed_domain(&conn, "dev.tugtool.app", 3);
        seed_entry(&conn, "dev.tugtool.app", "theme", "brio");

        migrate_schema(&conn).expect("first migration should succeed");
        // A domain re-created under the old name after the migration is not
        // swept up by a later open: the database is already at v2.
        seed_domain(&conn, "dev.tugtool.late", 1);
        migrate_schema(&conn).expect("second migration should be a no-op");

        assert_eq!(
            domain_names(&conn),
            vec!["dev.tugapp.app", "dev.tugtool.late"]
        );
        assert_eq!(generation_of(&conn, "dev.tugapp.app"), Some(4));
    }
}
