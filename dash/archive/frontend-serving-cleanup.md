# Frontend Serving Cleanup

## Problem

tugcast has become a static file server. It embeds the entire tugdeck production
build via `rust-embed` and serves HTML, CSS, and JavaScript through a fallback
HTTP route. This is wrong. tugcast is a feed broadcaster. It serves tugfeeds
via WebSocket, handles auth, and accepts API commands. It should not serve web
pages.

Compounding the problem, there are three different paths for loading the
frontend, depending on mode:

1. **Non-dev mode:** WKWebView loads from tugcast's embedded assets on port
   55255. tugcast IS the web server.
2. **Dev mode (success):** WKWebView loads from a Vite dev server on port
   5173. Vite proxies `/auth`, `/ws`, `/api` to tugcast.
3. **Dev mode (failure):** Falls back to path 1.

These should be the same path. The only difference between dev and non-dev
should be whether HMR and file watching are active.

The current empty-window regression after the React Foundation Cleanup merge
is a direct consequence of this complexity. Dev mode is enabled, the Vite dev
server may or may not be running, the fallback logic is confused about where
to load from, and the result is a blank page.

## Principle

**Vite serves the frontend. Always. tugcast serves feeds. Always.**

The browser always loads from Vite. Vite always proxies backend routes to
tugcast. There is one serving path, not three.

## Architecture

```
                    ┌─────────────┐
                    │   Browser   │
                    │  (WKWebView)│
                    └──────┬──────┘
                           │
                           │  http://localhost:5173/
                           │
                    ┌──────▼──────┐
                    │    Vite     │
                    │  port 5173  │
                    ├─────────────┤
                    │  Serves:    │
                    │  HTML/CSS/JS│
                    │             │
                    │  Proxies:   │
                    │  /auth ────────► tugcast:55255
                    │  /ws   ────────► tugcast:55255
                    │  /api  ────────► tugcast:55255
                    └─────────────┘
```

In dev mode, Vite runs as a dev server (`vite`): live transforms, HMR,
file watching. In non-dev mode, Vite runs as a preview server
(`vite preview`): serves pre-built `dist/` files, no transforms. Both
modes use the same port, the same proxy config, the same URL. The browser
doesn't know or care which mode Vite is in.

The `vite.config.ts` proxy configuration already exists and already works:

```typescript
server: {
  proxy: {
    "/auth": { target: `http://localhost:${tugcastPort}` },
    "/ws":   { target: `ws://localhost:${tugcastPort}`, ws: true },
    "/api":  { target: `http://localhost:${tugcastPort}` },
  },
},
```

The `preview` section in Vite uses the same proxy config when specified.
Add a `preview.proxy` block identical to `server.proxy` in `vite.config.ts`.

## What Gets Removed

### From tugcast

**build.rs — remove the frontend build pipeline (keep tugtalk)**

Lines 31-80 build the tugdeck frontend: they check for bun, run
`bun install`, run `bun run build`, and copy `dist/` into `OUT_DIR/tugdeck/`
for embedding. All of this goes away. Lines 82-125 (tugtalk compilation)
stay.

The `rerun-if-changed` directives for `tugdeck/` files (lines 127-143) go
away. The tugtalk directives (lines 144-151) stay.

**server.rs — remove static asset serving**

Remove:
- `#[derive(RustEmbed)] #[folder = "$OUT_DIR/tugdeck/"] struct Assets;`
  (lines 21-24)
- `content_type_for()` function (lines 43-63)
- `serve_asset()` function (lines 138-158)
- `.fallback(serve_asset)` in the router (line 172)
- Tests that reference `Assets::get()` (lines 226-228, 231-235)

What stays: `/auth` route, `/ws` route, `/api/tell` route, `tell_handler`,
`TellRequest`/`TellResponse`, and `run_server`.

After cleanup, unmatched routes return 404 with no body. tugcast serves
nothing but feeds, auth, and API.

**Cargo.toml — remove rust-embed**

Remove `rust-embed = { workspace = true }` from `[dependencies]`. If
`rust-embed` is unused elsewhere in the workspace, remove it from the
workspace `Cargo.toml` as well.

### From the Swift app

**AppDelegate.swift — simplify URL loading**

The current flow has two branches: dev mode (load from Vite port) and
non-dev mode (load from tugcast port). Replace both with a single path:
always load from the Vite port.

Remove:
- The `if devEnabled` / `else` branch in `processManager.onReady`
  (lines 57-78)
- The `onDevModeResult` callback with its port-rewriting logic
  (lines 81-103)
- The `awaitingDevModeResult` flag

Replace with: after tugcast is ready, spawn the appropriate Vite server
(dev or preview), wait for it to be ready, then load from the Vite port.
Always. No branching, no fallback.

```
processManager.onReady = { url, port in
    // Spawn Vite (dev or preview mode based on devModeEnabled)
    self.processManager.spawnViteServer(
        sourceTree: self.sourceTreePath,
        tugcastPort: port,
        vitePort: self.vitePort,
        devMode: self.devModeEnabled
    )
    // Wait for Vite to be listening, then load
    self.processManager.waitForViteReady(port: self.vitePort) { ready in
        if !ready {
            NSLog("Vite server did not become ready")
            // TODO: show error in window
            return
        }
        let viteURL = url.replacingOccurrences(
            of: ":\(port)", with: ":\(self.vitePort)"
        )
        self.window.loadURL(viteURL)
    }
}
```

**ProcessManager.swift — unify Vite spawning**

The current `spawnViteDevServer()` only runs in dev mode. Replace with a
single method that spawns either `vite` (dev mode) or `vite preview`
(non-dev mode):

```swift
func spawnViteServer(sourceTree: String, tugcastPort: Int,
                     vitePort: Int, devMode: Bool) {
    let viteBinary = "\(sourceTree)/tugdeck/node_modules/.bin/vite"
    let args: [String]
    if devMode {
        args = ["--host", "127.0.0.1", "--port", "\(vitePort)", "--strictPort"]
    } else {
        args = ["preview", "--host", "127.0.0.1",
                "--port", "\(vitePort)", "--strictPort"]
    }
    // ... spawn process with TUGCAST_PORT env var ...
}
```

The `waitForViteReady()` function stays as-is (TCP polling works for both
modes).

Remove:
- The `sendDevMode()` call from the onReady path (still needed for file
  watchers, but decouple it from the URL loading gate)
- The dev mode result awaiting / URL gating logic

Note: `sendDevMode()` should still be called to activate tugcast's file
watchers. But it no longer gates the URL load. The URL load is gated only
on Vite being ready.

### From tugtool (CLI launcher)

**main.rs — same unification**

Replace `spawn_vite_dev()` (which spawns `vite` dev server) with
`spawn_vite()` that spawns either `vite` or `vite preview` depending on
whether the user wants HMR. Since tugtool auto-detects source trees and
is used by developers, defaulting to `vite` (dev mode) is fine.

Remove the auth URL port-rewriting logic — just always construct the URL
with the Vite port.

### From vite.config.ts

**Add preview proxy configuration**

The `server.proxy` config only applies to `vite` (dev server). For
`vite preview`, add an identical `preview.proxy` block:

```typescript
export default defineConfig(() => {
  const tugcastPort = process.env.TUGCAST_PORT || "55255";
  const proxyConfig = {
    "/auth": { target: `http://localhost:${tugcastPort}` },
    "/ws":   { target: `ws://localhost:${tugcastPort}`, ws: true },
    "/api":  { target: `http://localhost:${tugcastPort}` },
  };
  return {
    plugins: [react(), tailwindcss()],
    resolve: { ... },
    server: { proxy: proxyConfig },
    preview: { proxy: proxyConfig },
    build: { outDir: "dist", emptyOutDir: true },
  };
});
```

Also change `emptyOutDir` from `false` to `true`. The `false` setting was
a workaround for stale assets accumulating. With Vite always serving (not
embedded assets), there's no reason to keep old files around.

### From the justfile

**`just app` recipe — remove redundant bun build, ensure dist/ exists**

The `just app` recipe currently runs `(cd tugdeck && bun run build)` after
`cargo build`. With the frontend build removed from tugcast's `build.rs`,
the production bundle must be built explicitly before launching the app
(since `vite preview` needs `dist/` to exist). This `bun run build` call
stays, but now it's the ONLY place the production build happens — not a
redundant second build.

Remove the `lsof` / `kill` lines that clean up stale Vite processes
on port 5173 — the app manages its own Vite process lifecycle now.

**`just build` recipe — no change**

`cargo build` no longer triggers a frontend build (build.rs change).
This is correct: `just build` is for Rust binaries only.

**`just dev` recipe — works as before**

tugtool spawns Vite as part of its startup. No justfile-level Vite
management needed.

## What Stays Unchanged

- **tugcast dev.rs** — file watchers, change notifications, debounce
  logic. All of this is independent of who serves the frontend.
- **tugcast control.rs** — dev_mode message handling. Still needed for
  enabling/disabling file watchers.
- **The three-watcher model** — styles, code, app watchers. These watch
  for build outputs and source changes, send notifications. Unchanged.
- **The notification protocol** — `dev_notification` with types
  `reloaded`, `restart_available`, `relaunch_available`. Unchanged.
- **The Developer card** — receives and displays notifications. Unchanged.
- **WebSocket feed broadcasting** — the entire tugfeed system. Unchanged.
- **Auth flow** — `/auth` endpoint in tugcast. Unchanged. Vite proxies
  to it.

## The "no source tree" case

The current architecture requires a source tree to run Vite. This is fine
for `just app` and `just dev`, which always have source trees. For future
distribution (installed .app without source), the options are:

1. Bundle `dist/` and a small static file server in the app (not tugcast)
2. Bundle `dist/` and the vite binary in the app for `vite preview`
3. Require a source tree (simplest; defer this problem)

This proposal does not address distribution. The immediate priority is
fixing the development workflow. The distribution case can be solved
separately with a purpose-built static server if needed.

## Summary of changes

| Component | Change |
|-----------|--------|
| `tugcode/crates/tugcast/build.rs` | Remove tugdeck build pipeline (lines 31-80). Keep tugtalk. Remove tugdeck rerun-if-changed directives. |
| `tugcode/crates/tugcast/src/server.rs` | Remove `Assets`, `serve_asset`, `content_type_for`, `.fallback(serve_asset)`, related tests. |
| `tugcode/crates/tugcast/Cargo.toml` | Remove `rust-embed` dependency. |
| `tugdeck/vite.config.ts` | Add `preview.proxy` block. Change `emptyOutDir` to `true`. |
| `tugapp/Sources/AppDelegate.swift` | Remove dev/non-dev URL branching. Always spawn Vite, always load from Vite port. |
| `tugapp/Sources/ProcessManager.swift` | Unify `spawnViteDevServer` into `spawnViteServer(devMode:)` that runs `vite` or `vite preview`. |
| `tugcode/crates/tugtool/src/main.rs` | Replace `spawn_vite_dev` with unified `spawn_vite`. Always use Vite port for URLs. |
| `justfile` | Remove stale Vite kill lines from `app` recipe. Keep `bun run build`. |

## Future consideration: consolidate /api/tell onto the control socket

tugcast currently has two control paths:

1. **UDS control socket** — used by the Swift app and tugtool to send
   commands like `dev_mode`, `restart`, etc. This is the primary control
   channel.
2. **`/api/tell` HTTP endpoint** — used by `tugcode tell` (the CLI
   command) to send actions like `restart`, `show-card`,
   `reload_frontend`, etc. over HTTP POST.

These do the same thing via different transports. With the frontend
serving removed, `/api/tell` is the only remaining HTTP route besides
`/auth` and `/ws`. It exists so that `tugcode tell` can poke tugcast
without needing UDS socket access, but the UDS socket is already
available to any local process.

This proposal does not remove `/api/tell` — it's functional and has
test coverage. But it should be evaluated for consolidation onto the
control socket in a future pass. Two control paths is one more than
necessary.

## What this supersedes

This proposal supersedes the "production (embedded) serving path" preserved
in `dev-mode-post-react.md`. That document explicitly listed the embedded
serving path as unchanged. This proposal removes it entirely.
