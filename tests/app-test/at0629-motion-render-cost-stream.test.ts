/**
 * at0629-motion-render-cost-stream.test.ts — the deck measures its own frame, with a
 * bench card full of dots breathing, and says what it cost.
 *
 * The animation doctrine's whole claim is that a long-running loop WebKit can
 * hand to Core Animation costs the page nothing per frame, and one it cannot
 * costs the page its entire compositing walk — every frame, for every surface,
 * for as long as the loop runs. Until this file that claim had no test: the
 * evidence was a `sample` trace taken by hand on a debug build, and nothing in
 * the corpus would go red if a WebKit change, or a stylesheet somebody wrote in
 * good faith, demoted a shipped loop back onto the main thread.
 *
 * What makes the reading possible at all is that the page can take it itself —
 * `requestAnimationFrame`, `performance.now()` and `setTimeout`, no private
 * API, no host code, no inspector (`tugdeck/src/lib/motion-guard/`). The
 * interval from a rAF callback to the first task after it IS the frame's
 * style-layout-compositing cost, because the HTML event loop runs the rendering
 * update between them.
 *
 * ## The two halves, and why neither alone is a test
 *
 * **The quiet reading** is the claim: three hundred `pulsing-dot` glyphs, all
 * running, all compositor-resident, cost the frame less than the budget. On its
 * own that is unfalsifiable — a reading of 3 ms proves nothing if 3 ms is also
 * what the page costs with the loops removed.
 *
 * **The forcing probe** is what makes it falsifiable ([D5]). `__force(true)`
 * runs a rAF loop writing an inline `transform` on one dot every frame — the
 * disqualifying form, installed on purpose and only under `__tugTestMode`. One
 * such write per frame is the doctrine's own claim in miniature: it is a style
 * commit, and a style commit drags the whole page's compositing walk into the
 * frame loop. So the forced reading must exceed the quiet one, and if it does
 * not, the instrument is broken rather than the deck being fast.
 *
 * The **pause leg** is the third reading and it is the one that says the cost
 * belongs to the loops: pausing every animation in the bench and re-measuring
 * gives the floor the quiet reading is standing on.
 *
 * ## The calibration reading is the bench as it ships
 *
 * The first reading of the run is taken with the off-screen rule on, which
 * is the deck the user gets: the dots the pane clips carry no animation and
 * the on-screen population runs. Its quiet cost and its at-rest count are
 * what the two budgets are derived from. The quiet and forced readings that
 * follow are taken with the rule parked, every dot running, because they are
 * about the glyph's own cost and the gauge's two ends — and the difference
 * between the two quiet readings is the record of what the clipped
 * population costs, which is the disease the first calibration was taken
 * over without knowing it.
 *
 * ## The at-rest gauge
 *
 * A frame's cost cannot say how many frames run. A deck paying a 7 ms
 * rendering update every frame with nothing streaming is under budget on
 * every sample and reads as healthy — and it is the deck that starves a
 * fold. So the probe carries a second reading, `rest()`: a chain of
 * one-millisecond timers watches the main thread for a second and counts the
 * fires that came late by more than the floor, which is how many rendering
 * updates held the thread. The leg reads it three ways on the same bench:
 * every dot running, with the off-screen rule switched off so the bench's
 * own clipped dots run (noted — a record of what the pane's clip costs, not
 * a claim); the off-screen dots paused by hand, so only the resident
 * on-screen population runs, which must read under the at-rest budget; and
 * the forcing probe on, which must read the display rate. The resident
 * reading and the forced one are the two ends the gauge has to tell apart,
 * on one deck, in one run.
 *
 * ## Off-screen content costs zero
 *
 * The last legs re-seat the same population one glyph to a row inside a
 * `TugListView` scroller, which is where the Overview card's dots were found
 * dirtying style every frame from under the fold. Three readings of one
 * population: the rule on (`lib/motion-guard/offscreen.ts` — an
 * intersection observer marks every figure out of view and the stylesheet
 * turns its loops off), which must read under the at-rest budget with the
 * off-screen figures carrying no animations at all; the rule off, the
 * untreated list, noted; and the declarative candidate, the primitive's own
 * `offscreenSkip` (`content-visibility: auto` on every measured row) with
 * the rule off, noted. The two noted readings are the bench that chose the
 * mechanism, kept so the choice can be re-read on any machine. Then the
 * scroller is scrolled to its foot and the figures that crossed in must be
 * breathing with their three loops welded to one start time — the dot's own
 * weld, applied on return — while the ones that crossed out carry the mark
 * and no animation.
 *
 * ## The switch
 *
 * The last leg before the list bench is the motion switch's: `demote(true)` must
 * still every loop through one CSS variable and change nothing else: each dot
 * still carries `data-breathing`, because the demotion is a CSS answer to a CSS
 * contract and React never hears about it ([L06]). The switch used to be a
 * circuit breaker that threw itself on the probe's readings, and this test
 * used to drive that path with budgets of zero; the breaker demoted the
 * release deck on 1–3 ms frames and the authority was taken away
 * (`breaker.ts`). The two budgets are still read off `probe()` as the
 * calibrated reference the readings below are judged against.
 *
 * ## What is derived and what is asserted
 *
 * Numbers that describe the corpus are read, not written down. The paused count
 * is whatever `list()` reports long-running inside the bench — three loops per
 * glyph is what the CSS says today, and a literal 900 would pin that reading
 * into a test about neither the count nor the CSS. The budget is
 * `probe().budgetMs` for the same reason: the constant was calibrated against
 * this test's own two readings, so a red here is as likely to say the constant
 * needs re-reading as that something regressed — re-read it and carry the
 * numbers back into `RENDER_COST_BUDGET_MS`, never loosen the assertion.
 *
 * The population is counted **inside the bench card**, not over the document.
 * The Session card mounts its own masthead glyph and any future one elsewhere
 * would break a document-wide equality for no reason this test is about.
 *
 * The census is scoped for the same reason, and the scope is the bench card
 * rather than `.tug-pane`: `document.querySelector('.tug-pane')` returns the
 * FIRST pane, which is the Session card's. Unscoped it is not a claim this test
 * can make at all — `tugx-icon-twinkle` on `.tug-icon-spark` is an infinite
 * loop on an SVG element, which the census convicts by construction, so any
 * deck chrome that happens to be twinkling would turn the assertion into a red
 * about somebody else's glyph.
 *
 * ## Occlusion
 *
 * An occluded window suspends `requestAnimationFrame` outright, so every
 * reading would hang rather than read high. The window is launched
 * `foreground: true`, and the first reading is taken behind a bounded wait that
 * fails saying so — a timeout with no explanation is the standing failure mode
 * this repo has met before.
 *
 * ## The cut
 *
 * Cut from `at0629-motion-render-cost` to fit the 20 s budget, each piece on
 * its own launch of the same bench. This file carries the streamed commit and
 * its demoted control, and the pause leg, with the quiet reading they are
 * noted against; `at0629-motion-render-cost-budget` carries the calibration,
 * the quiet claim, residency, the weld and the forcing probe, `-rest` the
 * at-rest gauge, the bisect, the composer chip and the switch, and
 * `-offscreen` the list benches. The deck and the readers are
 * `motion-render-cost-fixture.ts`.
 *
 * @family at0629-motion-render-cost
 *
 * @covers tugdeck/src/lib/motion-guard/registry.ts
 * @covers tugdeck/src/lib/motion-guard/render-cost-probe.ts
 * @covers tugdeck/src/lib/motion-guard/input-latency.ts
 * @covers tugdeck/src/lib/motion-guard/diagnostics.ts
 * @covers tugdeck/src/lib/motion-guard/breaker.ts
 * @covers tugdeck/src/lib/motion-guard/offscreen.ts
 * @covers tugdeck/src/lib/motion-guard/index.ts
 * @covers tugdeck/src/deck-trace.ts
 * @covers tugdeck/styles/tug.css
 * @covers tugdeck/src/components/tugways/internal/tug-progress-pulsing-dot.tsx
 * @covers tugdeck/src/components/tugways/internal/tug-progress-pulsing-dot.css
 * @covers tugdeck/src/components/tugways/tug-progress-indicator.tsx
 * @covers tugdeck/src/components/tugways/cards/gallery-motion-bench.tsx
 * @covers tugdeck/src/components/tugways/cards/gallery-motion-bench.css
 * @covers tugdeck/src/components/tugways/tug-text-editor/session-dot-layer.tsx
 * @covers tugdeck/src/lib/perf-monitor.ts
 *
 * @foreground — the probe measures a deck that is actually rendering, so the
 * launch takes the screen (`foreground: true` below).
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  BENCH,
  BENCH_COUNT,
  BENCH_DOTS,
  BENCH_LOOPS,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  cost,
  deckShape,
  mean,
  meanOf,
  type OffscreenReading,
} from "./motion-render-cost-fixture";


describe.skipIf(!SHOULD_RUN)("at0629 — the deck's own render cost", () => {
  test(
    "a streamed commit is priced by the running loops, and the pause leg pauses every loop in the bench",
    async () => {
      const app = await launchTugApp({
        testName: "at0629-motion-render-cost",
        foreground: true,
      });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "B" });

        // ---- The population, counted inside the bench card. --------------
        await app.body("B").waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(BENCH_DOTS)}).length === ${BENCH_COUNT}`,
          { timeoutMs: 30_000 },
        );

        // ---- The probe armed itself off the registry's rising edge. ------
        const armed = await app.body("B").evalJS<{
          armed: boolean;
          holds: number;
          budgetMs: number;
          restBudgetPerSecond: number;
          demoted: boolean;
        }>(`(function(){
          var p = window.__tugMotion.probe();
          return {
            armed: p.armed, holds: p.holds,
            budgetMs: p.budgetMs, restBudgetPerSecond: p.restBudgetPerSecond,
            demoted: p.demoted,
          };
        })()`);
        note("at0629 probe", armed);
        expect(armed.armed).toBe(true);
        expect(armed.holds).toBeGreaterThan(0);
        expect(armed.demoted).toBe(false);
        const budgetMs = armed.budgetMs;
        const restBudget = armed.restBudgetPerSecond;
        expect(restBudget).toBeGreaterThan(0);

        // The flow bench is read with the off-screen rule OFF, so the dots
        // the pane clips still run: these legs are about the glyph's own
        // cost and the gauge's two ends, and the rule would take the
        // clipped population out of both. The rule's own legs come last.
        const ruleOff = await app.body("B").evalJS<OffscreenReading>(
          `window.__tugMotion.offscreen(false)`,
        );
        note("at0629 off-screen rule parked for the flow bench", ruleOff);
        expect(ruleOff.enabled).toBe(false);
        expect(ruleOff.paused).toBe(0);

        // ---- The quiet reading: the claim. -------------------------------
        const quiet = await cost(app.body("B"), "__at0629quiet", 60);
        note("at0629 quiet render cost", {
          p50: quiet.p50,
          p95: quiet.p95,
          max: quiet.max,
          budgetMs,
        });
        expect(
          quiet.p95,
          `the quiet p95 was ${quiet.p95} ms against a ${budgetMs} ms budget. ` +
            `The budget is calibrated at twice this reading's own worst p95 on ` +
            `the bench, so a red here says either the deck regressed or the ` +
            `calibration wants re-reading on this machine. The first response ` +
            `is to re-read it into RENDER_COST_BUDGET_MS with the doctrine's ` +
            `rule, never to loosen the assertion.`,
        ).toBeLessThan(budgetMs);

        // ---- The streamed commit: the deck the deck actually is. --------
        //
        // The quiet reading above is taken on a deck where nothing is
        // dirtying style, and that is the reading's weakness rather than its
        // strength: the dots do not CAUSE the compositing walk, they set the
        // PRICE of each one. A bench with nothing committing pays for no
        // walks, so a green quiet p50 says very little about what three
        // hundred running loops cost a deck that is doing something.
        //
        // `__stream(true)` is that something, in its most innocent form: one
        // `data-*` attribute per frame on a `<span>` that animates nothing.
        // No transform, no transition, nothing the dots can see. It is what a
        // streaming transcript's React commit does to this page — dirty
        // style, schedule a rendering update — and the walk inside that
        // update is then priced by every running transform animation here.
        //
        // Deliberately not `__force`, which writes an inline transform on a
        // dot and demotes that animation to main-thread ticking: that probe
        // proves the instrument by breaking something, and this one prices
        // the deck without touching it.
        //
        // **The leg carries two controls, and only one of them is asserted
        // on cost.** The plan asked for a pair: the streamed reading above
        // the quiet one (the driver is doing something) and the demoted one
        // below it (what it is doing is billed by the dots). The second is
        // asserted below and is decisive — 0.17–0.32 ms against 3.4–3.7. The
        // first is measured, noted, and deliberately NOT asserted, because
        // four runs put its margin at 0.02, 0.20, 0.31 and 0.30 ms and a
        // 0.02 ms margin is a coin flip dressed as a test.
        //
        // The reason is the instrument rather than the driver. `cost()`
        // takes each of its sixty readings with a `requestAnimationFrame`
        // plus a `setTimeout`, which schedules a rendering update per frame
        // all by itself — so the "quiet" leg is already buying most of the
        // walks this driver was added to buy, and the two readings are
        // nearly the same measurement. What the pair was for is carried
        // instead by the tick assertion just below, which reads the driver's
        // own counter: a driver that silently no-ops is caught there, hard,
        // rather than inferred from two numbers a millisecond clock cannot
        // tell apart.
        const streamedPopulation = await app.body("B").evalJS<number>(
          `document.querySelectorAll(${JSON.stringify(BENCH_DOTS)}).length`,
        );
        const streaming = await app.body("B").evalJS<{ streaming: boolean }>(
          `window.__tugMotion.__stream(true)`,
        );
        expect(streaming.streaming).toBe(true);
        // The driver is demonstrably running before anything is read off it.
        // A silently no-opping driver is how a measurement of this shape gets
        // decided the wrong way.
        await app.body("B").waitForCondition<boolean>(
          `(function(){
             var el = document.querySelector('[data-tug-stream-node]');
             return el !== null && Number(el.getAttribute('data-tug-stream-tick')) > 5;
           })()`,
          { timeoutMs: 8_000 },
        );
        const streamed = await cost(app.body("B"), "__at0629streamed", 60);
        note("at0629 streamed render cost", {
          population: streamedPopulation,
          p50: streamed.p50,
          p95: streamed.p95,
          max: streamed.max,
          mean: meanOf(streamed),
          quietMean: meanOf(quiet),
          budgetMs,
        });
        expect(streamedPopulation).toBe(BENCH_COUNT);
        expect(
          streamed.p50,
          `three hundred breathing dots under one innocent style commit per ` +
            `frame cost ${streamed.p50} ms against a ${budgetMs} ms budget. ` +
            `This is the reading the budget exists for — the deck doing work ` +
            `while the loops run — so a red here is the doctrine's claim ` +
            `failing, not a calibration question.`,
        ).toBeLessThan(budgetMs);
        // Noted rather than asserted; see above for why. The direction has
        // held on every run taken so far, so a `note()` reading BELOW the
        // quiet one is worth a look even though nothing here goes red for it.
        note("at0629 streamed over quiet", {
          streamedMean: meanOf(streamed),
          quietMean: meanOf(quiet),
          marginMs: Math.round((mean(streamed.burst) - mean(quiet.burst)) * 100) / 100,
        });

        // The control. If the same cost comes back with every loop stilled,
        // the number is about the driver rather than about the dots — and the
        // assertion above would be measuring `setAttribute`.
        const streamedDemoted = await app.body("B").evalJS<null>(`(function(){
          window.__tugMotion.demote(true);
          return null;
        })()`);
        expect(streamedDemoted).toBe(null);
        const demotedStream = await cost(app.body("B"), "__at0629streamdemoted", 60);
        note("at0629 streamed render cost, loops demoted", {
          p50: demotedStream.p50,
          p95: demotedStream.p95,
          max: demotedStream.max,
          mean: meanOf(demotedStream),
        });
        await app.body("B").evalJS<unknown>(`window.__tugMotion.demote(false)`);
        await app.body("B").evalJS<unknown>(`window.__tugMotion.__stream(false)`);
        expect(
          mean(demotedStream.burst),
          `the same per-frame commit with every loop stilled cost ` +
            `${meanOf(demotedStream)} ms against ${meanOf(streamed)} ms with ` +
            `them running. A reading that does not fall is a reading about ` +
            `the commit rather than about the loops it is supposed to price.`,
        ).toBeLessThan(mean(streamed.burst));
        // ...and the driver is off before the pause, demote and breaker legs
        // below, which would otherwise read a deck with a rAF loop on it.
        expect(
          await app.body("B").evalJS<boolean>(
            `document.querySelector('[data-tug-stream-node]') === null`,
          ),
        ).toBe(true);

        // ---- The pause leg: the cost belongs to the loops. ---------------
        //
        // The count is derived from what the census reports inside the bench,
        // never written down: how many loops one glyph carries is a fact about
        // the stylesheet, and this test is about neither that number nor the
        // bench's count.
        const longRunningInBench = await app.body("B").evalJS<number>(
          `window.__tugMotion.list({ within: ${JSON.stringify(BENCH)} }).longRunning`,
        );
        const paused = await app.body("B").evalJS<number>(
          `window.__tugMotion.pause(${JSON.stringify(BENCH_LOOPS)}).paused`,
        );
        const pausedStates = await app.body("B").evalJS<string[]>(
          `Array.from(new Set(
             window.__tugMotion.list({ within: ${JSON.stringify(BENCH)} })
               .entries.map(function (e) { return e.playState; })
           ))`,
        );
        const pausedCost = await cost(app.body("B"), "__at0629paused", 60);
        const resumed = await app.body("B").evalJS<number>(
          `window.__tugMotion.resume(${JSON.stringify(BENCH_LOOPS)}).resumed`,
        );
        note("at0629 pause leg", {
          longRunningInBench,
          paused,
          resumed,
          pausedStates,
          pausedP50: pausedCost.p50,
          breathingP50: quiet.p50,
        });
        expect(paused).toBeGreaterThanOrEqual(longRunningInBench);
        expect(pausedStates).toEqual(["paused"]);
        expect(resumed).toBe(paused);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
