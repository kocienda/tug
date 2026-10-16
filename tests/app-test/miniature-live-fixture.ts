/**
 * miniature-live-fixture.ts — the deck and the gauge readers the at0463 live
 * miniature files share: five tall-floor cards in a six-up beside the Layout
 * card, the open-and-land the cases start from, and the readers for the
 * gauge properties the channel publishes onto the committed drawing.
 *
 * Split out of `at0463-miniature-live.test.ts` when that file was cut into
 * `at0463-miniature-live-strip`, `-drag` and `-flow` to keep each under the
 * 20 s budget.
 */

import { type App } from "./_harness";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 180_000;

export const RAIL_WIDTH = 420;
/** The settle window, with room for a landing tween. */
export const AFTER_LAND_MS = 900;
/** Long enough for the autoscroll's rate integrator to travel visibly. */
export const HOLD_MS = 400;

export const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

export const COMMITTED_MINI =
  '[data-testid="layout-card-plan"] [data-plan-layer="committed"] .layout-mini';

/**
 * Five content cards and the Layout card on the right, six-up so slot 1 exists.
 *
 * `fixture-tall-floor` rather than an ordinary card because this test needs an
 * overflowing column, and a place overflows when its members' floors no longer
 * fit in the run ([P01]) rather than when it passes a member count. Five 400px
 * floors are twice the run this canvas gives a column.
 */
export function deckShape(): Record<string, unknown> {
  const ids = ["A", "B", "C", "D", "E"];
  return {
    cards: [
      ...ids.map((id) => ({
        id,
        componentId: "fixture-tall-floor",
        title: `Card ${id}`,
        closable: true,
      })),
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      ...ids.map((id, index) => ({
        id: `p${index + 1}`,
        position: { x: 40, y: 40 },
        size: { width: 600, height: 400 },
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
    },
    hasFocus: true,
  };
}

/** Open the deck with the Layouts plan on screen. */
export async function openDeck(app: App, layout?: "flow"): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
  );
  const state = deckShape();
  if (layout === "flow") {
    (state.imposition as Record<string, unknown>).layout = "flow";
  }
  await app.seedDeckState({ state, focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `document.querySelector('[data-testid="layout-card-plan"]') !== null`,
    { timeoutMs: 8_000 },
  );
  await app.evalJS(
    `document.querySelector('[data-testid="layout-card-section"]')
       .scrollIntoView({ block: "center" })`,
  );
  await wait(AFTER_LAND_MS);
}

/** One gauge property as it stands on the committed drawing, or null when the
 *  channel has published nothing onto it. */
export async function gauge(app: App, property: string): Promise<number | null> {
  return app.evalJS<number | null>(
    `(function () {
      var mini = document.querySelector(${JSON.stringify(COMMITTED_MINI)});
      if (mini === null) return null;
      var raw = mini.style.getPropertyValue(${JSON.stringify(property)});
      return raw === "" ? null : parseFloat(raw);
    })()`,
  );
}

/** The vertical translation the first overflowing column member is drawing
 *  with, in pixels — the live half of its position. */
export async function memberSlidePx(app: App): Promise<number> {
  return app.evalJS<number>(
    `(function () {
      var block = document.querySelector(
        ${JSON.stringify(COMMITTED_MINI)} + " .layout-mini-block[data-column-overflow]"
      );
      if (block === null) return NaN;
      var transform = getComputedStyle(block).transform;
      if (transform === "none") return 0;
      var parts = transform.replace(/^matrix\\(/, "").replace(/\\)$/, "").split(",");
      return parseFloat(parts[5]);
    })()`,
  );
}

/** A rect as both the deck and the drawing report one. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One box as a diagnostic line. */
export const describe_ = (box: Box | null): string =>
  box === null
    ? "none"
    : `${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}×${Math.round(box.height)}`;

export const titleBar = (paneId: string): string =>
  `.tug-pane[data-pane-id="${paneId}"] .tug-pane-title-bar`;
