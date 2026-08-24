# Dev Mode Port Hardening

## Problem

The Vite dev server port (5173) is hardcoded as a magic number in 11 places across 6 source files in 3 languages (Rust, Swift, Make). If Vite's default port ever changes, or if a developer needs to run on a different port, every one of these sites must be found and updated in lockstep — miss one and you get a silent failure (white window, rejected WebSocket, broken proxy).

The tugcast port (55255) is better structured — it's a CLI default that gets discovered at bind time and communicated via the UDS ready message — but the Swift app hardcodes it in the control socket path, which would break under port rolling.

### Current state: how ports flow

```
                      TUGCAST PORT (55255)
                      ═══════════════════
tugcast binds :55255  ──► ready msg {"port": 55255} ──► parent reads actual port
                                                         │
                                                         ├─► URL rewrite (good: uses runtime value)
                                                         ├─► TUGCAST_PORT env to Vite (good)
                                                         └─► Vite proxy config (good: reads env)

                      VITE PORT (5173)
                      ════════════════
Vite binds :5173      ──► ??? ──► nobody is told
                                   │
                                   ├─► auth.rs: set_dev_port(Some(5173))     ← hardcoded
                                   ├─► main.rs: wait_for_vite("127.0.0.1:5173") ← hardcoded
                                   ├─► main.rs: rewrite_auth_url ":5173"     ← hardcoded
                                   ├─► AppDelegate.swift: ":5173"            ← hardcoded
                                   ├─► ProcessManager.swift: UInt16(5173)    ← hardcoded
                                   └─► Justfile: lsof -ti :5173             ← hardcoded
```

The tugcast port follows a "discover and communicate" pattern. The Vite port follows a "hope everyone agrees" pattern. The fix is to make the Vite port work like the tugcast port.

### Hardcoded sites

**Port 5173 (Vite) — 11 sites across 6 files:**

| File | Site | Usage |
|------|------|-------|
| `tugcode/crates/tugtool/src/main.rs` | `wait_for_vite` | TCP poll target |
| `tugcode/crates/tugtool/src/main.rs` | `rewrite_auth_url_to_vite_port` | URL rewrite literal |
| `tugcode/crates/tugtool/src/main.rs` | first_spawn block | Log message |
| `tugcode/crates/tugcast/src/control.rs` | dev_mode enable | `set_dev_port(Some(5173))` |
| `tugcode/crates/tugcast/src/auth.rs` | doc comment | `Pass Some(5173)` |
| `tugapp/Sources/AppDelegate.swift` | `onDevModeResult` | URL rewrite literal |
| `tugapp/Sources/ProcessManager.swift` | `waitForViteReady` | TCP poll target |
| `tugapp/Sources/ProcessManager.swift` | doc comment | Port reference |
| `Justfile` | `app` recipe | `lsof -ti :5173` stale kill |

**Port 55255 (tugcast) — 2 problematic sites:**

| File | Site | Problem |
|------|------|---------|
| `tugapp/Sources/ProcessManager.swift` | `controlSocketPath` | Hardcoded `tugcast-ctl-55255.sock` — breaks if port rolls |
| `tugdeck/vite.config.ts` | fallback | `"55255"` fallback when `TUGCAST_PORT` is unset — acceptable as last resort |

## Design

### Principle: ports are runtime values communicated via IPC

The parent process (tugtool CLI or Swift app) is the single authority for the Vite port. It assigns the port, passes it to Vite, passes it to tugcast, and uses it for URL rewriting. No component assumes a port — every component is told.

### Port flow after fix

```
Parent starts up
  │
  ├─► reads DEFAULT_VITE_PORT from one constant (5173)
  │
  ├─► spawns Vite with --port {vite_port} --host 127.0.0.1 --strictPort
  │
  ├─► waits for Vite to bind (polls 127.0.0.1:{vite_port})
  │
  ├─► sends dev_mode message with vite_port field:
  │     {"type":"dev_mode", "enabled":true, "source_tree":"...", "vite_port":5173}
  │
  ├─► tugcast receives vite_port, calls set_dev_port(Some(vite_port))
  │
  └─► parent rewrites auth URL using the runtime vite_port value
```

Every consumer gets the port from a message, not from a constant. The constant exists in exactly one place per language as a default.

### Changes

#### 1. Define constants (one per language, one location each)

**Rust** — new shared constant in `tugcast-core` (visible to both `tugcast` and `tugtool`):
```rust
/// Default port for the Vite dev server in dev mode.
pub const DEFAULT_VITE_DEV_PORT: u16 = 5173;
```

**Swift** — in `TugConfig.swift`:
```swift
/// Default port for the Vite dev server in dev mode.
static let defaultVitePort: Int = 5173
```

Every current literal `5173` in Rust and Swift is replaced with a reference to these constants.

#### 2. Add `vite_port` to the dev_mode control message

Extend the `DevMode` variant in `control.rs`:
```rust
DevMode {
    enabled: bool,
    #[serde(default)]
    source_tree: Option<String>,
    #[serde(default)]
    vite_port: Option<u16>,     // NEW — the port Vite is actually running on
},
```

When tugcast receives an enable with `vite_port: Some(port)`, it calls `set_dev_port(Some(port))` using the value from the message — not a hardcoded constant.

When `vite_port` is absent (backward compat), tugcast falls back to `DEFAULT_VITE_DEV_PORT`.

#### 3. Parent sends vite_port in dev_mode message

**tugtool CLI** (`main.rs`): after spawning Vite, sends the port it assigned:
```rust
send_dev_mode(enabled: true, source_tree: path, vite_port: Some(vite_port))
```

**Swift app** (`ProcessManager.swift`): `sendDevMode` gains a `vitePort` parameter:
```swift
func sendDevMode(enabled: Bool, sourceTree: String?, vitePort: Int? = nil)
```

AppDelegate passes the port it used to spawn Vite.

#### 4. Parent spawns Vite with explicit --port

Both `spawn_vite_dev` (Rust) and `spawnViteDevServer` (Swift) gain a `vite_port` parameter and pass `--port {N}` to Vite:
```
vite --host 127.0.0.1 --port 5173 --strictPort
```

This makes the port assignment explicit instead of relying on Vite's default.

#### 5. URL rewriting uses runtime port

**tugtool** (`rewrite_auth_url_to_vite_port`): takes `vite_port: u16` parameter instead of hardcoding `:5173`.

**Swift** (`AppDelegate.onDevModeResult`): uses the stored `vitePort` value instead of the literal `":5173"`.

#### 6. Port polling uses runtime port

**tugtool** (`wait_for_vite`): takes `port: u16` parameter, connects to `127.0.0.1:{port}`.

**Swift** (`waitForViteReady`): takes `port: Int` parameter, polls that port.

#### 7. Fix Swift control socket path

Replace:
```swift
private var controlSocketPath: String {
    NSTemporaryDirectory() + "tugcast-ctl-55255.sock"
}
```

With:
```swift
private var controlSocketPath: String {
    NSTemporaryDirectory() + "tugcast-ctl-\(tugcastPort).sock"
}
```

Where `tugcastPort` is the port passed to `start()` or a stored property. This matches what the Rust side already does (`format!("tugcast-ctl-{}.sock", port)`).

#### 8. Justfile uses variable

```make
VITE_DEV_PORT := "5173"

app:
    ...
    lsof -ti :{{VITE_DEV_PORT}} | xargs kill 2>/dev/null || true
```

### What this does NOT change

- The tugcast port flow is already correct (runtime discovery via ready message). No changes needed except the Swift socket path fix.
- Vite's `vite.config.ts` continues to read `TUGCAST_PORT` from the environment. The `"55255"` fallback there is acceptable — it's a last-resort default for running `npm run dev` manually without the tugcast wrapper.
- The `--strictPort` flag stays. It ensures Vite fails fast if the assigned port is occupied rather than silently binding elsewhere.

## Files to modify

| File | Change |
|------|--------|
| `tugcode/crates/tugcast-core/src/lib.rs` | Add `DEFAULT_VITE_DEV_PORT` constant |
| `tugcode/crates/tugcast/src/control.rs` | Add `vite_port` to `DevMode` variant; use it in `set_dev_port` |
| `tugcode/crates/tugcast/src/auth.rs` | Update doc comment |
| `tugcode/crates/tugtool/src/main.rs` | Parameterize `wait_for_vite`, `rewrite_auth_url_to_vite_port`, `spawn_vite_dev`; use constant as default |
| `tugapp/Sources/TugConfig.swift` | Add `defaultVitePort` constant |
| `tugapp/Sources/ProcessManager.swift` | Parameterize `waitForViteReady`, `spawnViteDevServer`, `sendDevMode`; fix socket path |
| `tugapp/Sources/AppDelegate.swift` | Store and use runtime vite port |
| `Justfile` | Use variable for port |

## Verification

1. `cd tugcode && cargo build` — zero warnings
2. `cd tugcode && cargo nextest run` — all tests pass
3. `xcodebuild -project tugapp/Tug.xcodeproj -scheme Tug -configuration Debug build` — BUILD SUCCEEDED
4. `just app` with dev mode enabled — page loads, HMR works, no white window
5. Grep for bare `5173` in source files (excluding comments, tests, roadmap) — zero hits
6. Grep for bare `55255` in ProcessManager.swift socket path — zero hits
