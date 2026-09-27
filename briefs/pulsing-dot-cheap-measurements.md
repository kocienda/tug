# The pulsing dot, cheap: measurements

The before-readings for the `pulsing-dot-cheap` arc, taken on 2026-09-26 against the running `release-main` instance (pid 45557, port 55348, WebContent pid 45622) at `9d2e7b782`, with sessions streaming throughout. Every reading below was taken through the same door and by the same commands, so the after-readings the later steps append are comparable to them by construction.

**How to retake any row.** `tugtool deck motion enable` opens `POST /api/eval` on the instance; `tugtool deck motion cost --frames 90` reads the page's own frame probe; `tugtool deck motion list --json` gives the animation census the population column counts from; `sample 45622 3 -f <path>` takes the process sample the symbol columns are parsed out of, counting only the main thread's call-graph block.

---

## What the instrument can and cannot see

**The `cost` probe is not usable as this arc's before/after number, and it was not used as one.** Every one of its samples on this deck came back flagged `*` — a session was mid-turn for the whole window — so what it measures is dominated by streaming render work that has nothing to do with the dots. The proof is the demoted row below: with *every* long-running loop stilled, the probe read the same p50 and a *worse* max than with them running. A number that does not move when the thing it is supposed to be measuring is switched off cannot convict the thing when it is switched on.

**The `sample` symbol counts are the instrument.** They separate cleanly: stilling the loops takes `computeExtentOfTransformAnimation` and `updateCompositingLayersAfterStyleChange` to exactly zero, which is the control that proves the counts are reading the loops and not the deck's background work. Those two counts, taken at a recorded dot population, are what the later steps' readings must be compared against.

**One consequence for the plan.** [F01]'s "6 ms floor, 0–1 ms when stilled" does not reproduce on today's deck under streaming load, in either direction: the shipped p50 is 1 ms, not 6, and the demoted p50 is also 1 ms, not 0. This is an instrument finding, not a falsification of [F01] — [F01]'s readings were taken on a quieter deck. It does mean Step 2's checkpoint should be read against the extent-computation count, which is the column that discriminates, rather than against the frame-cost percentiles, which on this deck do not.

---

## Reading 1 — shipped

The dot as it ships: 21-stop sampled `linear` keyframes, three loops per dot.

| Reading | Population (breathing dots) | p50 | p95 | max | `computeExtentOfTransformAnimation` | `updateCompositingLayersAfterStyleChange` | main-thread samples |
|---|---|---|---|---|---|---|---|
| shipped | 20 | 1.00 ms | 7.00 ms | 10.00 ms | 22 | 97 | 1907 |

Census at the time of the reading: 67 long-running animations, 0 violations — 20 × `breathe`, 20 × `emit-expand`, 20 × `emit-fade`, plus 2 `tug-arc-lifecycle-mark-breath`, 3 `tugx-progress-wave-*`, 1 `tug-text-editor-caret-blink`, 1 `tug-arc-track-breath`.

## Reading 2 — demoted (the control)

`tugtool deck motion demote on`, which stills every long-running loop. This is the floor, re-taken on today's deck.

| Reading | Population | p50 | p95 | max | `computeExtentOfTransformAnimation` | `updateCompositingLayersAfterStyleChange` | main-thread samples |
|---|---|---|---|---|---|---|---|
| demoted | 0 | 1.00 ms | 7.00 ms | 18.00 ms | 0 | 0 | 1865 |

**Both symbol counts go to zero and the frame percentiles do not move.** That is the whole case for reading this arc off the symbol columns: the loops are entirely responsible for the two counts, and entirely invisible in the percentiles under streaming load.

## Reading 3 — injected (the predicted after)

The Spec S01 blocks injected under the scratch prefix `pdcx` through `/api/eval`, with `--tugx-progress-pulsing-dot-breathe-name`, `-emit-expand-name` and `-emit-fade-name` pointed at them on `:root`. No product code changed. This is the reading Step 2 must reproduce from the source.

| Reading | Population | p50 | p95 | max | `computeExtentOfTransformAnimation` | `updateCompositingLayersAfterStyleChange` | main-thread samples |
|---|---|---|---|---|---|---|---|
| injected | 22 | 1.00 ms | 12.00 ms | 20.00 ms | 8 | 86 | 1936 |

The injection was then removed and the readings returned to shipped levels (48 and 120 at a population of 23), so the injection is proven to be what moved them.

## Reading 4 — the paired A/B

Because the single-shot readings above were taken at drifting populations and the deck's load varies minute to minute, the comparison was retaken as three alternating shipped/injected rounds at an **identical population of 23 dots**, each a fresh 3-second `sample`.

| Round | Population | `computeExtentOfTransformAnimation` | | `updateCompositingLayersAfterStyleChange` | |
|---|---|---|---|---|---|
| | | shipped | injected | shipped | injected |
| 1 | 23 | 17 | 4 | 74 | 69 |
| 2 | 23 | 21 | 8 | 79 | 78 |
| 3 | 23 | 28 | 5 | 95 | 75 |
| **mean** | 23 | **22.0** | **5.7** | **82.7** | **74.0** |

**[P01] holds, and the margin is not marginal.** The extent-computation count falls to **0.26 of shipped** — inside the plan's "at or below one third" bar — and the two distributions do not overlap: every shipped round exceeds every injected round.

**The compositing walk itself does not shrink, and the plan should not expect it to.** `updateCompositingLayersAfterStyleChange` moves only from 82.7 to 74.0, about a tenth, which is within the round-to-round spread of the shipped column alone. What Spec S01 removes is the *per-keyframe extent sampling inside* the walk, not the walk. The walk is driven by the deck's style changes, and those are Step 3's target, not Step 2's. A Step 2 after-reading that improves the extent count and leaves the compositing count flat is the expected result, not a shortfall.

---

## [Q01] — which coordination failure the user sees

**At rest, nothing separates.** With the injection removed and the deck steady, all 24 mounted dots reported a `startTime` spread of exactly **0** across their three CSS animations, and identical `currentTime`. The three loops share one `animation-duration`, and in the steady state they share one clock. The report is not a steady-state drift.

A per-frame watcher was installed through `/api/eval` over `requestAnimationFrame`, sampling every `.tug-progress-pulsing-dot`'s animations each frame and recording any `startTime` spread above 0.5 ms, across the deck's ordinary session activity.

**One methodological correction worth recording, because the next observer will hit it.** The first watcher read `root.getAnimations({ subtree: true })` unfiltered and reported a 7531 ms spread. That was **not** a dot/ring separation: the list includes the element's CSS *transitions*, which have their own `startTime` and no `animationName`. Spec S02's filter to `CSSAnimation` is load-bearing for the measurement as well as for the weld, and any reading of these clocks must apply it. The corrected watcher filters to named animations matching `pulsing-dot`.

**The corrected watcher then ran for 4026 frames and recorded zero separations.** Over that window it observed **6 real gate flips** — `data-breathing` / `data-emitting` transitions on live dots, driven by the deck's own session activity — and the maximum `startTime` spread across every dot on every frame stayed at **0**. So the weld held across six ordinary crossings, not only at rest.

**What this step can and cannot conclude.** It can say that **no separation was observed on this deck at all**: not in the steady state across 24 dots, and not across 6 live gate flips in 4026 frames. It cannot say the three paths [Q01] names are clean, because they were not driven deliberately — the watcher ran against whatever the live sessions happened to do, and the specific paths (a resume while the last settle's pulse is in the air, a phase flip during the inhale, a render landing mid-rejoin) each need provoking rather than waiting for. Six flips is not six of *those* flips.

So [Q01] stays open, and it is carried to [#step-4](#step-4) with an instrument rather than only a question: the corrected filtered watcher above is what Step 4 re-runs, with the three paths driven. The Step 1 answer to record is the negative — **no coordination failure reproduced on the paths that happened to occur** — which raises the odds that [P04]'s value is the invariant rather than a fix for a sighted bug, and that is the footing Step 4's task already anticipates.

---

## Baseline at `9d2e7b782`

The arc's worktree was clean and identical to `main` when these were taken.

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | green |
| `bun run audit:motion` | green — 312 stylesheets, 1114 TypeScript files |
| `bun test src/components/tugways/__tests__/ src/lib/code-session-store/__tests__/` | **1 pre-existing red**: `native-verb-claims.test.ts` — "only selection surfaces register them as responder actions". 2248 pass, 1 fail. Unrelated to the dot; red before this arc touched anything. |
| `at0619-session-dot-overlay.test.ts` | last green 2026-09-26 at `b87f29c99` (run of 50 files) |
| `at0629-motion-render-cost.test.ts` | last green 2026-09-26 at `3f3627d65` (run of 2 files) |

---

## Reading 5 — the after, driven from the source

Taken after the generator was rewritten, at `9d2e7b782` + this arc's Step 2. The instance is still the release deck at 55348; what changed is where the blocks came from.

**What was measured, and what was not.** The running instance is a release build of `main`, so it does not contain this arc's code. What was injected is the **byte-for-byte output of `breathKeyframes(0.3, "tugx-progress-pulsing-dot")` as this worktree's source now emits it**, re-prefixed to a scratch name and pointed at through the same three `--…-*-name` override hooks. That output was first checked against Step 1's hand-written Spec S01 injection and found **identical**, so the generator reproduces the spec exactly. This is therefore a real measurement of the bytes the change produces, hosted in a deck built from the base — not a measurement of a release build of the arc. Hosting it this way is what makes the comparison a **paired A/B on one deck within one minute**, which controls for the machine load that made the single-shot readings in Step 1 so wide.

Three alternating rounds at an identical population of **32 dots**, each a fresh three-second `sample`:

| Round | Population | `computeExtentOfTransformAnimation` | | `updateCompositingLayersAfterStyleChange` | |
|---|---|---|---|---|---|
| | | shipped | source | shipped | source |
| 1 | 32 | 35 | 7 | 107 | 92 |
| 2 | 32 | 21 | 5 | 78 | 63 |
| 3 | 32 | 33 | 4 | 94 | 67 |
| **mean** | 32 | **29.7** | **5.3** | **93.0** | **74.0** |

**The Step 2 checkpoint is met.** The extent-computation count falls to **0.18 of shipped** — the bar was at or below one third — and again the distributions do not overlap: the best shipped round (21) is three times the worst source round (7).

**Two things worth carrying forward.** The extent count barely moves with population: 5.7 at 23 dots in Step 1, 5.3 at 32 dots here, against a shipped column that scaled from 22.0 to 29.7. That is the expected shape — the shipped cost is per-dot-per-keyframe and the new cost is near the floor. And `updateCompositingLayersAfterStyleChange` again falls only about a fifth (93.0 to 74.0), consistent with Step 1: the walk itself is driven by the deck's style changes, which is Step 3's target rather than Step 2's.

**Census.** `at0629-motion-render-cost.test.ts` passes against the new form with an empty violation list at 900 long-running animations in its bench, which is the instrument that would convict a demoted loop by name (Risk R02). The new easing form therefore qualifies, and `bun run audit:motion` is clean across 312 stylesheets.

---

## [P03]'s two inferred claims, settled

Both were read on the running release deck through `/api/eval` before the flush sweep was trusted, and both are now also gated by an app-test leg in `at0619-session-dot-overlay.test.ts` so they cannot quietly stop being true.

### (a) `getAnimations()` is a real flush, including on an element with nothing to report — **confirmed**

The hazard was a fast path: if `getAnimations()` returned early on an element carrying no animations, the first-paint seed would coalesce with the pose after it and every crossing would fire from the stale pose — a tear that no static reading of the DOM would show.

Probed on the exact shape the seed sites use. Write `transition: none` and a pose, flush, release the transition, write a second pose, then read the resulting `CSSTransition`'s **first keyframe**:

| Flush | Transition starts from |
|---|---|
| `el.getAnimations()` | `scale(0.5)` — the seeded pose |
| `void el.offsetWidth` | `scale(0.5)` — identical |
| none | `scale(1)` — the pose *before* the seed |

The no-flush arm is what makes the other two mean something: the probe demonstrably can tell the difference, and the two flushes are interchangeable for this purpose. So `flushStyle` may be `getAnimations()`, and the four well sites were swept.

**One methodological note for whoever re-runs this.** A first attempt declared the transition and the starting pose together in `cssText` at insertion, and reported *no transition at all* on any of the three arms — which reads exactly like a flush failure and is only a broken probe. An element has no before-change style on its first resolution. The transition must come from a rule that exists before the element, with the starting pose written inline and settled, before the seed means anything.

### (b) `getComputedStyle(el).transform` **does** force layout on this WebKit

Measured by cost: dirty layout, then read, 2000 times.

| Read | ms |
|---|---|
| `getComputedStyle(el).transform` | 40 |
| `void el.offsetWidth` | 39 |
| `el.getAnimations()` | 19 |
| nothing | 1 |

`getComputedStyle().transform` is therefore **not** a cheaper substitute for `offsetWidth` — it is the same price. `getAnimations()` is roughly half, and far above the empty-loop baseline, so the read is real rather than optimized away: it resolves style and stops there.

**The consequence, as [P03] anticipated, is a finding for a follow-on rather than a reason to stop.** `liveScale` reads `getComputedStyle(el).transform`, so the running→settled pin and the settled→running hand-back still force layout after every `offsetWidth` in the file is gone. Two forced layouts per crossing per dot remain, and they are not what this step set out to remove. Removing them means getting the live scale from somewhere other than computed style — the breath animation's own `currentTime`, which is exactly what [#step-4](#step-4) builds for a different reason. Whether the pin can then read it instead is a question for after that step, not before it.

## [Q01], closed by observation: nothing separates, on the shipped build, anywhere

The question was which of three named paths the reported dot/ring coordination failure arrives by. The answer this record can give is **none of them, as far as two instruments can see** — so the weld is worth having as an invariant, and is not a fix for a sighted bug. That is a weaker claim than the plan hoped for and it is the one the readings support.

### The first watcher read the wrong observable, and its zero meant nothing

The obvious reading is each loop's `startTime`, and on the running release deck it gave a spread of **0** over 22,924 frames, 406 dot positions and 317 gate transitions, with not one sample above half a millisecond.

**Discard that reading.** On the shipped build the loops are phase-shifted with a *negative `animation-delay`* written through two custom properties, not by moving `startTime` — which is the whole reason this arc replaces the mechanism. Two loops a quarter cycle apart on the shipped build have **identical** `startTime`s and always did. A zero there is the instrument agreeing with itself.

This is worth writing down because the number looks like an answer. Anyone re-running it on a build from this arc onward will get a zero that *does* mean something, and the two zeros are not the same fact.

### The second read effective phase, which is the observable

`effect.getComputedTiming().progress` resolves the delay, so it is where a delay-induced separation shows. All three loops share one duration and the ring's blocks are written against the breath's cycle, so a welded glyph reports one progress across all three; a separated one does not. Spread taken circularly, since 0.99 and 0.01 are a hundredth apart rather than 0.98.

| Reading | Value |
|---|---|
| Frames sampled | 37,626 |
| Dot positions seen | 367 |
| Gate transitions (loop count changing on a dot) | 220 |
| **Max phase spread, any dot, any frame** | **0** |
| Samples above 0.01 of a cycle | 0 |

Two hundred and twenty gate transitions on live sessions, and not one produced a measurable phase difference between a dot's breath and its ring.

### What that does and does not settle

- It does not clear the architecture. [F08] describes an arrangement in which separation is *possible*, and a watcher that never catches it running has not proved it cannot happen — the three named paths were reachable only by whatever the observed sessions happened to do, not driven deliberately, because the harness that could drive them has no shipped build under it.
- It does mean the failure the user reports is **not** the one this arc's [P04] removes, or else it is rare enough that neither instrument met it across sixty thousand frames.
- So [P04] is carried on its own merits, which the plan states independently: one clock by construction, no forced reflow, no phase variables, and an invariant that a test can read back. The arc should not be measured against a reproduction it never had.

**The one thing the weld now buys that the old arrangement could not is a test.** "The two loops were started in the same style flush" is a claim about an ordering nothing can read back after the fact; "every loop under this root reports the same `startTime`" is a claim about data. `at0629` asserts it over three hundred bench glyphs, before and after a forced style recalculation, and `at0619` asserts it on a real session's dot crossing from settled to running. A separation of the kind [Q01] went looking for would now be caught by a red test rather than by a user noticing a glyph looked wrong.

### What is still uncovered, and why

The resume-**mid-pulse** arm of [P05] — a session that stops and resumes inside one breath, so the breath is welded to a ring already in the air — is **not asserted anywhere**. It is not for want of trying: the only settle the app-test harness can drive on a bound session is a transport close, and after one the masthead mark is unmounted outright. Sampled every 250ms for 15 seconds following a reconnect and a second send, the selector answers `gone` and never anything else, so there is no element left to read a weld off.

That arm runs the same `startLoops` both asserted legs exercise; what is unasserted is specifically the **well's absorb** — the pin at `live / welded` and its release to 1. A follow-on wants a driver that can return a bound session to `running` after a settle, and that is a harness change rather than a component one.

## The tripwire's own reading, and the control that makes it mean something

The `at0629` streamed-commit leg drives one `data-*` attribute write per frame on an element that animates nothing, over the bench's own 300 breathing dots, and prices the frame three ways. Three consecutive runs on the arc's build:

| Reading | mean (ms) | p50 | p95 | Run-to-run mean |
|---|---|---|---|---|
| Quiet — nothing driving commits | 3.38 | 3 | 6 | 3.38 / 3.27 / 3.37 |
| **Streamed — one innocent commit per frame** | **3.58** | **3** | **6** | 3.58 / 3.58 / 3.67 |
| Streamed, with every loop demoted | 0.32 | 0 | 1 | 0.32 / 0.30 / 0.17 |

Budget is 16 ms, so the streamed reading is comfortably under it — which is the claim the leg exists to assert.

### Read the two controls differently; one of them is much stronger

**The demoted control is the finding.** The same per-frame commit, on the same page, with `--tug-loop-iterations: 0` stilling every loop, costs **0.3 ms against 3.6**. An order of magnitude of the streamed frame's cost is the 300 running dots being re-priced on every compositing update — exactly what the engine-cost model says, and now a standing assertion rather than a `sample` trace somebody took by hand.

**The streamed-over-quiet control is too thin to assert on, and is noted instead.** Four runs put the margin at 0.02, 0.20, 0.31 and 0.30 ms. The direction never reversed, but 0.02 ms is a coin flip dressed as a test, so the leg records the margin through `note()` and does not go red on it — the plan asked for a cost-based pair here and this is a deliberate deviation from it.

The reason is the instrument rather than the driver: *the quiet leg is not quiet*. `cost()` takes each reading with a `requestAnimationFrame` plus a `setTimeout`, sixty times back to back, which schedules a rendering update per frame all by itself. The "quiet" measurement is therefore already buying most of the walks the driver was added to buy, and the two readings are nearly the same measurement taken twice.

What the pair was for — catching a driver that silently does nothing, which is the failure mode the doctrine's own falsification rule names — is carried instead by reading the driver's tick counter off the DOM before any cost reading is taken. That is a hard assertion on the thing actually in doubt, rather than an inference from two numbers a millisecond clock cannot separate.

### The p50 could not see any of this, and that is a fact about the clock

`performance.now()` is coarsened to the millisecond in this engine, so every reading in a burst is an integer and every percentile of them is an integer too. The first version of this leg asserted `streamed.p50 > quiet.p50` as the plan specified and went red at **3 against 3** — not because the driver did nothing but because a 0.2 ms difference is invisible at 1 ms resolution. The mean over sixty quantized samples recovers it, because the rounding is what varies between them. The budget gate stays on the p50, where a 3-against-16 comparison needs no resolution at all.

This also says something about the arc: the bench got cheap enough that the instrument's own quantization became the limiting factor. The same leg on the 21-stop breath would have had no such difficulty.

## The breaker can now fire on the deck it was built for

`shouldTrip` counted a sample only if nothing was in flight when it was taken. [F09]'s reading on the release deck was **0 trips across more than eighty motion holds**, with 17, 19, 24 and 39 ms samples sitting in the ring — every one over budget, every one discarded. In flight is this deck's normal state, so the gate was not conservative, it was inoperative.

The gate now reads `costMs > budgetMs` alone. The two remaining guards are what carry the safety: three consecutive samples at a 3-second interval, and the three-trip latch. `inFlight` is still recorded on every sample and still rides the `motion-demoted` trace row — it is how a reader tells a bill that arrived on a busy deck from one that arrived on a still one — and `nothingInFlight` is untouched.

The `at0629` breaker leg drives the real trip path with a budget of zero and still reads one trip, unlatched, with the census naming the three loops it was paying for. So the loosened gate has not made the breaker trigger-happy on a deck that is behaving: the demote legs before and after it are unchanged and green.

## The closing reading: population 72, on the machine that raised the report

Taken last, on the user's own release deck (`release-main`) with sessions mid-turn, at the largest dot population this record has seen: **72 breathing dots, 216 running loops**. Every earlier paired reading was at 23 or 32.

### The instrument, again, and why the cost probe is still the wrong one

`tugtool deck motion cost --frames 90` on the shipped build read **p50 2.00 ms**, p95 11, max 12, with every probe sample flagged as taken mid-turn.

That number already satisfies the exit bar this step was given — *median frame cost at or below 2 ms at rest* — **on the build the arc is replacing**, which is exactly why the bar cannot be what closes the step. The probe's percentiles are dominated by whatever else the deck is doing, and Step 1 established the same thing the hard way: with every loop demoted the p50 did not move. A gate that a change passes before it is made is not measuring the change. The `sample` symbol counts are, and they are what the closing row is.

### The paired A/B, alternated three times

The shipped 21-stop form and this arc's 3-stop form, switched back and forth on the same page through the `--tugx-progress-pulsing-dot-*-name` override hooks, so the two columns differ in the keyframe blocks and in nothing else — same population, same sessions, same minute.

| `sample <pid> 3`, main thread | shipped | arc form |
|---|---|---|
| `computeExtentOfTransformAnimation` | 16 / 20 / 17 (mean **17.7**) | 3 / 4 / 4 (mean **3.7**) |
| `updateCompositingLayersAfterStyleChange` | 87 / 110 / 96 (mean **97.7**) | 67 / 62 / 66 (mean **65.0**) |

The extent bill is **0.21×**, with the two distributions nowhere near overlapping — the third confirmation, after 0.26× at population 23 and 0.18× at population 32, and the first taken at a population large enough to matter.

**The compositing walk itself moved this time, and that is new.** At 23 and 32 dots the `updateCompositingLayersAfterStyleChange` column fell by 10–20%, inside its own round-to-round spread, and this record said so rather than claiming it. At 72 it falls by a third — 97.7 to 65.0, every pair in the same direction. That is the expected shape rather than a surprise: those samples are time spent inside the walk, the extent sampling happens inside it, and removing eighteen samples per dot per walk across seventy-two dots is enough of the walk's work to show. The dots still do not *cause* the walks. They cost this much less every time somebody else does.

### What could not be measured, and why it is not a gap in the argument

The plan asked for this reading on a release build **of the replayed tree**. That build exists and was made for this step — `just app-release` from the worktree, running as its own `release-tugarc-pulsing-dot-cheap` instance — and it is the wrong deck to read: a fresh instance has its own session ledger, so it opened with **0 animations and 0 long-running**, and a frame-cost reading at population zero says nothing about a dot. The user's sessions live on `release-main`, and that instance runs the installed build until this work lands on it.

So the closing row is the arc's keyframes measured on the user's real population in a release build, which is the nearest the shipped article can be priced before it *is* the shipped article. What the injection cannot carry is the rest of the arc — the weld, the zero-write phase mapping, the removed forced layout. Those are not `sample`-visible facts in the first place; they are asserted in `at0629` and `at0619` against the assembled tree, which is the right instrument for each of them.

### The arc's readings end up in one line

At seventy-two dots on a live deck, the same motion costs a fifth of the extent samples and two thirds of the compositing-walk time it did, and every claim that is not a frame cost — one clock, no writes per phase, no forced layout — is a standing test rather than a number in this file.
