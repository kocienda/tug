# Component Roadmap: tugcast + tugdeck

## Naming Convention

| Name | Role | Description |
|------|------|-------------|
| **tugcast** | Backend server | Rust binary. Publishes live data streams over WebSocket. |
| **tugfeed** | Data source | A single stream within tugcast. Each feed produces typed frames. |
| **tugdeck** | Frontend UI | Web dashboard. The operator interface for viewing and controlling execution. |
| **tugcard** | Display component | A single panel within tugdeck. Each card renders one or more tugfeeds. |

The relationship: tugcast produces tugfeeds. tugdeck renders tugcards. Each tugcard subscribes to one or more tugfeeds over a multiplexed WebSocket connection.

## 1. Problem Statement

Claude Code runs as an interactive TUI in a terminal. There is currently no way to "front" a locally-running Claude Code session with a richer interface that also integrates auxiliary data sources (filesystem activity, git status, statistics) into a unified dashboard. Existing open-source solutions (claude-code-web, claudecodeui, claude-code-webui) are all Node-based and treat the terminal as the only display channel.

## 2. Design Principles

- **Single source of truth.** Claude Code runs inside a tmux session. The tmux pane *is* the canonical terminal state. tugdeck is a viewport onto that state, not a competing state machine. This eliminates drift by construction.
- **Rust backend, minimal frontend JS.** tugcast is a single Rust binary. tugdeck is vanilla TypeScript + xterm.js with no framework. Node tooling is confined to the build step (esbuild).
- **Local-first security.** Binds to `127.0.0.1` only. No remote access path. Origin-checked WebSocket with a one-time auth token.
- **Multi-feed dashboard.** tugdeck is not merely a terminal mirror. It is a deck of tugcards where the terminal is one feed among several: filesystem events, git status, and extensible stat collectors.

## 3. Architecture Overview

```
┌──────────────────────────── tugdeck ────────────────────────────┐
│                        Web Browser                              │
│  ┌──────────────┐ ┌──────────┐ ┌─────────┐ ┌────────┐           │
│  │  Terminal    │ │ Files    │ │ Git     │ │ Stats  │           │
│  │  tugcard     │ │ tugcard  │ │ tugcard │ │ tugcard│           │
│  └──────┬───────┘ └────┬─────┘ └────┬────┘ └───┬────┘           │
│         └──────────────┴────────────┴──────────┘                │
│                        │                                        │
│              Multiplexed WebSocket                              │
│              (binary frames, feed-tagged)                       │
└────────────────────────┬────────────────────────────────────────┘
                         │ ws://127.0.0.1:<port>/ws (cookie auth)
                         │
┌────────────────────────┴──────── tugcast ───────────────────────┐
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │               axum HTTP/WS Server                          │ │
│  │   - Serves tugdeck assets (embedded in binary)             │ │
│  │   - Upgrades to WebSocket                                  │ │
│  │   - Multiplexes tugfeeds onto single connection            │ │
│  └─────────────┬──────────────────────────────────────────────┘ │
│                │                                                │
│  ┌─────────────┴──────────────────────────────────────────────┐ │
│  │              Feed Router                                   │ │
│  │   Dispatches frames to/from tugfeed drivers                │ │
│  └──┬──────────┬───────────┬────────────┬─────────────────────┘ │
│     │          │           │            │                       │
│  ┌──┴────┐  ┌──┴─────┐ ┌───┴─────┐ ┌────┴─────┐                 │
│  │Term   │  │ FS     │ │ Git     │ │ Stats    │                 │
│  │tugfeed│  │tugfeed │ │tugfeed  │ │ tugfeed  │                 │
│  └──┬────┘  └──┬─────┘ └────┬────┘ └────┬─────┘                 │
│     │          │            │           │                       │
└─────┼──────────┼────────────┼───────────┼───────────────────────┘
      │          │            │           │
      │       notify       git CLI     (pluggable)
      │       crate
      │
   ┌──┴───────────────────┐
   │  PTY running:        │
   │  tmux attach -t cc0  │
   └──────────┬───────────┘
              │
   ┌──────────┴───────────┐
   │  tmux session "cc0"  │
   │  ┌────────────────┐  │
   │  │  Claude Code   │  │
   │  │  (interactive) │  │
   │  └────────────────┘  │
   └──────────────────────┘
```

## 4. Project Structure

### 4.1 Repository Layout

```
tugtool/
├── crates/
│   ├── tugcast/                  # Binary crate — the backend server
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── main.rs           # Entry point: parse args, boot server
│   │       ├── cli.rs            # clap argument definitions
│   │       ├── server.rs         # axum server setup, static asset serving
│   │       ├── router.rs         # Feed router: multiplex/demux WebSocket frames
│   │       ├── auth.rs           # Token generation, cookie validation, origin check
│   │       └── feeds/
│   │           ├── mod.rs        # Feed registry, startup orchestration
│   │           ├── terminal.rs   # Terminal tugfeed: PTY ↔ tmux bridge
│   │           ├── filesystem.rs # Filesystem tugfeed: notify watcher
│   │           ├── git.rs        # Git tugfeed: status poller
│   │           └── stats.rs      # Stats tugfeed: pluggable collectors
│   │
│   └── tugcast-core/             # Library crate — shared types and protocol
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs            # Public exports
│           ├── protocol.rs       # Frame format, feed IDs, serialization
│           ├── feed.rs           # StreamFeed + SnapshotFeed trait definitions
│           └── types.rs          # FsEvent, GitStatus, StatSnapshot, etc.
│
├── tugdeck/                      # Frontend — vanilla TypeScript
│   ├── package.json
│   ├── tsconfig.json
│   ├── index.html                # Single-page shell
│   ├── src/
│   │   ├── main.ts               # Entry: WebSocket connect, card orchestration
│   │   ├── connection.ts         # WebSocket lifecycle, reconnect, auth
│   │   ├── protocol.ts           # Frame parse/serialize (mirrors tugcast-core)
│   │   ├── deck.ts               # Layout manager: CSS Grid, resize, collapse
│   │   └── cards/
│   │       ├── card.ts           # Base TugCard interface
│   │       ├── terminal-card.ts  # xterm.js terminal card
│   │       ├── files-card.ts     # Filesystem event log card
│   │       ├── git-card.ts       # Git status card
│   │       └── stats-card.ts     # Stats display card
│   └── styles/
│       ├── deck.css              # Grid layout, toolbar, status bar
│       └── cards.css             # Per-card styling
│
├── Cargo.toml                    # Workspace root
└── dash/
    └── component-roadmap.md      # This document
```

### 4.2 Cargo Workspace

```toml
# Cargo.toml (workspace root)
[workspace]
members = [
    "crates/tugcast",
    "crates/tugcast-core",
]
```

tugcast depends on tugcast-core. tugdeck is a standalone TypeScript project whose build output is embedded into the tugcast binary at compile time via `rust-embed`.

## 5. tugcast: Backend Server

### 5.1 Web Server

**Crate: `axum` 0.8.x** (tokio-native, ergonomic, near-Actix performance, lower memory)

tugcast does four things:
1. Serves tugdeck assets (HTML, JS, CSS) from an embedded directory (`rust-embed`)
2. Handles one-time auth at `GET /auth?token=<T>` (sets session cookie, invalidates token, redirects)
3. Accepts WebSocket upgrade at `GET /ws` (validates session cookie)
4. Hands authenticated connections to the feed router

A single `main.rs` boots the server, binds to `127.0.0.1:<port>`, prints the bootstrap URL (`/auth?token=<T>`) to stdout, and optionally opens the browser.

### 5.2 Terminal TugFeed

**Crate: `pty-process` 0.5.x** (async PTY with native tokio `AsyncRead`/`AsyncWrite` support)

The `pty-process` crate is preferred over `portable-pty` because it implements `tokio::io::AsyncRead` and `tokio::io::AsyncWrite` directly on the PTY handle, eliminating the need for `spawn_blocking` wrappers. Fallback option: `portable-pty` 0.9.x (from the wezterm project) if broader platform support is needed later.

The terminal tugfeed is the core integration point. It works as follows:

1. **Session setup.** On launch, tugcast either creates a new tmux session (`tmux new-session -d -s cc0 -- claude`) or attaches to an existing one if a session name is provided.
2. **PTY attachment.** tugcast spawns a PTY that runs `tmux attach-session -t cc0`. This gives two handles:
   - `AsyncRead` — raw bytes from tmux (terminal output, ANSI sequences, everything)
   - `AsyncWrite` — raw bytes to tmux (keystrokes, escape sequences, everything)
3. **Async bridging.** The async read side feeds into a `tokio::sync::broadcast` channel (capacity: 4096 messages; each message is one PTY read chunk, typically 1-4KB). The write side receives from an `mpsc` channel. No blocking thread wrappers needed.
4. **Resize propagation.** When tugdeck sends a resize event, tugcast calls the PTY resize ioctl and also runs `tmux resize-pane -t cc0 -x <cols> -y <rows>`. tmux's built-in "smallest client wins" policy arbitrates when multiple clients (real terminal + tugdeck) have different dimensions. tugdeck does not override the user's terminal — it is just another tmux client.
5. **Reconnect bootstrap.** Each tugdeck client has a per-client state machine: `BOOTSTRAP -> LIVE`. On new connection or reconnect, the client starts in BOOTSTRAP state. tugcast runs `tmux capture-pane -t cc0 -p -e` (preserving ANSI escapes) and sends the snapshot as the first terminal frame. During BOOTSTRAP, live PTY output is buffered (not dropped) for this client. After the snapshot is sent, buffered output is flushed and the client transitions to LIVE. This avoids duplicate or out-of-order rendering during active output.
6. **Backpressure.** If a slow tugdeck client falls behind the broadcast buffer (4096 messages), it receives a `Lagged` notification and transitions to BOOTSTRAP state for a capture-pane resync (see step 5). The slow client never blocks other clients or the PTY read loop.

**Why PTY-attach and not tmux control mode?** Control mode (`tmux -CC`) emits structured `%output` events, but they encode pane content as escaped text that must be reassembled. It's designed for GUI terminal emulators like iTerm2 that maintain their own terminal state machine. For our case — where xterm.js *is* the terminal state machine — raw PTY bytes from `tmux attach` are simpler, lower-latency, and more correct. We get every byte exactly as tmux would render it, including ANSI colors, cursor movement, alternate screen buffer, etc.

**Shared session semantics.** Because tmux supports multiple clients, the user's real terminal and tugdeck both attach to the same session simultaneously. Keystrokes from either side reach Claude Code. Output appears on both. There is structurally one source of truth. Input from all clients is multiplexed by tmux natively — no locking or writer-lease needed.

### 5.3 Filesystem TugFeed

**Crate: `notify` 8.2.x** (FSEvents on macOS, inotify on Linux, auto-selected via `RecommendedWatcher`)

Watches the project directory tree and emits events:
```rust
enum FsEvent {
    Created { path: PathBuf },
    Modified { path: PathBuf },
    Removed { path: PathBuf },
    Renamed { from: PathBuf, to: PathBuf },
}
```

Events are debounced (100ms window) to avoid flooding tugdeck during bulk operations (git checkout, cargo build). The watcher respects `.gitignore` patterns via the `ignore` crate to skip `target/`, `node_modules/`, etc.

Uses a `tokio::sync::watch` channel. Debounced events are coalesced into a batch; slow clients see the latest batch, not a growing queue.

Events are serialized to JSON and cast on the filesystem feed.

### 5.4 Git TugFeed

**Initial approach: `git` CLI** (simple, handles all edge cases including worktrees and sparse checkouts)

Uses a `tokio::sync::watch` channel (not broadcast). A watch channel holds only the latest value, so slow tugdeck clients always see current state rather than queuing stale snapshots.

Polls at a configurable interval (default: 2 seconds, accelerates to 500ms when filesystem events fire). Emits a snapshot:

```rust
struct GitStatus {
    branch: String,
    ahead: u32,
    behind: u32,
    staged: Vec<FileStatus>,
    unstaged: Vec<FileStatus>,
    untracked: Vec<String>,
    head_sha: String,
    head_message: String,
}
```

Starts with `git status --porcelain=v2 --branch` for reliability. Can migrate to `git2` (libgit2 bindings) later if latency matters. The snapshot is diffed against the previous one; only changes are cast to avoid redundant updates.

### 5.5 Stats TugFeed

Extensible slot for arbitrary metrics. Initial built-in collectors:

| Collector | Source | Interval | Reliability |
|-----------|--------|----------|-------------|
| Process info | `/proc` or `sysctl` | 5s | Stable |
| Claude Code token usage | Parse tmux pane output for status line | On change | Best-effort (fragile to upstream UI changes) |
| Build status | Watch `target/` modification times | On FS event | Stable |

The stats tugfeed uses a trait-based plugin system:
```rust
trait StatCollector: Send + Sync {
    fn name(&self) -> &str;
    fn collect(&self) -> serde_json::Value;
    fn interval(&self) -> Duration;
}
```

New collectors can be registered at startup. They run on independent timers and push JSON values onto the stats watch channel.

### 5.6 Feed Traits

Defined in `tugcast-core`. There are two feed types, matching the two outbound channel semantics:

```rust
/// A StreamFeed produces a continuous stream of frames.
/// Used for terminal output where every byte matters and ordering is critical.
/// Backed by `tokio::sync::broadcast`.
#[async_trait]
pub trait StreamFeed: Send + Sync {
    fn feed_id(&self) -> FeedId;
    fn name(&self) -> &str;

    /// Start the feed. Sends frames on `tx`. Runs until cancelled.
    async fn run(&self, tx: broadcast::Sender<Frame>, cancel: CancellationToken);
}

/// A SnapshotFeed produces periodic state snapshots.
/// Used for git status, filesystem events, stats — where only the latest
/// value matters. Backed by `tokio::sync::watch`.
#[async_trait]
pub trait SnapshotFeed: Send + Sync {
    fn feed_id(&self) -> FeedId;
    fn name(&self) -> &str;

    /// Start the feed. Writes latest state to `tx`. Runs until cancelled.
    async fn run(&self, tx: watch::Sender<Frame>, cancel: CancellationToken);
}
```

The terminal tugfeed implements `StreamFeed`. The filesystem, git, and stats tugfeeds implement `SnapshotFeed`.

### 5.7 Feed Router

The feed router is the central multiplexer inside tugcast. It holds:
- One `broadcast::Sender<Frame>` for stream feeds (terminal output)
- One `watch::Sender<Frame>` per snapshot feed (fs, git, stats)
- One `mpsc::Sender<Frame>` for inbound frames (terminal input, control commands)

When a WebSocket connection is established, the router:
1. Subscribes to the broadcast channel for the terminal stream feed
2. Subscribes to each watch channel for snapshot feeds
3. Spawns a per-client select loop that forwards frames from all feeds to the WebSocket, respecting the client's state machine (BOOTSTRAP -> LIVE for the terminal stream)
4. Spawns a reader loop that demultiplexes incoming WebSocket frames and dispatches to the appropriate inbound sender

## 6. WebSocket Protocol

### 6.1 Frame Format

All WebSocket messages are **binary frames** with a minimal header:

```
┌──────────┬──────────┬─────────────────┐
│ FeedId   │ Length   │ Payload         │
│ (1 byte) │ (4 bytes)│ (variable)      │
│          │ big-end. │                 │
└──────────┴──────────┴─────────────────┘
```

### 6.2 Feed IDs

| ID | TugFeed | Direction | Payload |
|----|---------|-----------|---------|
| `0x00` | Terminal output | tugcast -> tugdeck | Raw bytes (ANSI) |
| `0x01` | Terminal input | tugdeck -> tugcast | Raw bytes (keystrokes) |
| `0x02` | Terminal resize | tugdeck -> tugcast | JSON `{"cols": N, "rows": N}` |
| `0x10` | Filesystem events | tugcast -> tugdeck | JSON array of FsEvent |
| `0x20` | Git status | tugcast -> tugdeck | JSON GitStatus snapshot |
| `0x30` | Stats | tugcast -> tugdeck | JSON map of collector outputs |
| `0xFE` | Control | Bidirectional | JSON control messages |
| `0xFF` | Heartbeat | Bidirectional | Empty (keepalive) |

### 6.3 Invariants

- **Terminal: bounded broadcast.** Terminal output frames (0x00) are sent immediately. tugcast reads PTY output in small chunks (1-4KB) and forwards without accumulation. Latency target: <5ms from PTY read to WebSocket send. The broadcast channel holds 4096 messages; slow clients that fall behind receive `Lagged` and transition to BOOTSTRAP for a capture-pane resync.
- **JSON feeds: latest-value semantics.** Filesystem (0x10), git (0x20), and stats (0x30) feeds use `watch` channels (snapshot feeds). Slow clients always see the latest state, never a growing backlog.
- **Heartbeat.** Both sides send heartbeat frames every 15 seconds. If no heartbeat is received within 45 seconds, the connection is considered dead and is torn down.
- **Ordering.** Within a feed, frames are ordered. Across feeds, no ordering guarantee (but in practice they share a single WS connection, so they're serialized).
- **Input: pass-through.** All keyboard input including Ctrl-C, Ctrl-D, Escape is forwarded as raw bytes. tugdeck is a terminal, not a sandbox.

## 7. tugdeck: Frontend UI

### 7.1 Build Toolchain

- **esbuild** for bundling TypeScript -> JS (fast, zero-config, no webpack/vite overhead)
- **Vanilla TypeScript** — no React, no Svelte, no framework. DOM manipulation via thin helpers.
- tugdeck assets are embedded into the tugcast binary at compile time, so the shipped artifact is a single executable with no external files.

### 7.2 The Deck Layout

A CSS Grid dashboard with four tugcards. Default layout:

```
┌────────────────────────────────────────┐
│                 Toolbar                │
├────────────────────────┬───────────────┤
│                        │ Git TugCard   │
│  Terminal TugCard      ├───────────────┤
│  (xterm.js)            │ Files TugCard │
│                        ├───────────────┤
│                        │ Stats TugCard │
├────────────────────────┴───────────────┤
│                Status Bar              │
└────────────────────────────────────────┘
```

Tugcards are resizable via drag handles (CSS `resize` + pointer events). Tugcards can be collapsed/expanded. Layout state is persisted in `localStorage`.

### 7.3 The TugCard Interface

Every tugcard implements a common interface in TypeScript:

```typescript
interface TugCard {
    /** Unique identifier matching a FeedId (or set of FeedIds). */
    feedIds: number[];

    /** Create the DOM element for this card. */
    mount(container: HTMLElement): void;

    /** Called when a frame arrives on a subscribed feed. */
    onFrame(feedId: number, payload: Uint8Array): void;

    /** Called when the card is resized. */
    onResize(width: number, height: number): void;

    /** Tear down the card. */
    destroy(): void;
}
```

The deck manager (`deck.ts`) owns the grid layout, creates card containers, and dispatches incoming frames to the appropriate tugcard based on feed ID.

### 7.4 Terminal TugCard

Uses xterm.js with addons:
- `@xterm/addon-fit` — auto-resize to container
- `@xterm/addon-webgl` — GPU-accelerated rendering (falls back to canvas)
- `@xterm/addon-web-links` — clickable URLs

The terminal tugcard:
1. Subscribes to feed 0x00 (terminal output)
2. Registers `terminal.onData(data => send(0x01, data))` for keystrokes
3. Registers `terminal.onResize(({cols, rows}) => send(0x02, ...))` for resize
4. On receiving feed 0x00 frames, calls `terminal.write(payload)`

Escape key handling: xterm.js captures all keyboard events including Escape. `terminal.onData` fires with `\x1b` for a bare Escape press. This is forwarded as-is to the PTY via feed 0x01. No special handling needed — the byte arrives at Claude Code exactly as it would in a real terminal.

### 7.5 Git TugCard

Renders the `GitStatus` JSON from feed 0x20:
- Branch name + ahead/behind badges
- Staged files (green)
- Unstaged modifications (yellow)
- Untracked files (grey)

Updated reactively on each new snapshot.

### 7.6 Files TugCard

Renders filesystem events from feed 0x10:
- Scrolling log of recent create/modify/delete events
- Optional tree view of the project directory (populated on demand via control feed)

### 7.7 Stats TugCard

Renders JSON from feed 0x30 as key-value cards. Each stat collector gets a sub-card with its name, current value, and a sparkline if the value is numeric and historical data is retained client-side.

## 8. Security

### 8.1 Bind Address

tugcast binds exclusively to `127.0.0.1`. There is no configuration option to bind to `0.0.0.0`. If remote access is ever needed, it must go through an external tunnel (SSH, Tailscale, etc.) that the user sets up themselves.

### 8.2 Auth Token (Single-Use Bootstrap)

On startup, tugcast generates a cryptographically random 32-byte token (hex-encoded, 64 characters). The token is printed to stdout alongside the URL:

```
tugcast: http://127.0.0.1:7890/auth?token=a3f8...c912
```

The token is used exactly once:
1. User opens the URL. `GET /auth?token=<T>` validates the token.
2. tugcast sets an `HttpOnly; SameSite=Strict; Path=/` session cookie and **invalidates the token** (it cannot be reused).
3. tugcast responds with `302 /`, stripping the token from the URL.
4. All subsequent requests (HTTP and WebSocket upgrade) authenticate via the session cookie only.

The redirect minimizes token persistence in browser history and logs, though browser/proxy behavior varies. Regardless, the token is invalidated after first use, so any residual copies are inert. The session cookie has a configurable TTL (default: 24 hours).

### 8.3 Origin Check

The WebSocket upgrade handler rejects requests where the `Origin` header is not `http://127.0.0.1:<port>` or `http://localhost:<port>`. This prevents cross-origin WebSocket hijacking from malicious websites.

### 8.4 Threat Model

tugcast's security posture is designed for a **single-user local development workstation**. The threat surface is:

- **Remote network attacks**: Fully mitigated. Binds to 127.0.0.1 only.
- **Browser-based CSRF/hijacking**: Mitigated by origin check + SameSite cookie.
- **Malicious local processes**: A local process that can read stdout (to steal the token) or connect to localhost already has full access to the user's files, tmux sessions, and shell. The single-use token minimizes the theft window. This residual risk is accepted as inherent to the local development use case.
- **Shared-user machines**: Explicitly out of scope for v1. Multi-user isolation would require per-user auth, which is not warranted for the target use case.

## 9. Session Lifecycle

### 9.1 Startup Sequence

```
1. Parse CLI args (--session <name>, --dir <path>, --port <port>)
2. Ensure tmux is installed (check `tmux -V`)
3. Create or find tmux session:
   a. If --session given and session exists -> attach to it
   b. If --session given and doesn't exist -> create it, launch `claude` inside
   c. If no --session -> create session with auto-generated name, launch `claude`
4. Spawn PTY running `tmux attach-session -t <name>`
5. Start filesystem tugfeed on --dir (default: cwd)
6. Start git tugfeed
7. Start stats tugfeed
8. Generate auth token
9. Start axum server on 127.0.0.1:<port>
10. Print URL + token to stdout
11. Optionally open browser (`open` on macOS)
```

### 9.2 Shutdown

On SIGINT/SIGTERM:
1. Close all WebSocket connections (send Close frame)
2. Drop the PTY writer (sends EOF to tmux attach, which detaches — it does *not* kill the tmux session)
3. Stop all tugfeeds
4. Exit cleanly

The tmux session survives. The user can re-launch tugcast and reattach.

### 9.3 Reconnection

If the WebSocket drops (browser tab closed, network blip on localhost — unlikely but possible):
- tugdeck shows a "Disconnected" banner and attempts reconnection every 2 seconds
- On reconnect, the per-client state machine enters BOOTSTRAP:
  1. tugcast runs `tmux capture-pane -p -e` and sends the snapshot
  2. Live PTY output is buffered for this client during BOOTSTRAP
  3. After snapshot delivery, buffered output is flushed and client transitions to LIVE
- Target: visible screen state restored within 500ms
- Snapshot feeds (git, fs, stats) use watch channels, so latest state is delivered immediately on reconnect

## 10. Key Dependencies

### tugcast (Rust)

| Crate | Version | Purpose |
|-------|---------|---------|
| `axum` | 0.8.x | HTTP server + WebSocket |
| `tokio` | 1.x | Async runtime |
| `pty-process` | 0.5.x | Async PTY management (native tokio AsyncRead/AsyncWrite) |
| `notify` | 8.2.x | Filesystem watching (FSEvents on macOS) |
| `serde` / `serde_json` | 1.x | Serialization |
| `rand` | 0.8.x | Auth token generation |
| `tower-http` | 0.6.x | Static file serving |
| `rust-embed` | 8.x | Embed tugdeck assets in binary |
| `tracing` | 0.1.x | Structured logging |
| `clap` | 4.x | CLI argument parsing |
| `ignore` | 0.4.x | .gitignore-aware path filtering |
| `tokio-util` | 0.7.x | CancellationToken for feed lifecycle |

### tugdeck (TypeScript)

| Package | Purpose |
|---------|---------|
| `@xterm/xterm` | Terminal emulator widget |
| `@xterm/addon-fit` | Auto-resize terminal to container |
| `@xterm/addon-webgl` | GPU-accelerated rendering |
| `@xterm/addon-web-links` | Clickable URLs in terminal |
| `esbuild` | Bundler (dev dependency only) |

Total tugdeck dependencies: 5 packages. No framework. No runtime dependencies beyond xterm.js.

## 11. Build and Distribution

### Build

```bash
# Build tugdeck (fast — esbuild takes <100ms)
cd tugdeck && npx esbuild src/main.ts --bundle --outfile=dist/app.js --minify

# Build tugcast (embeds tugdeck assets)
cargo build --release
```

The resulting binary is a single static executable called `tugcast`. No Node runtime required at execution time. No external asset files. tugdeck is embedded inside tugcast.

### Run

```bash
# Launch with a new Claude Code session
tugcast --dir /path/to/project

# Attach to an existing tmux session
tugcast --session my-claude --dir /path/to/project

# Custom port
tugcast --port 8080 --dir /path/to/project
```

## 12. Phased Implementation Plan

### Phase 1: Terminal Bridge

**Deliverable:** tugcast binary that attaches to a tmux session and renders it in tugdeck via xterm.js. One tugfeed, one tugcard. End-to-end proof that the "no drift" architecture works.

**Crates:**
- `tugcast-core` — Frame type, FeedId enum, StreamFeed/SnapshotFeed traits
- `tugcast` — main binary with axum server, cookie auth, terminal tugfeed only

**tugdeck:**
- `connection.ts` — WebSocket connect/reconnect with cookie session
- `protocol.ts` — Frame parse/serialize
- `deck.ts` — Single-card layout (terminal fills the viewport)
- `cards/terminal-card.ts` — xterm.js terminal tugcard

**Scope:**
- axum server serving embedded tugdeck assets
- Terminal tugfeed: PTY bridge spawning `tmux attach`
- WebSocket with feed IDs 0x00, 0x01, 0x02
- Auth token generation + origin check
- xterm.js with `@xterm/addon-fit`
- Basic single-card layout

### Phase 2: Multi-Card Deck

**Deliverable:** Dashboard layout with filesystem and git tugcards. Three new tugfeeds, three new tugcards, resizable grid layout.

**Crates (additions):**
- `tugcast-core` — Add FsEvent, GitStatus types
- `tugcast` — Add filesystem and git tugfeeds, feed registry

**tugdeck (additions):**
- `deck.ts` — CSS Grid with resizable panels, collapse/expand
- `cards/files-card.ts` — Filesystem event log tugcard
- `cards/git-card.ts` — Git status tugcard
- `styles/deck.css` + `styles/cards.css`

**Scope:**
- CSS Grid layout with four tugcard slots
- Filesystem tugfeed (0x10) via `notify`
- Git tugfeed (0x20) via `git` CLI
- tugdeck rendering JSON data in files and git tugcards
- Heartbeat mechanism (0xFF)
- Drag-handle resize between tugcards

### Phase 3: Stats, Polish, Resilience

**Deliverable:** Production-quality tool with extensible stats, reconnection, and full visual polish.

**Crates (additions):**
- `tugcast-core` — StatCollector trait, StatSnapshot type
- `tugcast` — Stats tugfeed with pluggable collectors

**tugdeck (additions):**
- `cards/stats-card.ts` — Stats display tugcard with sparklines
- `connection.ts` — Reconnection with "Disconnected" banner
- Layout persistence in `localStorage`

**Scope:**
- Stats tugfeed framework + built-in collectors
- Reconnection handling in tugdeck
- Tugcard collapse/expand and layout persistence
- WebGL renderer for terminal tugcard
- CLI polish (--help, --version, clean error messages)
- Thorough error handling throughout

## 13. Architecture Decisions (Resolved)

Decisions made during design review, February 2026.

### AD-1: Reconnect State Bootstrap

**Decision:** Per-client `BOOTSTRAP -> LIVE` state machine with `tmux capture-pane` snapshot.

On new connection or reconnect, the client enters BOOTSTRAP state. tugcast runs `tmux capture-pane -t <session> -p -e` and sends the result as the first terminal frame. The `-e` flag preserves ANSI escape sequences so xterm.js can render colors and formatting. During BOOTSTRAP, live PTY output is buffered (not dropped) for this client; after the snapshot is delivered, the buffer is flushed and the client transitions to LIVE. This ordering prevents duplicate or out-of-order rendering during active output. Target: screen restored within 500ms.

### AD-2: Multi-Client Input and Resize

**Decision:** Native tmux multiplexing. No custom arbitration.

- **Input:** All attached clients (real terminal + tugdeck) can send keystrokes simultaneously. tmux multiplexes them natively, same as multiple `tmux attach` sessions. No writer-lease or locking.
- **Resize:** tmux's built-in "smallest client wins" policy applies. tugdeck sends its dimensions on connect and on window resize, exactly as any tmux client does. The user's real terminal and tugdeck negotiate size through tmux, not through tugcast.
- **Observe-only mode:** Deferred to Phase 3. Not a v1 requirement.

### AD-3: Auth and Session Hardening

**Decision:** Single-use token exchange with HttpOnly cookie.

The startup token is used exactly once at `GET /auth?token=<T>`. This endpoint validates the token, sets an `HttpOnly; SameSite=Strict` session cookie, invalidates the token permanently, and redirects to `/`. All subsequent authentication (HTTP and WebSocket upgrade) uses the cookie only. The redirect minimizes token persistence in browser history; regardless of browser/proxy behavior, the invalidated token is inert. See Section 8.2 for details.

### AD-4: Backpressure Strategy

**Decision:** Two feed types — `StreamFeed` (broadcast) for terminal, `SnapshotFeed` (watch) for JSON feeds.

- **Terminal (StreamFeed):** tokio `broadcast` with 4096-message capacity. Each message is one PTY read chunk (1-4KB). Slow clients receive `Lagged` and transition to BOOTSTRAP for a capture-pane resync.
- **JSON feeds (SnapshotFeed):** tokio `watch` channels. Only the latest value is held; slow clients skip intermediate states and always see current state. No unbounded queue growth.

The `StreamFeed` and `SnapshotFeed` traits in `tugcast-core` formalize this distinction. The feed router handles both types.

### AD-5: Repo Scope and Product Boundary

**Decision:** Same workspace, separate binary, independent release.

`tugcast` and `tugcast-core` live in `crates/` alongside `tugtool` and `tugtool-core`. No cross-dependency between the two products. Independent version numbers and release cadence. They share workspace configuration and CI but are separate binaries with separate concerns.

### AD-6: Platform Target

**Decision:** macOS and Linux for v1. No Windows.

Both platforms support tmux, PTY, and all selected crates (`pty-process`, `notify`). tmux 3.x is the minimum supported version.

### AD-7: Keyboard Pass-Through

**Decision:** All keys pass through. No gating.

tugdeck is a terminal emulator, not a sandbox. Ctrl-C, Ctrl-D, Ctrl-Z, Escape, and all other keys are forwarded as raw bytes without confirmation or filtering. This matches every terminal emulator in existence.

## 14. Open Questions

1. **Multiple tmux panes.** Should tugcast support casting multiple tmux panes (e.g., Claude Code in one, a build watcher in another)? Architecturally straightforward (multiple terminal tugfeeds), but adds tugdeck UI complexity.
2. **Frontend build integration.** Should the tugdeck build be driven by `build.rs` (cargo invokes esbuild) or kept as a separate `make` step? The `build.rs` approach is more seamless but adds a build-time dependency on Node/npx.
3. **git2 vs CLI.** `git2` (libgit2) is faster but adds a non-trivial native dependency. Shelling out to `git` is simpler and handles all edge cases. Recommendation: start with CLI, switch to `git2` if latency matters.

## 15. Phase 1 Acceptance Criteria

- Keystroke latency: < 10ms end-to-end (key press to PTY write)
- Output latency: < 10ms (PTY read to xterm.js render)
- Reconnect: visible screen state restored within 500ms via capture-pane
- Zero input loss under normal single-client operation
- Escape key arrives identically to native terminal (`\x1b`, no reinterpretation)
- Auth: single-use token exchange, cookie-based session, origin check
- Works with tmux 3.x on macOS and Linux

## 16. Prior Art and Landscape

Research conducted February 2026. Key existing projects:

| Project | Stars | Stack | Approach |
|---------|-------|-------|----------|
| siteboon/claudecodeui | 6,258 | Node/JS | Full-featured web UI with file explorer, chat, terminal |
| sugyan/claude-code-webui | 911 | TypeScript/Deno | Claude Agent SDK for structured output |
| dzhng/claude-agent-server | 514 | TypeScript | WebSocket wrapper around Agent SDK |
| vultuk/claude-code-web | 28 | Node/JS | PTY passthrough via node-pty + xterm.js |

All are Node/JS-based. None use tmux for shared-session semantics. None provide a multi-feed dashboard with filesystem/git/stats panels. The PTY passthrough model (used by vultuk and siteboon) validates the core technical approach; tugcast adopts it with a Rust backend and tmux as the session multiplexer.

---

*tugcast produces tugfeeds. tugdeck renders tugcards. tmux is the single source of truth.*
