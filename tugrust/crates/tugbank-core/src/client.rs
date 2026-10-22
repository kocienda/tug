//! TugbankClient — in-memory cached client wrapping DefaultsStore.
//!
//! `TugbankClient` wraps a [`DefaultsStore`] with an in-memory domain-snapshot
//! cache. All reads go through the cache (populated on first access per domain).
//! Writes go through to the database and update the local cache, then broadcast
//! a notification via Unix socket so other processes can react.
//!
//! External change detection is tugcast's responsibility — it owns the
//! notification socket and refreshes domains when datagrams arrive.
//!
//! # Thread safety
//!
//! `TugbankClient` is `Send + Sync` and intended to be shared via `Arc`.

use parking_lot::Mutex;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::Arc;

use crate::notify::broadcast_domain_changed;
use crate::{DefaultsStore, Error, Value};

/// A snapshot of all key-value pairs for a single domain.
pub type DomainSnapshot = BTreeMap<String, Value>;

/// A domain as the cache holds it: its entries and the generation they were
/// read at, always from one read, so a reader that publishes the generation
/// beside the entries never pairs one state's entries with another's number.
#[derive(Default)]
struct Cached {
    entries: DomainSnapshot,
    generation: u64,
}

// ── Callback registry ────────────────────────────────────────────────────────

type Callback = Box<dyn Fn(&str, &DomainSnapshot) + Send + 'static>;

struct CallbackRegistry {
    next_id: u64,
    callbacks: HashMap<u64, Callback>,
}

impl CallbackRegistry {
    fn new() -> Self {
        Self {
            next_id: 0,
            callbacks: HashMap::new(),
        }
    }

    fn register(&mut self, cb: Callback) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.callbacks.insert(id, cb);
        id
    }

    fn unregister(&mut self, id: u64) {
        self.callbacks.remove(&id);
    }

    fn fire(&self, domain: &str, snapshot: &DomainSnapshot) {
        for cb in self.callbacks.values() {
            cb(domain, snapshot);
        }
    }
}

// ── CallbackHandle ───────────────────────────────────────────────────────────

/// Returned by [`TugbankClient::on_domain_changed`].
///
/// Unregisters the callback when dropped.
pub struct CallbackHandle {
    id: u64,
    registry: Arc<Mutex<CallbackRegistry>>,
}

impl Drop for CallbackHandle {
    fn drop(&mut self) {
        self.registry.lock().unregister(self.id);
    }
}

// ── Internal shared state ────────────────────────────────────────────────────

struct Inner {
    store: DefaultsStore,
    cache: Mutex<HashMap<String, Cached>>,
    callbacks: Arc<Mutex<CallbackRegistry>>,
}

// ── TugbankClient ────────────────────────────────────────────────────────────

/// In-memory cached client wrapping a [`DefaultsStore`].
///
/// All reads go through an in-memory snapshot cache. The cache is populated
/// on first access per domain. Writes update the DB, the local cache, and
/// broadcast a notification via Unix socket.
pub struct TugbankClient {
    inner: Arc<Inner>,
}

// Compile-time assertion that TugbankClient is Send + Sync.
const _: () = {
    fn _assert_send_sync<T: Send + Sync>() {}
    fn _check() {
        _assert_send_sync::<TugbankClient>();
    }
};

impl TugbankClient {
    /// Open a new client backed by the database at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, Error> {
        let store = DefaultsStore::open(path)?;
        Self::from_store(store)
    }

    /// Create a client from an existing [`DefaultsStore`].
    pub fn from_store(store: DefaultsStore) -> Result<Self, Error> {
        let inner = Arc::new(Inner {
            store,
            cache: Mutex::new(HashMap::new()),
            callbacks: Arc::new(Mutex::new(CallbackRegistry::new())),
        });

        Ok(Self { inner })
    }

    /// Access the underlying [`DefaultsStore`].
    pub fn store(&self) -> &DefaultsStore {
        &self.inner.store
    }

    /// Read a value from the cache, loading the domain on first access.
    pub fn get(&self, domain: &str, key: &str) -> Result<Option<Value>, Error> {
        self.ensure_domain_loaded(domain)?;
        let cache = self.inner.cache.lock();
        Ok(cache.get(domain).and_then(|c| c.entries.get(key)).cloned())
    }

    /// Write a value to the DB and read the domain back into the local cache.
    ///
    /// Broadcasts a Unix socket notification so tugcast and other
    /// processes are notified of the change.
    pub fn set(&self, domain: &str, key: &str, value: Value) -> Result<(), Error> {
        self.inner.store.domain(domain)?.set(key, value.clone())?;
        if self.reload(domain).is_err() {
            let mut cache = self.inner.cache.lock();
            cache
                .entry(domain.to_owned())
                .or_default()
                .entries
                .insert(key.to_owned(), value);
        }
        broadcast_domain_changed(domain);
        Ok(())
    }

    /// Remove a key from the DB and update the local cache.
    ///
    /// Returns `true` if the key existed and was removed, `false` if it
    /// did not exist. Broadcasts a notification on removal.
    pub fn delete(&self, domain: &str, key: &str) -> Result<bool, Error> {
        let existed = self.inner.store.domain(domain)?.remove(key)?;
        if existed {
            if self.reload(domain).is_err() {
                let mut cache = self.inner.cache.lock();
                if let Some(c) = cache.get_mut(domain) {
                    c.entries.remove(key);
                }
            }
            broadcast_domain_changed(domain);
        }
        Ok(existed)
    }

    /// Return the cached snapshot for `domain`, loading it on first access.
    pub fn read_domain(&self, domain: &str) -> Result<DomainSnapshot, Error> {
        self.ensure_domain_loaded(domain)?;
        let cache = self.inner.cache.lock();
        Ok(cache
            .get(domain)
            .map(|c| c.entries.clone())
            .unwrap_or_default())
    }

    /// The cached entries of `domain` and the generation they were read at,
    /// as one pair, loading the domain on first access. Read from the cache
    /// rather than the database: published beside the cached entries, a
    /// fresh number would claim a write whose entries the cache has not
    /// taken yet.
    pub fn read_domain_with_generation(
        &self,
        domain: &str,
    ) -> Result<(DomainSnapshot, u64), Error> {
        self.ensure_domain_loaded(domain)?;
        let cache = self.inner.cache.lock();
        Ok(cache
            .get(domain)
            .map(|c| (c.entries.clone(), c.generation))
            .unwrap_or_default())
    }

    /// List all domain names in the database.
    pub fn list_domains(&self) -> Result<Vec<String>, Error> {
        self.inner.store.list_domains()
    }

    /// Register a callback that fires when any domain changes.
    ///
    /// Callbacks are fired by tugcast's notification handler when it
    /// receives a datagram on the Unix socket and refreshes the domain.
    ///
    /// Returns a [`CallbackHandle`] that unregisters the callback when dropped.
    pub fn on_domain_changed<F>(&self, callback: F) -> CallbackHandle
    where
        F: Fn(&str, &DomainSnapshot) + Send + 'static,
    {
        let mut reg = self.inner.callbacks.lock();
        let id = reg.register(Box::new(callback));
        CallbackHandle {
            id,
            registry: Arc::clone(&self.inner.callbacks),
        }
    }

    /// Refresh a domain from the database and fire callbacks.
    ///
    /// Called by tugcast's notification handler when a datagram arrives.
    pub fn refresh_domain(&self, domain: &str) {
        let snapshot = match self.reload(domain) {
            Ok(s) => s,
            Err(_) => return,
        };
        {
            let reg = self.inner.callbacks.lock();
            reg.fire(domain, &snapshot);
        }
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    /// Read `domain`'s entries and generation in one transaction into the
    /// cache, returning the entries.
    fn reload(&self, domain: &str) -> Result<DomainSnapshot, Error> {
        let (entries, generation) = self
            .inner
            .store
            .domain(domain)?
            .read_all_with_generation()?;
        let mut cache = self.inner.cache.lock();
        cache.insert(
            domain.to_owned(),
            Cached {
                entries: entries.clone(),
                generation,
            },
        );
        Ok(entries)
    }

    fn ensure_domain_loaded(&self, domain: &str) -> Result<(), Error> {
        let already_loaded = {
            let cache = self.inner.cache.lock();
            cache.contains_key(domain)
        };
        if !already_loaded {
            let (entries, generation) = self
                .inner
                .store
                .domain(domain)?
                .read_all_with_generation()?;
            let mut cache = self.inner.cache.lock();
            cache.entry(domain.to_owned()).or_insert(Cached {
                entries,
                generation,
            });
        }
        Ok(())
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    #[test]
    fn test_tugbank_client_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<TugbankClient>();
    }

    #[test]
    fn test_get_set_round_trip() {
        let tmp = NamedTempFile::new().expect("temp file");
        let client = TugbankClient::open(tmp.path()).expect("open failed");
        client
            .set("test.domain", "key", Value::String("hello".into()))
            .unwrap();
        let val = client.get("test.domain", "key").unwrap();
        assert_eq!(val, Some(Value::String("hello".into())));
    }

    #[test]
    fn test_read_domain() {
        let tmp = NamedTempFile::new().expect("temp file");
        let client = TugbankClient::open(tmp.path()).expect("open failed");
        client.set("d", "a", Value::String("one".into())).unwrap();
        client.set("d", "b", Value::I64(2)).unwrap();
        let snap = client.read_domain("d").unwrap();
        assert_eq!(snap.len(), 2);
        assert_eq!(snap.get("a"), Some(&Value::String("one".into())));
        assert_eq!(snap.get("b"), Some(&Value::I64(2)));
    }

    #[test]
    fn test_refresh_domain() {
        let tmp = NamedTempFile::new().expect("temp file");
        let client = TugbankClient::open(tmp.path()).expect("open failed");

        // Pre-load the domain.
        let _ = client.read_domain("ext").unwrap();

        // Write via a second independent connection (simulates external write).
        let external = DefaultsStore::open(tmp.path()).expect("external store open");
        external
            .domain("ext")
            .unwrap()
            .set("key", Value::String("external-write".into()))
            .unwrap();

        // Before refresh, cache is stale.
        let val = client.get("ext", "key").unwrap();
        assert_eq!(val, None);

        // After refresh, cache is updated.
        client.refresh_domain("ext");
        let val = client.get("ext", "key").unwrap();
        assert_eq!(val, Some(Value::String("external-write".into())));
    }

    #[test]
    fn test_generation_moves_with_the_entries_it_was_read_with() {
        let tmp = NamedTempFile::new().expect("temp file");
        let client = TugbankClient::open(tmp.path()).expect("open failed");
        client.set("gen", "a", Value::I64(1)).unwrap();
        let (_, before) = client.read_domain_with_generation("gen").unwrap();
        assert_eq!(before, 1);

        // Another process writes; the notice has not been handled yet.
        let external = DefaultsStore::open(tmp.path()).expect("external store open");
        external
            .domain("gen")
            .unwrap()
            .set("b", Value::I64(2))
            .unwrap();

        // The cache still holds the old entries, so it must still say the old
        // generation: a reader publishing the pair would otherwise claim the
        // write, and the refreshed pair that follows would look like nothing new.
        let (stale, generation) = client.read_domain_with_generation("gen").unwrap();
        assert_eq!(stale.get("b"), None);
        assert_eq!(generation, before);

        client.refresh_domain("gen");
        let (fresh, generation) = client.read_domain_with_generation("gen").unwrap();
        assert_eq!(fresh.get("b"), Some(&Value::I64(2)));
        assert_eq!(generation, before + 1);
    }

    #[test]
    fn test_callback_fires_on_refresh() {
        let tmp = NamedTempFile::new().expect("temp file");
        let client = TugbankClient::open(tmp.path()).expect("open failed");

        let fired = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let fired_clone = fired.clone();
        let _handle = client.on_domain_changed(move |_domain, _snapshot| {
            fired_clone.fetch_add(1, std::sync::atomic::Ordering::Release);
        });

        // Pre-load the domain.
        let _ = client.read_domain("cb-test").unwrap();

        // Write externally, then refresh.
        let external = DefaultsStore::open(tmp.path()).expect("external store open");
        external
            .domain("cb-test")
            .unwrap()
            .set("k", Value::Bool(true))
            .unwrap();
        client.refresh_domain("cb-test");

        assert!(
            fired.load(std::sync::atomic::Ordering::Acquire) > 0,
            "on_domain_changed callback should fire on refresh"
        );
    }
}
