/**
 * at0685-flow-swipe-settles-from-hand.test.ts — a trackpad swipe clears a
 * small hump before the strip moves, and the settle after it runs from where
 * the hand left the cards to the next slot the way the hand was going, never
 * backwards.
 *
 * ## The defect
 *
 * A horizontal wheel on the canvas draws the strip through
 * `previewFlowOffset` on every event and commits once, after the idle quiet.
 * The settle's flow slide used to plan its origin from the store's LAST
 * COMMITTED offset — which, after a swipe, is where the strip stood before the
 * hand touched it. The slide's inverse transform held every frame at that
 * stale origin for its first frame and then tweened the whole swipe distance
 * again: the cards snapped back and replayed the swipe. The fix is one fact
 * kept where the truth of the screen already lives — the per-frame writer
 * remembers the offset it drew, and the arm reads it as the origin — and a
 * commit of the very number the deck was drawing lands `"cut"`, because the
 * frames are already where it puts them.
 *
 * ## Why the recorder is armed BEFORE the gesture
 *
 * The defect lands in the frame where the commit lands. A row clocked from
 * the settle arm (`settle-frames`) begins AFTER that frame and cannot see it;
 * a reading taken after the settle sees only that the cards ended up in the
 * right place, which was always true. So this file samples where a card
 * actually stands, from before the first delta through the end of the settle
 * window, and asserts over the whole trace: no sample behind the hand's last
 * drawn position, and travel monotonic in the direction of the swipe.
 *
 * The sampler is a timer rather than `requestAnimationFrame`, which an
 * occluded harness window suspends; the reading is `getBoundingClientRect`,
 * which carries a running tween's transform and so answers where the card IS.
 *
 * ## The hump
 *
 * A resting hand sends a pixel or two of sideways delta, and a strip that
 * tracked 1:1 from the first event juddered on every one. So a gesture opens
 * held and draws nothing until its deltas sum past `FLOW_WHEEL_HUMP_PX`; the
 * first event past it draws the sum less the hump, so there is no lurch. The
 * second case drives a train that never clears it and asserts the card, the
 * store and the offset property all stand where they were; then a train that
 * clears it with a pause inside and asserts the travel is the sum less ONE
 * hump — a pause within a swipe does not re-arm it.
 *
 * ## The release
 *
 * The idle commit does not land wherever the hand stopped: it resolves the
 * next STOP — a slot's aligned offset, or a clamped end — in the direction of
 * the hand's last few deltas, and the settle slides there from the drawn
 * offset on a critically damped curve from rest, which cannot overshoot. Not
 * the nearest stop: a swipe that stopped forty percent of the way would be
 * sent back, which is the forbidden motion. The third case stops a swipe
 * forty percent past the first slot and asserts the settle lands on the
 * second with every frame moving one way; then reverses inside a swipe and
 * asserts the settle goes the way the hand LAST moved.
 *
 * ## The lift
 *
 * On a trackpad the deck does not wait for the quiet. Tug.app forwards the
 * fingers' phase edges over `__tugBridge.onScrollPhase`, and the gesture ends
 * the instant the `lifted` edge arrives: the stop is committed then, and every
 * delta macOS sends on the hand's behalf afterwards — the momentum — is taken
 * and drawn nowhere, so the settle from the hand to the stop is the only
 * motion. Synthetic wheel events never pass through AppKit, so the fourth case
 * calls the bridge handler itself around the train: `touched`, the finger
 * deltas, `lifted`, then a decaying momentum train. It asserts the store held
 * the stop before the momentum ended, the drawn offset never took a momentum
 * delta, every momentum event was taken, and the card ran one way from the
 * hand to the stop with no plateau — the glide-then-wait the quiet used to
 * leave. The first three cases send no edges, and are the quiet's fallback.
 *
 * ## The hand's speed
 *
 * The slide from a lift launches at the hand's measured speed, toward the
 * stop only, so a fast lift lands fast and a slow one slow — the curve's
 * shape changes and its destination does not. The fifth case lifts the same
 * finger travel twice from a stop, once fast and once slow, so the distance
 * from hand to stop is the same, and asserts the fast slide's curve covers
 * more ground in its first tenth, with every sampled frame of both one-way
 * and none past its stop. The curve is read off the slide's own keyframes,
 * in the lift's task: sampled positions this early carry the first frame's
 * latency, which differs slide to slide by more than the launch does.
 *
 * Both lifts here, and every lift case that asserts the NEXT stop, move at a
 * brisk pace the flick projection still lands one slot on — `BRISK_GAP_MS`.
 *
 * ## The flick
 *
 * A quick swipe travels more than one slot: the lift projects the hand on at
 * its speed (`FLOW_FLICK_COAST_S` × `FLOW_FLICK_SENSITIVITY`) and lands on the
 * stop ahead nearest that aim. The flick case lifts the same finger travel
 * fast, from rest, and asserts it settles past the next stop, on the offset it
 * committed at the lift, with every frame one-way and none past where it lands.
 *
 * ## The catch
 *
 * A touch while the slide from a lift is still running catches the strip: the
 * settle hands it over where it stands on screen, and the hand moves it 1:1
 * from there with no hump re-armed. The sixth case lifts, touches again
 * partway through the slide, and sends a few deltas; it asserts the strip was
 * caught where the slide had it rather than leaping to the stop, the first
 * delta drew from the caught place, and the whole trace ran one way.
 *
 * ## The fixture
 *
 * at0454's flow deck: five 420px cards in a six-up beside a 420px Layout
 * rail, a strip comfortably longer than the band on any window this harness
 * opens. The strip's overflow is asserted rather than assumed — a band with
 * no room to swipe into would move nothing and prove nothing.
 *
 * The swipe is a train of synthetic wheel events through the deck's own
 * handler, so the offset that lands is one the product clamped and
 * committed. The train is dispatched in-page on a timer, spaced well inside
 * the handler's idle quiet, so a slow RPC round trip cannot end the gesture
 * early; the hand's last drawn position is read in the same task as the
 * last dispatch, before any frame could move it.
 *
 * `deck-manager.ts` and `deck-canvas.tsx` are deliberately NOT named, and the
 * absence is the selection budget's answer rather than an oversight: both
 * already fan out to the count `ACCEPTED_FANOUT` records, and one more namer
 * would turn a one-line edit there into a sweep. What this file needs covered
 * is the drawn offset's CONTRACT — that the writer remembers it and the arm
 * reads it as the origin — which is `deck-manager-store.ts`'s doc comment and
 * the settle engine's arm, and the hump's size, which is the constant in
 * `layout-imposer.ts`; all three are named below.
 *
 * @covers tugdeck/src/deck-manager-store.ts
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/lib/scroll-phase-bridge.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import {
  FLOW_WHEEL_HUMP_PX,
  IMPOSITION_GAP_PX,
} from "../../tugdeck/src/lib/layout-imposer";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** The settle window, with room for the tween to land. */
const AFTER_LAND_MS = 900;
/** The canvas wheel's idle quiet (`FLOW_WHEEL_IDLE_MS`), with slack. */
const IDLE_MS = 180 + 120;
/** Frames are measured in device pixels; a rounded pin is within a pixel. */
const TOL = 1.5;
const RAIL_WIDTH = 420;
const PANE_WIDTH = 420;
const KIND_TILES = '[data-testid="layout-card-kind"] [data-choice-value]';
/** The train: twelve events of twenty pixels, sixteen milliseconds apart. */
const DELTA_PX = 20;
const DELTA_COUNT = 12;
const DELTA_GAP_MS = 16;
const SWIPE_PX = DELTA_PX * DELTA_COUNT;
/** What the strip travels for that train: the sum, less the hump paid once. */
const TRAVEL_PX = SWIPE_PX - FLOW_WHEEL_HUMP_PX;
/** One slot's pitch in the strip: a card and the gap after it. The stops of
 *  this fixture stand at multiples of it. */
const SLOT_PITCH_PX = PANE_WIDTH + IMPOSITION_GAP_PX;
/** Forty percent of the way from the first slot to the second. */
const PARTIAL_PX = Math.round(SLOT_PITCH_PX * 0.4);
/** A train that never clears the hump: six events of two pixels. */
const UNDER_DELTA_PX = 2;
const UNDER_COUNT = 6;
/** A pause inside a swipe, shorter than the idle quiet, longer than a frame. */
const PAUSE_MS = 60;
/** The momentum macOS keeps sending after a lift: a decaying train. */
const MOMENTUM_DELTAS = Array.from({ length: 24 }, (_, i) =>
  Math.max(1, Math.round(18 * 0.88 ** i)),
);
/** The longest stretch the card may stand still between the lift and the
 *  landing. The quiet-based ending leaves at least `FLOW_WHEEL_IDLE_MS`
 *  (180ms) after the last momentum delta; one move leaves only the settle's
 *  first-frame latency. */
const MAX_PLATEAU_MS = 100;
/** A slow hand: the same twelve deltas, seventy milliseconds apart — still
 *  inside the lift's 80ms velocity window, so it reads as a slow hand rather
 *  than a stopped one, and far enough under the brisk hand that the two
 *  launches separate clearly. */
const SLOW_GAP_MS = 70;
/** A brisk hand: the same twelve deltas, twenty-four milliseconds apart —
 *  quick enough to launch the slide faster than the slow hand, slow enough
 *  that the flick projection still aims short of the second stop. */
const BRISK_GAP_MS = 24;
/** How far into the slide's curve, as a fraction of its keyframes, the fast
 *  and slow lifts are compared — early, where the launch is what differs. */
const EARLY_FRACTION = 0.1;
/** How long after the lift the hand touches again — partway through the
 *  slide, which runs a few hundred milliseconds. */
const CATCH_AFTER_MS = 80;
/** The deltas the catching hand sends. */
const CATCH_DELTAS = 4;
/** The most a catch may move the strip: one frame of the slide's travel at
 *  its fastest, against the leap to the stop it would be without one. */
const MAX_CATCH_STEP_PX = 30;

const repeat = (px: number, count: number): number[] =>
  Array.from({ length: count }, () => px);

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Five cards in a six-up, plus the Layout card on the right, in FLOW. */
function deckShape() {
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
interface Sample {
  t: number;
  left: number;
  /** The offset property the strip is drawn with (`drawnOffset`). */
  drawn: number;
}

interface SwipeTrace {
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

const paneLeftJS = `document
  .querySelector('.tug-pane[data-pane-id="p1"]')
  .getBoundingClientRect().left`;

const drawnJS = `(parseFloat(document.querySelector('.tug-pane[data-pane-id="p1"]').style.getPropertyValue("--tug-imposer-flow-offset")) || 0)`;

async function paneLeft(app: App): Promise<number> {
  return app.evalJS<number>(`(${paneLeftJS})`);
}

async function stripOverflow(app: App): Promise<number> {
  return app.evalJS<number>(
    `(function () {
      var first = document.querySelector('.tug-pane[data-pane-id="p1"]').getBoundingClientRect();
      var last = document.querySelector('.tug-pane[data-pane-id="p5"]').getBoundingClientRect();
      var rail = document.querySelector('.tug-pane[data-pane-id="pRail"]').getBoundingClientRect();
      return (last.right - first.left) - (rail.left - first.left);
    })()`,
  );
}

async function flowOffset(app: App): Promise<number> {
  return app.evalJS<number>(
    `(window.tugdeck.diag.getDeckState().flowOffset || 0)`,
  );
}

/** The offset property the first slot's frame is drawn with, in px. */
async function drawnOffset(app: App): Promise<number> {
  return app.evalJS<number>(drawnJS);
}

interface Train {
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
async function startSwipe(app: App, train: Train): Promise<void> {
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
async function stopSwipe(app: App): Promise<SwipeTrace> {
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

describe.skipIf(!SHOULD_RUN)("at0685 — flow swipe settles from the hand", () => {
  test(
    "after the idle commit no frame stands behind the hand, and travel is monotonic",
    async () => {
      const app = await launchTugApp({
        testName: "at0685-flow-swipe-settles-from-hand",
      });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(KIND_TILES)}).length > 0`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // ── The fixture earns its assertions ────────────────────────────────
        const overflow = await stripOverflow(app);
        note(`strip overflows the band by ${Math.round(overflow)}px`);
        expect(
          overflow,
          "the strip must overflow by more than the swipe, or the clamp absorbs it",
        ).toBeGreaterThan(SWIPE_PX + PANE_WIDTH);
        expect(await flowOffset(app), "the strip starts at rest").toBe(0);
        const restLeft = await paneLeft(app);

        // ── The swipe, sampled the whole way through ─────────────────────────
        await startSwipe(app, {
          deltas: repeat(DELTA_PX, DELTA_COUNT),
          gapMs: DELTA_GAP_MS,
        });
        await wait(IDLE_MS + AFTER_LAND_MS);
        const trace = await stopSwipe(app);
        const after = trace.samples.filter((s) => s.t >= trace.tLastDelta);
        note(
          `${trace.samples.length} samples, ${after.length} after the last delta; ` +
            `rest ${Math.round(restLeft)}, hand ${Math.round(trace.handLeft)}, ` +
            `end ${Math.round(trace.samples[trace.samples.length - 1].left)}`,
        );

        // The hand moved the strip: twelve deltas of twenty is 240px less the
        // hump, and the card the band shows first stands that much further
        // left.
        expect(
          restLeft - trace.handLeft,
          "the strip tracked the hand",
        ).toBeCloseTo(TRAVEL_PX, 0);
        expect(after.length, "the recorder saw the settle").toBeGreaterThan(10);

        // No frame behind the hand. The snap-back is the first frame after the
        // commit: a slide planned from the pre-swipe offset holds every card
        // at `restLeft` for a frame and tweens it forward again.
        const behind = after.filter((s) => s.left > trace.handLeft + TOL);
        const worst = behind.reduce(
          (m, s) => Math.max(m, s.left - trace.handLeft),
          0,
        );
        note(
          `frames behind the hand: ${behind.length}` +
            (behind.length > 0 ? ` (worst ${Math.round(worst)}px back)` : ""),
        );
        expect(
          behind.length,
          `${behind.length} frame(s) stood behind the hand, up to ${Math.round(worst)}px`,
        ).toBe(0);

        // Monotonic in the swipe's direction: a positive deltaX moves the
        // strip right-to-left, so `left` never grows from one sample to the
        // next, before or after the commit.
        let backtracks = 0;
        let worstBacktrack = 0;
        for (let i = 1; i < trace.samples.length; i += 1) {
          const step = trace.samples[i].left - trace.samples[i - 1].left;
          if (step > TOL) {
            backtracks += 1;
            worstBacktrack = Math.max(worstBacktrack, step);
          }
        }
        note(
          `backtracking steps: ${backtracks}` +
            (backtracks > 0 ? ` (worst ${Math.round(worstBacktrack)}px)` : ""),
        );
        expect(
          backtracks,
          `the card moved backwards ${backtracks} time(s), up to ${Math.round(worstBacktrack)}px`,
        ).toBe(0);

        // And the release carried on to the next stop the way the hand was
        // going: the second slot's aligned offset, one pitch along.
        expect(await flowOffset(app), "the store holds the next stop").toBeCloseTo(
          SLOT_PITCH_PX,
          0,
        );
        expect(
          Math.abs((await paneLeft(app)) - (restLeft - SLOT_PITCH_PX)),
          "the card ends on the next slot's stop",
        ).toBeLessThanOrEqual(TOL);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a swipe under the hump moves nothing and commits nothing; the hump is paid once",
    async () => {
      const app = await launchTugApp({
        testName: "at0685-flow-swipe-hump",
      });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(KIND_TILES)}).length > 0`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);
        expect(await flowOffset(app), "the strip starts at rest").toBe(0);
        const restLeft = await paneLeft(app);
        const restDrawn = await drawnOffset(app);

        // ── Under the hump ───────────────────────────────────────────────────
        const underPx = UNDER_DELTA_PX * UNDER_COUNT;
        expect(underPx, "the train must sit under the hump").toBeLessThan(
          FLOW_WHEEL_HUMP_PX,
        );
        await startSwipe(app, {
          deltas: repeat(UNDER_DELTA_PX, UNDER_COUNT),
          gapMs: DELTA_GAP_MS,
        });
        await wait(IDLE_MS + AFTER_LAND_MS);
        const under = await stopSwipe(app);
        const moved = under.samples.filter(
          (s) => Math.abs(s.left - restLeft) > TOL,
        );
        note(
          `under the hump: ${underPx}px over ${UNDER_COUNT} events; ` +
            `${under.samples.length} samples, ${moved.length} off the rest position`,
        );
        expect(moved.length, "the card never moved").toBe(0);
        expect(await drawnOffset(app), "nothing was drawn").toBe(restDrawn);
        expect(await flowOffset(app), "nothing was committed").toBe(0);

        // ── Over the hump, with a pause inside ───────────────────────────────
        await startSwipe(app, {
          deltas: repeat(DELTA_PX, DELTA_COUNT),
          gapMs: DELTA_GAP_MS,
          pauseAfter: 4,
          pauseMs: PAUSE_MS,
        });
        await wait(IDLE_MS + AFTER_LAND_MS);
        const over = await stopSwipe(app);
        note(
          `over the hump with a ${PAUSE_MS}ms pause: rest ${Math.round(restLeft)}, ` +
            `hand ${Math.round(over.handLeft)}`,
        );
        expect(
          restLeft - over.handLeft,
          "the strip travelled the sum less one hump",
        ).toBeCloseTo(TRAVEL_PX, 0);
        expect(await flowOffset(app), "the store holds the travel").toBeCloseTo(
          SLOT_PITCH_PX,
          0,
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the release lands on the next stop the way the hand was last moving, one way only",
    async () => {
      const app = await launchTugApp({
        testName: "at0685-flow-swipe-next-stop",
      });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(KIND_TILES)}).length > 0`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);
        expect(await flowOffset(app), "the strip starts at rest").toBe(0);
        const restLeft = await paneLeft(app);

        /** Steps between consecutive samples after the last delta that run
         *  against `dir` (+1: left must not grow; -1: left must not fall). */
        const against = (trace: SwipeTrace, dir: 1 | -1): number => {
          const after = trace.samples.filter((s) => s.t >= trace.tLastDelta);
          let count = 0;
          for (let i = 1; i < after.length; i += 1) {
            const step = (after[i].left - after[i - 1].left) * dir;
            if (step > TOL) count += 1;
          }
          return count;
        };

        // ── Forty percent of the way, moving right ───────────────────────────
        // Six equal deltas whose sum is the hump plus the partial travel, so
        // the hand stops short of halfway — where a nearest-stop rule would
        // send it back to the slot it left.
        const partialDelta = (FLOW_WHEEL_HUMP_PX + PARTIAL_PX) / 6;
        await startSwipe(app, {
          deltas: repeat(partialDelta, 6),
          gapMs: DELTA_GAP_MS,
        });
        await wait(IDLE_MS + AFTER_LAND_MS);
        const partial = await stopSwipe(app);
        const partialTravel = restLeft - partial.handLeft;
        note(
          `partial: hand ${Math.round(partialTravel)}px along of a ${SLOT_PITCH_PX}px pitch, ` +
            `settled offset ${await flowOffset(app)}, ` +
            `${against(partial, 1)} step(s) against the hand`,
        );
        expect(partialTravel, "the hand stopped short of halfway").toBeLessThan(
          SLOT_PITCH_PX / 2,
        );
        expect(
          await flowOffset(app),
          "the release went ON to the next slot, not back",
        ).toBeCloseTo(SLOT_PITCH_PX, 0);
        expect(
          Math.abs((await paneLeft(app)) - (restLeft - SLOT_PITCH_PX)),
          "the card stands on the second slot's stop",
        ).toBeLessThanOrEqual(TOL);
        expect(
          against(partial, 1),
          "every frame after the hand moved the hand's way",
        ).toBe(0);

        // ── A reversal inside the swipe ──────────────────────────────────────
        // From the second slot: six deltas right, then four left. The net is
        // still rightward; the hand was LAST moving left, so the release
        // settles back on to the second slot, and the card moves only right.
        const slotLeft = await paneLeft(app);
        await startSwipe(app, {
          deltas: [...repeat(DELTA_PX, 6), ...repeat(-10, 4)],
          gapMs: DELTA_GAP_MS,
        });
        await wait(IDLE_MS + AFTER_LAND_MS);
        const reversed = await stopSwipe(app);
        note(
          `reversal: hand ${Math.round(slotLeft - reversed.handLeft)}px past the slot, ` +
            `settled offset ${await flowOffset(app)}, ` +
            `${against(reversed, -1)} step(s) against the hand`,
        );
        expect(
          slotLeft - reversed.handLeft,
          "the hand still stood past the slot when it stopped",
        ).toBeGreaterThan(TOL);
        expect(
          await flowOffset(app),
          "the release went the way the hand last moved",
        ).toBeCloseTo(SLOT_PITCH_PX, 0);
        expect(
          against(reversed, -1),
          "every frame after the hand moved the hand's way",
        ).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "on a lift the settle starts at once, and the momentum is never drawn",
    async () => {
      const app = await launchTugApp({
        testName: "at0685-flow-swipe-lift",
      });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(KIND_TILES)}).length > 0`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);
        expect(await flowOffset(app), "the strip starts at rest").toBe(0);
        const restLeft = await paneLeft(app);
        const stopLeft = restLeft - SLOT_PITCH_PX;

        // ── touched, the finger deltas, lifted, then the momentum ────────────
        await startSwipe(app, {
          deltas: repeat(DELTA_PX, DELTA_COUNT),
          gapMs: BRISK_GAP_MS,
          momentum: MOMENTUM_DELTAS,
        });
        await wait(AFTER_LAND_MS);
        const trace = await stopSwipe(app);
        const stopDrawn = await drawnOffset(app);
        const after = trace.samples.filter((s) => s.t >= trace.tLastDelta);

        expect(
          restLeft - trace.handLeft,
          "the strip tracked the fingers",
        ).toBeCloseTo(TRAVEL_PX, 0);
        expect(after.length, "the recorder saw the settle").toBeGreaterThan(10);

        // The stop was committed at the lift, not after the momentum's quiet.
        expect(
          trace.storeAtTrainEnd,
          "the store held the next stop before the momentum ended",
        ).toBeCloseTo(SLOT_PITCH_PX, 0);
        expect(trace.momentumUntaken, "every momentum event was taken").toBe(0);

        // No momentum delta was drawn: from the lift on, the strip's offset
        // property is either the hand's last drawn value or the stop's.
        const strays = after.filter(
          (s) =>
            Math.abs(s.drawn - trace.handDrawn) > TOL &&
            Math.abs(s.drawn - stopDrawn) > TOL,
        );
        note(
          `lift: hand drawn ${trace.handDrawn}, stop drawn ${stopDrawn}, ` +
            `${strays.length} sample(s) drawn elsewhere`,
        );
        expect(strays.length, "no momentum delta was drawn").toBe(0);

        // One way, from the hand to the stop, never past it.
        let backtracks = 0;
        for (let i = 1; i < trace.samples.length; i += 1) {
          if (trace.samples[i].left - trace.samples[i - 1].left > TOL) backtracks += 1;
        }
        const past = after.filter((s) => s.left < stopLeft - TOL);
        expect(backtracks, "the card only ever moved the hand's way").toBe(0);
        expect(past.length, "no frame went past the stop").toBe(0);

        // No plateau between the hand and the landing: the longest stretch the
        // card stood still before it reached the stop.
        const landed = after.find((s) => Math.abs(s.left - stopLeft) <= TOL);
        expect(landed, "the card reached the stop").toBeDefined();
        let plateau = 0;
        let stillSince = trace.tLastDelta;
        let lastLeft = trace.handLeft;
        for (const s of after) {
          if (s.t > landed!.t) break;
          if (Math.abs(s.left - lastLeft) > 0.01) {
            stillSince = s.t;
            lastLeft = s.left;
          }
          plateau = Math.max(plateau, s.t - stillSince);
        }
        note(
          `lift to landing ${Math.round(landed!.t - trace.tLastDelta)}ms, ` +
            `longest stand ${Math.round(plateau)}ms`,
        );
        expect(
          plateau,
          `the card stood still ${Math.round(plateau)}ms between the hand and the landing`,
        ).toBeLessThan(MAX_PLATEAU_MS);
        expect(
          Math.abs((await paneLeft(app)) - stopLeft),
          "the card ends on the next slot's stop",
        ).toBeLessThanOrEqual(TOL);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the slide from a lift launches at the hand's speed, one way, to the same stop",
    async () => {
      const app = await launchTugApp({
        testName: "at0685-flow-swipe-hand-speed",
      });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(KIND_TILES)}).length > 0`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);
        expect(await flowOffset(app), "the strip starts at rest").toBe(0);

        /** Lift one finger train from the stop the strip stands on; answer
         *  how much of the travel the slide's curve covers `EARLY_FRACTION`
         *  in, and the one-way and no-overshoot counts. */
        const lift = async (gapMs: number, stops: number) => {
          const fromLeft = await paneLeft(app);
          const stopLeft = fromLeft - SLOT_PITCH_PX;
          await startSwipe(app, {
            deltas: repeat(DELTA_PX, DELTA_COUNT),
            gapMs,
            momentum: MOMENTUM_DELTAS,
          });
          await wait(AFTER_LAND_MS);
          const trace = await stopSwipe(app);
          const after = trace.samples.filter((s) => s.t >= trace.tLastDelta);
          const launch = trace.launch ?? [];
          const early = launch[Math.round((launch.length - 1) * EARLY_FRACTION)];
          let backtracks = 0;
          for (let i = 1; i < trace.samples.length; i += 1) {
            if (trace.samples[i].left - trace.samples[i - 1].left > TOL) backtracks += 1;
          }
          return {
            handToStop: trace.handLeft - stopLeft,
            early: early ?? 0,
            launched: launch.length,
            backtracks,
            past: after.filter((s) => s.left < stopLeft - TOL).length,
            landed: Math.abs((await paneLeft(app)) - stopLeft),
            store: await flowOffset(app),
            stop: SLOT_PITCH_PX * stops,
          };
        };

        const fast = await lift(BRISK_GAP_MS, 1);
        const slow = await lift(SLOW_GAP_MS, 2);
        note(
          `hand to stop: fast ${Math.round(fast.handToStop)}px, slow ${Math.round(slow.handToStop)}px; ` +
            `curve at ${EARLY_FRACTION * 100}%: fast ${fast.early.toFixed(3)}, slow ${slow.early.toFixed(3)} of the travel`,
        );

        expect(
          Math.abs(fast.handToStop - slow.handToStop),
          "both lifts left the same distance to their stop",
        ).toBeLessThanOrEqual(TOL);
        for (const [name, run] of [["fast", fast], ["slow", slow]] as const) {
          expect(run.launched, `the ${name} lift launched a slide`).toBeGreaterThan(2);
          expect(run.store, `the ${name} lift settled on its next stop`).toBeCloseTo(run.stop, 0);
          expect(run.landed, `the ${name} card ends on its stop`).toBeLessThanOrEqual(TOL);
          expect(run.backtracks, `the ${name} card only moved the hand's way`).toBe(0);
          expect(run.past, `no ${name} frame went past the stop`).toBe(0);
        }
        expect(
          fast.early,
          `the fast lift's curve covers more of the travel ${EARLY_FRACTION * 100}% in than the slow one's`,
        ).toBeGreaterThan(slow.early + 0.02);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a quick swipe flicks past the next stop, one way, to where it committed",
    async () => {
      const app = await launchTugApp({
        testName: "at0685-flow-swipe-flick",
      });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(KIND_TILES)}).length > 0`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);
        expect(await flowOffset(app), "the strip starts at rest").toBe(0);
        const restLeft = await paneLeft(app);

        // ── the same twelve deltas, sixteen milliseconds apart, lifted ───────
        await startSwipe(app, {
          deltas: repeat(DELTA_PX, DELTA_COUNT),
          gapMs: DELTA_GAP_MS,
          momentum: MOMENTUM_DELTAS,
        });
        await wait(AFTER_LAND_MS);
        const trace = await stopSwipe(app);
        const settled = await flowOffset(app);
        const landedLeft = await paneLeft(app);
        const after = trace.samples.filter((s) => s.t >= trace.tLastDelta);
        note(
          `flick: hand at ${Math.round(restLeft - trace.handLeft)}px, ` +
            `committed ${trace.storeAtTrainEnd}, settled ${settled} ` +
            `(${(settled / SLOT_PITCH_PX).toFixed(2)} slots)`,
        );

        expect(
          trace.storeAtTrainEnd,
          "the flick's stop was committed at the lift",
        ).toBe(settled);
        expect(
          settled,
          "the flick travelled past the next stop",
        ).toBeGreaterThan(SLOT_PITCH_PX + TOL);
        expect(
          Math.abs(restLeft - landedLeft - settled),
          "the card ends where the store settled",
        ).toBeLessThanOrEqual(TOL);
        expect(trace.momentumUntaken, "every momentum event was taken").toBe(0);
        let backtracks = 0;
        for (let i = 1; i < trace.samples.length; i += 1) {
          if (trace.samples[i].left - trace.samples[i - 1].left > TOL) backtracks += 1;
        }
        expect(backtracks, "the card only ever moved the hand's way").toBe(0);
        expect(
          after.filter((s) => s.left < landedLeft - TOL).length,
          "no frame went past where the flick landed",
        ).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a touch mid-slide catches the strip where it stands and tracks from there",
    async () => {
      const app = await launchTugApp({
        testName: "at0685-flow-swipe-catch",
      });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(KIND_TILES)}).length > 0`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);
        expect(await flowOffset(app), "the strip starts at rest").toBe(0);
        const restLeft = await paneLeft(app);

        // ── touched, the fingers, lifted; then touched again mid-slide ───────
        await app.evalJS<null>(
          `(function () {
            var trace = {
              samples: [], tLift: null, tCatch: null, catchLeft: null,
              firstLeft: null, handLeft: null, tHand: null, done: false,
              timer: null,
            };
            window.__catch = trace;
            var left = function () { return ${paneLeftJS}; };
            trace.timer = setInterval(function () {
              trace.samples.push({ t: performance.now(), left: left() });
            }, 4);
            var el = document.querySelector("[data-deck-canvas-background]");
            var phase = function (edge) { window.__tugBridge.onScrollPhase(edge); };
            var wheel = function (dx) {
              el.dispatchEvent(new WheelEvent("wheel", {
                deltaX: dx, deltaY: 0, bubbles: true, cancelable: true,
              }));
            };
            var train = function (count, then) {
              var sent = 0;
              var tick = function () {
                wheel(${DELTA_PX});
                sent += 1;
                if (trace.tCatch !== null && trace.firstLeft === null) trace.firstLeft = left();
                if (sent < count) { setTimeout(tick, ${BRISK_GAP_MS}); return; }
                then();
              };
              tick();
            };
            setTimeout(function () {
              phase("touched");
              train(${DELTA_COUNT}, function () {
                phase("lifted");
                trace.tLift = performance.now();
                setTimeout(function () {
                  phase("touched");
                  trace.tCatch = performance.now();
                  trace.catchLeft = left();
                  setTimeout(function () {
                    train(${CATCH_DELTAS}, function () {
                      trace.handLeft = left();
                      trace.tHand = performance.now();
                      phase("lifted");
                      trace.done = true;
                    });
                  }, ${BRISK_GAP_MS});
                }, ${CATCH_AFTER_MS});
              });
            }, 40);
            return null;
          })()`,
        );
        await app.waitForCondition<boolean>(`window.__catch.done === true`, {
          timeoutMs: 5_000,
        });
        await wait(AFTER_LAND_MS);
        const trace = await app.evalJS<{
          samples: Sample[];
          tLift: number;
          tCatch: number;
          catchLeft: number;
          firstLeft: number;
          handLeft: number;
          tHand: number;
        }>(
          `(function () {
            clearInterval(window.__catch.timer);
            return window.__catch;
          })()`,
        );
        const before = trace.samples.filter((s) => s.t < trace.tCatch);
        const lastBefore = before[before.length - 1];
        const slideStop = restLeft - SLOT_PITCH_PX;
        note(
          `catch: slide at ${Math.round(lastBefore.left - slideStop)}px short of its stop, ` +
            `caught at ${Math.round(trace.catchLeft - slideStop)}px, ` +
            `first delta drawn at ${Math.round(trace.firstLeft - trace.catchLeft)}px from the catch`,
        );

        // The catch was mid-slide: the strip had left the hand and not landed.
        expect(
          lastBefore.left - slideStop,
          "the slide was still short of its stop when the hand touched",
        ).toBeGreaterThan(TOL);
        const atLift = trace.samples.filter((s) => s.t <= trace.tLift).pop()!;
        expect(
          atLift.left - lastBefore.left,
          "the slide had carried the strip on from the hand before the catch",
        ).toBeGreaterThan(TOL);

        // No jump at the catch: the strip stood where the slide had it, to
        // within one frame of the slide's travel, and did not leap to the stop.
        expect(
          Math.abs(trace.catchLeft - lastBefore.left),
          "the strip was caught where the slide had it",
        ).toBeLessThanOrEqual(MAX_CATCH_STEP_PX);
        // And the hand moved it 1:1 from there, with no hump re-armed.
        expect(
          trace.catchLeft - trace.firstLeft,
          "the first delta after the catch drew 1:1 from the caught place",
        ).toBeCloseTo(DELTA_PX, 0);
        expect(
          trace.catchLeft - trace.handLeft,
          "every delta after the catch drew 1:1",
        ).toBeCloseTo(DELTA_PX * CATCH_DELTAS, 0);
        // And nothing between the catch and the hand's last delta leapt: each
        // step is a delta or a frame of the slide, never the rest of the way.
        const held = trace.samples.filter(
          (s) => s.t >= trace.tCatch && s.t <= trace.tHand,
        );
        let leap = 0;
        for (let i = 1; i < held.length; i += 1) {
          leap = Math.max(leap, Math.abs(held[i].left - held[i - 1].left));
        }
        note(`largest step while the hand held the strip: ${Math.round(leap)}px`);
        expect(leap, "no step leapt while the hand held the strip").toBeLessThanOrEqual(
          MAX_CATCH_STEP_PX,
        );

        // One way throughout, and on to the next stop the hand was moving to.
        const backs: string[] = [];
        for (let i = 1; i < trace.samples.length; i += 1) {
          const step = trace.samples[i].left - trace.samples[i - 1].left;
          if (step > TOL) {
            backs.push(
              `${Math.round(step)}px at ${Math.round(trace.samples[i].t - trace.tCatch)}ms from the catch`,
            );
          }
        }
        if (backs.length > 0) note(`backtracks: ${backs.join(", ")}`);
        expect(backs.length, "the card only ever moved the hand's way").toBe(0);
        const settled = await flowOffset(app);
        note(`settled offset ${settled}`);
        expect(
          settled % SLOT_PITCH_PX,
          "the second lift settled on a slot's stop",
        ).toBeCloseTo(0, 0);
        expect(
          settled,
          "the second lift carried on past the caught place",
        ).toBeGreaterThanOrEqual(restLeft - trace.firstLeft);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
