<!-- brief-skeleton v1 -->

# UpdateTug: make Install and Relaunch work, and gate it on stopped work

**Purpose:** *Install and Relaunch* has never installed or relaunched anything, across three arcs that each found the driver correct. And the press that ends the user's work is bundled into the install button, when the user should be the one to end it. Fix the first by deleting a Sparkle delegate hook that deadlocks the install, and the second by giving the wizard a fourth row that derives from the deck.

---

## Purpose {#purpose}

In the user's words, after running `0.8.4` against a `0.8.5` appcast and reaching the *Install and relaunch* row:

- *"When I click the **Install and Relaunch** button, it actually has to install and relaunch."*
- *"We need some similarity in state management in UpdateTug that is similar to what we have in ConfigureTug."*
- *"I think it's OK to have the download work without interrupting any inflight sessions, however there should probably be an intermediate step that stops inflight work after the download completes, a state that gates the Install and Relaunch step. We shouldn't really terminate the user's work — they should do that. In other words, Install and Relaunch should not have a bundled-in 'stop all inflight sessions' implicit in it."*
- *"This would also allow us to trim down the Install and Relaunch description text to one line."*

The dead button is the defect `briefs/update-tug-brief.md` `[B09]` said to settle before building on top, and which that arc's join message reported as still unexplained. This brief settles it.

---

## Evidence {#evidence}

**[F01] The install press deadlocks between Tug and Sparkle, and the deadlock is readable in Sparkle's source** — `SPUInstallerDriver.m`, `installWithToolAndRelaunch:displayingUserInterface:`, in the Sparkle 2.9.4 checkout under DerivedData. Its first act, before opening the installer connection and before requesting any quit, is to ask the delegate `shouldPostponeRelaunchForUpdate:untilInvokingBlock:`. A `YES` returns immediately and Sparkle waits for the block, which is a re-entry into the same method. Tug's `UpdateController.swift` returns `true` and stores the block in `pendingRelaunchBlock`. The only caller of that block is `resumePostponedRelaunch()`, reached from `tearDownAndReplyToTerminate()` in `AppDelegate.swift` at the end of a quit — and the quit Sparkle would request is downstream of the block. Each side waits on the other. **(verified — read out of both sources)**

**[F02] The symptom matches exactly, and the instrument added last arc cannot see it** — the press consumes `installChoice`, so the driver's per-press line reads `held_after=none landed_in=readyToInstall`, which is what a working press also reads. Sparkle never calls `showInstallingUpdate`, so no `installing` stage follows and nothing further is logged to `tugapp.log`; the one line that says *postponing relaunch* is an `NSLog` in `UpdateController.swift` and reaches Console only. A second press finds no closure and `refuse(.install)` raises "This update is no longer active." Three arcs read the driver and found every path correct because the driver *is* correct; the defect is one delegate method. **(verified by reading; not reproduced — no instance's `tugapp.log` on this machine carries a `readyToInstall` line for the user's session, and the unified log returned nothing)**

**[F03] The race the hook was added for cannot happen** — the docblock on `shouldPostponeRelaunchForUpdate` says it exists so "the relaunched instance can't start booting while the outgoing one is still shutting down its children." Sparkle's `Autoupdate` watches the old process id with a kqueue `NOTE_EXIT` filter (`TerminationListener.m`) and installs and relaunches only after the process has exited. Tug's `applicationShouldTerminate` returns `.terminateLater`, and the process cannot exit until the deck pipeline, `processManager.shutdown()` and the reply have all run. The children are always gone before the new instance starts, with no help from the hook. **(verified)**

**[F04] Sparkle passes `displayingUserInterface: YES` for a user-chosen install** — every `finishInstallationWithResponse:` call in `SPUUIBasedUpdateDriver.m` does. Sparkle's own small installer-progress agent may therefore appear during the file copy, after the app has quit. This is Sparkle's behaviour with any user driver and is not something the wizard draws. **(verified)**

**[F05] The wizard's install button bundles an interrupt** — `installWithGate` in `update-tug.tsx` counts cards whose `codeSessionStore.canInterrupt` is true, shows a `TugAlert` confirm, interrupts each, and only then posts `install`. The row's detail is two lines, "Tug quits and reopens on the new version. Work in flight stops with it." `[B07]` of the previous brief put the gate there on purpose; the user has now said the gate belongs to a step of its own. **(verified)**

**[F06] The rows are already derived, but from one input** — `rows(state, waitingRow, stalled)` in `update-tug.tsx` is a pure function of the host snapshot, and the component is a thin render over it. What it does not read is the deck. `ConfigureTug` reads several stores and its `derive*` helpers in `macos-support.ts` are unit-tested in isolation; that is the shape the user is pointing at. **(verified)**

**[F07] Nothing subscribable answers "which sessions are mid-turn"** — the quit pipeline's `interruptLiveSessions` in `deck-manager.ts` walks `cardServicesStore.allServices()` and filters on each session's `canInterrupt` once, imperatively; `ConfigureTugRequest`, `TugLogout` and `installWithGate` each do the same walk. `cardServicesStore.subscribe` fires on card add and remove, and each `codeSessionStore` publishes its own `canInterrupt`, so an aggregate can be built from parts that exist; none exists today. **(verified)**

**[F08] The quit pipeline already owns the bounded interrupt** — `interruptLiveSessions` interrupts every live session, subscribes to each until its phase is `idle` or `errored`, and gives up after `TERMINATION_INTERRUPT_AWAIT_MS` of 5 seconds, releasing every subscription either way. It is private to `DeckManager`. **(verified)**

**[F09] `at0612` pins three rows and the no-turns install branch** — its header says so: with nothing running, *Install and Relaunch* posts `install` and asks nothing; the confirm is "deliberately not pinned here" because the app-test deck has no session mid-turn. **(verified)**

---

## Decisions {#decisions}

**[B01] Delete the postponement.** `shouldPostponeRelaunchForUpdate`, `pendingRelaunchBlock` and `resumePostponedRelaunch()` go from `UpdateController.swift`, and the call in `tearDownAndReplyToTerminate()` goes with them. Sparkle then requests the quit itself; `applicationShouldTerminate` runs the deck pipeline and the child shutdown as it does for every quit, and the relaunch waits on process exit `[F03]`. The section of `briefs/sparkle-non-modal-notes.md` that argued for the hook gets a correction rather than a deletion, so the reasoning is on record. Nothing else in the driver, the reducer or the bridge changes: the nine stages and seven actions are untouched.

**[B02] Four rows: Check, Download, Stop work in flight, Install and relaunch.** The previous brief's `[B08]` said three because the user named three; the user has now named four. Unpacking stays inside the Download row.

**[B03] The Stop-work row is derived from the deck, never latched.** Pending until `readyToInstall`. At `readyToInstall` and after: with no session mid-turn it is *done*, detail "Nothing is running." With sessions mid-turn it is *active*, its detail is the sentence `relaunchWarningLine` already builds, and its button reads **Stop Work**. Pressing it interrupts those sessions and the row is *busy* until they settle or the bound expires. Because the row reads state rather than remembering a press, a user who stops the turns in the cards themselves sees it settle with no press, and a turn started after Stop Work flips it back to active. That second property is the guarantee the user asked for, stated as a derivation: the install is never offered while a turn exists, so it can never end one.

**[B04] The Install row is pending until the Stop-work row is done, and its press posts `install` and nothing else.** `installWithGate`, the confirm alert, and the interrupt loop are deleted from the install path `[F05]`. Its detail is one line, "Tug quits and reopens on the new version." The gate has not been softened; it has moved one row up, where it is a step the user takes rather than a consequence hidden in a button.

**[B05] A `live-turns-store` supplies the deck's half.** A small store in `tugdeck/src/lib/` that subscribes to `cardServicesStore` and to each card's `codeSessionStore`, publishes a reference-stable `{ count, titles }` of cards whose `canInterrupt` is true, and enters React through `useSyncExternalStore` `[L02]`. It exists because nothing subscribable does today `[F07]`; the three imperative walks that already exist may move onto it but are not required to.

**[B06] Stop Work reuses the quit pipeline's interrupt rather than copying it.** `interruptLiveSessions` becomes a public method of `DeckManager` and the row's press calls it `[F08]`. One implementation of "interrupt and wait, bounded" is enough, and the settle test is the lifecycle owner's own `canInterrupt` and phase `[L28]`; a third copy would drift.

**[B07] The row derivation is a pure function, unit-tested, in ConfigureTug's style.** `rows()` leaves the component as `deriveUpdateRows(snapshot, liveTurns, waitingRow, stalled)` in a module beside it, with tests for every stage crossed with zero and some live turns. The component stays a thin render `[F06]`. This is the state-management similarity the user asked for: rows as a function of stores, and the function testable without a deck.

**[B08] `at0612` pins four rows and the no-turns branch; the with-turns branch is a unit test.** The app-test deck has no session mid-turn `[F09]`, so it pins that the Stop-work row reads done and the install button is present and posts `install`. That the install button is absent while a turn exists, and returns when it ends, is pinned on `deriveUpdateRows`.

**[B09] The fix is confirmed with one real press before the arc joins.** `just update-rehearse` against a local appcast, press Download, press Install and Relaunch, and read `tugapp.log` for `installing` followed by the termination verdict, then see the new version come up. `[F02]` is a reading of source rather than a reproduction, and a delegate deletion whose effect is "the app quits and comes back" is exactly the kind of thing three arcs have already verified green without ever seeing.

**[B10] The release notes catch up.** `release-notes/0.8.4.md` says Tug "names them and asks before it stops them," which describes the gate this brief removes; `0.8.5.md` says it exists only to exercise the flow. Whichever version carries this work says what actually changed: a Stop-work step, and an install that installs.

---

## Open Questions {#open-questions}

- **Does a wizard closed on the Stop-work row reopen on it with nothing remembered?** The sketch says yes, consistent with `[B04]` of the previous brief: the wizard holds no flow state, and the row re-derives on reopen. The one case this changes is a Stop Work press whose bounded wait is still running when the wizard closes; the interrupt continues, and reopening shows whatever the deck says now. That seems right, and is recorded here rather than as a decision only because nobody has watched it.

---

## Non-goals {#non-goals}

- **Keeping the postponement and invoking the block from the deck.** Considered as a way to run the Stop-work step *inside* Sparkle's hook. Rejected: the step happens before the press, on the user's gesture, so there is nothing for the hook to wait for, and a hook that stays is a hook that can deadlock again `[F01]`.

- **A row that only tells the user to go stop their work.** The stricter reading of "they should do that." Rejected as the only path, because the row derives from the deck either way `[B03]`: a user who prefers to stop turns in the cards gets the same row settling on its own, and the button is there for the rest.

- **A new stage or action on the bridge.** The Stop-work gate is deck-local. The snapshot gains nothing and the seven actions stay seven.

- **Disabling the install button while turns are live.** A disabled primary button with no explanation is a dead button by another name. The row is pending, in the same grey the screenshot already shows for a row whose turn has not come.

- **Drawing Sparkle's installer-progress agent ourselves.** `[F04]` is Sparkle's, appears after the app has quit, and is out of the wizard's reach.

---

## Exit {#exit}

**An arc.** The order that matters:

1. `[B01]` first, and alone: delete the postponement and rehearse one real install `[B09]`. Everything else in this brief is worth doing only if the button works.
2. `live-turns-store` `[B05]` and the public `interruptLiveSessions` `[B06]`.
3. `deriveUpdateRows` with the fourth row `[B02]` `[B03]` `[B04]` `[B07]`, and the deletion of `installWithGate`.
4. `at0612` and the unit tests `[B08]`.
5. The release-notes correction `[B10]` and the notes correction in `briefs/sparkle-non-modal-notes.md`.

Step 1 can be seen working before a line of the deck changes, and should be.
