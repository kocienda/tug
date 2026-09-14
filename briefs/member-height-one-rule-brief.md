# A column member declares what it needs, and the place divides what is left

**Purpose:** A new Session card opening into a split column is held at exactly 618px while the column has hundreds of pixels to spare, because the height it declares while unbound is written as a ceiling with zero weight — the folded form's mechanism, borrowed to say something that was never a band. Four mechanisms decide a member's height today and three of them are the same idea in different clothes. The work is to make them one rule, so room goes to the card that can use it and the arrival makes room only when room is actually short.

---

## Purpose {#purpose}

The user's words, with a screenshot of a folded Session card above a fresh Session card in a split column, the fresh card standing at its pinned height and roughly a third of the column empty beneath it:

> You seem to want to *limit* new session cards to the minimum in a split, even when there's more room in the slot/column! There's no need to do this. Use the space we have. We should be making space when we *need it* for the new card, not limiting its space when there's plenty.
>
> It feels like this still is a bunch of hacks, and not a completely functioning system yet. Make a sketch to unify these behaviors better.

This brief is that sketch, converged. The `picker-card-arrival` arc (`67db70119`) introduced the exact-height pin, and `picker-height-list-cap` (`f76a133ad`) re-measured it; both were faithful to their briefs, and the dead band in the screenshot is what the two of them add up to.

---

## Evidence {#evidence}

**[F01] The dead band is the allocator's wall branch firing on a card that is not a wall.** Both members of the column in the screenshot are ceilinged with zero weight: the folded card reads `floor = ceiling = 144, weight 0` through `foldedSizePolicy`, and the fresh card reads `floor = ceiling = 618, weight 0` through `exactMemberHeights`. `placeStandingOf` in `tugdeck/src/lib/layout-imposer.ts` sums the ceilings, finds the capacity (`144 + 5 + 618 = 767`) below the run (~1041 in the harness), and declares the place `"overflow"` — a strip whose surplus is "run left over beneath the wall", in the words of its own comment. That branch was written for a column of folded cards, where leaving a band beneath is right. **(verified by reading `placeStandingOf`, `sharedHeightsOf`, and the member spec in `tugdeck/src/deck-store-selectors.ts`)**

**[F02] The allocator is sound; the declarations are not.** `sharedHeightsOf` already does everything the unification needs: it divides a run by weight, holds any member at its floor, holds any member at its ceiling, and hands the difference back until nobody moves. A member with a floor, no ceiling, and a weight takes every pixel the place has to give. Nothing in the division has to change. **(verified)**

**[F03] Four mechanisms decide a column member's height, and three of them mean "what this member needs right now".** In the member spec: `foldedSizePolicy` (floor = ceiling, weight 0 — a genuine band), `exactMemberHeights` (floor = ceiling, weight 0 — "what I am worth unbound"), `sheetReservations` (a floor — "the sheet on me needs this"), and `getStackSizePolicy().min.height` (a floor with a weight — "this card type needs this"). The ordinary branch already takes `Math.max` of the last two. The pin is read ahead of them and short-circuits both. Only the folded tier is a ceiling in any sense the eye can confirm. **(verified)**

**[F04] The pin's reason to exist evaporated when its number crossed the floor, and a test recorded the moment.** `SESSION_UNBOUND_HEIGHT_PX` began at 444, *below* the Session card's 600 stack floor — the one thing a reservation cannot do is make a card smaller than its floor, and that was the pin's job. Re-measured to 618 it stands *above* the floor; the original purpose is gone and only the ceiling side effect remains. `at0569-sheet-reservation.test.ts` used to assert "the pin is under the floor a reservation could never get below" and now asserts "the pin is a height the stack floor would not have given the card" — a sentence with no content, passing. **(verified by reading the test's diff across the `picker-height-list-cap` rounds)**

**[F05] The pin and the reservation measure one subject in two currencies.** The picker's sheet reports its *panel's* natural height — 554px with the sessions list at its cap — through `reportNaturalHeight` in `session-card.tsx`, and `sheetReservationsWith` stores that as the *member's* floor unchanged. The pin says 618, which is `554 + 37 (title bar and clip drop) + 12 (panel top margin) + 32 (SHEET_CANVAS_GAP) − 5 (the gap under a column's last member)`. The reservation is therefore always 64px short of what the card needs, which is why `at0569` calls it "inert" on a Session card; and the pin is the reservation's number with the chrome arithmetic done by hand in a doc-comment. **(verified: the terms are the doc-comment on `SESSION_UNBOUND_HEIGHT_PX`; the reservation's raw storage is `sheetReservationsWith`)**

**[F06] A wrong constant is a permanent clip; a wrong opening bid would be one settle.** The `picker-height-list-cap` arc existed entirely because 444 was measured against a one-row picker and no test could see it; it took a re-measurement, a shared fixture, and four new assertions to fix one number, and its audit recorded a state the number still does not hold — the picker re-presented with an inline notice above its form. Every one of those is a consequence of the pin being a *ceiling*: a floor that is too small is corrected by the measurement that follows, and a ceiling that is too small is a clip forever. **(verified by the arc's own record; the notice case is the doc-comment's own admission, not measured)**

**[F07] "Unbound with no picker" is not a standing state.** Cancelling the picker closes its card through the [D02] cascade, and binding replaces the picker with the transcript. So the interval in which the deck needs the card's unbound height but has no sheet measurement is exactly the arrival window — from `addCard`'s commit until the sheet mounts and reports. **(verified by reading the picker's cancel path in `session-card.tsx`)**

**[F08] The newcomer's weight is the one term the current record leaves arbitrary.** `sharedHeightsOf` reads an unnamed member as weight 1. Against a sitter the hand has sashed to, say, 1.71 (a weight `at0455` prints), a newcomer at 1.0 takes an accidental fraction of the run that nobody chose. **(verified by reading `sharedHeightsOf` and `railWeightOf`)**

---

## Decisions {#decisions}

**[B01] A member's height comes from one rule: it declares what it needs, and the place divides what is left.** `floor` is the largest thing standing on the member — its card type's policy for its current form, and any sheet on it, measured — one `Math.max`, the shape the ordinary branch already has. `ceiling` is declared only by a form that is genuinely a band. `weight` belongs to every member that is not a band, which is what makes leftover run reach somebody. This rules out any second path that hands a member an exact height, and it rules out reading one mechanism ahead of the others: every contributor goes into the same `max`. The folded tier is untouched — it is the one form for which floor = ceiling says something true — and a column of only folded members still leaves its band beneath, as [P05] intends. Revisit only if a second genuinely banded form appears, and then it declares a ceiling the same way the folded one does.

**[B02] The exact-height pin retires as a ceiling and becomes an opening bid: a declared floor for the arrival window, superseded by the first measurement and then discarded.** The pin's one legitimate job was to know the number *before* `addCard` commits, so the arrival is one motion and nothing re-targets the settle a beat later ([B02] of `picker-card-arrival-brief.md`). That job survives as a floor. The sheet's measured reservation arrives a commit later and supersedes it; from then on the live measurement is the floor, so the picker-with-a-notice state ([F06]) and any future drift in the picker's height are handled by the thing that measures them rather than by a constant somebody has to re-read. `exactMemberHeights` and its ceiling reading in the member spec go; `exact-height-pin.ts` keeps its write-at-`addCard` gesture under the new name and meaning, and loses the drop-at-binding-commit, because the bid is cleared by the measurement that replaces it rather than by a card-state transition ([F07]). A wrong bid now costs one settle instead of a permanent clip.

**[B03] The chrome arithmetic lives in the deck, once.** The sheet reports what it knows — its panel's natural height — and the deck derives the member floor from it, adding the title bar and clip drop, the panel's top margin, and `SHEET_CANVAS_GAP` less the gap under a column's last member. The deck already knows every one of those terms; the card knows none of them and should not. This ends the two-currency problem in [F05]: the reservation stops being 64px short, the opening bid and the measurement denominate the same quantity, and `SESSION_UNBOUND_HEIGHT_PX`'s doc-comment stops being the only place the sum is written. The user's call, from the sketch: "put it in the deck."

**[B04] The opening bid is a form policy beside `foldedSizePolicy`, not a scalar.** A card registration already declares a policy per form, and `getStackSizePolicy(componentIds, { folded })` already selects by form. The unbound Session card's need is one more form and takes the same shape — an `unboundSizePolicy` (name to be settled in the arc) with a `min.height` and *no* `max.height`, which is precisely how it differs from the folded policy and precisely what [B01] requires. The scalar `unboundExactHeightPx` on `CardRegistration` goes. The user's call: "make a policy."

**[B05] A newcomer takes the surplus first, and only then shares.** On arrival into a split column the newcomer's weight is not the unnamed default of 1 against whatever the sitters have been sashed to ([F08]). The room the sitters' floors and ceilings do not claim goes to the newcomer before any proportional division; only when the newcomer's own need exceeds that surplus does the ordinary weighted division re-divide the run among everyone, and only then do the sitters yield. This is "make space when we need it" as a rule rather than a beat: in the screenshot the folded sitter is at its tier, the surplus is the whole rest of the column, and the newcomer takes it; with an unfolded sitter at a stored weight and a newcomer whose floor fits in the surplus, the sitter does not move at all. The user's call. How the newcomer's stored weight is then written so the next re-division agrees with what the eye saw is the arc's to work out against `sharedHeightsOf`'s inverse.

**[B06] The arrival choreography is untouched.** Beats, the arrival event, the settle-end notice, and the clamp's re-measure occasions are all correct. What changes is only what the newcomer's member declares when the beats run: a floor with a weight instead of an exact height with none. `picker-card-arrival-brief.md`'s [B02] — one commit, no re-target — is honoured because the bid is written in `addCard`'s own commit exactly as the pin was.

---

## Open Questions {#open-questions}

- **What does the deck do when the measurement arrives and differs from the bid?** [B02] says the measurement supersedes. When the two agree — the common case — nothing moves. When they differ, the column re-divides by one settle. Whether that settle should be animated like a sash move or committed as a plain re-place is a feel question the arc can answer by trying both; it is not a decision that changes what gets written.

---

## Non-goals {#non-goals}

- **Touching the allocator's division.** `sharedHeightsOf`, `placeStandingOf`, and the overflow strip are correct ([F02]) and this work changes nothing in them. A run that genuinely cannot hold its members' floors still overflows into a scrolling strip.
- **Giving the folded tier a weight or removing its ceiling.** A folded card is a band; stretching it would be wrong, and a wall of them leaving room beneath is the intended reading ([P05]).
- **Sizing the card from the picker's measurement alone, with no opening bid.** Rejected in `picker-card-arrival-brief.md` and still rejected: a floor that lands a commit after the card does re-targets the settle mid-beat. The bid exists so the common case is one motion; the measurement exists so the bid can be wrong without a permanent clip.
- **Keeping `exactMemberHeights` as a floor under its current name.** The three-line version — drop the ceiling, keep everything else — fixes the screenshot and leaves [F03], [F05], and the pin's own bookkeeping in place. The user asked for the behaviours unified, not for the symptom patched.
- **Re-pinning `SESSION_UNBOUND_HEIGHT_PX` at a different number.** The number is not the problem.

---

## Exit {#exit}

An arc.

The order that matters: first, the member spec in `deck-store-selectors.ts` reads one `Math.max` over the card's form policy and the deck-derived sheet floor, with a ceiling only from a banded form and a weight for everyone else ([B01], [B03]) — this is the change that fixes the screenshot, and everything after it is bookkeeping. Then the registration gains the unbound form policy and loses the scalar ([B04]), with `getStackSizePolicy` selecting it by form. Then the pin module becomes the opening bid: written in `addCard`'s commit, cleared by the first measurement ([B02]), and the binding-commit drop goes. Then the newcomer's arrival weight follows [B05], with `at0569` and `at0571` rewritten to assert the fit *and* that a newcomer on a roomy column takes the room — the roomy case is the one in the screenshot and the one no test has ever run. Then `tuglaws/pane-model.md` and D194's neighbours say what a member's height is, once. The by-eye look — a folded Session card above a new one on a tall canvas, with no band beneath — is the user's.
