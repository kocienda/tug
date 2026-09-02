/**
 * at0506-factory-rail.test.ts — what a brand-new install's first card stands
 * beside.
 *
 * A factory-fresh deck holds its rail back until the user opens something:
 * the setup wizard over a bare canvas is no place to stage a rail of empty
 * cards, so the first content card is the cue. What stands up at that cue used
 * to be the Cards card alone. It is the whole rail now — Cards, Dashes,
 * Layout, Tripwires — and this pins the three facts that makes true, none of
 * which any unit test can reach, because each is about the deck actually
 * standing the cards up:
 *
 *   1. **Four panes, on the right.** The rail's membership is the four
 *      sidebar cards the deck ships with, each pinned to the default side.
 *   2. **The arrangement is the factory's, not registration's.**
 *      `imposition.rails.right` reads `stack` in exactly
 *      `["cards","dashes","layout","tripwires"]`. Registration order is jots,
 *      overview, tripwires, dashes, cards, layout, so a rail that fell back to
 *      it would stand in a different sequence and still look arranged.
 *   3. **Cards is the one you see.** A stack draws one member, and the one it
 *      draws is the z-frontmost — the LAST of the rail's panes in
 *      `state.panes`, which is what `railFrontmostPaneId` reads. The commit
 *      appends the panes in reverse for exactly this, so the assertion is on
 *      pane order rather than on the rail's vertical order, which cannot
 *      answer it.
 *
 * The launch is the point of the fixture: `restoreInTestMode` with the
 * harness's own fresh per-instance tugbank and no seeding at all, so the boot
 * honors a persisted layout that is not there — which is what `factoryFresh`
 * means. Seeding a deck would answer the question before it was asked.
 *
 * Fact 3 rests on `railFrontmostPaneId` in
 * `tugdeck/src/components/chrome/deck-canvas.tsx`, which this file
 * deliberately does NOT name: that path's `@covers` fan-out is recorded at 21
 * in `ACCEPTED_FANOUT`, and a twenty-second namer would raise a debt figure
 * the selection budget lets you pay down but never refinance. The frontmost
 * rule is reached here through the deck manager that appends the panes, which
 * is the half this test can actually move.
 *
 * @covers tugdeck/src/deck-manager.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

/** The rail the factory stands, top to bottom (`FACTORY_RAIL_ORDER`). */
const FACTORY_RAIL = ["cards", "dashes", "layout", "tripwires"];

/** The componentIds of the panes pinned to the right, in `state.panes` order —
 *  the deck's z-order, which is what settles the stack's frontmost member. */
const RAIL_COMPONENTS_IN_Z_ORDER = `
  (() => {
    const state = window.tugdeck.diag.getDeckState();
    const sidebars = state.imposition.sidebars || {};
    const componentOf = (pane) => {
      const card = state.cards.find((c) => c.id === pane.activeCardId);
      return card ? card.componentId : null;
    };
    return state.panes
      .map(componentOf)
      .filter((id) => id !== null && (sidebars[id] || {}).side === "right");
  })()
`;

describe.skipIf(!SHOULD_RUN)("at0506 — the factory rail", () => {
  test(
    "the first card stands all four cards on the right, Cards frontmost",
    async () => {
      const app = await launchTugApp({
        testName: "at0506-factory-rail",
        restoreInTestMode: true,
      });
      try {
        await app.waitForCondition<boolean>(
          `typeof window.__tug !== "undefined"`,
          { timeoutMs: 5_000 },
        );

        // The rail is held back until there is a card to stand beside.
        expect(await app.evalJS<string[]>(RAIL_COMPONENTS_IN_Z_ORDER)).toEqual(
          [],
        );

        // One content card — the cue. Settings is a singleton content card, so
        // it is one `addCard` and nothing about the rail.
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("show-card", { component: "settings" }), null)`,
        );
        await app.waitForCondition<boolean>(
          `${RAIL_COMPONENTS_IN_Z_ORDER}.length === 4`,
          { timeoutMs: 8_000 },
        );

        // ---- 1 & 3. Four panes, and Cards is the last of them in z-order.
        const zOrder = await app.evalJS<string[]>(RAIL_COMPONENTS_IN_Z_ORDER);
        expect([...zOrder].sort()).toEqual([...FACTORY_RAIL].sort());
        expect(zOrder[zOrder.length - 1]).toBe("cards");

        // ---- 2. The arrangement is written, not fallen back to.
        const rail = await app.evalJS<{ mode?: string; order?: string[] }>(
          `(window.tugdeck.diag.getDeckState().imposition.rails || {}).right || {}`,
        );
        expect(rail.mode).toBe("stack");
        expect(rail.order).toEqual(FACTORY_RAIL);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
