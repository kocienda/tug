/**
 * at0629-motion-render-cost-rest.test.ts — the deck measures its own frame, with a
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
 * its own launch of the same bench. This file carries the at-rest gauge, the
 * bisect, the composer chip and the switch — thrown in the bench's body, then
 * thrown in the shell and followed by the body — behind one cost reading that
 * proves the window is painting before the first timer-chain reading;
 * `at0629-motion-render-cost-budget` carries the calibration, the quiet
 * claim, residency, the weld and the forcing probe, `-stream` the streamed
 * commit and the pause leg, and `-offscreen` the list benches. The deck and
 * the readers are `motion-render-cost-fixture.ts`.
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
  CHIP,
  CHIP_VALUE,
  COMPOSER,
  LAYER_HOST,
  PROJECT_DIR,
  SESSION_ID,
  SHOULD_RUN,
  SIDECAR,
  SPLIT_DOTS,
  TAG,
  TEST_TIMEOUT_MS,
  cost,
  deckShape,
  rest,
  type OffscreenReading,
} from "./motion-render-cost-fixture";


describe.skipIf(!SHOULD_RUN)("at0629 — the deck's own render cost", () => {
  test(
    "the at-rest gauge tells a resident bench from a forced one, the bisect keeps the weld, and one attribute stills every loop",
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

        // A cost reading first: it proves the window is painting before a
        // timer-chain reading is trusted (see `rest`), which the legs ahead
        // of these did in the uncut file.
        await cost(app.body("B"), "__at0629painting", 30);
        // What the census reports long-running inside the bench — the count
        // the bisect's weld read is held against.
        const longRunningInBench = await app.body("B").evalJS<number>(
          `window.__tugMotion.list({ within: ${JSON.stringify(BENCH)} }).longRunning`,
        );

        // ---- The at-rest gauge: updates per second, three ways. ----------
        //
        // Every dot running is the bench as it is, and the reading is a
        // record rather than a claim: the dots below the card's fold dirty
        // style every frame on this WebKit, and until off-screen content
        // reads zero this number says how much of the bench is off screen.
        const restAll = await rest(app.body("B"), "__at0629restAll");
        note("at0629 at rest, every dot running", restAll);
        expect(restAll.ticks).toBeGreaterThan(100);
        expect(restAll.windowMs).toBeGreaterThanOrEqual(1000);

        // The resident reading: pause only the dots the card has clipped
        // out of view, so what runs is the on-screen population — the one
        // that costs the frame nothing measurable. This is the reading the
        // doctrine's invariant is stated in, and it has to read under the
        // at-rest budget or the gauge cannot tell a resident deck from a
        // broken one.
        const split = await app.body("B").evalJS<{ on: number; off: number }>(`(function(){
          var s = ${SPLIT_DOTS};
          return { on: s.on.length, off: s.off.length };
        })()`);
        note("at0629 bench dots by placement", split);
        expect(split.on).toBeGreaterThan(0);
        expect(split.off).toBeGreaterThan(0);
        expect(split.on + split.off).toBe(BENCH_COUNT);
        const pausedOff = await app.body("B").evalJS<number>(`(function(){
          var s = ${SPLIT_DOTS};
          var n = 0;
          for (var i = 0; i < s.off.length; i++) {
            var loops = s.off[i].getAnimations({ subtree: true });
            for (var j = 0; j < loops.length; j++) { loops[j].pause(); n++; }
          }
          return n;
        })()`);
        expect(pausedOff).toBeGreaterThan(0);
        const restResident = await rest(app.body("B"), "__at0629restResident");
        const resumedOff = await app.body("B").evalJS<number>(`(function(){
          var s = ${SPLIT_DOTS};
          var n = 0;
          for (var i = 0; i < s.off.length; i++) {
            var loops = s.off[i].getAnimations({ subtree: true });
            for (var j = 0; j < loops.length; j++) { loops[j].play(); n++; }
          }
          return n;
        })()`);
        note("at0629 at rest, on-screen dots only", {
          ...restResident,
          onScreen: split.on,
          pausedOff,
          resumedOff,
          restBudget,
        });
        expect(resumedOff).toBe(pausedOff);
        expect(
          restResident.updatesPerSecond,
          `${split.on} resident dots read ${restResident.updatesPerSecond} ` +
            `updates/s at rest against a budget of ${restBudget}. A resident ` +
            `loop holds the main thread for nothing; a reading here says the ` +
            `on-screen population is ticking on the main thread, or the ` +
            `floor wants re-reading on this machine.`,
        ).toBeLessThan(restBudget);

        // The other end: the forcing probe writes a transform every frame,
        // so every frame is a rendering update that resolves style on the
        // main thread and pays the walk. The gauge must read the display
        // rate, or it is not reading updates.
        await app.body("B").evalJS<unknown>(`window.__tugMotion.__force(true)`);
        await app.body("B").waitForCondition<boolean>(
          `(function(){
             var el = document.querySelector('.tug-progress-pulsing-dot-dot');
             return el !== null && el.style.transform !== "";
           })()`,
          { timeoutMs: 8_000 },
        );
        const restForced = await rest(app.body("B"), "__at0629restForced");
        await app.body("B").evalJS<unknown>(`window.__tugMotion.__force(false)`);
        note("at0629 at rest, forced", restForced);
        expect(
          restForced.updatesPerSecond,
          `a per-frame inline transform write read ${restForced.updatesPerSecond} ` +
            `updates/s. A forced loop that does not read the display rate ` +
            `means the chain is not seeing the frame, not that the deck is fast.`,
        ).toBeGreaterThanOrEqual(45);
        expect(restForced.updatesPerSecond).toBeGreaterThan(
          restResident.updatesPerSecond,
        );

        // ---- The bisect: families by figure and placement, welds kept. ---
        //
        // The old verb grouped by keyframe name and paused one group while
        // its siblings ran, which read 0.00 for a family that cost 10 ms and
        // left every dot's ring out of phase with its breath. The new one
        // pauses whole figures, wakes one family at a time, and splits the
        // bench's dots by the pane's clip. What is asserted is the shape —
        // the dots are one family in two placements, every figure counted —
        // and the weld afterwards, which is the reading the user saw break.
        await app.body("B").evalJS<null>(`(function(){
          window.__at0629bisect = { done: false };
          window.__tugMotion.bisect({ frames: 10, cap: 4 }).then(function (r) {
            window.__at0629bisect = { done: true, reading: r };
          });
          return null;
        })()`);
        await app.body("B").waitForCondition<boolean>(
          `window.__at0629bisect !== undefined && window.__at0629bisect.done === true`,
          { timeoutMs: 30_000 },
        );
        const bisect = await app.body("B").evalJS<{
          baselineP50: number;
          floorP50: number;
          groupsFound: number;
          groupsRead: number;
          groups: {
            name: string;
            placement: string;
            count: number;
            figures: number;
            aloneP50: number;
            price: number;
          }[];
        }>(`window.__at0629bisect.reading`);
        note("at0629 bisect", bisect);
        const dotFamilies = bisect.groups.filter(
          (group) => group.name === "tug-progress-pulsing-dot",
        );
        expect(dotFamilies.map((group) => group.placement).sort()).toEqual([
          "off-screen",
          "on-screen",
        ]);
        expect(
          dotFamilies.reduce((sum, group) => sum + group.figures, 0),
        ).toBe(BENCH_COUNT);
        for (const group of dotFamilies) {
          // Three loops a figure, read off the family rather than written
          // down: the count is the census's fact, the ratio is the claim.
          expect(group.count).toBe(group.figures * 3);
        }
        const weldAfterBisect = await app.body("B").evalJS<{
          spreads: number[];
          running: number;
        }>(`(function(){
          var roots = document.querySelectorAll(${JSON.stringify(BENCH_LOOPS)});
          var spreads = [], running = 0;
          for (var i = 0; i < roots.length; i++) {
            var loops = roots[i].getAnimations({ subtree: true })
              .filter(function (a) { return a instanceof CSSAnimation; });
            var st = [];
            for (var j = 0; j < loops.length; j++) {
              if (loops[j].playState === "running") running++;
              if (loops[j].startTime !== null) st.push(loops[j].startTime);
            }
            if (st.length > 1) {
              spreads.push(Math.max.apply(null, st) - Math.min.apply(null, st));
            }
          }
          return { spreads: Array.from(new Set(spreads)), running: running };
        })()`);
        note("at0629 weld after bisect", weldAfterBisect);
        // Every loop the bisect paused is running again, and every figure's
        // three loops still share one start time.
        expect(weldAfterBisect.running).toBe(longRunningInBench);
        expect(weldAfterBisect.spreads).toEqual([0]);

        // ---- The composer chip's dot is the same glyph. ------------------
        await app.bindSession("A", {
          tugSessionId: SESSION_ID,
          projectDir: PROJECT_DIR,
        });
        await app.evalJS<boolean>(
          `window.__tug.publishSessionUpdated(${JSON.stringify(
            JSON.stringify({
              session_id: SESSION_ID,
              fields: { tag: TAG, name: null, name_user_set: false },
            }),
          )})`,
        );
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(COMPOSER)}) !== null`,
          { timeoutMs: 20_000 },
        );
        await app.body("A").focusElement(COMPOSER);
        await app.body("A").evalJS<null>(`(function(){
          var cm = document.querySelector(${JSON.stringify(COMPOSER)});
          var dt = new DataTransfer();
          dt.setData("text/plain", ${JSON.stringify(CHIP_VALUE)});
          dt.setData("application/x-tug-atoms", ${JSON.stringify(SIDECAR)});
          cm.dispatchEvent(new ClipboardEvent("paste", {
            bubbles: true, cancelable: true, clipboardData: dt,
          }));
          return null;
        })()`);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP)}) !== null`,
          { timeoutMs: 8_000 },
        );
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LAYER_HOST)}) !== null`,
          { timeoutMs: 8_000 },
        );
        const chipDot = await app.body("A").evalJS<{
          hosts: number;
          dots: number;
          state: string | null;
          breathing: string | null;
        }>(`(function(){
          var host = document.querySelector(${JSON.stringify(LAYER_HOST)});
          var dot = host === null
            ? null
            : host.querySelector('.tug-progress-pulsing-dot');
          return {
            hosts: document.querySelectorAll(${JSON.stringify(LAYER_HOST)}).length,
            dots: host === null
              ? 0
              : host.querySelectorAll('.tug-progress-pulsing-dot').length,
            state: dot === null ? null : dot.getAttribute('data-state'),
            breathing: dot === null ? null : dot.getAttribute('data-breathing'),
          };
        })()`);
        // The chip's glyph is the same `SessionPhaseDot` and inherits the
        // split. Whether it BREATHES is a different question and not one this
        // deck can answer: the stub tugcode holds no live phase, so the note
        // records the reading rather than asserting one.
        note("at0629 composer chip dot", chipDot);
        expect(chipDot.hosts).toBe(1);
        expect(chipDot.dots).toBe(1);

        note(
          "at0629 input latency supported",
          await app.body("B").evalJS<boolean>(`window.__tugMotion.input().supported`),
        );

        // ---- The breaker, by hand: one attribute stills every loop. ------
        //
        // `demote(true)` sets `data-tug-motion-demoted` on `<html>`, which
        // resolves `--tug-loop-iterations` to 0. What that must NOT do is
        // change the component's own state: a dot still carries
        // `data-breathing`, because the demotion is a CSS answer to a CSS
        // contract and React never hears about it ([L06], [P09]).
        const demoted = await app.body("B").evalJS<{
          attribute: boolean;
          breathing: number;
          longRunning: number;
          running: number;
        }>(`(function(){
          window.__tugMotion.demote(true);
          return {
            attribute: document.documentElement.hasAttribute("data-tug-motion-demoted"),
            breathing: document.querySelectorAll(${JSON.stringify(BENCH_DOTS)}).length,
            longRunning: window.__tugMotion.list().longRunning,
            running: document.getAnimations().filter(function (a) {
              return a.playState === "running";
            }).length,
          };
        })()`);
        note("at0629 demoted", demoted);
        expect(demoted.attribute).toBe(true);
        expect(demoted.breathing).toBe(BENCH_COUNT);
        expect(demoted.longRunning).toBe(0);
        expect(demoted.running).toBe(0);

        const undemoted = await app.body("B").evalJS<{
          attribute: boolean;
          longRunning: number;
        }>(`(function(){
          window.__tugMotion.demote(false);
          return {
            attribute: document.documentElement.hasAttribute("data-tug-motion-demoted"),
            longRunning: window.__tugMotion.list().longRunning,
          };
        })()`);
        note("at0629 un-demoted", undemoted);
        expect(undemoted.attribute).toBe(false);
        expect(undemoted.longRunning).toBeGreaterThan(0);

        // ---- The hand switch is the deck's: a body follows it. -----------
        //
        // `tugtool deck motion demote` calls `window.__tugMotion.demote()` in
        // the shell, and the bench's loops run in its body's page. The shell
        // publishes `motionDemoted` in its deck facts and every body applies
        // it to its own `<html>`, so a demote thrown in the shell must still
        // the bench's loops, and an un-demote there must start them again.
        await app.evalJS<unknown>(`window.__tugMotion.demote(true)`);
        await app.body("B").waitForCondition<boolean>(
          `document.documentElement.hasAttribute("data-tug-motion-demoted") && window.__tugMotion.list().longRunning === 0`,
          { timeoutMs: 5_000 },
        );
        await app.evalJS<unknown>(`window.__tugMotion.demote(false)`);
        await app.body("B").waitForCondition<boolean>(
          `!document.documentElement.hasAttribute("data-tug-motion-demoted") && window.__tugMotion.list().longRunning > 0`,
          { timeoutMs: 5_000 },
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
