# A new Session card arrives in three steps, at the picker's height

**Purpose:** Opening a new Session card into a split column hitches, judders, and lands a card that is the wrong size in the wrong place with its picker half-drawn over it. Too many motions start in the same frame. The arrival should be divided into steps, one thing moving at a time, and the card should open at the height the picker needs.

---

## Purpose {#purpose}

The user's words, with a screenshot of a New Session card standing as the lower member of a split column, oversized, with the Choose Session picker drawn over an empty body:

> This *obviously* does not work. There was hitching and juddering and a poorly placed and sized card. This really has to work better. We need to divide this out as we did when moving and resizing cards. Right now, too many things are happening at the same time. Let's divide out the phases. Make the space, then place the new card.

And, on the sizing:

> Just make the card big enough that the sheet doesn't clip.

And, on measurement:

> I *never ever* want per-frame measurements on things.

The precedent is the three-beat settle (`briefs/three-beat-settle-brief.md`): a crossing divided into shrink, move and grow so that at any instant exactly one kind of thing moves. The arrival of a card never joined that choreography.

---

## Evidence {#evidence}

**[F01] Everything starts in the same frame, from one commit.** `DeckManager.addCard` appends the pane and flips first responder in one commit. The settle arms on that notify, and in its Last pass the sitter's shrink beat and the new frame's entrance both launch immediately. **(verified by reading `tugdeck/src/deck-manager.ts` and `tugdeck/src/components/chrome/deck-canvas.tsx`)**

**[F02] The entrance is not a beat.** In `deck-canvas.tsx`'s Last pass, a frame with no First rect gets its own `imposer-enter` effect — fade up and a short rise — launched alongside the choreography rather than sequenced within it. So the new card fades in at its final geometry while the sitter is still shrinking to make room for it, and the two overlap for the length of the shrink beat. The exit ghost has the same shape on the way out: it fades while the survivor grows. **(verified by reading)**

**[F03] The picker raises before its card is on screen.** `cardDidActivate` fires synchronously inside the `addCard` commit; `SessionProjectPicker` subscribes on mount and gets an initial sync, so `presentSheet` runs on the picker's first render and the sheet's 200ms enter plays inside a frame that is itself mid-fade. **(verified by reading `session-card.tsx` and `card-lifecycle.ts`)**

**[F04] The card opens far taller than the thing it exists to show.** An arriving member takes a share of the run with a floor of 600px — the Session card's stack size policy. The picker's natural height is a little under 400px (recorded in `at0569`'s diagnostics). So the card is sized for a transcript it does not have. **(verified)**

**[F05] The sheet-reservation floor is inert here, by arithmetic.** `placeMembers` takes the greater of the stack floor and the reservation; 600 always beats the picker's ~400, so the mechanism landed by the `sheet-reservation` arc changes nothing on a Session card. `at0569` pins exactly that. **(verified)**

**[F06] Every sheet re-measures its clamp on every frame of a resize.** `TugSheetContent`'s clamp effect observes the pane frame and the canvas with a `ResizeObserver`, so a sheet on a card being resized — the upper card's Changes shade in the screenshot — re-measures `max-height` on every frame of the shrink beat. **(verified by reading `tug-sheet.tsx`)**

**[F07] A second commit lands on a timer.** `_revealAfterArrival` calls `revealCard` after `ARRIVAL_BEAT_MS`, a clock the settle does not share. **(verified by reading)**

**[F08] The allocator already has an exact-height reading.** A folded column member is given floor and ceiling equal to its folded tier and a weight of zero, so it pins at its height and asks for no share. **(verified by reading `placeMembers`)**

---

## Decisions {#decisions}

**[B01] An unbound Session card opens at the picker's height, and the neighbour keeps every other pixel.** Not a share of the column and not the 600px floor: the card's height is the picker's height plus the title bar. `placeMembers` reads an unbound Session card the way it reads a folded one ([F08]) — exact height, no share. When a session opens, the card takes its normal split share. When the picker is cancelled, the card goes and the neighbour gets its room back.

**[B02] That height is one constant on the Session card, next to its folded height.** It is known before `addCard` commits, so the arrival is one arm of the settle and nothing re-targets it a commit later. Nothing measures the picker to find it. The picker's measured report from the `sheet-reservation` arc stays as it is, for sheets on other cards; it is not the source of this number.

**[B03] The arrival is three steps, each starting when the one before it finishes.** One: the neighbour shrinks to make exactly that much room. Two: the new card fades in, at that size, into the room that is now there. Three: the picker slides in on the still card. Nothing else moves during any step.

**[B04] Entrance and departure become beats of the settle.** Arrival is the last beat, after shrink, move and grow; departure is the first, before any of them. A member appears only into room that already exists, and is gone before its room is reclaimed. Everything else about the three-beat settle is unchanged.

**[B05] The picker waits for its card to finish arriving.** The settle already knows when a frame's entrance completes. It tells the card lifecycle, and `presentSheet` listens to that instead of `cardDidActivate`; when no settle is in flight the event fires at once. It is an event, never a timer. `_revealAfterArrival` rides the same event instead of `ARRIVAL_BEAT_MS` ([F07]).

**[B06] Opening a session and cancelling run the same way back.** Open: the picker slides out, then the card grows to its share and the neighbour shrinks — one arm, sequenced by the beats that exist. The exact-height reading comes off when the card binds, derived from state in the binding commit, not as a side effect of the sheet unmounting. Cancel: the card fades out, then the neighbour grows back.

**[B07] No per-frame measurement, anywhere.** The `ResizeObserver` on the pane frame in the sheet's clamp effect ([F06]) goes. A sheet measures on open, on window resize, and once when a settle finishes. During motion it holds still.

**[B08] Timing rides the one settle knob.** Shrink and arrive at the resize beat's 0.6×, the sheet's own 200ms enter after them — about 680ms from the chord to a usable picker at default timing. Acceptable if it is smooth and reads as designed; every part scales with `--tugx-imposer-settle-duration`, so it is tuned by eye with one hand.

---

## Non-goals {#non-goals}

- **A floor for the unbound card.** [F05]: a floor under a card whose stack floor is already taller is inert. The card's height is exact, or the mechanism does nothing.
- **Measuring the picker to size the card.** A measured number arrives a commit after the card does and re-targets the settle mid-beat, which is the judder this brief exists to remove ([B02]).
- **Overlapping any two of the three steps to save time.** That is the current behaviour with a shorter overlap. Try the divided version first ([B08]).
- **Holding a sheet's clamp for the length of a beat and measuring per frame otherwise.** Per-frame measurement is out everywhere, not gated ([B07]).
- **Undoing the `sheet-reservation` arc.** The reservation, its verb, the sheet's report and the picker's declaration stay as the general mechanism for a card that hosts a sheet. This brief adds the exact-height reading beside them for the one card that *is* its sheet.

---

## Exit {#exit}

An arc.

The order that matters: the exact-height reading in `placeMembers` lands first, because every later step is judged against a card that is already the right size. Then the entrance and departure become beats in `deck-canvas.tsx`, so the card appears into made room. Then the frame-did-settle event on the card lifecycle, with `presentSheet` and `_revealAfterArrival` listening to it. Then the clamp's `ResizeObserver` comes out of `tug-sheet.tsx`, measuring on open, window resize and settle-complete only.

`at0569` should then assert the opposite of what it asserts now: the frames move, the host stands at the picker's height, the neighbour keeps the rest, and on open the host settles to its share. A second pin in the shape of `at0563`: during the shrink beat the new frame is not visible; during the arrive beat no frame changes size; the picker's panel is not present until the arrive beat has ended. Then look at it — a split column, a new Session card, a session opened, a picker cancelled — with a turn streaming in the neighbour.
