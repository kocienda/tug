/**
 * at0661-miniature-window-drag.test.ts — the flow window slides by its frame.
 *
 * When the flow strip is longer than its band, the Layout miniature draws the
 * band as a bracket over the whole strip, and the places overlay stands a grip
 * on that bracket's frame. A drag from the frame slides the deck's band
 * continuously. What this file pins:
 *
 *   (a) the grip is there exactly when there is a window: under an
 *       overflowing flow strip, and not under fit;
 *   (b) while the hand holds the drag, the deck PREVIEWS — the committed
 *       drawing's `--gauge-flow-offset` grows — and commits nothing;
 *   (c) the release commits once, at the offset the preview drew, as a `cut`,
 *       and the bracket does not move again after the hand lets go (its
 *       re-pin at the commit must not tween against its slide);
 *   (d) the window's interior is not a target: a press in the middle of a
 *       block under it still goes to that block.
 *
 * @covers tugdeck/src/components/layout/use-miniature-window-drag.ts
 * @covers tugdeck/src/components/layout/layout-places.tsx
 * @covers tugdeck/src/components/layout/layout-places.css
 * @covers tugdeck/src/components/layout/layout-card.css
 */

import { describe, expect, test } from "bun:test";

import { flowBandEdges } from "../../tugdeck/src/lib/layout-imposer";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const RAIL_WIDTH = 420;
const SLIM_PX = 675;
const AFTER_LAND_MS = 900;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

const GRIP = '[data-testid="layout-card-window-grip"]';
const COMMITTED_MINI =
  '.layouts-plan-layer[data-plan-layer="committed"] .layout-mini';
const BRACKET = `${COMMITTED_MINI} .layout-mini-window`;

/** Six slim cards, one per slot, the Layout card on the right. */
function deckShape(layout: "fit" | "flow") {
  const ids = ["A", "B", "C", "D", "E", "F"];
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
      ...ids.map((id, index) => ({
        id: `p${index + 1}`,
        position: { x: 40, y: 40 },
        size: { width: SLIM_PX, height: 400 },
        cardIds: [id],
        activeCardId: id,
        title: "",
        acceptsFamilies: ["maker"],
        slot: index,
      })),
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
      sidebars: { layout: { side: "right" } },
      layout,
    },
    hasFocus: true,
  };
}

async function openDeck(app: App, layout: "fit" | "flow"): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
  );
  await app.seedDeckState({ state: deckShape(layout), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `document.querySelector('[data-testid="layout-card-places"] .layout-places-target') !== null`,
    { timeoutMs: 8_000 },
  );
  await wait(AFTER_LAND_MS);
}

function committedOffset(app: App): Promise<number> {
  return app.evalJS<number>(
    `(window.tugdeck.diag.getDeckState().flowOffset || 0)`,
  );
}

/** The flow-offset gauge the committed drawing carries, as a fraction. */
function gauge(app: App): Promise<number | null> {
  return app.evalJS<number | null>(
    `(function () {
      var mini = document.querySelector(${JSON.stringify(COMMITTED_MINI)});
      if (mini === null) return null;
      var raw = mini.style.getPropertyValue("--gauge-flow-offset");
      return raw === "" ? null : parseFloat(raw);
    })()`,
  );
}

/** The deck's band, through the deck's own function. */
async function bandWidth(app: App): Promise<number> {
  const canvasWidth = await app.evalJS<number>(
    `document.querySelector("[data-deck-canvas-background]").getBoundingClientRect().width`,
  );
  const railWidth = await app.evalJS<number>(
    `document.querySelector('.tug-pane[data-pane-id="pRail"]').getBoundingClientRect().width`,
  );
  const edges = flowBandEdges(canvasWidth, { right: railWidth });
  return edges.end - edges.start;
}

/**
 * How many pointerups the window has heard. A native gesture arrives through
 * CGEvents and a read through the RPC, and the two are not ordered — under a
 * parallel batch a read can run before the event it follows. A bubble-phase
 * window listener runs after the target's own handlers, so once this has
 * moved, the release has done everything it does synchronously.
 */
function pointerUps(app: App): Promise<number> {
  return app.evalJS<number>(
    `(function () {
      if (window.__at0661Ups === undefined) {
        window.__at0661Ups = 0;
        window.addEventListener("pointerup", function () { window.__at0661Ups += 1; });
      }
      return window.__at0661Ups;
    })()`,
  );
}

async function afterPointerUp(app: App, before: number): Promise<void> {
  await app.waitForCondition<boolean>(`window.__at0661Ups > ${before}`, {
    timeoutMs: 8_000,
  });
}

function bracketLeft(app: App): Promise<number> {
  return app.evalJS<number>(
    `document.querySelector(${JSON.stringify(BRACKET)}).getBoundingClientRect().left`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0661 — the window slides by its frame", () => {
  test(
    "a drag from the frame previews, commits once as a cut, and stays put",
    async () => {
      const app = await launchTugApp({
        testName: "at0661-miniature-window-drag",
      });
      try {
        // (a) Under fit there is no window, so no grip.
        await openDeck(app, "fit");
        expect(
          await app.evalJS<boolean>(`document.querySelector('${GRIP}') !== null`),
          "fit has no window to grip",
        ).toBe(false);

        await openDeck(app, "flow");
        const grip = await app.evalJS<{
          left: number;
          right: number;
          top: number;
          bottom: number;
        } | null>(
          `(function () {
            var el = document.querySelector('${GRIP}');
            if (el === null) return null;
            var r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
          })()`,
        );
        expect(grip, "an overflowing flow strip has a grip").not.toBeNull();
        if (grip === null) throw new Error("no grip");
        const band = await bandWidth(app);
        const startOffset = await committedOffset(app);

        // (b) Hold a drag from the right edge, 40px rightward.
        const from = { x: grip.right - 1, y: (grip.top + grip.bottom) / 2 };
        const to = { x: from.x + 40, y: from.y };
        const mark = await app.evalJS<number>(
          `(function () {
            window.__deckTrace.enable(true);
            return window.__deckTrace.mark();
          })()`,
        );
        await app.nativeDragWithoutRelease(from, to);
        // The preview has drawn once the gauge has left the start.
        await app.waitForCondition<boolean>(
          `(function () {
            var mini = document.querySelector(${JSON.stringify(COMMITTED_MINI)});
            var raw = mini === null ? "" : mini.style.getPropertyValue("--gauge-flow-offset");
            return raw !== "" && parseFloat(raw) * ${band} > ${startOffset} + 1;
          })()`,
          { timeoutMs: 8_000 },
        );        const held = (await gauge(app)) ?? 0;
        const committedDuringHold = await committedOffset(app);
        const leftAtHold = await bracketLeft(app);
        note(
          `held: gauge=${held.toFixed(4)} (${Math.round(held * band)}px), ` +
            `committed=${committedDuringHold}, start=${startOffset}`,
        );
        expect(held * band, "the preview slid the band").toBeGreaterThan(
          startOffset + 1,
        );
        expect(committedDuringHold, "and committed nothing").toBe(startOffset);

        // (c) Release: one commit, as a cut, at the previewed offset.
        const upsBeforeRelease = await pointerUps(app);
        await app.nativeMouseUp(to);
        await afterPointerUp(app, upsBeforeRelease);
        const samples: number[] = [];
        for (let i = 0; i < 12; i += 1) {
          samples.push(await bracketLeft(app));
          await wait(40);
        }
        await wait(AFTER_LAND_MS);
        const committed = await committedOffset(app);
        const notifies = await app.evalJS<{ caller: string; landing: string }[]>(
          `window.__deckTrace.since(${mark})
             .filter(function (e) { return e.kind === "store-notify" && e.caller === "setFlowOffset"; })
             .map(function (e) { return { caller: e.caller, landing: e.landing }; })`,
        );
        const drift = Math.max(...samples.map((s) => Math.abs(s - leftAtHold)));
        note(
          `committed ${committed.toFixed(1)}px vs previewed ${(held * band).toFixed(1)}px; ` +
            `setFlowOffset notifies ${JSON.stringify(notifies)}; bracket drift ${drift.toFixed(2)}px ` +
            `(at hold ${leftAtHold.toFixed(2)}, after ${samples.map((s) => s.toFixed(2)).join(" ")})`,
        );
        expect(
          Math.abs(committed - held * band),
          "the commit lands where the preview drew",
        ).toBeLessThan(1);
        expect(notifies.length, "exactly one commit").toBe(1);
        expect(notifies[0].landing, "and it lands as a cut").toBe("cut");
        expect(drift, "the bracket stays where the hand left it").toBeLessThan(1);

        // (d) The window's interior is not a target: the middle of a block
        // under it still takes the block press.
        const inside = await app.evalJS<{
          x: number;
          y: number;
          slot: number;
        } | null>(
          `(function () {
            var g = document.querySelector('${GRIP}').getBoundingClientRect();
            var blocks = document.querySelectorAll('[data-testid="layout-card-places"] .layout-places-target[data-target="block"]');
            for (var i = 0; i < blocks.length; i += 1) {
              var r = blocks[i].getBoundingClientRect();
              var x = r.left + r.width / 2;
              if (x > g.left + 8 && x < g.right - 8) {
                return { x: x, y: r.top + r.height / 2, slot: Number(blocks[i].getAttribute("data-slot")) };
              }
            }
            return null;
          })()`,
        );
        expect(inside, "a block stands inside the window").not.toBeNull();
        if (inside === null) throw new Error("no block inside the window");
        const upsBeforePress = await pointerUps(app);
        await app.nativeClick({ x: inside.x, y: inside.y });
        await afterPointerUp(app, upsBeforePress);        expect(
          await app.getActiveCardId(),
          "the press went to the block under the window",
        ).toBe(["A", "B", "C", "D", "E", "F"][inside.slot]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
