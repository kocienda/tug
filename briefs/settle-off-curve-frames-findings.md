# No frame off its own curve: what was measured, and what the instrument was reading instead

**2026-09-24.** Release build, one machine, `tests/app-test/at0622-deck-settle-frames.test.ts` and `tests/app-test/at0624-reveal-travel-on-curve.test.ts` driving `tugdeck/src/lib/settle-frame-probe.ts`. Arc `settle-off-curve-frames`, against `briefs/settle-off-curve-frames-brief.md`.

This is the paper `[B08]` of that brief asks for: `offCurveTicks` before and after, on the same legs, on the same machine, with nothing claimed that a reading does not carry.

**Three of its four headlines are negatives, and they are stated first because that is the discipline the prior arc's paper had to restate four separate times.**

**The forced leg was green before the fix.** Reverting the settle's `fill: "backwards"` under `tugtool file probe --patch`, with the corrected instrument in place, reads `offCurveTicks: 0` on `at0622`'s four-up forced leg — the leg the brief nominated as its reproduction and its falsification. The backwards fill landed on `[B01]`'s argument, not on a measurement, and no part of this work may say it repaired a measured defect on that leg.

**The 17-of-23 reading that justified the urgency was the instrument.** The first assertion of the bar read 17 of 22 ticks off-curve on all four panes of the plain four-up leg. Every one of those ticks was a frame moving exactly as asked, a fraction of one frame behind the clock the probe compared it against. The deck was not painting off its curve there. See [The instrument correction](#the-instrument-correction).

**The reveal path was never off its curve either.** `at0624` was written for the user's second report — a file that opened into a slot the band does not show and "did not animate to it". It reads zero, and it reads zero with the fill reverted. It is a regression pin, not a repair.

**One headline is positive, and it is the beat boundary.** With the instrument corrected, a real off-curve tick survived: one tick, at an offset of 364–369ms on the four-up and eight-up legs and ~186ms on the height-bearing column legs, intermittent on the transform-only legs and reproducible on the column ones. That is `[F09]`'s hand-off between two beats, it was reachable by no fill, and building `[B03]`'s single-timeline shape closed it on every leg. That closure is the one measured improvement this work claims.

---

## The numbers

All readings are `offCurveTicks` / `pendingTicks` / `longestOffCurveRunTicks` / `longestOffCurveRunOffsetMs`, taken from the product's own `settle-frames` row where the leg has one and from the bench probe where it does not. `-1` in an offset column is the field's "no run" value, not a missing reading.

The **before** column has to be split in two, because the instrument moved between them and a single "before" would be a lie in one direction or the other.

| leg | before, shipped instrument (`ae87b9d18`) | before, corrected instrument (`8d7d0f1e3`–`dbd052944`) | after (`e1b64b3cb`, re-read 2026-09-24) |
|---|---|---|---|
| four-up plain, row | 17 / 0 / 17 / 0ms (of 22 ticks) | 0–1 / 0 / 0–1 / −1ms or ~365ms | **0 / 0 / 0 / −1ms** (of 23 ticks) |
| four-up plain, probe | 17 / 0 / 15 / 0ms | 0–1 / 0 / 0–1 / −1ms or ~365ms | **0 / 0 / 0 / −1ms** (of 60 ticks) |
| four-up forced, row | 6 / 0 / 6 / 0ms (of 14 ticks) | 0 / 1 / 0 / −1ms | **0 / 1 / 0 / −1ms** (of 15 ticks) |
| four-up forced, probe | 5 / 0 / 4 / 0ms | 0 / 1 / 0 / −1ms | **0 / 1 / 0 / −1ms** (of 55 ticks) |
| eight-up plain, row | 17 / 0 / 17 / 0ms (of 23 ticks) | 0–1 / 0 / 0–1 / −1ms or ~364ms | **0 / 0 / 0 / −1ms** (of 23 ticks) |
| eight-up plain, probe | 17 / 0 / 15 / 0ms | 0–1 / 0 / 0–1 / −1ms or ~364ms | **0 / 0 / 0 / −1ms** (of 60 ticks) |
| column split (height-bearing), probe | 51 / 3 / 43 / 31ms (of 67 ticks) | 1 / 3 / 1 / ~186ms | **0 / 3 / 0 / −1ms** (of 66 ticks) |
| column stack (height-bearing), probe | 41 / 2 / 27 / 159ms (of 64 ticks) | 1 / 1–2 / 1 / ~186ms | **0 / 1 / 0 / −1ms** (of 65 ticks) |
| reveal plain, row | *(no test; the gesture had no pin)* | 0 / 1 / 0 / −1ms, fill reverted under probe | **0 / 1 / 0 / −1ms** (of 24 ticks) |
| reveal plain, probe | *(no test)* | 0 / 1 / 0 / −1ms, fill reverted under probe | **0 / 1 / 0 / −1ms** (of 143 ticks) |
| reveal forced, row | *(no test)* | 0 / 1 / 0 / −1ms, fill reverted under probe | **0 / 1 / 0 / −1ms** (of 24 ticks) |
| reveal forced, probe | *(no test)* | 0 / 1 / 0 / −1ms, fill reverted under probe | **0 / 1 / 0 / −1ms** (of 177 ticks) |

Three things about the cells rather than the numbers.

**The reveal legs have no "before" in the first sense**, because no test walked that gesture before this arc wrote one. What stands in the column is the honest substitute and the only one available: the same test, the same machine, with the fix reverted underneath it by `tugtool file probe --patch`. It is a before in the sense that matters for `[B08]` — a reading of the unfixed product — and it is not one in the sense of a reading anybody took at the time.

**The ranges in the middle column are ranges because the readings were intermittent**, and that is the finding rather than sloppiness. The boundary tick appeared on four-up in one run and eight-up in another and on neither in a third. The column legs were the reproducible ones, which is why they are the legs that argued the boundary was real.

**`pendingTicks` did not go to zero and was never asked to.** The forced legs, the reveal legs and the height-bearing column legs all still spend a tick or three in the play-pending window. That is the condition `[F03]` named; what changed is that a frame inside that window now paints its start pose rather than its destination, so a pending tick is no longer an off-curve tick. A `pendingTicks` of 0 would mean the compositor hand-off got faster, which nothing here attempted.

**The forcing probe passed alongside every reading above.** Four-up forced saw a 216ms worst gap against a 200ms planted task; reveal forced saw 215ms. A sampler that has quietly stopped observing and a deck that has stopped painting off-curve produce the same zeros, and nothing here is offered without the leg that separates them.

---

## The instrument correction {#the-instrument-correction}

This is a finding in its own right and the largest one in the paper: **the shipped `offCurve` could not tell a frame painting the wrong pose from a frame painting the right one, and it reported the second as the first on nearly every tick of a fast beat.** Three mechanisms were named when the correction was made. Two of them the measurement confirmed. One remains a reading of the specification, and is labelled as such here rather than being allowed to pass as measured.

**Confirmed by measurement: the verdict was inferred from pendingness rather than compared against the curve.** The shipped field asked whether a transform-bearing effect existed whose clock had not advanced, and called that "off-curve". Replacing it with a comparison — the pose the element *computes* against the pose its own curve *says* it should hold — took the plain four-up leg from 17 off-curve ticks to 0 with no change whatsoever to the product. The detail probe that did it is the evidence: pane `at0622-p1` at progress 0.16 computed a translate of 796.58px where its curve at that progress was 818.74px, on a travel of 1493px. `getComputedTiming().progress` and `getComputedStyle().transform` are two clocks read in the same JS tick that do not answer for the same instant, and a fixed half-pixel comparison against a single sampled pose reports that skew as a defect. The comparison is now containment in the segment the pane's own curve spans across the neighbouring ticks, per axis, widened by the half-pixel floor — nearness to one of three discrete poses is a different test and does not work, because a frame a third of a frame behind lands between two of them and is near neither.

**Confirmed by measurement: the settle's Last pass already writes an inline origin transform, and the instrument read it as residue.** `applyHolds` in `tugdeck/src/components/chrome/deck-canvas.tsx` writes the constant transform a resize beat wears while the move has not yet run, inline rather than as a keyframe, so the move beat's own effect stays transform-only and accelerated. A pane sitting between two of its own beats therefore computes a real translate that is exactly correct — and the shipped read called it residue for 43 consecutive ticks. The fix reads a pane's window from both ends, `firstEffectTick` and `lastEffectTick`, so only a pane past its **last** effect owes the identity.

**A reading of the spec, not a measurement: why a play-pending animation's local time resolves at offset 0.** What *was* measured is the observable — a play-pending animation's `currentTime` reads a resolved `0` in this WebKit, never `null`, which is the opposite of what the shipped `movePendingOf` docblock asserted and is why the probe's pending window had been invisible since it was written. The explanation offered for it — that the animation's hold time is 0, so the effect's local time resolves at offset 0 rather than being unresolved — is read off the Web Animations model and was not independently verified here. The correction does not depend on it: the read is now `startTime === null`, which is true under either explanation.

**The correction cost one unit expectation and moved it twice, and both moves are recorded rather than adjusted away.** The residue count in `tugdeck/src/lib/__tests__/settle-frame-probe.test.ts` went 31 → 30 when the hand-off tick was admitted, and 30 → 29 when the classifier learned that a curve's pinned end pose is a legal candidate on an effect's **last** tick — which is what the four-up and eight-up legs' single 365–369ms tick turned out to be, on every pane at once.

**The lesson generalizes past this arc.** A measurement of motion has to be a comparison against the motion's own model at the instant sampled, with a tolerance derived from the sampling skew rather than from the property's units. A half-pixel floor against a single instant is a threshold on a quantity nobody measured.

---

## What closed the boundary

`[F09]`'s hand-off was the one real defect the corrected instrument found, and `[B03]`'s second admissible shape closed it: every launched beat's effect is created in one frame, with `delay` equal to the sum of the launched beats before it. The `BEAT_ORDER` promise chain survives as the completion notifier it also was, and sequences nothing.

Three secondary mechanisms had to be found before the shape worked, and each is a fact about this codebase worth having written down.

**Every beat needs its own animator slot.** `TugAnimator`'s named slots snap an incumbent to its end when a new animation claims the same key, so with all six beats sharing `imposer-flip` the creation of each beat finished its predecessor on the spot. That is also the explanation for why the promise chain had been load-bearing: it hid the collision by never letting two beats exist at once.

**A delayed beat fills `none`, not `backwards`.** A backwards fill on a delayed resize beat keeps that resize in effect all through the move, which costs the transform-only promise. `at0566-three-beat-settle.test.ts` read it as a 2.8px interior drift. The fill is `backwards` only for the beat at delay 0 — the one whose play-pending window is the thing the fill exists to cover.

**The beat announcement rides the animation clock.** `settleBeatRef` and the `data-imposer-beat` attribute advance off an empty marker effect on the document timeline rather than off a `setTimeout`, because a timer and an animation clock skew far enough apart to fail a 37.7px assertion on the shrink beat.

---

## The brief's open questions

**`[Q01]` — whether `at0566`'s two-device-pixel seam is `[F09]`'s boundary. Answered: yes, and it is closed.** The brief hoped the new instrument would settle it in the same run that measured everything else, and it did. `at0566` named the hole exactly — a shrink ending at 237ms against a move starting at 254ms, and a move ending at 414ms against a grow starting at 433ms — a dropped frame at each hand-off, which is the same event `at0622`'s column legs read as one off-curve tick at ~186ms. Building the single-timeline shape closed both: `at0566` is green with interior spreads of 0.02–0.53px where it had carried a two-pixel seam, and the column legs read 0. A standing puzzle from the prior arc is retired rather than carried forward.

**`[Q02]` — whether the reveal-after-arrival commit should exist at all. Deferred, and the evidence for deferring it is `at0624`'s numbers.** The design question the brief posed is real and this work does not settle it: whether the second beat must be a second *settle*, rather than a delayed beat of the first one under the timeline shape that now exists. What has changed is the urgency. The reveal path reads `offCurveTicks: 0` idle and under a 200ms planted task, on a 1618px travel, and read 0 with the fill reverted as well — so there is no defect pressing the question. It is now a question about the shape of the code and the perception argument in `_revealAfterArrival`'s own docblock, to be taken on those merits by whoever takes it. `at0624` is the pin that will notice if the answer regresses the travel.

**`[Q03]` — how long the pending window is on a real deck rather than on the harness fixture. Open, with a channel and no reading.** The off-curve fields ride the in-product `settle-frames` record, which is what the brief called the cheaper of the two answers, and that shipped in this arc's first round. Nobody has taken the reading on a loaded deck, and this arc could not: every number in this paper is the harness's. The fixture seeds session cards with empty transcripts and the condition tracks main-thread load, so the harness's pending window is a lower bound on the product's and is not offered as anything else.

---

## What is left pointing at the user's report

**Two settle exits are not demonstrated, and the test that was written for `[B02]` says so in its own words.** `at0622`'s three cancellation legs — a planted stall, a retarget 80ms into the move beat, and a space switch mid-flight — are green, and all three release from `"completion"`. The stall does not outlast the settle's own completion handler, which runs as soon as the thread comes back, and a space switch swaps the shown layer without tearing the canvas down. So the window sweep and the canvas unmount were reached by no leg, and `[B02]`'s "a demonstrated cancel on every exit" is satisfied **for completion-released gestures only**. Under `fill: "backwards"` an exit that does not cancel strands a frame at its origin, which is worse than the defect that was fixed, so this is the one open item with a downside attached. Reaching those two clocks wants a harness door `at0622` does not have.

**`[Q03]` is the reading that would answer the user's original report on the user's own terms.** Everything here says the deck holds its poses on a harness fixture. The report was about a loaded deck, and the channel to read one is in place and unused.

**Nothing else is left pointing at the two reports.** The activation gesture is pinned at `offCurveTicks === 0` on four-up plain, four-up forced, eight-up, and both height-bearing column legs; the file-link gesture is pinned on the one path nothing else walks; and the bar goes red the moment a frame paints a pose its own curve does not pass through.

---

## Inherited reds, so a later reader does not attribute them here

Recorded in the arc's own baseline and re-stated because a findings paper is where somebody looks: `at0605-still-crossing-deliveries.test.ts` (measured on the base through a reverse-diff `tugtool file probe` — the same distribution with and without this work), `at0347-stack-badge-picker.test.ts` and `at0430-resize-scroll-preservation.test.ts` (both red back to `e4fa38cb0`, which predates this branch), and `just app-test-covers-check`'s subtree width for `tugdeck/src/components/jots/`, which is somebody else's directory and somebody else's change to answer.
