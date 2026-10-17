/**
 * column-split-fixture.ts — the deck and the instruments the at0455 column
 * split files share: a three-up deck with two cards sharing slot 0 and the
 * Layout card on the right rail, the frame and seam readers, and the column
 * verbs as the action layer dispatches them.
 *
 * Split out of `at0455-column-split.test.ts` when that file was cut into
 * `at0455-column-split-tiles`, `-doors`, `-chords` and `-flow` to keep each
 * under the 20 s budget.
 */

import { type App, type BodyApp } from "./_harness";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

/** The imposition gaps (`lib/layout-imposer.ts`). */
export const GAP = 5;
/**
 * The bottom gap, which is the profile's rather than a constant. A maker's
 * canvas reserves `IMPOSITION_GAP_BOTTOM_MAKER_PX` at the foot for the host's
 * dev-info stamps; a release build draws none and keeps the ordinary gap
 * there. The app-test harness always reports maker mode OFF
 * (`AppDelegate.makerModeEnabled`), so the geometry under test is the release
 * one.
 */
export const GAP_BOTTOM = GAP;
/** The settle window, with room for the tween to land. */
export const AFTER_LAND_MS = 900;

/** The split family lives on the Tug layout tier (tuglaws/chord-tiers.md). */
export const SPLIT = ["cmd", "ctrl"] as const;
export const SPLIT_END = ["cmd", "ctrl", "shift"] as const;

export const RAIL_WIDTH = 420;
export const PANE_WIDTH = 420;

export const frame = (paneId: string): string => `.tug-pane[data-pane-id="${paneId}"]`;
export const columnSeam = (slot: number, index: number): string =>
  `[data-column-seam="${slot}:${index}"]`;

export const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

/**
 * Four cards in a three-up: two sharing slot 0, two sharing slot 1, plus the
 * Layout card on the right.
 *
 * Two occupied-and-shared slots rather than one, because the bug a
 * single-column fixture cannot see is a seam property that is keyed by index
 * alone: with one split column it reads correctly, and with two it has both
 * columns dividing at the same fraction.
 */
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
  const members: [string, number, string][] = [
    ["p1", 0, "A"],
    ["p2", 0, "B"],
    ["p3", 1, "C"],
    ["p4", 1, "D"],
  ];
  return {
    cards: [
      ...members.map(([, , cardId]) => ({
        id: cardId,
        componentId: "hello",
        title: `Card ${cardId}`,
        closable: true,
      })),
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      ...members.map(([id, slot, cardId]) => pane(id, slot, cardId)),
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
      kind: "three-up",
      sidebars: { layout: { side: "right" } },
    },
    hasFocus: true,
  };
}

/** Every named pane's live frame, in viewport coordinates. */
export async function rects(app: App, paneIds: string[]): Promise<Record<string, Rect>> {
  return app.evalJS<Record<string, Rect>>(
    `(function () {
      var out = {};
      ${JSON.stringify(paneIds)}.forEach(function (id) {
        var el = document.querySelector('.tug-pane[data-pane-id="' + id + '"]');
        if (el === null) return;
        var r = el.getBoundingClientRect();
        out[id] = {
          top: r.top, bottom: r.bottom, left: r.left, right: r.right,
          width: r.width, height: r.height,
        };
      });
      return out;
    })()`,
  );
}

/** How many frames are currently rendering as split column members. */
export function splitFrameCount(app: App): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll('.tug-pane[data-column-split]').length`,
  );
}

/** A place's toggle under the Layout card's strip — the card's door for its arrangement. */
export const placeMark = (key: string): string =>
  `[data-testid="layout-card-place-${key}"]`;

/** Which slots the toggle row currently marks, low to high. `layout` is the
 *  Layout card's page (`app.body("L")`). */
export function markedSlots(layout: App | BodyApp): Promise<number[]> {
  return layout.evalJS<number[]>(
    `Array.from(document.querySelectorAll('[data-testid="layout-card-toggles"] .layout-places-mark[data-place^="col-"]'))
      .map(function (el) {
        return parseInt(el.getAttribute("data-place").replace("col-", ""), 10);
      })
      .sort(function (a, b) { return a - b; })`,
  );
}

/** The arrangement pressing this mark would set — always the one NOT in force.
 *  `layout` is the Layout card's page (`app.body("L")`). */
export function placeOffers(layout: App | BodyApp, key: string): Promise<string | null> {
  return layout.getElementAttribute(placeMark(key), "data-choice-value");
}

export async function setColumnMode(
  app: App,
  slot: number,
  mode: "stack" | "split",
): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-column-mode", { slot: ${slot}, mode: ${JSON.stringify(mode)} }), null)`,
  );
  await wait(AFTER_LAND_MS);
}

/** The `columns` record as the live store holds it. */
export async function columnsRecord(
  app: App,
): Promise<Record<string, { mode?: string; order?: string[]; shares?: Record<string, number> }>> {
  return app.evalJS(
    `(window.tugdeck.diag.getDeckState().imposition.columns || {})`,
  );
}
