# Dev Mode Strategy Audit

## Current State: Four Operations

| Operation | Label in UI | What triggers it | Action | Status |
|-----------|-------------|------------------|--------|--------|
| **Reload** | "Styles" row | CSS/HTML/JS/TS change via Vite HMR | Automatic | Partially working — HMR works but has severe flash/flicker |
| **Restart** | "Code" row | Rust binary mtime change | User clicks [Restart] | Broken — binary watcher fires but notification never triggers UI button |
| **Relaunch** | "App" row | .swift source file change | User clicks [Relaunch] | Working (watcher + notification + button all connected) |
| **Reset** | Reset button | N/A | User clicks [Reset] | Working |

## Issues Found

### Issue 1: "Styles" row should be "Frontend"

**What changed:** The React + Vite migration (PR #60 → #62) replaced the old architecture where CSS was served directly from source. Now ALL frontend assets (CSS, HTML, JS, TS, TSX) are served through Vite's dev server. Vite provides true HMR — editing any frontend file (not just CSS) triggers an in-place module update.

**What's wrong:** The developer card still labels this row "Styles" and `categorizeFile()` still classifies TS/TSX files as "code" (backend). With Vite HMR, frontend TypeScript changes hot-reload automatically — they should NOT be in the "Code/Backend" row alongside Rust changes. They don't need a restart.

**Fix:**
- Rename "Styles" → "Frontend" in the developer card
- Update `categorizeFile()` to map `tugdeck/**/*.ts` and `tugdeck/**/*.tsx` to "frontend" (was "code")
- Rename internal category from "styles" to "frontend" throughout
- The "Reloaded" flash behavior stays — it fires on Vite HMR `vite:afterUpdate`

### Issue 2: Severe flash/flicker during HMR and startup

**Symptoms:** The app flashes terribly when Vite HMR updates fire, and also on initial app launch.

**Root cause analysis:**

1. **Startup flash:** The WKWebView initially shows a blank/white page while Vite's dev server responds and JS initializes. The CSS is loaded via JS imports (`import "./globals.css"`) so there's a brief FOUC (flash of unstyled content) between HTML parse and CSS application.

2. **HMR flash:** When Vite sends an HMR update for CSS, the old stylesheet is briefly removed before the new one is injected. This causes a visible flash where the page momentarily loses its styles. For a full-module HMR (JS/TS change), Vite may trigger a full page reload which goes through the white-flash-then-render cycle again.

3. **WKWebView aggravates the problem:** WKWebView doesn't have the same rendering pipeline optimizations as Chrome DevTools. Style recalculation during HMR is more visually jarring.

**Possible fixes to investigate:**
- Add a transition-suppressing overlay during HMR updates (show a div over the page, apply update, remove div)
- Set `WKWebView.isOpaque = false` with a matching `window.backgroundColor` so the flash is dark instead of white
- Inject initial CSS as a `<style>` block in index.html (not via JS import) so it's available before React mounts
- Debounce rapid HMR events (Vite can fire multiple updates in quick succession)
- For startup: don't show the WKWebView until the first paint is complete (`webView.isHidden = true` until `didFinishNavigation`)

### Issue 3: Restart button never appears for Rust changes

**Symptoms:** User touches a .rs file, the git feed shows the edit (yellow "Edited" state), but no Restart button appears.

**Root cause:** The compiled watcher (`dev_compiled_watcher` in `dev.rs`) polls the **binary** at `tugcode/target/debug/tugcast`, not source files. Touching a `.rs` file changes git status (which the git feed reports), but does NOT change the binary mtime. The binary only changes after `cargo build`.

This is a design gap. The app watcher (`dev_app_watcher`) watches Swift **source** files and immediately shows the Relaunch button. But the code watcher watches the **binary** (build output) and requires a manual `cargo build` before the Restart button appears.

**Two sub-issues:**

**(a) Design gap: No source-level watcher for Rust files.** There should be a Rust source watcher analogous to the Swift app watcher. When the developer touches a `.rs` file, the Restart button should appear immediately (just like touching a `.swift` file shows the Relaunch button). The developer then runs `cargo build` themselves and clicks Restart. The current flow (touch source → no UI feedback → must remember to build → build changes binary → only then UI shows button) is broken UX.

**(b) Potential delivery bug:** Even with the current binary-watching design, the end-to-end flow (binary changes → notification → UI button) may have issues. The compiled watcher sends a `dev_notification` Control frame via `client_action_tx`. The router relays it over WebSocket. The client's action-dispatch handler dispatches a `td-dev-notification` CustomEvent. The DeveloperCard listens for this. Each link in this chain should be verified with logging to confirm the notification arrives.

**Fix:**
- Add a Rust source watcher (like the Swift app watcher) that watches `tugcode/crates/**/*.rs` and sends `restart_available` notifications on source changes
- The compiled binary watcher can stay as a secondary trigger (catches `cargo build` by external tools)
- Rename "Code" → "Backend" to make it clear this row covers Rust changes, not frontend code

### Issue 4: Row renaming summary

| Current | Proposed | What it covers | Watcher |
|---------|----------|----------------|---------|
| Styles | **Frontend** | CSS, HTML, JS, TS, TSX from tugdeck/ | Vite HMR (automatic) |
| Code | **Backend** | Rust source and binary from tugcode/ | Source watcher (new) + binary mtime poller |
| App | **App** (unchanged) | Swift source from tugapp/ | Source watcher (existing) |

## Roadmap File Audit

### Files that are OBSOLETE and should be ARCHIVED or DELETED

**`full-hot-reload.md`** — Fully superseded. This was the original "edit any source file, see the change live" plan. Its Phase 1 (remove `--dev` flag) was done in `runtime-dev-mode.md`. Its Phase 2 (binary mtime watcher) was done differently in `dev-mode-notifications.md`. Its Phase 3 (unified `just dev`) was partially addressed. The document still references `bun build --watch`, the `--dev` CLI flag, and other pre-React concepts. Mark as superseded.

**`dev-mode-source-direct-serving.md`** — Fully superseded. This proposed serving CSS directly from source via `assets.toml`, bypassing `dist/`. The React migration (PR #60) eliminated this approach entirely — all assets now go through Vite. The `assets.toml` manifest was removed. The document references architecture that no longer exists. Mark as superseded.

**`dev-app-mode-roadmap.md`** — Partially superseded. This was the original "initial concept" document that proposed `tugcast --dev`, live reload via SSE, the Mac app, and distribution. Sections 1-4 are done (dev serve, live reload, dock controls, Mac app). Section 5 (distribution/DMG/notarization) is future. Most of the implementation details are now outdated (references `bun dev`, SSE reload, pre-React card system). The remaining value (distribution plan) should be extracted into a new focused document if/when we work on it. Mark as superseded.

**`runtime-dev-mode.md`** — Fully implemented. Runtime dev mode via control socket, `SharedDevState`, `ArcSwap`, watcher lifecycle — all done. The document's scope is 100% shipped. Mark as done.

**`dev-mode-port-hardening.md`** — Fully implemented (PR #63). `vite_port` in control message, constants in Rust and Swift, parameterized functions. Mark as done.

**`dev-notification-improvements.md`** — Partially implemented. Fix 1 (routing bug, `tabItems → tabs`) is done. Fix 2 (rename Category 1/2/3) is done in code but comments may still have remnants. Fix 3 (timestamps) is done. Fix 4 (card labels with times) is done. Mark as done.

**`external-commands-and-dev-mode-redesign.md`** — Partially implemented. Part 1 (external commands via tell pipeline) is done. Part 2 (deferred restart for dev mode toggle) is done. Part 3 (source tree picker) is done. The document can be marked as done. The remaining "Follow-Up" items are minor cleanup.

### Files that are CURRENT and should be UPDATED

**`dev-mode-notifications.md`** — This is the main architectural document. Its core design (three watcher categories, notification-only for compiled code, user-triggered operations, Developer card) is implemented. But it needs updates:
- The "Styles/Code/App" naming should be updated to "Frontend/Backend/App"
- The compiled watcher section should note the addition of a Rust source watcher
- The `bun build --watch` references should be updated to reflect Vite
- The "What to Remove" section references `spawn_binary_watcher` and exit code 44 — these were already removed
- The card design mockup should update labels

**`dev-mode-post-react.md`** — This was the most recent plan (PR #62). Some items are done:
- ProcessManager Vite dev server spawning: Done
- Card text color fix: Done
- vite.config.ts revert: Done
- dev.rs revert: Done

Outstanding items from this doc:
- tugtool `spawn_bun_dev()` → `spawn_vite_watch()`: Status unclear (may still reference old bun commands)
- Developer card stale-clearing (pending-flag confirmation): Done
- Justfile updates: Status unclear

### Files that should be CREATED

**`dev-mode-flash-fix.md`** (new) — A focused document on diagnosing and fixing the flash/flicker problem. This is the most user-visible issue and needs its own investigation + plan.

**`dev-mode-rust-source-watcher.md`** (new) — A focused document on adding a Rust source file watcher (analogous to the Swift app watcher) so that editing `.rs` files immediately shows the Restart button.

## Proposed Roadmap Changes

### Step 1: Archive completed/superseded documents

Move to a `dash/archive/` directory (or add a "STATUS: DONE/SUPERSEDED" header):
- `full-hot-reload.md` → superseded by `dev-mode-notifications.md`
- `dev-mode-source-direct-serving.md` → superseded by React/Vite migration
- `dev-app-mode-roadmap.md` → superseded (distribution plan can be extracted later)
- `runtime-dev-mode.md` → fully implemented
- `dev-mode-port-hardening.md` → fully implemented (PR #63)
- `dev-notification-improvements.md` → fully implemented
- `external-commands-and-dev-mode-redesign.md` → fully implemented

### Step 2: Update the main architecture document

Update `dev-mode-notifications.md` to reflect post-React reality:
- Rename watcher categories: Styles→Frontend, Code→Backend, App stays
- Note that "Frontend" is now Vite HMR (not CSS-only reload)
- Note that "Backend" needs a Rust source watcher (not just binary polling)
- Replace `bun build --watch` references with Vite
- Mark completed sections as "DONE"

### Step 3: Create new focused documents

1. **Flash/flicker investigation** — Diagnose root cause, propose fix
2. **Rust source watcher** — Add source-level watching for .rs files

### Step 4: Consolidate `dev-mode-post-react.md`

Verify which items are actually done vs. still pending. Mark completed items. Extract any remaining work into the focused documents above.
