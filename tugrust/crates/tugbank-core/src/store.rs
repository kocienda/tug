//! DefaultsStore struct and implementation.

use parking_lot::Mutex;
use std::path::Path;

use rusqlite::Connection;

use crate::Error;
use crate::domain::DomainHandle;
use crate::schema::{apply_pragmas, migrate_schema};

/// A SQLite-backed typed defaults store.
///
/// `DefaultsStore` wraps a `rusqlite::Connection` in a `Mutex` to provide
/// `Send + Sync` access. All domain operations go through a [`DomainHandle`]
/// obtained via [`domain`](DefaultsStore::domain).
///
/// # Example
///
/// ```no_run
/// use tugbank_core::{DefaultsStore, Value};
///
/// let store = DefaultsStore::open("/path/to/bank.db").unwrap();
/// let handle = store.domain("com.example.prefs").unwrap();
/// handle.set("theme", Value::String("dark".into())).unwrap();
/// ```
pub struct DefaultsStore {
    pub(crate) conn: Mutex<Connection>,
}

// Compile-time assertion that DefaultsStore is Send + Sync.
const _: () = {
    fn _assert_send_sync<T: Send + Sync>() {}
    fn _check() {
        _assert_send_sync::<DefaultsStore>();
    }
};

impl DefaultsStore {
    /// Open or create a tugbank database at the given path.
    ///
    /// Applies pragmas (`journal_mode=WAL`, `foreign_keys=ON`,
    /// `busy_timeout=5000`, `synchronous=NORMAL`) and bootstraps or
    /// migrates the schema. Safe to call on an already-open database.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, Error> {
        let conn = tugcore::ledger_db::open(path)?;
        apply_pragmas(&conn)?;
        migrate_schema(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Get a handle to a specific domain.
    ///
    /// The domain row is created lazily on first write.
    /// Returns [`Error::InvalidDomain`] if `name` is empty.
    pub fn domain(&self, name: &str) -> Result<DomainHandle<'_>, Error> {
        if name.is_empty() {
            return Err(Error::InvalidDomain(name.to_owned()));
        }
        Ok(DomainHandle {
            store: self,
            domain: name.to_owned(),
        })
    }

    /// List all domain names that have at least one write in the database.
    ///
    /// Returns an empty `Vec` for a fresh database.
    pub fn list_domains(&self) -> Result<Vec<String>, Error> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT name FROM domains ORDER BY name")?;
        let names = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(names)
    }

    /// Delete an entire domain: remove all entries and the domain row.
    ///
    /// Returns `true` if the domain existed and was deleted, `false` if it did
    /// not exist. Entries are removed automatically via `ON DELETE CASCADE` on
    /// the `entries.domain` foreign key.
    ///
    /// Returns [`Error::InvalidDomain`] if `name` is empty.
    pub fn delete_domain(&self, name: &str) -> Result<bool, Error> {
        if name.is_empty() {
            return Err(Error::InvalidDomain(name.to_owned()));
        }
        let mut conn = self.conn.lock();
        let txn = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let affected = txn.execute(
            "DELETE FROM domains WHERE name = ?1",
            rusqlite::params![name],
        )?;
        txn.commit()?;
        Ok(affected > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    fn temp_store() -> (DefaultsStore, NamedTempFile) {
        let tmp = NamedTempFile::new().expect("temp file failed");
        let store = DefaultsStore::open(tmp.path()).expect("open failed");
        (store, tmp)
    }

    #[test]
    fn test_open_creates_new_database_file() {
        let tmp = NamedTempFile::new().expect("temp file failed");
        let store = DefaultsStore::open(tmp.path());
        assert!(store.is_ok(), "open should succeed for a new path");
    }

    #[test]
    fn test_open_existing_database_succeeds() {
        let tmp = NamedTempFile::new().expect("temp file failed");
        // First open bootstraps schema.
        DefaultsStore::open(tmp.path()).expect("first open failed");
        // Second open should re-apply pragmas and migrate without error.
        let result = DefaultsStore::open(tmp.path());
        assert!(result.is_ok(), "second open should succeed");
    }

    #[test]
    fn test_list_domains_empty_on_fresh_db() {
        let (store, _tmp) = temp_store();
        let domains = store.list_domains().expect("list_domains failed");
        assert!(
            domains.is_empty(),
            "fresh database should have no domains, got: {domains:?}"
        );
    }

    #[test]
    fn test_domain_returns_handle_for_valid_name() {
        let (store, _tmp) = temp_store();
        let result = store.domain("com.example.prefs");
        assert!(result.is_ok(), "domain() should succeed for a valid name");
    }

    #[test]
    fn test_domain_empty_string_returns_invalid_domain() {
        let (store, _tmp) = temp_store();
        let result = store.domain("");
        match result {
            Err(Error::InvalidDomain(name)) => {
                assert_eq!(name, "", "error should carry the rejected name");
            }
            other => panic!("expected InvalidDomain, got {other:?}"),
        }
    }

    #[test]
    fn test_defaults_store_is_send_sync() {
        // Compile-time check is in the const block above.
        // This test documents the requirement and fails if the const
        // block is removed.
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<DefaultsStore>();
    }

    // ── T01: delete_domain on domain with entries removes all data ────────────

    #[test]
    fn test_delete_domain_with_entries_returns_true_and_removes_all() {
        use crate::Value;
        let (store, _tmp) = temp_store();
        let handle = store.domain("com.example.test").unwrap();
        handle.set("key1", Value::String("hello".into())).unwrap();
        handle.set("key2", Value::I64(42)).unwrap();

        let result = store.delete_domain("com.example.test").unwrap();
        assert!(
            result,
            "delete_domain should return true for existing domain"
        );

        // Verify entries are gone via a fresh handle.
        let handle2 = store.domain("com.example.test").unwrap();
        assert_eq!(handle2.get("key1").unwrap(), None);
        assert_eq!(handle2.get("key2").unwrap(), None);
    }

    // ── T02: delete_domain on non-existent domain returns false ──────────────

    #[test]
    fn test_delete_domain_nonexistent_returns_false() {
        let (store, _tmp) = temp_store();
        let result = store.delete_domain("does.not.exist").unwrap();
        assert!(
            !result,
            "delete_domain should return false for nonexistent domain"
        );
    }

    // ── T03: delete_domain with empty string returns InvalidDomain ───────────

    #[test]
    fn test_delete_domain_empty_string_returns_invalid_domain() {
        let (store, _tmp) = temp_store();
        let err = store.delete_domain("").unwrap_err();
        assert!(
            matches!(err, Error::InvalidDomain(_)),
            "expected InvalidDomain, got {err:?}"
        );
    }

    // ── T04: After delete_domain, list_domains no longer includes deleted ─────

    #[test]
    fn test_delete_domain_removed_from_list_domains() {
        use crate::Value;
        let (store, _tmp) = temp_store();
        let handle = store.domain("to.delete").unwrap();
        handle.set("k", Value::Null).unwrap();

        // Domain should be listed before deletion.
        let before = store.list_domains().unwrap();
        assert!(
            before.contains(&"to.delete".to_owned()),
            "domain should exist before deletion"
        );

        store.delete_domain("to.delete").unwrap();

        // Domain should not appear after deletion.
        let after = store.list_domains().unwrap();
        assert!(
            !after.contains(&"to.delete".to_owned()),
            "domain should not exist after deletion: {after:?}"
        );
    }

    // ── T05: After delete_domain, get on former keys returns None ─────────────

    #[test]
    fn test_delete_domain_former_keys_return_none() {
        use crate::Value;
        let (store, _tmp) = temp_store();
        let handle = store.domain("d").unwrap();
        handle.set("x", Value::Bool(true)).unwrap();
        handle.set("y", Value::I64(100)).unwrap();

        store.delete_domain("d").unwrap();

        // Access via a new domain handle (re-opening the domain after deletion).
        let handle2 = store.domain("d").unwrap();
        assert_eq!(handle2.get("x").unwrap(), None);
        assert_eq!(handle2.get("y").unwrap(), None);
    }
}
