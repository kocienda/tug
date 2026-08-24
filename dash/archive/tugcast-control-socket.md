# tugcast Control Socket

## The Problem

The Mac app and tugcast communicate through two fragile channels:

**Channel 1: stdout line parsing.** Tugcast prints a line to stdout
containing the auth URL. ProcessManager reads stdout through a pipe,
applies a regex, extracts the URL, and fires a callback that navigates
the WebView. This is the only way the Mac app learns the auth URL.

**Channel 2: exit codes.** Tugcast exits with code 42 (restart) or 43
(reset). ProcessManager's supervisor loop reads the exit code and
decides what to do. This is the only way tugcast signals intent back
to the Mac app.

Both channels are wrong.

### Why stdout parsing breaks

The auth URL is printed at `main.rs:74`, before the HTTP server binds
its port. The server doesn't actually listen until `main.rs:244` (inside
`run_server` -> `TcpListener::bind`), ~170 lines later. Between print and
bind: channel setup, feed creation, manifest loading, file watcher
initialization, task spawning.

On initial launch, this race is usually won because the WebView has
inherent navigation latency (WKWebView initialization, DNS lookup, TCP
handshake) that gives the server enough time to bind. On restart, the
timing is tighter: the main queue was just busy dispatching the restart
callback, the WebView is already warm, and the navigation fires faster
than the server can finish its setup. The WebView requests
`http://127.0.0.1:7890/auth?token=...` and gets connection refused.

`WKNavigationDelegate.didFail` logs the error and does nothing. The old
page stays loaded with a stale session cookie. The WebSocket reconnection
logic kicks in, but every attempt fails with 403 because the new server
has new auth state and the old cookie is meaningless. Exponential backoff
grows: 2s, 4s, 8s, 16s, 30s. The user is stuck.

### Why exit codes are insufficient

Exit codes are unidirectional, carry exactly one byte of information,
and arrive only after the process is dead. The parent can't ask the
child anything. The child can't tell the parent anything except "I'm
done, here's a number." There's no way to:

- Signal readiness (port is bound, server is accepting connections)
- Pass structured data (auth URL, port, PID, error details)
- Send commands without HTTP (the Mac app uses `/api/tell` as a
  workaround, but this requires knowing the port, having a valid
  connection, and routing through the HTTP server)
- Coordinate graceful shutdown (the parent can't prepare for a restart
  before the child dies)

### Why HTTP `/api/tell` is the wrong control plane

The Mac app currently sends commands to tugcast by HTTP POST to
`/api/tell`:

```swift
func tell(_ action: String, params: [String: Any] = [:]) {
    guard let port = serverPort else { return }
    // ... build JSON, POST to http://127.0.0.1:{port}/api/tell
}
```

This works, but it's a workaround for not having proper IPC:

- Requires knowing the port (extracted from the auth URL, which came
  from stdout parsing)
- Requires the HTTP server to be running (can't send commands during
  startup or shutdown)
- Routes through the full HTTP stack (TCP connection, HTTP parsing, JSON
  deserialization) for a message between a parent and its child process
- For `restart`, the Mac app sends an HTTP request to a server asking it
  to kill itself, then the parent process detects the death through
  `waitUntilExit`, then starts a new process. The HTTP request is
  literally asking the child to commit suicide so the parent can notice.

We own both processes. They run on the same machine. We should talk to
each other like it.

## Design: Unix Domain Socket Control Channel

A Unix domain socket between the Mac app (parent) and tugcast (child)
replaces stdout parsing, exit code signaling, and local HTTP control
with a single bidirectional IPC channel.

### Architecture

```
┌──────────────────────────────┐
│         Mac App              │
│                              │
│   ProcessManager             │
│     ├── UDS listener         │  UDS: /tmp/tugcast-ctl-{port}.sock
│     │   (persistent)   ◄─────┼──────────────────────┐
│     ├── Process (child)      │                       │
│     └── onReady callback     │                       │
│                              │                       │
│   AppDelegate                │                       │
│     └── sendControl()  ──────┼───┐                   │
│         (replaces tell())    │   │                    │
└──────────────────────────────┘   │                    │
                                   │                    │
                               ┌───▼────────────────────┴──┐
                               │         tugcast            │
                               │                            │
                               │   UDS client connection    │
                               │     ├── receives commands  │
                               │     └── sends events       │
                               │                            │
                               │   HTTP server (:7890)      │
                               │     ├── /auth              │
                               │     ├── /ws                │
                               │     └── /api/tell          │
                               │         (kept for external │
                               │          tools / CLI)      │
                               └────────────────────────────┘
```

### Socket Lifecycle

**Parent listens, child connects.** The Mac app creates the UDS
listener before spawning the child process and passes the socket path
as a CLI argument. The child connects to the socket during startup.

This ordering is critical: the parent is always ready to accept a
connection before the child exists. No polling, no waiting, no race.

The listener persists across child restarts. When tugcast exits and the
Mac app spawns a new instance, the new child connects to the same
listener. The Mac app doesn't need to recreate the socket.

```
Parent                          Child (v1)            Child (v2)
  │                                │
  ├── create UDS listener          │
  ├── spawn child ─────────────────►
  │                                ├── connect to UDS
  │◄─── accept ───────────────────┤
  │                                ├── setup feeds, bind port
  │◄─── {"type":"ready"} ────────┤
  ├── loadURL(auth_url)            │
  │         ...                    │
  ├── {"type":"tell","action":     │
  │    "restart"} ────────────────►│
  │◄─── {"type":"shutdown"} ──────┤
  │                                ├── exit
  │                                │
  ├── spawn child ─────────────────────────────────────►
  │                                                     ├── connect to UDS
  │◄─── accept ───────────────────────────────────────┤
  │                                                     ├── setup, bind port
  │◄─── {"type":"ready"} ──────────────────────────────┤
  ├── loadURL(auth_url)                                 │
```

**Socket path:** `$TMPDIR/tugcast-ctl-{port}.sock`. Deterministic,
predictable, scoped to the user. The parent deletes any stale socket
file before creating the listener (standard Unix socket cleanup).

**CLI argument:** `tugcast --control-socket /path/to/socket`

### Protocol

Newline-delimited JSON over the Unix domain socket. One JSON object per
line, terminated by `\n`. The message rate is very low (a handful per
server lifetime), so efficiency is irrelevant. Debuggability matters:
you can `socat` into the socket and read plaintext JSON.

#### Child-to-parent messages

**`ready`** — Server is bound and accepting connections.

Sent AFTER `TcpListener::bind` succeeds, AFTER all feeds are started,
AFTER the server is fully operational. This is the "server ready" signal
that eliminates the auth URL race condition.

```json
{"type":"ready","auth_url":"http://127.0.0.1:7890/auth?token=abc...","port":7890}
```

**`shutdown`** — Server is shutting down.

Sent before the process exits. Includes the reason so the parent can
decide how to respond (restart, show error, etc.) without interpreting
exit codes.

```json
{"type":"shutdown","reason":"restart"}
{"type":"shutdown","reason":"reset"}
{"type":"shutdown","reason":"error","message":"failed to bind port"}
```

#### Parent-to-child messages

**`tell`** — Trigger an action.

Same semantics as HTTP POST `/api/tell`, but over the socket. No HTTP
overhead, no port discovery, no session cookie, works during startup.

```json
{"type":"tell","action":"show-card","component":"about"}
{"type":"tell","action":"restart"}
{"type":"tell","action":"reload_frontend"}
```

**`shutdown`** — Request graceful shutdown.

Replaces `process.terminate()` (SIGTERM). The child can clean up,
send a `shutdown` response, and exit on its own terms.

```json
{"type":"shutdown"}
```

### Startup Flow (Fixed)

Current (broken):
```
1. tugcast starts
2. Prints auth URL to stdout          ← BEFORE server binds port
3. Sets up 170 lines of feeds/channels
4. Binds port, starts listening       ← AFTER auth URL was printed
5. ProcessManager reads auth URL from pipe
6. loadURL fires                      ← Server may not be listening yet
7. Connection refused (on restart)
8. User stuck in reconnection loop
```

Proposed:
```
1. Mac app creates UDS listener
2. Mac app spawns tugcast with --control-socket path
3. tugcast starts, connects to UDS
4. tugcast sets up feeds, channels, auth state
5. tugcast binds HTTP port (TcpListener::bind succeeds)
6. tugcast starts accepting connections
7. tugcast sends {"type":"ready","auth_url":"..."} over UDS
8. Mac app receives "ready"
9. Mac app loads auth URL in WebView   ← Server GUARANTEED listening
10. Auth exchange succeeds, page loads, WebSocket connects
```

Step 7 cannot happen before step 5 completes. The race condition is
structurally eliminated.

### Restart Flow (Fixed)

Current (broken):
```
1. Settings card → fetch /api/tell → {"action":"restart"}
2. tugcast tell_handler sends shutdown_tx (exit code 42)
3. tokio::select! receives shutdown, calls process::exit(42)
4. ProcessManager.waitUntilExit() → sees exit code 42
5. ProcessManager.restart() → stop() + startProcess()
6. New tugcast prints auth URL to stdout     ← BEFORE bind
7. Pipe reads auth URL → onAuthURL → loadURL ← Server not ready
8. Connection refused, stale session, exponential backoff
```

Proposed:
```
1. Settings card → sendControl() → Mac app sends UDS tell
   (OR: settings card → HTTP /api/tell → tugcast handler)
2. tugcast receives "restart" via UDS (or HTTP)
3. tugcast sends {"type":"shutdown","reason":"restart"} over UDS
4. tugcast exits
5. Mac app detects UDS disconnect + process exit
6. Mac app reads current preferences (devModeEnabled, sourceTreePath)
7. Mac app spawns new tugcast with correct --dev flag
8. New tugcast connects to UDS
9. New tugcast completes setup, binds port
10. New tugcast sends {"type":"ready","auth_url":"..."}
11. Mac app loads auth URL                    ← Server GUARANTEED ready
12. Auth exchange, page load, WebSocket connect
```

Step 6 also fixes the stale `devPath` bug: the parent reads current
preferences on every restart, not just on initial launch.

### Dev Mode Restart (Stale devPath Fix)

Current bug: `ProcessManager.start(devMode:sourceTree:)` stores
`devPath` once. `restart()` calls `startProcess()` which reuses the
stale `devPath`. If the user toggles dev mode OFF and restarts, tugcast
still launches with `--dev`.

Fix: `startProcess()` reads preferences directly:

```swift
private func startProcess() {
    let devMode = UserDefaults.standard.bool(forKey: TugConfig.keyDevModeEnabled)
    let sourceTree = UserDefaults.standard.string(forKey: TugConfig.keySourceTreePath)

    var args: [String] = ["--control-socket", controlSocketPath]
    if let dir = sourceTree {
        args += ["--dir", dir]
    }
    if devMode, let path = sourceTree {
        args += ["--dev", path]
    }
    // ...
}
```

No more `self.devPath`. No more stale state. Preferences are the source
of truth, read at process start time.

### Local Control Plane (Replacing HTTP tell)

The Mac app currently uses HTTP POST to send commands to tugcast. With
the UDS, local commands go through the socket:

```swift
// Before: HTTP round-trip
func tell(_ action: String, params: [String: Any] = [:]) {
    guard let port = serverPort else { return }
    // ... URLRequest, JSON serialization, URLSession.dataTask ...
}

// After: direct socket write
func sendControl(_ action: String, params: [String: Any] = [:]) {
    var msg: [String: Any] = ["type": "tell", "action": action]
    for (k, v) in params { msg[k] = v }
    controlSocket?.send(msg)
}
```

Benefits:
- No HTTP overhead (no TCP connection, no HTTP parsing per call)
- No port discovery (socket path is fixed, known at process start)
- Works during server startup (child connects to UDS before HTTP is up)
- Works during shutdown (can send commands until the socket closes)
- No auth needed (the UDS is between parent and child — they trust each
  other implicitly, same as the pipe was)

The HTTP `/api/tell` endpoint stays for external consumers: CLI tools,
scripts, `curl`, other processes that aren't the Mac app. The endpoint
is a convenience wrapper — it receives the HTTP request, classifies the
action, and handles it the same way as a UDS `tell` message.

### Action Classification (Unchanged)

The action classification from the tell handler stays the same:

| Action | Type | UDS handling | HTTP handling |
|--------|------|-------------|---------------|
| `restart` | server-only | Send `shutdown` response, exit | Same |
| `reset` | hybrid | Broadcast 0xC0, send `shutdown`, exit | Same |
| `reload_frontend` | hybrid | Broadcast 0xC0, fire reload_tx | Same |
| Everything else | client-only | Broadcast 0xC0 to WebSocket clients | Same |

The only difference is the ingress path. UDS and HTTP converge on the
same action handler.

### Error Handling

**Child crashes without sending `shutdown`.** The parent detects this
through two signals: the UDS connection closes (EOF on read) and
`Process.waitUntilExit()` returns. Either signal can trigger restart
logic. UDS disconnect is typically detected faster.

**Child can't connect to UDS.** Fatal error. If the child can't reach
the parent, it can't report readiness. Log an error and exit with a
non-zero code. The parent will see the process exit without ever
receiving "ready" and can show an error to the user.

**Parent's UDS listener fails.** Fatal error at app launch. If the Mac
app can't create the control socket, it can't manage the child process.
Show an alert and terminate.

**Stale socket file.** The parent deletes any existing socket file at
the path before creating the listener. This handles the case where a
previous app instance crashed without cleanup.

## Implementation

### tugcast (Rust)

**New CLI flag:**
```
--control-socket <path>    Unix domain socket path for parent IPC
```

**New module: `control.rs`**

Connects to the parent's UDS listener. Provides:
- `ControlSocket::connect(path)` — connect during startup
- `ControlSocket::send_ready(auth_url, port)` — after bind
- `ControlSocket::send_shutdown(reason)` — before exit
- `ControlSocket::recv() -> ControlMessage` — receive parent commands
- Background task: reads UDS messages, feeds them into the action
  handler (same path as HTTP tell_handler)

**Changes to `main.rs`:**

```rust
// Before:
println!("\ntugcast: {}\n", auth_url);
std::io::stdout().flush().ok();
// ... 170 lines of setup ...
let server_future = server::run_server(cli.port, ...);

// After:
let control = if let Some(ref sock_path) = cli.control_socket {
    Some(ControlSocket::connect(sock_path).await?)
} else {
    None
};
// ... setup ...
let server_future = server::run_server(cli.port, ...);
// Send ready AFTER server is created (run_server binds port internally)
// NOTE: need to restructure so bind happens before select!
if let Some(ref ctl) = control {
    ctl.send_ready(&auth_url, cli.port).await;
}
```

The restructuring needed: `run_server` currently binds the port AND
runs the server in one call. Split it so the bind happens first, "ready"
is sent, then the server runs:

```rust
let listener = TcpListener::bind(format!("127.0.0.1:{}", cli.port)).await?;
info!(port = cli.port, "tugcast server listening");

// NOW the port is bound. Signal readiness.
if let Some(ref ctl) = control {
    ctl.send_ready(&auth_url, cli.port).await;
}

// Run server on the already-bound listener
axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await;
```

**Standalone mode:** When `--control-socket` is not provided, tugcast
runs without readiness signaling. No auth URL is printed to stdout.
The auth URL appears only in tracing logs (`info!`). This mode is
for development and testing.

### ProcessManager (Swift)

**New properties:**
```swift
private var controlListener: ControlSocketListener?
private var controlConnection: ControlSocketConnection?
private let controlSocketPath: String
```

**Socket path generation:**
```swift
let controlSocketPath = NSTemporaryDirectory() + "tugcast-ctl-\(port).sock"
```

**Startup sequence:**
```swift
func start() {
    // 1. Create UDS listener (once, persists across restarts)
    if controlListener == nil {
        controlListener = ControlSocketListener(path: controlSocketPath)
        controlListener?.onConnection = { [weak self] conn in
            self?.controlConnection = conn
            conn.onMessage = { [weak self] msg in
                self?.handleControlMessage(msg)
            }
        }
    }

    // 2. Start child process with --control-socket flag
    startProcess()
}

private func handleControlMessage(_ msg: ControlMessage) {
    switch msg.type {
    case "ready":
        DispatchQueue.main.async {
            self.onReady?(msg.authURL)
        }
    case "shutdown":
        // Child is about to exit. Prepare for restart if needed.
        break
    }
}
```

**Remove:**
- `authURLPattern` regex
- `pipe.fileHandleForReading.readabilityHandler` stdout parsing
- Exit code interpretation in supervisor loop (42/43 → restart)
- `devPath` stored property (read preferences directly)

**Replace `onAuthURL` with `onReady`:**
- Same callback shape, but fires only when the server is known to be
  listening. The name change makes the contract explicit.

### AppDelegate (Swift)

**Replace `tell()` with `sendControl()`:**
```swift
private func sendControl(_ action: String, params: [String: Any] = [:]) {
    processManager.sendControl(action, params: params)
}

@objc func showAbout(_ sender: Any?) {
    sendControl("show-card", params: ["component": "about"])
}

@objc func showSettings(_ sender: Any?) {
    sendControl("show-card", params: ["component": "settings"])
}

@objc private func restartServer(_ sender: Any) {
    sendControl("restart")
}
```

**Remove `serverPort` property.** No longer needed for HTTP tell.
The UDS is the control channel.

**Update `onReady` callback (renamed from `onAuthURL`):**
```swift
processManager.onReady = { [weak self] authURL in
    self?.window.loadURL(authURL)
    self?.runtimeDevMode = self?.devModeEnabled ?? false
}
```

### Frontend (No Changes Needed)

The restart flow is handled entirely by the Mac app:

1. Server dies → WebSocket closes → frontend shows "Disconnected" banner
2. Mac app starts new server → receives "ready" → navigates to auth URL
3. Auth sets new cookie → redirect to / → fresh page load → new
   WebSocket connection

The frontend's exponential backoff reconnection logic remains useful
for transient network disruptions (laptop sleep/wake, brief network
hiccups). But for server restarts, the Mac app's auth URL navigation
takes over. The page reload clears the stale state and establishes a
fresh session.

The Settings card's "Restart Now" button can continue to use either
HTTP `/api/tell` or the WebSocket Control frame to trigger the restart.
Both paths work because they both reach tugcast's action handler, which
sends a `shutdown` message over the UDS and exits.

## What This Replaces

| Current mechanism | Replaced by | Status |
|-------------------|-------------|--------|
| stdout auth URL printing + pipe regex parsing | UDS `ready` message | Eliminated |
| Exit code 42/43 signaling | UDS `shutdown` message with reason | Eliminated |
| HTTP `/api/tell` for Mac app commands | UDS `tell` message | Replaced locally |
| `ProcessManager.devPath` stored property | Read preferences at start time | Eliminated |
| `ProcessManager.onAuthURL` callback | `ProcessManager.onReady` callback | Renamed |

## What This Keeps

| Mechanism | Why it stays |
|-----------|-------------|
| HTTP `/api/tell` endpoint | External tools (CLI, curl, scripts) still need an HTTP interface. The endpoint stays, but the Mac app no longer uses it. |
| WebSocket 0xC0 Control frames | Client-to-server actions from tugdeck (dock buttons, Settings card) still use WebSocket. The UDS is parent-to-child only. |
| Auth token + session cookie | The auth model is correct. The UDS just ensures the auth URL is loaded after the server is ready. |
| Frontend reconnection with backoff | Still needed for transient network issues. Not used for server restarts (Mac app handles those). |
| `WKScriptMessageHandler` bridge | Still needed for native UI operations (NSOpenPanel, UserDefaults). Orthogonal to process IPC. |

## What This Enables (Future)

With a bidirectional control channel in place, several capabilities
become straightforward:

**Health monitoring.** The Mac app can send periodic health checks
over the UDS. If tugcast stops responding, the Mac app knows before
the WebSocket times out.

**Structured logging.** Instead of forwarding stdout, tugcast can send
structured log messages over the UDS. The Mac app can display them in a
native log viewer or filter by severity.

**Hot configuration.** Send configuration changes over the UDS without
restarting. Dev mode hot-swap (Option B from the dev mode redesign doc)
becomes possible: `{"type":"tell","action":"set-dev-mode","enabled":true}`.

**Multiple server instances.** The socket-per-port model naturally
supports running multiple tugcast instances. Each gets its own control
socket.

**Process metrics.** The Mac app can request metrics (memory usage,
connection count, uptime) over the UDS and display them in the UI
without routing through the WebSocket.

## Implementation Order

1. **Add `--control-socket` to tugcast CLI.** No behavior change yet.
   Just accept the flag.

2. **Split `run_server` to separate bind from serve.** Return the bound
   `TcpListener` so the caller can signal readiness between bind and
   serve.

3. **Implement `control.rs` in tugcast.** Connect to UDS, send `ready`
   after bind, send `shutdown` before exit, receive and dispatch `tell`
   messages.

4. **Implement `ControlSocketListener` in ProcessManager.** Create UDS
   listener, accept connections, parse messages, fire callbacks.

5. **Wire `onReady` in AppDelegate.** Replace `onAuthURL`. Load auth
   URL only when `ready` arrives.

6. **Remove stdout parsing.** Delete the regex, the pipe
   readabilityHandler, the auth URL print. Tugcast still prints a
   human-readable startup message to stderr for debugging, but nothing
   flows through stdout for IPC.

7. **Replace `tell()` with `sendControl()` in AppDelegate.** Mac menu
   actions go through UDS instead of HTTP.

8. **Remove exit code interpretation.** ProcessManager no longer checks
   for 42/43. The `shutdown` message carries the reason. Process exit is
   just "process exited" — the reason was already communicated.

9. **Fix `devPath` stale bug.** Remove stored `devPath`. Read
   preferences in `startProcess()`.

Steps 1-5 fix the restart race condition. Steps 6-9 clean up the old
mechanisms. Each step is independently testable.
