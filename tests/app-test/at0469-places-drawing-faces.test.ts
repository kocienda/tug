/**
 * at0469-places-drawing-faces.test.ts — the deck's picture, wearing its
 * places: every block wears its card's face, and hovering one names the card.
 *
 * One of the at0469-places-drawing split, a test to a file so each launch
 * fits its own budget. This file carries the faces half of claim 6;
 * `at0469-places-drawing-preview` carries the preview half. The claims the
 * at0469-places family reads, the deck and the readers are
 * `layout-places-fixture.ts`.
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

describe.skipIf(!SHOULD_RUN)("at0469 — the drawing wears its places: the drawing", () => {
  test(
    "every block wears its card's face, and hovering one names the card",
    async () => {
      const app = await launchTugApp();
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.body("L").waitForCondition<boolean>(
          `document.querySelector('[data-testid="layout-card-target-block-0"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // ── The faces: one per occupied slot, a sheet behind a stack. ──
        //
        // Slot 0 holds two cards stacked, slot 1 one, slot 2 none. A faced
        // block draws its front card's face, and a stack draws a sheet per
        // card behind the front one stepping out at the top. An empty slot
        // stays a bare block — there is no card to draw. Read off the
        // committed layer's live DOM.
        const faces = await app.body("L").evalJS<{
          faced: number[];
          sheets: Record<string, number>;
          icons: Record<string, number>;
          railIcons: number;
          rects: Record<string, [number, number]>;
        }>(
          `(function () {
            var layer = document.querySelector('.layouts-plan-layer[data-plan-layer="committed"]');
            var blocks = layer.querySelectorAll(".layout-mini-field .layout-mini-block");
            var faced = [], sheets = {}, icons = {}, rects = {};
            Array.prototype.forEach.call(blocks, function (el, i) {
              if (el.hasAttribute("data-faced")) faced.push(i);
              sheets[i] = el.querySelectorAll(".layout-mini-sheet").length;
              icons[i] = el.querySelectorAll(".layout-mini-face-icon").length;
              var r = el.getBoundingClientRect();
              var t = document.querySelector('[data-testid="layout-card-target-block-' + i + '"]');
              var tr = t === null ? null : t.getBoundingClientRect();
              rects[i] = [r.left - (tr ? tr.left : NaN), r.width - (tr ? tr.width : NaN)];
            });
            return {
              faced: faced,
              sheets: sheets,
              icons: icons,
              railIcons: layer.querySelectorAll(".layout-mini-rail-icon").length,
              rects: rects,
            };
          })()`,
        );
        note(
          `faced ${JSON.stringify(faces.faced)}, sheets ${JSON.stringify(faces.sheets)}, ` +
            `icons ${JSON.stringify(faces.icons)}, rail icons ${faces.railIcons}`,
        );
        expect(faces.faced, "the two occupied slots wear faces; the empty one does not").toEqual([0, 1]);
        expect(faces.sheets["0"], "the two-card stack shows one sheet behind its front").toBe(1);
        expect(faces.sheets["1"], "a lone card shows none").toBe(0);
        expect(faces.icons["0"], "a face carries its card's icon").toBe(1);
        expect(faces.icons["2"], "the empty slot carries none").toBe(0);
        expect(faces.railIcons, "the rail's one card wears its icon").toBe(1);
        // The block keeps its rect: the faces draw INSIDE it, so the target
        // standing on it still covers exactly the card it names.
        for (const slot of ["0", "1", "2"]) {
          const [dl, dw] = faces.rects[slot];
          expect(Math.abs(dl), `slot ${slot}'s face leaves its block where its target is`).toBeLessThan(1);
          expect(Math.abs(dw), `and as wide`).toBeLessThan(1);
        }

        // ── The hover names the card, its place, and what is behind it. ──
        //
        // The target is a TugTooltip trigger; a pointer resting on it opens
        // the bubble. The tip resolves the card's name through the one
        // identity door, so it reads the seeded card's own title.
        await app.body("L").evalJS<null>(
          `(function () {
            var el = document.querySelector('[data-testid="layout-card-target-block-0"]');
            var opts = { bubbles: true, cancelable: true, pointerType: "mouse" };
            el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false, pointerType: "mouse" }));
            el.dispatchEvent(new PointerEvent("pointermove", opts));
            return null;
          })()`,
        );
        await app.body("L").waitForCondition<boolean>(
          `document.querySelector('[data-testid="layout-card-tip"]') !== null`,
          { timeoutMs: 5_000 },
        );
        const tip = await app.body("L").getElementText('[data-testid="layout-card-tip"]');
        note(`slot 1 tip: ${tip.replace(/\s+/g, " ")}`);
        expect(tip, "the tip names the front card").toMatch(/Card [AB]/);
        expect(tip, "and its place and depth").toContain("Slot 1 · front of 2");
        expect(tip, "and the card behind it").toMatch(/Behind it: Card [AB]/);
        expect(tip, "and what a press does").toContain("Click to bring it forward");

        // ── An empty slot's hover says so, and what a press there does. ──
        await app.body("L").evalJS<null>(
          `(function () {
            var el = document.querySelector('[data-testid="layout-card-target-block-2"]');
            var opts = { bubbles: true, cancelable: true, pointerType: "mouse" };
            el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false, pointerType: "mouse" }));
            el.dispatchEvent(new PointerEvent("pointermove", opts));
            return null;
          })()`,
        );
        await app.body("L").waitForCondition<boolean>(
          `(function () {
            var c = document.querySelector('.tug-tooltip-content');
            return c !== null && c.textContent.indexOf("Slot 3 is empty") >= 0;
          })()`,
          { timeoutMs: 5_000 },
        );
        note("slot 3 tip: Slot 3 is empty");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
