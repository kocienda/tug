/**
 * at0469-places-sidebar-rows-side-move.test.ts — the deck's picture, wearing
 * its places: a sidebar's row moves the real card; the picture carries no
 * side arrows.
 *
 * One of the at0469-places-sidebar-rows split, a test to a file so each
 * launch fits its own budget. The sidebar-rows files carry claim 4 (a rail is
 * a place too: its row shows, moves and hides the real card) and the toggle
 * row's keyboard walk. The claims the at0469-places family reads, the deck
 * and the readers are `layout-places-fixture.ts`.
 *
 * @family at0469-places
 * @covers tugdeck/src/components/layout/layout-places.tsx
 * @covers tugdeck/src/components/layout/layout-miniature.tsx
 * @covers tugdeck/src/components/layout/layout-card.tsx
 * @covers tugdeck/src/components/layout/miniature-faces.tsx
 * @covers tugdeck/src/components/layout/miniature-card-tip.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  AFTER_LAND_MS,
  RAIL_WIDTH,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  deckShape,
  wait,
} from "./layout-places-fixture";

describe.skipIf(!SHOULD_RUN)("at0469 — the drawing wears its places: the sidebar rows", () => {
  test(
    "a sidebar's row moves the real card; the picture carries no side arrows",
    async () => {
      const app = await launchTugApp();
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.body("L").waitForCondition<boolean>(
          `document.querySelector('[data-testid="layout-card-sidebar-layout"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // Placement is the ROW's question, not the picture's: the schematic's
        // marks say only stack versus split, and the picture carries no
        // side-move affordance at all. The row can also say Off, which is the
        // answer no mark on a drawing of the open deck could offer.
        const arrows = await app.body("L").evalJS<number>(
          `document.querySelectorAll('[data-testid^="layout-card-place-side-"]').length`,
        );
        expect(
          arrows,
          "the picture carries no side-move affordance — the rows own placement",
        ).toBe(0);

        const railBefore = await app.evalJS<number>(
          `document.querySelector('.tug-pane[data-pane-id="pRail"]').getBoundingClientRect().left`,
        );
        const cardBefore = await app.evalJS<number>(
          `document.querySelector('.tug-pane[data-pane-id="p1"]').getBoundingClientRect().left`,
        );
        expect(
          railBefore,
          "the Layout card starts to the right of the content cards",
        ).toBeGreaterThan(cardBefore);

        await app.body("L").click(
          `[data-testid="layout-card-sidebar-layout"] [data-choice-value="left"]`,
        );
        await wait(AFTER_LAND_MS);

        const railAfter = await app.evalJS<number>(
          `document.querySelector('.tug-pane[data-pane-id="pRail"]').getBoundingClientRect().left`,
        );
        const cardAfter = await app.evalJS<number>(
          `document.querySelector('.tug-pane[data-pane-id="p1"]').getBoundingClientRect().left`,
        );
        // The real card moved, not just the row: the press went through the
        // section's own `set-sidebar-side` route.
        expect(
          railAfter,
          "pressing Left on the Layout card's row moved the real Layout card to the left edge",
        ).toBeLessThan(cardAfter);
        note(
          `rail ${Math.round(railBefore)} → ${Math.round(railAfter)}, ` +
            `card ${Math.round(cardBefore)} → ${Math.round(cardAfter)}`,
        );

        // And the row now reads the side it holds.
        const activeNow = await app.body("L").evalJS<string | null>(
          `(function () {
            var el = document.querySelector('[data-testid="layout-card-sidebar-layout"] [data-choice-value][data-state="active"]');
            return el === null ? null : el.getAttribute("data-choice-value");
          })()`,
        );
        expect(activeNow, "the row reads the move").toBe("left");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
