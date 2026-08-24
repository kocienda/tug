# Full Hot Reload: CSS, TypeScript, and Rust

## Problem

Dev mode hot reload only works for CSS today. TypeScript and Rust changes require manual rebuilds. The goal: **edit any source file, see the change live in the running app.**

## The `--dev` flag is dead

The `--dev` CLI flag is **completely obsolete**. It was removed from tugcast's CLI, and dev mode is now activated exclusively at runtime via the control socket `dev_mode` message. Any remaining references to `--dev` in `tugtool/src/main.rs`, `Justfile`, or elsewhere are bugs that must be cleaned up. The only way to enter dev mode is through the control socket protocol.

## Current State

### What works

**CSS**: Edit a `.css` file in `tugdeck/styles/` → file watcher detects the change → WebSocket sends `reload_frontend` → browser does `location.reload()` → new CSS served directly from source via `assets.toml` files map. No build step. Instant.

### What's broken

**TypeScript**: The pipeline *exists* but has gaps.
- `bun build --watch` compiles `src/main.ts` → `dist/app.js` on every `.ts` change.
- The file watcher detects `dist/app.js` changes (it watches the fallback dir).
- The reload signal fires, browser reloads, new JS loads from `dist/`.
- **But**: `bun build --watch` isn't always running. The Mac app (`ProcessManager.swift`) spawns it when dev mode is enabled — this path works. The CLI path (`tugtool`) still has stale `--dev` flag code that tries to pass it to tugcast, which rejects it. So `just dev` is broken. This is a bug — see above.

**Rust**: No mechanism at all. Editing a `.rs` file does nothing. The developer must manually `cargo build`, then restart tugcast. There is no watcher, no rebuild trigger, no process restart.

## Architecture

Two dev mode entry points need to work. The primary workflow is the Mac app via `just app`.

```
┌────────────────────────────────────────────────────────────────┐
│ Path A: Mac App (Tug.app via `just app`)              PRIMARY  │
│                                                                │
│   ProcessManager starts tugcast                                │
│   → tugcast sends `ready` over UDS                             │
│   → AppDelegate sends `dev_mode` control message               │
│   → tugcast enables dev mode at runtime                        │
│   → ProcessManager spawns `bun build --watch`                  │
│                                                                │
│   Status: Works for CSS + TypeScript. No Rust.                 │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ Path B: CLI (`just dev`)                             SECONDARY │
│                                                                │
│   tugtool spawns tugcast                                       │
│   → waits for `ready` on control socket                        │
│   → sends `dev_mode` control message with source tree path     │
│   → spawns `bun build --watch`                                 │
│                                                                │
│   Status: Broken (stale --dev flag code). Must be fixed.       │
└────────────────────────────────────────────────────────────────┘
```

## Proposal

### Phase 1: Remove all `--dev` flag remnants and fix the CLI dev path

**Clean up the dead `--dev` code and fix `tugtool` to use the control socket protocol.**

`tugtool/src/main.rs` changes:
- Remove the `--dev` CLI flag and `dev_path` parameter from `spawn_tugcast()`.
- Keep the `--source-tree` flag (useful for explicit override) and `detect_source_tree()`.
- After `wait_for_ready()`, send `{"type":"dev_mode","enabled":true,"source_tree":"<path>"}` over the control socket's write half.
- `spawn_bun_dev()` already works and stays as-is.

`Justfile` changes:
- Update `just dev` to invoke `tugtool` without `--dev` (the source tree is auto-detected, dev mode is activated via control socket).

After this, `just dev` works again, and CSS + TypeScript hot reload works from the CLI.

### Phase 2: Tugcast watches its own binary — one watcher for both paths

**Put the binary mtime watcher inside tugcast itself**, so it works identically whether tugcast is managed by the Mac app or by `tugtool`.

When dev mode is enabled, tugcast already knows its own binary path (`std::env::current_exe()`). It already has the `notify` crate and a file watcher infrastructure in `dev.rs`. The binary watcher fits naturally here:

1. When `enable_dev_mode()` is called, also start watching the tugcast binary's mtime.
2. Poll every 2 seconds. When mtime changes, wait 500ms for the write to finish.
3. Send `{"type":"shutdown","reason":"restart","pid":<pid>}` over the control socket.
4. The supervisor (whether `ProcessManager.swift` or `tugtool`'s supervisor loop) handles the restart — both already do this correctly.

The new tugcast binary is picked up on respawn because:
- **Mac app path**: `ProcessManager` needs to copy the new binary into the app bundle before respawning. Tugcast sends a `binary_updated` control message before the shutdown, giving `ProcessManager` a chance to copy. (Or: tugcast sends shutdown with `reason: "binary_updated"`, and `ProcessManager` handles it as copy-then-restart.)
- **CLI path**: `tugtool` resolves the binary path on each spawn (already does this via `resolve_tugcast_path()`), so it picks up the new binary automatically.

This is **one watcher, one implementation**, shared by both entry points.

#### Mac app: handling the binary copy

`ProcessManager.swift` needs one small addition: when it sees a shutdown with `reason: "binary_updated"`, it copies `tugcode/target/debug/tugcast` into the app bundle before respawning. This is a few lines in the existing `handleControlMessage` switch. The source tree path is already stored in the `SourceTreePath` UserDefault.

### Phase 3: Unified dev runner (`just dev` does everything)

After phases 1-2, `just dev` is a fully functional alternative entry point:

```just
# Start full dev environment with hot reload for everything
dev: build
    tugcode/target/debug/tugtool
```

`tugtool` auto-detects the source tree, handles everything:
- Starting tugcast
- Sending `dev_mode` over the control socket
- Spawning `bun build --watch` for TypeScript
- Tugcast watches its own binary for Rust rebuilds (phase 2)
- Supervisor respawns tugcast when it exits with restart reason

#### Optional: `cargo watch` integration

For a fully hands-free Rust workflow, `tugtool` can optionally spawn `cargo watch`:
```
cargo watch -w tugcode/crates -s "cargo build -p tugcast -p tugtool"
```

This eliminates the need to manually run `cargo build`. The binary watcher inside tugcast still handles the restart — `cargo watch` just automates the build step. This can be added later if warranted.

## Summary of changes

| Phase | Files | What changes |
|-------|-------|-------------|
| 1 | `tugtool/src/main.rs`, `Justfile` | Remove dead `--dev` flag, send `dev_mode` via control socket |
| 2 | `tugcast/src/dev.rs`, `tugapp/Sources/ProcessManager.swift` | Tugcast watches its own binary; ProcessManager handles `binary_updated` restart reason |
| 3 | `Justfile` | Simplify `just dev` (may already work after phase 1-2) |

## What each language gets

| Language | Edit → Live | Mechanism |
|----------|------------|-----------|
| CSS | Edit file → instant reload | File watcher → `reload_frontend` → `location.reload()`. Served directly from source. |
| TypeScript | Edit file → ~1-2s reload | `bun build --watch` recompiles → file watcher detects `dist/app.js` → reload. |
| Rust | `cargo build` → ~3-5s restart | Tugcast detects its own binary changed → self-restart via control socket → frontend reconnects. |
| Rust (with cargo-watch) | Edit file → ~10-20s restart | `cargo watch` auto-builds → tugcast detects → restart. Fully hands-free. |

## Non-goals

- **HMR (Hot Module Replacement)**: All reloads are full page reloads via `location.reload()`. No CSS injection, no partial JS replacement, no state preservation. This is fine for the current stage.
- **Incremental Rust compilation**: `cargo build` already does incremental compilation. No special handling needed.
- **Multi-binary watching**: Only `tugcast` needs restart. `tugcode` and `tugtool` are CLI tools that don't run persistently. `tugtalk` is spawned on-demand by tugcast's agent bridge.
