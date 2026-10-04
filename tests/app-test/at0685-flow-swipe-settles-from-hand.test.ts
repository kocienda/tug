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
}

interface SwipeTrace {
  samples: Sample[];
  /** When the last delta was dispatched. */
  tLastDelta: number;
  /** Where the card stood in the task that dispatched the last delta. */
  handLeft: number;
}

const paneLeftJS = `document
  .querySelector('.tug-pane[data-pane-id="p1"]')
  .getBoundingClientRect().left`;

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
  return app.evalJS<number>(
    `parseFloat(document.querySelector('.tug-pane[data-pane-id="p1"]').style.getPropertyValue("--tug-imposer-flow-offset")) || 0`,
  );
}

interface Train {
  /** Every event's deltaX, in order. */
  deltas: number[];
  gapMs: number;
  /** After this many events, wait `pauseMs` instead of `gapMs`. */
  pauseAfter?: number;
  pauseMs?: number;
}

/** Arm the sampler, then dispatch the train in-page; the trace fills in. */
async function startSwipe(app: App, train: Train): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var trace = { samples: [], tLastDelta: null, handLeft: null, timer: null };
      window.__swipe = trace;
      trace.timer = setInterval(function () {
        trace.samples.push({ t: performance.now(), left: ${paneLeftJS} });
      }, 4);
      var el = document.querySelector("[data-deck-canvas-background]");
      var deltas = ${JSON.stringify(train.deltas)};
      var sent = 0;
      var tick = function () {
        el.dispatchEvent(new WheelEvent("wheel", {
          deltaX: deltas[sent],
          deltaY: 0,
          bubbles: true,
          cancelable: true,
        }));
        sent += 1;
        if (sent < deltas.length) {
          setTimeout(tick, sent === ${train.pauseAfter ?? -1} ? ${train.pauseMs ?? 0} : ${train.gapMs});
          return;
        }
        trace.tLastDelta = performance.now();
        trace.handLeft = ${paneLeftJS};
      };
      setTimeout(tick, 40);
      return null;
    })()`,
  );
  await app.waitForCondition<boolean>(`window.__swipe.handLeft !== null`, {
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
});
