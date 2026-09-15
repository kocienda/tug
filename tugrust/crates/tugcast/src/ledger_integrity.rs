//! Open-time integrity gate for the ledger databases.
//!
//! Every on-disk ledger open (`sessions.db`, the attached machine-global
//! `changes.db`, `shell_exchanges.db`) passes through [`integrity_gate`]
//! before the real connection is made. The gate runs `PRAGMA quick_check`
//! on the file; a database that fails is **quarantined** — the db and its
//! `-wal`/`-shm` siblings are renamed to `<name>.corrupt-<epoch-ms>` so no
//! writer ever adds rows to a structurally damaged tree again — and the
//! caller proceeds against a fresh file. After the fresh schema is
//! bootstrapped, [`salvage_into`] copies every readable row back from the
//! quarantined file, table by table, tolerating mid-scan corruption errors.
//!
//! The gate uses the same bundled rusqlite build as every legitimate
//! writer, so the probe connection participates in ordinary WAL recovery.
//! Quarantine renames are safe against a still-running older process: that
//! process keeps its open file descriptors to the renamed inodes and its
//! writes land in the quarantined file, never the fresh one. Two processes
//! racing the gate is also safe — the loser's rename fails with `NotFound`
//! and it simply opens the fresh file the winner left behind.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use rusqlite::types::Value;

/// Process-global ledger health — the runtime corruption guard.
///
/// Any statement that fails with a corruption-class SQLite error
/// (`SQLITE_CORRUPT` / `SQLITE_NOTADB`) latches the process into a
/// degraded state via [`health::note_error`]. The flag rides outbound
/// snapshots (`WorkspacesChangesetSnapshot::ledger_degraded`) so the deck
/// can say "the ledger is damaged" instead of misreporting damage as an
/// empty result — the 2026-07-27 incident surfaced as "no session claims
/// these" for three days because reads failed silently.
pub mod health {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    static DEGRADED: AtomicBool = AtomicBool::new(false);
    static ANNOUNCED: Mutex<Vec<String>> = Mutex::new(Vec::new());

    /// Inspect a ledger operation error; latch degraded (and error-log,
    /// once per ledger label) when it is corruption-class. Non-corruption
    /// errors are the caller's business and are ignored here.
    pub fn note_error(ledger: &str, err: &crate::session_ledger::LedgerError) {
        let crate::session_ledger::LedgerError::Sqlite(sqlite_err) = err else {
            return;
        };
        note_sqlite_error(ledger, sqlite_err);
    }

    /// [`note_error`] for a raw rusqlite error.
    pub fn note_sqlite_error(ledger: &str, err: &rusqlite::Error) {
        let corruption = matches!(
            err,
            rusqlite::Error::SqliteFailure(e, _)
                if matches!(
                    e.code,
                    rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase
                )
        );
        if !corruption {
            return;
        }
        DEGRADED.store(true, Ordering::Relaxed);
        let mut announced = ANNOUNCED.lock().expect("health mutex poisoned");
        if !announced.iter().any(|l| l == ledger) {
            announced.push(ledger.to_string());
            tracing::error!(
                ledger,
                error = %err,
                "ledger statement hit database corruption — process degraded; restart to trigger quarantine and rebuild"
            );
        }
    }

    /// Latch degraded for a non-SQLite reason the deck must still be
    /// honest about — a forwarded write that could not be delivered means
    /// attribution claims are incomplete, not empty. Logged once per
    /// `reason`.
    pub fn note_degraded(reason: &str) {
        DEGRADED.store(true, Ordering::Relaxed);
        let mut announced = ANNOUNCED.lock().expect("health mutex poisoned");
        if !announced.iter().any(|l| l == reason) {
            announced.push(reason.to_string());
            tracing::error!(
                reason,
                "changes ledger degraded — some attribution writes have not landed"
            );
        }
    }

    /// True once any ledger statement has hit corruption in this process.
    pub fn is_degraded() -> bool {
        DEGRADED.load(Ordering::Relaxed)
    }

    #[cfg(test)]
    pub fn reset_for_test() {
        DEGRADED.store(false, Ordering::Relaxed);
        ANNOUNCED.lock().expect("health mutex poisoned").clear();
    }
}

/// Result of gating one database file.
#[derive(Debug)]
pub enum GateOutcome {
    /// The file is absent (fresh create) or passed `quick_check`.
    Healthy,
    /// The file failed `quick_check` (or was unreadable as a database) and
    /// was renamed aside; `corrupt_path` is where the damaged file now
    /// lives, for salvage and forensics.
    Quarantined { corrupt_path: PathBuf },
}

/// Gate `db_path` before opening it for real. Never returns an error: a
/// database that cannot be verified is treated as corrupt and quarantined,
/// and a quarantine that cannot be performed (rename raced by a sibling
/// process) degrades to `Healthy` so startup proceeds against whatever the
/// winner left in place.
///
/// Contention is NOT corruption: a probe that fails with a busy/locked
/// error (a sibling process mid-bootstrap or mid-checkpoint — observed
/// racing two instances at launch on 2026-07-27) passes as `Healthy`; the
/// real open's own `busy_timeout` handles the wait.
pub fn integrity_gate(db_path: &Path, label: &str) -> GateOutcome {
    if !db_path.exists() {
        return GateOutcome::Healthy;
    }
    match quick_check(db_path) {
        Ok(None) => GateOutcome::Healthy,
        Ok(Some(detail)) => quarantine(db_path, label, &detail),
        Err(err) if is_contention(&err) => {
            tracing::warn!(
                ledger = label,
                error = %err,
                "integrity probe hit lock contention; treating as healthy and proceeding"
            );
            GateOutcome::Healthy
        }
        Err(err) if is_corruption(&err) => {
            quarantine(db_path, label, &format!("unopenable: {err}"))
        }
        Err(err) => {
            // An IO error, permissions problem, or disk-pressure hiccup
            // says "cannot verify", not "corrupt" — quarantining a
            // healthy database over a transient probe failure would be
            // self-inflicted data loss. Leave the file alone; the real
            // open fails loudly if the problem is real.
            tracing::warn!(
                ledger = label,
                error = %err,
                "integrity probe failed for a non-corruption reason; leaving the database untouched"
            );
            GateOutcome::Healthy
        }
    }
}

/// Busy/locked-class errors — a sibling holds the file, which says nothing
/// about its integrity.
fn is_contention(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(e, _)
            if matches!(
                e.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            )
    )
}

/// Corruption-class errors — the file's *content* is damaged, which is
/// what quarantine exists for. Everything else (IO, permissions) is an
/// environmental failure that must never trigger it.
fn is_corruption(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(e, _)
            if matches!(
                e.code,
                rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase
            )
    )
}

/// Run `PRAGMA quick_check(1)` on the file. `Ok(None)` means healthy;
/// `Ok(Some(detail))` carries the first corruption complaint.
fn quick_check(db_path: &Path) -> Result<Option<String>, rusqlite::Error> {
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "busy_timeout", 5000i64)?;
    let verdict: String = conn.query_row("PRAGMA quick_check(1)", [], |r| r.get(0))?;
    if verdict == "ok" {
        Ok(None)
    } else {
        Ok(Some(verdict))
    }
}

/// Rename the db and its WAL/shm siblings aside. The three files must move
/// together: a stale `-wal` left beside a fresh db would be replayed into
/// it on the next open, re-importing the damage.
fn quarantine(db_path: &Path, label: &str, detail: &str) -> GateOutcome {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let suffix = format!("corrupt-{ms}");
    let corrupt_path = sibling_with_suffix(db_path, &suffix, "");
    tracing::error!(
        ledger = label,
        db = %db_path.display(),
        quarantine = %corrupt_path.display(),
        detail,
        "ledger database failed integrity check; quarantining and rebuilding"
    );
    // The WAL/shm siblings move FIRST: if the db were renamed and a
    // sibling then refused to move, the fresh database bootstrapped in
    // its place would sit beside a stale `-wal` and replay the damage
    // right back in on the next open. A sibling that can be neither
    // moved nor deleted aborts the quarantine outright — an honest
    // degraded state beats a rebuilt db with a poisoned WAL.
    for ext in ["-wal", "-shm"] {
        let side = path_with_appended(db_path, ext);
        if !side.exists() {
            continue;
        }
        let dest = sibling_with_suffix(db_path, &suffix, ext);
        if std::fs::rename(&side, &dest).is_ok() {
            continue;
        }
        if let Err(err) = std::fs::remove_file(&side) {
            tracing::error!(
                ledger = label,
                file = %side.display(),
                error = %err,
                "cannot move or delete a WAL/shm sibling; aborting quarantine"
            );
            health::note_degraded("quarantine-blocked");
            return GateOutcome::Healthy;
        }
        tracing::warn!(
            ledger = label,
            file = %side.display(),
            "WAL/shm sibling could not be renamed into quarantine; deleted instead (db is quarantined whole)"
        );
    }
    if let Err(err) = std::fs::rename(db_path, &corrupt_path) {
        // A sibling process won the quarantine race (or the file vanished);
        // open whatever is now in place.
        tracing::warn!(
            ledger = label,
            error = %err,
            "quarantine rename raced or failed; proceeding with the file now in place"
        );
        return GateOutcome::Healthy;
    }
    GateOutcome::Quarantined { corrupt_path }
}

/// `<db>.corrupt-<ms><ext>` — quarantine name for the db or a sibling.
fn sibling_with_suffix(db_path: &Path, suffix: &str, ext: &str) -> PathBuf {
    let mut name = db_path.as_os_str().to_owned();
    name.push(".");
    name.push(suffix);
    name.push(ext);
    PathBuf::from(name)
}

/// `<db><ext>` — the WAL/shm sibling of a database path.
fn path_with_appended(db_path: &Path, ext: &str) -> PathBuf {
    let mut name = db_path.as_os_str().to_owned();
    name.push(ext);
    PathBuf::from(name)
}

/// Best-effort row salvage from a quarantined database into the freshly
/// bootstrapped one. `conn` is the live ledger connection whose `schema`
/// (`"main"` or an attach name like `"changes"`) already holds the current
/// tables; for each name in `tables` present in both databases, every row
/// readable before the scan hits damage is copied with `INSERT OR IGNORE`
/// over the intersection of column names. Returns the number of rows
/// copied. Never fails the open: any error simply ends that table's scan.
pub fn salvage_into(
    conn: &Connection,
    schema: &str,
    corrupt_path: &Path,
    tables: &[&str],
    label: &str,
) -> usize {
    let attach = format!(
        "ATTACH DATABASE '{}' AS salvage_src",
        corrupt_path.display().to_string().replace('\'', "''")
    );
    if let Err(err) = conn.execute_batch(&attach) {
        tracing::warn!(ledger = label, error = %err, "cannot attach quarantined db for salvage");
        return 0;
    }
    let mut total = 0usize;
    for table in tables {
        match salvage_table(conn, schema, table) {
            Ok(count) => {
                total += count;
                tracing::info!(
                    ledger = label,
                    table,
                    rows = count,
                    "salvaged rows from quarantined db"
                );
            }
            Err(err) => {
                tracing::warn!(ledger = label, table, error = %err, "salvage scan ended early");
            }
        }
    }
    let _ = conn.execute_batch("DETACH DATABASE salvage_src");
    tracing::error!(
        ledger = label,
        rows = total,
        corrupt = %corrupt_path.display(),
        "ledger rebuilt after quarantine; salvaged rows re-inserted (quarantined file kept for forensics)"
    );
    total
}

/// Copy one table's readable rows. Errors mid-scan (the corrupt page) end
/// the scan but keep every row already copied.
fn salvage_table(conn: &Connection, schema: &str, table: &str) -> Result<usize, rusqlite::Error> {
    let cols = common_columns(conn, schema, table)?;
    if cols.is_empty() {
        return Ok(0);
    }
    let col_list = cols.join(", ");
    let placeholders = (1..=cols.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut read = conn.prepare(&format!("SELECT {col_list} FROM salvage_src.\"{table}\""))?;
    let mut write = conn.prepare(&format!(
        "INSERT OR IGNORE INTO {schema}.\"{table}\" ({col_list}) VALUES ({placeholders})"
    ))?;
    let mut rows = read.query([])?;
    let mut copied = 0usize;
    loop {
        match rows.next() {
            Ok(Some(row)) => {
                let mut values = Vec::with_capacity(cols.len());
                for i in 0..cols.len() {
                    values.push(row.get::<_, Value>(i)?);
                }
                if write.execute(rusqlite::params_from_iter(values))? > 0 {
                    copied += 1;
                }
            }
            Ok(None) => return Ok(copied),
            // The scan reached damage; keep what we have — but say so,
            // loudly: a scan that died at row 3 of 30,000 must never
            // read like a complete salvage in the logs.
            Err(err) if copied > 0 => {
                tracing::warn!(
                    table,
                    rows = copied,
                    error = %err,
                    "salvage scan hit damage mid-table; the salvaged row count is PARTIAL"
                );
                return Ok(copied);
            }
            Err(err) => return Err(err),
        }
    }
}

/// Column names present in both the live table and its quarantined
/// counterpart, in the live table's declared order — so a salvage across a
/// schema drift copies the shared shape instead of failing.
fn common_columns(
    conn: &Connection,
    schema: &str,
    table: &str,
) -> Result<Vec<String>, rusqlite::Error> {
    let live = table_columns(conn, schema, table)?;
    let old = table_columns(conn, "salvage_src", table)?;
    Ok(live.into_iter().filter(|c| old.contains(c)).collect())
}

pub(crate) fn table_columns(
    conn: &Connection,
    schema: &str,
    table: &str,
) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = conn.prepare(&format!("PRAGMA {schema}.table_info(\"{table}\")"))?;
    let cols = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(cols)
}

/// True when `err` is sqlite's `duplicate column name` — the answer a losing
/// racer gets from a self-healing `ALTER TABLE ADD COLUMN`.
pub(crate) fn is_duplicate_column(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(_, Some(msg)) if msg.starts_with("duplicate column name")
    )
}

/// How many snapshot backups to retain per database.
const BACKUP_RETAIN: usize = 5;

/// Take `VACUUM INTO` snapshot backups of the ledger databases into a
/// `backups/` directory beside each live file, retaining the newest
/// [`BACKUP_RETAIN`] per database. `targets` pairs the schema name on the
/// ledger connection (`"main"` / `"changes"`) with the live file path.
/// Failures are logged, never fatal — a backup pass must not take down
/// the server.
pub fn snapshot_backups(ledger: &crate::session_ledger::SessionLedger, targets: &[(&str, &Path)]) {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    for (db, live_path) in targets {
        let Some(parent) = live_path.parent() else {
            continue;
        };
        let Some(stem) = live_path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let backups = parent.join("backups");
        if let Err(err) = std::fs::create_dir_all(&backups) {
            tracing::warn!(dir = %backups.display(), error = %err, "cannot create ledger backups dir");
            continue;
        }
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        // Zero-padded so lexicographic name order is age order for prune.
        let dest = backups.join(format!("{stem}-{ms:013}-{seq:06}.db"));
        match ledger.snapshot_into(db, &dest) {
            Ok(()) => {
                tracing::info!(db, dest = %dest.display(), "ledger snapshot backup written")
            }
            Err(err) => {
                tracing::warn!(db, error = %err, "ledger snapshot backup failed");
                continue;
            }
        }
        prune_backups(&backups, stem);
    }
}

/// Keep only the newest [`BACKUP_RETAIN`] `<stem>-*.db` files in `dir`.
/// Name order is age order (epoch-ms + monotonic sequence in the name).
fn prune_backups(dir: &Path, stem: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let prefix = format!("{stem}-");
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(&prefix) && n.ends_with(".db"))
        .collect();
    names.sort();
    if names.len() <= BACKUP_RETAIN {
        return;
    }
    let excess = names.len() - BACKUP_RETAIN;
    for name in &names[..excess] {
        if let Err(err) = std::fs::remove_file(dir.join(name)) {
            tracing::warn!(file = name, error = %err, "cannot prune old ledger backup");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Seek, SeekFrom, Write};

    fn make_db(path: &Path, rows: usize) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT NOT NULL);",
        )
        .unwrap();
        for i in 0..rows {
            conn.execute(
                "INSERT INTO t (id, body) VALUES (?1, ?2)",
                rusqlite::params![i as i64, format!("row-{i}-{}", "x".repeat(64))],
            )
            .unwrap();
        }
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
    }

    #[test]
    fn health_latches_on_corruption_class_errors_only() {
        use crate::session_ledger::LedgerError;
        health::reset_for_test();
        assert!(!health::is_degraded());
        // A non-corruption sqlite error (busy) must not trip the alarm.
        let busy = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
            None,
        );
        health::note_error("test", &LedgerError::Sqlite(busy));
        assert!(!health::is_degraded());
        // SQLITE_CORRUPT latches degraded.
        let corrupt = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CORRUPT),
            None,
        );
        health::note_error("test", &LedgerError::Sqlite(corrupt));
        assert!(health::is_degraded());
        health::reset_for_test();
        assert!(!health::is_degraded());
    }

    #[test]
    fn healthy_db_passes_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("x.db");
        make_db(&db, 5);
        assert!(matches!(integrity_gate(&db, "test"), GateOutcome::Healthy));
        assert!(db.exists());
    }

    #[test]
    fn absent_db_is_healthy() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            integrity_gate(&dir.path().join("missing.db"), "test"),
            GateOutcome::Healthy
        ));
    }

    #[test]
    fn locked_db_is_not_quarantined() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("x.db");
        make_db(&db, 5);
        // Hold an exclusive lock the way a sibling mid-bootstrap would.
        let holder = Connection::open(&db).unwrap();
        holder
            .execute_batch(
                "PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE lockholder (x);",
            )
            .unwrap();
        // Probe with no patience so the test doesn't sit in busy_timeout:
        // the gate itself sets a 5s timeout, so simulate the outcome by
        // classifying the error the probe would return.
        let busy = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
            None,
        );
        assert!(is_contention(&busy));
        let locked = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_LOCKED),
            None,
        );
        assert!(is_contention(&locked));
        let corrupt = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CORRUPT),
            None,
        );
        assert!(!is_contention(&corrupt));
        drop(holder);
        // With the lock released the gate sees a healthy file, untouched.
        assert!(matches!(integrity_gate(&db, "test"), GateOutcome::Healthy));
        assert!(db.exists());
    }

    /// An environmental probe failure (here: permissions) must never
    /// quarantine — "cannot verify" is not "corrupt", and renaming a
    /// healthy database aside over a transient IO problem would be
    /// self-inflicted data loss.
    #[cfg(unix)]
    #[test]
    fn an_unreadable_but_intact_db_is_not_quarantined() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            return; // root ignores file modes; the scenario can't exist
        }
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("x.db");
        make_db(&db, 10);
        std::fs::set_permissions(&db, std::fs::Permissions::from_mode(0o000)).unwrap();
        let outcome = integrity_gate(&db, "test");
        std::fs::set_permissions(&db, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            matches!(outcome, GateOutcome::Healthy),
            "expected the file left untouched, got {outcome:?}"
        );
        assert!(db.exists(), "the database must not be renamed aside");
    }

    #[test]
    fn garbage_file_is_quarantined() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("x.db");
        std::fs::write(&db, b"this is not a sqlite database at all").unwrap();
        let outcome = integrity_gate(&db, "test");
        let GateOutcome::Quarantined { corrupt_path } = outcome else {
            panic!("expected quarantine, got {outcome:?}");
        };
        assert!(!db.exists(), "corrupt file must be moved aside");
        assert!(corrupt_path.exists());
    }

    #[test]
    fn scribbled_pages_are_quarantined_with_wal_siblings() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("x.db");
        make_db(&db, 200);
        // Corrupt interior pages, sparing the header so the file still
        // opens as a database and quick_check itself must find the damage.
        let mut f = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&db)
            .unwrap();
        let len = f.metadata().unwrap().len();
        assert!(len > 8192, "test db too small to scribble safely");
        f.seek(SeekFrom::Start(4096 + 32)).unwrap();
        f.write_all(&[0xAB; 512]).unwrap();
        f.seek(SeekFrom::Start(len - 2048)).unwrap();
        f.write_all(&[0xCD; 1024]).unwrap();
        drop(f);
        // Plant WAL/shm siblings to verify they travel with the db.
        std::fs::write(dir.path().join("x.db-wal"), b"stale").unwrap();
        std::fs::write(dir.path().join("x.db-shm"), b"stale").unwrap();

        let outcome = integrity_gate(&db, "test");
        let GateOutcome::Quarantined { corrupt_path } = outcome else {
            // If sqlite silently accepted the scribble, the test db shape
            // needs adjusting — fail loudly rather than pass vacuously.
            panic!("expected quarantine, got {outcome:?}");
        };
        assert!(!db.exists());
        assert!(corrupt_path.exists());
        assert!(
            !dir.path().join("x.db-wal").exists(),
            "wal must be quarantined too"
        );
        assert!(
            !dir.path().join("x.db-shm").exists(),
            "shm must be quarantined too"
        );
    }

    #[test]
    fn snapshot_backups_write_and_prune() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions.db");
        let ledger = crate::session_ledger::SessionLedger::open_with_claude_root(
            &sessions,
            std::path::PathBuf::from("/tmp/tugcast-tests-no-trash"),
        )
        .unwrap();
        let changes = dir.path().join("sessions.db.changes");
        for _ in 0..(BACKUP_RETAIN + 2) {
            snapshot_backups(
                &ledger,
                &[("main", sessions.as_path()), ("changes", changes.as_path())],
            );
        }
        let backups = dir.path().join("backups");
        let names: Vec<String> = std::fs::read_dir(&backups)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        let sessions_count = names
            .iter()
            .filter(|n| n.starts_with("sessions.db-"))
            .count();
        assert_eq!(
            sessions_count, BACKUP_RETAIN,
            "pruned to retention: {names:?}"
        );
        // Every surviving backup is a healthy, openable database.
        for name in names.iter().filter(|n| n.ends_with(".db")) {
            let verdict: String = Connection::open(backups.join(name))
                .unwrap()
                .query_row("PRAGMA quick_check(1)", [], |r| r.get(0))
                .unwrap();
            assert_eq!(verdict, "ok", "{name}");
        }
    }

    #[test]
    fn salvage_copies_readable_rows() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.db");
        make_db(&old, 50);

        let fresh = Connection::open(dir.path().join("fresh.db")).unwrap();
        fresh
            .execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT NOT NULL);")
            .unwrap();
        let copied = salvage_into(&fresh, "main", &old, &["t", "not_a_table"], "test");
        assert_eq!(copied, 50);
        let n: i64 = fresh
            .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 50);
        // Re-running is idempotent (INSERT OR IGNORE on the same PKs).
        let again = salvage_into(&fresh, "main", &old, &["t"], "test");
        assert_eq!(again, 0);
    }

    #[test]
    fn salvage_survives_schema_drift() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.db");
        let conn = Connection::open(&old).unwrap();
        conn.execute_batch(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT NOT NULL, legacy TEXT);
             INSERT INTO t VALUES (1, 'a', 'x'), (2, 'b', 'y');",
        )
        .unwrap();
        drop(conn);

        let fresh = Connection::open(dir.path().join("fresh.db")).unwrap();
        fresh
            .execute_batch(
                "CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT NOT NULL, added INTEGER DEFAULT 7);",
            )
            .unwrap();
        let copied = salvage_into(&fresh, "main", &old, &["t"], "test");
        assert_eq!(copied, 2);
        let body: String = fresh
            .query_row("SELECT body FROM t WHERE id = 2", [], |r| r.get(0))
            .unwrap();
        assert_eq!(body, "b");
    }

    #[test]
    fn quarantined_db_with_readable_prefix_salvages_partially() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("x.db");
        make_db(&db, 400);
        // Damage the tail of the table's btree; early pages stay readable.
        let mut f = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&db)
            .unwrap();
        let len = f.metadata().unwrap().len();
        f.seek(SeekFrom::Start(len - 4096)).unwrap();
        let mut buf = vec![0u8; 4096];
        f.read_exact(&mut buf).unwrap();
        f.seek(SeekFrom::Start(len - 4096 + 16)).unwrap();
        f.write_all(&[0xEE; 256]).unwrap();
        drop(f);

        let fresh = Connection::open(dir.path().join("fresh.db")).unwrap();
        fresh
            .execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT NOT NULL);")
            .unwrap();
        // Whatever the damage did, salvage must not error out of the open
        // path; it copies zero or more rows and returns.
        let copied = salvage_into(&fresh, "main", &db, &["t"], "test");
        let n: i64 = fresh
            .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(copied as i64, n);
    }
}
