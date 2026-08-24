# Tugbank Change Detection

## Problem

When a process writes to tugbank, other processes need to know. The writer knows what changed — it just needs to tell everyone else. This happens rarely (theme changes, CLI settings writes) but must be reliable when it does happen.

## What We Tried and Why It Failed

### Polling (original)

Every TugbankClient ran its own polling loop — dedicated threads, timers, `PRAGMA data_version` checks every 500ms. Too much machinery for infrequent events. Caused launch hitches, wasted CPU, added complexity (thread safety, cache invalidation, generation tracking) in every client.

### Darwin notifications

`notify_post` for broadcast works perfectly — one C call, fire-and-forget. But the Rust listen side was a disaster. `notify_register_dispatch` requires Objective-C blocks, which can't be done cleanly from Rust FFI. The workaround — `notify_register_file_descriptor` + hand-rolled `select()` loop + raw pointers — led to deadlocks, intermittent write failures, and unsafe code. Abandoned.

### Per-process Unix sockets

Each listening process creates its own socket (`~/.tugbank/notify/<pid>.sock`). Writers iterate the directory and `sendto` each. Problems: race conditions on socket creation, no coordination across processes, stale socket cleanup, runaway socket files, wrong directory location. Fundamentally unsuitable for cross-process coordination.

## Design: tugcast as IPC Coordinator

tugcast is already the long-running process that all other pieces depend on. It runs the HTTP server, the WebSocket, and the DEFAULTS feed. It is the natural coordination point.

### Architecture

```
                    ┌─────────────────────────────────┐
                    │           tugcast               │
                    │                                 │
                    │  ┌───────────────────────────┐  │
                    │  │ Unix datagram socket      │  │
                    │  │ (receives domain-change   │  │
                    │  │  notifications from CLI   │  │
                    │  │  and other writers)       │  │
                    │  └──────────┬────────────────┘  │
                    │             │                   │
                    │             ▼                   │
                    │  ┌───────────────────────────┐  │
                    │  │ TugbankClient             │  │
                    │  │ (refreshes cache,         │  │
                    │  │  fires onDomainChanged)   │  │
                    │  └──────────┬────────────────┘  │
                    │             │                   │
                    │             ▼                   │
                    │  ┌───────────────────────────┐  │
                    │  │ DEFAULTS feed             │  │
                    │  │ (rebuilds frame,          │  │
                    │  │  pushes via WebSocket)    │  │
                    │  └──────────┬────────────────┘  │
                    │             │                   │
                    └─────────────┼───────────────────┘
                                  │
                    ┌─────────────┼──────────────┐
                    │             │              │
                    ▼             ▼              ▼
               ┌─────────┐ ┌─────────┐   ┌──────────┐
               │ tugdeck │ │ tugapp  │   │ tugtalk  │
               │ (WS)    │ │(SQLite) │   │ (SQLite) │
               └─────────┘ └─────────┘   └──────────┘
```

### The Socket

tugcast creates and owns a single Unix datagram socket at a well-known path in the per-user runtime directory:
- **macOS:** `confstr(_CS_DARWIN_USER_TEMP_DIR)` → `/var/folders/.../T/tugbank-notify.sock`
- **Linux:** `$XDG_RUNTIME_DIR/tugbank-notify.sock` → `/run/user/<uid>/tugbank-notify.sock`

One socket. One owner (tugcast). No races.

**Single-instance guarantee:** tugcast's TCP port bind (default 55255) is the OS-enforced single-instance guard. If the port is already held by another tugcast, the new one fails to bind and exits. No advisory locks, no PID files.

**Force reclaim (`--force` flag):** Development escape hatch. When `--force` is passed and the TCP port is already bound, tugcast finds the PID holding the port, sends SIGKILL, waits briefly, then proceeds with normal startup. This avoids manual `lsof`/`pkill` work when a zombie tugcast is holding the port. Not the normal path — the normal path is: try to bind, fail if occupied, exit.

**Socket lifecycle:**
1. tugcast binds the TCP port. If this succeeds, we are the only tugcast.
2. If the notification socket file already exists, unlink it. (It's stale — the previous tugcast is dead, because if it were alive, the TCP bind would have failed.)
3. Bind the notification socket.
4. On clean shutdown, unlink the socket file.
5. On crash, the socket file is left behind — cleaned up by step 2 on the next startup, or by the OS on reboot (the runtime dir is tmpfs).

**The socket is a doorbell, not a queue.** It carries datagrams containing domain names — short strings like `dev.tugtool.app`. A datagram says "something changed in this domain, go re-read the database." If a datagram is dropped (kernel buffer full, tugcast not reading fast enough), the database still has the correct data — it just won't be pushed to clients until the next notification. This is acceptable for the use case (infrequent settings changes).

**Socket path:** `<temp_dir>/tugbank-notify.sock`. On macOS this resolves to `/var/folders/.../T/tugbank-notify.sock`. Each language computes this from its native temp dir API: Rust `std::env::temp_dir()`, Swift `FileManager.default.temporaryDirectory`, TypeScript `os.tmpdir()`.

**Self-notification:** When tugcast writes to tugbank via its own `TugbankClient::set()`, it broadcasts to its own socket. It receives its own notification, re-reads the domain, fires `onDomainChanged`, and the DEFAULTS feed rebuilds the frame. This is correct and necessary — it's the single code path by which the DEFAULTS feed learns about all writes, including those from tugdeck via HTTP PUT. Do not optimize this away.

Properties:
- `SOCK_DGRAM` — no connections, no handshake, no ordering guarantees
- Per-user directory with mode 700 — other users can't see or access it
- Managed by the OS — cleaned up on reboot (tmpfs)
- One socket per user, deterministic path — no PID, no port number
- No directory iteration on the write side — one `sendto` to a known path
- If tugcast isn't running, the socket doesn't exist, and writers fail silently (correct behavior)

### Write Side

Any process that writes to tugbank sends a datagram to the socket after the write succeeds:

```
sendto(tugbank-notify.sock, domain_name_bytes)
```

If the `sendto` fails, print a warning to stderr and move on. The DB write already succeeded — the notification is supplementary, not critical. No retry, no error code, no fallback.

```
warning: tugbank notify: <reason> (domain: dev.tugtool.app)
```

Failure modes:
- `ENOENT` — socket not found (tugcast not running). Warning: "socket not found — tugcast not running?"
- `ECONNREFUSED` — stale socket file (tugcast crashed). Warning: "stale socket"
- `ENOBUFS`/`EAGAIN` — kernel buffer full (tugcast not reading fast enough). Warning: "buffer full"

Writers:
- **tugbank CLI** — after successful `write`, `delete`, or `set_if_generation` command
- **Rust TugbankClient::set()** — after successful DB write (covers tugcast's own writes and writes from tugdeck via HTTP PUT)
- **Swift TugbankClient.set()** — after successful SQLite write (tugapp native)
- **tugtalk** — deferred (only writes session-id, no broadcast needed currently)

### Receive Side

tugcast binds the socket on startup and receives datagrams in a background task (tokio). Each datagram contains a domain name.

**Receive-side debounce (50ms):** When a datagram arrives for a domain, tugcast starts a 50ms timer for that domain. If another datagram arrives for the same domain during the window, the timer resets. When the timer fires, tugcast does the actual work:

1. Re-read the domain from the database via the TugbankClient
2. Update the in-memory cache
3. Fire `onDomainChanged` callbacks
4. The DEFAULTS feed callback rebuilds the aggregated frame and pushes it to all WebSocket clients

This collapses bursts (e.g., a script writing 10 keys to the same domain) into a single re-read and push. Single writes have 50ms latency — imperceptible for settings changes. The write side stays simple: broadcast immediately, no timer, no batching.

### Client Behavior

| Client | Writes via | Receives changes via |
|--------|-----------|---------------------|
| **tugbank CLI** | Direct DB + sendto socket | N/A (exits after write) |
| **tugcast** | TugbankClient::set() + sendto socket | Unix socket → cache refresh → DEFAULTS feed |
| **tugdeck** | HTTP PUT to tugcast | WebSocket DEFAULTS feed (already works) |
| **tugapp** | Direct SQLite + sendto socket | Indirectly via tugdeck bridge callbacks (see below) |
| **tugtalk** | Direct DB (bun:sqlite) + sendto socket | N/A (short-lived, reads at startup) |

**tugapp change flow:** tugapp (native Swift) doesn't have its own WebSocket connection to tugcast. tugdeck (running inside tugapp's WebView) receives DEFAULTS frames via WebSocket. When tugdeck detects a theme change, it applies the CSS theme and calls `bridgeSetTheme` via the WebKit message handler, which reaches Swift `AppDelegate` to update the window background color. So the full path for a CLI theme change is: CLI → socket → tugcast → DEFAULTS feed → WebSocket → tugdeck → bridge callback → tugapp native.

### Startup Ordering Constraint

tugcast must bind the notification socket before it reads any tugbank data or starts serving clients. The required startup order:

1. **Bind the TCP port** (single-instance guard). If occupied and `--force` is set, kill the holder and retry. If occupied without `--force`, exit with error.
2. **Unlink stale socket file if it exists, then bind the Unix datagram socket.** We know the previous owner is dead because the TCP bind succeeded.
3. **Open the TugbankClient** (read current DB state into cache).
4. **Start the HTTP server, WebSocket, and DEFAULTS feed.**
5. **Signal readiness** to the parent process (Tug.app).

The app (Tug.app) should make a best effort to ensure tugcast has completed step 1 before proceeding with other work that writes to tugbank (e.g., writing `source-tree-path`, configuring the Swift TugbankClient via FFI). This avoids the window where a write happens after tugcast reads the DB but before the socket is bound — which would cause the write to be invisible until the next notification.

If the socket isn't ready yet when a writer fires, the write still succeeds (it goes directly to the database) — the only consequence is that tugcast won't push the change to WebSocket clients until the next notification arrives. This is acceptable as a transient startup condition, not a correctness issue.

### What This Eliminates

- All polling threads, timers, `PRAGMA data_version` checks
- All Darwin notification code (`notify_post`/`notify_register_file_descriptor` FFI in Rust, `notify_register_dispatch` in Swift, `notify_post` via bun:ffi in tugtalk)
- The `libc` dependency in tugbank-core (was added for the `select()` loop)
- The `notify.h` bridging header import in Swift

## Delete Rust FFI

The tugbank-ffi approach linked the entire Rust runtime + SQLite + serde_json into the Swift app as a static library. In debug builds this bloated `Tug.debug.dylib` from 567KB to 6.2MB — an 11x increase that caused a visible app launch regression. The FFI is not needed: the Swift app's tugbank usage is simple (a few reads at startup, a few writes on user action) and can be done with direct SQLite access via the system `libsqlite3`, the same approach tugtalk uses with `bun:sqlite`.

### Delete checklist

- [ ] Delete `tugcode/crates/tugbank-ffi/` (entire crate)
- [ ] Remove `tugbank-ffi` from `tugcode/Cargo.toml` workspace members
- [ ] Remove `-p tugbank-ffi` from `just build` in Justfile
- [ ] Delete `tugapp/Sources/TugbankClient.swift` (FFI-based client)
- [ ] Delete `tugapp/Sources/TugbankFFI/include/tugbank_ffi.h` (C header)
- [ ] Delete `tugapp/Sources/Tug-Bridging-Header.h`
- [ ] Remove TugbankClient.swift, tugbank_ffi.h, Tug-Bridging-Header.h file references from `Tug.xcodeproj/project.pbxproj`
- [ ] Remove linker flags from Xcode project: `-ltugbank_ffi`, `-lsqlite3`, `-liconv`, `-framework Security`
- [ ] Remove `HEADER_SEARCH_PATHS`, `LIBRARY_SEARCH_PATHS`, `SWIFT_OBJC_BRIDGING_HEADER` build settings from project.pbxproj
- [ ] Revert `ProcessManager.swift` to direct CLI fallback (remove TugbankClient.shared delegation)
- [ ] Revert `AppDelegate.swift` — remove `TugbankClient.configure` call
- [ ] Verify: `just app` launches fast (Tug.debug.dylib back to ~567KB), cards load, dev mode works

## Implement Swift TugbankClient (native SQLite)

Replace the FFI-based client with a pure Swift client that opens `~/.tugbank.db` directly via the system `libsqlite3`. Same approach as tugtalk's `bun:sqlite` client — direct database access in the native language.

### Schema (from tugbank-core/src/schema.rs)

```sql
CREATE TABLE domains (
    name        TEXT PRIMARY KEY,
    generation  INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL
);

CREATE TABLE entries (
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
```

### Value encoding (from tugbank-core/src/value.rs)

| kind | Swift type | SQL column |
|------|-----------|------------|
| 0 (Null) | nil | all payload columns NULL |
| 1 (Bool) | Bool | value_i64: 0 or 1 |
| 2 (I64) | Int64 | value_i64 |
| 3 (F64) | Double | value_f64 |
| 4 (String) | String | value_text |
| 5 (Bytes) | Data | value_blob |
| 6 (Json) | Any (JSONSerialization) | value_text (JSON string) |

### Pragmas (from tugbank-core/src/schema.rs)

Applied on every open:
```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

### Write pattern (from tugbank-core/src/domain.rs)

```sql
-- In a single IMMEDIATE transaction:
INSERT OR IGNORE INTO domains (name, generation, updated_at) VALUES (?1, 0, ?2);
INSERT INTO entries (domain, key, value_kind, value_i64, value_f64, value_text, value_blob, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
  ON CONFLICT(domain, key) DO UPDATE SET
    value_kind = excluded.value_kind, value_i64 = excluded.value_i64,
    value_f64 = excluded.value_f64, value_text = excluded.value_text,
    value_blob = excluded.value_blob, updated_at = excluded.updated_at;
UPDATE domains SET generation = generation + 1, updated_at = ?2 WHERE name = ?1;
```

After the transaction, send a datagram to the notification socket:
```swift
sendto(notifySocket, domain.utf8, socketPath)
```

### Swift implementation plan

- [ ] New `TugbankClient.swift` using `import SQLite3` (system library, no extra linking)
- [ ] Open `~/.tugbank.db` with `sqlite3_open_v2`, apply pragmas
- [ ] `TugbankValue` enum: `.null`, `.bool(Bool)`, `.i64(Int64)`, `.f64(Double)`, `.string(String)`, `.json(Any)`
- [ ] `get(domain:key:)` → query entries table, decode value_kind
- [ ] `set(domain:key:value:)` → IMMEDIATE transaction, upsert + generation bump, sendto notification socket
- [ ] `getString(domain:key:)`, `getBool(domain:key:)`, `setString`, `setBool` — convenience wrappers
- [ ] `listDomains()` → query domains table
- [ ] Singleton `TugbankClient.shared` configured in `AppDelegate.applicationDidFinishLaunching`
- [ ] `ProcessManager.readTugbank` / `writeTugbank` / `readTugbankBool` delegate to TugbankClient.shared
- [ ] `deinit` calls `sqlite3_close`
- [ ] No cache, no polling, no threads — reads go to SQLite every time (a few reads at startup, negligible cost)
- [ ] Notification socket path: `FileManager.default.temporaryDirectory` + `tugbank-notify.sock`

### Verification

- [ ] `just app` launches fast (no Rust dylib/static lib in app binary)
- [ ] `Tug.debug.dylib` size back to baseline (~567KB)
- [ ] Cards load, dev mode works
- [ ] `tugbank write` from CLI + `tugbank read` from CLI both work
- [ ] ProcessManager.readTugbank/writeTugbank work through the new native client
- [ ] No FFI references remain in tugapp/

## Implementation (notification system)

### tugtalk — deferred

tugtalk's only write is `session-id`, which is driven by tugdeck, not changed unilaterally. No process needs instant notification of this write. Broadcast from tugtalk is deferred.

**Open issue for the future:** Bun has no native Unix datagram socket support. If tugtalk ever needs to broadcast, the options are: (1) Bun FFI to libc `socket`/`sendto` (two syscalls, should be simple but untested), (2) route tugtalk writes through tugcast via HTTP PUT (same as tugdeck), or (3) call the `tugbank` CLI which already broadcasts. This is a known gap in the TypeScript side of the notification system.

### tugcast — bind and listen on the notification socket

- [ ] Bind Unix datagram socket in main.rs startup (after TCP bind, before TugbankClient open)
- [ ] Unlink stale socket file before binding (safe — TCP bind already proved we're the only instance)
- [ ] Add receive loop in a tokio task with 50ms per-domain debounce
- [ ] On notification: call `TugbankClient::refresh_domain()` to reload cache + fire callbacks
- [ ] Unlink socket on clean shutdown
- [ ] Add `--force` flag for TCP port reclaim (kill holder, then bind)

### Verification

After all implementation:
- [ ] `just ci` passes
- [ ] `cd tugdeck && npx tsc --noEmit` passes
- [ ] `cd tugtalk && bun test` passes
- [ ] `just app` — app launches fast, cards load, dev mode works
- [ ] Manual smoke test: `tugbank write dev.tugtool.app theme harmony` while app running — app reacts
- [ ] `tugbank write dev.tugtool.app theme brio` — app switches back
- [ ] Both transitions work without restart
