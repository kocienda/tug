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

import { launchTugApp, note, type App } from "./_harness";

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

/**
 * The list-hosted benches, seated alone for the off-screen legs — each under
 * its own card id, because the card host keeps a card's content by id, and a
 * re-seed that changed only the component would find the old list still
 * mounted under the new name.
 */
const LIST_CARD = "L";
const SKIP_CARD = "S";
function listBench(cardId: string): string {
  return `[data-card-id="${cardId}"]`;
}
function listDots(cardId: string): string {
  return `${listBench(cardId)} .tug-progress-pulsing-dot[data-breathing]`;
}
function listScroller(cardId: string): string {
  return `${listBench(cardId)} .tug-list-view`;
}

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

/** One pane, one list-hosted bench, for the off-screen legs. */
function listDeckShape(cardId: string, componentId: string) {
  return {
    cards: [{ id: cardId, componentId, title: "Motion bench (list)", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 20, y: 20 },
        size: { width: 560, height: 560 },
        cardIds: [cardId],
        activeCardId: cardId,
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

interface OffscreenReading {
  enabled: boolean;
  watched: number;
  paused: number;
}

/**
 * What the list bench's figures are doing: how many carry the off-screen
 * mark, how many carry any animation, and how many of those are running.
 */
interface ListFigures {
  dots: number;
  marked: number;
  animated: number;
  running: number;
  spreads: number[];
}

function listFigures(cardId: string): string {
  return `(function(){
  var roots = document.querySelectorAll(${JSON.stringify(listDots(cardId))});
  var marked = 0, animated = 0, running = 0, spreads = [];
  for (var i = 0; i < roots.length; i++) {
    var root = roots[i];
    if (root.hasAttribute("data-tug-offscreen")) marked++;
    var loops = root.getAnimations({ subtree: true })
      .filter(function (a) { return a instanceof CSSAnimation; });
    if (loops.length > 0) animated++;
    var st = [];
    for (var j = 0; j < loops.length; j++) {
      if (loops[j].playState === "running") running++;
      if (loops[j].startTime !== null) st.push(loops[j].startTime);
    }
    if (st.length > 1) {
      spreads.push(Math.max.apply(null, st) - Math.min.apply(null, st));
    }
  }
  return {
    dots: roots.length, marked: marked, animated: animated, running: running,
    spreads: Array.from(new Set(spreads)),
  };
})()`;
}

/**
 * Seat one list-hosted bench alone and wait for every row to mount. Inline
 * mode mounts all three hundred at their real heights; the wait is for the
 * dots to be breathing, which is the moment the observer has something to
 * watch.
 */
async function seatListBench(
  app: App,
  cardId: string,
  componentId: string,
): Promise<void> {
  await app.seedDeckState({
    state: listDeckShape(cardId, componentId),
    focusCardId: cardId,
  });
  await app.waitForCondition<boolean>(
    `document.querySelectorAll(${JSON.stringify(listDots(cardId))}).length === ${BENCH_COUNT}`,
    { timeoutMs: 30_000 },
  );
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

interface RestReading {
  updatesPerSecond: number;
  busyMsPerSecond: number;
  windowMs: number;
  ticks: number;
  medianGapMs: number;
  maxGapMs: number;
  floorMs: number;
}

/**
 * Take a `rest()` reading, parked on a slot the same way `cost` is.
 *
 * The chain runs on timers rather than frames, so it resolves even under an
 * occluded window — but the reading it takes there is of a throttled timer
 * queue, not of the deck, which is why every `rest` here follows a `cost`
 * that already proved the window is painting.
 */
async function rest(app: App, slot: string): Promise<RestReading> {
  await app.evalJS<null>(`(function(){
    window.${slot} = { done: false };
    window.__tugMotion.rest().then(function (reading) {
      window.${slot} = { done: true, reading: reading };
    });
    return null;
  })()`);
  await app.waitForCondition<boolean>(
    `window.${slot} !== undefined && window.${slot}.done === true`,
    { timeoutMs: 15_000 },
  );
  return app.evalJS<RestReading>(`window.${slot}.reading`);
}

/**
 * The bench's dots, split by whether their box intersects the pane's.
 *
 * The pane is the clip (`overflow: clip` on `.tug-pane`): a dot laid out
 * below the pane's bottom edge is inside the card's flow and out of view,
 * which is exactly the population the gauge has to be able to tell from the
 * one on screen. The card element itself is not the box to read — it is the
 * flow container, and it is as tall as its three hundred dots.
 */
const SPLIT_DOTS = `(function(){
  var roots = document.querySelectorAll(${JSON.stringify(BENCH_LOOPS)});
  var pane = roots.length > 0 ? roots[0].closest('.tug-pane') : null;
  if (pane === null) return { on: [], off: [] };
  var box = pane.getBoundingClientRect();
  var on = [], off = [];
  for (var i = 0; i < roots.length; i++) {
    var r = roots[i].getBoundingClientRect();
    var visible = r.bottom > box.top && r.top < box.bottom &&
                  r.right > box.left && r.left < box.right;
    (visible ? on : off).push(roots[i]);
  }
  return { on: on, off: off };
})()`;

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
        const shipped = await app.evalJS<OffscreenReading>(
          `window.__tugMotion.offscreen()`,
        );
        note("at0629 off-screen rule as shipped", shipped);
        expect(shipped.enabled).toBe(true);
        const quietShipped = await cost(app, "__at0629quietShipped", 60);
        const restShipped = await rest(app, "__at0629restShipped");
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
        const ruleOff = await app.evalJS<OffscreenReading>(
          `window.__tugMotion.offscreen(false)`,
        );
        note("at0629 off-screen rule parked for the flow bench", ruleOff);
        expect(ruleOff.enabled).toBe(false);
        expect(ruleOff.paused).toBe(0);

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

        // ---- The at-rest gauge: updates per second, three ways. ----------
        //
        // Every dot running is the bench as it is, and the reading is a
        // record rather than a claim: the dots below the card's fold dirty
        // style every frame on this WebKit, and until off-screen content
        // reads zero this number says how much of the bench is off screen.
        const restAll = await rest(app, "__at0629restAll");
        note("at0629 at rest, every dot running", restAll);
        expect(restAll.ticks).toBeGreaterThan(100);
        expect(restAll.windowMs).toBeGreaterThanOrEqual(1000);

        // The resident reading: pause only the dots the card has clipped
        // out of view, so what runs is the on-screen population — the one
        // that costs the frame nothing measurable. This is the reading the
        // doctrine's invariant is stated in, and it has to read under the
        // at-rest budget or the gauge cannot tell a resident deck from a
        // broken one.
        const split = await app.evalJS<{ on: number; off: number }>(`(function(){
          var s = ${SPLIT_DOTS};
          return { on: s.on.length, off: s.off.length };
        })()`);
        note("at0629 bench dots by placement", split);
        expect(split.on).toBeGreaterThan(0);
        expect(split.off).toBeGreaterThan(0);
        expect(split.on + split.off).toBe(BENCH_COUNT);
        const pausedOff = await app.evalJS<number>(`(function(){
          var s = ${SPLIT_DOTS};
          var n = 0;
          for (var i = 0; i < s.off.length; i++) {
            var loops = s.off[i].getAnimations({ subtree: true });
            for (var j = 0; j < loops.length; j++) { loops[j].pause(); n++; }
          }
          return n;
        })()`);
        expect(pausedOff).toBeGreaterThan(0);
        const restResident = await rest(app, "__at0629restResident");
        const resumedOff = await app.evalJS<number>(`(function(){
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
        await app.evalJS<unknown>(`window.__tugMotion.__force(true)`);
        await app.waitForCondition<boolean>(
          `(function(){
             var el = document.querySelector('.tug-progress-pulsing-dot-dot');
             return el !== null && el.style.transform !== "";
           })()`,
          { timeoutMs: 8_000 },
        );
        const restForced = await rest(app, "__at0629restForced");
        await app.evalJS<unknown>(`window.__tugMotion.__force(false)`);
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
        await app.evalJS<null>(`(function(){
          window.__at0629bisect = { done: false };
          window.__tugMotion.bisect({ frames: 10, cap: 4 }).then(function (r) {
            window.__at0629bisect = { done: true, reading: r };
          });
          return null;
        })()`);
        await app.waitForCondition<boolean>(
          `window.__at0629bisect !== undefined && window.__at0629bisect.done === true`,
          { timeoutMs: 30_000 },
        );
        const bisect = await app.evalJS<{
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
        const weldAfterBisect = await app.evalJS<{
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

        // ---- Off-screen content costs zero. ------------------------------
        //
        // The same population, one glyph to a row inside a list scroller,
        // nearly all of it under the fold. With the rule on, every figure out
        // of view carries the mark and no animation, and the deck reads under
        // the at-rest budget with three hundred dots mounted.
        await app.evalJS<unknown>(`window.__tugMotion.offscreen(true)`);
        await seatListBench(app, LIST_CARD, "gallery-motion-bench-dot-list");
        await app.waitForCondition<boolean>(
          `window.__tugMotion.offscreen().paused > 0`,
          { timeoutMs: 8_000 },
        );
        // A cost reading first: it proves the window is painting before a
        // timer-chain reading is trusted (see `rest`).
        const listCost = await cost(app, "__at0629listCost", 30);
        const ruleOn = await app.evalJS<OffscreenReading>(
          `window.__tugMotion.offscreen()`,
        );
        const figuresOn = await app.evalJS<ListFigures>(listFigures(LIST_CARD));
        const restRuleOn = await rest(app, "__at0629restRuleOn");
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
        const ruleOffList = await app.evalJS<OffscreenReading>(
          `window.__tugMotion.offscreen(false)`,
        );
        const figuresOff = await app.evalJS<ListFigures>(listFigures(LIST_CARD));
        const restRuleOff = await rest(app, "__at0629restRuleOff");
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
        await seatListBench(app, SKIP_CARD, "gallery-motion-bench-dot-list-skip");
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(`${listBench(SKIP_CARD)} .tug-list-view-cell[data-cv-ready]`)}).length === ${BENCH_COUNT}`,
          { timeoutMs: 15_000 },
        );
        const figuresSkip = await app.evalJS<ListFigures & { skipped: number }>(
          `(function(){
             var f = ${listFigures(SKIP_CARD)};
             f.skipped = document.querySelectorAll(${JSON.stringify(`${listBench(SKIP_CARD)} .tug-list-view-cell[data-cv-skipped]`)}).length;
             return f;
           })()`,
        );
        const restSkip = await rest(app, "__at0629restSkip");
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
        await app.evalJS<unknown>(`window.__tugMotion.offscreen(true)`);
        await seatListBench(app, LIST_CARD, "gallery-motion-bench-dot-list");
        await app.waitForCondition<boolean>(
          `window.__tugMotion.offscreen().paused > 0`,
          { timeoutMs: 8_000 },
        );
        const firstMarkedBefore = await app.evalJS<boolean>(`(function(){
          var roots = document.querySelectorAll(${JSON.stringify(listDots(LIST_CARD))});
          return roots[0].hasAttribute("data-tug-offscreen");
        })()`);
        await app.evalJS<unknown>(`(function(){
          var s = document.querySelector(${JSON.stringify(listScroller(LIST_CARD))});
          s.scrollTop = s.scrollHeight;
          return null;
        })()`);
        await app.waitForCondition<boolean>(
          `(function(){
             var roots = document.querySelectorAll(${JSON.stringify(listDots(LIST_CARD))});
             var first = roots[0], last = roots[roots.length - 1];
             return first.hasAttribute("data-tug-offscreen") &&
               !last.hasAttribute("data-tug-offscreen") &&
               last.getAnimations({ subtree: true }).length > 0;
           })()`,
          { timeoutMs: 8_000 },
        );
        const figuresScrolled = await app.evalJS<ListFigures>(listFigures(LIST_CARD));
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
