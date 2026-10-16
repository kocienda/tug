/**
 * at0469-places-drawing.test.ts — the deck's picture, wearing its places: the drawing.
 *
 * The Layout section draws the deck at scale and now marks every arrangeable
 * place on that drawing: a slot's mark says whether the slot is stacked or
 * split, a side's mark says the same for its rail. What makes the marks worth
 * having — and what this file is for — is that they read the STORED
 * arrangement rather than the drawn one.
 *
 * The two come apart at exactly one card. Membership churn preserves an
 * arrangement (`columnDrawsSplit` in `deck-store-selectors.ts`), so a slot set
 * to split and standing one card deep renders as one undivided card. Before the
 * overlay that stored split was invisible on every surface and unreachable from
 * the Layout card, because the section's column rows were gated on `members.length > 1`
 * — so it sat there until a second card arrived and it resurfaced as a surprise.
 *
 *   1. **Every slot the kind defines is marked**, occupied or not, and each
 *      mark says that slot's own stored arrangement.
 *   2. **A one-card split is visible**, drawn split: the arrangement is real,
 *      there is just nothing standing under it yet.
 *   3. **The marks stand under the places they name.** They live in a row
 *      beneath the numbered strip, one under each number, and each stands
 *      within its block's span — the drawing's blocks wear their cards'
 *      faces, so the marks left the drawing for the legend.
 *   4. **A rail is a place too**, and wears the same vocabulary.
 *   5. **A mark is a button.** It answers a hand and does not audition, and
 *      every mark rests at one weight — the picture states arrangements, not
 *      how many cards stand under them.
 *   6. **Every block wears its card's face, and hovering one names the card.**
 *      A stack shows its sheets behind the front card; the hover says what the
 *      card is called, where it stands, what is behind it, and what a press
 *      does.
 *   7. **A place wears ONE mark, and the note says which thing scrolls.** The
 *      mark says stack or split and nothing more — the layout glyph it wore
 *      for a while is gone — and a rail put on flow through its mixer row
 *      draws as a strip in the miniature while the plan's note names the rail
 *      as the thing that scrolls.
 *   8. **A place's arrangement is a row in the mixer**, `Stack | Fit | Flow`
 *      per rail side and per slot with something to arrange. Stack writes the
 *      mode alone and the layout is remembered; Fit and Flow write the mode
 *      and the layout together. A rail row is disabled, never absent, while
 *      its side holds fewer than two cards; a column row is absent, never
 *      disabled, while its slot does.
 *
 * Read from live `getBoundingClientRect()` and `data-` attributes. Nothing here
 * reads back a declared style value.
 *
 * Cut from `at0469-layout-places` to fit the 20 s budget. This file carries
 * claim 6 (a preview moves the drawing, and every block wears its card's
 * face); `at0469-places-marks` carries claims 1–3 and 5,
 * `at0469-places-sidebar-rows` claim 4, and `at0469-places-arrangement`
 * claims 7 and 8. The deck and the readers are `layout-places-fixture.ts`.
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
  PLACES,
  RAIL_WIDTH,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  TOGGLES,
  cursorOffTheRows,
  cursorOnto,
  deckShape,
  hover,
  wait,
} from "./layout-places-fixture";

describe.skipIf(!SHOULD_RUN)("at0469 — the drawing wears its places: the drawing", () => {
  test(
    "a preview moves the drawing, and the marks stay with the strip",
    async () => {
      const app = await launchTugApp();
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('${PLACES}') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        // ── A row's preview moves the drawing; the marks stay put. ──
        //
        // The rows audition under the KEYBOARD cursor. A preview swaps the
        // drawing for the auditioned arrangement, and nothing on that drawing
        // is a mark any more — the stack/split toggles stand in a row under the
        // numbered strip, which states the deck as it IS, so they keep their
        // committed places and their committed answers through any preview.
        // The ghost copy of the marks that once rode each preview layer is
        // gone with the marks it copied.
        await cursorOnto(app, "layout-card-width", "wide");
        await wait(400);
        const previewFacts = await app.evalJS<{
          layerId: string | null;
          ghosts: number;
          marksOnLayer: number;
          liveMode: string | null;
          liveOpacity: string;
        }>(
          `(function () {
            var layer = document.querySelector('.layouts-plan-layer[data-plan-active]');
            var live = document.querySelector('${TOGGLES} .layout-places-mark[data-place="col-1"]');
            return {
              layerId: layer === null ? null : layer.getAttribute("data-plan-preview-id"),
              ghosts: document.querySelectorAll('[data-testid="layout-card-places-ghost"]').length,
              marksOnLayer: layer === null ? -1 : layer.querySelectorAll('.layout-places-mark').length,
              liveMode: live === null ? null : live.getAttribute("data-mode"),
              liveOpacity: live === null ? "" : getComputedStyle(live).opacity,
            };
          })()`,
        );
        expect(previewFacts.layerId, "the width preview is showing").toBe("width:wide");
        expect(previewFacts.ghosts, "no ghost overlay rides any layer").toBe(0);
        expect(
          previewFacts.marksOnLayer,
          "the previewed drawing carries no marks",
        ).toBe(0);
        expect(
          previewFacts.liveMode,
          "the toggle row keeps stating slot 1's stored split through the preview",
        ).toBe("split");
        expect(
          Number(previewFacts.liveOpacity),
          "and keeps standing at full weight",
        ).toBe(1);
        note(
          `width preview: ${previewFacts.marksOnLayer} marks on the layer, toggle col-1 ${previewFacts.liveMode}`,
        );

        // ── A rail is drawn divided, in the committed layer and every
        //    proposal alike. ──
        //
        // There is one picture for a rail now ([B01]): a member per card the
        // side holds, in both layers, so a preview cannot make the side look
        // like a different kind of place.
        await app.click(
          `[data-testid="layout-card-sidebar-jots"] [data-choice-value="right"]`,
        );
        await wait(AFTER_LAND_MS);
        await cursorOnto(app, "layout-card-width", "wide");
        await wait(400);
        const railDrawing = await app.evalJS<{
          committed: number;
          preview: number;
        }>(
          `(function () {
            var count = function (scope) {
              var layer = document.querySelector(scope);
              return layer === null
                ? -1
                : layer.querySelectorAll('.layout-mini-rail .layout-mini-rail-member').length;
            };
            return {
              committed: count('.layouts-plan-layer[data-plan-layer="committed"]'),
              preview: count('.layouts-plan-layer[data-plan-active]'),
            };
          })()`,
        );
        note(
          `rail members: committed ${railDrawing.committed}, preview ${railDrawing.preview}`,
        );
        expect(
          railDrawing.committed,
          "the committed drawing divides the side between its two cards",
        ).toBe(2);
        expect(
          railDrawing.preview,
          "and so does the proposal — a rail has one picture",
        ).toBe(2);

        // ── Taking the cursor off the rows clears the preview. ──
        //
        // The audition raised for the silhouette count is still standing, so
        // this reads the drop rather than staging one.
        await cursorOffTheRows(app);
        await wait(400);
        const after = await app.evalJS<{ previewing: boolean; liveOpacity: string }>(
          `(function () {
            var plan = document.querySelector('[data-testid="layout-card-plan"]');
            var live = document.querySelector('${TOGGLES} .layout-places-mark[data-place="col-0"]');
            return {
              previewing: plan !== null && plan.hasAttribute("data-previewing"),
              liveOpacity: live === null ? "" : getComputedStyle(live).opacity,
            };
          })()`,
        );
        expect(after.previewing, "the preview cleared").toBe(false);
        expect(
          Number(after.liveOpacity),
          "and the toggles stand as they did",
        ).toBe(1);

        // ── A POINTER auditions nothing, wherever it rests. ──
        //
        // A hover once raised the segment's layer, on an intent clock meant to
        // keep a pointer crossing the rows from strobing the picture. The clock
        // could not fix what was under it: a hand travelling to the control it
        // means to press passes over three or four others on the way, and the
        // drawing answered every one — the section's largest element restating
        // itself while the reader was only moving their hand. So the pointer
        // states nothing and presses instead, and this is the claim that keeps
        // it that way. Rest on a segment for longer than any clock and read.
        await hover(
          app,
          `[data-testid="layout-card-width"] [data-choice-value="wide"]`,
        );
        await wait(600);
        expect(
          await app.evalJS<boolean>(
            `document.querySelector('[data-testid="layout-card-plan"]').hasAttribute("data-previewing")`,
          ),
          "a pointer resting on a segment does not swap the drawing",
        ).toBe(false);
        note("pointer rests on a segment: the drawing does not move");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "every block wears its card's face, and hovering one names the card",
    async () => {
      const app = await launchTugApp();
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
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
        const faces = await app.evalJS<{
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
        await app.evalJS<null>(
          `(function () {
            var el = document.querySelector('[data-testid="layout-card-target-block-0"]');
            var opts = { bubbles: true, cancelable: true, pointerType: "mouse" };
            el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false, pointerType: "mouse" }));
            el.dispatchEvent(new PointerEvent("pointermove", opts));
            return null;
          })()`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="layout-card-tip"]') !== null`,
          { timeoutMs: 5_000 },
        );
        const tip = await app.getElementText('[data-testid="layout-card-tip"]');
        note(`slot 1 tip: ${tip.replace(/\s+/g, " ")}`);
        expect(tip, "the tip names the front card").toMatch(/Card [AB]/);
        expect(tip, "and its place and depth").toContain("Slot 1 · front of 2");
        expect(tip, "and the card behind it").toMatch(/Behind it: Card [AB]/);
        expect(tip, "and what a press does").toContain("Click to bring it forward");

        // ── An empty slot's hover says so, and what a press there does. ──
        await app.evalJS<null>(
          `(function () {
            var el = document.querySelector('[data-testid="layout-card-target-block-2"]');
            var opts = { bubbles: true, cancelable: true, pointerType: "mouse" };
            el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false, pointerType: "mouse" }));
            el.dispatchEvent(new PointerEvent("pointermove", opts));
            return null;
          })()`,
        );
        await app.waitForCondition<boolean>(
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
