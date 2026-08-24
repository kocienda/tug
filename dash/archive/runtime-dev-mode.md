# Runtime Dev Mode

## Problem

Dev mode requires the `--dev <source_tree>` CLI flag at process launch. Toggling dev mode in the UI saves a preference but doesn't take effect until tugcast restarts. This is a design flaw: the Mac app shows a Developer menu and "Reload Frontend" button that appear to work, but file-watching hot reload is silently absent because the running process was never told about dev mode.

The `--dev` flag must go. Dev mode must be a runtime switch.

## Design

### Control message

Add a `dev_mode` variant to the control socket protocol:

```
→ tugcast:   {"type":"dev_mode","enabled":true,"source_tree":"/path/to/tugtool"}
→ tugcast:   {"type":"dev_mode","enabled":false}
```

This is a first-class control message (like `tell` and `shutdown`), not a tell action. It changes server configuration, not client state.

### Shared dev state

Replace the static `Option<Arc<DevState>>` with a runtime-swappable shared cell:

```rust
type SharedDevState = Arc<ArcSwap<Option<DevState>>>;
```

(`arc-swap` crate — lock-free atomic pointer swap, zero contention on reads.)

The asset handler checks this on every request:

```rust
async fn serve_asset(uri: Uri, dev_state: Extension<SharedDevState>) -> Response {
    if let Some(state) = dev_state.load().as_ref() {
        // Serve from disk (dev mode)
        serve_dev_asset(uri, state).await
    } else {
        // Serve from embedded assets (production)
        serve_embedded_asset(uri).await
    }
}
```

One route handler. One fallback. No conditional router construction.

### File watcher lifecycle

The file watcher must be created and destroyed at runtime:

```rust
struct DevRuntime {
    _watcher: RecommendedWatcher,  // dropped = watcher stops
}
```

Hold `Option<DevRuntime>` alongside the shared state. When dev mode turns on, load manifest, populate shared state, create watcher. When dev mode turns off, drop the `DevRuntime` (stops watcher), swap shared state to `None`.

All of this happens in a handler for the `dev_mode` control message — no process restart, no flag parsing.

`load_manifest` does blocking filesystem I/O (reads `assets.toml`, stats paths for validation). The control message handler runs in the async recv loop, so the enable path must use `spawn_blocking` to avoid stalling the control socket.

### Watcher channel

The file watcher already sends to `client_action_tx` (the broadcast channel for WebSocket Control frames). This doesn't change. The watcher is created with a clone of `client_action_tx`, same as today. The only difference is *when* it's created: at runtime instead of at startup.

### Mac app changes

**ProcessManager.swift** — Remove `--dev` from the args array. After receiving the `ready` message from tugcast, send the dev_mode control message:

```swift
processManager.onReady = { [weak self] url in
    self?.window.loadURL(url)
    // Enable dev mode at runtime (no restart needed)
    if self?.devModeEnabled == true, let path = self?.sourceTreePath {
        self?.processManager.sendDevMode(enabled: true, sourceTree: path)
    }
}
```

**bridgeSetDevMode** — Send the control message immediately when the user toggles:

```swift
func bridgeSetDevMode(enabled: Bool, completion: @escaping (Bool) -> Void) {
    self.devModeEnabled = enabled
    self.savePreferences()
    self.updateDeveloperMenuVisibility()
    // Take effect immediately — no restart
    if enabled, let path = sourceTreePath {
        processManager.sendDevMode(enabled: true, sourceTree: path)
    } else {
        processManager.sendDevMode(enabled: false, sourceTree: nil)
    }
    completion(enabled)
}
```

### CLI changes

- Delete `--dev` from `cli.rs`
- Delete all `cli.dev` handling from `main.rs`
- `build_app` no longer takes `dev_state: Option<Arc<DevState>>` — it takes `SharedDevState` always
- `run_server` signature simplifies accordingly

### What stays the same

- Manifest format (`tugdeck/assets.toml`) — unchanged
- `load_manifest`, `validate_manifest`, `watch_dirs_from_manifest` — unchanged, just called from the control message handler instead of main
- `serve_dev_asset`, `serve_dev_index_impl` — unchanged logic, takes state by reference instead of Extension
- `has_reload_extension`, debounce task — unchanged
- `bun build --watch` — still launched by the Mac app separately (unchanged)
- Control socket protocol — additive (new message type, existing types unchanged)

## Scope

| File | Change |
|------|--------|
| `tugcast/src/cli.rs` | Remove `--dev` field |
| `tugcast/src/main.rs` | Remove dev setup from main, create `SharedDevState`, pass to server |
| `tugcast/src/server.rs` | Unified asset handler, `build_app` takes `SharedDevState` |
| `tugcast/src/dev.rs` | Add `DevRuntime` struct, `enable_dev_mode`/`disable_dev_mode` functions |
| `tugcast/src/control.rs` | Add `DevMode` variant to `ControlMessage`, handle in recv loop |
| `tugcast/src/integration_tests.rs` | Update `build_app` calls, add dev mode toggle tests |
| `tugcast/Cargo.toml` | Add `arc-swap` dependency |
| `tugapp/Sources/ProcessManager.swift` | Remove `--dev` arg, add `sendDevMode` method |
| `tugapp/Sources/AppDelegate.swift` | Send control message on toggle and on ready |

## Non-goals

- Adding dev mode to the HTTP API (control socket only)
