/**
 * at0629-motion-render-cost-budget.test.ts — the deck measures its own frame, with a
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
 * reading would hang rather than read high. The launch is `visible: true`,
 * which keeps the web views rendering under cover without taking the screen,
 * and the first reading is taken behind a bounded wait that fails saying so — a
 * timeout with no explanation is the standing failure mode this repo has met before.
 *
 * ## The cut
 *
 * Cut from `at0629-motion-render-cost` to fit the 20 s budget, each piece on
 * its own launch of the same bench. This file carries the calibration
 * reading, the quiet reading, the probe's own samples, residency, the weld
 * and the forcing probe; `at0629-motion-render-cost-stream` carries the
 * streamed commit and the pause leg, `-rest` the at-rest gauge, the bisect,
 * the composer chip and the switch, and `-offscreen` the list benches. The
 * deck and the readers are `motion-render-cost-fixture.ts`.
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
 * @visible — the probe measures a deck that is actually rendering, so the
 * launch asks for a rendering viewport (`visible: true` below), not the screen.
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
  rest,
  type OffscreenReading,
} from "./motion-render-cost-fixture";


describe.skipIf(!SHOULD_RUN)("at0629 — the deck's own render cost", () => {
  test(
    "a bench of breathing dots costs the frame less than the budget, and a single main-thread write costs more",
    async () => {
      const app = await launchTugApp({
        testName: "at0629-motion-render-cost",
        visible: true,
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

        // ---- The calibration reading: the bench as it ships. -------------
        //
        // The off-screen rule is on, so the dots the pane clips out of view
        // carry no animation and what runs is the on-screen population. This
        // is the reading the two budgets are derived from, and it has to be
        // this one: a quiet reading taken with the clipped dots running
        // contains the disease the rule exists to remove — an off-screen loop
        // is not compositor-resident on this WebKit and dirties style every
        // frame from under the fold — and a budget derived over it is a
        // budget tuned never to fire on it. That is what the first
        // calibration did, and the record of it is in the doctrine. The
        // legs below park the rule and read the same population running, so
        // the two readings stand side by side in one run.
        const shipped = await app.body("B").evalJS<OffscreenReading>(
          `window.__tugMotion.offscreen()`,
        );
        note("at0629 off-screen rule as shipped", shipped);
        expect(shipped.enabled).toBe(true);
        const quietShipped = await cost(app.body("B"), "__at0629quietShipped", 60);
        const restShipped = await rest(app.body("B"), "__at0629restShipped");
        note("at0629 quiet render cost, rule on", {
          p50: quietShipped.p50,
          p95: quietShipped.p95,
          max: quietShipped.max,
          offscreen: shipped.paused,
          budgetMs,
        });
        note("at0629 at rest, rule on", { ...restShipped, restBudget });
        expect(
          quietShipped.p95,
          `the bench as it ships read a quiet p95 of ${quietShipped.p95} ms ` +
            `against a ${budgetMs} ms budget. The budget is at least twice ` +
            `this reading's worst p95 across the calibration passes, so a red ` +
            `here says the deck regressed or the calibration wants re-reading ` +
            `on this machine — re-read it into RENDER_COST_BUDGET_MS with the ` +
            `doctrine's rule, never loosen the assertion.`,
        ).toBeLessThan(budgetMs);
        expect(
          restShipped.updatesPerSecond,
          `the bench as it ships read ${restShipped.updatesPerSecond} ` +
            `updates/s at rest against a budget of ${restBudget}. With the ` +
            `off-screen rule on, every loop that runs is on screen and ` +
            `resident, and a reading over the budget says one of them is ` +
            `ticking on the main thread.`,
        ).toBeLessThan(restBudget);

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

        // ---- The armed probe's own background samples. -------------------
        //
        // The probe samples every 3 s while anything is moving, so two of them
        // is the shortest reading that says the sampler is running rather than
        // that one sample happened to land.
        await app.body("B").waitForCondition<boolean>(
          `window.__tugMotion.probe().samples.length >= 2`,
          { timeoutMs: 12_000 },
        );
        const sampled = await app.body("B").evalJS<{ costMs: number; inFlight: boolean }[]>(
          `window.__tugMotion.probe().samples.map(function (s) {
             return { costMs: s.costMs, inFlight: s.inFlight };
           })`,
        );
        note("at0629 sampled render cost", sampled);
        for (const sample of sampled) {
          expect(sample.costMs).toBeLessThan(budgetMs);
        }

        // ---- Residency: the loops are the qualifying form. ---------------
        const census = await app.body("B").evalJS<{
          longRunning: number;
          violations: string[];
          retained: number;
          retainedTargets: string[];
        }>(`(function(){
          var c = window.__tugMotion.list({ within: ${JSON.stringify(BENCH)} });
          return {
            longRunning: c.longRunning,
            violations: c.violations.map(function (v) {
              return v.name + " on " + v.target + ": " + v.violations.join("; ");
            }),
            retained: c.retainedTransitions.count,
            retainedTargets: c.retainedTransitions.targets.slice(0, 8),
          };
        })()`);
        note("at0629 bench census", census);
        expect(census.violations).toEqual([]);
        expect(census.retained).toBe(0);
        expect(census.longRunning).toBeGreaterThan(0);

        // ---- The weld: one clock, and it survives a style recalc. -------
        //
        // The dot and its ring run three separate CSS loops on three separate
        // elements, and nothing in CSS makes them agree. What makes them one
        // clock is that the component assigns all three an identical
        // `startTime` the moment it opens the gates ([P04]). That is an
        // assertion about data, so it is assertable — which the arrangement it
        // replaced was not: two loops "started in the same style flush" is a
        // claim about an ordering no test can read back.
        //
        // Read over every bench dot rather than one, because the failure this
        // guards against is per-glyph: a dot whose gates opened apart sheds
        // rings out of its breath for as long as it runs, and one sampled dot
        // that happened to open cleanly would report nothing.
        const weld = await app.body("B").evalJS<{
          dots: number;
          loopsPerDot: number[];
          spreads: number[];
          nullStarts: number;
        }>(`(function(){
          var roots = document.querySelectorAll(${JSON.stringify(BENCH_LOOPS)});
          var loopsPerDot = [], spreads = [], nullStarts = 0;
          for (var i = 0; i < roots.length; i++) {
            var loops = roots[i].getAnimations({ subtree: true })
              .filter(function (a) { return a instanceof CSSAnimation; });
            loopsPerDot.push(loops.length);
            var st = [];
            for (var j = 0; j < loops.length; j++) {
              if (loops[j].startTime === null) nullStarts++;
              else st.push(loops[j].startTime);
            }
            if (st.length > 1) {
              spreads.push(Math.max.apply(null, st) - Math.min.apply(null, st));
            }
          }
          return {
            dots: roots.length,
            loopsPerDot: Array.from(new Set(loopsPerDot)),
            spreads: Array.from(new Set(spreads)),
            nullStarts: nullStarts,
          };
        })()`);
        note("at0629 weld", weld);
        expect(weld.dots).toBe(BENCH_COUNT);
        // Three loops each — the breath, the ring's expand and its fade. Not
        // written as a literal count of 900: how many loops one glyph carries
        // is the stylesheet's fact, and the claim here is that every dot
        // agrees with every other about it.
        expect(weld.loopsPerDot).toEqual([3]);
        // A `null` start time is an unwelded loop wearing a different face —
        // it reads as no disagreement at all to a naive min/max.
        expect(weld.nullStarts).toBe(0);
        // One distinct spread across three hundred dots, and it is zero.
        expect(weld.spreads).toEqual([0]);

        // ---- Risk R01: a style recalculation does not move the weld. ----
        //
        // The weld is written once, at the crossing. If a later style
        // recalculation re-created the animations — which is what a changed
        // `animation-name`, a re-inserted stylesheet or an unlucky invalidation
        // would do — they would come back at the recalculation's own start
        // time and the weld would be silently gone. So: dirty style with an
        // attribute the component knows nothing about, force the resolve, and
        // read the three back.
        const afterRecalc = await app.body("B").evalJS<{
          spreads: number[];
          moved: number;
          opacity: string;
        }>(`(function(){
          var roots = document.querySelectorAll(${JSON.stringify(BENCH_LOOPS)});
          var before = [];
          for (var i = 0; i < roots.length; i++) {
            before.push(roots[i].getAnimations({ subtree: true })
              .filter(function (a) { return a instanceof CSSAnimation; })
              .map(function (a) { return a.startTime; }));
          }
          var opacity = "";
          for (var i = 0; i < roots.length; i++) {
            roots[i].setAttribute('data-at0629-recalc', String(i));
            opacity = getComputedStyle(roots[i]).opacity;
          }
          var spreads = [], moved = 0;
          for (var i = 0; i < roots.length; i++) {
            var loops = roots[i].getAnimations({ subtree: true })
              .filter(function (a) { return a instanceof CSSAnimation; });
            var st = loops.map(function (a) { return a.startTime; });
            for (var j = 0; j < st.length; j++) {
              if (before[i][j] !== st[j]) moved++;
            }
            if (st.length > 1) {
              spreads.push(Math.max.apply(null, st) - Math.min.apply(null, st));
            }
            roots[i].removeAttribute('data-at0629-recalc');
          }
          return { spreads: Array.from(new Set(spreads)), moved: moved,
                   opacity: opacity };
        })()`);
        note("at0629 weld after recalc", afterRecalc);
        // The read is real: a `getComputedStyle` that resolved nothing would
        // make the whole leg vacuous.
        expect(afterRecalc.opacity).not.toBe("");
        expect(afterRecalc.moved).toBe(0);
        expect(afterRecalc.spreads).toEqual([0]);

        // ---- The forcing probe: what makes the quiet reading falsifiable.
        const forcing = await app.body("B").evalJS<{ forcing: boolean }>(
          `window.__tugMotion.__force(true)`,
        );
        expect(forcing.forcing).toBe(true);
        await app.body("B").waitForCondition<boolean>(
          `(function(){
             var el = document.querySelector('.tug-progress-pulsing-dot-dot');
             return el !== null && el.style.transform !== "";
           })()`,
          { timeoutMs: 8_000 },
        );
        const forced = await cost(app.body("B"), "__at0629forced", 60);
        note("at0629 forced render cost", {
          p50: forced.p50,
          p95: forced.p95,
          max: forced.max,
        });
        await app.body("B").evalJS<unknown>(`window.__tugMotion.__force(false)`);
        expect(
          forced.p50,
          `the driver that writes an inline transform every frame cost ` +
            `${forced.p50} ms against the quiet ${quiet.p50} ms. A forced ` +
            `reading that does not exceed the quiet one means the instrument ` +
            `is not reading the frame, not that the deck is fast.`,
        ).toBeGreaterThan(quiet.p50);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
