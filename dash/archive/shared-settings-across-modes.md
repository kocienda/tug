# Shared Settings Across Dev/Production Modes

## Problem

Card layout and theme settings are lost when switching between dev mode (port 55155) and production mode (port 55255). The user sees completely different layouts in each mode.

## Root Cause

localStorage is scoped by **origin** (protocol + host + port). Dev mode loads from `http://127.0.0.1:55155` (Vite) and production loads from `http://127.0.0.1:55255` (tugcast). These are different origins with completely separate localStorage stores.

## Current State (on main)

The `shared-settings` dash merged code that attempts to sync via UserDefaults:

1. `didFinishNavigation` fires → calls `syncLocalStorageOnPageLoad()`
2. Reads localStorage via `evaluateJavaScript` → saves to UserDefaults
3. If localStorage is empty but UserDefaults has data → injects via `evaluateJavaScript`

**Why it fails:** `didFinishNavigation` fires AFTER the page's JavaScript has already executed. By that point, DeckManager has already called `loadLayout()` from empty localStorage and initialized with the default layout. The injection happens too late — the layout is already rendered.

## Detailed Timing (the race)

```
1. loadURL("http://127.0.0.1:55255/auth?token=...")
2. HTML loads, JS bundle executes
3. main.tsx runs:
   - Line 43: new DeckManager(container, ...)
   - Constructor calls this.loadLayout()
   - loadLayout() reads localStorage.getItem("tugdeck-layout")
   - localStorage is EMPTY (fresh origin) → returns default layout
   - DeckManager renders with default 5-card layout
4. didFinishNavigation fires
5. syncLocalStorageOnPageLoad() runs (async)
6. evaluateJavaScript reads localStorage (empty) and UserDefaults (has saved layout)
7. evaluateJavaScript injects UserDefaults values into localStorage
8. TOO LATE — DeckManager already initialized with defaults
```

## What Was Tried and Discarded

A `WKUserScript` at `.atDocumentStart` approach was attempted in the `shared-settings-fix` dash. It injected a `window.__TUG_SETTINGS` global before page JS ran, and modified the frontend to read from it. This was discarded because it didn't work in testing. Possible failure modes were never diagnosed.

## Settings Architecture Reference

### What gets stored

| Setting | localStorage Key | UserDefaults Key | Format |
|---------|-----------------|-----------------|--------|
| Card layout | `tugdeck-layout` | `TugdeckLayout` | JSON, v5 format, ~2-5 KB |
| Theme | `td-theme` | `TugdeckTheme` | String: "brio", "bluenote", "harmony" |
| Window bg color | N/A | `TugWindowBackground` | Hex color string |

### How layout is saved (frontend)

`DeckManager.scheduleSave()` is called after every layout change (drag, resize, tab switch, card add/remove). It debounces at 500ms, then calls `saveLayout()` which serializes to v5 JSON and writes to localStorage.

### How layout is loaded (frontend)

`DeckManager.loadLayout()` runs once in the constructor (main.tsx line 43 → deck-manager.ts line 212). It reads from `localStorage.getItem("tugdeck-layout")`. If missing or invalid, returns `buildDefaultLayout()`.

### How theme is saved (frontend)

`setTheme()` in use-theme.ts: (1) sets body class, (2) writes to localStorage, (3) posts hex color to Swift bridge via `setTheme` message handler.

### How theme is loaded (frontend)

`useTheme()` hook reads from `document.body.classList` on mount via `readCurrentTheme()`. It does NOT read from localStorage. Theme classes must be on the body element before React renders for the correct theme to appear.

### Vite proxy config

Both dev and production modes proxy `/api/*` to tugcast on port 55255. This is already configured in vite.config.ts.

## Solution Options

### Option A: Tugcast API endpoint

Add a settings endpoint to tugcast. The frontend saves/loads settings through the API instead of (or in addition to) localStorage. Since both modes proxy `/api` to the same tugcast instance, settings are automatically shared.

**Changes required:**
- tugcast (Rust): Add `GET /api/settings` and `POST /api/settings` routes. Store as a JSON file in the source tree (e.g., `.tugtool/deck-settings.json`) or in memory.
- deck-manager.ts: On init, `fetch("/api/settings")` before constructing layout. On save, `fetch("/api/settings", { method: "POST", body })` in addition to localStorage.
- use-theme.ts: Similar fetch-before-render pattern, or include theme in the same endpoint.
- main.tsx: Make initialization async — fetch settings, then construct DeckManager.

**Pros:**
- Both modes use the same tugcast, so sharing is automatic
- No Swift changes needed
- No WKWebView edge cases
- Works for any future mode or port configuration
- Clean separation: tugcast owns settings persistence

**Cons:**
- Requires Rust changes (new API routes)
- Makes frontend init async (fetch before render)
- Adds a file write on every layout save (debounced)
- Settings depend on tugcast being running

### Option B: WKUserScript at document start (retry with diagnosis)

Retry the discarded approach, but this time with proper debugging to understand why it failed.

**What it does:**
- Before each `loadURL`, read UserDefaults and install a `WKUserScript` with `injectionTime: .atDocumentStart` that sets `window.__TUG_SETTINGS = { layout, theme }`
- Frontend reads from global first, falls back to localStorage

**Changes required:**
- AppDelegate.swift: Install WKUserScript before each loadURL
- MainWindow.swift: Expose addUserScript/removeAllUserScripts
- deck-manager.ts: Check `window.__TUG_SETTINGS?.layout` before localStorage
- use-theme.ts / main.tsx: Apply theme from global before React renders

**Pros:**
- No Rust changes
- No network requests
- Synchronous — global is available before any JS runs

**Cons:**
- Previous attempt failed for unknown reasons
- WKWebView-specific behavior may have edge cases
- Requires understanding and fixing the previous failure

### Option C: Cookie-based sync

Use cookies instead of localStorage for settings. Cookies are scoped by host only (not port) per RFC 6265, so both origins share the same cookie jar.

**Changes required:**
- deck-manager.ts: Read/write layout via `document.cookie` instead of localStorage
- use-theme.ts: Same

**Pros:**
- No Swift or Rust changes
- Automatic sharing across ports
- Simple implementation

**Cons:**
- Cookie size limit is ~4 KB per cookie. Layout JSON is 2-5 KB, which is borderline.
- Would need to compress or split across multiple cookies for larger layouts
- Cookies are sent with every HTTP request (bandwidth waste)
- Cookie parsing is more complex than localStorage API

### Option D: Single origin (architectural change)

Make both modes load from the same origin. In dev mode, instead of loading from Vite on port 55155, load from tugcast on port 55255 and have tugcast proxy to Vite for static assets.

**Pros:**
- Eliminates the root cause entirely
- No sync mechanism needed at all

**Cons:**
- Large architectural change
- Reverses the work done in the frontend rendering fix plan
- HMR would need to work through tugcast proxy
- Significantly more complex

## Decision: Option A (Tugcast API Endpoint)

Option A is the chosen approach. It eliminates the timing problem entirely — the frontend fetches settings from the API before initializing, and the API is the same endpoint regardless of mode. No WKWebView edge cases, no race conditions, no cookie size limits.

Option B (WKUserScript) was attempted twice and failed both times for undiagnosed reasons. Rather than debug further, we go with the approach that avoids WKWebView entirely.

---

## Option A: Detailed Investigation

### Storage Backend: File vs UserDefaults

**Decision: File (`.tugtool/deck-settings.json`)**

Tugcast is a Rust process. It has no native access to macOS UserDefaults. Using UserDefaults would require one of:
- Shelling out to the `defaults` CLI tool — fragile, slow, parsing pain
- FFI bindings to Apple's CoreFoundation — complex, platform-specific
- Routing through the control socket to the Swift app — defeats the purpose (re-introduces the Swift/WKWebView layer we're trying to bypass)

A JSON file is the right choice:
- tugcast already has `watch_dir` (the resolved source tree path) available in `main.rs` line 298 and passed to `build_app` as `source_tree`
- `serde_json` is already a dependency
- `tokio::fs` is already available via the tokio runtime
- `.tugtool/` is the established convention for tugtool metadata
- The file is human-readable and debuggable (`cat .tugtool/deck-settings.json`)
- Cross-platform if tugcast ever runs outside macOS

### Cons Mitigation

**Con 1: "Requires Rust changes (new API routes)"**

Straightforward. The existing `/api/tell` handler in `server.rs` provides a clear pattern: extract `ConnectInfo` for loopback check, extract `State<FeedRouter>` for shared state, return JSON. Two new handlers (GET and POST) following the same pattern. One new module (`settings.rs`) with a `DeckSettings` struct.

The `source_tree` path is already passed to `build_app` (`server.rs:129`). It just needs to be made available to the settings handlers — either by storing it in `FeedRouter` or by layering it as separate axum state via `.layer(Extension(...))`.

**Con 2: "Makes frontend init async (fetch before render)"**

The fetch is a local HTTP call to `127.0.0.1:55255` (or proxied through Vite in dev mode). Round-trip latency is sub-millisecond. The approach:

1. Wrap `main.tsx` initialization in an async IIFE
2. First action: `fetch("/api/settings")`
3. Apply theme to `document.body` before React renders (so `readCurrentTheme()` picks it up from the DOM)
4. Pass layout JSON to `DeckManager` constructor (new optional parameter)
5. If fetch fails (network error, tugcast not ready), fall back to localStorage — identical to current behavior

The visual delay is imperceptible. The user sees no flash because theme is applied to the body before any React component mounts.

If the fetch fails, the frontend should retry (with backoff) rather than fall back to localStorage. localStorage on a fresh origin gives the default layout — the exact bug we're fixing. Since nothing else works without tugcast (no WebSocket, no terminal, no API), waiting for the settings endpoint is not an additional constraint.

**Con 3: "Adds a file write on every layout save (debounced)"**

`scheduleSave()` already debounces at 500ms. The POST request piggybacks on this existing debounce — no additional writes beyond what already happens. The payload is 2-5 KB JSON. Local HTTP + file write of that size is <1ms.

For safety, use atomic writes: write to a temp file, then rename. This prevents corruption from interrupted writes.

**Con 4: "Settings depend on tugcast being running"**

The entire application depends on tugcast. If tugcast isn't running:
- No WebSocket connection (terminal, filesystem, git, stats feeds all dead)
- No API (`/api/tell` unavailable)
- In production mode, no page at all (tugcast serves the frontend)

Settings availability is not a new dependency — it's an existing one. The frontend already handles tugcast unavailability (reconnect logic, disconnect banner). If the settings GET fails, the frontend retries until tugcast is reachable — it cannot proceed without settings because falling back to localStorage would reproduce the exact origin-scoping bug we're fixing.

### Settings File Format

```json
{
  "layout": { "version": 5, "cards": [...] },
  "theme": "brio"
}
```

The `layout` field holds the same v5 JSON that `deck-manager.ts` already serializes. The `theme` field is one of: `"brio"`, `"bluenote"`, `"harmony"`.

File location: `{source_tree}/.tugtool/deck-settings.json`. The `.tugtool/` directory may already exist (it's used by tugcode for plans and state). If not, create it.

### Tugcast Implementation

**New module: `settings.rs`**

```
struct DeckSettings { layout: Option<Value>, theme: Option<String> }
```

- `load(path)` → read file, parse JSON, return `DeckSettings` (or defaults if file missing)
- `save(path, settings)` → serialize JSON, atomic write (temp file + rename)

**New routes in `build_app` (server.rs)**

```
.route("/api/settings", get(get_settings).post(post_settings))
```

Both handlers:
1. Check loopback IP (same as `tell_handler`)
2. Derive settings file path from `source_tree` (which `build_app` already receives)
3. GET: read file, return JSON (or empty defaults if file missing)
4. POST: parse body, write file, return OK

**Making `source_tree` available to handlers:**

Option: store the settings file path in a new lightweight state struct layered onto the router, or add it to `FeedRouter`. The simplest approach is to create the path in `build_app` and add it as an axum `Extension`:

```rust
let settings_path = source_tree.map(|t| t.join(".tugtool/deck-settings.json"));
base.layer(Extension(SettingsPath(settings_path)))
```

### Frontend Implementation

**main.tsx changes:**

Wrap initialization in an async IIFE. Before constructing DeckManager:

```typescript
(async () => {
  // Fetch settings — retry until tugcast is reachable (nothing works without it)
  const serverSettings = await fetchSettingsWithRetry("/api/settings");

  // Apply theme to body BEFORE React renders
  if (serverSettings.theme && serverSettings.theme !== "brio") {
    document.body.classList.add(`td-theme-${serverSettings.theme}`);
  }

  // Pass layout to DeckManager
  const dm = new DeckManager(container, serverSettings.layout ?? null);
  // ... rest of init unchanged
})();
```

**deck-manager.ts changes:**

- `loadLayout()` accepts an optional pre-fetched layout parameter. If provided and valid, use it (and also write it to localStorage as cache). Otherwise fall back to localStorage, then default.
- `saveLayout()` adds a `fetch("/api/settings", { method: "POST", body })` call after writing to localStorage. This is fire-and-forget (no await needed in the debounced save path).

**use-theme.ts changes:**

- `setTheme()` already writes to localStorage. Add a fire-and-forget POST to `/api/settings` with the new theme. Since layout saves also POST to the same endpoint, consolidate: the POST always sends the full settings object (layout + theme). The debounce in `scheduleSave()` naturally batches this.

### Swift Cleanup

With settings synced through the tugcast API, the broken Swift-side sync code is no longer needed:

**Remove:**
- `syncLocalStorageOnPageLoad()` in AppDelegate.swift (lines 137-213)
- `bridgePageDidLoad()` protocol method and its call in `didFinishNavigation`
- `keyTugdeckLayout` and `keyTugdeckTheme` from TugConfig.swift

**Keep:**
- `keyWindowBackground` — used for the native NSWindow background color (separate from frontend settings; works correctly today)
- `keyDevModeEnabled` and `keySourceTreePath` — app-level preferences, unrelated to deck settings

### Data Flow (after implementation)

```
SAVE (user drags a card):
  1. DeckManager.scheduleSave() → 500ms debounce
  2. saveLayout() fires:
     a. localStorage.setItem("tugdeck-layout", json)  ← local cache
     b. fetch("/api/settings", { method: "POST", body: { layout, theme } })
        → Vite proxy (dev) or direct (prod) → tugcast on :55255
        → tugcast writes .tugtool/deck-settings.json

LOAD (page opens in either mode):
  1. main.tsx: fetch("/api/settings")
     → Vite proxy (dev) or direct (prod) → tugcast on :55255
     → tugcast reads .tugtool/deck-settings.json
  2. Apply theme to document.body
  3. Pass layout to new DeckManager(container, layout)
  4. DeckManager renders with the shared layout
```

Both modes hit the same tugcast instance on port 55255. The Vite proxy for `/api` is already configured. Settings are automatically shared regardless of which mode the page loaded from.
