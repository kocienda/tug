# Overlay exits

**Purpose:** An alert vanishes when it is dismissed, while sheets and shades animate out. All three overlay kinds should present and dismiss the same way.

---

## Purpose {#purpose}

The user noticed "a glitch/difference in the way we order out alerts: there is no animation. We animate sheets and shades, right? All three of these *overlay* types should present the same."

They are right on both counts. Sheets and shades animate in and out. Alerts animate in only, and the Radix app-modals built on the alert's classes do the same. The overlays also differ in what moves them, how long they take, and how far they travel.

---

## Evidence {#evidence}

**[F01] An alert's exit was removed on purpose, to fix a hang.** `tug-alert.css` keeps only the entrance keyframes. The overlay rule `[data-state="closed"]` names no animation, and its comment explains why:

- Radix Presence keeps a closing layer mounted until `animationend`.
- Radix removes its `pointer-events: none` on `<body>` only when that layer unmounts.
- When `animationend` never comes, the whole app goes click-dead with nothing on screen to explain it. That happens under `--tug-timing: 0`, because WebKit fires no `animationend` for a 0 s animation. It also happened on the restore gate's quick open-then-close, which held a layer for 160 s in an app-test.

The fix removed the exit animation. What actually caused the hang was Radix's unmount waiting on that animation. **(verified, read from `tugdeck/src/components/tugways/tug-alert.css:29–215`)**

**[F02] Sheets and shades run their own presence and drive motion through TugAnimator.** `tug-sheet.tsx` keeps a `mounted` state that goes false only after the exit runs. The enter and exit effects run a `group()` on `--tug-motion-duration-moderate` (200 ms): `ease-out` on the way in, `ease-in` on the way out. The frames come from `SHEET_PRESENTATION_MOTION`, where each exit mirrors its entrance. The shade fades its own scrim, with the exit on `SHADE_SCRIM_EXIT_MS` = 150 ms. Every other presentation uses the pane scrim, which fades through a CSS transition. **(verified, `tug-sheet.tsx:396–488`, `:2160–2336`)**

**[F03] A sheet's exit waits only on `finished`, with no deadline.** The effect that ends the exit calls `setMounted(false)` from `g.finished.then` and from `.catch`, and from nothing else. `ModalInputDialog`'s comment records that `finished` never settles when rAF is suspended (a covered window does this) or when the group is superseded. In either case the sheet would stay mounted. **(verified that no deadline exists; what a stuck `mounted` leaves behind (`inert`, focus, the card's modal hold) was not traced)**

**[F04] `ModalInputDialog` already animates a safe exit from a Radix app-modal.** Every close goes through `closeWith` (`chrome/modal-input-dialog.tsx:270–310`), which:

- sets `data-closing` on the panel, which the CSS makes pointer-dead;
- fades the panel and the overlay with a TugAnimator `group()`;
- races `finished` against `MODAL_INPUT_CLOSE_DEADLINE_MS` = 250 ms, with whichever comes first settling once;
- only then calls the callback that closes Radix.

Radix's closed state names no animation, so its unmount is synchronous and the body lock always comes off. **(verified)**

**[F05] The overlays' numbers have drifted apart.**

| | Engine | Duration | Rise distance |
|---|---|---|---|
| Alert entrance | CSS keyframes | 150 ms | 8 px on the rest line |
| Sheets | WAAPI | 200 ms | `SHEET_ROLL_PX` = 28 px |
| `ModalInputDialog` | WAAPI | 100 ms (`fast`) | — |

The alert's centred entrance scales from 0.96, the same as the sheet's `scale-fade`. The rest-line keyframe's comment calls itself "the sheets' `rise`" but travels 8 px rather than 28. **(verified, `tug-alert.css:37–56`, `tug-sheet.tsx:320`)**

**[F06] Five more Radix app-modals draw on the alert's classes, and none of them goes through `TugAlert`.**

- **`version-gate`** has a store-controlled `open`. Its copy tells the user to reopen Tug, so it may never close while the app is running (inferred, not traced).
- **`restore-gate`** has a store-controlled `open` and holds its last snapshot for the closing frame.
- **`configure-tug`** has a store-controlled `open`.
- **`workspace-name-dialog`** zooms in from the control that raised it. On commit it zooms out to the workspace's row; on cancel it zooms back to where it came from. Both use `chrome/zoom-rects.ts` as the scrim fades. A close with neither `from` nor `to` gets a fade alone.
- **`update-tug`** zooms in from the update pill. On close it stashes the panel's rect so that whichever pill mounts next runs the reverse. Its header says its exit "stays instant, which is what [F03] requires", and that [F03] is the alert-exit finding of the update-pill zoom brief.

All five inherit the instant exit from [F01]. **(verified by reading each file's open/close path and CSS. Whether the workspace dialog's fade-alone close actually animates the panel or only the scrim was not run.)**

**[F07] TugAnimator degrades without stalling, and its group's `finished` can reject.** Under reduced motion it strips the spatial properties and fades instead. A cancel with `hold-at-current` rejects `finished`. A duration token scales by `getTugTiming()`, so a zero timing gives a zero duration. **(verified, `tug-animator.ts`)**

---

## Decisions {#decisions}

**[B01] Every overlay exit follows one contract: the motion only dresses the close and never decides whether it happens.** `closeWith` (see [F04]) moves to a shared helper in `tugdeck/src/components/tugways/internal/`. It takes the panel, an optional scrim, the exit frames and a duration. It sets `data-closing`, runs one `group()`, and settles exactly once, on whichever comes first: `finished`, its rejection, or a deadline set at the scaled duration plus a margin. `TugAlert`, `TugSheet` (every presentation, the shade included) and `ModalInputDialog` all close through it. The sheet gets the deadline it lacks ([F03]) as a side effect.

This rules out any exit that waits on `animationend` or on `finished` alone. It is the only shape that keeps [F01]'s guarantee and still has motion.

**[B02] The alert answers immediately and closes after the motion.** `resolveAndClose` resolves the pending promise at once, so a caller never waits on animation. Then the shared helper fades the panel and the overlay, and only when it settles does the alert call `setOpen(false)`. `[data-state="closed"]` keeps naming no animation, along with its `pointer-events: none !important`. Presence still unmounts synchronously and the body lock comes off within the deadline at the latest. The [F01] comment is rewritten to say the exit now lives before Radix closes rather than in Radix's closed state; it is not deleted, because the hazard it records is still real.

The trap's focus restore moves to the end of the fade. A second close gesture during the fade does nothing, the same way `closeWith` guards against it.

**[B03] One duration for every overlay: `--tug-motion-duration-moderate`, 200 ms.** The user settled this. The alert entrance moves from 150 ms to 200 ms. Easing follows the sheets: `ease-out` in, `ease-in` out. `ModalInputDialog` keeps its 100 ms `fast` fade, because that one is intentional: it is a quick input surface, not a dialog. `SHADE_SCRIM_EXIT_MS` stays, since it is the scrim leaving a beat ahead of the panel inside the 200 ms, not a second duration.

**[B04] One motion table: each alert placement uses the sheet presentation it already resembles.** A centred alert uses `scale-fade` and a rest-line alert uses `rise`, with frames read from `SHEET_PRESENTATION_MOTION` (exported, or lifted beside the helper). Both alert entrances move from CSS keyframes to TugAnimator. As a result, the rest-line alert travels `SHEET_ROLL_PX` (28 px) rather than 8 px.

The centred alert keeps its centring in `transform: translate(-50%, -50%)`, which an animated `transform` would overwrite. The centring moves to the individual `translate: -50% -50%` property, which composes with an animated `transform`. The rest-line variant does the same with `translate: -50% 0`. The CSS entrance keyframes are deleted.

**[B05] The two zoom dialogs keep their zoom, and the zoom is their exit.** The user settled this: the zoom tells a clearer story about where these surfaces come from.

- On a close with a destination, the rectangles carry the panel out, as they do today: commit to the row, cancel back to the source, or close to the pill.
- On a close with no destination, the panel and scrim leave through the shared helper ([B01]) with the plain `scale-fade` exit at 200 ms instead of vanishing.

`update-tug`'s header ("the exit stays instant, which is what [F03] requires") is rewritten to say the safe exit now comes from the shared helper.

**[B06] The restore gate stays instant.** The user settled this. It opens and closes inside a cold restore, and it is the surface that produced [F01]'s stuck layer. A fade there would decorate a moment nobody is watching. Its closed rules stay exactly as they are.

**[B07] The version gate and `configure-tug` adopt the helper, which needs a presented state that lags the store.** Both read `open` from a store, so Radix closes on the same frame as the store. Each one keeps a local `presented` flag: it goes true with the store, and goes false only when the helper settles. Radix's `open` follows `presented`. The restore gate already holds its last snapshot for its closing frame; these two do the same with their content. If the version gate turns out never to close at runtime ([F06]), it adopts the same code for consistency and nothing more.

**[B08] The work may land directly on `main` from this brief.** The user said so. The change is contained to the overlay components, their CSS and one helper, and every decision it needs is above. Running an arc is still an option, not a requirement.

---

## Non-goals {#non-goals}

- **Restoring a CSS exit keyframe on the alert.** This is exactly the shape [F01] removed. Any exit Radix Presence waits on can strand the body lock.
- **Animating the restore gate.** Rejected by the user ([B06]).
- **Replacing the zoom with a plain fade on the workspace-name and update dialogs.** Rejected by the user ([B05]).
- **Moving the alert off Radix, or onto `TugSheet`.** Its app-modal focus trap and the `role="alertdialog"` semantics are why it uses Radix `Dialog` ([P13] in its header). `TugAlertSheet` already covers the pane-modal alert.
- **Bringing `ModalInputDialog` to 200 ms.** Its 100 ms fade stays ([B03]).

---

## Exit {#exit}

**An arc, or the same changes made directly on `main`** ([B08]). The order matters:

1. **The helper.** Lift `closeWith` into `internal/` and move `ModalInputDialog` onto it. This is a pure refactor and should change no behaviour.
2. **Sheets.** `TugSheet`'s exit settles through the helper, which adds the deadline.
3. **The alert.**
   - The answer comes first and the close after the motion ([B02]).
   - Entrances move to TugAnimator on the shared table, with centring on `translate` ([B04]).
   - Duration 200 ms ([B03]).
   - Rewrite the [F01] comment.
4. **The app-modals.**
   - `configure-tug` and `version-gate` get the lagging `presented` state ([B07]).
   - The two zoom dialogs get the helper's fade on closes with no destination ([B05]).
   - The restore gate is left alone.

**Verification:**

- A new app-test closes an alert under `--tug-timing: 0` and again with rAF held (a covered window), then asserts that the body takes a press again within the deadline. This turns [F01]'s hazard into a test.
- A matching case covers a sheet closed while its window is covered.
- `at0559`'s `clearStaleAppModal` helper should become unnecessary. If the new test proves it is, delete it.
- Run the step's selection through `just app-test-changed`. The alert and sheet are shared primitives, so take the union with `just app-test-select`.
