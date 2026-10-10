/**
 * at0506-factory-rail.test.ts — what a brand-new install's first card stands
 * beside.
 *
 * A factory-fresh deck holds its rail back until the user opens something:
 * the setup wizard over a bare canvas is no place to stage a rail of empty
 * cards, so the first content card is the cue. What stands up at that cue is
 * both rails — Arcs, Jots and Overview on the left, Cards and Layout on the
 * right — and this pins the three facts that makes true, none of which any
 * unit test can reach, because each is about the deck actually standing the
 * cards up:
 *
 *   1. **Five panes, on their sides.** Each rail's membership is the factory's,
 *      each card pinned to its side.
 *   2. **The arrangement is the factory's, not registration's.**
 *      `imposition.rails.left` reads exactly `["dashes","jots","overview"]`
 *      and `imposition.rails.right` exactly `["cards","layout"]`. Registration
 *      order is jots, overview, dashes, cards, layout, so a rail that fell
 *      back to it would stand in a different sequence and still look arranged.
 *   3. **Cards is frontmost.** The z-frontmost rail pane is the LAST of the
 *      rail panes in `state.panes`, which is what `railFrontmostPaneId`
 *      reads. The commit appends the panes in reverse for exactly this, so
 *      the assertion is on pane order rather than on the rails' vertical
 *      orders, which cannot answer it.
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
 * @covers tugdeck/src/cascade.ts
 * @covers tugdeck/src/layout-imposition.ts
 * @covers tugdeck/src/deck-manager.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

/** The rails the factory stands, top to bottom (`FACTORY_RAILS`). */
const FACTORY_LEFT = ["dashes", "jots", "overview"];
const FACTORY_RIGHT = ["cards", "layout"];
const FACTORY_RAIL = [...FACTORY_RIGHT, ...FACTORY_LEFT];

/** The componentIds of the panes pinned to either rail, in `state.panes`
 *  order — the deck's z-order, which is what settles the frontmost member. */
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
      .filter((id) => id !== null && sidebars[id] !== undefined);
  })()
`;

describe.skipIf(!SHOULD_RUN)("at0506 — the factory rail", () => {
  test(
    "the first card stands both factory rails, Cards frontmost",
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
          `${RAIL_COMPONENTS_IN_Z_ORDER}.length === ${FACTORY_RAIL.length}`,
          { timeoutMs: 8_000 },
        );

        // ---- 1 & 3. Five panes, and Cards is the last of them in z-order.
        const zOrder = await app.evalJS<string[]>(RAIL_COMPONENTS_IN_Z_ORDER);
        expect([...zOrder].sort()).toEqual([...FACTORY_RAIL].sort());
        expect(zOrder[zOrder.length - 1]).toBe("cards");

        // ---- 2. The arrangement is written, not fallen back to.
        const imposition = await app.evalJS<{
          kind?: string;
          contentWidth?: string;
          sidebars: Record<string, { side: string; pinned?: boolean }>;
          rails?: { left?: { order?: string[] }; right?: { order?: string[] } };
        }>(`window.tugdeck.diag.getDeckState().imposition`);
        expect(imposition.rails?.left?.order).toEqual(FACTORY_LEFT);
        expect(imposition.rails?.right?.order).toEqual(FACTORY_RIGHT);
        for (const id of FACTORY_LEFT) {
          expect(imposition.sidebars[id]).toEqual({ side: "left", pinned: true });
        }
        for (const id of FACTORY_RIGHT) {
          expect(imposition.sidebars[id]).toEqual({ side: "right", pinned: true });
        }
        expect(imposition.kind).toBe("four-up");
        expect(imposition.contentWidth).toBe("slim");

        // ---- Each side stands at its factory width, every member alike — a
        // rail is as wide as its widest pane, so one preferred width would
        // widen the whole side.
        const widths = await app.evalJS<Record<string, number>>(`
          (() => {
            const state = window.tugdeck.diag.getDeckState();
            const out = {};
            for (const pane of state.panes) {
              const card = state.cards.find((c) => c.id === pane.activeCardId);
              if (card && state.imposition.sidebars[card.componentId]) {
                out[card.componentId] = pane.size.width;
              }
            }
            return out;
          })()
        `);
        for (const id of FACTORY_LEFT) expect(widths[id]).toBe(420);
        for (const id of FACTORY_RIGHT) expect(widths[id]).toBe(395);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
