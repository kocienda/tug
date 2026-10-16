/**
 * multi-tab-close-confirm-fixture.ts — the deck shapes, selectors and
 * gestures the at0040-multi-tab-close-confirm-* files share: the title-bar
 * X's close confirmation, a pane-level feature applied uniformly to every
 * pane.
 *
 * @module tests/app-test/multi-tab-close-confirm-fixture
 */

import type { App } from "./_harness";
import {
  IMPOSITION_GAP_PX,
  RAIL_GUTTER_PX,
} from "../../tugdeck/src/lib/layout-imposer";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

export const TEST_TIMEOUT_MS = 60_000;

// The pane-close confirmation is the shared `TugConfirmPopover` component
// (data-slot "tug-confirm-popover"); on these close-confirm routes it is the
// only confirm popover present.
export const CONFIRM_POPOVER_SELECTOR = "[data-slot=\"tug-confirm-popover\"]";

export function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) =>
    (
      globalThis as unknown as {
        setTimeout: (fn: () => void, ms: number) => unknown;
      }
    ).setTimeout(() => resolve(), ms),
  );
}

export function paneCloseButtonSelector(paneId: string): string {
  return `.tug-pane[data-pane-id="${paneId}"] [data-testid="tug-pane-close-button"]`;
}

export function popoverButtonByText(label: string): string {
  return `(function(){
    var root = document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)});
    if (root === null) return null;
    var btns = root.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].textContent && btns[i].textContent.trim() === ${JSON.stringify(label)}) {
        return btns[i];
      }
    }
    return null;
  })()`;
}

/**
 * Option(alt)-click an element. `holdModifier` buffers native verbs
 * into one atomic RPC with the modifier held; `evalJS` is not allowed
 * inside that scope, so the element's viewport-center point is
 * resolved beforehand.
 */
export async function optionClickElement(app: App, selector: string): Promise<void> {
  const point = await app.evalJS<{ x: number; y: number }>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) throw new Error("[at0040] option-click target missing: " + ${JSON.stringify(selector)});
      var r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
  );
  await app.holdModifier(["alt"], async (inner) => {
    await inner.rpcCall<void>("nativeClick", { viewportPoint: point });
  });
}

/** Two cards in a single pane → multi-tab pane. */
export function multiTabActiveDeckShape() {
  return {
    cards: [
      { id: "A", componentId: "gallery-input" as const, title: "TugInput", closable: true },
      { id: "B", componentId: "gallery-textarea" as const, title: "TugTextarea", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 600, height: 540 },
        cardIds: ["A", "B"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"] as const,
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/**
 * Two panes: p1 (multi-tab, contains M+N cards) and p2 (active,
 * single card). p2 is active so p1 starts inactive — this is the
 * setup case 4 needs.
 */
export function inactiveMultiTabDeckShape() {
  return {
    cards: [
      { id: "A", componentId: "gallery-input" as const, title: "TugInput", closable: true },
      { id: "B", componentId: "gallery-textarea" as const, title: "TugTextarea", closable: true },
      { id: "C", componentId: "gallery-input" as const, title: "Other", closable: true },
    ],
    panes: [
      {
        id: "p1",
        // Background pane (inactive) with two tabs.
        position: { x: 40, y: 40 },
        size: { width: 600, height: 540 },
        cardIds: ["A", "B"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"] as const,
      },
      {
        id: "p2",
        // Foreground pane (active) with one tab. Its existence
        // makes p1 the inactive pane.
        position: { x: 700, y: 40 },
        size: { width: 460, height: 540 },
        cardIds: ["C"],
        activeCardId: "C",
        title: "",
        acceptsFamilies: ["maker"] as const,
      },
    ],
    activePaneId: "p2",
    hasFocus: true,
  };
}

/** Inactive single-tab variant — case 4, single-tab cell. */
export function inactiveSingleTabDeckShape() {
  return {
    cards: [
      { id: "A", componentId: "gallery-input" as const, title: "TugInput", closable: true },
      { id: "C", componentId: "gallery-input" as const, title: "Other", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 460, height: 540 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"] as const,
      },
      {
        id: "p2",
        position: { x: 540, y: 40 },
        size: { width: 460, height: 540 },
        cardIds: ["C"],
        activeCardId: "C",
        title: "",
        acceptsFamilies: ["maker"] as const,
      },
    ],
    activePaneId: "p2",
    hasFocus: true,
  };
}

/** The width the Layout rail is seeded at, and what `band()` subtracts. */
export const RAIL_WIDTH = 420;
/** Wide enough that five of them overrun any band this harness opens. */
export const FLOW_PANE_WIDTH = 700;
/** How far the strip stands slid under the band — half a pane, so the target
 *  straddles the band's near edge with its title bar's trailing end still in
 *  the clear. Seeded as the deck's `flowOffset`, not panned: a wheel pan now
 *  jumps a whole slot, so no wheel delta can stop the strip half a pane in. */
export const HALF_PANE_OFFSET_PX = 350;
/** A seed's settle, and the reveal's, cleared with room. */
export const AFTER_SETTLE_MS = 900;
// Its own number, not `PIXEL_TOL` (1.5) from `_harness/tolerances.ts`: a different
// tolerance is this file's decision, so the table does not flatten it.
/** Frames are measured in device pixels; a rounded pin is within a pixel. */
export const TOL = 2;

/** Active single-tab variant — case 1. */
export function activeSingleTabDeckShape() {
  return {
    cards: [
      { id: "A", componentId: "gallery-input" as const, title: "TugInput", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 460, height: 540 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"] as const,
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/**
 * Case 5's deck: five imposed panes in a flow strip, plus the Layout card
 * pinned right.
 *
 * `p1` holds two cards, so it confirms on close unconditionally, and it is the
 * ACTIVE pane — the reveal under test has to be the close's own rather than an
 * activation's (see case 4).
 */
export function flowDeckShape() {
  const pane = (id: string, slot: number, cardIds: string[]) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: FLOW_PANE_WIDTH, height: 400 },
    cardIds,
    activeCardId: cardIds[0],
    title: "",
    acceptsFamilies: ["maker"] as const,
    slot,
  });
  return {
    cards: [
      { id: "A", componentId: "gallery-input" as const, title: "TugInput", closable: true },
      { id: "B", componentId: "gallery-textarea" as const, title: "TugTextarea", closable: true },
      { id: "C", componentId: "hello" as const, title: "Card C", closable: true },
      { id: "D", componentId: "hello" as const, title: "Card D", closable: true },
      { id: "E", componentId: "hello" as const, title: "Card E", closable: true },
      { id: "F", componentId: "hello" as const, title: "Card F", closable: true },
      { id: "L", componentId: "layout" as const, title: "Layout", closable: true },
    ],
    panes: [
      pane("p1", 0, ["A", "B"]),
      pane("p2", 1, ["C"]),
      pane("p3", 2, ["D"]),
      pane("p4", 3, ["E"]),
      pane("p5", 4, ["F"]),
      railPane(),
    ],
    activePaneId: "p1",
    imposition: FLOW_SIX_UP,
    hasFocus: true,
  };
}

/** Case 6's deck: one content pane, and the Layout card in its rail. */
export function railDeckShape() {
  return {
    cards: [
      { id: "A", componentId: "gallery-input" as const, title: "TugInput", closable: true },
      { id: "L", componentId: "layout" as const, title: "Layout", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 460, height: 540 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"] as const,
        slot: 0,
      },
      railPane(),
    ],
    activePaneId: "p1",
    imposition: FLOW_SIX_UP,
    hasFocus: true,
  };
}

export const FLOW_SIX_UP = {
  kind: "six-up",
  layout: "flow",
  sidebars: { layout: { side: "right" } },
} as const;

export function railPane() {
  return {
    id: "pRail",
    position: { x: 0, y: 0 },
    size: { width: RAIL_WIDTH, height: 900 },
    cardIds: ["L"],
    activeCardId: "L",
    title: "Layout",
    acceptsFamilies: [] as const,
  };
}

/**
 * The band's edges in viewport coordinates — the arithmetic `resolveSpan`
 * does, read from the pixels the deck actually drew: one card gap in from the
 * canvas edge, and one rail gutter short of the rail's near edge.
 *
 * Measured off the rail's painted frame rather than off the
 * `--tug-imposer-inset-*` properties, which resolve to a `calc()` that
 * `parseFloat` answers NaN for. at0454's helper, for at0454's reason.
 */
export function band(app: App): Promise<{ left: number; right: number }> {
  return app.evalJS<{ left: number; right: number }>(
    `(function () {
      var box = document
        .querySelector("[data-deck-canvas-background]")
        .getBoundingClientRect();
      var rail = document
        .querySelector('.tug-pane[data-pane-id="pRail"]')
        .getBoundingClientRect();
      return {
        left: box.left + ${IMPOSITION_GAP_PX},
        right: rail.left - ${RAIL_GUTTER_PX},
      };
    })()`,
  );
}

export function paneRect(
  app: App,
  paneId: string,
): Promise<{ left: number; right: number }> {
  return app.evalJS<{ left: number; right: number }>(
    `(function () {
      var box = document
        .querySelector('.tug-pane[data-pane-id="${paneId}"]')
        .getBoundingClientRect();
      return { left: box.left, right: box.right };
    })()`,
  );
}
