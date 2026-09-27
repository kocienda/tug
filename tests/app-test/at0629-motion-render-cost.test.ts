/**
 * at0629-motion-render-cost.test.ts — the deck measures its own frame, with a
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
 * ## The breaker
 *
 * The last two legs are the circuit breaker's. By hand, `demote(true)` must
 * still every loop through one CSS variable and change nothing else: each dot
 * still carries `data-breathing`, because the demotion is a CSS answer to a CSS
 * contract and React never hears about it ([L06], [P09]). On its own, a budget
 * of zero drives the real trip path — three consecutive over-budget samples
 * with nothing in flight — and the `motion-demoted` trace row is the only
 * record a silent demotion leaves. Its census must say what the deck was paying
 * for, which is why it is read before the demotion lands rather than after.
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
 * @covers tugdeck/src/lib/motion-guard/registry.ts
 * @covers tugdeck/src/lib/motion-guard/render-cost-probe.ts
 * @covers tugdeck/src/lib/motion-guard/input-latency.ts
 * @covers tugdeck/src/lib/motion-guard/diagnostics.ts
 * @covers tugdeck/src/lib/motion-guard/breaker.ts
 * @covers tugdeck/src/lib/motion-guard/index.ts
 * @covers tugdeck/src/deck-trace.ts
 * @covers tugdeck/styles/tug.css
 * @covers tugdeck/src/components/tugways/internal/tug-progress-pulsing-dot.tsx
 * @covers tugdeck/src/components/tugways/internal/tug-progress-pulsing-dot.css
 * @covers tugdeck/src/components/tugways/tug-progress-indicator.tsx
 * @covers tugdeck/src/components/tugways/cards/gallery-motion-bench.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor/session-dot-layer.tsx
 * @covers tugdeck/src/lib/perf-monitor.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App, type DeckTraceEvent } from "./_harness";

/**
 * The `motion-demoted` row, as this test reads it.
 *
 * The harness's own `DeckTraceEvent` is the open `{ kind: string; [k: string]:
 * unknown }` superset rather than the deck's discriminated union — the two are
 * kept apart on purpose, so a test does not have to track every trace kind to
 * compile. Which means `Extract<…, { kind: "motion-demoted" }>` over it
 * resolves to `never` and silently un-types every assertion under it. The
 * row's shape is declared here instead, mirroring `deck-trace.ts`; the
 * exhaustive fixture map in `_harness/matchers.test.ts` is what pins the same
 * shape on the harness's own side.
 */
interface MotionDemotedRow {
  kind: "motion-demoted";
  costMs: number[];
  budgetMs: number;
  trips: number;
  latched: boolean;
  census: {
    longRunning: number;
    byName: Record<string, number>;
    violations: string[];
  };
}

function isMotionDemoted(
  event: DeckTraceEvent,
): event is DeckTraceEvent & MotionDemotedRow {
  return event.kind === "motion-demoted";
}

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SESSION_ID = "aa11bb22-0000-4000-8000-0000000a0629";
const TAG = "curly-apple";
const PROJECT_DIR = "/Users/tester/src/tugtool";
const CHIP_VALUE = `tugtool/${TAG}`;

/** The bench card, and the scope every population reading is taken in. */
const BENCH = '[data-card-id="B"]';
const BENCH_DOTS = `${BENCH} .tug-progress-pulsing-dot[data-breathing]`;
/** Every animation inside the bench, for the pause leg. */
const BENCH_LOOPS = `${BENCH} .tug-progress-pulsing-dot`;

const COMPOSER = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';
const CHIP = `${COMPOSER} img[data-atom-well-x]`;
const LAYER_HOST = ".cm-tug-session-dot-layer .cm-tug-session-dot-host";

/** What `GalleryMotionBench` renders. Asserted, not assumed. */
const BENCH_COUNT = 300;

/** The sidecar a copy of one session atom would have written (as `at0619`). */
const SIDECAR = JSON.stringify({
  version: 1,
  text: "￼",
  atoms: [
    {
      position: 0,
      segment: {
        kind: "atom",
        type: "session",
        label: CHIP_VALUE,
        value: CHIP_VALUE,
        session: { id: SESSION_ID, projectDir: PROJECT_DIR },
      },
    },
  ],
});

/**
 * Two panes, because the two cards are of two families.
 *
 * The bench registers as `maker` and the Session card does not, so a single
 * pane accepting both would be a shape the deck does not otherwise seat. What
 * the test needs is that the bench renders inside a `.tug-pane`, which it does
 * either way.
 */
function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
      {
        id: "B",
        componentId: "gallery-motion-bench-dot",
        title: "Motion bench (dot)",
        closable: true,
      },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 20, y: 20 },
        size: { width: 700, height: 560 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
      },
      {
        id: "p2",
        position: { x: 760, y: 20 },
        size: { width: 560, height: 560 },
        cardIds: ["B"],
        activeCardId: "B",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p2",
    hasFocus: true,
  };
}

interface CostReading {
  p50: number;
  p95: number;
  max: number;
  burst: number[];
}

/**
 * The mean of a burst, which is the only statistic fine enough for the
 * streamed leg's two falsifiers.
 *
 * `performance.now()` is coarsened to the millisecond in this engine, so
 * every reading in a burst is an integer and a percentile of them is an
 * integer too. That is fine for a budget gate — the budget is 16 ms and the
 * readings are 3 — and useless for "did this reading move", where the
 * difference the driver makes is a fraction of a millisecond on a bench this
 * cheap. Averaging sixty quantized samples recovers the resolution the
 * quantization took, because the rounding is what varies between them.
 *
 * Reported to two decimals wherever it is noted, so the `Diagnostics:`
 * section shows the separation rather than two numbers that read as equal.
 */
function mean(burst: readonly number[]): number {
  if (burst.length === 0) return 0;
  return burst.reduce((sum, ms) => sum + ms, 0) / burst.length;
}

/** A mean, rounded for a `note()`. */
function meanOf(reading: CostReading): number {
  return Math.round(mean(reading.burst) * 100) / 100;
}

/**
 * Take a `cost(frames)` reading.
 *
 * `evaluateJavaScript` does not await a promise, so the call is started, its
 * result parked on a slot, and the slot waited on. The wait is what turns an
 * occluded window — where `requestAnimationFrame` never fires and the promise
 * never settles — into a failure that says which reading hung.
 */
async function cost(
  app: App,
  slot: string,
  frames: number,
): Promise<CostReading> {
  await app.evalJS<null>(`(function(){
    window.${slot} = { done: false };
    window.__tugMotion.cost(${frames}).then(function (reading) {
      window.${slot} = { done: true, reading: reading };
    });
    return null;
  })()`);
  try {
    await app.waitForCondition<boolean>(
      `window.${slot} !== undefined && window.${slot}.done === true`,
      { timeoutMs: 60_000 },
    );
  } catch (cause) {
    throw new Error(
      `the '${slot}' render-cost reading never resolved. A ${frames}-frame ` +
        `burst needs ${frames * 2} frames, and an occluded or minimised ` +
        `window suspends requestAnimationFrame outright — check the harness ` +
        `window is raised before reading this as a deck that stopped painting.`,
      { cause },
    );
  }
  return app.evalJS<CostReading>(`(function(){
    var r = window.${slot}.reading;
    return { p50: r.p50, p95: r.p95, max: r.max, burst: r.burst };
  })()`);
}

describe.skipIf(!SHOULD_RUN)("at0629 — the deck's own render cost", () => {
  test(
    "a bench of breathing dots costs the frame less than the budget, and a single main-thread write costs more",
    async () => {
      const app = await launchTugApp({
        testName: "at0629-motion-render-cost",
        foreground: true,
      });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "B" });

        // ---- The population, counted inside the bench card. --------------
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(BENCH_DOTS)}).length === ${BENCH_COUNT}`,
          { timeoutMs: 30_000 },
        );

        // ---- The probe armed itself off the registry's rising edge. ------
        const armed = await app.evalJS<{
          armed: boolean;
          holds: number;
          budgetMs: number;
          demoted: boolean;
        }>(`(function(){
          var p = window.__tugMotion.probe();
          return {
            armed: p.armed, holds: p.holds,
            budgetMs: p.budgetMs, demoted: p.demoted,
          };
        })()`);
        note("at0629 probe", armed);
        expect(armed.armed).toBe(true);
        expect(armed.holds).toBeGreaterThan(0);
        expect(armed.demoted).toBe(false);
        const budgetMs = armed.budgetMs;

        // ---- The quiet reading: the claim. -------------------------------
        const quiet = await cost(app, "__at0629quiet", 60);
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
        await app.waitForCondition<boolean>(
          `window.__tugMotion.probe().samples.length >= 2`,
          { timeoutMs: 12_000 },
        );
        const sampled = await app.evalJS<{ costMs: number; inFlight: boolean }[]>(
          `window.__tugMotion.probe().samples.map(function (s) {
             return { costMs: s.costMs, inFlight: s.inFlight };
           })`,
        );
        note("at0629 sampled render cost", sampled);
        for (const sample of sampled) {
          expect(sample.costMs).toBeLessThan(budgetMs);
        }

        // ---- Residency: the loops are the qualifying form. ---------------
        const census = await app.evalJS<{
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
        const weld = await app.evalJS<{
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
        const afterRecalc = await app.evalJS<{
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
        const streamedPopulation = await app.evalJS<number>(
          `document.querySelectorAll(${JSON.stringify(BENCH_DOTS)}).length`,
        );
        const streaming = await app.evalJS<{ streaming: boolean }>(
          `window.__tugMotion.__stream(true)`,
        );
        expect(streaming.streaming).toBe(true);
        // The driver is demonstrably running before anything is read off it.
        // A silently no-opping driver is how a measurement of this shape gets
        // decided the wrong way.
        await app.waitForCondition<boolean>(
          `(function(){
             var el = document.querySelector('[data-tug-stream-node]');
             return el !== null && Number(el.getAttribute('data-tug-stream-tick')) > 5;
           })()`,
          { timeoutMs: 8_000 },
        );
        const streamed = await cost(app, "__at0629streamed", 60);
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
        const streamedDemoted = await app.evalJS<null>(`(function(){
          window.__tugMotion.demote(true);
          return null;
        })()`);
        expect(streamedDemoted).toBe(null);
        const demotedStream = await cost(app, "__at0629streamdemoted", 60);
        note("at0629 streamed render cost, loops demoted", {
          p50: demotedStream.p50,
          p95: demotedStream.p95,
          max: demotedStream.max,
          mean: meanOf(demotedStream),
        });
        await app.evalJS<unknown>(`window.__tugMotion.demote(false)`);
        await app.evalJS<unknown>(`window.__tugMotion.__stream(false)`);
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
          await app.evalJS<boolean>(
            `document.querySelector('[data-tug-stream-node]') === null`,
          ),
        ).toBe(true);

        // ---- The forcing probe: what makes the quiet reading falsifiable.
        const forcing = await app.evalJS<{ forcing: boolean }>(
          `window.__tugMotion.__force(true)`,
        );
        expect(forcing.forcing).toBe(true);
        await app.waitForCondition<boolean>(
          `(function(){
             var el = document.querySelector('.tug-progress-pulsing-dot-dot');
             return el !== null && el.style.transform !== "";
           })()`,
          { timeoutMs: 8_000 },
        );
        const forced = await cost(app, "__at0629forced", 60);
        note("at0629 forced render cost", {
          p50: forced.p50,
          p95: forced.p95,
          max: forced.max,
        });
        await app.evalJS<unknown>(`window.__tugMotion.__force(false)`);
        expect(
          forced.p50,
          `the driver that writes an inline transform every frame cost ` +
            `${forced.p50} ms against the quiet ${quiet.p50} ms. A forced ` +
            `reading that does not exceed the quiet one means the instrument ` +
            `is not reading the frame, not that the deck is fast.`,
        ).toBeGreaterThan(quiet.p50);

        // ---- The pause leg: the cost belongs to the loops. ---------------
        //
        // The count is derived from what the census reports inside the bench,
        // never written down: how many loops one glyph carries is a fact about
        // the stylesheet, and this test is about neither that number nor the
        // bench's count.
        const longRunningInBench = await app.evalJS<number>(
          `window.__tugMotion.list({ within: ${JSON.stringify(BENCH)} }).longRunning`,
        );
        const paused = await app.evalJS<number>(
          `window.__tugMotion.pause(${JSON.stringify(BENCH_LOOPS)}).paused`,
        );
        const pausedStates = await app.evalJS<string[]>(
          `Array.from(new Set(
             window.__tugMotion.list({ within: ${JSON.stringify(BENCH)} })
               .entries.map(function (e) { return e.playState; })
           ))`,
        );
        const pausedCost = await cost(app, "__at0629paused", 60);
        const resumed = await app.evalJS<number>(
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
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(COMPOSER)}) !== null`,
          { timeoutMs: 20_000 },
        );
        await app.focusElement(COMPOSER);
        await app.evalJS<null>(`(function(){
          var cm = document.querySelector(${JSON.stringify(COMPOSER)});
          var dt = new DataTransfer();
          dt.setData("text/plain", ${JSON.stringify(CHIP_VALUE)});
          dt.setData("application/x-tug-atoms", ${JSON.stringify(SIDECAR)});
          cm.dispatchEvent(new ClipboardEvent("paste", {
            bubbles: true, cancelable: true, clipboardData: dt,
          }));
          return null;
        })()`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP)}) !== null`,
          { timeoutMs: 8_000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LAYER_HOST)}) !== null`,
          { timeoutMs: 8_000 },
        );
        const chipDot = await app.evalJS<{
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
          await app.evalJS<boolean>(`window.__tugMotion.input().supported`),
        );

        // ---- The breaker, by hand: one attribute stills every loop. ------
        //
        // `demote(true)` sets `data-tug-motion-demoted` on `<html>`, which
        // resolves `--tug-loop-iterations` to 0. What that must NOT do is
        // change the component's own state: a dot still carries
        // `data-breathing`, because the demotion is a CSS answer to a CSS
        // contract and React never hears about it ([L06], [P09]).
        const demoted = await app.evalJS<{
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

        const undemoted = await app.evalJS<{
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

        // ---- The breaker, on its own: a budget nothing can meet. ---------
        //
        // A budget of zero makes every sample over budget, which is the one
        // way to drive the real trip path inside a test's patience: the probe
        // samples every 3 s and the run is three samples long.
        const mark = await app.markDeckTrace();
        await app.evalJS<unknown>(`window.__tugMotion.setBudget(0)`);
        await app.waitForCondition<boolean>(
          `window.__tugMotion.probe().demoted === true`,
          { timeoutMs: 15_000 },
        );
        const trace = await app.getDeckTrace({ since: mark });
        const trips = trace.filter(isMotionDemoted);
        note(
          "at0629 motion-demoted rows",
          trips.map((event) => ({
            costMs: event.costMs,
            budgetMs: event.budgetMs,
            trips: event.trips,
            latched: event.latched,
            longRunning: event.census.longRunning,
            byName: event.census.byName,
          })),
        );
        expect(trips.length).toBe(1);
        const trip = trips[0];
        expect(trip.costMs.length).toBe(3);
        expect(trip.budgetMs).toBe(0);
        expect(trip.latched).toBe(false);
        // The census is read BEFORE the demotion lands, so the row says what
        // the deck was paying for rather than what survived the answer.
        expect(trip.census.longRunning).toBeGreaterThan(0);
        expect(trip.census.violations).toEqual([]);

        const afterReset = await app.evalJS<{
          demoted: boolean;
          trips: number;
          latched: boolean;
          budgetMs: number;
          longRunning: number;
        }>(`(function(){
          window.__tugMotion.reset();
          var p = window.__tugMotion.probe();
          return {
            demoted: p.demoted, trips: p.trips, latched: p.latched,
            budgetMs: p.budgetMs,
            longRunning: window.__tugMotion.list().longRunning,
          };
        })()`);
        note("at0629 after reset", afterReset);
        expect(afterReset.demoted).toBe(false);
        expect(afterReset.trips).toBe(0);
        expect(afterReset.latched).toBe(false);
        // The budget goes back with everything else: a `setBudget(0)` that
        // survived would leave the deck one sample from demoting again.
        expect(afterReset.budgetMs).toBe(budgetMs);
        expect(afterReset.longRunning).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
