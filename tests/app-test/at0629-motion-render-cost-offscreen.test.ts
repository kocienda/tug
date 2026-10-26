/**
 * at0629-motion-render-cost-offscreen.test.ts — the deck measures its own frame, with a
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
 * can make at all — a running progress glyph is an infinite loop on an SVG
 * element, which the census convicts by construction, so any deck chrome that
 * happens to be busy would turn the assertion into a red about somebody else's
 * glyph.
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
 * its own launch of the same bench. This file carries the list benches —
 * off-screen content costs zero, and resuming on scroll-in goes through the
 * dot's own weld — after the probe's budgets are read off the bench;
 * `at0629-motion-render-cost-budget` carries the calibration, the quiet
 * claim, residency, the weld and the forcing probe, `-stream` the streamed
 * commit and the pause leg, and `-rest` the at-rest gauge, the bisect, the
 * composer chip and the switch. The deck and the readers are
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
 * @visible — the probe measures a deck that is actually rendering, so the
 * launch asks for a rendering viewport (`visible: true` below), not the screen.
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  BENCH_COUNT,
  BENCH_DOTS,
  LIST_CARD,
  SHOULD_RUN,
  SKIP_CARD,
  TEST_TIMEOUT_MS,
  cost,
  deckShape,
  listBench,
  listDots,
  listFigures,
  listScroller,
  rest,
  seatListBench,
  type ListFigures,
  type OffscreenReading,
} from "./motion-render-cost-fixture";


describe.skipIf(!SHOULD_RUN)("at0629 — the deck's own render cost", () => {
  test(
    "off-screen figures in a list carry no animation and cost nothing at rest, and re-weld when they scroll in",
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
        const restBudget = armed.restBudgetPerSecond;
        expect(restBudget).toBeGreaterThan(0);

        // ---- Off-screen content costs zero. ------------------------------
        //
        // The same population, one glyph to a row inside a list scroller,
        // nearly all of it under the fold. With the rule on, every figure out
        // of view carries the mark and no animation, and the deck reads under
        // the at-rest budget with three hundred dots mounted.
        //
        // The rule is per page: the list card's body has its own, so it is
        // switched there, once the body exists.
        await seatListBench(app, LIST_CARD, "gallery-motion-bench-dot-list");
        await app.body(LIST_CARD).evalJS<unknown>(`window.__tugMotion.offscreen(true)`);
        await app.body(LIST_CARD).waitForCondition<boolean>(
          `window.__tugMotion.offscreen().paused > 0`,
          { timeoutMs: 8_000 },
        );
        // A cost reading first: it proves the window is painting before a
        // timer-chain reading is trusted (see `rest`).
        const listCost = await cost(app.body(LIST_CARD), "__at0629listCost", 30);
        const ruleOn = await app.body(LIST_CARD).evalJS<OffscreenReading>(
          `window.__tugMotion.offscreen()`,
        );
        const figuresOn = await app.body(LIST_CARD).evalJS<ListFigures>(listFigures(LIST_CARD));
        const restRuleOn = await rest(app.body(LIST_CARD), "__at0629restRuleOn");
        note("at0629 list bench, rule on", {
          ...restRuleOn,
          costP50: listCost.p50,
          rule: ruleOn,
          figures: figuresOn,
          restBudget,
        });
        expect(ruleOn.enabled).toBe(true);
        expect(ruleOn.watched).toBeGreaterThanOrEqual(BENCH_COUNT);
        expect(figuresOn.dots).toBe(BENCH_COUNT);
        // Most of the list is under the fold, and every figure there carries
        // the mark and nothing else.
        expect(figuresOn.marked).toBeGreaterThan(BENCH_COUNT / 2);
        expect(figuresOn.animated).toBe(BENCH_COUNT - figuresOn.marked);
        expect(figuresOn.running).toBe(figuresOn.animated * 3);
        expect(figuresOn.spreads).toEqual([0]);
        expect(
          restRuleOn.updatesPerSecond,
          `${BENCH_COUNT} dots in a list scroller, ${figuresOn.marked} of ` +
            `them out of view and stilled, read ${restRuleOn.updatesPerSecond} ` +
            `updates/s at rest against a budget of ${restBudget}. Off-screen ` +
            `content costs zero, or the rule is not reaching these figures.`,
        ).toBeLessThan(restBudget);

        // The untreated list: the rule off, every dot running, the disease
        // the rule exists for. Noted rather than asserted, because the
        // number is a property of this WebKit on this machine.
        const ruleOffList = await app.body(LIST_CARD).evalJS<OffscreenReading>(
          `window.__tugMotion.offscreen(false)`,
        );
        const figuresOff = await app.body(LIST_CARD).evalJS<ListFigures>(listFigures(LIST_CARD));
        const restRuleOff = await rest(app.body(LIST_CARD), "__at0629restRuleOff");
        note("at0629 list bench, rule off", {
          ...restRuleOff,
          rule: ruleOffList,
          figures: figuresOff,
        });
        expect(figuresOff.marked).toBe(0);
        expect(figuresOff.animated).toBe(BENCH_COUNT);
        expect(figuresOff.running).toBe(BENCH_COUNT * 3);

        // The declarative candidate: the primitive's `offscreenSkip`, which
        // is `content-visibility: auto` on every measured row, read with the
        // rule off. Noted for the same reason. The rows have to have earned
        // their stamp first, which the cell observer does on measurement.
        // A fresh body's rule starts on, so it is parked in this one too.
        await seatListBench(app, SKIP_CARD, "gallery-motion-bench-dot-list-skip");
        await app.body(SKIP_CARD).evalJS<unknown>(`window.__tugMotion.offscreen(false)`);
        await app.body(SKIP_CARD).waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(`${listBench(SKIP_CARD)} .tug-list-view-cell[data-cv-ready]`)}).length === ${BENCH_COUNT}`,
          { timeoutMs: 15_000 },
        );
        const figuresSkip = await app.body(SKIP_CARD).evalJS<ListFigures & { skipped: number }>(
          `(function(){
             var f = ${listFigures(SKIP_CARD)};
             f.skipped = document.querySelectorAll(${JSON.stringify(`${listBench(SKIP_CARD)} .tug-list-view-cell[data-cv-skipped]`)}).length;
             return f;
           })()`,
        );
        const restSkip = await rest(app.body(SKIP_CARD), "__at0629restSkip");
        note("at0629 list bench, content-visibility skip, rule off", {
          ...restSkip,
          figures: figuresSkip,
        });
        expect(figuresSkip.dots).toBe(BENCH_COUNT);
        expect(figuresSkip.marked).toBe(0);
        // The reading that CHOSE the observer, and the reason it is asserted
        // rather than only noted: the doctrine's residency limit
        // (#offscreen-limit) rests on the claim that a skipped subtree's
        // animations stay resident and running on this WebKit, and a claim
        // nothing pins can stop being true with nothing going red. The rows
        // have to have been skipped for the claim to be about anything, so
        // that is pinned first.
        expect(figuresSkip.skipped).toBeGreaterThan(BENCH_COUNT / 2);
        expect(figuresSkip.animated).toBe(BENCH_COUNT);
        expect(figuresSkip.running).toBe(BENCH_COUNT * 3);

        // ---- Resuming on scroll-in goes through the dot's own weld. ------
        //
        // Back on the untreated list with the rule on, scrolled to its foot:
        // the figures that crossed in are breathing with their three loops on
        // one start time, and the ones that crossed out carry the mark.
        await seatListBench(app, LIST_CARD, "gallery-motion-bench-dot-list");
        await app.body(LIST_CARD).evalJS<unknown>(`window.__tugMotion.offscreen(true)`);
        await app.body(LIST_CARD).waitForCondition<boolean>(
          `window.__tugMotion.offscreen().paused > 0`,
          { timeoutMs: 8_000 },
        );
        const firstMarkedBefore = await app.body(LIST_CARD).evalJS<boolean>(`(function(){
          var roots = document.querySelectorAll(${JSON.stringify(listDots(LIST_CARD))});
          return roots[0].hasAttribute("data-tug-offscreen");
        })()`);
        await app.body(LIST_CARD).evalJS<unknown>(`(function(){
          var s = document.querySelector(${JSON.stringify(listScroller(LIST_CARD))});
          s.scrollTop = s.scrollHeight;
          return null;
        })()`);
        await app.body(LIST_CARD).waitForCondition<boolean>(
          `(function(){
             var roots = document.querySelectorAll(${JSON.stringify(listDots(LIST_CARD))});
             var first = roots[0], last = roots[roots.length - 1];
             return first.hasAttribute("data-tug-offscreen") &&
               !last.hasAttribute("data-tug-offscreen") &&
               last.getAnimations({ subtree: true }).length > 0;
           })()`,
          { timeoutMs: 8_000 },
        );
        const figuresScrolled = await app.body(LIST_CARD).evalJS<ListFigures>(listFigures(LIST_CARD));
        note("at0629 list bench, scrolled to the foot", {
          firstMarkedBefore,
          figures: figuresScrolled,
        });
        expect(firstMarkedBefore).toBe(false);
        expect(figuresScrolled.marked).toBeGreaterThan(BENCH_COUNT / 2);
        expect(figuresScrolled.animated).toBe(BENCH_COUNT - figuresScrolled.marked);
        expect(figuresScrolled.running).toBe(figuresScrolled.animated * 3);
        // Every figure that came back in was re-welded: one start time a
        // figure, never three.
        expect(figuresScrolled.spreads).toEqual([0]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
