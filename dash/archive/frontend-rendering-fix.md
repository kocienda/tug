# Frontend Rendering Fix

## Problem

After the React Foundation Cleanup (PR #67), the app launched to an empty grid. Multiple bugs were found and fixed: an infinite render loop, WebSocket origin rejection, CSP conflicts, and stale Vite processes. The app now renders cards — but the serving architecture is wrong.

Production mode currently runs `vite preview` (a Node.js process) just to serve pre-built static files. This is unnecessary overhead and the source of real bugs (stale processes, port conflicts, confusing process lifecycle). tugcast already has an HTTP server. It should serve the production frontend directly.

## Architecture

```
PRODUCTION                          DEV MODE

┌─────────────┐                    ┌─────────────┐
│  WKWebView  │                    │  WKWebView  │
└──────┬──────┘                    └──────┬──────┘
       │                                  │
       │ http://127.0.0.1:55255/          │ http://127.0.0.1:55155/
       │                                  │
┌──────▼──────┐                    ┌──────▼──────┐
│   tugcast   │                    │    Vite     │
│  port 55255 │                    │  port 55155 │
├─────────────┤                    ├─────────────┤
│ Serves:     │                    │ Serves:     │
│  HTML/CSS/JS│ (tower-http)       │  HTML/CSS/JS│ (HMR, live transforms)
│  /auth      │                    │             │
│  /ws        │                    │ Proxies:    │
│  /api       │                    │  /auth ───────► tugcast:55255
└─────────────┘                    │  /ws   ───────► tugcast:55255
                                   │  /api  ───────► tugcast:55255
                                   └─────────────┘
```

**tugcast serves three things in all modes:**
- `/auth` — token exchange, sets session cookie
- `/ws` — WebSocket upgrade for feeds
- `/api/tell` — control commands

**tugcast additionally serves in production mode:**
- Static files from `{source_tree}/tugdeck/dist/` via `tower-http::ServeDir` as a fallback route. If `dist/` doesn't exist, unmatched routes return 404 and a warning is logged.

**Vite runs only in dev mode:**
- Dev server with HMR and React Refresh on port 55155
- Proxies `/auth`, `/ws`, `/api` to tugcast on port 55255
- No Vite process runs in production

**Static file serving uses `tower-http::ServeDir`, not `rust-embed`.**
rust-embed was previously removed from tugcast. We use runtime file serving from disk instead of compile-time embedding. This means tugcast doesn't need to be recompiled when the frontend changes — just rebuild dist/ and reload.

**Cookies are host-scoped, not port-scoped (RFC 6265).**
A session cookie set by tugcast at `127.0.0.1:55255` is sent to Vite at `127.0.0.1:55155` and vice versa. Mode toggling does not break the auth session.

**Mode toggling works because:**
- Production → Dev: spawn Vite, reload WebView from port 55155, cookie carries over, `sendDevMode(enabled: true)` adds Vite port to origin allowlist
- Dev → Production: kill Vite, reload WebView from port 55255, cookie carries over, `sendDevMode(enabled: false)` removes Vite port from origin allowlist

## Bugs Found and Fixed (Prior Work)

These were discovered and fixed while debugging the post-PR #67 breakage:

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| Infinite render loop (React error #185) | Unstable callback identity in `deck-canvas.tsx` | `useRef` pattern to stabilize callbacks |
| WebSocket disconnect banner persists | `control.rs` dropped Vite port from origin allowlist in production mode | Always include `vite_port` in origin allowlist |
| Silent rendering failures | No error boundary, no diagnostic logging | Added `ErrorBoundary` component + `diagnostic.js` |
| CSP blocks Vite dev mode | `<meta>` CSP tag blocked React Refresh inline scripts | Removed CSP meta tag (no security value in WKWebView) |
| HMR not working in dev mode | Stale `vite preview` process held port across app relaunches | Added `killProcessOnPort()` to `ProcessManager.swift` |
| Port conflict risk | Vite used default port 5173 | Changed to dedicated port 55155 |

The ErrorBoundary, `diagnostic.js`, and CSP removal carry forward into all phases below.

Note: The "always include `vite_port`" origin fix was correct for the old model (both modes served by Vite). Under the new model, this needs to be revised — `dev_port` should only be set when dev mode is enabled (see Phase 0).

## Phased Plan

Each phase is verified by running the app and observing behavior. No phase is done until it passes under the new architecture.

### Phase 0: Establish Baseline in Production Mode

**Goal**: Cards render with tugcast serving the frontend directly. No Vite process running.

This is the architectural cutover. Production mode currently spawns `vite preview` on port 55155. After this phase, tugcast serves `dist/` directly from disk and no Vite process is involved.

Changes needed:

1. **Add `tower-http` dependency to tugcast** — add `tower-http` with the `fs` feature to `Cargo.toml`. This provides `ServeDir` for static file serving from disk.

2. **Add static file fallback to tugcast's router** — in `server.rs`, add a `ServeDir` fallback that serves files from `{dir}/tugdeck/dist/`. Use `not_found_service(ServeFile::new("index.html"))` for SPA routing. If the dist directory doesn't exist, log a warning and skip the fallback (routes return 404).

3. **Update `AppDelegate.swift`** — in production mode (`devModeEnabled == false`), load from tugcast port (55255) instead of spawning Vite. Only spawn Vite when `devModeEnabled == true`.

4. **Update `ProcessManager.swift`** — `spawnViteServer` should only be called when dev mode is enabled. No Vite process in production.

5. **Revise origin allowlist in `control.rs`** — revert the "always set dev_port" fix. In production mode, set `dev_port` to `None` (origin `127.0.0.1:55255` is always allowed as the tugcast port). In dev mode, set `dev_port` to the Vite port (adds `127.0.0.1:55155` to the allowlist).

6. **Rebuild and test**: `cd tugdeck && npm run build` to create dist/, `just app` with `DevModeEnabled = false`.

7. **Verify**: Grid appears, cards render, WebSocket connects (to 55255 directly, no proxy), no disconnect banner, no Vite process running (`lsof -i :55155` shows nothing).

### Phase 1: Structural Robustness

**Goal**: Verify error visibility works under the new serving model.

1. Confirm ErrorBoundary renders a visible fallback when a component throws
2. Confirm `diagnostic.js` catches and displays uncaught errors
3. Confirm Web Inspector shows diagnostic log messages

These were already implemented but must be re-verified since the serving path changed (tugcast instead of Vite).

### Phase 2: Dev Mode

**Goal**: Cards render with HMR working. Vite serves the frontend, proxying to tugcast.

1. Toggle dev mode ON: `defaults write dev.tugtool.app DevModeEnabled -bool true`
2. Launch the app
3. **Verify**: Vite dev server starts on port 55155, cards render, console shows unbundled module names (not hashed `index-*.js`)
4. Edit `tugdeck/styles/tokens.css` — change a color value, save
5. **Verify**: Change appears live without page reload (HMR working)
6. **Verify**: No stale process issues (the `killProcessOnPort` fix from prior work handles this)

### Phase 3: Mode Toggling

**Goal**: Seamless transitions between production and dev mode in a running app.

Production → dev:
1. Start in production mode → verify cards render (served by tugcast on 55255)
2. Open Settings card → toggle dev mode ON
3. **Verify**: Vite starts on 55155, WebView reloads from Vite port, cards render, HMR works
4. **Verify**: Session survives the port change (no re-auth needed)

Dev → production:
5. Toggle dev mode OFF
6. **Verify**: Vite killed, WebView reloads from tugcast port (55255), cards render, no Vite process
7. **Verify**: Session survives the port change

Use `defaults write dev.tugtool.app DevModeEnabled -bool true/false` as fallback if the UI toggle doesn't work yet.

### Phase 4: Control Actions

**Goal**: All four control mechanisms work in both modes.

| Action | Trigger | Expected Behavior |
|--------|---------|-------------------|
| Reload Frontend | Developer menu or Dock | Frontend reloads page |
| Restart Server | Developer menu or Dock | tugcast restarts, frontend reconnects |
| Relaunch App | Developer menu | tugrelaunch helper restarts the entire app |
| Reset Everything | Developer menu or Dock | Clears localStorage, fresh state |

Test each in production mode and dev mode (8 tests total).

## Success Criteria

- Cards render in production mode (served by tugcast, no Vite process)
- Cards render in dev mode with HMR working (served by Vite)
- Mode toggling works in a running app (both via defaults and via UI)
- All four control actions work in both modes
- Rendering errors show a visible fallback UI instead of a blank screen

## What This Supersedes

This document supersedes `dash/frontend-serving-cleanup.md`, which proposed removing `rust-embed` from tugcast and making Vite serve everything in both modes. That proposal went the wrong direction — it added a Node.js process to the production runtime for no benefit. The correct architecture keeps tugcast as the production frontend server and uses Vite only for development. The old proposal is retained as historical context for what was previously removed from tugcast.
