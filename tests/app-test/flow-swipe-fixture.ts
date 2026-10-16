/**
 * flow-swipe-fixture.ts — the deck, the swipe train and the sampler the
 * at0685 flow swipe files share: at0454's flow deck (five 420px cards in a
 * six-up beside a 420px Layout rail), a train of synthetic wheel events
 * dispatched in-page on a timer, and a timer-driven sampler of where a card
 * stands from before the first delta through the settle window.
 *
 * Split out of `at0685-flow-swipe-settles-from-hand.test.ts` when that file
 * was cut into `at0685-flow-swipe-quiet`, `-release-lift`, `-speed-flick` and
 * `-catch` to keep each under the 20 s budget.
 */

import { type App } from "./_harness";
import {
  FLOW_WHEEL_HUMP_PX,
  IMPOSITION_GAP_PX,
} from "../../tugdeck/src/lib/layout-imposer";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

/** The settle window, with room for the tween to land. */
export const AFTER_LAND_MS = 900;
/** The canvas wheel's idle quiet (`FLOW_WHEEL_IDLE_MS`), with slack. */
export const IDLE_MS = 180 + 120;
export const RAIL_WIDTH = 420;
export const PANE_WIDTH = 420;
export const KIND_TILES = '[data-testid="layout-card-kind"] [data-choice-value]';
/** The train: twelve events of twenty pixels, sixteen milliseconds apart. */
export const DELTA_PX = 20;
export const DELTA_COUNT = 12;
export const DELTA_GAP_MS = 16;
export const SWIPE_PX = DELTA_PX * DELTA_COUNT;
/** What the strip travels for that train: the sum, less the hump paid once. */
export const TRAVEL_PX = SWIPE_PX - FLOW_WHEEL_HUMP_PX;
/** One slot's pitch in the strip: a card and the gap after it. The stops of
 *  this fixture stand at multiples of it. */
export const SLOT_PITCH_PX = PANE_WIDTH + IMPOSITION_GAP_PX;
/** Forty percent of the way from the first slot to the second. */
export const PARTIAL_PX = Math.round(SLOT_PITCH_PX * 0.4);
/** A train that never clears the hump: six events of two pixels. */
export const UNDER_DELTA_PX = 2;
export const UNDER_COUNT = 6;
/** A pause inside a swipe, shorter than the idle quiet, longer than a frame. */
export const PAUSE_MS = 60;
/** The momentum macOS keeps sending after a lift: a decaying train. */
export const MOMENTUM_DELTAS = Array.from({ length: 24 }, (_, i) =>
  Math.max(1, Math.round(18 * 0.88 ** i)),
);
/** The longest stretch the card may stand still between the lift and the
 *  landing. The quiet-based ending leaves at least `FLOW_WHEEL_IDLE_MS`
 *  (180ms) after the last momentum delta; one move leaves only the settle's
 *  first-frame latency. */
export const MAX_PLATEAU_MS = 100;
/** A slow hand: the same twelve deltas, seventy milliseconds apart — still
 *  inside the lift's 80ms velocity window, so it reads as a slow hand rather
 *  than a stopped one, and far enough under the brisk hand that the two
 *  launches separate clearly. */
export const SLOW_GAP_MS = 70;
/** A brisk hand: the same twelve deltas, twenty-four milliseconds apart —
 *  quick enough to launch the slide faster than the slow hand, slow enough
 *  that the flick projection still aims short of the second stop. */
export const BRISK_GAP_MS = 24;
/** How far into the slide's curve, as a fraction of its keyframes, the fast
 *  and slow lifts are compared — early, where the launch is what differs. */
export const EARLY_FRACTION = 0.1;
/** How long after the lift the hand touches again — partway through the
 *  slide, which runs a few hundred milliseconds. */
export const CATCH_AFTER_MS = 80;
/** The deltas the catching hand sends. */
export const CATCH_DELTAS = 4;
/** The most a catch may move the strip: one frame of the slide's travel at
 *  its fastest, against the leap to the stop it would be without one. */
export const MAX_CATCH_STEP_PX = 30;

export const repeat = (px: number, count: number): number[] =>
  Array.from({ length: count }, () => px);

export const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Five cards in a six-up, plus the Layout card on the right, in FLOW. */
export function deckShape() {
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: PANE_WIDTH, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  const ids = ["A", "B", "C", "D", "E"];
  return {
    cards: [
      ...ids.map((id) => ({
        id,
        componentId: "hello",
        title: `Card ${id}`,
        closable: true,
      })),
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      ...ids.map((id, index) => pane(`p${index + 1}`, index, id)),
      {
        id: "pRail",
        position: { x: 0, y: 0 },
        size: { width: RAIL_WIDTH, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Layout",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p1",
    imposition: {
      kind: "six-up",
      layout: "flow",
      sidebars: { layout: { side: "right" } },
    },
    hasFocus: true,
  };
}

/** One reading of where the first slot's card stood, and when. */
export interface Sample {
  t: number;
  left: number;
  /** The offset property the strip is drawn with (`drawnOffset`). */
  drawn: number;
}

export interface SwipeTrace {
  samples: Sample[];
  /** When the last delta was dispatched — for a phased train, the last
   *  FINGER delta, dispatched in the task that sent `lifted`. */
  tLastDelta: number;
  /** Where the card stood in the task that dispatched the last delta. */
  handLeft: number;
  /** The drawn offset in that same task. */
  handDrawn: number;
  /** Phased trains only: the store's offset when the momentum ended, and how
   *  many momentum events the deck did not take. */
  storeAtTrainEnd: number | null;
  momentumUntaken: number;
  /** Phased trains only: the progress of the first slot's settle curve at
   *  each keyframe, read off its running animation in the lift's task. */
  launch: number[] | null;
}

export const paneLeftJS = `document
  .querySelector('.tug-pane[data-pane-id="p1"]')
  .getBoundingClientRect().left`;

export const drawnJS = `(parseFloat(document.querySelector('.tug-pane[data-pane-id="p1"]').style.getPropertyValue("--tug-imposer-flow-offset")) || 0)`;

export async function paneLeft(app: App): Promise<number> {
  return app.evalJS<number>(`(${paneLeftJS})`);
}

export async function stripOverflow(app: App): Promise<number> {
  return app.evalJS<number>(
    `(function () {
      var first = document.querySelector('.tug-pane[data-pane-id="p1"]').getBoundingClientRect();
      var last = document.querySelector('.tug-pane[data-pane-id="p5"]').getBoundingClientRect();
      var rail = document.querySelector('.tug-pane[data-pane-id="pRail"]').getBoundingClientRect();
      return (last.right - first.left) - (rail.left - first.left);
    })()`,
  );
}

export async function flowOffset(app: App): Promise<number> {
  return app.evalJS<number>(
    `(window.tugdeck.diag.getDeckState().flowOffset || 0)`,
  );
}

/** The offset property the first slot's frame is drawn with, in px. */
export async function drawnOffset(app: App): Promise<number> {
  return app.evalJS<number>(drawnJS);
}

export interface Train {
  /** Every event's deltaX, in order. */
  deltas: number[];
  gapMs: number;
  /** After this many events, wait `pauseMs` instead of `gapMs`. */
  pauseAfter?: number;
  pauseMs?: number;
  /** Drive the host's phase edges around the train: `touched` before the
   *  first delta, `lifted` after the last, then these momentum deltas. */
  momentum?: number[];
}

/** Arm the sampler, then dispatch the train in-page; the trace fills in. */
export async function startSwipe(app: App, train: Train): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var trace = {
        samples: [], tLastDelta: null, handLeft: null, handDrawn: null,
        storeAtTrainEnd: null, momentumUntaken: 0, launch: null, done: false,
        timer: null,
      };
      window.__swipe = trace;
      trace.timer = setInterval(function () {
        trace.samples.push({ t: performance.now(), left: ${paneLeftJS}, drawn: ${drawnJS} });
      }, 4);
      var el = document.querySelector("[data-deck-canvas-background]");
      var deltas = ${JSON.stringify(train.deltas)};
      var momentum = ${JSON.stringify(train.momentum ?? null)};
      var phase = function (edge) { window.__tugBridge.onScrollPhase(edge); };
      var wheel = function (dx) {
        var event = new WheelEvent("wheel", {
          deltaX: dx,
          deltaY: 0,
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(event);
        return event.defaultPrevented;
      };
      var sent = 0;
      var coasted = 0;
      var coast = function () {
        if (!wheel(momentum[coasted])) trace.momentumUntaken += 1;
        coasted += 1;
        if (coasted < momentum.length) {
          setTimeout(coast, ${train.gapMs});
          return;
        }
        trace.storeAtTrainEnd = window.tugdeck.diag.getDeckState().flowOffset || 0;
        trace.done = true;
      };
      var tick = function () {
        if (sent === 0 && momentum !== null) phase("touched");
        wheel(deltas[sent]);
        sent += 1;
        if (sent < deltas.length) {
          setTimeout(tick, sent === ${train.pauseAfter ?? -1} ? ${train.pauseMs ?? 0} : ${train.gapMs});
          return;
        }
        trace.tLastDelta = performance.now();
        trace.handLeft = ${paneLeftJS};
        trace.handDrawn = ${drawnJS};
        if (momentum === null) {
          trace.done = true;
          return;
        }
        phase("lifted");
        var frame = document.querySelector('.tug-pane[data-pane-id="p1"]');
        frame.getAnimations().forEach(function (a) {
          var tx = a.effect.getKeyframes().map(function (k) {
            var m = /translate\\((-?[\\d.]+)px/.exec(k.transform || "");
            return m === null ? null : parseFloat(m[1]);
          });
          if (trace.launch !== null || tx.length < 3 || tx[0] === null || tx[0] === 0) return;
          trace.launch = tx.map(function (x) { return 1 - (x || 0) / tx[0]; });
        });
        setTimeout(coast, ${train.gapMs});
      };
      setTimeout(tick, 40);
      return null;
    })()`,
  );
  await app.waitForCondition<boolean>(`window.__swipe.done === true`, {
    timeoutMs: 5_000,
  });
}

/** Stop the sampler and answer everything it saw, oldest first. */
export async function stopSwipe(app: App): Promise<SwipeTrace> {
  return app.evalJS<SwipeTrace>(
    `(function () {
      clearInterval(window.__swipe.timer);
      return {
        samples: window.__swipe.samples,
        tLastDelta: window.__swipe.tLastDelta,
        handLeft: window.__swipe.handLeft,
        handDrawn: window.__swipe.handDrawn,
        storeAtTrainEnd: window.__swipe.storeAtTrainEnd,
        momentumUntaken: window.__swipe.momentumUntaken,
        launch: window.__swipe.launch,
      };
    })()`,
  );
}
