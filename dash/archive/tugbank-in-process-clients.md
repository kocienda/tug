# Tugbank In-Process Clients

## Problem

Every tugbank access today spawns a process or makes an HTTP round-trip:

| Client | Current access pattern | Cost |
|--------|----------------------|------|
| **Swift (tugapp)** | `Process()` → `tugbank read/write` | Fork + exec + SQLite open per call |
| **TypeScript (tugdeck)** | `fetch("/api/defaults/...")` via tugcast | HTTP round-trip + spawn_blocking per call |
| **TypeScript (tugtalk)** | `Bun.spawnSync(["tugbank", ...])` | Fork + exec + SQLite open per call |
| **Rust (tugcast)** | `DefaultsStore` directly | Already in-process (the one exception) |
| **Rust (tugbank CLI)** | `DefaultsStore` directly | Already in-process |

Reading a single bool — like `no-auth` — means forking a process, loading the Rust binary, opening SQLite, querying one row, formatting the output, and parsing it back. This is the dominant access pattern. It's too much.

## Goal

Every client gets in-process, in-memory access to tugbank data. Reads are instant (memory lookup). Writes go through to the database and propagate to all other live clients — across processes, across languages — within a short, bounded window.

## Current Architecture

```
                  ┌────────────────────────┐
                  │   ~/.tugbank.db        │
                  │   (SQLite, WAL mode)   │
                  └──────┬─────────────────┘
                         │
          ┌──────────────┼──────────────────┐
          │              │                  │
   ┌──────┴──────┐ ┌────┴─────┐    ┌───────┴───────┐
   │ tugbank CLI │ │ tugcast  │    │ tugapp        │
   │ (Rust)      │ │ (Rust)   │    │ (Swift)       │
   │ Direct DB   │ │ Direct DB│    │ shell → CLI   │
   └─────────────┘ │ + HTTP   │    └───────────────┘
                   └────┬─────┘
                        │ HTTP
                ┌───────┴────────┐
                │ tugdeck (TS)   │
                │ fetch()        │
                └────────────────┘
```

tugcast is the only process that holds a `DefaultsStore` open for its lifetime. Everyone else opens-reads-closes or shells out.

## Proposed Architecture

```
                  ┌────────────────────────┐
                  │   ~/.tugbank.db        │
                  │   (SQLite, WAL mode)   │
                  └──────┬─────────────────┘
                         │
                         │ PRAGMA data_version
                         │ (polled 500ms)
                         │
          ┌──────────────┼──────────────────────────┐
          │              │                           │
   ┌──────┴──────┐ ┌────┴──────────┐    ┌───────────┴───────┐
   │ tugbank CLI │ │ tugcast       │    │ tugapp            │
   │ (Rust)      │ │ (Rust)        │    │ (Swift)           │
   │ Direct DB   │ │ TugbankClient │    │ TugbankClient     │
   └─────────────┘ │ in-memory     │    │ in-memory         │
                   │ + WS bridge   │    │ (via tugbank-ffi) │
                   └────┬──────────┘    └───────────────────┘
                        │ WebSocket
                        │ (full snapshots)
                ┌───────┴────────┐
                │ tugdeck (TS)   │
                │ TugbankClient  │
                │ in-memory      │
                │ (via tugcast)  │
                └────────────────┘
```

### One implementation, multiple bindings

The core data model — schema reading, value encoding/decoding (7-variant `value_kind` discriminator, SQL column mapping), domain/generation logic, migration behavior — lives in one place: the Rust `tugbank-core` crate. Rather than reimplementing ~250 lines of encoding logic per language, non-Rust clients use `tugbank-core` via a C ABI (`extern "C"` functions exposed by a new `tugbank-ffi` crate).

1. **Rust `TugbankClient`** — New type in `tugbank-core`. Wraps `DefaultsStore` with an in-memory cache and `PRAGMA data_version` polling. Used by tugcast.

2. **Swift `TugbankClient`** — Thin Swift wrapper over the `tugbank-ffi` C library. Linked into tugapp via a bridging header. The Rust library handles all SQLite access, value encoding, and schema migration. Swift provides the in-memory cache, change callbacks, and `PRAGMA data_version` polling (via an FFI call that returns the current data version).

3. **TypeScript `TugbankClient`** — Two variants:
   - **tugdeck** (browser): Cannot access the filesystem. Gets full domain snapshots pushed via the existing WebSocket (DEFAULTS feed). No HTTP fetch needed after initial connection.
   - **tugtalk** (Bun): Uses `bun:sqlite` for direct access. Reimplements the minimal read path (value decoding is straightforward; schema migration is not tugtalk's job — the Rust CLI or tugcast handles that).

## Design

### Core Concept: Domain Snapshots

Each client maintains an in-memory map per domain:

```
Map<domain, Map<key, Value>>
```

This is the **domain snapshot**. On first access to a domain, the client reads all entries for that domain from the database in a single query (`read_all`) and caches them. Subsequent reads are pure memory lookups — no I/O.

The domain's `generation` counter (already in the schema) acts as the change-detection signal. The client stores the generation it loaded at, and on refresh, only reloads domains whose generation has changed.

### Change Detection: `PRAGMA data_version`

In WAL mode, SQLite writes go to the `-wal` file, not the main database file. Watching `~/.tugbank.db` with `kqueue` or `DispatchSource` would miss most writes — only catching WAL checkpoints. This makes raw file watching unreliable as the sole change-detection mechanism.

Instead, the authoritative signal is **`PRAGMA data_version`**. SQLite provides this specifically for detecting external modifications: it returns a version counter that changes whenever *any other connection* commits a write to the database. It's a single pragma call with no disk I/O — essentially free.

The client polls `PRAGMA data_version` on a short interval (500ms). When the value changes:

1. Read the `generation` column for all cached domains.
2. For any domain whose generation has increased, re-read that domain's entries.
3. Replace the in-memory snapshot atomically.

This is cheap: one pragma check per poll (no I/O), then on actual change, one `SELECT` to check generations + one `SELECT` to reload per changed domain. Most changes touch one domain.

**Why not file watching?** File-system events can supplement polling as a hint to check sooner (reducing latency from 100ms to near-instant), but they cannot be the sole mechanism due to WAL. A hybrid approach — file watch as a fast-path trigger, `data_version` poll as the reliable fallback — is possible but adds complexity. Pure `data_version` polling at 500ms is simple, reliable, and fast enough for UI reactivity.

### Writes: Write-Through Cache

Writes go directly to the database (using the existing `DefaultsStore` API), then update the local cache in the same call. The next `data_version` poll will see a change (from the perspective of other connections), but the local client's generation check will see the cache is already current and skip the reload.

Note: `PRAGMA data_version` only changes when *another* connection commits. A connection's own writes do not change its `data_version`. This is exactly what we want — the write-through cache handles the local update, and `data_version` polling handles external updates.

```
client.set(domain, key, value)
  → store.domain(domain).set(key, value)    // DB write
  → update local snapshot                    // cache update
  → return
```

Other processes polling `data_version` will detect the change on their next poll cycle and refresh their caches.

### Write Contention

SQLite WAL mode with `busy_timeout=5000` already serializes writers. The existing `BEGIN IMMEDIATE` + generation CAS pattern handles concurrent writes correctly:

- Two clients writing to the **same domain** at the same time: SQLite serializes the transactions. Both succeed. Each client's `data_version` poll detects the other's write and triggers a reload of the domain.
- Two clients writing to **different domains**: WAL allows readers and one writer concurrently. Transactions are short (single upsert + generation bump), so contention is minimal.
- **CAS writes** (`set_if_generation`): Work exactly as before. The in-memory generation is checked first (fast-path rejection), then the database CAS provides the authoritative check.

No new locking or coordination protocol is needed. SQLite is already the coordination point.

### The TypeScript Case: tugdeck

tugdeck runs in a WebView. It can't open SQLite or watch files. It currently accesses tugbank through tugcast's `/api/defaults/` HTTP endpoints.

**Full snapshots pushed via the existing WebSocket**

tugdeck already maintains a persistent WebSocket connection to tugcast using a binary frame protocol (`connection.ts`, `protocol.ts`). Each frame carries a feed ID byte. Domain snapshots use a new feed ID (e.g., `DEFAULTS: 0x50`).

The DEFAULTS frame carries the **complete domain snapshot** — not just a generation number. This eliminates two problems at once: no follow-up HTTP fetch needed (no stale window during fetch), and cold-start initialization is just waiting for the first batch of frames.

```
Feed: 0x50  DEFAULTS
Payload (JSON): {
  "domain": "dev.tugtool.deck.layout",
  "generation": 42,
  "entries": {
    "layout": {"kind":"json","value":{...}}
  }
}
```

**On WebSocket connect**: tugcast pushes a DEFAULTS frame for every domain that has data. tugdeck's `TugbankClient` populates its cache from these frames. An `await client.ready()` promise resolves when the initial batch is received (tugcast sends a sentinel frame to mark "initial sync complete").

**On domain change**: tugcast's `TugbankClient` detects the change (via `PRAGMA data_version` polling), reloads the domain, and pushes a DEFAULTS frame with the full updated snapshot to all connected WebSocket clients.

**After `ready()` resolves**: All reads are truly synchronous — pure map lookups against a fully populated cache. No stale window, no async fetch-on-miss.

```typescript
class TugbankClient {
  private cache: Map<string, { generation: number; entries: Map<string, TaggedValue> }>;
  private connection: TugConnection;
  private readyPromise: Promise<void>;

  /** Resolves when initial domain snapshots have been received. */
  ready(): Promise<void> { return this.readyPromise; }

  /** Synchronous read. Returns undefined only if key doesn't exist. */
  get(domain: string, key: string): TaggedValue | undefined {
    return this.cache.get(domain)?.entries.get(key);
  }

  // Called when DEFAULTS frame arrives via WebSocket
  private onSnapshot(domain: string, generation: number, entries: Record<string, TaggedValue>) {
    const cached = this.cache.get(domain);
    if (cached && cached.generation >= generation) return;
    this.cache.set(domain, { generation, entries: new Map(Object.entries(entries)) });
    // fire domain change callbacks
  }
}
```

Writes from tugdeck still go through the existing `PUT /api/defaults/:domain/:key` HTTP endpoint. tugdeck optimistically updates its own cache immediately on PUT (matching the write-through pattern used by Rust/Swift clients). tugcast writes to the database, its `TugbankClient` detects the change on the next poll, and pushes the updated snapshot back to all WebSocket clients. The writing client's cache is already current; other clients get the update within the poll window. The database remains the source of truth — if the PUT fails, the optimistic cache update is rolled back.

### The TypeScript Case: tugtalk

tugtalk runs in Bun, which has a native SQLite API (`bun:sqlite`). tugtalk can open `~/.tugbank.db` directly for reads and writes. For change detection, it polls `PRAGMA data_version` on a timer, same as the Rust and Swift clients. No HTTP needed.

This eliminates the `Bun.spawnSync(["tugbank", ...])` pattern entirely.

### The Swift Case: tugapp

tugapp currently shells out to the `tugbank` binary via `Process()`. Replace with a Swift client that calls `tugbank-core` via the `tugbank-ffi` C library:

1. Links `tugbank-ffi` (static library built from Rust) via a bridging header.
2. All SQLite access, value encoding/decoding, and schema migration happens in the Rust library — one implementation, not two.
3. Swift provides the in-memory cache, change callbacks, and a `Timer`-based `PRAGMA data_version` poll (via an FFI call).
4. Loads requested domains into memory on first access. Refreshes on `data_version` change.

```swift
class TugbankClient {
    private var handle: OpaquePointer  // opaque Rust TugbankClient*
    private var cache: [String: DomainSnapshot]
    private var pollTimer: Timer?

    func get(domain: String, key: String) -> TugbankValue? {
        ensureLoaded(domain)
        return cache[domain]?.entries[key]
    }

    func set(domain: String, key: String, value: TugbankValue) throws {
        // Call tugbank_ffi_set() → Rust writes to DB
        // Update local cache
    }
}
```

This eliminates all `Process()` spawns for tugbank access. The app reads theme, no-auth, session-id, and source-tree-path from memory. The Rust library handles all the tricky parts (schema, encoding, SQLite WAL); Swift is a thin caching/callback layer.

### The CLI: No Change

The `tugbank` CLI binary is a short-lived command. It opens the database, performs one operation, and exits. There's no benefit to an in-memory cache for a process that lives for milliseconds. The CLI continues using `DefaultsStore` directly, as it does today.

When the CLI writes, it modifies the database. Long-running clients (tugcast, tugapp) detect the change on their next `data_version` poll cycle.

## Change Notification Callbacks

Clients should support registering callbacks for domain changes so that higher-level code can react to external writes:

```rust
// Rust
client.on_domain_changed("dev.tugtool.app", |domain, snapshot| {
    // Theme changed externally, update UI
});
```

```swift
// Swift
client.onDomainChanged("dev.tugtool.app") { domain, snapshot in
    // Theme changed, update WebView
}
```

```typescript
// TypeScript (tugdeck)
client.onDomainChanged("dev.tugtool.app", (domain, snapshot) => {
    // Theme changed, apply new CSS
});
```

This is how tugapp could react to a theme change written by tugdeck, or how tugdeck could react to a setting changed by tugapp — without polling.

## Implementation Order

### Phase 1: Rust `TugbankClient` in `tugbank-core` (DONE)

Completed in tugplan-tugbank-in-process-clients (PR #158):
- `TugbankClient` in `tugbank-core` with in-memory domain snapshots, `PRAGMA data_version` polling, domain change callbacks, `Send + Sync`
- tugcast migrated from raw `DefaultsStore` to `TugbankClient` for HTTP handlers
- `FeedId::Defaults = 0x50` added to tugcast-core protocol
- DEFAULTS feed implemented in tugcast (`feeds/defaults.rs`) — aggregated domain snapshots pushed via WebSocket watch channel
- `DEFAULTS: 0x50` added to tugdeck `protocol.ts`

### Phase 2: `tugbank-ffi` crate

New `tugbank-ffi` crate exposing `extern "C"` functions:
- `tugbank_open(path) → handle`
- `tugbank_get(handle, domain, key) → tagged value`
- `tugbank_set(handle, domain, key, tagged_value)`
- `tugbank_data_version(handle) → u64`
- `tugbank_read_domain(handle, domain) → serialized snapshot`
- `tugbank_close(handle)`

Build as a static library (`.a`) for linking into the Swift app.

**FFI memory management**: Values cross the boundary as JSON-serialized byte buffers. `tugbank_get` and `tugbank_read_domain` return a Rust-allocated C string (`*mut c_char`) containing the JSON-encoded tagged value or snapshot. The caller must free it via `tugbank_free_string(ptr)`. String parameters (`domain`, `key`) are borrowed `*const c_char` — Rust reads them, caller retains ownership. This keeps the FFI surface simple and avoids exposing Rust's `Value` enum layout to C.

Note: The DEFAULTS feed work originally planned for Phase 2 was completed as part of Phase 1.

### Phase 3: TypeScript `TugbankClient` in tugdeck

Build the in-memory client:
- Registers callback on `DEFAULTS` feed via existing `TugConnection`
- Caches full domain snapshots received via WebSocket
- `await ready()` blocks until initial sync-complete sentinel
- Synchronous reads after `ready()` — pure map lookups, no HTTP fetch
- Writes still go through `PUT /api/defaults/:domain/:key`

Migrate `settings-api.ts` to use `TugbankClient` instead of direct fetch calls.

### Phase 4: Swift `TugbankClient` in tugapp

Build the Swift client over `tugbank-ffi`:
- Link `tugbank-ffi` static library via bridging header
- In-memory domain snapshots populated via FFI calls
- `Timer`-based `PRAGMA data_version` polling (via `tugbank_data_version()`)
- Change callbacks

Replace `ProcessManager.readTugbank` / `writeTugbank` with `TugbankClient` calls.

### Phase 5: tugtalk Migration

Replace `Bun.spawnSync(["tugbank", ...])` in tugtalk with direct `bun:sqlite` access:
- Read-only path: decode `value_kind` discriminators (straightforward, minimal logic)
- Schema migration is not tugtalk's responsibility — the Rust CLI or tugcast handles that
- `PRAGMA data_version` polling for cache invalidation

## Resolved Questions

1. **Blob-heavy domains**: Not a concern — no large blobs in current usage.
2. **SQLite from Swift**: Via `tugbank-ffi` (Rust C ABI), not raw SQLite C API. One implementation of schema/encoding logic, Swift is a thin caching layer.
3. **SSE vs WebSocket for tugdeck**: WebSocket — tugdeck already has one. New `DEFAULTS` feed ID on the existing connection. Full snapshots pushed, not just generation numbers.
4. **Shared TypeScript package**: Not worth unifying. tugdeck (WebSocket-based) and tugtalk (`bun:sqlite`-based) are different enough to stay separate.
5. **WAL checkpoint considerations**: Not a problem at expected data volumes.
6. **File watching vs `PRAGMA data_version`**: `data_version` polling is the authoritative mechanism. WAL mode means file-system events on the main `.db` file miss most writes. `data_version` is reliable and essentially free.
7. **Avoiding reimplementation across languages**: `tugbank-ffi` crate exposes `extern "C"` functions. Swift links the static library. Only tugtalk reimplements a minimal read-only path via `bun:sqlite`; tugdeck doesn't touch SQLite at all.