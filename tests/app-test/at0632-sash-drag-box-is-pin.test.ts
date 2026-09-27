/**
 * at0632-sash-drag-box-is-pin.test.ts — a member of a sash drag is laid out
 * at its pin on every tick of the gesture.
 *
 * ## What this is for
 *
 * A seam drag writes each member's `height` in px, inline, on every pointer
 * move (`PlaceSeam` in `deck-canvas.tsx`). The write is provably on time from
 * the DOM alone; what the eye sees is the laid-out box, and anything that
 * animates `height` outranks an inline value in the cascade for as long as
 * it runs. `chrome.css` puts a 100ms `transition: height` on every
 * `.tug-pane` for the window-shade collapse ([D07]) and stands it down only
 * for the pane's own drag, an imposer settle and a workspace switch — none of
 * which a seam drag is. So every pin started a 100ms ease from wherever the
 * box was: the seam and every `top` snapped, the heights chased them, and the
 * hand saw a gap open under the sash and close a beat after it stopped. The
 * loaded-deck instrument (`at0626`) was green over it — its bars are frame
 * cost and overrun, and the ease is cheap.
 *
 * ## What it asserts
 *
 * On every tick the seam is under the hand, each member's laid-out height is
 * within a pixel of the inline px height the drag pinned on it. A sidebar
 * rail rather than a session column, because the invariant is the same on
 * any member and a rail of 240px-floor cards fits every screen the harness
 * opens on. The ticks are a `setTimeout` heartbeat, not `requestAnimationFrame`,
 * because a covered harness window suspends the latter.
 *
 * @covers tugdeck/styles/chrome.css
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** Room past the settle attribute clearing for the tween's own tail. */
const SETTLE_TAIL_MS = 900;

const RAIL_WIDTH = 420;
const MEMBERS = ["cards", "jots", "layout"] as const;
const SEAM = `.tug-place-seam[data-rail-seam="right:0"]`;
const PANES = `.tug-pane[data-rail-side="right"]`;

/** How far the sash travels, px — inside the floors either side of it. */
const DRAG_PX = 90;
/** Trail steps and their gap: a hand's rate, one move per 60Hz frame. */
const DRAG_STEPS = 48;
const DRAG_STEP_MS = 17;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Three sidebar cards on the right rail, divided at equal shares. */
function deckShape() {
  const pane = (id: string, cardId: string, title: string) => ({
    id,
    position: { x: 0, y: 0 },
    size: { width: RAIL_WIDTH, height: 900 },
    cardIds: [cardId],
    activeCardId: cardId,
    title,
    acceptsFamilies: [],
  });
  return {
    cards: [
      { id: "C", componentId: "cards", title: "Cards", closable: true },
      { id: "J", componentId: "jots", title: "Jots", closable: true },
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      pane("pCards", "C", "Cards"),
      pane("pJots", "J", "Jots"),
      pane("pLayout", "L", "Layout"),
    ],
    activePaneId: "pCards",
    imposition: {
      kind: "three-up",
      sidebars: {
        cards: { side: "right" },
        jots: { side: "right" },
        layout: { side: "right" },
      },
      rails: { right: { order: [...MEMBERS] } },
    },
    hasFocus: true,
  };
}

/** One heartbeat tick, as the timer saw the page. */
interface Tick {
  t: number;
  /** Whether the seam carried `data-gesture="seam"` on this tick. */
  gesture: boolean;
  /** How many rail members carried `data-still-crossing`. */
  marked: number;
  /**
   * The largest distance, over the rail members, between a member's
   * laid-out height and the inline px height pinned on it — zero on a tick
   * where no member carries a px height.
   */
  lag: number;
}

async function settled(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector("[data-imposer-settling]") === null`,
    { timeoutMs: 8_000 },
  );
  await wait(SETTLE_TAIL_MS);
}

const seamCentre = (app: App): Promise<number> =>
  app.evalJS<number>(
    `(function () {
      var r = document.querySelector(${JSON.stringify(SEAM)}).getBoundingClientRect();
      return r.top + r.height / 2;
    })()`,
  );

/** Start the heartbeat. Every tick reads the seam's mark, the members' marks
 *  and each member's box against its pin, and nothing else. */
async function arm(app: App): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var prior = window.__at0632;
      if (prior !== undefined) prior.armed = false;
      var state = { armed: true, ticks: [] };
      window.__at0632 = state;
      var beat = function () {
        if (!state.armed) return;
        var seam = document.querySelector(${JSON.stringify(SEAM)});
        var marked = 0;
        var lag = 0;
        document.querySelectorAll(${JSON.stringify(PANES)}).forEach(function (el) {
          if (el.hasAttribute("data-still-crossing")) marked += 1;
          if (/px$/.test(el.style.height)) {
            var box = el.getBoundingClientRect().height;
            lag = Math.max(lag, Math.abs(box - parseFloat(el.style.height)));
          }
        });
        state.ticks.push({
          t: performance.now(),
          gesture: seam !== null && seam.getAttribute("data-gesture") === "seam",
          marked: marked,
          lag: lag,
        });
        setTimeout(beat, 0);
      };
      setTimeout(beat, 0);
      return null;
    })()`,
  );
}

async function harvest(app: App): Promise<Tick[]> {
  return app.evalJS<Tick[]>(
    `(function () {
      var state = window.__at0632;
      state.armed = false;
      return state.ticks;
    })()`,
  );
}

const fmt = (x: number): string => x.toFixed(1);

const percentile = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
};

describe.skipIf(!SHOULD_RUN)(
  "at0632 — a member of a sash drag is laid out at its pin on every tick",
  () => {
    test(
      "no member's box lags the height the drag pinned on it",
      async () => {
        const app = await launchTugApp({
          testName: "at0632-sash-drag-box-is-pin",
        });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "C" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(PANES)}).length === 3 && ` +
              `document.querySelectorAll(${JSON.stringify(SEAM)}).length === 1`,
            { timeoutMs: 15_000 },
          );
          await settled(app);

          const box = await app.getElementBounds(SEAM);
          const from = {
            x: Math.round(box.x + box.width / 2),
            y: Math.round(box.y + box.height / 2),
          };
          const to = { x: from.x, y: from.y + DRAG_PX };
          const startCentre = await seamCentre(app);

          await arm(app);
          await app.nativeDragElementWithoutRelease(SEAM, to, {
            interpolationSteps: DRAG_STEPS,
            interpolationDelayMs: DRAG_STEP_MS,
          });
          await app.nativeMouseUp(to);
          await wait(600);
          const ticks = await harvest(app);
          const endCentre = await seamCentre(app);
          await settled(app);

          const held = ticks.filter((t) => t.gesture);
          expect(
            held.length,
            "the heartbeat recorded ticks while the seam was held",
          ).toBeGreaterThan(20);
          const travel = endCentre - startCentre;
          expect(
            travel,
            "the sash really travelled under the pointer",
          ).toBeGreaterThan(DRAG_PX / 2);

          const lags = held.map((t) => t.lag);
          const pinned = held.filter((t) => t.marked > 0).length;
          note(
            "at0632 box against pin",
            `${held.length} held ticks, ${pinned} with members marked; ` +
              `seam travelled ${fmt(travel)}px of ${DRAG_PX}; ` +
              `lag max ${fmt(Math.max(0, ...lags))}px, ` +
              `p95 ${fmt(percentile(lags, 0.95))}px`,
          );
          expect(
            pinned,
            "the members were held and pinned for the length of the gesture",
          ).toBeGreaterThan(20);
          expect(
            Math.max(0, ...lags),
            "each member's laid-out height is its pinned height on every held tick",
          ).toBeLessThan(1);

          const after = ticks.filter((t) => !t.gesture && t.t > held[held.length - 1].t);
          expect(
            after.length === 0 ? 0 : Math.max(...after.map((t) => t.marked)),
            "no member is left marked after the pointer is released",
          ).toBe(0);
        } finally {
          await app.close().catch(() => undefined);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
