<!-- brief-skeleton v1 -->

# The band's residual has a price, not a grade

**Purpose:** A Three Up + Flow deck clips a few dozen pixels off a content card at the band's edge, and the space allocator — whose one flow job is to end the band cleanly — does not spend the rail width that would fix it. The objective grades a cut as clean past a threshold instead of pricing the boundary that would remove it.

---

## Purpose {#purpose}

> "When we added additional gap to better differentiate the sidebar rails from the content cards, the layout-imposer's resize algorithm *was not* updated, which sucks, because to my mind, this algo *must* be tightly coordinated into all the changes we make whenever we touch *anything* to do with layout. … The negative effect can be seen here in the way that a Three Up + Flow layout now clips a *little bit* of the third content card. The imposer could have easily resized the sidebar rail widths to ensure this little content card clip didn't happen, but it failed to do so."

The screenshot: Three Up · Slim · Flow, Arcs and Overview on the left rail, Cards / Jots / Layout on the right, three 675px content cards. The first content card is clipped on its left by roughly thirty pixels; the Layout card's miniature reports "the deck scrolls".

---

## Evidence {#evidence}

**[F01] The gutter arithmetic was updated; the geometry is consistent** — `railSpanInsetPx` in `tugdeck/src/lib/layout-imposer.ts` carries `RAIL_EDGE_INSET_PX + width + RAIL_GUTTER_PX − IMPOSITION_GAP_PX`; `resolveSpan` reads it per standing rail; the allocator's flow objective (`sliverOfChain`) derives the band from that same `resolveSpan` less two gaps, the same derivation `DeckManager._flowBandWidth` makes. The allocator and the painted deck agree on where the band ends. The report's premise — that the resize algorithm was not updated for the gutter — is not where the defect is. **(verified, read out of the code)**

**[F02] The flow objective grades a cut, and the grade is zero at 32px and above** — `scoreRailTotal`'s flow key is `[hairlineOf(worstSliver), discomfort, distance]`, and `hairlineOf` returns the sliver only when `0 < sliver < SLIVER_PX` (32), else 0. Its comment says a cut at or past 32 is "an honest slice of a card" and "a perfectly good overflow affordance". **(verified)**

**[F03] The sweep games the threshold: a hairline is pushed to 33, not to a boundary** — a script driving `allocateSidebarWidths` with the screenshot's shape (three-up, flow, three 675px cards, rails preferring 420 with floors at 320 and comfort 380/320, ceiling 675) across canvas widths: **(verified, measured)**

| canvas | rails | band | residual (strip − band) |
|---|---|---|---|
| 2820 … 2860 | 420 / 420 | 1956 … 1996 | 79, 69, 59, 49, 39 |
| 2870 | 422 / 422 | 2002 | 33 |
| 2880 | 427 / 427 | 2002 | 33 |
| 2890 | 416 / 416 | 2034 | 1 |
| 2900 … | 420 / 420 | ≥ 2036 | strip fits |

At 2870 and 2880 a canvas that left a cut under 32 had its rails *widened* past preferred until the cut read 33 — the cheapest total that zeroes the first term — and the sweep stopped there. At 2890 the strip was 1px past the band and the rails were shrunk to fit; the residual then reads 1 rather than 0 because the answer is chosen from integer totals and the ties keep the smaller one. The 33px slice is the clip in the screenshot.

**[F04] Every residual from 33 up scores zero, however cheap the boundary** — at canvas 2860 the boundary is 39px of rail away and both rails stand 100px above their floors; nothing is spent. The doctrine in `tuglaws/pane-model.md` ("the rails absorb the residual") promises more than the code does: the code absorbs residuals under 32 only, and absorbs those the wrong way. **(verified, from the same sweep)**

**[F05] The threshold was itself a fix, and it over-corrected** — `hairlineOf`'s comment records that minimising the raw sliver once dragged a rail from the user's 420 to its 675 ceiling to take a 316px cut down to 61px, "still cut, still not a boundary, and the user's rail gone." Zeroing every cut past 32 stopped that and discarded the case that matters: a boundary a few tens of pixels away. **(verified, read out of the code)**

**[F06] The reveal moves the residual to where it is seen** — the objective is evaluated at flow offset 0 only, by design (rails that followed the offset would breathe as the strip scrolled). Activating the far card reveals it — `_flowRevealOffsetFor` slides the strip by the residual — and the slice lands on the near card's left edge, which is the state the screenshot is in. A boundary makes rest and reveal agree; without one the residual is the same size at both, on different cards. **(verified)**

**[F07] The allocator already runs at every moment that matters** — `_commitImposition` (arrangement changes, with `retuneRails`), `retuneSidebarAllocation` on the settled window resize (`deck-canvas.tsx`, `RESIZE_RETUNE_QUIET_MS`), on the maker-mode toggle in `main.tsx`, and on re-picking the standing kind in `setImposition`. Nothing about *when* is at fault. **(verified)**

**[F08] Nothing sweeps the allocator for residuals** — `layout-imposer-flow.test.ts` and `layout-imposer-solutions.test.ts` pin `hairlineOf`, `stripPicture`, and specific totals, and would have passed on every row of the table above; no test asserts that an affordable boundary is taken, so a gap or width constant can move the deck onto a bad row without a test noticing. **(verified)**

---

## Decisions {#decisions}

**[B01] The flow objective prices the nearest boundary instead of grading the cut.** For a candidate total the two boundaries are known in closed form: shrink the rails by `residual` so the strip fits (band = strip), or grow them so the band ends on the previous card's far edge. Each has a price — the rail width moved from preferred — bounded below by the hard floors and above by the shared ceiling. The flow key becomes `[cutIfUnpaid, discomfort, distance]` where a candidate that lands on a boundary reads 0 in the first term and one that does not reads the actual residual, so the sweep is drawn to a boundary rather than to the far side of a threshold. `hairlineOf` and `SLIVER_PX` are retired; a manufactured 33px slice becomes impossible because no boundary is at 33.

**[B02] One budget caps the spend, replacing the threshold as the flow objective's only tunable.** A boundary is taken when its price is within `RAIL_BOUNDARY_BUDGET_PX` of rail movement; beyond the budget the rails stay at preferred and the cut is an honest slice. The budget answers a question a person can reason about — "how far may a rail move to end the band cleanly" — where 32 answered one nobody asked. The 316px pathology from [F05] cannot recur: the budget caps the spend, the way the threshold never did. The starting value is a design call to feel out in the app rather than settle here; on the order of a fifth of a rail's range (~120px) reads right from the table, where a 39px or 79px boundary is plainly worth taking and a 316px one plainly not.

**[B03] Comfort is still spent before a cut is accepted, and the floors are still inviolable.** The current key already ranks the picture term above discomfort in flow; that ordering is kept. A boundary that costs a rail its comfort but not its hard floor is paid for; one that would breach a floor is not on the menu at all.

**[B04] When no boundary is affordable, prefer the larger residual.** Among candidates that all leave a cut, the tie-break inside the first term favours the total whose slice is largest — a cut near a card's middle reads as overflow, one near its edge reads as breakage — which is the opposite of today's drift toward "just past 32". This is the term's ordering, not a second threshold.

**[B05] A standing allocator census.** A unit test sweeps canvas widths across kind × content-width preset × rail count (one side, both sides, none) and asserts, for every row, that the residual is 0 or at least `RESIDUAL_READABLE_MIN_PX` when the boundary was within budget — so any change to `IMPOSITION_GAP_PX`, `RAIL_GUTTER_PX`, `RAIL_EDGE_INSET_PX`, a content-width preset, or a rail's size policy fails the same day it lands. It is the sweep in [F03] made permanent. This is the answer to the report's wider point: the allocator cannot be kept "tightly coordinated" by discipline, only by a test that reads every constant it depends on.

**[B06] The doctrine says what is promised.** The "band ends cleanly" paragraph in `tuglaws/pane-model.md` is rewritten to state the rule as built: a boundary when one is within budget, an honest slice otherwise, and never a slice manufactured to clear a threshold. [D166]'s reasoning about the lap in fit is untouched.

---

## Open Questions {#open-questions}

- **The budget's starting value**, and whether it is absolute or a fraction of the rail's `ceiling − floor` range. A fraction scales with policy changes; an absolute number is easier to read in a golden table. Settle by trying both in the app on the three-up and four-up decks at Slim and Comfy; the table in [F03] is the fixture.
- **Whether the fit branch wants the same change.** Fit has no residual (the strip never overflows), so the objective there is untouched by [B01]; but the census in [B05] should sweep fit too, asserting its own invariants (no overlap, no shortfall under comfort), so a gap change is caught in both modes.

---

## Non-goals {#non-goals}

- **Following the flow offset.** The objective stays evaluated at offset 0. Rails that resized as the strip scrolled would breathe under the user's hand; the design already rejected this and [F06] shows a boundary makes the question moot.
- **Changing when the allocator runs.** [F07]: every trigger is present. Adding a per-frame or per-activation retune would move rails on activation, which is the class of defect the last week was spent removing.
- **Re-deriving the gutter arithmetic.** [F01]: it is correct, and the same derivation serves the allocator and the paint. A second band formula "for the allocator" is the thing the current code was written to avoid.
- **Minimising the raw sliver.** The pre-threshold objective; [F05] records why it was removed and [B02] is what keeps it from coming back under another name.

---

## Exit {#exit}

**An arc.** The shape, in the order it must land:

1. The census first, red: the sweep from [F03] as a unit test over kind × preset × rails in `tugdeck/src/lib/__tests__/`, asserting the boundary-or-readable rule, so the objective change lands against a failing fixture rather than a passing one.
2. `scoreRailTotal`'s flow branch: the boundary price and budget from [B01]–[B04], `hairlineOf`/`SLIVER_PX` retired, the golden tables in `layout-imposer-flow.test.ts` and `layout-imposer-solutions.test.ts` re-derived and each changed row explained in its own words.
3. The doctrine paragraph, [B06].
4. The budget felt out in the app on the decks named in Open Questions, and the chosen value recorded beside the constant with the table that justified it.

Steps 1 and 2 must land together; 3 follows 2; 4 is last and may adjust one number.
