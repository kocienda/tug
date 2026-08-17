/**
 * zz-probe-layout-miniature.test.ts — TEMPORARY visual probe. Delete after use.
 *
 * @covers tugdeck/src/components/lens/layout-miniature.tsx
 */

import { describe, expect, test } from "bun:test";
import { copyFileSync } from "node:fs";

import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

function deckShape(): Record<string, unknown> {
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: 560, height: 620 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  return {
    cards: [
      { id: "A", componentId: "gallery-accordion", title: "Card A", closable: true },
      { id: "B", componentId: "gallery-accordion", title: "Card B", closable: true },
      { id: "C", componentId: "gallery-accordion", title: "Card C", closable: true },
      { id: "L", componentId: "lens", title: "Lens", closable: true },
    ],
    panes: [
      pane("p1", 0, "A"),
      pane("p2", 1, "B"),
      pane("p3", 2, "C"),
      {
        id: "pLens",
        position: { x: 0, y: 0 },
        size: { width: 420, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Lens",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p1",
    imposition: {
      kind: "three-up",
      contentWidth: "slim",
      sidebars: {
        lens: { side: "right" },
        jots: { side: "left" },
        overview: { side: "left" },
      },
      rails: { left: { mode: "split" }, right: { mode: "split" } },
    },
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)("zz probe — layout miniature", () => {
  test(
    "shoot committed and preview",
    async () => {
      const app = await launchTugApp({ testName: "zz-probe-layout-miniature" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="lens-layouts-plan"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await app.evalJS(
          `document.querySelector('[data-testid="lens-layouts-section"]')
             .scrollIntoView({ block: "center" })`,
        );
        const committed = await app.screenshot();
        copyFileSync(committed.path, "/tmp/mini-committed.png");

        // The preview path the pointer drives: a real pointerover on a segment
        // the section has not already got.
        await app.evalJS(
          `(function () {
             var seg = document.querySelector(
               '[data-testid="lens-layouts-width"] [data-choice-value="wide"]'
             );
             seg.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
             return true;
           })()`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="lens-layouts-plan"]')
             .hasAttribute("data-previewing")`,
          { timeoutMs: 4_000 },
        );
        const preview = await app.screenshot();
        copyFileSync(preview.path, "/tmp/mini-preview.png");
        expect(true).toBe(true);
      } finally {
        await app.close();
      }
    },
    90_000,
  );
});
