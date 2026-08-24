# Quit Hardening — Brief

**Status:** brief, pre-devise. Written 2026-07-27, after app self-update via Sparkle landed on main (`1128c1fe4`).

## The two promises

This work exists to make two guarantees absolute, in an app that can now decide to quit itself.

1. **In-flight typing is never lost.** Composer text survives every termination — ⌘Q, Maker ▸ Reload, log out, restart, a Sparkle update swap, and the paths where macOS does not ask first. "Sometimes lost on reload or relaunch" is a standing bug; the fix must be complete, not narrowed.
2. **A running session is never rug-pulled.** A live turn is interrupted *explicitly*, through the interrupt protocol that already exists, and the interrupt is *awaited* — before any process teardown. The app never quits around a session that is mid-flight.

## Why now

Until self-update shipped, every termination was something the user asked for. Sparkle makes the app an initiator: it downloads an update and terminates the running app to swap the bundle underneath itself. That converts a latent data-loss window into one that fires on a schedule the user did not choose. The same reasoning applies to the open consent defect [Q02] in `dash/self-update.md` — an app that replaces itself unasked and an app that discards typing unasked are the same failure wearing different clothes.

## What is already right

Devise should build on this machinery, not replace it.

- **[L23] is the governing law** — internal implementation operations must never lose, destroy, or cease to apply user-visible state. [L26] is its React-reconciliation complement. The doctrine is settled; the gap is enforcement at process exit.
- **The save pipeline pulls live state rather than trusting a cache.** `DeckManager.saveAndFlushSync()` walks every registered card save callback and *then* flushes dirty state synchronously. `TugPromptEntry`'s `onSave` calls `editor.captureState()` on the live substrate, falling back to `lastKnownDraftRef` only when there is no substrate mounted. On a graceful quit the final keystroke genuinely is captured.
- **Termination already defers.** `AppDelegate.applicationShouldTerminate` returns `.terminateLater`, freezes the WebView under a snapshot overlay so teardown artifacts never paint, runs `window.tugdeck.saveState()`, and only replies once the completion handler fires.
- **An interrupt protocol exists and works.** `control_request_cancel` / `turn_cancelled` on the tugcode wire, with `interruptInFlight` state tracked in `code-session-store.ts`, plus the cancel escalation ladder added during wedge-recovery hardening. The user-facing stop gesture drives it today.

## Findings

Each of these was read on `main` at the commit above.

### F1 — Sudden termination is never disabled

`disableSuddenTermination` does not appear anywhere in `tugapp/Sources/`. macOS is therefore permitted to kill Tug outright without calling `applicationShouldTerminate`, which means no `saveState`, no flush, and no interrupt. This is sufficient on its own to explain intermittent typing loss, and it explains why the loss is *intermittent*: whether the OS takes the fast path is not something the app currently influences. Any termination-path hardening that does not close this is decorative.

### F2 — Nothing interrupts the session before teardown

`applicationShouldTerminate` runs `saveState` → `cleanupBridge()` → `ProcessManager.shutdown()`. `shutdown()` calls `stop()`, which sends a UDS `shutdown` message, waits up to 5 seconds for tugcast to exit, then issues `kill(-pgid, SIGTERM)`, sleeps 200 ms, and issues `kill(-pgid, SIGKILL)`. At no point is a live turn told to stop. The interrupt protocol from the previous section is never invoked on this path — the session is killed with its process group. The 200 ms window between SIGTERM and SIGKILL is too short for a clean interrupt even if one were sent.

### F3 — Teardown leaves residue

After the update-and-relaunch cycle exercised during self-update verification, a `tmux` server belonging to the superseded instance was still running and had to be killed by hand. That observation followed a `pkill` rather than a graceful quit, so it is not proof of a graceful-path leak — but it is exactly the residue F2 predicts, and it is the concern Risk R01 in `dash/self-update.md` was raised against. Worth confirming or clearing deliberately rather than by anecdote.

### F4 — There are four flush entry points and several initiators

`DeckManager` exposes `captureAllForTeardown`, `saveAndFlushSync`, `saveAndFlush`, and `prepareForReload`, with differing semantics around the layout save timer, the `stateFlushed` lock, and the suspend gate. `saveAndFlushSync` — the one quit uses — does not clear the pending layout save timer, while `captureAllForTeardown` does. Meanwhile the initiators are ⌘Q, Maker ▸ Reload, log out, OS logout/restart, and now Sparkle, each reaching teardown by its own route. The fragmentation is the risk surface: a guarantee that must hold *always* cannot be spread across four functions that each hold part of it.

### F5 — The durability floor is a debounce

Between the 250 ms dirty-marking debounce and the 250 ms card-state flush debounce, the worst-case edit-to-durable window is roughly half a second, and the layout save debounce is 500 ms. The code comment naming this window is explicit that it is what a crash or force-quit can lose. That is an acceptable floor only if every termination runs the graceful path — which F1 says is not guaranteed.

## Levers available

- **`ProcessInfo.disableSuddenTermination()` / `enableSuddenTermination()`**, held for as long as there is uncommitted composer text or a live turn.
- **`applicationShouldTerminate` returning `.terminateLater`**, already in use, which is what buys time for an awaited interrupt.
- **`SPUUpdaterDelegate.updater(_:shouldPostponeRelaunchForUpdate:untilInvokingBlock:)`** — confirmed present in Sparkle 2.9.4's headers. This is the hook that lets Tug hold the update relaunch until its own teardown reports done, making an update-driven quit no more dangerous than ⌘Q.
- **The existing interrupt protocol and its acknowledgment** (`turn_cancelled`), which gives termination something concrete to await rather than a fixed sleep.
- **`NSWorkspace` power-off / log-out notifications**, for the paths that do not route through the app menu.

## Shape under consideration

One termination pipeline that every initiator funnels into, with ordered and awaited phases: quiesce input and hold sudden termination off → capture and flush durable state → explicitly interrupt live sessions and wait for acknowledgment → tear down processes, with SIGKILL reserved for a real timeout rather than a 200 ms formality. Beneath that, a durability floor tight enough that even an unhookable kill loses nothing meaningful. Devise should treat this as a starting hypothesis, not a settled design.

## Constraints

- Warnings are errors; the Rust workspace enforces `-D warnings`.
- No `localStorage` / `sessionStorage` / `IndexedDB` — durable web state goes through tugbank `/api/defaults/<domain>/<key>`.
- Quit must stay fast enough to feel instant when there is nothing to interrupt and nothing dirty; the hardening must not turn every ⌘Q into a visible wait.
- App-tests are selective and derived from `@covers`; changes under `tugapp/Sources/` sit beneath every test and will trip the sweep advisory.
- HMR must never reload data or transcript; Maker ▸ Reload is a true hard refresh that re-resumes from JSONL. Any unified teardown path must preserve that distinction.

## Open questions for devise

- Does the graceful path actually leak `tmux` servers and other children, or was F3 an artifact of `pkill`? Needs a deliberate test before designing around it.
- What is the right bound on waiting for an interrupt to acknowledge, and what does the UI show while waiting — a quit that hangs on a wedged session is its own failure mode. The wedge-recovery escalation ladder is the precedent.
- Should the durability floor become a synchronous write on blur / visibility change / `pagehide`, or simply a much tighter debounce? The former is stronger; the latter is cheaper and less invasive.
- Do the four flush entry points collapse into one, or does each keep a distinct role behind a single guaranteed-ordering front door?
- Is queued-but-unsent composer text distinct from in-flight typing for these purposes, and does an interrupted turn's partial output need preserving too?
- Does this work subsume [Q02], or does [Q02] get fixed first as a prerequisite?

## How we would know it is fixed

- Typing in the composer survives every termination initiator, including one that does not route through `applicationShouldTerminate`.
- A live turn is observably interrupted and acknowledged before any process is signalled, verified from logs rather than by inspection.
- No orphaned children survive a graceful quit or an update relaunch.
- A Sparkle update swap is indistinguishable from ⌘Q in what it preserves.
- Quit with nothing dirty and nothing running stays as fast as it is today.

## Out of scope

- The self-update feature itself, beyond the relaunch-postpone integration and the [Q02] consent defect.
- Crash recovery and transcript reconstruction — this brief is about *known* transitions, which is what [L23] governs.
- Any redesign of the composer or the session card beyond what durability requires.
