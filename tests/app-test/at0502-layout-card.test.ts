/**
 * at0502-layout-card.test.ts — the **Layout** card as a card.
 *
 * The layout picker used to be a band inside a larger sidebar card, reached by
 * opening that card and finding it. It is a registered sidebar card now, and this pins the
 * three facts that makes true — the ones no unit test can reach, because each
 * one is about the deck actually standing the card up:
 *
 *   1. `toggle-layout` shows the rail, and what stands on it is the Layout
 *      card — its own pane, on the deck's own rail machinery.
 *   2. The card draws the deck: the plan, and inside it a miniature whose
 *      blocks are the arrangement's slots. A picture that renders zero blocks
 *      is the failure this guards, and it is exactly the failure a move
 *      between directories can cause without a type error.
 *   3. The card lists one `Off · Left · Right` row per REGISTERED sidebar
 *      card, and one of those rows is its own — the rows are registry-driven,
 *      and the Layout card is in the registry.
 *
 * The toggle is dispatched twice: a second `toggle-layout` hides the rail
 * again, which is what makes the row a toggle rather than a way in. That is
 * the whole of the card's own door, and the rest of its behaviour — the
 * arrangement axes, the places overlay, the flow strip — is pinned by the
 * suites that already drive those controls.
 *
 * @covers tugdeck/src/components/layout/layout-card.tsx
 * @covers tugdeck/src/components/layout/layout-card-registration.tsx
 * @covers tugdeck/src/components/layout/layout-card.css
 * @covers tugdeck/src/lib/layout-card-id.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

/** The card's root — the element the body renders into. */
const CARD = '[data-testid="layout-card-section"]';

/** The committed drawing's blocks: one per slot the arrangement defines. */
const BLOCKS = '[data-plan-layer="committed"] .layout-mini-block';

describe.skipIf(!SHOULD_RUN)("at0502 — the Layout card", () => {
  test(
    "the toggle stands the card up, it draws the deck, and it lists itself",
    async () => {
      const app = await launchTugApp({ testName: "at0502-layout-card" });
      try {
        await app.waitForCondition<boolean>(
          `typeof window.__tug !== "undefined"`,
          { timeoutMs: 5_000 },
        );

        // ---- 1. The toggle stands the card up.
        await app.dispatchControlAction("toggle-layout");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CARD)}) !== null`,
          { timeoutMs: 8_000 },
        );

        // The card is hosted by a real pane, not mounted loose: the deck's own
        // rail machinery is what the breakout was for.
        expect(
          await app.evalJS<string | null>(
            `(function () {
              var card = document.querySelector(${JSON.stringify(CARD)});
              var pane = card === null ? null : card.closest("[data-pane-id]");
              return pane === null ? null : pane.getAttribute("data-pane-id");
            })()`,
          ),
        ).not.toBeNull();

        // ---- 2. It draws the deck.
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="layout-card-plan"]') !== null`,
          { timeoutMs: 8_000 },
        );
        const blocks = await app.evalJS<number>(
          `document.querySelectorAll(${JSON.stringify(BLOCKS)}).length`,
        );
        expect(blocks).toBeGreaterThan(0);

        // ---- 3. It lists itself among the sidebar rows.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector('[data-testid="layout-card-sidebar-layout"]') !== null`,
          ),
        ).toBe(true);

        // ---- The toggle is a toggle.
        await app.dispatchControlAction("toggle-layout");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CARD)}) === null`,
          { timeoutMs: 8_000 },
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
