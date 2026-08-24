# Dev Mode Notifications: Simplified Reload Strategy

## Problem

The current hot reload plan (full-hot-reload.md) attempts to make all source changes automatically reload, restart, or relaunch the running application. This creates gnarly problems:

1. **Restarting code from under the user.** When tugcast detects its own binary changed and self-restarts, the user may be mid-interaction. The page reloads, WebSocket connections drop, terminal state resets. This is jarring and produces bad UX.

2. **Cascading restarts.** A backend change triggers a rebuild, which triggers a binary watcher, which triggers a shutdown, which triggers a re-spawn, which re-sends dev_mode, which re-creates watchers. Each link in this chain can fail, race, or produce duplicate events.

3. **Mac app complexity.** Copying a new binary into the app bundle at runtime, then respawning — while the user is actively using the app — is fragile and hard to test. If the copy fails partway through, the app bundle is corrupted.

4. **No user agency.** The user has no say in when the restart happens. There's no way to finish what you're doing, then apply the change.

The fix: **stop auto-reloading compiled code entirely.** Keep instant hot reload for CSS and non-compiled markup (it works, it's safe, it's fast). For everything else, track changes with file watchers but only *notify* the user — let them decide when to apply.

## Definitions

Four operations, each a superset of the previous:

| Operation | What it does | Trigger |
|-----------|-------------|---------|
| **Reload** | Updates CSS and non-compiled markup (HTML, fonts). No compilation. | Automatic — changes appear instantly |
| **Restart** | Picks up already-compiled frontend and backend changes, restarts tugcast. Includes a reload. | On-demand — user clicks "Restart" button |
| **Relaunch** | Builds everything (frontend, backend, and app code), replaces the app, relaunches from scratch. Includes a restart. | On-demand — user clicks "Relaunch" button |
| **Reset** | Clears all user state and caches (localStorage, preferences, beads), returns to factory settings, then does a relaunch. | On-demand — user clicks "Reset" button |

### Key distinction: Restart vs. Relaunch

**Restart** is fast because the builds have already happened. The Vite dev server continuously recompiles frontend code via HMR. `cargo-watch` (or manual `cargo build`) produces new backend binaries. The Category 2 watchers detect these *build outputs* and notify the user. When the user clicks Restart, there's nothing left to build — it's just a process restart.

**Relaunch** includes a build step because the Category 3 watcher monitors app *source files*, not build outputs. There's no equivalent of the Vite dev server for xcodebuild. When the user clicks Relaunch, the build must happen. A dedicated helper binary (`tugrelaunch`) handles the full build-replace-relaunch cycle.

## Current State

### What works and stays the same

**CSS hot reload** is instant and reliable. The file watcher in `dev.rs` detects changes to source CSS files, sends `reload_frontend` over the control socket, and the browser does `location.reload()`. Assets are served directly from source via `assets.toml`. This is the "reload" operation. It stays exactly as-is.

### What changes

**Frontend auto-reload** previously worked via `bun build --watch` → file watcher detects `dist/app.js` change → `reload_frontend`. This has been superseded: the Vite dev server handles hot module replacement (HMR) directly. TS/TSX and CSS file changes are hot-reloaded via the `vite:afterUpdate` event bridge, which dispatches the `td-hmr-update` CustomEvent and triggers the "Reloaded" flash on the Frontend row. No `dist/app.js` watcher is needed.

**Backend binary watcher** (`spawn_binary_watcher` in `dev.rs`) currently sends exit code 44 to trigger an automatic shutdown and restart. This entire mechanism must be removed. Instead, the watcher sets a "backend changed" dirty flag and sends a notification.

**App changes** have no watcher today. A new watcher should monitor `tugapp/Sources/` for app source file changes and set an "app changed" dirty flag with notification.

## Architecture

### File Watchers: Track and Notify, Don't Act

The file watcher in `dev.rs` currently has one behavior: detect change → reload. The new design introduces three watcher categories with distinct behaviors:

```
┌─────────────────────────────────────────────────────┐
│ Category 1: Frontend Resources (RELOAD — automatic) │
│                                                     │
│   Watch: assets.toml [files] and [dirs] entries     │
│   Extensions: .css, .html, .woff2                   │
│   On change: reload_frontend (unchanged behavior)   │
│   Also: send dev_notification with type "reloaded"  │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ Category 2: Backend (Compiled + Source) (RESTART)   │
│                                                     │
│   Watch: tugcode/target/debug/tugcast (binary)       │
│          tugcode/crates/**/*.rs (Rust source)        │
│          tugcode/**/Cargo.toml                       │
│   On change: set dirty flag, send dev_notification  │
│              with type "restart_available"           │
│   Does NOT trigger reload_frontend                  │
│   Does NOT trigger shutdown/restart                 │
│                                                     │
│   Note: The Rust source watcher (dev_rust_source_   │
│   watcher) fires immediately when .rs or Cargo.toml │
│   files change — no waiting for cargo build.        │
│   The compiled binary watcher (dev_compiled_watcher)│
│   fires when the build output mtime changes.        │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ Category 3: Mac App Code (RELAUNCH)                 │
│                                                     │
│   Watch: tugapp/Sources/**/*.swift                  │
│   On change: set dirty flag, send dev_notification  │
│              with type "relaunch_available"          │
│   Does NOT trigger any automatic action             │
└─────────────────────────────────────────────────────┘
```

### Notification Protocol

A new Control frame action `dev_notification` carries change information to the frontend:

```json
{"action": "dev_notification", "type": "reloaded"}
{"action": "dev_notification", "type": "restart_available", "changes": ["frontend", "backend"]}
{"action": "dev_notification", "type": "relaunch_available", "changes": ["app"]}
```

The `changes` array accumulates between operations. If both frontend and backend code have changed since the last restart, the notification carries both. After the user triggers a restart, the accumulator clears.

### Operation Triggers

Operations are triggered from the frontend via existing Control frame actions:

```json
{"action": "restart"}
{"action": "relaunch"}
{"action": "reset"}
```

`restart` sends exit code 42 (already exists). `relaunch` sends exit code 45 (new). `reset` sends exit code 43 (already exists) with the additional step of clearing state.

## Developer Mode Notifications Card

A new tugdeck card displays the dev mode state and provides operation buttons.

### Card Design

The card shows a compact list of indicators, one per change category:

```
┌─────────────────────────────────────────────────────┐
│ Developer                                     ▾  ×  │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ● Frontend         Clean                           │
│  ○ Backend          2 changes        [ Restart ]    │
│  ○ App              1 change         [ Relaunch ]   │
│                                                     │
│                                      [ Reset ]      │
└─────────────────────────────────────────────────────┘
```

Each row has:
- **Indicator dot** — green when clean, yellow when dirty
- **Label** — "Frontend" (CSS/HTML/TS/TSX in tugdeck/), "Backend" (RS/Cargo.toml in tugcode/), "App" (covers Mac app code)
- **Status text** — "Clean" or "N changes"
- **Action button** — appears only when dirty. "Restart" for Backend, "Relaunch" for App

The "Reset" button is always visible at the bottom, since it's a utility operation not tied to file changes.

Frontend row shows "Clean" normally and briefly flashes "Reloaded" when a Vite HMR update occurs, then returns to "Clean" after ~2 seconds.

When a Relaunch is in progress, the card shows build status:

```
┌─────────────────────────────────────────────────────┐
│ Developer                                     ▾  ×  │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ● Frontend         Clean                           │
│  ◐ Backend          Building...                     │
│  ◐ App              Building...                     │
│                                                     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Implementation

The card implements `TugCard`:
- **feedIds**: `[FeedId.CONTROL]` — receives `dev_notification` actions
- **mount()**: Creates the indicator rows, registers action handlers
- **onFrame()**: Parses `dev_notification` payloads, updates indicator states
- **destroy()**: Cleans up

The card sends operations via the existing WebSocket connection. When the user clicks "Restart", the card sends a Control frame with `{"action": "restart"}` back to tugcast.

### Card Registration

Register the card factory in `deck-manager.ts`:

```typescript
deckManager.registerCardFactory("developer", () => new DeveloperCard());
```

The card can be toggled from the Developer menu (Mac app) or a keyboard shortcut.

## The `tugrelaunch` Helper Binary

### Why a separate binary

Relaunch replaces the running Mac app itself. The Tug binary inside `Tug.app/Contents/MacOS/` must be rebuilt (via xcodebuild) and the app must quit and relaunch. A process cannot replace its own binary while running and then relaunch itself — something must outlive the app to perform the swap and relaunch.

This is a well-established pattern on macOS. Sparkle (the standard Mac update framework) uses a separate `Autoupdate` helper binary that outlives the host app, replaces the bundle, and relaunches. Squirrel.Mac (used by Electron/VS Code) uses a `ShipIt` helper for the same purpose. `tugrelaunch` follows the same pattern, adapted for dev builds instead of downloaded updates.

### Design

`tugrelaunch` is a new Rust binary crate in the tugcode workspace. It has one job: orchestrate the build-replace-relaunch cycle.

```
tugcode/crates/tugrelaunch/
├── Cargo.toml
└── src/
    └── main.rs
```

CLI interface:

```
tugrelaunch \
  --source-tree /path/to/tugtool \
  --app-bundle /path/to/Tug.app \
  --progress-socket /tmp/tugrelaunch-{pid}.sock
```

### Lifecycle

The sequence follows the Sparkle model: **build while the old app is still running** (so the user can see progress and the build can fail gracefully), then quit the old app, swap binaries, and relaunch.

```
┌───────────────────────────────────────────────────────────────────┐
│ Phase 1: BUILD (old app still running, user sees progress)       │
│                                                                  │
│   tugrelaunch creates UDS listener at --progress-socket          │
│   tugcast connects and relays progress to Developer card         │
│                                                                  │
│   1. cargo build -p tugcast -p tugtool -p tugcode                │
│      → progress: {"stage": "cargo", "status": "building"}       │
│      → progress: {"stage": "cargo", "status": "done"}           │
│                                                                  │
│   2. bun run build (in tugdeck/)                                 │
│      → progress: {"stage": "bun", "status": "building"}         │
│      → progress: {"stage": "bun", "status": "done"}             │
│                                                                  │
│   3. xcodebuild -project tugapp/Tug.xcodeproj -scheme Tug       │
│      → progress: {"stage": "xcode", "status": "building"}       │
│      → progress: {"stage": "xcode", "status": "done"}           │
│                                                                  │
│   On failure at any stage:                                       │
│      → progress: {"stage": "...", "status": "failed",            │
│                   "error": "..."}                                │
│      → tugrelaunch exits with non-zero code                     │
│      → Old app stays running, user sees error in Developer card  │
│      → No harm done                                              │
└───────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (all builds succeeded)
┌───────────────────────────────────────────────────────────────────┐
│ Phase 2: SIGNAL (tell the old app to quit)                       │
│                                                                  │
│   → progress: {"stage": "relaunch", "status": "quitting"}       │
│   tugrelaunch sends SIGTERM to the old Tug.app process           │
│   (pid derived from --app-bundle or passed explicitly)           │
└───────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────────┐
│ Phase 3: WAIT (for old app to exit)                              │
│                                                                  │
│   tugrelaunch uses kqueue with EVFILT_PROC / NOTE_EXIT to        │
│   efficiently wait for the old app's PID to exit.                │
│   No polling — kernel event, instant notification.               │
│   Timeout: 10 seconds. If the old app doesn't exit, SIGKILL.    │
└───────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────────┐
│ Phase 4: COPY (swap binaries into app bundle)                    │
│                                                                  │
│   Source: tugcode/target/debug/{tugcast,tugtool,tugcode}         │
│   Source: xcodebuild build products (Tug binary)                 │
│   Dest:   Tug.app/Contents/MacOS/                                │
│                                                                  │
│   Uses rename() for atomic replacement where possible.           │
│   On Unix, replacing a running binary's path is safe — the old   │
│   process keeps its file descriptors to the old inode.           │
│   Since the app has already exited (Phase 3), this is even       │
│   simpler — no running process to worry about.                   │
└───────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────────┐
│ Phase 5: RELAUNCH                                                │
│                                                                  │
│   tugrelaunch runs: open -a /path/to/Tug.app                    │
│   (or NSWorkspace.shared.openApplication if using Swift)         │
│                                                                  │
│   Writes a status file at a known location:                      │
│   /tmp/tugrelaunch-status.json                                   │
│   {"result": "success", "timestamp": "..."}                      │
│                                                                  │
│   tugrelaunch exits with code 0.                                 │
│   The new Tug.app reads the status file on startup to show       │
│   "Relaunched successfully" in the Developer card.               │
└───────────────────────────────────────────────────────────────────┘
```

### Progress Communication

`tugrelaunch` creates a Unix domain socket listener at the `--progress-socket` path. Tugcast connects after spawning `tugrelaunch` and relays progress messages to the frontend as `dev_notification` frames.

Progress messages are newline-delimited JSON:

```json
{"stage": "cargo", "status": "building"}
{"stage": "cargo", "status": "done"}
{"stage": "bun", "status": "building"}
{"stage": "bun", "status": "done"}
{"stage": "xcode", "status": "building"}
{"stage": "xcode", "status": "done"}
{"stage": "relaunch", "status": "quitting"}
{"stage": "cargo", "status": "failed", "error": "compilation error..."}
```

If tugcast disconnects before the build completes (e.g., it was killed), `tugrelaunch` continues building. The progress socket is nice-to-have, not a dependency. `tugrelaunch` works independently of whether anyone is listening.

### Failure Handling

If any build step fails:
- `tugrelaunch` writes the error to the progress socket (if connected)
- `tugrelaunch` exits with a non-zero code
- The old Tug.app stays running, untouched
- The Developer card shows the error and keeps the "Relaunch" button available

This is strictly better than the current auto-restart approach, where a failure mid-restart leaves the system in a partially broken state.

### Where `tugrelaunch` is NOT used

**Restart** does not use `tugrelaunch`. The builds have already happened (bun-watch and cargo-watch/manual). The supervisor (tugtool or ProcessManager) handles the restart directly:

- **CLI path (tugtool):** Kills tugcast → respawns. `tugtool` resolves the binary path on each spawn, so it picks up the new binary automatically. No copy needed.
- **Mac app path (ProcessManager):** Kills tugcast → copies the already-built binary from `<source_tree>/tugcode/target/debug/tugcast` into `Tug.app/Contents/MacOS/` → respawns. This reuses the existing `copyBinaryFromSourceTree()` method, but it's only called when the user explicitly clicks Restart, never automatically.

### CLI path: Relaunch not applicable

The CLI path (`just dev` / tugtool) has no app code and no app bundle. "Relaunch" is a Mac app concept. From the CLI, only "restart" is relevant. The Developer card can hide the "App" row and "Relaunch" button when running in the CLI (detected by the absence of the WebKit bridge).

## What to Remove

### Remove from tugcast/src/dev.rs

1. **`spawn_binary_watcher()`** — the entire function. Binary mtime polling → exit code 44 → shutdown is the auto-restart mechanism we're eliminating. **DONE** — replaced by `dev_compiled_watcher()` (mtime polling, notification only) and `dev_rust_source_watcher()` (notify events on .rs/Cargo.toml, notification only).
2. **`_binary_watcher` field on `DevRuntime`** — no longer needed. **DONE** — `DevRuntime` now holds `_compiled_watcher` (JoinHandle), `_app_watcher`, and `_rust_source_watcher`.
3. **The `.abort()` call in `disable_dev_mode()`** for the binary watcher handle. **DONE** — `disable_dev_mode()` aborts `_compiled_watcher` and drops the runtime.
4. **Exit code 44 mapping** in `tugcast/src/main.rs` — `44 => "binary_updated"` becomes dead code. **DONE** — exit code 44 is no longer emitted.

Replace with: a notification-only watcher that detects binary mtime changes and sends `dev_notification` with `"type": "restart_available"` over the control socket. No shutdown, no exit codes. **DONE**

### Remove from ProcessManager.swift

1. **`"binary_updated"` case** in the shutdown handler — this shutdown reason no longer exists. **DONE**

`copyBinaryFromSourceTree()` **stays** — it's repurposed for the user-triggered Restart flow. The method is unchanged; only its call site changes (called from the explicit `"restart"` handler instead of the automatic `"binary_updated"` handler).

### Remove from tugtool/src/main.rs

1. **`"binary_updated"` match arm** in the supervisor loop — this restart reason no longer exists. **DONE**

### Remove from the tugplan

The existing `tugplan-full-hot-reload.md` steps 2-4 (binary watcher, ProcessManager copy, tugtool supervisor handling) are superseded by this proposal. Step 0-1 (remove `--dev` flag, send `dev_mode` via control socket) remain valid and should be retained. **DONE** — `full-hot-reload.md` has been archived to `dash/archive/`.

## What to Add

### New crate: `tugcode/crates/tugrelaunch/`

A new binary crate for the relaunch helper. Depends on `serde_json` for progress protocol. No other special dependencies — uses std Unix APIs for kqueue and process management.

### In tugcast/src/dev.rs

1. **Change tracking state** — a struct holding dirty flags and change counts, organized semantically by what changed rather than by language:
   ```rust
   struct DevChangeTracker {
       frontend_dirty: bool,
       backend_dirty: bool,
       app_dirty: bool,
       frontend_change_count: u32,
       backend_change_count: u32,
       app_change_count: u32,
   }
   ```

2. **Notification-only watchers** — the existing file watcher splits into categories:
   - Category 1 (styles): same as today, sends `reload_frontend` AND `dev_notification` type `"reloaded"`
   - Category 2 (compiled): watches `dist/app.js` and the tugcast binary path, sends only `dev_notification` type `"restart_available"` — no reload, no shutdown
   - Category 3 (app): new watcher on `tugapp/Sources/**/*.swift`, sends `dev_notification` type `"relaunch_available"`

3. **Change accumulation** — dirty flags accumulate between user-triggered operations. When the user triggers "restart" (exit code 42), the restart handler clears the frontend and backend dirty flags. When the user triggers "relaunch", all flags clear.

### In tugcast/src/main.rs

1. **Exit code 45 mapping** — `45 => "relaunch"` alongside existing `42 => "restart"` and `43 => "reset"`.

### In tugcast/src/control.rs or actions

1. **Handle `restart`/`relaunch`/`reset` actions** received from the frontend — map to appropriate exit codes via `shutdown_tx`.
2. **Handle `relaunch` action specifically** — before sending exit code 45, spawn `tugrelaunch` as a child process, connect to its progress socket, and relay progress to the frontend. Then shut down.

### In ProcessManager.swift

1. **Handle `"relaunch"` shutdown reason** — ProcessManager sees tugcast exit with the relaunch reason. It does NOT restart tugcast. Instead, it knows `tugrelaunch` is handling the full cycle. ProcessManager prepares for app exit (saves state, cleans up).

### In tugdeck/src/cards/

1. **`developer-card.ts`** — new card implementing `TugCard` for the developer notifications UI.

### In tugdeck/src/action-dispatch.ts

1. **`restart` action handler** — sends restart request back to tugcast.
2. **`relaunch` action handler** — sends relaunch request back to tugcast.
3. **`reset` action handler** — extended to send reset request back to tugcast (currently only clears localStorage).

### In Justfile

1. **`build` recipe** — updated to also build `tugrelaunch`.
2. **`app` recipe** — updated to copy `tugrelaunch` into the app bundle alongside tugcast, tugtool, tugcode.

## Operation Flows

### Reload (automatic)

```
Developer edits tokens.css
  → File watcher detects change (Category 1)
  → Sends reload_frontend action (browser reloads)
  → Sends dev_notification { type: "reloaded" }
  → Developer card briefly shows "Reloaded" on Frontend row
  → After ~2s, returns to "Clean"
```

### Restart (on-demand)

Restart is fast because the builds have already happened. The Vite dev server handles frontend hot module replacement automatically. `cargo-watch` (or manual `cargo build`) produces new backend binaries. The Backend watcher tracks both source edits and build outputs.

```
Developer edits a .ts file
  → Vite dev server applies HMR automatically
  → td-hmr-update CustomEvent fires
  → Developer card Frontend row briefly shows "Reloaded"

Developer edits a .rs file
  → Rust source watcher (dev_rust_source_watcher) detects change immediately
  → Sets backend_dirty = true, increments count
  → Sends dev_notification { type: "restart_available", changes: ["backend"] }
  → Developer card shows Backend row: "1 change" with [Restart] button

Developer runs cargo build
  → Compiled binary watcher (dev_compiled_watcher) detects mtime change
  → Sends dev_notification { type: "restart_available", changes: ["backend"] }
  → Developer card shows Backend row: "2 changes" with [Restart] button

Developer clicks [Restart]
  → Frontend sends { action: "restart" } to tugcast
  → tugcast shuts down with exit code 42 ("restart")

  CLI path (tugtool supervisor):
    → tugtool sees "restart" shutdown reason
    → Respawns tugcast (resolves binary path, picks up new binary)
    → Sends dev_mode, waits for ack
    → Browser reconnects, page reloads with new code

  Mac app path (ProcessManager):
    → ProcessManager sees "restart" shutdown reason
    → Copies tugcast binary from source tree to app bundle
    → Respawns tugcast
    → Sends dev_mode, waits for ack
    → WebView reconnects, page reloads with new code

  → Dirty flags for frontend and backend clear on fresh startup
  → Developer card shows all rows "Clean"
```

### Relaunch (on-demand)

Relaunch includes a build step because the Category 3 watcher monitors app *source files*. The `tugrelaunch` helper handles the full build-replace-relaunch cycle.

```
Developer edits an app source file
  → File watcher detects change (Category 3)
  → Sets app_dirty = true
  → Sends dev_notification { type: "relaunch_available", changes: ["app"] }
  → Developer card shows App row: "1 change" with [Relaunch] button

Developer clicks [Relaunch]
  → Frontend sends { action: "relaunch" } to tugcast

  tugcast spawns tugrelaunch:
    tugrelaunch \
      --source-tree /path/to/tugtool \
      --app-bundle /path/to/Tug.app \
      --progress-socket /tmp/tugrelaunch-{pid}.sock

  tugcast connects to progress socket, relays to frontend:
    → Developer card shows "Building... (cargo)" then "(bun)" then "(xcode)"

  On build failure:
    → Developer card shows error
    → tugrelaunch exits, old app stays running
    → User can fix the error and try again

  On build success:
    → tugrelaunch sends SIGTERM to Tug.app
    → tugrelaunch waits for exit (kqueue EVFILT_PROC, 10s timeout)
    → tugrelaunch copies new binaries into Tug.app/Contents/MacOS/
    → tugrelaunch runs: open -a /path/to/Tug.app
    → tugrelaunch writes status file and exits

  New Tug.app launches:
    → ProcessManager starts tugcast
    → Dev mode enabled, watchers created
    → All dirty flags clean (fresh process)
    → Developer card reads status file, briefly shows "Relaunched"
```

### Reset (on-demand)

```
Developer clicks [Reset]
  → Frontend clears localStorage
  → Frontend sends { action: "reset" } to tugcast
  → tugcast clears server-side caches/state
  → tugcast shuts down with exit code 43 ("reset")
  → Supervisor relaunches from scratch
  → All dirty flags clear, fresh state
```

## Relationship to Existing Plans

### tugplan-full-hot-reload.md

Steps 0-1 (remove `--dev` flag, send `dev_mode` via control socket) are **retained** — they fix the CLI dev path and establish the correct control socket protocol.

Steps 2-4 (binary watcher → exit code 44 → auto-restart → binary copy) are **superseded** by this proposal. The binary watcher still exists but becomes notification-only. The auto-restart mechanism and exit code 44 are removed.

Step 5 (Justfile recipes) is **retained** with modifications. `just dev` and `just dev-watch` still make sense — `dev-watch` runs `cargo watch` so the developer doesn't need to manually `cargo build`, but the restart is still user-triggered.

### runtime-dev-mode.md and dev-mode-source-direct-serving.md

These are **unaffected**. The control socket `dev_mode` protocol, `SharedDevState`, asset manifest, and source-direct serving all remain as designed. This proposal only changes what happens *after* a file change is detected.

## Implementation Order

1. **Remove auto-restart mechanisms** — delete `spawn_binary_watcher`, exit code 44 mapping, and `"binary_updated"` handling from tugtool and ProcessManager. This simplifies the codebase immediately.

2. **Add change tracking and notification protocol** — implement `DevChangeTracker`, categorize watchers, send `dev_notification` actions instead of auto-reloading for compiled code.

3. **Add Developer card** — implement the notification UI in tugdeck with indicator rows and operation buttons.

4. **Add frontend-to-backend operation triggers** — wire the Restart/Relaunch/Reset buttons to send actions back through the control socket. Update ProcessManager's restart handler to copy the binary before respawning.

5. **Add app file watcher** — extend the file watcher to monitor `tugapp/Sources/` for app code changes (Category 3).

6. **Build `tugrelaunch`** — new crate with build orchestration, kqueue-based process wait, binary copy, and app relaunch. Wire it into the `relaunch` action flow.

## Non-goals

- **HMR (Hot Module Replacement)** — all reloads remain full page reloads via `location.reload()`. No CSS injection, no partial JS replacement, no state preservation.
- **Automatic restart/relaunch** — the entire point is to make these user-triggered. No hidden auto-restart behavior.
- **Build integration in tugcast** — tugcast does not run `cargo build`, `bun build`, or `xcodebuild`. It only watches for results (Category 1 and 2) or spawns `tugrelaunch` which handles builds (Category 3). Build orchestration for restart stays in the Justfile, cargo-watch, or the developer's workflow.
- **Cross-platform** — Mac-only for the relaunch path (app code requires Xcode). The restart path works anywhere.
- **Code signing** — Tug.app is unsigned during development. No codesign step in `tugrelaunch`. (If signing becomes necessary, it's a one-line addition to Phase 4.)

## Summary of Changes

| Component | Remove | Add |
|-----------|--------|-----|
| `tugcode/crates/tugrelaunch/` | (new crate) | Build-replace-relaunch helper binary |
| `tugcast/src/dev.rs` | `spawn_binary_watcher()`, binary watcher handle | `DevChangeTracker`, categorized watchers, `dev_notification` sending |
| `tugcast/src/main.rs` | `44 => "binary_updated"` | `45 => "relaunch"` |
| `tugcast/src/control.rs` | (none) | Handle `restart`/`relaunch`/`reset` actions; spawn `tugrelaunch` on relaunch |
| `ProcessManager.swift` | `"binary_updated"` case | `"relaunch"` case (prepare for app exit); `"restart"` case calls `copyBinaryFromSourceTree()` |
| `tugtool/src/main.rs` | `"binary_updated"` match arm | (none — relaunch is Mac-app-only) |
| `tugdeck/src/cards/` | (none) | `developer-card.ts` — new Developer card |
| `tugdeck/src/action-dispatch.ts` | (none) | `restart`, `relaunch`, `reset` action handlers |
| `Justfile` | (none) | Build and copy `tugrelaunch` in `build` and `app` recipes |
