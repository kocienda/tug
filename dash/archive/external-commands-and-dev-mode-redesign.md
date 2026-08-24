# External Commands and Dev Mode: Redesign

## What Went Wrong

The tugtell implementation mixed three fundamentally different concerns into
one system, and the interactions between them created cascading failures.

### Concern 1: External Commands (show-card, focus-card, close-card)

These are stateless, fire-and-forget UI actions. "Show the About card."
"Focus the terminal." The tell endpoint, Control frame broadcast, and
action-dispatch registry are the right architecture for this. The data flow
is clean:

```
tell() HTTP POST → tugcast → 0xC0 broadcast → WebSocket → action-dispatch → DeckManager
```

**This part works.** The bugs here are wiring bugs, not architectural bugs.

### Concern 2: Server Lifecycle (restart, reset, reload_frontend)

These are server-side operations that terminate or reconfigure the process.
They already worked via Control frames from the dock. The tell endpoint
provides an HTTP front door for the same operations.

**This part also works.**

### Concern 3: Dev Mode and Settings

This is where everything broke. Dev mode is not a command. It is
configuration state that spans three layers:

| Layer | What it owns |
|-------|-------------|
| Mac app (UserDefaults) | The preference: is dev mode on or off? |
| tugcast (CLI args) | The runtime behavior: serve from disk or from embedded assets |
| tugdeck (Settings card) | The UI: checkbox, source tree path display |

Changing dev mode requires synchronizing all three layers. The
implementation tried to do this through the external command system (Control
frames + WKScriptMessageHandler bridge), and the result was:

1. Settings card sends `set-dev-mode` Control frame to tugcast
2. Tugcast broadcasts it back to all clients (including the sender)
3. Action-dispatch calls `webkit.messageHandlers.setDevMode.postMessage()`
4. Swift `bridgeSetDevMode` saves preference, then calls
   `processManager.stop()` + `processManager.start()`
5. Stopping kills tugcast (WebSocket drops, SSE drops, server gone)
6. Starting spawns new tugcast with new `--dev` flag
7. New tugcast prints new auth URL
8. `onAuthURL` fires `window.loadURL(newURL)` — **page navigates away**
9. All JavaScript state destroyed. Settings card gone. Bridge callbacks gone.

The WebView navigating to a new page is the kill shot. Everything
downstream of step 8 is broken: the Settings card content vanishes, the
bridge callbacks are wiped, the rollback timer fires into a dead page, and
on the new page the Settings card isn't in the default layout.

The attempted fix (localStorage flag to reopen Settings after restart) added
more moving parts to an already fragile chain. The real problem is that
**toggling a checkbox triggers a full server restart and page navigation**.
That is the wrong architecture.

## Why the WKScriptMessageHandler Bridge Is Fragile

The bridge (`window.__tugBridge`) is a JavaScript-to-Swift communication
channel that relies on:

1. The WebView page having registered the bridge callbacks
2. The Swift side calling `evaluateJavaScript()` with string interpolation
3. The JavaScript context surviving long enough to receive the callback

All three assumptions break during a dev mode toggle:

- After `window.loadURL()`, the old page's JavaScript context is destroyed
- The new page hasn't registered bridge callbacks yet
- The `evaluateJavaScript()` call from `bridgeSetDevMode`'s completion
  handler fires into a dead or transitioning page

The bridge is also one-way asynchronous with no error handling. If the
JavaScript callback doesn't exist, the `evaluateJavaScript` call silently
fails. There are no timeouts, no retries, no acknowledgments.

## Redesign

### Principle: Separate Commands from Configuration

**Commands** are instantaneous, stateless actions: "show this card", "close
that card", "restart the server". They flow through tell/Control
frames/action-dispatch. Fire-and-forget is fine because there's nothing to
synchronize.

**Configuration** is persistent state that must be consistent across layers:
"is dev mode on?", "where is the source tree?", "which theme?". It needs a
different mechanism — one that doesn't involve restarting the server or
navigating the page as a side effect of changing a checkbox.

### Part 1: External Commands (Keep, Fix Wiring)

The tell → tugcast → broadcast → action-dispatch pipeline is correct. The
bugs are wiring issues:

**Problem**: Mac menu "About" and "Settings" don't show cards.
**Root cause**: The tell() HTTP POST may fail silently if the server hasn't
fully started, if the port is wrong, or if the broadcast channel has no
subscribers yet. There's no feedback path.
**Fix**: Add logging/diagnostics. Verify the tell → broadcast → dispatch
chain end-to-end. The architecture is sound; the implementation needs
hardening.

**Problem**: Cards restored from persisted layout have empty bodies.
**Root cause**: DeckManager persists layout to localStorage including cards
like Settings and About. On reload, the layout is restored but only the 5
default cards (conversation, terminal, git, files, stats) get card instances
created. Non-default cards have CardFrame headers but no mounted content.
**Fix**: Already implemented — render() now auto-creates cards from
factories for persisted tabs. This is a correct fix at the right layer.

### Part 2: Dev Mode Toggle (Redesign)

**Current**: Toggling dev mode synchronously restarts tugcast, which
destroys the WebSocket connection, navigates the WebView, and wipes all
JavaScript state.

**Redesigned**: Toggling dev mode saves the preference and displays a
message. The restart happens on the user's terms, not as a side effect of
clicking a checkbox.

#### Option A: Deferred Restart (Recommended)

The simplest and most reliable approach:

1. User toggles dev mode checkbox in Settings card
2. Settings card sends `set-dev-mode` Control frame
3. Action-dispatch handler calls `webkit.messageHandlers.setDevMode`
4. Swift `bridgeSetDevMode` saves the preference to UserDefaults and
   updates the Developer menu visibility — **but does NOT restart**
5. Swift calls completion callback confirming the change
6. Settings card shows a note: "Dev mode change takes effect on next
   restart. Restart now?" with a button.
7. If user clicks "Restart now", send a `restart` control frame (which
   goes through the normal restart path: tugcast exits 42, ProcessManager
   restarts it)
8. If user doesn't click, the change takes effect next time the app
   launches or the server restarts for any reason

**Why this is better:**

- No surprise page navigation. The checkbox does what checkboxes do: it
  saves a preference.
- The restart is explicit and expected. The user clicks "Restart now" and
  understands the consequence.
- The WKScriptMessageHandler bridge is used only for preference read/write,
  not for triggering process lifecycle changes. The bridge becomes simpler
  and more reliable.
- The Settings card stays mounted. No localStorage hacks needed.

**Implementation changes:**

In `AppDelegate.swift` `bridgeSetDevMode`:
```swift
func bridgeSetDevMode(enabled: Bool, completion: @escaping (Bool) -> Void) {
    self.devModeEnabled = enabled
    self.updateDeveloperMenuVisibility()
    self.savePreferences()
    // DO NOT restart processManager here
    completion(enabled)
}
```

In `settings-card.ts`, after receiving `onDevModeChanged` confirmation:
```typescript
bridge.onDevModeChanged = (confirmed: boolean) => {
    // Update checkbox state
    this.devModeCheckbox.checked = confirmed;
    // Show restart prompt
    this.showDevNote("Dev mode change takes effect on next restart.");
    this.showRestartButton();
};
```

The "Restart now" button sends:
```typescript
this.connection.sendControlFrame("restart");
```

This uses the existing restart infrastructure. ProcessManager's supervisor
loop handles exit code 42 and restarts tugcast with the new dev mode
preference (read from UserDefaults on startup).

#### Option B: Hot-Swap Serving Mode (Future)

The ideal long-term solution: tugcast switches between embedded and dev
serving without restarting. This requires:

1. A runtime signal (e.g., SIGUSR1 or a Control frame action) that tells
   tugcast to reload its serving configuration
2. The dev.rs module supports being enabled/disabled at runtime
3. The file watcher and SSE reload endpoint are created/destroyed on demand
4. Asset routes are swapped between embedded (rust-embed) and dev
   (manifest-based disk serving)

This is significantly more complex and not needed immediately. Option A
solves the user-facing problem. Option B is an optimization for the future.

### Part 3: Source Tree Selection (Simplify Bridge Usage)

The source tree picker uses `NSOpenPanel`, which requires native code.
This is one of the few legitimate uses of the WKScriptMessageHandler
bridge. It should stay, but the bridge interaction should be simplified:

1. Settings card button click → `webkit.messageHandlers.chooseSourceTree`
2. Swift shows NSOpenPanel as a sheet
3. If user selects a valid directory, Swift saves to UserDefaults and calls
   completion with the path
4. Settings card updates the display

**No restart needed** for source tree changes. Tugcast already receives the
source tree via `--dir` on startup. If the source tree changes, it takes
effect on next restart (same deferred model as dev mode).

If dev mode is currently on and the source tree changes, the Settings card
can show: "Source tree changed. Restart to use new source tree." with the
same restart button.

### Part 4: Theme Selection (Client-Only, No Bridge)

Theme selection is purely client-side. It uses localStorage and CSS classes.
No bridge, no server communication, no restart. This already works
correctly and should stay as-is.

### Part 5: Dev Hot Reload Debounce (Already Fixed)

The poll-based debounce in `dev.rs` has been replaced with a proper
quiet-period debounce using `tokio::sync::mpsc::unbounded_channel`. This
fix is correct and independent of the other issues:

- Zero-CPU idle: suspends on `recv().await` instead of polling
- Quiet-period: fires 100ms after the *last* file event, not 300ms after
  the first
- Natural adaptation: the quiet period resets on each new event, so it
  waits for bun's build to finish regardless of how long it takes

## Architecture Summary

```
                    ┌─────────────────────────────────────┐
                    │           COMMANDS                    │
                    │  (stateless, fire-and-forget)         │
                    │                                       │
  Mac menu ────►  tell() HTTP POST ──► tugcast             │
  CLI tool ────►  tell() HTTP POST ──► classifies action   │
                    │                    │                   │
                    │    server-only     │   client-only     │
                    │    (restart,       │   (show-card,     │
                    │     reset,         │    focus-card,    │
                    │     reload)        │    close-card)    │
                    │       │            │       │           │
                    │    tugcast         │    broadcast      │
                    │    handles         │    0xC0 frame     │
                    │    locally         │       │           │
                    │                    │       ▼           │
                    │                    │  action-dispatch  │
  Dock ──────────►  dispatchAction() ──►│  (tugdeck)        │
                    │  (local, no HTTP)  │       │           │
                    │                    │    DeckManager    │
                    └─────────────────────────────────────┘

                    ┌─────────────────────────────────────┐
                    │         CONFIGURATION                 │
                    │  (persistent state, deferred apply)   │
                    │                                       │
                    │  Dev mode:                            │
                    │    Settings card ──► bridge ──►       │
                    │    AppDelegate saves UserDefaults     │
                    │    Shows "restart to apply" note      │
                    │    User explicitly restarts if wanted │
                    │                                       │
                    │  Source tree:                         │
                    │    Settings card ──► bridge ──►       │
                    │    AppDelegate shows NSOpenPanel      │
                    │    Saves to UserDefaults              │
                    │    "Restart to apply" if dev mode on  │
                    │                                       │
                    │  Theme:                               │
                    │    Settings card ──► localStorage     │
                    │    Immediate, no restart needed        │
                    └─────────────────────────────────────┘
```

## What Needs to Change

### Immediate (Fix Current Bugs)

| Change | File | Description |
|--------|------|-------------|
| Remove processManager restart from bridgeSetDevMode | AppDelegate.swift | Save preference only. Do not call stop()/start(). |
| Add restart prompt to Settings card | settings-card.ts | Show "restart to apply" message and restart button after dev mode change. |
| Remove localStorage reopen hack | settings-card.ts, main.ts | The `td-reopen-settings` mechanism is no longer needed if the page doesn't navigate. |
| Verify tell → dispatch chain | End-to-end | Debug why Mac menu About/Settings don't show cards. May be a timing issue with serverPort or broadcast subscription. |

### Follow-Up (Harden)

| Change | File | Description |
|--------|------|-------------|
| Same deferred model for source tree | AppDelegate.swift, settings-card.ts | Source tree changes saved to UserDefaults, take effect on restart. |
| Read initial dev mode state on page load | settings-card.ts | Request settings from bridge on mount, not on action-dispatch callback. |
| Audit bridge error paths | MainWindow.swift | Add null checks to evaluateJavaScript calls. Log failures. |

### Not Needed (Remove)

| What | Why |
|------|-----|
| `td-reopen-settings` localStorage flag | Page no longer navigates on dev mode toggle. |
| Rollback timer in handleDevModeToggle | Bridge confirms immediately since it no longer restarts. |
| Auto-create cards from factories in render() | Still useful for general robustness, but no longer the band-aid for the dev-mode-destroys-page bug. Keep it as a defensive measure. |
