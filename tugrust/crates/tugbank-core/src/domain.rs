//! DomainHandle, DomainTxn, SetOutcome, and Mutation types.

use std::collections::BTreeMap;

use rusqlite::TransactionBehavior;

use crate::Error;
use crate::Value;
use crate::value::{check_blob_size, decode_value, encode_value};

/// Outcome of a `set_if_generation` operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetOutcome {
    /// The value was written successfully.
    Written,
    /// The write was rejected because the domain generation has changed.
    Conflict {
        /// The current generation at the time of the conflict.
        current_generation: u64,
    },
}

/// Internal representation of a queued mutation in a `DomainTxn`.
pub(crate) enum Mutation {
    Set { key: String, value: Value },
    Remove { key: String },
}

/// A write-only transaction buffer for atomic multi-key updates.
///
/// Created by [`DomainHandle::update`] and passed to the user closure.
/// Call [`set`](DomainTxn::set) and [`remove`](DomainTxn::remove) to
/// queue mutations; they are applied atomically when the closure returns `Ok`.
pub struct DomainTxn {
    pub(crate) mutations: Vec<Mutation>,
}

impl DomainTxn {
    pub(crate) fn new() -> Self {
        Self {
            mutations: Vec::new(),
        }
    }

    /// Queue a set operation. Enforces the 10 MB blob size limit.
    pub fn set(&mut self, key: &str, value: Value) -> Result<(), Error> {
        check_blob_size(&value)?;
        self.mutations.push(Mutation::Set {
            key: key.to_owned(),
            value,
        });
        Ok(())
    }

    /// Queue a remove operation.
    pub fn remove(&mut self, key: &str) {
        self.mutations.push(Mutation::Remove {
            key: key.to_owned(),
        });
    }
}

/// RFC 3339 timestamp for `updated_at` columns.
pub(crate) fn now_rfc3339() -> String {
    // chrono is not a dependency of this crate; use a simple UTC approximation
    // via std. We format as an ISO 8601 / RFC 3339 string using SystemTime.
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Format as YYYY-MM-DDTHH:MM:SSZ (UTC, second precision)
    let s = secs;
    let sec = s % 60;
    let min = (s / 60) % 60;
    let hour = (s / 3600) % 24;
    let days = s / 86400; // days since 1970-01-01
    // Compute year/month/day from days-since-epoch (proleptic Gregorian)
    let (year, month, day) = days_to_ymd(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}Z")
}

/// Convert days since Unix epoch to (year, month, day).
fn days_to_ymd(mut days: u64) -> (u64, u64, u64) {
    // Algorithm from http://howardhinnant.github.io/date_algorithms.html
    days += 719468;
    let era = days / 146097;
    let doe = days % 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// A handle to a specific domain within a [`DefaultsStore`](crate::DefaultsStore).
///
/// All read and write operations on a domain go through this handle.
/// The handle borrows the store and is scoped to a single domain name.
pub struct DomainHandle<'a> {
    pub(crate) store: &'a crate::DefaultsStore,
    pub(crate) domain: String,
}

impl std::fmt::Debug for DomainHandle<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DomainHandle")
            .field("domain", &self.domain)
            .finish_non_exhaustive()
    }
}

impl<'a> DomainHandle<'a> {
    /// Read a single key. Returns `None` if the key does not exist.
    ///
    /// Returns [`Error::InvalidKey`] if `key` is empty.
    pub fn get(&self, key: &str) -> Result<Option<Value>, Error> {
        if key.is_empty() {
            return Err(Error::InvalidKey(key.to_owned()));
        }
        let conn = self.store.conn.lock().unwrap();
        let mut stmt = conn.prepare_cached(
            "SELECT value_kind, value_i64, value_f64, value_text, value_blob \
             FROM entries WHERE domain = ?1 AND key = ?2",
        )?;
        let result = stmt.query_row(rusqlite::params![self.domain, key], |row| {
            Ok((
                row.get::<_, i32>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<f64>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<Vec<u8>>>(4)?,
            ))
        });
        match result {
            Ok((kind, i64v, f64v, textv, blobv)) => {
                Ok(Some(decode_value(kind, i64v, f64v, textv, blobv)?))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(Error::Sqlite(e)),
        }
    }

    /// List all keys in this domain, in sorted order.
    pub fn keys(&self) -> Result<Vec<String>, Error> {
        let conn = self.store.conn.lock().unwrap();
        let mut stmt =
            conn.prepare_cached("SELECT key FROM entries WHERE domain = ?1 ORDER BY key")?;
        let keys = stmt
            .query_map(rusqlite::params![self.domain], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(keys)
    }

    /// Read all key-value pairs in this domain.
    pub fn read_all(&self) -> Result<BTreeMap<String, Value>, Error> {
        let conn = self.store.conn.lock().unwrap();
        let mut stmt = conn.prepare_cached(
            "SELECT key, value_kind, value_i64, value_f64, value_text, value_blob \
             FROM entries WHERE domain = ?1",
        )?;
        let mut map = BTreeMap::new();
        let rows = stmt.query_map(rusqlite::params![self.domain], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i32>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<f64>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<Vec<u8>>>(5)?,
            ))
        })?;
        for row in rows {
            let (key, kind, i64v, f64v, textv, blobv) = row?;
            map.insert(key, decode_value(kind, i64v, f64v, textv, blobv)?);
        }
        Ok(map)
    }

    /// Set a key to a value.
    ///
    /// Creates the domain row if it does not exist. Increments the domain
    /// generation. Enforces the 10 MB blob size limit.
    ///
    /// Returns [`Error::InvalidKey`] if `key` is empty.
    pub fn set(&self, key: &str, value: Value) -> Result<(), Error> {
        if key.is_empty() {
            return Err(Error::InvalidKey(key.to_owned()));
        }
        check_blob_size(&value)?;
        let now = now_rfc3339();
        let (kind, i64v, f64v, textv, blobv) = encode_value(&value);
        let mut conn = self.store.conn.lock().unwrap();
        let txn = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Ensure domain row exists.
        txn.execute(
            "INSERT OR IGNORE INTO domains (name, generation, updated_at) \
             VALUES (?1, 0, ?2)",
            rusqlite::params![self.domain, now],
        )?;
        // Upsert the entry.
        txn.execute(
            "INSERT INTO entries \
               (domain, key, value_kind, value_i64, value_f64, value_text, value_blob, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
             ON CONFLICT(domain, key) DO UPDATE SET \
               value_kind = excluded.value_kind, \
               value_i64  = excluded.value_i64, \
               value_f64  = excluded.value_f64, \
               value_text = excluded.value_text, \
               value_blob = excluded.value_blob, \
               updated_at = excluded.updated_at",
            rusqlite::params![self.domain, key, kind, i64v, f64v, textv, blobv, now],
        )?;
        // Increment generation.
        txn.execute(
            "UPDATE domains SET generation = generation + 1, updated_at = ?1 \
             WHERE name = ?2",
            rusqlite::params![now, self.domain],
        )?;
        txn.commit()?;
        Ok(())
    }

    /// Remove a key.
    ///
    /// Returns `true` if the key existed and was deleted, `false` if it did
    /// not exist. Does not create the domain row or bump the generation if
    /// no entry was found.
    ///
    /// Returns [`Error::InvalidKey`] if `key` is empty.
    pub fn remove(&self, key: &str) -> Result<bool, Error> {
        if key.is_empty() {
            return Err(Error::InvalidKey(key.to_owned()));
        }
        let now = now_rfc3339();
        let mut conn = self.store.conn.lock().unwrap();
        let txn = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let affected = txn.execute(
            "DELETE FROM entries WHERE domain = ?1 AND key = ?2",
            rusqlite::params![self.domain, key],
        )?;
        if affected > 0 {
            // Only bump generation when a row was actually deleted.
            txn.execute(
                "UPDATE domains SET generation = generation + 1, updated_at = ?1 \
                 WHERE name = ?2",
                rusqlite::params![now, self.domain],
            )?;
            txn.commit()?;
            Ok(true)
        } else {
            // Nothing deleted — roll back (implicit on drop, but explicit is clear).
            drop(txn);
            Ok(false)
        }
    }

    /// Get the current generation counter for this domain.
    ///
    /// Returns `0` if the domain has no rows yet (no writes have occurred).
    pub fn generation(&self) -> Result<u64, Error> {
        let conn = self.store.conn.lock().unwrap();
        let result = conn.query_row(
            "SELECT generation FROM domains WHERE name = ?1",
            rusqlite::params![self.domain],
            |row| row.get::<_, i64>(0),
        );
        match result {
            Ok(g) => Ok(g as u64),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(0),
            Err(e) => Err(Error::Sqlite(e)),
        }
    }

    /// Set a key only if the domain generation matches `expected_generation`.
    ///
    /// Returns [`SetOutcome::Written`] on success, or
    /// [`SetOutcome::Conflict`] with the current generation if the domain
    /// has been modified since `expected_generation` was read.
    ///
    /// Returns [`Error::InvalidKey`] if `key` is empty.
    pub fn set_if_generation(
        &self,
        key: &str,
        value: Value,
        expected_generation: u64,
    ) -> Result<SetOutcome, Error> {
        if key.is_empty() {
            return Err(Error::InvalidKey(key.to_owned()));
        }
        check_blob_size(&value)?;
        let now = now_rfc3339();
        let (kind, i64v, f64v, textv, blobv) = encode_value(&value);
        let mut conn = self.store.conn.lock().unwrap();
        let txn = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Ensure domain row exists (generation starts at 0).
        txn.execute(
            "INSERT OR IGNORE INTO domains (name, generation, updated_at) \
             VALUES (?1, 0, ?2)",
            rusqlite::params![self.domain, now],
        )?;
        // Read current generation.
        let current_gen: i64 = txn.query_row(
            "SELECT generation FROM domains WHERE name = ?1",
            rusqlite::params![self.domain],
            |row| row.get(0),
        )?;
        if current_gen as u64 != expected_generation {
            return Ok(SetOutcome::Conflict {
                current_generation: current_gen as u64,
            });
        }
        // Upsert entry.
        txn.execute(
            "INSERT INTO entries \
               (domain, key, value_kind, value_i64, value_f64, value_text, value_blob, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
             ON CONFLICT(domain, key) DO UPDATE SET \
               value_kind = excluded.value_kind, \
               value_i64  = excluded.value_i64, \
               value_f64  = excluded.value_f64, \
               value_text = excluded.value_text, \
               value_blob = excluded.value_blob, \
               updated_at = excluded.updated_at",
            rusqlite::params![self.domain, key, kind, i64v, f64v, textv, blobv, now],
        )?;
        // CAS bump: generation must still match (defense-in-depth).
        let affected = txn.execute(
            "UPDATE domains SET generation = generation + 1, updated_at = ?1 \
             WHERE name = ?2 AND generation = ?3",
            rusqlite::params![now, self.domain, expected_generation as i64],
        )?;
        if affected != 1 {
            return Err(Error::Conflict);
        }
        txn.commit()?;
        Ok(SetOutcome::Written)
    }

    /// Atomic multi-key update.
    ///
    /// The closure receives a write-only [`DomainTxn`]. Uses `BEGIN IMMEDIATE`
    /// for writer serialization. Includes a defense-in-depth CAS check on
    /// the generation. If the closure returns `Err`, the transaction is
    /// rolled back automatically and the error is propagated.
    ///
    /// Returns the new generation on success.
    pub fn update<F>(&self, f: F) -> Result<u64, Error>
    where
        F: FnOnce(&mut DomainTxn) -> Result<(), Error>,
    {
        let now = now_rfc3339();
        let mut conn = self.store.conn.lock().unwrap();
        let txn = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Ensure domain row exists.
        txn.execute(
            "INSERT OR IGNORE INTO domains (name, generation, updated_at) \
             VALUES (?1, 0, ?2)",
            rusqlite::params![self.domain, now],
        )?;
        // Read generation before mutations.
        let pre_gen: i64 = txn.query_row(
            "SELECT generation FROM domains WHERE name = ?1",
            rusqlite::params![self.domain],
            |row| row.get(0),
        )?;
        // Collect mutations from the caller's closure.
        let mut domain_txn = DomainTxn::new();
        f(&mut domain_txn)?;
        // Apply mutations.
        for mutation in domain_txn.mutations {
            match mutation {
                Mutation::Set { key, value } => {
                    let (kind, i64v, f64v, textv, blobv) = encode_value(&value);
                    txn.execute(
                        "INSERT INTO entries \
                           (domain, key, value_kind, value_i64, value_f64, value_text, value_blob, updated_at) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
                         ON CONFLICT(domain, key) DO UPDATE SET \
                           value_kind = excluded.value_kind, \
                           value_i64  = excluded.value_i64, \
                           value_f64  = excluded.value_f64, \
                           value_text = excluded.value_text, \
                           value_blob = excluded.value_blob, \
                           updated_at = excluded.updated_at",
                        rusqlite::params![
                            self.domain, key, kind, i64v, f64v, textv, blobv, now
                        ],
                    )?;
                }
                Mutation::Remove { key } => {
                    txn.execute(
                        "DELETE FROM entries WHERE domain = ?1 AND key = ?2",
                        rusqlite::params![self.domain, key],
                    )?;
                }
            }
        }
        // CAS bump (defense-in-depth).
        let affected = txn.execute(
            "UPDATE domains SET generation = generation + 1, updated_at = ?1 \
             WHERE name = ?2 AND generation = ?3",
            rusqlite::params![now, self.domain, pre_gen],
        )?;
        if affected != 1 {
            return Err(Error::Conflict);
        }
        let new_gen = pre_gen as u64 + 1;
        txn.commit()?;
        Ok(new_gen)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DefaultsStore;
    use tempfile::NamedTempFile;

    fn temp_store() -> (DefaultsStore, NamedTempFile) {
        let tmp = NamedTempFile::new().expect("temp file");
        let store = DefaultsStore::open(tmp.path()).expect("open");
        (store, tmp)
    }

    // ── T22: set then get returns the same value for each Value variant ──────

    fn roundtrip_via_db(store: &DefaultsStore, domain: &str, key: &str, value: Value) {
        let h = store.domain(domain).unwrap();
        h.set(key, value.clone()).unwrap();
        let got = h.get(key).unwrap();
        assert_eq!(got, Some(value), "roundtrip failed for key {key}");
    }

    #[test]
    fn test_set_get_null() {
        let (store, _tmp) = temp_store();
        roundtrip_via_db(&store, "d", "k", Value::Null);
    }

    #[test]
    fn test_set_get_bool_true() {
        let (store, _tmp) = temp_store();
        roundtrip_via_db(&store, "d", "k", Value::Bool(true));
    }

    #[test]
    fn test_set_get_bool_false() {
        let (store, _tmp) = temp_store();
        roundtrip_via_db(&store, "d", "k", Value::Bool(false));
    }

    #[test]
    fn test_set_get_i64_max() {
        let (store, _tmp) = temp_store();
        roundtrip_via_db(&store, "d", "k", Value::I64(i64::MAX));
    }

    #[test]
    fn test_set_get_f64_pi() {
        let (store, _tmp) = temp_store();
        roundtrip_via_db(&store, "d", "k", Value::F64(std::f64::consts::PI));
    }

    #[test]
    fn test_set_get_string_unicode() {
        let (store, _tmp) = temp_store();
        roundtrip_via_db(&store, "d", "k", Value::String("héllo 🌍".into()));
    }

    #[test]
    fn test_set_get_bytes() {
        let (store, _tmp) = temp_store();
        roundtrip_via_db(&store, "d", "k", Value::Bytes(vec![1, 2, 3, 0xFF]));
    }

    #[test]
    fn test_set_get_json() {
        let (store, _tmp) = temp_store();
        roundtrip_via_db(
            &store,
            "d",
            "k",
            Value::Json(serde_json::json!({"a": [1, 2, true]})),
        );
    }

    // ── T23: get on nonexistent key returns None ──────────────────────────────

    #[test]
    fn test_get_nonexistent_key_returns_none() {
        let (store, _tmp) = temp_store();
        let h = store.domain("d").unwrap();
        assert_eq!(h.get("missing").unwrap(), None);
    }

    // ── T24: set overwrites an existing key ───────────────────────────────────

    #[test]
    fn test_set_overwrites_existing_key() {
        let (store, _tmp) = temp_store();
        let h = store.domain("d").unwrap();
        h.set("k", Value::I64(1)).unwrap();
        h.set("k", Value::I64(2)).unwrap();
        assert_eq!(h.get("k").unwrap(), Some(Value::I64(2)));
    }

    // ── T25: remove returns true for existing key, false for nonexistent ──────

    #[test]
    fn test_remove_existing_returns_true() {
        let (store, _tmp) = temp_store();
        let h = store.domain("d").unwrap();
        h.set("k", Value::Bool(true)).unwrap();
        assert!(h.remove("k").unwrap());
    }

    #[test]
    fn test_remove_nonexistent_returns_false() {
        let (store, _tmp) = temp_store();
        let h = store.domain("d").unwrap();
        assert!(!h.remove("missing").unwrap());
    }

    // ── T26: keys returns all keys in sorted order ────────────────────────────

    #[test]
    fn test_keys_returns_sorted() {
        let (store, _tmp) = temp_store();
        let h = store.domain("d").unwrap();
        h.set("c", Value::Null).unwrap();
        h.set("a", Value::Null).unwrap();
        h.set("b", Value::Null).unwrap();
        assert_eq!(h.keys().unwrap(), vec!["a", "b", "c"]);
    }

    // ── T27: read_all returns all key-value pairs ─────────────────────────────

    #[test]
    fn test_read_all_returns_all_pairs() {
        let (store, _tmp) = temp_store();
        let h = store.domain("d").unwrap();
        h.set("x", Value::I64(10)).unwrap();
        h.set("y", Value::Bool(false)).unwrap();
        let map = h.read_all().unwrap();
        assert_eq!(map.get("x"), Some(&Value::I64(10)));
        assert_eq!(map.get("y"), Some(&Value::Bool(false)));
        assert_eq!(map.len(), 2);
    }

    // ── T28: set rejects Bytes > 10 MB ───────────────────────────────────────

    #[test]
    fn test_set_rejects_oversized_bytes() {
        let (store, _tmp) = temp_store();
        let h = store.domain("d").unwrap();
        let big = Value::Bytes(vec![0u8; crate::value::MAX_BLOB_SIZE + 1]);
        let err = h.set("k", big).unwrap_err();
        assert!(
            matches!(err, Error::ValueTooLarge { .. }),
            "expected ValueTooLarge, got {err:?}"
        );
    }

    // ── T29: domains do not cross-contaminate ─────────────────────────────────

    #[test]
    fn test_different_domains_do_not_cross_contaminate() {
        let (store, _tmp) = temp_store();
        let a = store.domain("a").unwrap();
        let b = store.domain("b").unwrap();
        a.set("key", Value::I64(1)).unwrap();
        b.set("key", Value::I64(2)).unwrap();
        assert_eq!(a.get("key").unwrap(), Some(Value::I64(1)));
        assert_eq!(b.get("key").unwrap(), Some(Value::I64(2)));
    }

    // ── T30: remove a key then get returns None ───────────────────────────────

    #[test]
    fn test_remove_then_get_returns_none() {
        let (store, _tmp) = temp_store();
        let h = store.domain("d").unwrap();
        h.set("k", Value::Bool(true)).unwrap();
        h.remove("k").unwrap();
        assert_eq!(h.get("k").unwrap(), None);
    }

    // ── T30a: remove on never-written domain does not create domain row ───────

    #[test]
    fn test_remove_on_unwritten_domain_no_domain_row() {
        let (store, _tmp) = temp_store();
        let h = store.domain("ghost").unwrap();
        let existed = h.remove("k").unwrap();
        assert!(!existed);
        // list_domains should still be empty — ghost domain row was never created
        let domains = store.list_domains().unwrap();
        assert!(
            !domains.contains(&"ghost".to_owned()),
            "domain row should not exist: {domains:?}"
        );
    }

    // ── T30b: set with empty key returns InvalidKey ───────────────────────────

    #[test]
    fn test_set_empty_key_returns_invalid_key() {
        let (store, _tmp) = temp_store();
        let h = store.domain("d").unwrap();
        let err = h.set("", Value::Null).unwrap_err();
        assert!(
            matches!(err, Error::InvalidKey(_)),
            "expected InvalidKey, got {err:?}"
        );
    }

    // ── T30c: get with empty key returns InvalidKey ───────────────────────────

    #[test]
    fn test_get_empty_key_returns_invalid_key() {
        let (store, _tmp) = temp_store();
        let h = store.domain("d").unwrap();
        let err = h.get("").unwrap_err();
        assert!(
            matches!(err, Error::InvalidKey(_)),
            "expected InvalidKey, got {err:?}"
        );
    }

    // ── T31: generation returns 0 for domain with no prior writes ────────────

    #[test]
    fn test_generation_zero_for_unwritten_domain() {
        let (store, _tmp) = temp_store();
        let h = store.domain("fresh").unwrap();
        assert_eq!(h.generation().unwrap(), 0);
    }

    // ── T32: after one set(), generation is 1 ─────────────────────────────────

    #[test]
    fn test_generation_one_after_first_set() {
        let (store, _tmp) = temp_store();
        let h = store.domain("d").unwrap();
        h.set("k", Value::I64(1)).unwrap();
        assert_eq!(h.generation().unwrap(), 1);
    }

    // ── T33: generation increments by 1 after each set/remove ────────────────

    #[test]
    fn test_generation_increments_on_each_write() {
        let (store, _tmp) = temp_store();
        let h = store.domain("d").unwrap();
        h.set("a", Value::I64(1)).unwrap();
        assert_eq!(h.generation().unwrap(), 1);
        h.set("b", Value::I64(2)).unwrap();
        assert_eq!(h.generation().unwrap(), 2);
        h.remove("a").unwrap();
        assert_eq!(h.generation().unwrap(), 3);
    }

    // ── T34: set_if_generation returns Written when generation matches ────────

    #[test]
    fn test_set_if_generation_written_when_matches() {
        let (store, _tmp) = temp_store();
        let h = store.domain("d").unwrap();
        // Fresh domain: generation is 0.
        let outcome = h.set_if_generation("k", Value::Bool(true), 0).unwrap();
        assert_eq!(outcome, SetOutcome::Written);
        assert_eq!(h.get("k").unwrap(), Some(Value::Bool(true)));
        assert_eq!(h.generation().unwrap(), 1);
    }

    // ── T35: set_if_generation returns Conflict when generation is stale ──────

    #[test]
    fn test_set_if_generation_conflict_when_stale() {
        let (store, _tmp) = temp_store();
        let h = store.domain("d").unwrap();
        h.set("k", Value::I64(1)).unwrap(); // generation is now 1
        // Try with stale expected generation of 0.
        let outcome = h.set_if_generation("k", Value::I64(99), 0).unwrap();
        match outcome {
            SetOutcome::Conflict { current_generation } => {
                assert_eq!(current_generation, 1);
            }
            SetOutcome::Written => panic!("expected Conflict, got Written"),
        }
        // Value must not have been changed.
        assert_eq!(h.get("k").unwrap(), Some(Value::I64(1)));
    }

    // ── T36: update with multiple set/remove operations applies atomically ────

    #[test]
    fn test_update_applies_multiple_mutations_atomically() {
        let (store, _tmp) = temp_store();
        let h = store.domain("d").unwrap();
        // Seed two keys.
        h.set("a", Value::I64(1)).unwrap();
        h.set("b", Value::I64(2)).unwrap();

        h.update(|txn| {
            txn.set("a", Value::I64(10))?;
            txn.set("c", Value::I64(30))?;
            txn.remove("b");
            Ok(())
        })
        .unwrap();

        assert_eq!(h.get("a").unwrap(), Some(Value::I64(10)));
        assert_eq!(h.get("b").unwrap(), None);
        assert_eq!(h.get("c").unwrap(), Some(Value::I64(30)));
    }

    // ── T37: update returns the new generation on success ─────────────────────

    #[test]
    fn test_update_returns_new_generation() {
        let (store, _tmp) = temp_store();
        let h = store.domain("d").unwrap();
        // After two individual sets, generation is 2.
        h.set("x", Value::I64(0)).unwrap();
        h.set("y", Value::I64(0)).unwrap();

        let new_gen = h
            .update(|txn| {
                txn.set("x", Value::I64(1))?;
                txn.set("y", Value::I64(2))?;
                Ok(())
            })
            .unwrap();

        // update() bumps generation by exactly 1 per call.
        assert_eq!(new_gen, 3);
        assert_eq!(h.generation().unwrap(), 3);
    }

    // ── T38: DomainTxn::set enforces blob size limit inside transactions ──────

    #[test]
    fn test_domain_txn_set_rejects_oversized_bytes() {
        let (store, _tmp) = temp_store();
        let h = store.domain("d").unwrap();
        let big = Value::Bytes(vec![0u8; crate::value::MAX_BLOB_SIZE + 1]);
        let result = h.update(|txn| txn.set("k", big));
        assert!(
            matches!(result, Err(Error::ValueTooLarge { .. })),
            "expected ValueTooLarge from DomainTxn::set, got {result:?}"
        );
        // Nothing should have been written.
        assert_eq!(h.get("k").unwrap(), None);
    }
}
