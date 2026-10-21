/**
 * at0750-gap-preset-moves-frames.test.ts — the Layout card's Gap row moves
 * every card distance on the deck at once.
 *
 * The card gap is one live number (`impositionGapPx()` in
 * `lib/layout-imposer.ts`), and the Gap row is its door: choosing a preset
 * writes the `gap` axis on the deck's imposition, the deck manager projects
 * it onto the imposer and stamps `--tug-imposer-gap` and the two lengths
 * derived from it, and every imposed frame re-pins in the same commit. The
 * claim is about distances, not about the record: after the press, the
 * frame's top sits one new gap under the canvas, the slot 0 frame one new gap
 * in from the band's near edge, the two members of a split column one new
 * gap apart, the run one new gap short of the canvas's foot, and the rail
 * stands its gutter — the gap plus its fixed extra — from the last slot.
 *
 * Read on the live rects rather than the imposer's own numbers, because the
 * failure this guards is the one a unit test cannot see: a preset that lands
 * in the record and moves nothing on screen, or moves the frames and not the
 * seam, or the frames and not the rail. The harness reports maker mode OFF,
 * so the bottom gap under test is the release one — the gap itself.
 *
 * Scenario:
 *   1. Seed a three-up in fit: two cards sharing slot 0, one in slot 2, the
 *      Layout card pinned as a rail on the right. Split slot 0 so it carries a
 *      seam. Fit rather than flow, because fit pins the last slot's far edge
 *      to the band's end, which is what makes the rail's gutter readable as a
 *      rect; a flow strip wider than the band runs on under the rail by design.
 *   2. At rest the frames stand on the default gap (`IMPOSITION_GAP_PX`).
 *   3. Press Airy on the Gap row — a non-default, so the move shows.
 *   4. Every pin is now the preset's pixels: top, side, seam, bottom, gutter.
 *
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/components/layout/layout-card.tsx
 * @covers tugdeck/src/deck-manager.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { waitForBodyPainted } from "./_harness/card-reach";
import {
  GAP_PX,
  IMPOSITION_GAP_PX,
  RAIL_GUTTER_EXTRA_PX,
} from "../../tugdeck/src/lib/layout-imposer";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

/** The preset pressed, and the pixels it carries. A non-default so the move shows. */
const PRESET = "airy";
const AIRY = GAP_PX[PRESET];
const DEFAULT = IMPOSITION_GAP_PX;

const RAIL_WIDTH = 420;
const PANE_WIDTH = 420;
/** The settle window, with room for the tween to land. */
const AFTER_LAND_MS = 900;
/** Frame rects land on half-pixels on a retina deck; a pin is right within one. */
const PIXEL_TOL = 1;

const GAP_TILE = (preset: string): string =>
  `[data-testid="layout-card-gap"] [data-choice-value="${preset}"]`;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

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
  return {
    cards: [
      { id: "A", componentId: "hello", title: "Card A", closable: true },
      { id: "B", componentId: "hello", title: "Card B", closable: true },
      { id: "C", componentId: "hello", title: "Card C", closable: true },
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      pane("p1", 0, "A"),
      pane("p2", 0, "B"),
      pane("p3", 2, "C"),
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
    imposition: { kind: "three-up", layout: "fit", sidebars: { layout: { side: "right" } } },
    hasFocus: true,
  };
}

interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Every named pane's live frame, plus the canvas it stands in, in viewport coordinates. */
async function rects(app: App): Promise<Record<string, Rect>> {
  return app.evalJS<Record<string, Rect>>(
    `(function () {
      var out = {};
      function box(key, el) {
        var r = el.getBoundingClientRect();
        out[key] = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      }
      ["p1", "p2", "p3", "pRail"].forEach(function (id) {
        var el = document.querySelector('.tug-pane[data-pane-id="' + id + '"]');
        if (el !== null) box(id, el);
      });
      box("canvas", document.querySelector("[data-deck-canvas-background]"));
      return out;
    })()`,
  );
}

/** The canvas's live gap, inset and flow properties, for the diagnostics line. */
async function canvasProperties(app: App): Promise<string> {
  return app.evalJS<string>(
    `(function () {
      var el = document.querySelector("[data-deck-canvas-background]");
      var cs = getComputedStyle(el);
      var r = el.getBoundingClientRect();
      var names = ["--tug-imposer-gap", "--tug-rail-gutter", "--tug-imposer-gap-bottom",
        "--tug-imposer-inset-left", "--tug-imposer-inset-right",
        "--tug-imposer-flow-strip", "--tug-imposer-flow-offset"];
      var s = "canvas " + r.width + "x" + r.height;
      names.forEach(function (n) { s += " " + n.replace("--tug-imposer-", "") + "=" + cs.getPropertyValue(n).trim(); });
      var st = window.tugdeck.diag.getDeckState();
      s += " flowOffset=" + st.flowOffset + " layout=" + st.imposition.layout;
      ["p1", "p2", "p3", "pRail"].forEach(function (id) {
        var b = document.querySelector('.tug-pane[data-pane-id="' + id + '"]').getBoundingClientRect();
        s += " " + id + "=[" + b.left + "," + b.top + "," + b.width + "x" + b.height + "]";
      });
      return s;
    })()`,
  );
}

/** The gap every frame stands on, read as the slot 0 top member's distance from the canvas top. */
const TOP_GAP_JS = `(function () {
  var c = document.querySelector("[data-deck-canvas-background]").getBoundingClientRect();
  var tops = ["p1", "p2"].map(function (id) {
    return document.querySelector('.tug-pane[data-pane-id="' + id + '"]').getBoundingClientRect().top;
  });
  return Math.min.apply(null, tops) - c.top;
})()`;

/**
 * Wait until the Layout card's body is painted and standing still: the state
 * a native click on it lands in. The imposition pins the rail right, so it
 * arrives across the deck; a press read while the host is still carrying it
 * lands outside the body, on the shell, and the tile never hears it.
 */
async function awaitLayoutBodyAtRest(app: App): Promise<void> {
  await waitForBodyPainted(app, "layout");
  const deadline = Date.now() + 8_000;
  let last = "";
  let still = 0;
  while (still < 3) {
    const frame = (await app.bodies()).find((b) => b.cardId === "L")?.frame;
    const now = frame === undefined ? "none" : [frame.x, frame.y, frame.width, frame.height].join(",");
    still = now === last ? still + 1 : 0;
    last = now;
    if (Date.now() > deadline) throw new Error(`the Layout body did not stand still within 8000 ms (last frame ${now})`);
    await Bun.sleep(100);
  }
}

/** Every distance the gap governs, at one setting. */
function expectPins(r: Record<string, Rect>, gap: number, label: string): void {
  const [top, bottom] = [r.p1, r.p2].sort((a, b) => a.top - b.top);
  note(
    `at0750 ${label}`,
    `top ${top.top - r.canvas.top}, side ${top.left - r.canvas.left}, seam ${bottom.top - top.bottom}, ` +
      `bottom ${r.canvas.bottom - bottom.bottom}, gutter ${r.pRail.left - r.p3.right} against gap ${gap}`,
  );
  expect(Math.abs(top.top - r.canvas.top - gap), `${label}: top edge one gap under the canvas`).toBeLessThan(PIXEL_TOL);
  expect(Math.abs(top.left - r.canvas.left - gap), `${label}: slot 0 one gap in from the band's near edge`).toBeLessThan(PIXEL_TOL);
  expect(Math.abs(bottom.top - top.bottom - gap), `${label}: one gap between the column's members`).toBeLessThan(PIXEL_TOL);
  expect(Math.abs(r.canvas.bottom - bottom.bottom - gap), `${label}: the run ends one gap short of the canvas foot`).toBeLessThan(PIXEL_TOL);
  expect(
    Math.abs(r.pRail.left - r.p3.right - (gap + RAIL_GUTTER_EXTRA_PX)),
    `${label}: the rail stands its gutter (gap + ${RAIL_GUTTER_EXTRA_PX}) from the last slot`,
  ).toBeLessThan(PIXEL_TOL);
}

describe.skipIf(!SHOULD_RUN)("at0750 — the Gap row moves every card distance", () => {
  test(
    "pressing Airy re-pins the top, side, seam, bottom and gutter to the preset",
    async () => {
      const app = await launchTugApp({ testName: "at0750-gap-preset-moves-frames" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('.tug-pane[data-pane-id]').length === 4`,
          { timeoutMs: 15_000 },
        );
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("set-column-mode", { slot: 0, mode: "split" }), null)`,
        );
        await wait(AFTER_LAND_MS);

        // ── At rest: the default, so nothing has moved before the press. ──
        note("at0750 default canvas", await canvasProperties(app));
        expectPins(await rects(app), DEFAULT, "default");

        // ── Airy, from the real control. ──
        await app.body("L").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(GAP_TILE(PRESET))}) !== null`,
          { timeoutMs: 8_000 },
        );
        await awaitLayoutBodyAtRest(app);
        await app.body("L").nativeClickAtElement(GAP_TILE(PRESET));
        await app.waitForCondition<boolean>(
          `Math.abs((${TOP_GAP_JS}) - ${AIRY}) < ${PIXEL_TOL}`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // The record carries the choice, so it survives the deck's persistence.
        expect(
          await app.evalJS<string | undefined>(`window.tugdeck.diag.getDeckState().imposition.gap`),
          "the imposition record holds the pressed preset",
        ).toBe(PRESET);

        // ── Every pin is the preset's, in one commit. ──
        note("at0750 airy canvas", await canvasProperties(app));
        expectPins(await rects(app), AIRY, PRESET);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
