/**
 * at0193-deselect-renav.test.ts — a deselected deck re-activates its card via
 * the card / pane navigation commands.
 *
 * A click on the empty canvas deselects: it clears the active card, so every
 * title bar deactivates and no pane is the first responder (the chain promotes
 * the deck-canvas root). With a single card there is nowhere to navigate, so
 * Previous Card / Next Card / Cycle Panes — the commands the host keeps enabled
 * while deselected — re-activate the card instead, restoring its selected
 * state. This pins that recovery path through the real menu dispatch.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/action-dispatch.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/focus-transfer.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 150_000;

const CARD = (id: string) => `[data-card-id="${id}"]`;
const exists = (sel: string) =>
  `document.querySelector(${JSON.stringify(sel)}) !== null`;

// A single card in a single pane on the left — leaves empty canvas on the
// right (x ≈ 700) for the deselect click.
function oneCard() {
  return {
    cards: [
      { id: "A", componentId: "gallery-input", title: "Card A", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 460, height: 520 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

// The pane's title-bar selection signal: `data-focused="true"` iff the pane is
// the active (selected) one. The pane-focus controller writes it from
// `activePaneId`, so a deselect drops it to "false".
const paneSelected = (paneId: string) =>
  `(function(){
    var el = document.querySelector('.tug-pane[data-pane-id="${paneId}"]');
    return el !== null && el.getAttribute("data-focused") === "true";
  })()`;

const settle = () => new Promise((r) => setTimeout(r, 350));

describe.skipIf(!SHOULD_RUN)(
  "AT0193: deselected deck re-activates via nav commands",
  () => {
    test(
      "canvas-click deselect → previous-tab / next-tab each re-activate the card",
      async () => {
        const app = await launchTugApp({ testName: "at0193-deselect-renav" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: oneCard(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          await app.waitForCondition<boolean>(exists(CARD("A")), {
            timeoutMs: 6000,
          });

          // Selected at rest.
          await settle();
          expect(
            await app.evalJS<boolean>(paneSelected("p1")),
            "card selected at rest",
          ).toBe(true);

          // Each nav command, from the deselected state, re-activates the card.
          for (const action of ["previous-tab", "next-tab"]) {
            // Deselect: click the empty canvas to the right of the pane.
            await app.nativeMouseDown({ x: 700, y: 300 });
            await app.nativeMouseUp({ x: 700, y: 300 });
            await settle();
            expect(
              await app.evalJS<boolean>(paneSelected("p1")),
              `deselected before ${action}`,
            ).toBe(false);

            // The command re-activates the single card — the deselected-deck
            // recovery path (host keeps these enabled while deselected).
            await app.evalJS<void>(
              `window.__tug.dispatchControlAction(${JSON.stringify(action)})`,
            );
            await settle();
            expect(
              await app.evalJS<boolean>(paneSelected("p1")),
              `${action} re-activates the card`,
            ).toBe(true);
          }
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "")
            process.stderr.write(`\n[at0193] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
