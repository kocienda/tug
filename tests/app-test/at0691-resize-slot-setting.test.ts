/**
 * at0691-resize-slot-setting.test.ts — the Layout card's Resizing row is the
 * door to what an edge resize does to an imposed card's slot.
 *
 * The rule is deck-wide and defaults to keeping the slot, so:
 *
 *  1. A deck that never chose shows **Keeps Slot** and stores nothing — the
 *     default is an absent field, not a written one.
 *  2. Pressing **Releases** writes `"release"` onto the imposition, and pressing
 *     **Keeps Slot** writes `"keep"` back.
 *  3. Neither press moves anything. The rule is for the NEXT resize, so every
 *     card keeps its slot and its frame, and the rail keeps its width — choosing
 *     how a later gesture behaves is not a moment the deck re-solves its rails.
 *
 * @covers tugdeck/src/components/layout/layout-card.tsx
 * @covers tugdeck/src/action-dispatch.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const RESIZE_TILE = (value: string): string =>
  `[data-testid="layout-card-resize"] [data-choice-value="${value}"]`;

/** Two slotted content cards on a fit deck, plus the Layout card at its pin. */
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
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      pane("p1", 0, "A"),
      pane("p2", 1, "B"),
      {
        id: "pRail",
        position: { x: 0, y: 0 },
        size: { width: 412, height: 900 },
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

/** The stored rule, or null when the field is absent. */
async function storedRule(app: App): Promise<string | null> {
  return app.evalJS<string | null>(
    `window.tugdeck.diag.getDeckState().imposition.resizeSlot ?? null`,
  );
}

/** Which segment of the row wears the selection. */
async function activeTile(app: App): Promise<string | null> {
  return app.evalJS<string | null>(
    `document.querySelector('[data-testid="layout-card-resize"] [data-state="active"]')?.getAttribute("data-choice-value") ?? null`,
  );
}

/** Every pane's slot and rounded frame rect, keyed by pane id. */
async function frames(app: App): Promise<string> {
  return app.evalJS<string>(
    `JSON.stringify(
       ["p1", "p2", "pRail"].map(function (id) {
         var r = document.querySelector('.tug-pane[data-pane-id="' + id + '"]').getBoundingClientRect();
         var pane = window.tugdeck.diag.getDeckState().panes.find(function (p) { return p.id === id; });
         return [id, pane.slot ?? null, Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
       })
     )`,
  );
}

describe.skipIf(!SHOULD_RUN)(
  "at0691 — the Resizing row chooses what an edge resize does to a slot",
  () => {
    test(
      "defaults to Keeps Slot, writes each answer, and moves nothing",
      async () => {
        const app = await launchTugApp({ testName: "at0691-resize-slot-setting" });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(RESIZE_TILE("keep"))}) !== null`,
            { timeoutMs: 8_000 },
          );

          // ── A deck that never chose keeps the slot, and stores nothing. ──
          expect(await storedRule(app)).toBeNull();
          expect(await activeTile(app)).toBe("keep");
          const before = await frames(app);

          // ── Releases, from the real control. ──
          await app.nativeClickAtElement(RESIZE_TILE("release"));
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getDeckState().imposition.resizeSlot === "release"`,
            { timeoutMs: 8_000 },
          );
          expect(await activeTile(app)).toBe("release");
          // A rule for the next gesture: every slot, frame and the rail stand.
          expect(await frames(app)).toBe(before);

          // ── And back. ──
          await app.nativeClickAtElement(RESIZE_TILE("keep"));
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getDeckState().imposition.resizeSlot === "keep"`,
            { timeoutMs: 8_000 },
          );
          expect(await activeTile(app)).toBe("keep");
          expect(await frames(app)).toBe(before);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
