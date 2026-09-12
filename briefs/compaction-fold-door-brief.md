# The fold is the one door a compaction admits

**Purpose:** A compacting Session card is held by its run, and the fold is refused with everything else. The fold should pass, since folding a compacting card does not dismiss the run but swaps its face. Fold and unfold need to be plumbed through the hold, and the crossing needs a motion that carries the run's indicator from the cover sheet to the Z2 row and back.

---

## Purpose {#purpose}

The user's words: *"I think the one operation we need to allow through the session compacting modality is the folding/unfolding of the session. We need to plumb this through and add an excellent animation for the compact progress/sheet."*

A `/compact` run lasts minutes and streams nothing. On an open card it raises the exclusive cover sheet, which holds the card so that no other sheet, no close, and no Escape can dismiss the run out from under the user. That hold is right for every door except one. A fold does not leave the run; the folded card already carries the run in its Z2 row with the same Cancel. So a user who wants to tuck a compacting card away for a few minutes is refused for no reason the run can name, and a user who folded before compacting gets a different card on unfold than the one who compacted first.

---

## Evidence {#evidence}

**[F01] The hold belongs to the sheet, not the run.** `TugSheetContent` takes `cardModalHoldStore.hold(...)` in a `useLayoutEffect` keyed on `open && exclusive` (`tugdeck/src/components/tugways/tug-sheet.tsx`, near line 952) and releases it when the sheet closes. `compactionProgressStore.begin` takes no hold of its own. **(verified)**

**[F02] The fold is refused at the responder by the hold's existence alone.** The `TOGGLE_SESSION_FOLD` handler in `tugdeck/src/components/tugways/cards/session-card.tsx` (near line 5150) calls `refuseCardModalHold(cardId)` and returns before the fold, on the argument that its stand-down carries `SHEET_SETTLED_DISMISS` and would otherwise close a live run's cover. All three fold doors, ⌃⌘Y, the Z2 control, and Session ▸ Fold Session, land on that handler. **(verified)**

**[F03] A folded compaction has a face and no hold.** The cover's `showSheet` declares `foldPresentation: "inhabit"`, so on a folded card `useTugSheet.showSheet` resolves `undefined` and raises nothing. The Z2 row derives `occupant === "compaction"` from `compactionProgressStore` and renders the wave, "Compacting…", and a Cancel that calls `compactionProgressStore.requestCancel` (`session-card-telemetry-renderers.tsx`, near lines 773 and 1419). No sheet means no hold: the comment in `session-compaction-run.tsx` says so, and a `/usage` during a folded compaction unfolds the card and rises. **(verified)**

**[F04] Unfolding a run that started folded leaves the card open with no cover.** Nothing re-raises the sheet. `beginCompactionRun` returns early when the store already has a run, and the raise is inside it. The run itself is unharmed, since the watcher is subscribed to the store and settles the run wherever it ends, but the open card shows an ordinary busy turn with every door open. **(verified)**

**[F05] Cancel is already one closure on both faces.** `compactionProgressStore.begin(cardId, onCancel)` files the run's cancel; the sheet's Cancel and the row's Cancel both reach it, with its `canceled` latch and its correction bulletin. Nothing here changes. **(verified)**

**[F06] The refusal has one voice and it is the sheet's.** The hold's `refuse` callback reaches `nudgeRef`, which flashes the sheet's refusal line for 3.2 s on a `data-refused` attribute with a forced-reflow restart (`compaction-progress-sheet.tsx` and `.css`). The row has no such line. **(verified)**

**[F07] The fold's clock is the imposer's spring.** The card interior is held still under `data-fold-crossing` for the crossing's length, and the end is the `FOLD_CROSSING_END` event on the frame, not a timer (`tugdeck/src/lib/fold-crossing.ts`). The settle duration is published as `--tugx-imposer-settle-duration` and scaled by `--tug-timing`. The cover sheet lives in the pane's portal, outside the still interior, so it is not carried by that hold and must move on its own. **(verified)**

**[F08] Bidden sheets raise one task after the unfold, and the reason is stated.** `showSheet` defers `raise` with `setTimeout(raise, 0)` when it just unfolded the card, because a panel mounted mid-fold reads its anchor off a slot with no box and parks at the `rise` resting offset (`tug-sheet.tsx`, near line 2560). A cover raised on unfold faces the same hazard for the crossing's whole length, not one task. **(verified)**

**[F09] The two indicators say nothing about compaction.** The sheet shows `TugProgressIndicator variant="bar"` with no value, which is the generic barber pole; the row shows `variant="wave"`, the same three-bar mark used for any running thing. The row's CSS calls the wave "the compaction's wave" only because it is what was to hand. **(verified)**

**[F10] The sheet's presentations are transform-and-opacity pairs on a fixed table.** `SHEET_PRESENTATION_MOTION` in `tug-sheet.tsx` (near line 277) holds `top`, `bottom`, `rise`, `scale-fade`, `shade`; `rise` is a 28 px roll plus fade and takes a `bottomAnchorSelector`. Their durations are the sheet's own, not the imposer's. **(verified)**

---

## Decisions {#decisions}

**[B01] The run holds the card, and it is the only holder.** `compactionProgressStore.begin` takes the modal hold for the run's life and `clear` releases it. The cover sheet keeps `exclusive` for its keyboard refusals (Escape, ⌘., a stray `CANCEL_DIALOG`) but no longer acquires a hold of its own. Confirmed by the user this session. What this buys: a folded compaction is held too, so a `/usage` during one is refused in the run's voice instead of unfolding the card and rising over it; and the fold can be reasoned about as one door in one holder rather than as a hole in the sheet's guard.

**[B02] The hold names the one door it admits, and it is the fold.** `CardModalHold` gains a flag, `admitsFold`, that the compaction hold sets and no other holder does. The `TOGGLE_SESSION_FOLD` handler asks the hold whether the fold is admitted rather than whether a hold exists. Every other door is unchanged and still refuses: close, ⌘W, the tab ×, a second `showSheet`, Escape, ⌘. inside the sheet. The flag is on the hold rather than special-cased on the compaction because the refusal doctrine is that the holder speaks, and a door the holder admits is the holder's to say.

**[B03] The cover's presence is derived from run × fold, not raised once.** An effect in `useCompactionRun` watches the run's store and the card's fold flag. Run in flight, card open, no cover up: raise the cover. Card folded: stand the cover down with `SHEET_SETTLED_DISMISS`, the token the exclusive sheet accepts. This retires the raise inside `beginCompactionRun` and fixes [F04] without a special case: a run that started folded gets its cover the first time the card is open.

**[B04] A compaction that starts on a folded card raises no panel.** The folded-card brief's rule stands and the derivation in [B03] honours it: the cover only rises when the card is open. Confirmed by the user this session.

**[B05] The fold in lowers the cover into the row on the imposer's clock.** A new sheet presentation, `settle`, whose exit translates the panel toward the Z2 row and fades it, with duration read from `--tugx-imposer-settle-duration` times `--tug-timing` rather than the sheet's own exit length. The row's occupant fades in over the closing part of the same window, rising about 8 px into place. One clock, two things converging on one line, and the edge of the card arrives with them.

**[B06] The unfold raises the cover at `FOLD_CROSSING_END`, from the Z2 line.** The row's occupant fades as the edge sweeps down; the cover waits for the crossing-end event and then rises with the existing `rise` presentation, `bottomAnchorSelector` pointing at the status bar. Waiting for the event rather than one task ([F08]) is what mounts the panel into a settled card with a boxed slot. Motion off and reduced motion snap, as the fold itself does.

**[B07] ~~A `squeeze` variant of `TugProgressIndicator` is the compaction mark in both seats.~~ REVERSED 2026-09-13. The barber pole is the compaction mark in both seats.** The squeeze was built and the user rejected it: it was never asked for, and the variant is deleted from `TugProgressIndicator` — glyph pair, unit test, gallery entry, and all. The sheet carries `variant="bar"` at 8 px, as it did before this arc. The folded Z2 row carries the same bar at 6 px in a 72 px seat, and its shape is **label, bar, Cancel**: the reading and the pole centred together on the row's midline, Cancel pinned to the trailing edge beside the fold control. One glyph in two seats, so the handoff in [B05] and [B06] still hands the run between two faces of the same mark — but the mark is the one the system already had, and adding a variant to draw an operation is not a thing this arc gets to do on its own.

**[B08] The row gets the refusal's voice while folded.** The hold's `refuse` reaches whichever face is up. On the sheet the flash line is unchanged. On the folded row, `data-refused` on the occupant row swaps its title from "Compacting…" to the refusal text for the same 3.2 s, with the same forced-reflow restart, then returns. The row is the run's surface while folded, so the run speaks from there.

**[B09] The `card-taxonomy` spike-count pin is deleted.** It counted registrations and went stale every time a spike was added or removed, and it was red on the tree before this work began. Deleted this session at the user's instruction; the family-and-acceptance test beside it still covers every spike.

---

## Open Questions {#open-questions}

- **Where the hold's refuse callback is routed when both faces exist for an instant.** During the fold in, the sheet is standing down and the row is arriving. The simplest rule is that the run's hold refuses through the store, and each face subscribes to a `refusedAt` tick and flashes itself if mounted. Whether that lives on `compactionProgressStore` or on `cardModalHoldStore` is for the arc to settle by reading which store already holds per-card run state.

---

## Non-goals {#non-goals}

- **A second holder on the card.** Considered and rejected: the sheet keeping its own hold beside the run's would make "the one door" a property of two objects that must agree. One holder, the run.
- **Letting the fold walk past the hold with the stand-down as it is.** Rejected: the fold's `closeSheet` carries `SHEET_SETTLED_DISMISS` and would close a live run's cover with nothing to bring it back. [B03] makes the cover derived so the fold never has to know.
- **A new glyph variant for compaction.** Built as the squeeze and then reversed by the user ([B07]); the variant is deleted. The bar stands in both seats.
- **Any change to Cancel, the run watcher, or the correction bulletin.** [F05] stands.
- **The Z2 blinking question on a folded card.** Parked by the user; a rejected spike was deleted this session.
- **The deferred arrivals, question and permission.** They are notices, not holds, and are untouched.
- **⌃⌘M.** Not touched, not proposed, not a door here.

---

## Exit {#exit}

An arc. The order that matters:

1. Move the hold onto the run ([B01]) and add `admitsFold` ([B02]); route the fold responder through it. At this point a fold during a compaction lands and the row takes over, with the cover simply gone on unfold.
2. Derive the cover from run × fold ([B03], [B04]) so the unfold brings it back; raise on `FOLD_CROSSING_END` ([B06]).
3. Give the row the refusal's voice ([B08]) and settle the open question.
4. Seat the bar in both places and give the folded row its label/bar/Cancel shape ([B07]).
5. Add the `settle` presentation and time the handoff to the imposer's clock ([B05]).

Steps 4 and 5 are the motion and can land last; steps 1 through 3 are the plumbing and are worth having on their own. App-tests already exist for the hold's refusals and for the folded row's Cancel, and each step names a behaviour the existing pins should be extended to, not rewritten.
