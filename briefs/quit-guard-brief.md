# Quit guard

**Purpose:** ⌘Q and Quit Tug end the app immediately, stopping any session that is mid-turn, with no chance to change your mind. Quitting while sessions are active should ask first.

---

## Purpose {#purpose}

The ask: a *quit guard* on the Tug app, "where ⌘Q or selecting from the file menu will offer an app-wide modal to confirm quitting *if there are active sessions*", with a mechanism "very similar to how we handle File > Log Out...".

Today a quit runs straight through to the termination pipeline, which interrupts every live turn. Nothing asks first, so one stray ⌘Q stops all the work in flight.

---

## Evidence {#evidence}

All findings were read out of the code at `c377949c3`. None was reproduced in the running app.

**[F01] Quit is wired directly to AppKit.** The menu item's action is `NSApplication.terminate(_:)` (`tugapp/Sources/MenuBarBuilder.swift:216`), and `quit-application` is `routing: "native"` with the ⌘Q chord in `tugdeck/src/components/tugways/command-registry.ts`. The responder chain steps aside for native commands (`responder-chain-provider.tsx:742`), so the deck never hears about a quit. **(verified)**

**[F02] Log Out is the pattern to follow.** `logOut(_:)` sends a `logout` control frame (`tugapp/Sources/AppDelegate.swift:1104`). `action-dispatch.ts:612` calls `requestLogout()`, which bumps a nonce in `tugdeck/src/lib/logout-store.ts`. `TugLogout` (`tugdeck/src/components/tugways/tug-logout.tsx`), a renderless deck-root sibling of `ConfigureTug`, watches the nonce and shows a `TugAlert`. The shell's alerts are drawn by the overlay page (`overlay.alert`). **(verified)**

**[F03] Log Out's control frame is fire-and-forget.** The host sends the frame and hears nothing back. If the page is dead or hung, nothing happens, which Log Out can tolerate and a quit cannot. `AppDelegate.swift:669-675` states the quit's rule: "A quit may be slow; it may never hang." **(verified)**

**[F04] The termination pipeline already stops turns.** `applicationShouldTerminate` freezes the window and calls `prepareForTermination` in the shell and every body under a 12 s deadline, and that call interrupts live turns (`AppDelegate.swift:677-765`, `tugdeck/src/teardown.ts`). A confirmed quit needs no interrupt step of its own. **(verified)**

**[F05] `liveTurnsStore` already answers "which sessions are active".** `tugdeck/src/lib/live-turns-store.ts` publishes a count and titles, republishes as turns start and end, and folds in body cards through `bodilessFactsStore.canInterrupt`. The update wizard's *Stop work in flight* row reads it, and it crosses to the overlay as `overlay.liveTurns`. `canInterrupt` is true in `submitting`, `awaiting_first_token`, `streaming`, `tool_work`, `awaiting_approval` and `waking` (`tugdeck/src/lib/code-session-store.ts:760`). **(verified)**

**[F06] Many quit paths never touch the menu item.** They reach `applicationShouldTerminate` by another door:

- `tugtool host instance quit`, a `quit` Apple Event used by every `just` recipe through `tugrust/scripts/quit-tug-bundle.sh`
- Sparkle's relaunch, whose wizard has its own warning
- system logout and restart
- the harness's `quitGracefully`, used by 29 app-test files
- the exit-73 path in `ProcessManager.swift:1096`

**(verified)**

**[F07] Dock ▸ Quit and the app switcher's Q also skip the menu item.** This is general macOS behaviour: they send the `quit` Apple Event, the same event as `tugtool host instance quit`. Not confirmed in Tug; an app-test or a manual quit from the Dock would confirm it.

**[F08] `$` commands and background jobs are not in `canInterrupt`.** Running shell commands are tracked in `tugdeck/src/lib/shell-session-store.ts`, and background jobs in `code-session-store/select-jobs.ts`. Neither feeds the phases in [F05]. **(verified)**

**[F09] `TugLogout`'s interrupt loop probably misses body cards.** It reads `cardServicesStore.getServices(card.id)` in the shell (`tug-logout.tsx:67-72`), while `live-turns-store.ts` says a body card's session lives in its body and takes a different route to it. `configure-tug-request.tsx:50` has the same shape. This is inference from reading the code; a logout with a body card mid-turn would confirm it.

**[F10] Menu items can be disabled before the frontend is ready.** `tugapp/Sources/MenuState.swift` documents an `.empty` cache before `frontendReady`, and `validateMenuItem` (`AppDelegate.swift:2037`) reads it. A registry-routed item is subject to this validation in a way the native Quit may not be. The exact arm that would answer for Quit was not read.

---

## Decisions {#decisions}

**[B01] The guard sits at the menu item, not in `applicationShouldTerminate`.** The menu item's action changes to a new `MenuBarActions.quit(_:)`, and a confirmed quit calls the existing `NSApp.terminate(nil)`. Everything in [F06] stays as it is, with no bypass flag and no need to classify who is asking. A guard inside `applicationShouldTerminate` would stall `just` recipes, system logout and 29 app-test files on a dialog nobody can answer.

**[B02] "Active" means a turn in flight, as `liveTurnsStore` reports it.** It is the existing definition, it already handles bodies, and the store that acts on a quit uses the same `canInterrupt`, so the guard cannot disagree with what the quit actually stops ([F05]). "Any bound session" was rejected in Non-goals.

**[B03] The host bounds the question, and an unanswered question means quit.** The host asks the shell through a page call (declared like `prepareForTerminationCall`), which answers at once whether it will ask the user. No answer within about a second, a failed call, or no page at all means `NSApp.terminate(nil)`. The answer is not the alert's outcome, so the deadline never races a person reading a dialog. This is the one real departure from Log Out, required by [F03].

**[B04] The UI follows Log Out.** A renderless `TugQuitGuard` mounts as a deck-root sibling of `TugLogout`, driven by a nonce store like `logout-store.ts`, and shows a `TugAlert` through the overlay with `confirmRole: "danger"`. `quit-application` moves to registry routing, and `command-routing-drift.test.ts` follows.

**[B05] The guard only asks; it interrupts nothing.** Turns keep running while the alert is up, so Cancel costs nothing. On confirm, the termination pipeline does the interrupting ([F04]). `TugLogout`'s interrupt loop is not copied ([F09]).

**[B06] The alert dismisses itself and the quit proceeds if the work ends while it is up.** The user already asked to quit, and nothing is left to protect. A new turn starting after that does not reopen anything.

**[B07] A second ⌘Q while the alert is up does nothing.** No stacked alert. Return confirms the alert anyway.

**[B08] Quit is always enabled.** Whatever `MenuState` says before `frontendReady` or while a wizard holds the app, the Quit item stays enabled, so a launch stall can still be quit ([F10], [B03]). The registry move must not make Quit depend on the deck being up.

**[B09] The copy.**

- Title: "Quit Tug?"
- One session: "'{title}' is still working. Quitting will stop it."
- Several: "3 sessions are still working: {titles}. Quitting will stop them."
- Buttons: Quit / Cancel

**[B10] Dock ▸ Quit and the app switcher stay unguarded.** Telling them apart from `tugtool host instance quit` ([F07]) would mean reading the Apple Event's sender pid, which isn't worth it for what the ask named. This also leaves a way out if the alert ever fails to draw.

**[B11] Coverage: unit tests for the logic, one app-test for the real path.** Unit tests cover the decision (no turns, one, several, and turns ending while the alert is up) and the copy. A new `@covers` app-test sends ⌘Q natively with a turn in flight and checks that the alert appears, Cancel leaves the app running with the turn going, Quit exits, and ⌘Q with nothing active exits with no alert. The host's deadline in [B03] gets a test of its own.

---

## Non-goals {#non-goals}

- **Guarding on any bound session.** Restored cards all hold bindings, so nearly every quit would prompt, and a guard that always fires teaches people to press Return through it.
- **Guarding `$` commands and background jobs.** The termination pipeline doesn't wait on them today either ([F08]). This is the natural next step if "active" should widen, and it is a change to what `liveTurnsStore` means, not to this guard.
- **Fixing `TugLogout`'s interrupt loop.** [F09] is a suspected separate defect and needs its own confirmation.
- **A native `NSAlert`.** The ask was for a mechanism like Log Out's, and the app's modals are `TugAlert`.
- **A preference to turn the guard off, or a "don't ask again" checkbox.** Nobody asked for one.

---

## Exit {#exit}

An arc. The natural order is:

1. The page's half: the nonce store, `TugQuitGuard`, the copy, and the page call answered from `liveTurnsStore`, with unit tests.
2. The host's half: `MenuBarActions.quit(_:)`, the bounded page call, `quitConfirmed` to the host, and Quit always enabled.
3. The registry move for `quit-application` and the drift test, landing with the host change so ⌘Q is never left routed to nothing.
4. The app-test over the real path.
