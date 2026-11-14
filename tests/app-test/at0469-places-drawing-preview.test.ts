/**
 * at0469-places-drawing-preview.test.ts — the deck's picture, wearing its
 * places: a preview moves the drawing, and the marks stay with the strip.
 *
 * One of the at0469-places-drawing split, a test to a file so each launch
 * fits its own budget. This file carries the preview half of claim 6;
 * `at0469-places-drawing-faces` carries the faces half. The claims the
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
        await app.body("L").waitForCondition<boolean>(
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
        const previewFacts = await app.body("L").evalJS<{
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
        await app.body("L").click(
          `[data-testid="layout-card-sidebar-jots"] [data-choice-value="right"]`,
        );
        await wait(AFTER_LAND_MS);
        await cursorOnto(app, "layout-card-width", "wide");
        await wait(400);
        const railDrawing = await app.body("L").evalJS<{
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
        const after = await app.body("L").evalJS<{ previewing: boolean; liveOpacity: string }>(
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
          await app.body("L").evalJS<boolean>(
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
});
