/**
 * at0453-slot-move-holds-rails.test.ts — moving a card WITHIN the chain is not
 * a licence to re-solve the rails.
 *
 * The space allocator has a short list of moments it may spend a rail's width
 * on (`retuneSidebarAllocation`), and "a card was assigned to a slot" is on it.
 * That entry was written for a card JOINING the chain: a loose card gaining a
 * slot changes what the chain IS, so the deck makes room for what it was just
 * asked to arrange (at0303 case 5 pins exactly that, and it stays pinned).
 *
 * A card that already had a slot taking a different one is not that gesture.
 * Chain membership does not change, nothing new needs room — and yet the solve
 * ran, saw the chain pack into fewer columns, and handed the freed width to the
 * rails. Pressing ⌘3 on the middle of three cards moved the card AND grew the
 * left rail by most of a card width, which reads as the deck rearranging itself
 * behind a gesture that named one card.
 *
 * It is the same fault `setCardWidths` was given `retuneRails: false` for — a
 * ⌃⌘-digit drained the Lens to its floor — and the two verbs are siblings: both
 * are card-addressed, so neither may spend the rails. The rule that separates
 * them from the Layouts click is membership, not verb: a pane entering the
 * chain retunes, a pane moving inside it does not.
 *
 * The last block is what keeps this honest. Asserting "the rails did not move"
 * would pass just as well on a fixture where the allocator had nothing it
 * wanted to do — so after the move, the test re-asserts the layout (a Layouts
 * click, which IS one of the moments) and requires the rails to move THEN. The
 * allocator wanted the width all along; the slot move simply declined to take
 * it.
 *
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/action-dispatch.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { DEFAULT_OVERVIEW_WIDTH_PX } from "../../tugdeck/src/lib/overview-measure";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

/** The settle window, with room for the tween to land. */
const AFTER_LAND_MS = 900;
/** Frames are measured in device pixels; a rounded pin is within a pixel. */
const TOL = 1.5;
const LENS_WIDTH = 420;
const PANE_WIDTH = 420;
const KIND_TILES = '[data-testid="lens-layouts-kind"] [data-choice-value]';

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Three cards filling a three-up, with a rail pinned on each edge — the shape
 *  the report came from. */
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
      { id: "G", componentId: "overview", title: "Overview", closable: true },
    ],
    panes: [
      pane("p1", 0, "A"),
      pane("p2", 1, "B"),
      pane("p3", 2, "C"),
      {
        id: "pLens",
        position: { x: 0, y: 0 },
        size: { width: LENS_WIDTH, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Lens",
        acceptsFamilies: [],
      },
      {
        id: "pGaz",
        position: { x: 0, y: 0 },
        size: { width: DEFAULT_OVERVIEW_WIDTH_PX, height: 900 },
        cardIds: ["G"],
        activeCardId: "G",
        title: "Overview",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p2",
    imposition: {
      kind: "three-up",
      sidebars: { layout: { side: "right" }, overview: { side: "left" } },
    },
    hasFocus: true,
  };
}

async function frameWidth(app: App, paneId: string): Promise<number> {
  return app.evalJS<number>(
    `document.querySelector('.tug-pane[data-pane-id="${paneId}"]').getBoundingClientRect().width`,
  );
}

async function slotOf(app: App, paneId: string): Promise<number | null> {
  return app.evalJS<number | null>(
    `(function () {
      var pane = window.tugdeck.diag.getDeckState().panes.find(function (p) {
        return p.id === ${JSON.stringify(paneId)};
      });
      return pane === undefined || pane.slot === undefined ? null : pane.slot;
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)(
  "at0453 — a slot move inside the chain leaves the rails alone",
  () => {
    test(
      "⌘3 on the middle card moves it and nothing else, and the allocator still wanted the width",
      async () => {
        const app = await launchTugApp({
          testName: "at0453-slot-move-holds-rails",
        });
        try {
          await app.evalJS<null>(
            `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
          );
          await app.seedDeckState({ state: deckShape(), focusCardId: "B" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(KIND_TILES)}).length > 0`,
            { timeoutMs: 8_000 },
          );
          await wait(AFTER_LAND_MS);

          // No selection standing, so ⌘3 means the card in front — card B, the
          // middle of the three, exactly as in the report.
          await app.evalJS<null>(
            `(window.__tug.setLayoutSelection([]), null)`,
          );
          const railBefore = await frameWidth(app, "pGaz");
          const lensBefore = await frameWidth(app, "pLens");
          expect(await slotOf(app, "p2"), "the middle card starts at slot 2").toBe(1);

          await app.nativeKey("3", ["cmd"]);
          await wait(AFTER_LAND_MS);

          expect(await slotOf(app, "p2"), "⌘3 moved the card it named").toBe(2);
          expect(await slotOf(app, "p1"), "and left the others where they were").toBe(0);
          expect(await slotOf(app, "p3"), "both of them").toBe(2);

          const railAfter = await frameWidth(app, "pGaz");
          const lensAfter = await frameWidth(app, "pLens");
          note(
            `rail ${railBefore} → ${railAfter}, lens ${lensBefore} → ${lensAfter}`,
          );
          expect(
            Math.abs(railAfter - railBefore),
            "the left rail is the user's, and a slot move never asked for it",
          ).toBeLessThanOrEqual(TOL);
          expect(
            Math.abs(lensAfter - lensBefore),
            "nor the right one",
          ).toBeLessThanOrEqual(TOL);

          // ── The guard on the guard ──────────────────────────────────────
          // Re-assert the layout, which IS one of the allocator's moments. The
          // chain now packs into fewer columns than it did, so a licensed
          // solve has width to spend — and spends it. Without this the block
          // above would pass on a fixture where nothing wanted to move.
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-imposition", { kind: "three-up" }), null)`,
          );
          await wait(AFTER_LAND_MS);
          const railRetuned = await frameWidth(app, "pGaz");
          const lensRetuned = await frameWidth(app, "pLens");
          note(`after a licensed retune: rail ${railRetuned}, lens ${lensRetuned}`);
          expect(
            Math.abs(railRetuned - railBefore) > TOL ||
              Math.abs(lensRetuned - lensBefore) > TOL,
            "a Layouts click does re-solve — the width was there to take",
          ).toBe(true);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
