## `tugbank` Design Draft (SQLite-backed)

A self-contained design for a small, shareable defaults system (library + CLI), inspired by Apple’s `UserDefaults`/`defaults` model and adapted for Rust + multi-process safety.  
Reference model: [Apple `UserDefaults`](https://developer.apple.com/documentation/foundation/userdefaults)

---

## 1) Goals

- Simple defaults API by **domain + key**.
- Safe for **multiple processes** sharing one file.
- Strong correctness: no silent lost updates.
- Small implementation footprint (reuse `rusqlite`).
- Include a command-line tool like macOS `defaults`.
- Usable by any app by pointing at a database path.

## 2) Non-goals (v1)

- iCloud/sync/replication.
- ACL/permissions beyond filesystem permissions.
- Rich query language.
- Watch/notify API (can be added later).

---

## 3) Data Model

- **Store file**: one SQLite DB file. Default path: `~/.tugbank.db`.
- **Domain**: reverse-URL string (e.g. `dev.tugtool.app`).
- **Key**: UTF-8 string (e.g. `window.background`).
- **Value**: compact typed value:
  - bool, i64, f64, string, bytes, null
  - arrays/objects via JSON payload (v1 compromise)
- **Blob size limit**: `Bytes` values capped at 10 MB, enforced at the API level before touching SQLite.

---

## 4) Encoding Options (and choice)

### A) JSON blob only
- **Pros**: very simple
- **Cons**: primitive types lose strictness; bigger payloads; slower parse

### B) Tagged BLOB (custom binary)
- **Pros**: compact, explicit
- **Cons**: custom codec complexity; more code risk

### C) Typed columns (recommended)
- **Pros**: explicit typing, simple SQL, no custom binary codec
- **Cons**: a few nullable columns

### **Chosen for v1: C (typed columns + JSON fallback)**

---

## 5) SQLite Schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL; -- or FULL for stricter durability
```

```sql
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- schema_version in meta, e.g. ('schema_version', '1')

CREATE TABLE IF NOT EXISTS domains (
  name        TEXT PRIMARY KEY,
  generation  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);

-- value_kind:
-- 0=null, 1=bool, 2=i64, 3=f64, 4=string, 5=bytes, 6=json
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
```

Invariant: exactly one payload column is populated based on `value_kind`.

---

## 6) Rust Value Type

```rust
pub enum Value {
    Null,
    Bool(bool),
    I64(i64),
    F64(f64),
    String(String),
    Bytes(Vec<u8>),
    Json(serde_json::Value), // arrays/objects in v1
}
```

---

## 7) API Surface (library)

```rust
pub struct DefaultsStore { /* connection manager */ }
pub struct DomainHandle { /* store + domain */ }

impl DefaultsStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, Error>;
    pub fn domain(&self, name: &str) -> Result<DomainHandle, Error>;
    pub fn list_domains(&self) -> Result<Vec<String>, Error>;
}

impl DomainHandle {
    pub fn get(&self, key: &str) -> Result<Option<Value>, Error>;
    pub fn keys(&self) -> Result<Vec<String>, Error>;

    pub fn set(&self, key: &str, value: Value) -> Result<(), Error>;
    pub fn remove(&self, key: &str) -> Result<bool, Error>;

    pub fn read_all(&self) -> Result<std::collections::BTreeMap<String, Value>, Error>;

    // CAS/optimistic concurrency
    pub fn generation(&self) -> Result<u64, Error>;
    pub fn set_if_generation(
        &self,
        key: &str,
        value: Value,
        expected_generation: u64,
    ) -> Result<SetOutcome, Error>;

    // Atomic multi-key update
    pub fn update<F>(&self, f: F) -> Result<u64, Error>
    where
        F: FnOnce(&mut DomainTxn) -> Result<(), Error>;
}
```

---

## 8) Exact Transaction Flow (`rusqlite`)

## Read path
- Open read transaction (`BEGIN` implicit via query).
- Read rows.
- Commit/finish (implicit at statement end).
- WAL allows readers concurrent with writer.

## Write path (no lost update)
1. `BEGIN IMMEDIATE` (reserves writer lock early).
2. `INSERT INTO domains ... ON CONFLICT DO NOTHING`.
3. Read current `generation` from `domains`.
4. For each mutation, `INSERT ... ON CONFLICT(domain,key) DO UPDATE ...`.
5. CAS bump:
   ```sql
   UPDATE domains
   SET generation = generation + 1, updated_at = ?
   WHERE name = ? AND generation = ?;
   ```
6. If updated row count != 1 => conflict => `ROLLBACK`, return `Conflict`.
7. `COMMIT`.

This ensures serialized writes and explicit conflict detection.

---

## 9) Multi-process Behavior

- SQLite + WAL handles concurrent readers and one writer.
- `busy_timeout` handles brief contention.
- For write-heavy cases, caller retries on `Busy` or `Conflict` with backoff.
- No separate lockfiles required.

---

## 10) CLI (`tugbank`) Spec

Modeled after `defaults`, but explicit and script-friendly.

## Global flags
- `--path <db-path>` (default: `~/.tugbank.db`; overridable or env `TUGBANK_PATH`)
- `--json` (machine output)
- `--pretty` (pretty JSON)

## Commands

### `domains`
List all domains.
```bash
tugbank domains
tugbank --path /some/other/path.db domains
```

### `read <domain> [key]`
- no key: dump whole domain
- key: print value
```bash
tugbank --path db.sqlite read dev.tugtool.app
tugbank --path db.sqlite read dev.tugtool.app dev_mode.enabled
```

### `write <domain> <key> <value> [--type ...]`
Types: `bool|i64|f64|string|bytes|json|null`
```bash
tugbank --path db.sqlite write dev.tugtool.app dev_mode.enabled true --type bool
tugbank --path db.sqlite write dev.tugtool.deck layout '{"cards":[]}' --type json
```

### `delete <domain> [key]`
- with key: delete key
- without key: delete whole domain
```bash
tugbank --path db.sqlite delete dev.tugtool.app dev_mode.enabled
tugbank --path db.sqlite delete dev.tugtool.app
```

### `keys <domain>`
List keys in domain.

### `cas-write <domain> <key> <value> --type ... --expected-generation <n>`
Explicit compare-and-swap write.

### `generation <domain>`
Print domain generation.

---

## 11) Error Model

- `InvalidDomain`
- `InvalidKey`
- `TypeMismatch`
- `NotFound`
- `Conflict` (generation changed)
- `Busy` (lock timeout)
- `ValueTooLarge` (blob exceeds 10 MB limit)
- `Sqlite(rusqlite::Error)`
- `Serde(serde_json::Error)`

CLI exit codes:
- `0` success
- `2` not found
- `3` conflict
- `4` invalid usage/value
- `5` busy/timeout
- `1` other failure

---

## 12) Path + portability

- Default path: `~/.tugbank.db` (dotfile in user's home directory).
- Override with `--path` flag or `TUGBANK_PATH` environment variable.
- Exactly one database file is active at a time — no cascade or multi-file lookup.
- Allow arbitrary path for shared/cross-app usage.
- Require directory to exist or create parent dirs on first open.
- Set file mode to user-only when creating (best effort).

---

## 13) Migration + schema versioning

- Store `schema_version` in `meta`.
- On open:
  - if missing -> bootstrap schema v1
  - if older -> run migration transaction(s)
- Keep migrations additive and transactional.

---

## 14) Minimal implementation plan

1. `tugbank-core` crate
   - schema bootstrap
   - value encode/decode
   - domain CRUD
   - CAS update logic
2. `tugbank` CLI crate
   - `clap` command parsing
   - JSON/text output
3. tests
   - unit: value roundtrip, SQL mapping
   - integration: two-process writer contention
   - conflict tests: CAS works, no silent clobber
   - CLI golden tests

---

## 15) Practical defaults for v1

- `journal_mode=WAL`
- `synchronous=NORMAL`
- `busy_timeout=5000`
- typed columns with JSON for arrays/objects
- CAS on all writes through `update()` path

This gives a very small codebase with solid correctness and a familiar defaults-style UX.