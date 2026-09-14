<!-- brief-skeleton v1 -->

# Know the height before the commit

**Purpose:** Opening a Session card into a split column is three motions where two were wanted, and cancelling it is three the other way. The deck commits the card before it knows how tall the card is, then learns the number from the picker after the card is already on screen, and the picker moves on a clock of its own on top of that. The work is to know what to draw before drawing it: measure the opening form before `addCard` commits, make the picker ride the frame's own beats, and hold an arrival and a departure to exactly two motions each.

---

## Purpose {#purpose}

The user's words, after the `member-height-one-rule` arc joined:

> When I open a new session card in a split, I *still get a double stutter*. The space opens, and then the space re-adjusts, and then the card draws. I want a maximum of *two motions*. This is *three*. One too many. Same for when the card goes away, if I decide against opening the session. This simply needs to be better. It's like we still don't know how tall the new session card will be, since *we don't give ourselves sufficiently powerful APIs to know*, so we bumble through the experience and patch things up later. This must improve.

And on the sketch that followed:

> This is the main missing piece, IMHO: **Know the height before the commit, by measuring.** No "cheaper fallbacks". That approach has gotten us, and kept us, in this mess. Focus on *knowing what to draw* before drawing it.

Three arcs have now sized the unbound Session card from a constant — `picker-card-arrival` wrote it, `picker-height-list-cap` re-measured it, `member-height-one-rule` turned it from a ceiling into a floor — and each was faithful to its brief. The constant is the mess. This brief retires it.

---

## Evidence {#evidence}

**[F01] The arrival runs three beats before the picker moves, and then the picker moves.** `just app-test at0571-picker-card-arrival.test.ts` on 2026-09-15 printed `arrival beats: order=["shrink","move","arrive"]`, and the picker was present on zero beat samples and on every sample after. The sheet's own entrance then plays on `--tug-motion-duration-moderate` (200ms). That is a shrink, a move, an arrive, and a slide-in. **(verified, by the test's own diagnostics)**

**[F02] Three steps is a decision on the record, not a defect.** `briefs/picker-card-arrival-brief.md` [B03]: "The arrival is three steps, each starting when the one before it finishes. One: the neighbour shrinks. Two: the new card fades in. Three: the picker slides in on the still card." [B05] there makes the picker wait on `onceCardDidArrive`, and `session-card.tsx` does exactly that. The user is counting what was designed. **(verified)**

**[F03] The move beat is a width re-solve, and the planner emits it whenever any frame translates or smears.** `planSettleBeats` in `tugdeck/src/lib/pane-flip.ts` pushes a `move` beat when `dx`, `dy` or `sx` is non-identity, and `flipDelta` reads `dy` from the frames' tops, so a top-anchored sitter shrinking in place carries no `dy`. What moved on the harness is width: the fixture's sitter is a `hello` card at 600px and a Session card asks for `CONTENT_WIDTH_COMFY_PX` (800), so slot 0's extent grows and every frame translates. **(the planner's rule is verified by reading; that the harness's move is the width is inferred from the fixture and not measured — the census samples heights and opacity only)**

**[F04] The height is declared, not known, and the deck learns the real number after the card is on screen.** `SESSION_UNBOUND_PANEL_HEIGHT_PX` (554) in `session-card-registration.tsx` was "read off the built app" and written down. The live number arrives from `tug-sheet.tsx`'s `useLayoutEffect` after the panel mounts — `scrollHeight` plus borders and margins — through `reserveSheetHeightForCard` into `setSheetReservation`, which is an ordinary commit. `arrangementSignature` in `deck-canvas.tsx` rounds allocated heights to the pixel, so a measurement one pixel off the declaration arms a full settle, with beats, after the card has already arrived. A different font rasterisation, a wrapped path field, or the picker's inline notice is enough. **(verified by reading)**

**[F05] The picker is a second actor with its own clock, on both ends.** Arrival: `presentSheet` waits on `onceCardDidArrive`, then `showSheet` mounts the panel and the enter animation runs. Departure: `close("cancel")` runs the exit animation, `setMounted(false)` fires `sheetDidHide` and `sheetDidReturnResult`, and only then does `CLOSE_TAB` remove the card. The departure choreography the harness recorded is `["depart","move","grow"]`, after the sheet has already left. The exit ghost in `deck-canvas.tsx` is an empty `div` painted with the pane's background and border at the last rect — the picker vanishes, then a blank card fades, then the survivor grows. **(verified by reading and by the test's diagnostics)**

**[F06] Measurement was rejected before only because of when it happened.** `picker-card-arrival-brief.md` [B02]: "Nothing measures the picker to find it," and its non-goal: "A measured number arrives a commit after the card does and re-targets the settle mid-beat." The objection is to a measurement that lands after the commit. A measurement taken before the commit has none of that cost, and the brief did not consider one. **(verified)**

**[F07] The arrival commit already carries everything but the truth.** `addCard` writes the seat ([D194]), the opening bid and the newcomer's weight ([D195]) in the one commit that appends the pane, and the width re-solve the newcomer causes lands in the same commit. The one term that is not in that commit is the height the card actually needs, because nothing can know it before the picker has rendered. Every other input to the settle is known before the settle is launched. **(verified by reading `addCard` and `_impositionSeating`)**

**[F08] "Never measure" has already been reversed once, on the rails.** `briefs/sidebar-height-is-measured-brief.md` reversed the rule that a card declares its height from state and never measures it; what survives of that arc is the `data-card-content` element every content card marks, read once by *Resize Sidebars to Fit*. The precedent for a measured height with a stated invariant about what it may depend on is in the tree. **(verified)**

**[F09] The picker's data-dependent height is bounded, and its data can change after mount.** The sessions list is `max-height: 14.5rem`, every row has a 3.5rem floor, and the picker form kicks a stale-while-revalidate refresh of the ledger once per open, so rows can arrive after the first render. The cap bounds what the refresh can do to the height. **(verified by reading `session-card.css` and `SessionProjectPickerForm`)**

---

## Decisions {#decisions}

**[B01] The height is known before the commit, by measuring the opening form off-screen.** A card type whose card opens as its sheet declares an **opening form** on its registration — the picker's panel, as a renderable — and `addCard` renders it into a measuring layer on the canvas at the width the member will stand at, reads its natural height synchronously, derives the member floor through `memberFloorForSheetPanel`, and writes that as the opening bid inside the commit that appends the pane. `SESSION_UNBOUND_PANEL_HEIGHT_PX` and `unboundSizePolicy`'s height retire; the width half of that policy stays. There is no fallback constant and no "if measurement is unavailable" branch: a card type that declares an opening form is measured, and one that does not has no unbound form. This is the user's call, stated twice, and the argument is [F04] and the three arcs before this one: a number written down is wrong the moment anything around it moves, and a number read off the thing about to be drawn cannot be. Revisit only if the measuring render proves too slow to run inside a commit, which would be measured before being believed.

**[B02] What is measured is what is drawn.** The measuring render and the live picker are the same component, at the same width, over the same data, so the first report the live sheet makes equals the bid by construction. The deck treats a differing first report as a defect: it records a `deckTrace` row naming both numbers and holds the bid, and it does not re-divide. A later report that differs because the picker's content genuinely changed — the inline notice after a failed resume, rows arriving past the cap — is an honest reservation update and moves the member as reservations do today. The rule that separates the two is time: nothing the arrival commit decided may be revised by a number learned after it.

**[B03] The picker rides the frame; it is not a sheet with its own clock during arrival or departure.** On arrival the picker mounts inside the frame before the frame is shown and rides the arrive beat with it — no entrance of its own, and no `onceCardDidArrive` wait in `SessionProjectPicker`. On cancel the picker does not exit; the card departs with the picker still in it, and the depart ghost holds the frame's face rather than an empty box. Sheets a user summons on a standing card keep their slide, because there the sheet is the thing arriving and the frame is not.

**[B04] An arrival and a departure are exactly two beats, by contract: room, then card.** Room is every sitter's shrink and every frame's translate and width change, together; card is the frame appearing or fading. A frame that carries both a size term and a translate in the room beat rides both in one keyframe list for that beat — that beat is already off the compositor because of the size term, so the three-beat settle's reason for keeping a move transform-only does not apply to it. The everyday arrangement change with no arrival or departure is untouched: one transform-only move beat, or the shrink–move–grow chain it plans today.

**[B05] The widths are known before the commit too.** The width re-solve a newcomer causes is computed in the arrival commit already ([F07]); the measuring render in [B01] is made at the width that re-solve produces, not at the column's current width, so the measured height is the height at the width the card will actually stand at. This is the ordering that makes [B02] true for a card whose width changes on arrival.

**[B06] The rule is stated in the laws in these words: the deck knows what it will draw before it draws it.** `tuglaws/pane-model.md` gains the sentence, beside the one-rule paragraph [D195] added: every term a settle animates — seat, weight, floor, width — is known in the commit that launches it, and no number learned after the commit may re-target that settle. The exact-height pin, the opening bid as a constant, and the picker's own clock are named as the three ways this was broken and the one way it is now kept.

---

## Non-goals {#non-goals}

- **A constant, frozen form, or any other "cheaper fallback" for the unbound height.** Freezing the picker's list at its cap height would make a constant truthful for one picker on one machine and leave fonts, DPI, the notice and every future form as drift sources. The user rejected this in so many words. A card's opening height is measured or the card has no unbound form.
- **Measuring after the commit and settling again.** That is what happens today ([F04]) and what `picker-card-arrival` rightly rejected ([F06]).
- **Overlapping the third motion into the second to shorten it.** A shorter stutter is a stutter. The count is the target.
- **Changing the allocator.** `sharedHeightsOf`, `placeStandingOf`, `arrivalSharesOf` and the one-rule member spec are correct and untouched. What changes is what the arrival commit knows, and how the settle is choreographed for arrivals and departures.
- **Touching a user-summoned sheet's entrance or exit.** A sheet raised on a standing card is arriving into a frame that is not; its slide stays.
- **The settle-end notice a superseded settle never announces.** `.tug/arcs/member-height-one-rule/step-4-open-question.md` recorded that a settle re-targeted mid-flight can leave the sheet clamp's re-measure without its `IMPOSER_SETTLE_END`. After [B02] no measurement re-targets an arrival, so this brief no longer reaches it; it remains a defect of its own on any other re-target and is separate work.

---

## Exit {#exit}

An arc.

The order that matters: first, the measuring layer and the registration's opening form, with `addCard` rendering, reading and writing the bid inside its commit at the post-re-solve width ([B01], [B05]) — this is the piece the user named, and `SESSION_UNBOUND_PANEL_HEIGHT_PX` goes with it. Then the first-report rule ([B02]): equal by construction, a trace row and a held bid on a mismatch, never a re-divide. Then the picker riding the frame ([B03]): mounted before the frame is shown, no entrance, no exit, a ghost with a face. Then the two-beat contract for arrivals and departures in the planner and the canvas ([B04]). Then the laws ([B06]). `at0571` is rewritten to assert the count — `["room","card"]` on arrival, `["card","room"]` on departure, the picker present from the frame's first visible sample, and no `settle-arm` with `armed: true` between the arrival's launch and rest — and `at0569` to assert the first live report equals the bid on a seeded list at its cap and on a one-row list both. The by-eye pass on a real project, split column, session card above session card, is the user's.
