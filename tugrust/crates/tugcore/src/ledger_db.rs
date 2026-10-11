//! The single chokepoint for opening Tug's SQLite ledger databases.
//!
//! Every writable open of a ledger file (`sessions.db`, the attached
//! machine-global `changes.db`, `shell_exchanges.db`, `tugbank.db`) goes
//! through [`open`] / [`attach`], so every writer — long-lived tugcast or
//! a short-lived CLI — runs the identical pragma set. Heterogeneous
//! configurations sharing one WAL database is the failure neighborhood of
//! the 2026-07-27 corruption incident; this module makes "one true way to
//! open a ledger" a compile-time property, enforced by the
//! `no_ad_hoc_ledger_opens` source scan below. Every versioned ledger
//! brings its schema up to date through [`migrate`], the one migration
//! loop, and `no_ad_hoc_user_version_writes` keeps it the only one.
//!
//! Pragmas applied (connection-wide unless noted):
//! - `journal_mode = WAL` — multi-process-safe journaling.
//! - `busy_timeout = 5000` — writers queue instead of erroring.
//! - `synchronous = NORMAL` — WAL-appropriate durability.
//! - `cell_size_check = ON` — page-level corruption errors at the
//!   statement that touches it instead of festering silently.

use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// Open (or create) a ledger database with the unified pragma set.
pub fn open(path: impl AsRef<Path>) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    apply_pragmas(&conn)?;
    Ok(conn)
}

/// Apply the unified pragma set to an existing connection — the shared
/// half of [`open`], exposed for callers that construct connections in
/// special ways (in-memory ledgers, injected test connections).
pub fn apply_pragmas(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA journal_mode = WAL;")?;
    conn.pragma_update(None, "busy_timeout", 5000i64)?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "cell_size_check", true)?;
    Ok(())
}

/// Attach another ledger database under `schema` and bring it up to the
/// same journaling contract (`journal_mode`/`synchronous` are per-database
/// for an attach; `busy_timeout`/`cell_size_check` are connection-wide and
/// already applied by [`open`]).
pub fn attach(conn: &Connection, schema: &str, path: &Path) -> rusqlite::Result<()> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    conn.execute(
        &format!("ATTACH DATABASE ?1 AS {schema}"),
        rusqlite::params![path.to_string_lossy()],
    )?;
    let db = rusqlite::DatabaseName::Attached(schema);
    conn.pragma_update(Some(db), "journal_mode", "WAL")?;
    conn.pragma_update(Some(db), "synchronous", "NORMAL")?;
    Ok(())
}

/// Attach another ledger database under `schema` **read-only** — the
/// non-owner half of the single-writer contract ([LR8]): a mutation that
/// escapes the forwarding route fails loudly instead of quietly joining a
/// second writer to the shared WAL. The journaling pragmas are the
/// owner's to set; a read-only attach cannot (and must not) touch them.
pub fn attach_read_only(conn: &Connection, schema: &str, path: &Path) -> rusqlite::Result<()> {
    let uri = format!("file:{}?mode=ro", uri_encode_path(&path.to_string_lossy()));
    conn.execute(
        &format!("ATTACH DATABASE ?1 AS {schema}"),
        rusqlite::params![uri],
    )?;
    Ok(())
}

/// One ledger's versioned schema, as [`migrate`] brings it up to date.
pub struct LedgerSchema<'a> {
    /// Which database on the connection the schema lives in: `Main`, or an
    /// attach such as `Attached("changes")`.
    pub db: rusqlite::DatabaseName<'a>,
    /// The version this build writes, stamped into `PRAGMA user_version`.
    pub version: i64,
    /// Registered migrations, each keyed by the on-disk version it upgrades
    /// *from*. Every migration whose `from` is at or above the version found
    /// on disk is applied in order.
    pub migrations: &'a [(i64, &'a str)],
    /// The errors a re-run migration may raise that mean it already ran — a
    /// crash between a migration and the stamp re-runs it, and an `ALTER
    /// TABLE … ADD COLUMN` is not idempotent the way `CREATE TABLE IF NOT
    /// EXISTS` is. [`no_migration_error_absorbed`] for a ledger that has none.
    pub already_applied: fn(&rusqlite::Error) -> bool,
}

/// The [`LedgerSchema::already_applied`] of a ledger whose every migration
/// is idempotent: no error is absorbed.
pub fn no_migration_error_absorbed(_: &rusqlite::Error) -> bool {
    false
}

/// What [`migrate`] found on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Migrated {
    /// The schema is now at the build's version.
    Current,
    /// The on-disk version is newer than this build's: a newer build owns
    /// the shape, and nothing was touched. Each ledger decides what that
    /// costs it — an open refused, or the shared tables written by nobody.
    TooNew { on_disk: i64 },
}

/// Bring a ledger's schema to `schema.version` — the one migration loop
/// every versioned ledger runs, and the only place a `user_version` is
/// written.
///
/// Reads the on-disk version and refuses one newer than this build's. A
/// database already stamped below it takes each registered migration above
/// its version, in order; a fresh one (version 0) takes none, because
/// `create` makes the current shape outright. Then `create` runs — the
/// idempotent `CREATE … IF NOT EXISTS` of the current shape, plus whatever
/// conditional repair a ledger's pre-versioning databases need — and the
/// version is stamped. Everything after the version check runs inside one
/// savepoint, so a failure leaves the database at the version it was found
/// at rather than half-migrated; a savepoint rather than a transaction,
/// because it nests inside one a caller may hold.
pub fn migrate<E: From<rusqlite::Error>>(
    conn: &Connection,
    schema: &LedgerSchema<'_>,
    create: impl FnOnce(&Connection) -> Result<(), E>,
) -> Result<Migrated, E> {
    let on_disk: i64 = conn.pragma_query_value(Some(schema.db), "user_version", |r| r.get(0))?;
    if on_disk > schema.version {
        return Ok(Migrated::TooNew { on_disk });
    }
    conn.execute_batch("SAVEPOINT ledger_migrate")?;
    let applied = (|| {
        if on_disk > 0 && on_disk < schema.version {
            for (from, sql) in schema.migrations {
                if *from >= on_disk
                    && let Err(err) = conn.execute_batch(sql)
                    && !(schema.already_applied)(&err)
                {
                    return Err(E::from(err));
                }
            }
        }
        create(conn)?;
        conn.pragma_update(Some(schema.db), "user_version", schema.version)?;
        Ok(())
    })();
    match applied {
        Ok(()) => {
            conn.execute_batch("RELEASE ledger_migrate")?;
            Ok(Migrated::Current)
        }
        Err(err) => {
            // Best effort: an error SQLite answered by rolling the whole
            // transaction back has already undone the work, and the
            // savepoint with it.
            let _ = conn.execute_batch("ROLLBACK TO ledger_migrate; RELEASE ledger_migrate");
            Err(err)
        }
    }
}

/// Percent-encode a filesystem path for a SQLite `file:` URI, leaving the
/// path separator and the unreserved set intact.
fn uri_encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

// ── Writer ownership ─────────────────────────────────────────────────────────

/// Suffix of the writer-claim lockfile beside a ledger database.
const WRITER_LOCK_SUFFIX: &str = ".writer-lock";

/// Identity the claim holder publishes for non-owners to reach it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WriterOwner {
    /// Per-instance id (`<profile>-<branch-slug>`), or `"standalone"`.
    pub instance_id: String,
    /// PID of the owning process.
    pub pid: i32,
    /// Loopback port its HTTP API is bound to; `0` when it has none.
    pub port: u16,
}

/// An held writer claim. Dropping it (or the process dying) releases the
/// claim — `flock(2)` locks are owned by the open file description, so
/// there is no stale-lock protocol to get wrong.
pub struct WriterLock {
    file: File,
    path: PathBuf,
}

impl WriterLock {
    /// The lockfile this claim is held on.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for WriterLock {
    fn drop(&mut self) {
        let _ = flock(&self.file, libc::LOCK_UN);
    }
}

/// The claim lockfile for `db_path` (`<db>.writer-lock`). Never renamed:
/// `flock` is per-inode, so a replaced file would let two processes each
/// believe they hold the exclusive claim.
pub fn writer_lock_path(db_path: &Path) -> PathBuf {
    let mut name = db_path.as_os_str().to_owned();
    name.push(WRITER_LOCK_SUFFIX);
    PathBuf::from(name)
}

/// Try to claim write ownership of the ledger at `db_path`.
///
/// Returns the held claim, or `None` when another live process already
/// owns it (or the lockfile cannot be opened). On success the caller's
/// `owner` identity is written into the lockfile so non-owners can find
/// the owner's API — diagnostics and routing only; the *claim* is the
/// `flock`, never the file's content.
pub fn claim_writer(db_path: &Path, owner: &WriterOwner) -> Option<WriterLock> {
    let path = writer_lock_path(db_path);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let file = match OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
    {
        Ok(f) => f,
        Err(err) => {
            tracing_warn(&format!(
                "cannot open writer lockfile {}: {err}",
                path.display()
            ));
            return None;
        }
    };
    if flock(&file, libc::LOCK_EX | libc::LOCK_NB).is_err() {
        return None;
    }
    let mut lock = WriterLock { file, path };
    lock.publish(owner);
    Some(lock)
}

impl WriterLock {
    /// Re-publish the holder's identity when the lockfile content has
    /// drifted from it (a failed publish at claim time — disk pressure is
    /// likeliest exactly when ownership just changed hands — or a torn
    /// write). The claim itself is the flock; this heals only the routing
    /// hint non-owners read. Cheap no-op when the content already matches,
    /// so it is safe to call on every maintenance tick.
    pub fn republish(&mut self, owner: &WriterOwner) {
        let current = std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|t| serde_json::from_str::<WriterOwner>(t.trim()).ok());
        if current.as_ref() == Some(owner) {
            return;
        }
        self.publish(owner);
    }

    /// Overwrite the lockfile content with the holder's identity. Failures
    /// are non-fatal: the claim is the lock, not the bytes.
    fn publish(&mut self, owner: &WriterOwner) {
        let bytes = match serde_json::to_vec(owner) {
            Ok(b) => b,
            Err(_) => return,
        };
        let write = self
            .file
            .set_len(0)
            .and_then(|()| self.file.seek(SeekFrom::Start(0)))
            .and_then(|_| self.file.write_all(&bytes))
            .and_then(|()| self.file.write_all(b"\n"))
            .and_then(|()| self.file.sync_data());
        if let Err(err) = write {
            tracing_warn(&format!(
                "cannot publish writer identity to {}: {err}",
                self.path.display()
            ));
        }
    }
}

/// Read the published owner identity for `db_path`, or `None` when no
/// claim has ever been published (or the content is unreadable).
pub fn read_writer_owner(db_path: &Path) -> Option<WriterOwner> {
    let text = std::fs::read_to_string(writer_lock_path(db_path)).ok()?;
    serde_json::from_str(text.trim()).ok()
}

fn flock(file: &File, op: i32) -> std::io::Result<()> {
    // SAFETY: `as_raw_fd` is a valid borrowed fd for the life of `file`;
    // `flock` records the lock in the kernel and does not retain the fd.
    let ret = unsafe { libc::flock(file.as_raw_fd(), op) };
    if ret == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// tugcore carries no tracing dependency; ledger-claim problems are rare
/// and worth seeing, so they go to stderr where the host log captures them.
fn tracing_warn(message: &str) {
    eprintln!("tugcore::ledger_db: {message}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_applies_unified_pragmas() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(dir.path().join("x.db")).unwrap();
        let journal: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(journal, "wal");
        let busy: i64 = conn
            .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
            .unwrap();
        assert_eq!(busy, 5000);
        let sync: i64 = conn
            .query_row("PRAGMA synchronous", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sync, 1, "NORMAL");
        let cell: i64 = conn
            .query_row("PRAGMA cell_size_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cell, 1);
    }

    #[test]
    fn attach_brings_sibling_to_wal() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(dir.path().join("main.db")).unwrap();
        attach(&conn, "changes", &dir.path().join("changes.db")).unwrap();
        let journal: String = conn
            .query_row("PRAGMA changes.journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(journal, "wal");
    }

    #[test]
    fn read_only_attach_reads_but_refuses_writes() {
        let dir = tempfile::tempdir().unwrap();
        // A path with characters that must survive URI encoding.
        let shared = dir.path().join("has space+hash#/changes.db");
        std::fs::create_dir_all(shared.parent().unwrap()).unwrap();
        {
            let writer = open(&shared).unwrap();
            writer
                .execute_batch("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('seed');")
                .unwrap();
        }
        let conn = open(dir.path().join("main.db")).unwrap();
        attach_read_only(&conn, "changes", &shared).unwrap();
        let seen: String = conn
            .query_row("SELECT v FROM changes.t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(seen, "seed");
        let write = conn.execute("INSERT INTO changes.t VALUES ('nope')", []);
        assert!(write.is_err(), "read-only attach must refuse writes");
    }

    fn owner(port: u16) -> WriterOwner {
        WriterOwner {
            instance_id: "test".into(),
            pid: std::process::id() as i32,
            port,
        }
    }

    #[test]
    fn one_claim_at_a_time_and_drop_releases() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("changes.db");
        let first = claim_writer(&db, &owner(1)).expect("first claim");
        assert!(
            claim_writer(&db, &owner(2)).is_none(),
            "a second claim must fail while the first is held"
        );
        assert_eq!(read_writer_owner(&db).unwrap().port, 1);
        drop(first);
        let second = claim_writer(&db, &owner(2)).expect("claim after release");
        assert_eq!(read_writer_owner(&db).unwrap().port, 2);
        assert_eq!(second.path(), writer_lock_path(&db));
    }

    #[test]
    fn owner_is_unreadable_before_any_claim() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_writer_owner(&dir.path().join("changes.db")).is_none());
    }

    /// The enforcement half of the chokepoint: no production source in the
    /// workspace may call `Connection::open(` directly — writable ad-hoc
    /// opens are exactly how a divergent configuration reaches a shared
    /// WAL database. Read-only opens (`open_with_flags` + READ_ONLY),
    /// in-memory opens, and `#[cfg(test)]` code are exempt.
    #[test]
    fn no_ad_hoc_ledger_opens() {
        let crates_root = crate::source_scan::crates_root();
        let mut offenders = Vec::new();
        for (path, production) in crate::source_scan::production_sources() {
            // The chokepoint itself.
            if path == crates_root.join("tugcore/src/ledger_db.rs") {
                continue;
            }
            // The integrity prober's quick_check open is deliberately
            // raw (it must open a possibly-corrupt file without side
            // effects) — exactly ONE raw open is sanctioned there,
            // zero anywhere else. A count, not a whole-file skip, so
            // a future ad-hoc open added to that file is still caught.
            let allowed_raw =
                usize::from(path == crates_root.join("tugcast/src/ledger_integrity.rs"));
            if production.matches("Connection::open(").count() > allowed_raw {
                offenders.push(path.display().to_string());
            }
            // A writable `open_with_flags` is the same bypass wearing
            // different clothes; only READ_ONLY opens are exempt.
            for (idx, _) in production.match_indices("Connection::open_with_flags(") {
                let window = &production[idx..production.len().min(idx + 300)];
                if !window.contains("READ_ONLY") {
                    offenders.push(format!("{} (writable open_with_flags)", path.display()));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "ad-hoc `Connection::open(` outside tugcore::ledger_db — route these through the chokepoint: {offenders:#?}"
        );
    }

    /// The sibling of `no_ad_hoc_ledger_opens` for the migration loop: no
    /// production source may write a `user_version` except [`migrate`]. A
    /// hand-rolled stamp is how a ledger grows its own loop again, with its
    /// own idea of what a newer version means. rusqlite writes a pragma by
    /// its bare name (`pragma_update(…, "user_version", …)`) and SQL by
    /// assignment (`user_version = …`); reads are spelled `PRAGMA
    /// user_version` and pass. `#[cfg(test)]` code is exempt, because a test
    /// stamping a version is how a test sets up a database a newer build
    /// left behind.
    #[test]
    fn no_ad_hoc_user_version_writes() {
        let crates_root = crate::source_scan::crates_root();
        let mut offenders = Vec::new();
        for (path, production) in crate::source_scan::production_sources() {
            if path == crates_root.join("tugcore/src/ledger_db.rs") {
                continue;
            }
            let assigns = production
                .match_indices("user_version")
                .any(|(idx, m)| production[idx + m.len()..].trim_start().starts_with('='));
            if production.contains("\"user_version\"") || assigns {
                offenders.push(path.display().to_string());
            }
        }
        assert!(
            offenders.is_empty(),
            "`user_version` written outside tugcore::ledger_db::migrate — bring the schema up through it: {offenders:#?}"
        );
    }

    const SCHEMA_V3: &str = "CREATE TABLE IF NOT EXISTS t (a TEXT, b TEXT, c TEXT);";

    fn schema_v3() -> LedgerSchema<'static> {
        LedgerSchema {
            db: rusqlite::DatabaseName::Main,
            version: 3,
            migrations: &[
                (1, "ALTER TABLE t ADD COLUMN b TEXT;"),
                (2, "ALTER TABLE t ADD COLUMN c TEXT;"),
            ],
            already_applied: |err| err.to_string().contains("duplicate column name"),
        }
    }

    fn version(conn: &Connection, db: &str) -> i64 {
        conn.query_row(&format!("PRAGMA {db}.user_version"), [], |r| r.get(0))
            .unwrap()
    }

    fn columns(conn: &Connection) -> Vec<String> {
        let mut stmt = conn.prepare("PRAGMA table_info(t)").unwrap();
        stmt.query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    fn create_v3(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute_batch(SCHEMA_V3)
    }

    #[test]
    fn migrate_creates_and_stamps_a_fresh_database() {
        let conn = Connection::open_in_memory().unwrap();
        assert_eq!(
            migrate(&conn, &schema_v3(), create_v3).unwrap(),
            Migrated::Current
        );
        assert_eq!(version(&conn, "main"), 3);
        assert_eq!(columns(&conn), ["a", "b", "c"]);
    }

    #[test]
    fn migrate_applies_only_the_migrations_above_the_version_on_disk() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (a TEXT, b TEXT); PRAGMA user_version = 2;")
            .unwrap();
        assert_eq!(
            migrate(&conn, &schema_v3(), create_v3).unwrap(),
            Migrated::Current
        );
        assert_eq!(version(&conn, "main"), 3);
        assert_eq!(columns(&conn), ["a", "b", "c"]);
    }

    #[test]
    fn migrate_absorbs_a_migration_that_already_ran() {
        // The crash-between-DDL-and-stamp shape: the column is there, the
        // stamp is not.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (a TEXT, b TEXT, c TEXT); PRAGMA user_version = 2;")
            .unwrap();
        assert_eq!(
            migrate(&conn, &schema_v3(), create_v3).unwrap(),
            Migrated::Current
        );
        assert_eq!(version(&conn, "main"), 3);
    }

    #[test]
    fn migrate_refuses_a_newer_version_and_touches_nothing() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA user_version = 9;").unwrap();
        let mut created = false;
        let outcome = migrate(&conn, &schema_v3(), |_| {
            created = true;
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
        assert_eq!(outcome, Migrated::TooNew { on_disk: 9 });
        assert!(!created, "a newer schema must not be created over");
        assert_eq!(version(&conn, "main"), 9);
    }

    #[test]
    fn migrate_rolls_back_to_the_version_it_found_on_failure() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (a TEXT); PRAGMA user_version = 1;")
            .unwrap();
        let err = migrate(&conn, &schema_v3(), |conn| {
            conn.execute_batch("CREATE TABLE half (x TEXT); NOT SQL;")
        });
        assert!(err.is_err());
        assert_eq!(version(&conn, "main"), 1);
        assert_eq!(
            columns(&conn),
            ["a"],
            "the applied migration rolls back with the failure"
        );
        let half: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'half'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(half, 0);
    }

    #[test]
    fn migrate_stamps_the_attached_database_it_names() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(dir.path().join("main.db")).unwrap();
        attach(&conn, "side", &dir.path().join("side.db")).unwrap();
        let schema = LedgerSchema {
            db: rusqlite::DatabaseName::Attached("side"),
            version: 2,
            migrations: &[],
            already_applied: no_migration_error_absorbed,
        };
        migrate(&conn, &schema, |conn| {
            conn.execute_batch("CREATE TABLE IF NOT EXISTS side.t (a TEXT);")
        })
        .unwrap();
        assert_eq!(version(&conn, "side"), 2);
        assert_eq!(version(&conn, "main"), 0);
    }
}
