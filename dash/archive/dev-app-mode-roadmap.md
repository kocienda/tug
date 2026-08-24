# DEV MODE + APP MODE Strategy

DEV MODE and APP MODE are the same application with a toggle. The Mac app is
the shell for both. Dev mode is a Developer menu item, exactly like Safari.

```
┌─────────────────────────────────────────────────────┐
│  Tugtool.app                                        │
│  ┌───────────────────────────────────────────────┐  │
│  │  WKWebView  <-  http://127.0.0.1:7890         │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  ProcessManager spawns:                             │
│    tugcast [--dev /u/src/tugtool/tugdeck]           │
│      └── tugtalk                                    │
│                                                     │
│  Menus:                                             │
│    Tugtool  File  Developer  Help                   │
│    └─ Developer (hidden until enabled):             │
│       ☑ Enable Dev Mode                             │
│       ──────────                                    │
│       Reload Frontend          ⌘R                   │
│       Restart Server           ⌘⇧R                  │
│       Reset Everything         ⌘⌥R                  │
│       ──────────                                    │
│       Open Web Inspector                            │
│       Source Tree: /u/src/tugtool                   │
└─────────────────────────────────────────────────────┘
```

**APP MODE** (default): Everything is bundled inside the .app. Double-click,
it works. Tugcast serves embedded assets.

**DEV MODE** (toggled on): Tugcast restarts with `--dev`, serves from your
source tree. `bun dev` watches and rebuilds. Browser auto-reloads on save.
You edit code, see changes live, commit when ready.

From the terminal, one command does everything:

```bash
tugtool --dev
```

This auto-detects the source tree, spawns `bun dev` to watch and rebuild
tugdeck, spawns tugcast with `--dev` to serve from disk, and opens the
browser. Ctrl+C kills all child processes.

In the Mac app, the same transition happens when you toggle "Enable Dev
Mode" in the Developer menu. The first time, the app opens a folder picker
for the source tree root (the directory containing `tugdeck/`, `tugcode/`,
etc.). It validates the selection — checks that `tugdeck/src/main.ts` and
`tugdeck/package.json` exist — then stores the path in
`~/Library/Preferences/com.tugtool.app.plist` (standard `UserDefaults`).

From then on, toggling Dev Mode is instant — one click, no prompts. The
stored path appears in the Developer menu as "Source Tree: /u/src/tugtool"
so you always know where it's pointing. If you need to change it, a
"Choose Source Tree..." menu item opens the picker again.

On activation, the app restarts tugcast with `--dev` and starts `bun dev`
in the background. Live reload works — save a file, see the change. Toggle
Dev Mode off, and it goes back to embedded assets.

**Error handling for Dev Mode activation:**

- **Source tree missing or moved:** "Source tree not found at /old/path.
  Choose a new location?" with a button to open the folder picker. Dev Mode
  stays off until resolved.
- **`tugdeck/` not found in source tree:** "No tugdeck/ directory found in
  /u/src/tugtool. Is this the right source tree?" Same picker button.
- **`bun` not installed:** "bun is required for Dev Mode but was not found
  in PATH. Install it from https://bun.sh" Dev Mode stays off.
- **`bun dev` crashes:** "Frontend watcher exited unexpectedly. Restart it?"
  with Restart / Dismiss buttons. Tugcast keeps running (serves stale files
  from disk) so the app doesn't go dark.
- **`tugcast --dev` fails to bind port:** "Port 7890 is already in use.
  Another instance of tugcast may be running." Offers to kill the stale
  process or pick a different port.
- **Source tree has no `node_modules/`:** Automatically runs `bun install`
  before starting `bun dev`. Shows brief "Installing dependencies..." status
  in the Developer menu.

---

## 1. The Linchpin: `tugcast --dev`

Everything else builds on this one change.

**Today:** `server.rs` only serves from rust-embed. No escape hatch. Every
frontend change requires `cargo build -p tugcast`.

**Proposed:** Add `--dev <path>` flag to tugcast. When set, serve from disk
using `tower_http::services::ServeDir`. The change to `build_app` in
`server.rs`:

```rust
pub(crate) fn build_app(router: FeedRouter, dev_path: Option<PathBuf>) -> Router {
    let base = Router::new()
        .route("/auth", get(crate::auth::handle_auth))
        .route("/ws", get(crate::router::ws_handler));

    if let Some(ref path) = dev_path {
        // DEV: serve from disk — picks up changes without rebuild
        base.fallback_service(ServeDir::new(path))
    } else {
        // APP: serve embedded assets from binary
        base.fallback(serve_asset)
    }
    .with_state(router)
}
```

In dev mode, `bun dev` rebuilds `dist/app.js` on save. Tugcast serves the
updated file from disk on the next browser refresh. No cargo rebuild needed
for frontend changes.

The `tugtool --dev` command orchestrates this automatically:

1. Auto-detect the mono-repo root (walk up from cwd looking for
   `tugdeck/`, or accept `--source-tree <path>`)
2. Spawn `bun dev` as a child process in `tugdeck/` (watch + rebuild)
3. Spawn `tugcast --dev <tugdeck-path>` (serve from disk)
4. Open browser to the auth URL
5. On Ctrl+C, kill both child processes cleanly

**Note:** The `tower-http` crate with `features = ["fs"]` needs to be added
back to `Cargo.toml` when this phase is implemented (it was previously listed
as a workspace dependency but never used, so it was removed as dead code).

---

## 2. Live Reload

Automatic browser refresh without manual ⌘R:

1. Tugcast watches the dev path using `notify` (already a dependency — used
   by the filesystem feed).
2. New SSE endpoint: `GET /dev/reload` — holds the connection open, sends an
   event when watched files change.
3. In dev mode, tugcast injects a small script into the `index.html` response:
   ```js
   new EventSource("/dev/reload").onmessage = () => location.reload();
   ```
4. Result: save `.ts` or `.css` -> bun rebuilds -> notify fires -> SSE
   pushes -> browser reloads.

This is the same pattern used by Vite, esbuild's serve mode, etc. — but
wired into tugcast directly so it works inside the WKWebView too.

---

## 3. Rust Backend Changes (The Harder Case)

Frontend hot-reload is straightforward. Rust changes (tugcast itself,
tugcode, tugtalk) need a recompile. The strategy:

**Restart Server (⌘⇧R):** Tugdeck sends a restart command over WebSocket.
Tugcast signals the parent process (tugtool/app). The app kills and respawns
tugcast. Tugdeck's existing auto-reconnect with exponential backoff handles
the brief disconnect.

**Binary watching:** The app watches `tugcode/target/debug/tugcast` for mtime
changes. When it detects a new binary (from `cargo build` you ran in another
terminal), it shows a subtle "Server outdated — restart?" indicator in the
dock, or auto-restarts.

**Reset Everything (⌘⌥R):** Clears localStorage, clears all caches, kills
tugcast, respawns. Clean slate.

---

## 4. Mac App: Minimal `.xcodeproj`

```
tugapp/                              (new directory at repo root)
├── Tug.xcodeproj/                (build config — built with xcodebuild)
├── Sources/
│   ├── AppDelegate.swift            (~100 lines: lifecycle, Developer menu)
│   ├── MainWindow.swift             (~80 lines: WKWebView setup)
│   └── ProcessManager.swift         (~120 lines: spawn/monitor tugcast)
├── Assets.xcassets/
│   ├── AppIcon.appiconset/          (standard icon + nightly variant)
│   └── AccentColor.colorset/
├── Tug.entitlements              (hardened runtime: allow unsigned exec)
└── Info.plist
```

Total Swift code: ~300 lines. Three files. The app is a thin shell — the
real work is all tugcast/tugdeck/tugcode.

**Build from terminal** (no Xcode GUI):

```bash
xcodebuild -project tugapp/Tug.xcodeproj -scheme Tug build
```

**What's inside the .app bundle:**

```
Tug.app/Contents/
├── MacOS/
│   ├── Tug                          (Swift host)
│   ├── tugcast                      (server binary)
│   ├── tugcode                      (CLI binary)
│   └── tugtalk                      (protocol bridge)
├── Resources/
│   ├── AppIcon.icns
│   └── tugplug/                     (skills + agents for APP MODE users)
└── Info.plist
```

The app finds tugcast as a sibling binary. The tugtool launcher's existing
`resolve_tugcast_path` already checks the sibling directory first. Same
pattern works from inside the .app bundle.

---

## 5. Distribution

Two paths, two audiences:

| Path | Audience | What ships |
|------|----------|------------|
| **Tug.dmg** (direct download) | Everyone | Full .app with all binaries + plugin |
| **`brew install tugtool`** (formula) | Terminal-first devs | `tugcode` CLI + tugplug skills/agents |

Both can coexist. Homebrew stays for the CLI tool.

### Nightly builds (Safari Technology Preview model)

- **Tugtool.app** — stable releases, standard icon, bundle ID
  `com.tugtool.app`
- **Tugtool Nightly.app** — built from HEAD, different icon (orange/amber),
  bundle ID `com.tugtool.nightly`
- Both installable simultaneously (different bundle IDs)
- CI builds nightly from `main`, publishes to GitHub Releases with `nightly`
  tag

### What happens to `scripts/release.sh`?

It stays for the Rust/Homebrew release path (version bumps, tags, CI-built
tarballs). A new `scripts/build-app.sh` handles the Mac app: `cargo build
--release`, `bun build`, assemble .app, codesign, notarize, create DMG. All
from the command line.

---

## Implementation Phases

| Phase | What | Payoff |
|-------|------|--------|
| 1. Dev Serve | `tugtool --dev` (one command) | Spawns bun dev + tugcast --dev + opens browser |
| 2. Live Reload | File watcher + SSE + auto-inject | Save file -> see change automatically |
| 3. Dock Controls | Restart/Reset commands via WS IPC | Restart server without leaving the browser |
| 4. Mac App | `tugapp/` with xcodeproj, WKWebView, ProcessManager | Double-click to run. Developer menu for dev mode toggle |
| 5. Distribution | Signing, notarization, DMG, nightly CI | Other people can download and use it |

Phase 1 is the immediate unblock — it eliminates the cargo-rebuild-for-every-
frontend-change bottleneck. Phase 4 is the bigger structural commitment but
the Swift code is genuinely small. Phases 2-3 are quality-of-life that can
land incrementally.

---

## In a Pinch

The escape hatch always works:

```bash
claude --plugin-dir /u/src/tugtool/tugplug
```

Nothing about this plan breaks that workflow. The plugin lives in `tugplug/`,
the CLI is `tugcode`, the plans are in `.tugtool/`. The Mac app is additive —
a nicer way to run the same stack.
