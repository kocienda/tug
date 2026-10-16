/**
 * motion-render-cost-fixture.ts — the bench deck, the list benches and the
 * `cost` / `rest` readers the at0629 render-cost files share.
 *
 * Split out of `at0629-motion-render-cost.test.ts` when that file was cut into
 * `at0629-motion-render-cost-budget`, `-stream`, `-rest` and `-offscreen` to
 * keep each under the 20 s budget.
 */

import { type App } from "./_harness";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 180_000;

export const SESSION_ID = "aa11bb22-0000-4000-8000-0000000a0629";
export const TAG = "curly-apple";
export const PROJECT_DIR = "/Users/tester/src/tugtool";
export const CHIP_VALUE = `tugtool/${TAG}`;

/** The bench card, and the scope every population reading is taken in. */
export const BENCH = '[data-card-id="B"]';
export const BENCH_DOTS = `${BENCH} .tug-progress-pulsing-dot[data-breathing]`;
/** Every animation inside the bench, for the pause leg. */
export const BENCH_LOOPS = `${BENCH} .tug-progress-pulsing-dot`;

/**
 * The list-hosted benches, seated alone for the off-screen legs — each under
 * its own card id, because the card host keeps a card's content by id, and a
 * re-seed that changed only the component would find the old list still
 * mounted under the new name.
 */
export const LIST_CARD = "L";
export const SKIP_CARD = "S";
export function listBench(cardId: string): string {
  return `[data-card-id="${cardId}"]`;
}
export function listDots(cardId: string): string {
  return `${listBench(cardId)} .tug-progress-pulsing-dot[data-breathing]`;
}
export function listScroller(cardId: string): string {
  return `${listBench(cardId)} .tug-list-view`;
}

export const COMPOSER = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';
export const CHIP = `${COMPOSER} img[data-atom-well-x]`;
export const LAYER_HOST = ".cm-tug-session-dot-layer .cm-tug-session-dot-host";

/** What `GalleryMotionBench` renders. Asserted, not assumed. */
export const BENCH_COUNT = 300;

/** The sidecar a copy of one session atom would have written (as `at0619`). */
export const SIDECAR = JSON.stringify({
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
export function deckShape() {
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
export function listDeckShape(cardId: string, componentId: string) {
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

export interface OffscreenReading {
  enabled: boolean;
  watched: number;
  paused: number;
}

/**
 * What the list bench's figures are doing: how many carry the off-screen
 * mark, how many carry any animation, and how many of those are running.
 */
export interface ListFigures {
  dots: number;
  marked: number;
  animated: number;
  running: number;
  spreads: number[];
}

export function listFigures(cardId: string): string {
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
export async function seatListBench(
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

export interface CostReading {
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
export function mean(burst: readonly number[]): number {
  if (burst.length === 0) return 0;
  return burst.reduce((sum, ms) => sum + ms, 0) / burst.length;
}

/** A mean, rounded for a `note()`. */
export function meanOf(reading: CostReading): number {
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
export async function cost(
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

export interface RestReading {
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
export async function rest(app: App, slot: string): Promise<RestReading> {
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
export const SPLIT_DOTS = `(function(){
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
