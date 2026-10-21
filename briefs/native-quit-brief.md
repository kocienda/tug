<!-- brief-skeleton v1 -->

# Quitting a running Tug instance natively, with its own evidence

**Purpose:** The build recipes quit the running instance by Apple Event through `osascript`, and since 2026-10-16 the app has intermittently sat on that event for 20–146 s or never taken it. Five days were spent reconstructing what happened from logs that could not say. The quit must move under our control in Rust, and a quit that goes wrong must capture its own evidence.

---

## Purpose {#purpose}

The user's words: "I want this to be more robust and more under our direct control (in Rust) and have (or restore) the tools we need to log and debug what's going wrong when it goes off the rails. We *must not* be in the state we're in now where we are guessing about what has gone awry."

And the standing rule from the same conversation: "Send the Apple Event. Don't just send a signal." A quit is the deck's termination pipeline — interrupt live turns, persist every card, flush, then tear down tugcast. A signal to the host app skips all of it and loses whatever the deck had not saved.

---

## Evidence {#evidence}

**[F01] The Apple Event quit path worked for months and still works most of the time** — `tugcast.log` under `~/Library/Application Support/Tug/instances/release-main/Logs/` records every quit either as `Control socket: shutdown requested by parent` (the pipeline, reached only through `applicationShouldTerminate`) or as `boot::serve: SIGTERM received` (a kill). From 2026-09-12 through 2026-10-15 every day shows 1–23 pipeline quits and 0 kills (one exception: 2 kills on 10-11). 10-17 shows 0 pipeline quits and 4 kills; 10-18 shows 9 and 1. **(verified)**

**[F02] The quit script never waited for the app, from the day it was written** — `tugrust/scripts/quit-tug-bundle.sh` tested "still running" by grepping `lsappinfo info -only pid` for `"pid"=`, while that command prints `pid = N`. The test was always false, so the script sent the event, skipped the wait, and fell through to `tugtool host instance stop`, which SIGTERMs the host app. The stop ran only when `tugrust/target/debug/tugtool` existed. Fixed in `358be10dd` (`lsappinfo find bundleid=…`, and the quit is always the event). **(verified)**

**[F03] `tugrust/target/` was recreated on 2026-10-16 at 14:40, removing the debug `tugtool`** — after that the fallback had no binary, and the recipe built over the still-running instance and `open`ed the bundle, which only activated the old process. This is why the failure surfaced on 10-16, not why the app stalls. **(verified)**

**[F04] Delivery is not the problem; the app receives the event and does not dispatch it** — from the unified log (`/usr/bin/log`), `osascript` launch time against AppKit's `Handling Quit AppleEvent` line:

| sent | handled | gap |
|---|---|---|
| 10-20 15:40:42.10 | 15:40:42.21 | 0.1 s |
| 10-20 15:42:17.35 | 15:43:17.56 | 60 s |
| 10-20 17:16:40.08 | 17:16:40.19 | 0.1 s |
| 10-20 18:56:19.97 | 18:56:20.08 | 0.1 s |
| 10-20 20:07:32, 20:09:37 | never | — |
| 10-21 06:10:59.90 | 06:13:26.46 | 146 s |
| 10-18 ~06:32:40 | 06:33:00.26 | ~20 s |

Once handled, every quit completed the pipeline in 0.5–2.4 s. **(verified)**

**[F05] The gap is entirely before AppKit enters its quit handler, while the main thread keeps running** — disassembly of `-[NSApplication(NSAppleEventHandling) _handleAEQuit]` (via a scratch AppKit-linked binary under lldb) shows the `Handling Quit AppleEvent` log as its first act. During the 146 s gap the main thread logged `NSPersistentUIManager flushAllChanges` at 06:12:53 and 06:13:21. An event that arrives and is not dispatched on a running main thread means the run loop is in a mode, or a nested event loop, that does not service Apple Events. **(verified that the thread ran; the mode is inference — nothing in any log records it.)**

**[F06] Nothing in Tug's own code nests the run loop except modal alerts and `NSOpenPanel.runModal` (Maker ▸ Source Tree…)** — `grep` over `tugapp/Sources` for `runMode|runModal|nextEvent|CFRunLoopRun|beginDraggingSession|addChildWindow`. No child windows. The timing coincides with the bodies cutover (one WKWebView per card, `52714669b` 10-13 through `4ead4a0d6`), which is correlation only. **(verified for Tug's code; the WebKit side is unexamined.)**

**[F07] Our own logs could not answer the question** — the pipeline's lines (`AppDelegate: applicationShouldTerminate…`, verdicts, `replyToApplicationShouldTerminate`) are `NSLog`, which reach only the unified log, not `tugapp.log`. The unified log retains Debug-level lines (such as `osascript`'s) for roughly a day. And in this shell `log` is a function that prints nothing; `/usr/bin/log` is the real binary — two days of readings were taken off the empty output before that was noticed. **(verified)**

**[F08] A no-op Apple Event to the idle instance answers in 86 ms, and the debug instance quits in under 1 s every time** — the stalled state is intermittent and tied to the user's deck, not to the quit path. **(verified)**

**[F09] A one-shot live capture is already in the script** — uncommitted edit to `quit-tug-bundle.sh`: 3 s after the event, a 2 s `sample` of the app plus a no-op Apple Event with a 5 s timeout, written to `/tmp/tug-quit-stall-<time>/`. It is the shape of what [B03] builds in properly. **(verified: runs green against the debug instance; has not yet caught a stall.)**

---

## Decisions {#decisions}

**[B01] The quit is a native Apple Event sent from Rust: `tugtool host instance quit <instance>`.** It resolves the host app pid from the instance registry — no bundle-id lookup, no AppleScript, no `is running` round trip, so the wrong instance is impossible — and sends `'aevt'/'quit'` by `AECreateDesc(typeKernelProcessID)` → `AECreateAppleEvent` → `AESendMessage(kAEWaitReply | kAENeverInteract, timeout)` through FFI to CoreServices, the first Apple-framework link in `tugrust/`, so it gets its own macOS-only module in `tugcore` with the `extern` block and a safe wrapper. It reports numbers: the send's `OSStatus`, time to reply, time to process exit, as `--json` and as a progress line every 5 s. `-1743` is named as the terminal lacking Automation permission for Tug, with the fix in the message. [F04] says this does not cure the stall; it makes the sender exact and its failures numeric.

**[B02] The quit never signals the GUI.** If the event is not taken by the deadline, `quit` exits 1 with the capture of [B03]. `--force` is the only route to the existing `stop` ladder, for the day the user has chosen to lose the pipeline on purpose. `stop` keeps its one job: reaping a tugcast that outlived an already-exited GUI, run only after the GUI is gone. The build recipes fail loudly on a stalled quit rather than escalating; a build that quietly killed the deck is the thing [F02] was doing for months without anyone knowing.

**[B03] A stalled quit captures its own evidence before anyone has to guess.** When the reply has not arrived after 3 s, `quit` writes `instances/<id>/stalls/<timestamp>/`: a 2 s `sample` of the app, the answer of the state probe in [B05], a no-op Apple Event's result with a short timeout (all events stuck, or only the quit), the last two minutes of the app's unified-log lines via `/usr/bin/log show --predicate processID`, and a `stall.json` tying them together. It prints the path and keeps waiting to the deadline. The directory is the artifact the stall is debugged from.

**[B04] The app's quit path logs to `tugapp.log`, and every Apple Event's dispatch is logged.** The termination pipeline's lines move from `NSLog` to `TugLog` so they sit beside everything else [F07]. An `AEInstallSpecialHandler(keyPreDispatch)` hook logs each Apple Event at the moment AppKit dispatches it (class, id, sender pid) — public API, bypasses nothing — so the next stall shows exactly when the event reached dispatch.

**[B05] The main run loop's mode is observed, always, and exposed by a probe.** A `CFRunLoopObserver` on the main loop logs any stretch of 250 ms or more spent outside the default mode, naming the mode (tracking, modal panel, or custom) and `NSApp.modalWindow` if set — the state [F05] could not see. It is on in release: it logs transitions only, and costs nothing between them. A read-only `/api/host/state` beside `/api/eval` returns the current mode, the modal window, time since the last default-mode pass, Apple Events dispatched in the last minute, and the body count; the capture of [B03] and the hand tools of [B06] read it.

**[B06] The hand tools come back as recipes.** `just app-log <instance> [--last 5m] [--grep X]` wraps `/usr/bin/log show` with the right predicate so the shadowed `log` never costs a day again; `just app-sample <instance>` and `just app-state <instance>` run over the registry's pid and the probe. `just stop-release` and its siblings call `quit`; `quit-tug-bundle.sh` becomes a thin call to it, using whichever `tugtool` exists and running `cargo build -p tugtool` first when none does (as `app-release` already builds `tugbank` before the quit).

**[B07] Proof is a unit layer and one app-test under 20 s.** Rust tests cover the descriptors, the error mapping, and a send to a pid that cannot take Apple Events (a `sleep` child), asserting the numeric error and that no signal was sent. One app-test launches the harness app, runs `tugtool host instance quit`, and asserts the pre-dispatch log line, the pipeline verdict line, `quiesce-report.json`, and exit within 5 s. The live proof is the next slow quit on the user's deck producing a stall directory.

**[B08] Order: [B04]+[B05] first, then [B01]+[B03] together, then [B06] and [B07].** The observer and the log moves are small and are what make the next failure legible, whatever the sender is; the sender and its capture depend on the probe existing.

---

## Open Questions {#open-questions}

- **Why the app stops dispatching Apple Events.** [F05] establishes where the gap is and [F06] rules out Tug's own loops; what holds the run loop is unknown, and [B03]+[B05] exist to answer it from the next occurrence rather than from theory. The bodies cutover is the leading suspect by timing alone.

---

## Non-goals {#non-goals}

- **A signal as a quit.** SIGTERM to the host app skips the termination pipeline; rejected by the user in so many words, and [F02] shows what months of it looked like.
- **A longer wait as the fix.** `a4a23f341` raised the wait to 90 s; this morning's gap was 146 s and two attempts on 10-20 were never taken. The wait is a bound on patience, not a remedy.
- **Overriding AppKit's quit handler.** Installing our own `kAEQuitApplication` handler would bypass `applicationShouldTerminate` and the state-restoration bookkeeping around it; the pre-dispatch hook of [B04] observes without replacing.
- **Fixing the stall itself in this work.** Its cause is unmeasured [F05]; this work builds the instrument. The fix is the next brief, written from a stall directory.

---

## Exit {#exit}

An arc. The first steps: move the pipeline's `NSLog` lines to `TugLog` and add the pre-dispatch and run-loop observers with their log lines [B04][B05]; add `/api/host/state` [B05]; then the `tugcore` Apple Event module and `tugtool host instance quit` with its stall capture [B01][B02][B03]; then the recipes and `quit-tug-bundle.sh` [B06]; then the unit tests and the one app-test [B07]. [B04]+[B05] land first and can ship alone — they are what the next slow quit is read from, whichever sender sends it.
