# Dev Mode After the React Migration

## Problem

The React + shadcn/ui migration (PR #60) changed tugdeck's build model in a
way that breaks the assumptions underlying dev mode's three-watcher
architecture. The watchers still work individually, but the relationship
between source files, build outputs, and what gets served to the browser has
shifted. Two issues surfaced immediately, and a third — the fundamental one —
needs a design-level fix.

### Issue 1: Card content has no foreground color

The old `cards.css` (deleted in the migration) set `color` on card content
areas. The surviving `.card-frame-content` in `cards-chrome.css` has
`background` but no `color`, so text renders as the browser default (black)
against dark theme backgrounds.

**Fix:** Add `color: var(--td-text)` alongside `background: var(--td-surface-content)`
on `.card-frame-content`. One line, already applied.

### Issue 2: Source CSS hot reload is broken

Before the migration, CSS source files lived at known URL paths and were served
directly by tugcast in dev mode (via the `assets.toml` manifest). The styles
watcher detected source CSS changes and sent `reload_frontend`. The browser
reloaded and fetched the updated CSS directly from disk. Instant.

After the migration, all CSS is imported via JavaScript in `main.tsx`:

```typescript
import "./globals.css";
import "../styles/cards-chrome.css";
import "../styles/dock.css";
```

Vite processes these imports, runs Tailwind, and bundles everything into
content-hashed files in `dist/`. The `assets.toml` manifest was removed
(Decision D02 in the migration plan). Dev mode serves exclusively from `dist/`.

This means: editing `styles/tokens.css` does nothing visible. The styles
watcher watches `dist/` and `src/`, but source CSS changes in `styles/` don't
update `dist/` until Vite rebuilds. And nothing triggers a Vite rebuild.

### Issue 3: Stale build commands in tugtool and ProcessManager

Two existing code paths still use pre-React build commands:

**tugtool (CLI path)** — `spawn_bun_dev()` in `tugcode/crates/tugtool/src/main.rs`
launches `bun run dev`, which starts Vite's dev server on port 5173. This is
wrong: tugcast serves from `dist/`, not from Vite's dev server. The Vite dev
server is for standalone frontend work only.

**ProcessManager (Mac app path)** — launches `bun build src/main.ts --outfile=dist/app.js --watch`.
This is doubly wrong: the entry point is now `main.tsx` (not `.ts`), and the
old Bun bundler command doesn't run Tailwind, the React plugin, or any Vite
processing. It produces broken output.

Both must be updated to use `vite build --watch`.

### Issue 4: Who rebuilds?

The pre-React architecture had a clean separation:

```
Source CSS file → served directly (no build step) → browser reload
Source JS/TS   → bun build --watch (external) → dist/ → compiled watcher → notification
Rust source    → cargo build (external) → binary → compiled watcher → notification
Swift source   → xcode (external) → app watcher → notification
```

Source CSS was the one asset type that needed no build step. The migration
eliminated that special case. Now source CSS requires a Vite build, just like
TypeScript.

The dev mode notifications architecture (from `dev-mode-notifications.md`)
established a clear principle: **tugcast watches for results, it doesn't run
builds.** The three watcher categories are:

| Watcher | Watches | On change |
|---------|---------|-----------|
| **Styles** | CSS/HTML in dist/ and src/ | Automatic `reload_frontend` |
| **Code** | dist/index.html + tugcast binary (build outputs) | Notification only: `restart_available` |
| **App** | tugapp/Sources/*.swift (source files) | Notification only: `relaunch_available` |

The styles watcher is the only one that triggers automatic reload. The code
and app watchers only notify — the user decides when to restart or relaunch.

Post-React, the styles watcher's automatic reload still works for changes that
appear in `dist/` (because Vite's output lands there). But source CSS changes
never reach `dist/` without a Vite rebuild. The rebuild is a build step — and
tugcast doesn't run build steps.

## What Changed and What Didn't

### Architecture that survived the migration intact

1. **The three-watcher model.** Styles, code, and app watchers remain correct
   in their roles. The styles watcher still auto-reloads from dist/. The code
   watcher still polls dist/index.html and the tugcast binary. The app watcher
   still watches Swift sources. None of this needs to change.

2. **The notification protocol.** `dev_notification` with types `reloaded`,
   `restart_available`, and `relaunch_available` — all still correct.

3. **The Developer card.** Receives notifications, shows state, provides
   Restart/Relaunch buttons — unchanged.

4. **The debounce logic.** Quiet-period debounce in the styles watcher —
   unchanged and correct.

5. **The principle that tugcast doesn't run builds.** This must remain. The
   failed attempt to spawn `vite build --watch` from inside tugcast proved
   why: Vite's initial build empties dist/ (emptyOutDir), creating a window
   where the server can't find index.html. Even with workarounds, tugcast
   spawning build processes introduces lifecycle complexity, race conditions,
   and failure modes that don't belong in a file server.

6. **dist/index.html as the code-change sentinel.** The code watcher polls
   dist/index.html mtime to detect frontend rebuilds. This remains a strong
   sentinel post-React: Vite rewrites index.html on every build because it
   injects `<script>` and `<link>` tags with content-hashed filenames
   (e.g., `assets/index-abc123.js`, `assets/index-def456.css`). Any source
   change — CSS, TS, TSX — that affects the bundle produces a new index.html
   with new hash references. A rebuild that doesn't change index.html means
   nothing user-visible changed.

### What the migration broke

1. **Source CSS is no longer a zero-build-step asset.** It now requires Vite
   processing (Tailwind, CSS imports, bundling). This means source CSS changes
   are invisible to the running app without a rebuild.

2. **The styles watcher watches the wrong directories for source changes.**
   It watches `dist/` and `tugdeck/src/`, but source CSS lives in
   `tugdeck/styles/`. Even adding `styles/` to the watch list wouldn't help —
   the watcher can trigger a reload, but the reload would serve stale content
   from the last Vite build.

3. **The parent-process build commands are stale.** Both tugtool and
   ProcessManager launch the wrong build tool with the wrong arguments.

## Design

The primary development path is `just app`. That workflow must work properly,
efficiently, and smoothly. The CLI path (`just dev`) is secondary but should
also work.

### The rebuild belongs to the parent process

Tugcast's parent process — `tugtool` on the CLI path, `ProcessManager` in the
Mac app — is already responsible for process lifecycle. It spawns tugcast, it
restarts tugcast, it manages dev mode. It should also manage the Vite watcher.

This follows the same pattern as `cargo watch` in the `dev-watch` recipe:
the parent spawns a build watcher as a sibling process, and tugcast only
watches for the build outputs.

### Vite build --watch as a managed sibling process

`vite build --watch` is the correct build command. It:

- Watches source files (src/, styles/, index.html) using Rollup's watcher
- Does fast incremental rebuilds (not cold builds)
- Writes updated content-hashed output to dist/
- Does NOT empty dist/ on incremental rebuilds (only on the initial build;
  Rollup's watch mode preserves the output directory between rebuilds)
- Runs as a long-lived process, same as `cargo watch`

When Vite rebuilds dist/, tugcast's existing styles watcher detects the
CSS/HTML changes and sends `reload_frontend`. The browser reloads and gets
the freshly-built content. This is the same flow that already works for
dist/ changes — it just needs Vite running to produce those changes.

The correct invocation from the source tree:

```
tugdeck/node_modules/.bin/vite build --watch
```

Run from the `tugdeck/` directory. This uses the project-local Vite binary
(not a global install) and doesn't depend on `bun run` argument forwarding.

### Changes to ProcessManager.swift (primary path)

ProcessManager owns the Vite watcher. `just app` runs `open "$APP_DIR"` and
exits — any watcher it spawns would be orphaned. ProcessManager is the right
owner because it already manages tugcast's lifecycle and survives app restarts.

When dev mode is enabled, ProcessManager spawns `vite build --watch` as a
managed child process alongside tugcast:

- **Start:** When dev mode activates (after tugcast starts), spawn
  `vite build --watch` in the tugdeck directory using the Vite binary at
  `{source_tree}/tugdeck/node_modules/.bin/vite`. Store the Process reference.
- **Stop:** When dev mode deactivates or the app quits, terminate the
  Vite process.
- **Crash recovery:** If the Vite process exits unexpectedly, log a warning.
  Dev mode still works (tugcast serves from the last-built dist/), but
  source changes won't hot-reload until Vite is restarted.

**Replace the stale `bun build src/main.ts` command.** The current
ProcessManager code at line ~372 launches
`bun build src/main.ts --outfile=dist/app.js --watch`. This must change to
spawn the Vite binary with `["build", "--watch"]` arguments. The Vite binary
path is `{source_tree}/tugdeck/node_modules/.bin/vite` and the working
directory is `{source_tree}/tugdeck/`.

### Changes to tugtool (CLI path)

**Replace `spawn_bun_dev()`.** The function at line ~88 in
`tugcode/crates/tugtool/src/main.rs` spawns `bun run dev` (Vite dev server).
This must change to spawn `vite build --watch` using the same Vite binary
path as ProcessManager. The working directory is `{source_tree}/tugdeck/`.

The function should be renamed to `spawn_vite_watch()` to match its purpose.

### Changes to the Justfile

#### `just dev` — the common case

`just dev` becomes "Vite watch + tugtool". This is the single blessed CLI
path for frontend development:

```just
dev: build
    #!/usr/bin/env bash
    set -euo pipefail
    (cd tugdeck && node_modules/.bin/vite build --watch) &
    VITE_PID=$!
    trap "kill $VITE_PID 2>/dev/null" EXIT
    tugcode/target/debug/tugtool
```

Note: tugtool's internal `spawn_vite_watch()` also launches a Vite watcher.
The Justfile version is redundant but harmless — two Vite watchers watching
the same files will debounce into the same rebuilds. If tugtool's internal
watcher is reliable, the Justfile version can be removed later.

#### `just dev-watch` — adds cargo-watch

```just
dev-watch: build
    #!/usr/bin/env bash
    set -euo pipefail
    (cd tugdeck && node_modules/.bin/vite build --watch) &
    VITE_PID=$!
    if command -v cargo-watch &>/dev/null; then
        (cd tugcode && cargo watch -w crates -s "cargo build -p tugcast") &
        CARGO_PID=$!
    else
        echo "cargo-watch not found; Rust changes require manual cargo build"
    fi
    trap "kill $VITE_PID ${CARGO_PID:-} 2>/dev/null" EXIT
    tugcode/target/debug/tugtool
```

#### `just app` — no Justfile-level watcher

`just app` does a one-shot `bun run build`, launches the Mac app, and exits.
ProcessManager owns the Vite watcher from that point forward. No Justfile
changes needed beyond what's already there.

### No changes to tugcast

Tugcast's dev.rs stays exactly as it is. The three watchers, the debounce
logic, the notification protocol — all unchanged.

The styles watcher continues to watch `dist/` and `tugdeck/src/`. When Vite
rebuilds dist/, the watcher sees the changes and reloads. This is the existing
working path — no modifications needed.

### No changes to vite.config.ts

The Vite config stays as-is with `emptyOutDir: true`. This only affects the
initial build. Rollup's watch mode does not re-empty the directory on
incremental rebuilds.

Note: When the Vite watcher starts fresh, the initial build empties and
repopulates dist/. This is fine for the `just app` path: `bun run build`
already ran before the app launches, so dist/ is populated before tugcast
starts. ProcessManager starts the Vite watcher *after* tugcast is running,
so the initial rebuild overwrites dist/ with identical content. Tugcast's
styles watcher sees the writes, triggers a reload — which is a harmless
no-op (the content is the same as what was just served).

### Developer card: wait for confirmation before clearing stale state

The Developer card currently clears stale state optimistically when the user
clicks Restart or Relaunch — before the operation completes. If the restart
fails, the card reports "clean" when the running code is still stale.

**Fix:** Don't clear on button click. The restart/relaunch cycle produces a
fresh `dev_notification` with type `reloaded` when the new tugcast instance
starts and dev mode re-enables. The card should clear stale state when it
receives that incoming confirmation event, not on the outgoing button click.
If the restart fails, the notification never arrives, and the card stays
stale — which is correct.

### Card background fix (already applied)

`.card-frame-content` in `cards-chrome.css` now has:

```css
background: var(--td-surface-content);
color: var(--td-text);
```

This is the container where all card content (React or vanilla TS) renders.
The `--td-surface-content` and `--td-text` tokens are defined in all three
themes.

## Developer experience: `just app` path

This is the primary workflow.

```
$ just app
```

Behind the scenes:
1. `cargo build` compiles Rust binaries
2. `bun run build` does one-shot Vite build → dist/ populated
3. `xcodebuild` builds the Mac app
4. Binaries copied into Tug.app bundle
5. `open Tug.app` launches the app

The app starts:
1. ProcessManager spawns tugcast with `--dev`
2. ProcessManager spawns `vite build --watch` in tugdeck/
3. Tugcast enables dev mode, starts three watchers
4. WKWebView loads the UI

Developer edits `styles/tokens.css`:
- Vite watcher detects the change, does incremental rebuild (~200-500ms)
- dist/ files updated with new CSS
- Tugcast's styles watcher detects dist/ change
- `reload_frontend` sent → browser reloads with new styles
- Developer card briefly shows "Reloaded", returns to "Clean"

Developer edits `src/components/cards/about-card.tsx`:
- Vite watcher detects the change, does incremental rebuild
- dist/ files updated (new JS + CSS bundles, new index.html with new hashes)
- Tugcast's code watcher detects dist/index.html mtime change
- `dev_notification` type `restart_available` sent
- Developer card shows "1 change — [Restart]"
- Developer clicks Restart when ready

Developer edits a `.rs` file, runs `cargo build`:
- Tugcast binary updated
- Tugcast's code watcher detects binary mtime change
- `dev_notification` type `restart_available` sent
- Developer card shows change count, [Restart] button

Developer edits a `.swift` file:
- Tugcast's app watcher detects change
- `dev_notification` type `relaunch_available` sent
- Developer card shows change count, [Relaunch] button

## Summary of changes

| Component | Change | Priority |
|-----------|--------|----------|
| `tugdeck/styles/cards-chrome.css` | Add `color: var(--td-text)` and `background: var(--td-surface-content)` to `.card-frame-content` | Done |
| `tugcode/crates/tugcast/src/dev.rs` | Revert vite-spawn attempt; restore to pre-migration state | Done |
| `tugdeck/vite.config.ts` | Revert TUG_WATCH env var; restore to pre-migration state | Done |
| `tugapp/Sources/ProcessManager.swift` | Replace `bun build src/main.ts` with `vite build --watch`; manage as child process | High — blocks `just app` hot reload |
| `tugcode/crates/tugtool/src/main.rs` | Replace `spawn_bun_dev()` with `spawn_vite_watch()` using Vite binary | High — blocks `just dev` hot reload |
| `Justfile` | Update `dev` and `dev-watch` recipes to spawn Vite watcher | Medium |
| `tugdeck/src/components/cards/developer-card.tsx` | Clear stale state on incoming confirmation, not on button click | Low |

## What this does NOT change

- The three-watcher architecture in tugcast (styles, code, app)
- The notification protocol (reloaded, restart_available, relaunch_available)
- The Developer card UI (except stale-clearing timing)
- The principle that tugcast doesn't run builds
- The Vite config or build output structure
- The production (embedded) serving path
- The dist/index.html sentinel for code-change detection
