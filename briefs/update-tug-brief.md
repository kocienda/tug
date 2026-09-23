<!-- brief-skeleton v1 -->

# UpdateTug: one wizard, one pill

**Purpose:** The update feature has become several pieces — a badge, an inline dialog with three sizes, a menu item that both reveals and acts — none of which is the app's wizard. Replace all of it with two things: a modeless pill whose only job is to say an update exists, and `UpdateTug`, an app-modal wizard in `ConfigureTug`'s style that walks check, download and install, and can be put down and picked up at any step.

---

## Purpose {#purpose}

In the user's words, after running the last arc and relaunching: *"We still have a ton of work to do on this feature."*

- *"I want **one** wizard dialog. One. Not two or three or random other pieces."*
- *"When the user explicitly checks for an update, we can make the update dialog app-modal, just like ConfigureTug, and we should."*
- *"The only part of this whole scheme that can and should remain modeless is the pill, and this pill has only one purpose: to tell the user that an update is available. This pill should be placed in the top-center of the deck/canvas, and must have an `x` to dismiss it."*
- *"Clicking this pill, or selecting the Tug menu item that deals with checking for or installing updates in any state should raise a full-on modal dialog in the style of ConfigureTug, and this dialog should walk the user through an update check, the update download, and the installation."*
- *"At any point of this UpdateTug dialog (which is what we should call this component), the user should be able to pause and come back later."*

This is the third reshaping of the surface. The first made it non-modal end to end; the second re-anchored it. Each fixed what it named and left the shape that was producing the complaints. This one changes the shape.

---

## Evidence {#evidence}

**[F01] What the user sees today is a badge and an inline dialog, and neither is the wizard** — `tugdeck/src/components/chrome/update-overlay.tsx` renders one component with three sizes (`hidden` / `collapsed` / `expanded`): a `TugBadge` collapsed, a `TugInlineDialog` expanded. `TugInlineDialog` is the transcript-strip permission dialog, widened by scoped tokens to 600px. It shares rows with the wizard but not its frame, its modality, or its way of being opened and closed. The "random pieces" reading is fair: the same update is a badge one moment and a strip-shaped dialog the next, and nothing about either says *wizard*. **(verified)**

**[F02] `ConfigureTug` is exactly the shape being asked for, and its machinery is reusable in parts** — `tugdeck/src/components/tugways/configure-tug.tsx` is app-modal through `TugAlert`'s chrome (a Radix `AlertDialog` portaled into the canvas overlay at z-index 99990/99991, which actually blocks the deck), carries a checklist of `TugStepRow`s each with a pulsing dot and a right-hand CTA, and has **two doors**: it opens itself when needed, and the Tug-menu *Configure Tug…* item opens it on demand through `configure-tug-request-store` — a monotonic nonce, watched by `ConfigureTugRequest`, which confirms and interrupts live turns before opening. The on-demand wizard is dismissible (Done, Escape); the required one is not. **(verified)**

**[F03] The step row is already shared** — the update-surface arc lifted the wizard's row into `tug-step-row.tsx` and both surfaces render it, with one status-to-dot mapping. So "one wizard" is nearer than the screenshots suggest: the rows already match. What differs is everything around them. **(verified)**

**[F04] `[L33]`'s second clause is the constraint this design has to answer** — *"no app-wide modal may depend on anything outside the deck."* An `UpdateTug` that waits on Sparkle's check or download waits on the host and the network, both outside the deck. The long form (`tuglaws/no-wait-without-a-horizon.md`) records that for the restore gate a *softened* modal — "one with a Cancel button, or a timeout" — was considered and rejected, because it "keeps the construction in which one card's trouble is everybody's." `ConfigureTug` lives under the same clause and complies by bounding every wait (`CONFIGURE_TUG_PROBE_DEADLINE_MS`, `SIGN_IN_TIMEOUT_MS`), naming each terminal state, and letting go of the app when it cannot make its claim. **(verified — quoted)**

**[F05] The menu item today acts as well as reveals** — `AppDelegate.checkForUpdates` calls `requestReveal()` and then `perform(menuCommand)`. In `available`, `menuCommand` is `.install`, so choosing *Update to Tug 0.8.3…* from the menu **starts the download immediately**, with no dialog in between. That is the opposite of a door onto a wizard. **(verified)**

**[F06] The raise signal already exists and is state-shaped** — `revealCount` rides the snapshot; the host bumps it from the menu item and from Sparkle's `showUpdateInFocus`; the deck acts once per new value and a replay re-reads a value it has already handled. It was built to expand the inline dialog. It can open `UpdateTug` unchanged. **(verified)**

**[F07] "Pause and come back later" already maps cleanly onto Sparkle, because the host never needed the UI** — in `TugUpdateDriver`, the `available` and `readyToInstall` closures are held indefinitely until answered; `checking` and `downloading` are cancellable and a download continues whether or not anything is drawn; `installing` is past the point of return. The deck's `hidden` size already proved the mechanism: it answers Sparkle nothing, consumes no closure, changes no host state, and the update stays exactly as live as it was. **(verified)**

**[F08] The pill narrates every stage, which is the opposite of one purpose** — `badgeLabel` returns *Checking for updates…*, *Downloading Tug 0.8.3…*, *Unpacking the update…*, *Installing…*, *Tug is up to date*, *Tug update failed*. The user's pill says one thing. **(verified)**

**[F09] Install and Relaunch ends every live turn, and the wizard already has the gate for that** — `ConfigureTugRequest` counts cards whose `codeSessionStore.canInterrupt` is true, and if any, shows a `TugAlert` confirm (*"Stop Work and Open Setup?"*) before interrupting each and opening. The update surface's mid-turn warning line is a sentence; the wizard's gate is a decision. **(verified)**

**[F10] The dead *Later* / *Install and Relaunch* report is still unsettled, and the instrument to settle it now exists** — the anchor arc found that the driver's refusal line was an `NSLog` that never reached `tugapp.log`, moved it to `TugLog`, and made a refused install raise a visible failure. One press of each button against a live update in the real app — which `0.8.3` was bumped to make possible — is the observation that has never been made. **(verified that the instrument exists; the symptom's cause is not)**

---

## Decisions {#decisions}

**[B01] One component, `UpdateTug`, a sibling of `ConfigureTug`.** It uses `TugAlert`'s app-modal chrome, `TugStepRow` for its rows, and a request store on the nonce pattern for its on-demand door. The badge, the inline dialog, the three-size model and the collapse control are deleted, not adapted. Two wizards in the app share their parts; they do not merge, because setup can be *required* and an update never is.

**[B02] The pill is the only modeless piece, and it has one sentence.** Top centre of the window on the anchor the last arc built, an `x`, and text that says an update exists — never what the flow is doing. It appears whenever an update is live and the wizard is closed; it does not appear for a check that finds nothing, and it does not appear while the wizard is open. Clicking it opens the wizard. The `x` hides it for the rest of this update's flow, answers Sparkle nothing, and the menu item still opens the wizard afterwards.

**[B03] Modality is always the user's gesture.** A scheduled check that finds something lights the pill and does nothing else; that premise of the first brief survives intact. The wizard is raised only by a pill click, the menu item, or a check the user started. So the app is never covered by something the user did not ask to see, and once they have asked, covering it is right — an update is a decision about the whole app.

**[B04] The wizard is dismissible at every step, and that is how it complies with `[L33]`.** Closing it is *pause*: the host is untouched, held closures stay held, a running download keeps running, and the pill comes back. Reopening resumes at the current stage. Every wait inside it carries Sparkle's own deadline surfaced as a named step state, so the reviewer's test — *if the thing you are waiting on never answers, what does the user see, and what can they do?* — answers "a named failed step, and Close or Retry." This is deliberately the "softened modal" the long form rejected for the restore gate, and the difference is the granularity clause: that gate staged *one card's* wait over every card. An app update is not one card's wait — there is no narrower thing that is waiting — so app-wide is its granularity, and a user exit at every step is what the law asks of it.

**[B05] The menu item raises the wizard and does nothing else.** `menuCommand` retires; the wizard holds every decision. The title keeps tracking the stage so the menu still reads as a status line, but choosing it never starts a download or an install on its own `[F05]`. It is enabled in every stage, including `idle`, where the wizard opens on its Check step.

**[B06] `revealCount` is the raise signal, unchanged.** The host bumps it exactly as today; the deck opens the wizard once per new value. A pill click is deck-local and needs no bridge traffic. The seven actions stay seven and the snapshot gains nothing.

**[B07] The turn-interrupt gate sits on *Install and Relaunch*, not on opening.** Looking at an update, checking for one, and downloading one end no turns, and the whole point of pause-and-resume is that the user can look without committing. Pressing the install CTA with turns in flight runs the same confirm-then-interrupt gate `ConfigureTugRequest` runs, with its own copy, and only then replies to Sparkle.

**[B08] Three steps: Check, Download, Install and relaunch.** Unpacking is the Download row's detail phase rather than a fourth row; the user named three things. `upToDate` and `error` are terminal states of whichever row was waiting — a green check with *Tug is up to date* and a Done button, or a failed row with Retry — and are not separate notices. Progress stays words on the row's detail line, written from the store without a render.

**[B09] Settle the dead buttons before building on top of them.** One session against `0.8.3`: press *Later*, press *Install and Relaunch*, read `tugapp.log`. The rewrite must not carry an unexplained defect across — a wizard whose install button does nothing is worse than a strip whose install button does nothing, because it promises more.

**[B10] `at0612` is rewritten against the wizard, and the surface is still driven from the bridge alone.** Snapshots in through `onUpdateState`, actions read back from the `updateAction` recorder, no Sparkle and no network. What it newly pins: a scheduled find opens nothing; a pill click opens the wizard; close-then-reopen lands on the same step; the menu-raise via `revealCount` opens in every stage.

---

## Open Questions {#open-questions}

- **Does the pill get a second sentence at `readyToInstall`?** "One purpose" argues for never changing it. Resume clarity argues that a user who paused after the download deserves *ready to install* rather than *available*. Both are defensible; the difference is one string.

- **Does the pill's `x` survive a deck reload?** The store is in-memory and the host replays its snapshot to a fresh deck, so today a hide does not survive. Keeping that is the simplest answer and probably the right one; the alternative needs the host to remember a deck-side choice.

- **Is the wizard copy written in the arc, or does it earn a spike?** The user has said the text wants wordsmithing. Three rows and their detail lines, a title per stage, two terminal states and a gate confirm is a bounded amount of prose; but the last two passes were written in-arc and each was asked to be redone.

---

## Non-goals {#non-goals}

- **Keeping any of the current surface.** No badge, no inline dialog, no three sizes, no collapse control. Adapting them would preserve the shape the complaint is about.

- **A modal on a scheduled find.** `[B03]` — the arrival stays silent. This is the one thing every version of this feature has agreed on.

- **Merging `UpdateTug` into `ConfigureTug`.** Siblings sharing chrome, rows and the request pattern — not one wizard with modes. Setup can be required and blocks until done; an update is always optional and always pausable.

- **A progress bar.** Still words. Decided twice already.

- **New bridge actions or snapshot fields.** `revealCount` is enough for raise; the seven actions are enough for every decision the wizard offers.

- **Touching the Swift state machine's nine stages.** `UpdateState.swift`'s reducer is correct and tested; the wizard is a new reading of the same snapshot.

---

## Exit {#exit}

**An arc.** The order matters at the start and the end:

1. The observation first: settle `[F10]` with one real press of each button against `0.8.3` and a read of `tugapp.log` `[B09]`.
2. `UpdateTug` — the frame on `TugAlert`'s chrome, the three rows over the existing snapshot, opened by `revealCount` and by a deck-local request, closable at every step as pause `[B01]` `[B04]` `[B06]` `[B08]`.
3. The pill — one sentence, top centre, `x`, click opens the wizard `[B02]`.
4. The menu item — raise only, `menuCommand` retired, enabled everywhere `[B05]`.
5. The install gate `[B07]`.
6. Delete the old surface and rewrite `at0612` `[B10]`.
7. Copy, unless the open question sends it to a spike.

Steps 2 and 3 can be seen on screen before anything is deleted, which is worth doing: the last two arcs each looked right in the test and wrong in the app.
