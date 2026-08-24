# Tugtell: External Command Interface for Tugdeck

## Problem

Tug.app's About box and Settings window are native macOS panels
(`NSApp.orderFrontStandardAboutPanel`, `SettingsWindow.swift`). They should be
tugcards inside tugdeck — consistent with everything else in the UI. But there's
no mechanism for the Mac app's menu bar to tell tugdeck "show the About card."

The current menu actions (Reload Frontend, Restart Server, Reset Everything) work
through process-level hacks: the Mac app kills tugcast and respawns it, or
reloads the WebView. These are blunt instruments. The dock's settings menu in
tugdeck already does it better — it sends Control frames (0xC0) over the
WebSocket to tugcast, which handles restart/reset/reload cleanly. But the Mac
app's native menus can't use that path because they live outside the WebView.

The deeper problem: there is no general mechanism for external software to
trigger UI actions inside tugdeck. The Mac app's menu bar is just the first
example. Scripts, CLI tools, other applications — anything that wants to say
"hey tugdeck, show this card" or "navigate to that panel" — has no way in.

## Current State

### What works

The Control feed (0xC0) is fully implemented and operational:

```
tugdeck (dock.ts)
  → sendControlFrame("restart")      // 0xC0 frame via WebSocket
  → tugcast router.rs                 // parses action, sends shutdown code
  → tugcast exits with code 42
  → ProcessManager detects exit code
  → ProcessManager restarts tugcast
```

Three actions are handled: `restart` (exit 42), `reset` (exit 43),
`reload_frontend` (broadcast to SSE reload channel).

Client-side infrastructure exists:
- `protocol.ts`: `controlFrame(action)` helper builds 0xC0 frames
- `connection.ts`: `sendControlFrame(action)` sends them
- `deck-manager.ts`: `sendControlFrame(action)` delegates to connection

### What's missing

1. **No external ingress.** The only way to send a Control frame is from
   JavaScript inside the WebView. The Mac app, CLI tools, and other processes
   have no entry point.

2. **Control frames are one-way.** They flow tugdeck → tugcast only. There is
   no path for tugcast → tugdeck. Tugdeck never receives Control frames — it
   only sends them.

3. **No action dispatch in tugdeck.** Even if Control frames arrived, tugdeck
   has no dispatcher to route them to handlers. Cards subscribe to feed
   callbacks for data feeds (conversation, terminal, etc.), but nobody listens
   on the Control feed.

## Key Insight

We don't need a new protocol, a new binary, or a new IPC mechanism. The
Control feed is the right channel. It just needs to work in both directions
and have an HTTP front door.

```
External process                        tugdeck
     │                                     │
     │  POST /api/tell                     │
     │  {"action":"show-card",             │
     │   "component":"about"}              │
     ▼                                     │
  tugcast ──── 0xC0 frame ────────────────►│
  (HTTP endpoint)  (WebSocket broadcast)   │
                                           ▼
                                    Action Dispatcher
                                    → DeckManager.addNewCard("about")
```

The same path works for the Mac app, a CLI command, a script, or any process
that can make an HTTP request to localhost.

## Design

### Layer 1: HTTP Control Endpoint (tugcast)

New route on the tugcast HTTP server:

```
POST /api/tell
Content-Type: application/json

{"action": "show-card", "component": "about"}
```

Response: `200 OK` with `{"status": "ok"}` or `400` with error details.

Auth: Same localhost-only model as existing endpoints. The `/api/tell`
endpoint is only reachable from `127.0.0.1` — same security boundary as the
WebSocket.

Implementation: The handler receives JSON, wraps it as a 0xC0 Control frame,
and broadcasts it to all connected WebSocket clients via the existing broadcast
channel. Server-level actions (`restart`, `reset`, `reload_frontend`) are also
recognized and handled locally, same as when they arrive via WebSocket.

### Layer 2: Control Frame Broadcast (tugcast router)

Currently, router.rs only receives Control frames from clients and handles
them server-side. Two additions:

1. **Outbound broadcast**: When a Control frame arrives via HTTP (or WebSocket
   with a client-action), broadcast it to all connected WebSocket clients as a
   0xC0 frame. This is the reverse direction.

2. **Action classification**: Simple convention distinguishes server actions
   from client actions:

   | Action | Handler | Description |
   |--------|---------|-------------|
   | `restart` | tugcast | Exit code 42, process restart |
   | `reset` | tugcast | Exit code 43, full reset |
   | `reload_frontend` | tugcast | SSE broadcast to dev reload |
   | Everything else | broadcast | Forward to all WebSocket clients |

   Server actions are handled locally AND NOT broadcast (they cause tugcast
   to exit, so broadcasting is pointless). Client actions are broadcast to
   all connected WebSocket clients.

### Layer 3: Action Dispatcher (tugdeck)

New module in tugdeck that registers a callback on the Control feed and
routes actions to handlers.

```typescript
// action-dispatch.ts

type ActionHandler = (params: Record<string, unknown>) => void;

const handlers = new Map<string, ActionHandler>();

export function registerAction(action: string, handler: ActionHandler): void {
    handlers.set(action, handler);
}

export function dispatchAction(payload: { action: string } & Record<string, unknown>): void {
    const handler = handlers.get(payload.action);
    if (handler) {
        handler(payload);
    }
}
```

DeckManager wires this up during initialization:
- Registers a callback for `FeedId.CONTROL` on the connection
- Incoming 0xC0 frames are parsed and passed to `dispatchAction()`
- Registers built-in action handlers (see below)

### Layer 4: Built-in Actions

Actions registered by DeckManager and cards at startup:

| Action | Params | Behavior |
|--------|--------|----------|
| `show-card` | `component: string` | Create card if none exists, or focus existing. Toggle: if the target card is already focused, close it instead. |
| `focus-card` | `component: string` | Focus existing card of type, no-op if none |
| `close-card` | `component: string` | Close card of type, no-op if none |
| `navigate` | `target: string` | App-level navigation (future) |

The `show-card` action with toggle behavior means a menu item like "About"
works naturally: first press opens it, second press closes it. Same pattern
as toggling a panel.

### Layer 5: Mac App Integration

The Mac app already captures the tugcast auth URL
(`http://127.0.0.1:7890/auth?token=...`). It knows the host and port. To send
a command:

```swift
// In AppDelegate.swift or a small TugTell helper

func tell(_ action: String, params: [String: Any] = [:]) {
    guard let port = processManager.serverPort else { return }
    var body = params
    body["action"] = action

    var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/tell")!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: body)

    URLSession.shared.dataTask(with: request).resume()
}
```

Menu items become one-liners:

```swift
@objc func showAbout(_ sender: Any?)      { tell("show-card", params: ["component": "about"]) }
@objc func showSettings(_ sender: Any?)   { tell("show-card", params: ["component": "settings"]) }
@objc func reloadFrontend(_ sender: Any?) { tell("reload_frontend") }
@objc func restartServer(_ sender: Any?)  { tell("restart") }
@objc func resetEverything(_ sender: Any?){ tell("reset") }
```

The native `SettingsWindow.swift` and `NSApp.orderFrontStandardAboutPanel`
calls are removed entirely. The `tell()` helper replaces them.

Note: `tell()` is fire-and-forget. If tugcast isn't running (server not
started yet, crashed, etc.), the POST silently fails. That's correct — if
there's no server, there's no UI to show the card in. The Mac app's process
lifecycle management handles that case (restart, error display, etc.).

### Optional: CLI Convenience

A thin CLI wrapper for the HTTP endpoint:

```bash
tugcode tell show-card --component about
tugcode tell restart
```

This is just `curl` with nicer syntax. Low priority — the HTTP endpoint is
the real interface. But it's useful for scripting and debugging.

## About Card and Settings Card

These are the first two consumers of the tugtell system. They are standard
tugcards registered with the card factory.

### About Card

Component ID: `"about"`
Feed subscriptions: none (static content)

Displays:
- App name and icon
- Version (read from tugcast's `/api/version` endpoint or embedded in page)
- Build info
- Copyright
- Credits/attribution

This is a simple card with no live data feeds. It renders static HTML. The
card's `meta` has `closable: true` so it can be dismissed.

### Settings Card

Component ID: `"settings"`
Feed subscriptions: none (reads/writes localStorage and sends Control frames)

Displays:
- Theme selector (already exists in dock settings menu — consolidate here)
- Developer mode toggle
- Source tree path display + choose button

Settings persistence: localStorage for client-side preferences (theme),
Control frames to tugcast for server-side changes (dev mode, source tree).

The dev mode toggle sends a Control frame that tugcast handles by restarting
with or without `--dev`. The source tree chooser may need a file picker,
which could use the Mac app's native `NSOpenPanel` via a reverse
communication path (tugdeck → tugcast → Mac app), or could be a simple text
input initially.

## Dock Integration

The dock already has a settings gear menu with theme selection, control
actions, and an About entry. These currently use inline handlers and
JavaScript alerts. Update them to use `tell()`:

- "About" → `dispatchAction({action: "show-card", component: "about"})`
- Control actions remain as `sendControlFrame()` (they go to tugcast)
- Theme selection could stay in the dock menu as a quick-access shortcut
  even after the Settings card exists

The dock icon buttons (conversation, terminal, git, files, stats) could also
use the action dispatch system internally, but this is optional cleanup —
they already work via `DeckManager.addNewCard()` directly.

## Migration: Removing Native About and Settings

### Files to delete

| File | What it contains |
|------|-----------------|
| `tugapp/Sources/SettingsWindow.swift` | Native NSWindow with dev mode toggle and source tree picker |

### Files to modify

| File | Changes |
|------|---------|
| `tugapp/Sources/AppDelegate.swift` | Remove `orderFrontStandardAboutPanel`. Remove `SettingsWindowController` property and lazy init. Replace menu action methods with `tell()` calls. Remove `settingsWindow` import. Add `tell()` helper method. Extract server port from auth URL. |
| `tugdeck/src/dock.ts` | Update About menu item to use action dispatch instead of JS alert. |
| `tugdeck/src/deck-manager.ts` | Register Control feed callback. Wire action dispatcher. Register `about` and `settings` card factories. |
| `tugdeck/src/connection.ts` | Add callback registration for receiving Control frames (may already be possible via existing feed callback mechanism). |
| `tugcode/crates/tugcast/src/server.rs` | Add `POST /api/tell` route. |
| `tugcode/crates/tugcast/src/router.rs` | Add outbound Control frame broadcast for client actions. |

### New files

| File | Purpose |
|------|---------|
| `tugdeck/src/action-dispatch.ts` | Action registry and dispatcher |
| `tugdeck/src/cards/about-card.ts` | About card implementation |
| `tugdeck/src/cards/settings-card.ts` | Settings card implementation |

## Data Flow Summary

```
Mac App Menu "About Tug"
  → AppDelegate.tell("show-card", component: "about")
  → POST http://127.0.0.1:7890/api/tell
  → tugcast /api/tell handler
  → classifies as client action (not restart/reset/reload)
  → broadcasts 0xC0 frame to all WebSocket clients
  → tugdeck connection.ts receives 0xC0 frame
  → action-dispatch.ts routes to "show-card" handler
  → DeckManager creates/focuses AboutCard
  → User sees About card in tugdeck

CLI/Script:
  → curl -X POST http://127.0.0.1:7890/api/tell \
      -d '{"action":"show-card","component":"settings"}'
  → (same path from tugcast onward)

Dock Settings Menu "About":
  → dispatchAction({action: "show-card", component: "about"})
  → (dispatches locally, no HTTP round-trip needed)
```

Three entry points, one dispatch system, same result.

## What This Does Not Cover

- **Bidirectional settings sync**: Settings card → tugcast is covered (Control
  frames). Tugcast → Settings card (e.g., confirming dev mode activated) would
  need a response mechanism. For now, the Settings card can poll or optimistically
  update.
- **Authentication for /api/tell**: Localhost-only is sufficient for now. If
  tugcast ever binds to a non-loopback address, the endpoint needs auth.
- **Action namespacing**: All actions share a flat namespace. If this grows
  unwieldy, add prefixes (`card.show`, `server.restart`). Not needed yet.
- **File picker for source tree**: The native NSOpenPanel is the best UX for
  folder selection on macOS. The Settings card may need a hybrid approach
  (trigger native picker from tugdeck, receive result back). This is a
  contained sub-problem that can be solved when the Settings card is built.
