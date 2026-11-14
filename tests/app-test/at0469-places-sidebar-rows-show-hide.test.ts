/**
 * at0469-places-sidebar-rows-show-hide.test.ts — the deck's picture, wearing
 * its places: a sidebar row shows, moves, and hides the real card.
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
    "a sidebar row shows, moves, and hides the real card",
    async () => {
      const app = await launchTugApp();
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.body("L").waitForCondition<boolean>(
          `document.querySelector('[data-testid="layout-card-sidebar-jots"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        const activeOf = (id: string): Promise<string | null> =>
          app.body("L").evalJS<string | null>(
            `(function () {
              var el = document.querySelector('[data-testid="${id}"] [data-choice-value][data-state="active"]');
              return el === null ? null : el.getAttribute("data-choice-value");
            })()`,
          );

        // ── The rows read what stands: Layout open on the right, Jots off. ──
        expect(
          await activeOf("layout-card-sidebar-layout"),
          "the Layout card's row reads the side it holds",
        ).toBe("right");
        expect(
          await activeOf("layout-card-sidebar-jots"),
          "a hidden card's row reads Off",
        ).toBe("off");

        // ── And the drawing draws what stands: no rail for a hidden card. ──
        //
        // Membership is a live read of the OPEN cards. A registered-but-hidden
        // Jots is not on the deck, so its side is not drawn at all — the row
        // above is its one door. Read off the committed drawing rather than off
        // a mark: a rail wears none ([B01]).
        const drawnRails = async (): Promise<number> =>
          app.body("L").evalJS<number>(
            `document.querySelectorAll(
              '.layouts-plan-layer[data-plan-layer="committed"] .layout-mini-rail'
            ).length`,
          );
        expect(await drawnRails(), "only the occupied right side is drawn").toBe(1);

        // ── Pressing a side on a hidden card's row shows it THERE. ──
        await app.body("L").click(
          `[data-testid="layout-card-sidebar-jots"] [data-choice-value="left"]`,
        );
        await wait(AFTER_LAND_MS);
        expect(
          await activeOf("layout-card-sidebar-jots"),
          "the row now reads the side it was shown on",
        ).toBe("left");
        const jotsLeft = await app.evalJS<number>(
          `document.querySelectorAll('.tug-pane[data-rail-side="left"]').length`,
        );
        expect(jotsLeft, "the real Jots card stands on the left edge").toBe(1);
        // The drawing follows: a left rail appears beside the right one.
        await app.body("L").waitForCondition<boolean>(
          `document.querySelectorAll(
            '.layouts-plan-layer[data-plan-layer="committed"] .layout-mini-rail'
          ).length === 2`,
          { timeoutMs: 4_000 },
        );
        expect(await drawnRails(), "both edges now carry a rail").toBe(2);

        // ── Off hides it again, and everything retracts together. ──
        await app.body("L").click(
          `[data-testid="layout-card-sidebar-jots"] [data-choice-value="off"]`,
        );
        await wait(AFTER_LAND_MS);
        expect(await activeOf("layout-card-sidebar-jots")).toBe("off");
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll('.tug-pane[data-rail-side="left"]').length`,
          ),
          "the real card left the deck",
        ).toBe(0);
        expect(await drawnRails(), "and its rail left the drawing").toBe(1);
        note("jots: off → left → off, with the deck and the drawing in step");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
