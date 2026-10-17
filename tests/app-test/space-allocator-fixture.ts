/**
 * space-allocator-fixture.ts — the deck and the instruments the at0303 space
 * allocator files share: a three-card chain beside a Layout rail (and, for
 * the two-rail cases, an Overview rail on the other edge), the fixture-width
 * arithmetic that stands in for a window resize, and the seam and frame
 * readers.
 *
 * Split out of `at0303-imposer-space-allocator.test.ts` when that file was
 * cut into `at0303-space-allocator-engages`, `-retunes`, `-greed` and
 * `-drag-floor` to keep each under the 20 s budget.
 */

import { type App } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";
import { DEFAULT_OVERVIEW_WIDTH_PX } from "../../tugdeck/src/lib/overview-measure";
import {
  IMPOSITION_GAP_PX,
  RAIL_EDGE_INSET_PX,
  RAIL_GUTTER_PX,
} from "../../tugdeck/src/lib/layout-imposer";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 90_000;

/** The imposition gap (`lib/layout-imposer.ts`). */
export const GAP = IMPOSITION_GAP_PX;
/** What one standing rail costs the canvas besides its width: its stand-off
 *  from the window edge and its gutter to the first card, which are the
 *  rail's own lengths rather than the card gap (`lib/layout-imposer.ts`). */
export const RAIL_AIR = RAIL_EDGE_INSET_PX + RAIL_GUTTER_PX;
/** The widest any rail may stand: the slim content width. */
export const CEILING = 675;
/** The preferred rail width this test seeds, so nothing depends on the default. */
export const PREFERRED = 420;
/** The Layout card's registered floor (`MIN_LAYOUT_WIDTH_PX` in
 *  `components/layout/layout-card-registration.tsx`). */
export const MIN_RAIL_WIDTH_PX = 320;
/** The settle window, with room for the tween to land. */
export const AFTER_LAND_MS = 900;

// Three-up, and the fixture seeds three cards into its three slots: the chain
// the allocator solves is every slot the KIND defines, occupied or not
// ([D166]), so a three-card deck under five-up is a chain with two holes in it
// and no surplus left for a rail to flex into. A filled chain is what the
// arithmetic below describes, and what these claims are about.
export const THREE_UP_TILE = '[data-testid="layout-card-kind"] [data-choice-value="three-up"]';
export const KIND_TILES = '[data-testid="layout-card-kind"] [data-choice-value]';
export const RAIL_FRAME = `.tug-pane[data-pane-id="pRail"]`;
/** The Layout card's body, wherever its pane stands — the address that
 *  survives a hide/show cycle, which mints a new pane id. */
export const LAYOUT_FRAME = `[data-testid="layout-card-section"]`;
/** The three chain panes, in slot order. */
export const CHAIN = ["p1", "p2", "p3"];

/**
 * A deck of three cards in slots 1, 3 and 5 (stored 0-based) at `paneWidth`,
 * with the Layout card pinned right at `railWidth`. The kind starts at two-up, so
 * choosing Five Up in the Layouts section is a real kind change.
 */
export function deckShape(paneWidth: number, railWidth: number) {
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: paneWidth, height: 400 },
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
      pane("p2", 1, "B"),
      pane("p3", 2, "C"),
      {
        id: "pRail",
        position: { x: 0, y: 0 },
        size: { width: railWidth, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Layout",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p1",
    imposition: { kind: "two-up", layout: "fit", sidebars: { layout: { side: "right" } } },
    hasFocus: true,
  };
}

export const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Seed the user's preferred rail width, the number the flex range centres on. */
export async function seedPreferredWidth(app: App, widthPx: number): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${widthPx} }), null)`,
  );
}

/** The width of the canvas the chain is imposed across. */
export async function canvasWidth(app: App): Promise<number> {
  return app.evalJS<number>(
    // The canvas container by identity rather than by walking up one level: a
    // pane's parent is its workspace wrapper now ([B06]), and a shown wrapper
    // is `display: contents`, so it has no box and `clientWidth` reads 0.
    `document.querySelector("[data-deck-canvas-background]").clientWidth`,
  );
}

export async function frameWidth(app: App, paneId: string): Promise<number> {
  return app.evalJS<number>(
    `document.querySelector('.tug-pane[data-pane-id="${paneId}"]').getBoundingClientRect().width`,
  );
}

/** The seam between each pair of adjacent chain panes, left to right. */
export async function seams(app: App): Promise<number[]> {
  return app.evalJS<number[]>(
    `(function () {
      var rects = ${JSON.stringify(CHAIN)}.map(function (id) {
        return document.querySelector('.tug-pane[data-pane-id="' + id + '"]').getBoundingClientRect();
      });
      var out = [];
      for (var i = 0; i < rects.length - 1; i += 1) {
        out.push(rects[i + 1].left - rects[i].right);
      }
      return out;
    })()`,
  );
}

/**
 * The pane width whose exact solve puts the rail `offset` px off the preferred
 * width. Three cards and two seams fill the band, the band keeps one gap at
 * its far edge, and the rail keeps its own air on the near side — so
 * `rail = canvas - railAir - 3·gap - 3·width`.
 */
export function paneWidthFor(canvas: number, offset: number): number {
  return Math.floor((canvas - RAIL_AIR - GAP * 3 - (PREFERRED + offset)) / 3);
}

/** What the allocator must answer for that fixture — the same arithmetic back. */
export function predictedRailWidth(canvas: number, paneWidth: number): number {
  return canvas - RAIL_AIR - GAP * 3 - paneWidth * 3;
}

/**
 * The pane width whose solve wants the two rails to total `railTotal`.
 *
 * With rails on both edges the canvas spends each rail's air and two gaps —
 * one interior seam per card pair — so
 * `canvas = railTotal + 2·railAir + 2·gap + 3·pane`. Seeding the CARD width is
 * how this test moves the target: `T*` is a function of the chain's widths
 * exactly as it is of the canvas, and the harness cannot resize the window.
 */
export function twoRailPaneWidth(canvas: number, railTotal: number): number {
  return Math.floor((canvas - RAIL_AIR * 2 - GAP * 2 - railTotal) / 3);
}

/** The rail total that fixture actually asks for — the floor above leaves up
 *  to 2px on the table, and the assertions are exact, so they read it back. */
export function railTotalFor(canvas: number, paneWidth: number): number {
  return canvas - RAIL_AIR * 2 - GAP * 2 - paneWidth * 3;
}

/** The three-card chain with the Overview pinned left and the Layout card right, each
 *  standing at the width its owner chose. */
export async function seedTwoRails(
  app: App,
  paneWidth: number,
  kind: "two-up" | "three-up" = "two-up",
): Promise<void> {
  const shape = deckShape(paneWidth, PREFERRED);
  shape.cards.push({
    id: "G",
    componentId: "overview",
    title: "Overview",
    closable: true,
  });
  shape.panes.push({
    id: "pGaz",
    position: { x: 0, y: 0 },
    size: { width: DEFAULT_OVERVIEW_WIDTH_PX, height: 900 },
    cardIds: ["G"],
    activeCardId: "G",
    title: "Overview",
    acceptsFamilies: [],
  });
  await app.seedDeckState({
    state: {
      ...shape,
      imposition: {
        kind,
        layout: "fit",
        sidebars: { layout: { side: "right" }, overview: { side: "left" } },
      },
    },
    focusCardId: "A",
  });
  await (await waitForBodyReady(app, "L")).waitForCondition<boolean>(
    `document.querySelectorAll(${JSON.stringify(KIND_TILES)}).length > 0`,
    { timeoutMs: 8_000 },
  );
  await wait(AFTER_LAND_MS);
}

export async function seedFixture(
  app: App,
  paneWidth: number,
  railWidth: number,
): Promise<void> {
  await app.seedDeckState({
    state: deckShape(paneWidth, railWidth),
    focusCardId: "A",
  });
  await (await waitForBodyReady(app, "L")).waitForCondition<boolean>(
    `document.querySelectorAll(${JSON.stringify(KIND_TILES)}).length > 0`,
    { timeoutMs: 8_000 },
  );
}
