# Dev Mode Completeness Audit

**Date:** 2026-02-28

This report audits the current state of developer mode, identifies issues and gaps, and proposes fixes.

---

## Current Architecture

Developer mode provides four actions:

| Action | Trigger | What It Does |
|--------|---------|--------------|
| **Reload** (Frontend) | Automatic via Vite HMR | Hot-reloads CSS/JS/TS/TSX in place |
| **Restart** (Backend) | Manual button when Rust code changes | Restarts tugcast process (exit code 42) |
| **Relaunch** (App) | Manual button when Swift code changes | Full app relaunch via tugrelaunch (exit code 45) |
| **Reset** | Manual button always visible | Clears localStorage + restarts tugcast (exit code 43) |

---

## Issues Found

### Issue 1: Flash fix uses hardcoded background color — MUST FIX

**Severity:** High (fit and finish — any mismatch is too long)
**Location:** `tugapp/Sources/MainWindow.swift:61`

The window background is hardcoded to `NSColor(red: 0.09, green: 0.09, blue: 0.09, alpha: 1.0)` (~`#171717`). This doesn't match any theme:

| Source | Color |
|--------|-------|
| Swift hardcode | `#171717` (approx) |
| Brio `--tl-bg` | `#1c1e22` |
| Bluenote `--tl-bg` | `#2a3136` |
| Harmony `--tl-bg` (light) | `#b0ab9f` |

The CSS side is correct — `body` uses `background-color: var(--td-canvas)` which respects the theme. But during startup the window background is the hardcoded color, and any mismatch is visible.

**Proposal:** Make the window background respect the current theme's `--tl-bg` value. Two-phase approach:

1. **Startup:** Use the persisted theme preference (UserDefaults) to set the initial window background color. Map each theme name to its `--tl-bg` value in Swift:
   - `"brio"` → `NSColor(sRGBRed: 0.11, green: 0.118, blue: 0.133, alpha: 1.0)` (`#1c1e22`)
   - `"bluenote"` → `NSColor(sRGBRed: 0.165, green: 0.192, blue: 0.212, alpha: 1.0)` (`#2a3136`)
   - `"harmony"` → `NSColor(sRGBRed: 0.69, green: 0.67, blue: 0.624, alpha: 1.0)` (`#b0ab9f`)

2. **Theme change:** When the user changes themes (via the Settings card), the frontend posts the new `--tl-bg` value to Swift via the bridge, and Swift updates the window background color. This way subsequent navigations / HMR reloads also match.

This eliminates the flash completely — the window background always matches the active theme.

### Issue 2: Workspace-root Cargo files not watched — MUST FIX

**Severity:** Medium
**Current state:** The Rust source watcher covers `tugcode/crates/` recursively. All 67 `.rs` files are under this path, so all Rust source is watched.

**Gap:** The workspace-root `tugcode/Cargo.toml` and `tugcode/Cargo.lock` are NOT watched — they're outside `tugcode/crates/`. `categorizeFile()` in the git feed does categorize `tugcode/Cargo.toml` as "backend", but the filesystem watcher won't trigger a restart notification for it.

**Proposal:** Widen the watch path from `tugcode/crates/` to `tugcode/`, and update the `has_rust_extension()` filter to also match `Cargo.lock`. Add an exclusion for paths containing `/target/` so the watcher doesn't fire on build artifacts.

### Issue 3: Reset restarts instead of relaunching — MUST FIX

**Severity:** High
**Location:** `tugcode/crates/tugcast/src/actions.rs:21-26`

Reset sends exit code 43, which the Swift ProcessManager handles identically to restart (exit code 42) — it restarts tugcast but does NOT relaunch the full app. The frontend does `localStorage.clear()` before sending the command, but the WKWebView process stays alive.

**Current behavior:** `localStorage.clear()` + backend restart (keeps WKWebView alive)
**Expected behavior:** `localStorage.clear()` + full app relaunch (fresh WKWebView, fresh backend)

**Proposal:** Change reset to use the relaunch path so the entire app restarts from scratch. Specifically:
1. In `actions.rs`, change reset's exit code from 43 to 45 (same as relaunch), or have ProcessManager treat exit code 43 as a relaunch trigger
2. In `ProcessManager.swift`, handle `"reset"` the same as `"relaunch"` — stop Vite, let tugrelaunch handle the full restart
3. Update the card label from "Clear localStorage and restart" to "Clear localStorage and relaunch"

### Issue 4: Dev mode toggle clipped by overflow:hidden — MUST FIX

**Severity:** High
**Location:** `tugdeck/styles/cards-chrome.css:267-277`

The dev mode toggle Switch IS implemented in `settings-card.tsx:241-266` and has full test coverage. **But it's not visible** because the Settings card content overflows its container.

**Root cause:** The `.card-frame-content` CSS class has `overflow: hidden` with no scroll mechanism:

```css
.card-frame-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;        /* clips the Developer Mode section */
  position: relative;
  min-height: 0;
  ...
}
```

The Settings card renders three sections (Theme, Source Tree, Developer Mode) in a flex column. When the card frame height is too small to fit all three, the Developer Mode section is clipped with no way to scroll to it.

**Proposal:** Change `.card-frame-content` to `overflow-y: auto` so content scrolls when it exceeds the visible area. This is a one-line CSS fix that makes the Developer Mode toggle accessible.

### Issue 5: Developer menu out of sync with Developer card — MUST FIX

**Severity:** Medium
**Location:** `tugapp/Sources/AppDelegate.swift:214-234`

**Current state:**

| Action | Developer Menu | Developer Card |
|--------|---------------|----------------|
| Reload Frontend | Cmd+R | (automatic via HMR) |
| Restart Server | Cmd+Shift+R | "Restart" button (conditional) |
| Relaunch App | **MISSING** | "Relaunch" button (conditional) |
| Reset Everything | Cmd+Option+R | "Reset" button (always) |

**Gap 1:** The menu has no "Relaunch App" item.

**Gap 2:** Menu items don't reflect the dirty/stale state shown in the card. The card shows status indicators (green dot = clean, yellow = edited, amber = stale with action button). The menu should mirror this.

**Proposal:** Two changes:

**A. Add "Relaunch App" menu item.** Place it between Restart Server and Reset Everything:

1. Reload Frontend (Cmd+R)
2. Restart Server (Cmd+Shift+R)
3. Relaunch App (Cmd+Option+Shift+R or similar)
4. Reset Everything (Cmd+Option+R)
5. (separator)
6. Open Web Inspector
7. (separator)
8. Source Tree display + Choose Source Tree...

**B. Badge dirty menu items with a diamond character.** When a row in the Developer card becomes stale (restart/relaunch available), prepend a diamond `◆` to the corresponding menu item title. When the state clears, remove it.

Implementation approach:
- Use Unicode character `◆` (U+25C6, BLACK DIAMOND) prepended to the menu item title
- When Backend row becomes stale: `restartMenuItem.title = "◆ Restart Server"`
- When it's clean: `restartMenuItem.title = "Restart Server"`
- Same pattern for Relaunch App
- The state change is communicated from tugcast to the Swift app via the same `dev_notification` mechanism that drives the card. The Swift ProcessManager already receives these notifications — it just needs to forward the state to AppDelegate to update menu titles.

### Issue 6: Dev mode on/off lifecycle — VERIFY

**Severity:** Needs verification
**Current state:** The enable/disable lifecycle has code paths and test coverage:
- `enable_dev_mode()` starts 3 watchers (compiled, app, Rust source) and stores DevRuntime
- `disable_dev_mode()` clears shared state, aborts polling, drops watchers
- The Settings card toggle sends `set-dev-mode` control frames
- The control handler in `control.rs` calls enable/disable appropriately

**The code looks correct.** But it hasn't been tested recently. Manual verification needed to confirm: (1) turning dev mode off stops all watchers and hides the Developer card, (2) turning it back on restarts watchers and shows the Developer card again. (This will be possible to test once Issue 4 is fixed and the toggle is visible.)

---

## Summary of Proposals

| # | Issue | Proposal | Priority | Effort |
|---|-------|----------|----------|--------|
| 1 | Flash fix hardcoded color | Theme-aware window background via persisted preference + bridge callback | Must fix | Medium |
| 2 | Workspace Cargo files not watched | Widen watch path to `tugcode/`, exclude `/target/`, match `Cargo.lock` | Must fix | Small |
| 3 | Reset doesn't relaunch | Change reset to use relaunch path (exit code 45); update label | Must fix | Medium |
| 4 | Dev mode toggle clipped | Change `.card-frame-content` overflow to `auto` | Must fix | Tiny |
| 5 | Menu missing Relaunch + no dirty badges | Add Relaunch item; badge dirty items with `◆` diamond | Must fix | Medium |
| 6 | Dev mode on/off lifecycle | Manual verification after Issue 4 fix | Verify | Tiny |
