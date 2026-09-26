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
