<!-- brief-skeleton v1 -->

# A place allocates its run, and never retires its sashes

**Purpose:** A rail's vertical space is divided equally or not at all: two members share the run at a draggable seam, three or more become a fixed `run / 2.5` strip that scrolls and drops its seams. Nothing in the deck knows how tall a card wants to be, so a rail whose members need 65% of the run pushes one of them off the bottom of the screen and takes the sash away at the same time.

---

## Purpose {#purpose}

> "The vertical space allocation algorithm for sidebar cards needs work. Just look at this situation I have right now. It basically makes no sense at all to push the Layout card off the bottom of the display. There's plenty of room for it. We simply do not have a sufficiently powerful rail-layout-imposer algorithm to make the best use of the available space and no sense about how to re-allocate space as the amount of content that needs to be displayed changes as elements (cards, jots, tripwires, etc.) comes and goes. We need this.
>
> We also seem to have lost the *adjustable sash* between sidebar cards. That must come back too."

The screenshot: a right rail carrying Cards, Jots and Layout. Cards shows two sessions and one file above six hundred pixels of empty list. Jots shows eleven rows above four hundred more. Layout is cut off partway through its preset row, and there is no sash anywhere in the rail.

The two complaints are one defect wearing two faces. The rail is in the **overflow** standing, which is what fixes every member's height and what retires every seam.

---

## Evidence {#evidence}

**[F01] The standing rule counts members and never asks the run** — `placeStanding` (`tugdeck/src/lib/layout-imposer.ts:3249`) is `count >= PLACE_OVERFLOW_MIN_MEMBERS ? "overflow" : "shared"`, with `PLACE_OVERFLOW_MIN_MEMBERS = 3`. It takes no run height, no floor, and no measure of what the members need. A three-member rail overflows on a 6K display exactly as it does on a laptop. **(verified, read out of the code)**

**[F02] An overflowing member's height is a constant fraction of the run, independent of its content and of how many members there are** — `overflowMemberHeight` is `run / PLACE_OVERFLOW_VISIBLE_MEMBERS` with `PLACE_OVERFLOW_VISIBLE_MEMBERS = 2.5`. Three members therefore make a strip of 1.2 runs and the third hangs 20% of the run below the fold; four make 1.6 runs. The overhang is a property of the constant, not of the cards. **(verified)**

**[F03] The screenshot is that arithmetic and nothing else** — measured off the image: the Cards→Jots title-bar pitch is 798 and Jots→Layout is 791 against a rail run of ~2000, i.e. 39.7% each where `1/2.5` predicts 40%; Layout's overhang is 385 against a predicted 400. **(verified by measurement on the screenshot, not instrumented in the app)**

**[F04] Everything in that rail fits in about two thirds of the run** — content extents read off the same image: Cards' last row ends ~420 into its 795, Jots' ~470, Layout's drawing and preset row occupy ~400. Roughly 1290 of a 2000 run. The deck put a card off the screen with 700px of headroom. **(verified by measurement on the screenshot; the per-card numbers are estimates, the order of magnitude is not)**

**[F05] The floors it could have consulted are already collected, and they fit** — `railMemberMinHeights` / `paneMinHeight` (`deck-canvas.tsx:539`) resolve each member's floor through `getStackSizePolicy(...).min.height`, and every sidebar registration declares `min: { height: 240 }`. Three members is 720 against a 2000 run. Those numbers exist today and are used for exactly one thing: clamping a seam drag. **(verified)**

**[F06] No card declares, publishes, or measures a vertical appetite** — every sidebar registration carries the identical boilerplate `min: { height: 240 }, preferred: { height: 900 }`, and `preferred.height` only ever sizes a free-floating card. There is no vertical counterpart to `comfortWidth` and no vertical counterpart to `greedRank`. No card reports its content height to anything on the layout path. **(verified across `cards-`, `jots-`, `layout-`, `arcs-`, `overview-`, `tripwires-card-registration.tsx`)**

**[F07] The width axis solved this problem and the height axis did not** — width has a three-tier policy per card (hard floor, comfort floor, preferred), a per-card greed rank, and `allocateSidebarWidths`, which sweeps every integer rail total against a scored objective. Height has `railSeamFractions` — equal weights unless a hand moved them — and a constant. The asymmetry is the whole of the complaint. **(verified)**

**[F08] The shared path is already N-ary; only the count rule caps it at two** — `railSeamFractions` loops `weights.length - 1` for any order, `memberPins` reads `seam(index − 1)` / `seam(index)` for any count, `RAIL_SEAM_EPSILON` keeps N − 1 fractions strictly increasing, and `deck-canvas.tsx`'s seam-property sweep already removes indices above the live count. A three-member shared rail with two sashes needs no new math. **(verified)**

**[F09] Seams retire on overflow by design, and the design's reason is [F02]** — the render gate is `deck-canvas.tsx:3908` for rails and `:3940` for columns; the doctrine is `tuglaws/pane-model.md:133`, "a division that no longer decides anything must not offer a handle". Under [F02] that is correct: every member is the same height by construction, so there is nothing for a seam to decide. The sash did not break — it was withdrawn because the geometry made it meaningless. **(verified)**

**[F10] The same doctrine explicitly forbids the obvious repair** — `pane-model.md:133` also says "Reinterpreting the weights against a virtual strip would silently change what a seam the user dragged had meant." Any decision that restores sashes in overflow has to answer that sentence rather than skip past it. **(verified)**

**[F11] The overflow constant is re-derived in twelve places across four files** — `deck-manager.ts` (6 uses: both reveal rules, both retunes, both offset commits), `drop-zones.ts` (2), `layout-miniature.tsx` (2), `deck-canvas.tsx` (2). Each computes a member height from the run by hand. Uniform heights are what make that survivable; per-member heights make it untenable. **(verified)**

**[F12] Nothing sweeps the vertical allocation** — no test asserts that a rail whose members fit is un-clipped, that a division sums to the run, or that a strip is longer than the run. `layout-imposer.test.ts` and `layout-imposer-columns.test.ts` pin `railSeamFractions` and `railSharesFromFractions` as pure functions and would pass on every picture above. **(verified)**

---

## Decisions {#decisions}

**[B01] The standing rule asks the run, not the count.** `placeStanding` takes the members' floors and the run: **shared** when the floors fit, **overflow** only when they do not. Three modest cards on a tall rail divide it; the same three on a short one scroll. `PLACE_OVERFLOW_MIN_MEMBERS` is retired — a count was always a proxy for "is there room", and the deck has the real quantity to hand ([F05]). This alone puts Layout back on the screen.

**[B02] A card declares a vertical appetite in three tiers, mirroring width.** `minHeight` (the hard floor, already registered and largely untuned), `comfortHeight` (the smallest height at which the card is doing its job), and `naturalHeight` (the height at which the card needs no internal scrollbar). `greedRank` is per-card and already exists ([F06]'s neighbour on the width side); it is reused verbatim as the vertical fill order rather than duplicated. A card that declares no comfort or natural height reads its floor for both, which makes the new tiers a no-op for it — the same permissive default `comfortWidth` already takes.

**[B03] `naturalHeight` is declared from state, never measured from the DOM.** A card computes it as a pure function of what it already holds — Jots from its row count, Cards from its sections and rows, Layout from a constant, since its drawing does not grow — and publishes it on a store keyed by componentId ([L02] on the way in, no layout read). A measured height would arrive after a layout and arm the settle a frame late, and it is the shape of the line-box metric loop that has bitten this codebase before: re-measuring on a geometry change when publishing is itself a geometry change.

**[B04] One allocator answers the whole question, and it is the only place heights are derived.** `allocatePlaceHeights(members, run)` returns a top and a height per member, and every consumer in [F11] reads it: the pins, the drop-zone tiles, both reveal rules, the autoscroll bands, the retunes, and the Layout miniature. This is the same move `resolveSpan` made for width, and per-member heights make it a precondition rather than a tidy-up — twelve hand-rolled derivations cannot agree about a non-uniform strip.

**[B05] The allocation is: floors, then comfort by greed, then weighted share capped at natural, then the remainder redistributed.** Every member is guaranteed its floor. What is left fills each member toward its comfort height, greediest first. What is left after that is the **discretionary pool**, divided by the stored weights, with each member capped at its `naturalHeight` — so Layout takes its ~400 and stops, and its surplus is redistributed to the members that still want more. When everyone is at natural and there is still room, the remainder is divided by weight uncapped: a rail's members are flush panels ([D181], `RAIL_SEAM_PX = 0`), so there is no air to leave and the run must be filled exactly.

**[B06] A share is a weight over the discretionary pool, not over the run.** This is the user's call between the two readings, taken explicitly: a dragged seam decides how the space *beyond comfort* is split, so appetite survives a drag instead of being discarded by it. Consequences, all intended: a seam clamps at its neighbours' comfort heights rather than at their hard floors; *Equalize Heights* means equal discretionary shares, which is equal heights only when every member's comfort is equal; and a rail with no discretionary pool has seams that cannot move, which is the honest report that there is nothing left to divide. Recorded as provisional at the user's direction — if it does not read well in the hand, [B06] is the decision to revisit, and the fallback is weights over the whole run, which is today's meaning extended to N members.

**[B07] An overflowing place sizes its members from their appetites, and `PLACE_OVERFLOW_VISIBLE_MEMBERS` retires.** When the floors do not fit, the strip is built from each member's comfort height (its floor when it declares none), so a strip carrying two small cards and one large one shows more of the small ones instead of three identical fifths. The half-visible affordance survives without being stated: if the floors do not fit the run, the strip is longer than the run by construction, and there is always something below the fold. `2.5` was the definition of overflow and becomes nothing at all.

**[B08] Seams never retire. A place always offers a sash between every pair of members.** [F09]'s reasoning was sound and its premise is gone: under [B07] an overflow strip's members have individual heights, so the boundary between two of them decides a real thing and must have a handle. An overflow seam is positioned along the **strip** — the same expression its two neighbours read, riding the side's offset property — rather than as a fraction of the run, and it may scroll out of the run like any other part of the strip. Its drag is **zero-sum between the two members it divides**: one grows, the other shrinks toward its floor, and the strip's total length does not change, so the scroll position does not move under the hand.

**[B09] [F10]'s objection is answered by the weight meaning the same thing in both standings, not by exempting overflow.** Under [B06] a weight is a claim on discretionary space relative to one's neighbours; under [B07] an overflowing member has discretionary space above its comfort height. So the pool's *size* differs between shared and overflow but the weight's *meaning* does not, and the [P02] property that actually protects the user is preserved by construction: `railSharesFromFractions` derives weights from segment lengths, so every member the drag did not touch keeps its ratio to every other untouched member. The doctrine sentence at `pane-model.md:133` is rewritten accordingly rather than deleted — what it forbade was reinterpreting a weight against a *uniform* strip, where it would have meant nothing at all.

**[B10] Content changes re-allocate on a settled quiet period, never per element.** The user's second ask — reallocating as cards, jots and tripwires come and go — is what [B03] makes possible, and it is also the hazard: an appetite that tracks a row count would move a seam under the hand of the person adding the row. So the allocation re-runs on arrangement changes and on a *settled* appetite change, on the `RESIZE_RETUNE_QUIET_MS` precedent the width retune already sets. The resulting allocation is a term of `arrangementSignature`, so the change **crosses** rather than cuts.

**[B11] A standing vertical census.** A unit test sweeps run heights × member counts × card mixes and asserts the invariants for every row: no member below its floor; in shared, the heights sum to the run exactly and no member is clipped; in overflow, the strip exceeds the run; and a member whose natural height is below its share is never given more than a redistribution allows. It is [F03]'s measurement made permanent, and it is the same argument `briefs/band-residual-price-brief.md` makes for the horizontal allocator — a layout constant that moves must fail a test the day it moves, not the next time somebody looks at a screenshot.

---

## Open Questions {#open-questions}

- **Whether a rail's members should be able to exceed their natural heights at all**, or whether a rail with more run than appetite should distribute the surplus (today's `1fr`-ish reading, and what [B05] specifies) versus growing only its most content-hungry member. The flush-panel constraint ([D181]) forces *someone* to take it; which member is a feel question. Settle in the app on a two-member rail with one fixed-height card.
- **What `comfortHeight` and `naturalHeight` actually are for each shipped card.** [B02] gives the tiers; the numbers are per-card design work that wants the card in front of you. The registrations' uniform `min: { height: 240 }` is boilerplate and should be re-derived at the same time.
- **Whether columns want [B07] and [B08] on the same schedule as rails.** `placeStanding` is deliberately axis-free and a column is the same kind of place, so the changes land in shared code either way; the question is only whether a column's overflow strip is retuned in the same step or a following one. Read the drop-zone tile arithmetic in `drop-zones.ts` when the arc opens — if the tiles cannot express a non-uniform strip for one kind of place without expressing it for both, there is no schedule to choose.

---

## Non-goals {#non-goals}

- **Measuring card content into the layout path.** [B03]: declared, not measured. A ResizeObserver on card content feeding the imposer is the loop this codebase has already been bitten by, and it buys generality nobody has asked for.
- **A card-level collapse to the title bar.** It is the direct way to say "Layout needs forty pixels right now", it composes with everything here, and it is its own feature with its own persistence and its own chrome. Out of scope so this brief stays about allocation.
- **Changing what a seam drag *is*.** The gesture, its live property write, its double-click equalize, and its commit through `railSharesFromFractions` all stand. [B06] changes what the committed weight means and [B08] changes where the handle is placed; the machine is untouched.
- **Re-tuning the horizontal allocator.** `briefs/band-residual-price-brief.md` owns that axis and is being walked separately. The one thing shared between them is the census argument ([B11]), which is deliberately made twice rather than factored into a dependency.
- **Serializing the allocation.** Heights stay derived, and offsets stay session state that nothing writes to disk — the reasoning at `pane-model.md:131` is unaffected by any of this.

---

## Exit {#exit}

**An arc.** The user has asked that this one be planned rather than walked from a task list; the `/arc` door still makes that call, but the request is recorded here because it is a fact about their intent and not an inference from the document.

The shape, in the order it must land:

1. **The census first, red** ([B11]) — the sweep as a unit test over run × count × mix, asserting the invariants, so every later step lands against a failing fixture rather than a passing one.
2. **`allocatePlaceHeights` and its twelve callers** ([B04]) — the function introduced returning today's answers exactly (equal shares at two, `run / 2.5` at three), and all twelve derivations in [F11] moved onto it. Behaviour is unchanged at this step and the census is still red; this is the step that makes the rest expressible.
3. **The standing rule and the allocation** ([B01], [B05], [B06]) — floors decide the standing, comfort and natural fill the run, weights divide the discretionary pool. The census goes green for the shared cases here.
4. **Overflow sized from appetites** ([B07]) — `PLACE_OVERFLOW_VISIBLE_MEMBERS` retired, the strip built from comfort heights, the reveal and autoscroll arithmetic reading step 2's function rather than the constant.
5. **Seams in overflow** ([B08], [B09]) — the strip-relative seam position, the zero-sum drag, and the doctrine paragraphs at `pane-model.md:103`, `:131` and `:133` rewritten.
6. **Appetites declared** ([B02], [B03]) — the store, the per-card `comfortHeight` / `naturalHeight`, and the quiet-period retune ([B10]). Last, because every step before it is testable with the floors alone, and because the per-card numbers are design work that wants the built allocator in front of it.

Steps 1 and 2 must land together or the census has nothing to run against. 3 must precede 4 and 5. 6 is separable and could be walked as its own arc if the first five run long.
