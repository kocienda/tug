/**
 * at0593-jot-close-holds-its-place.test.ts — opening a jot brings it into
 * view, closing it must not move the card, and an empty jot must not raise the
 * confirm.
 *
 * Opening: the open reveals the jot in the card's scroller as the well grows.
 * A jot that fits shows whole; one taller than the card puts its header row at
 * the top and the body flows underneath.
 *
 * Closing: the ascend every close performs re-reveals the key view, which
 * while the editor is open is the EDITING CELL — a cell taller than the
 * scrollport, which `revealFocusTarget` brings in by its leading edge and so
 * scrolls the card. The whole card content hopped as a result. The editor row
 * samples the card's resting scroll position and puts it back, so the jot's
 * title line stands exactly where it stood. Both close routes are covered
 * because they reach the row differently: Escape is claimed by the responder
 * chain (which ascends and stops the event before the row's own handler runs),
 * while the header ✕ calls `ascend` from the row itself.
 *
 * Closing a tall jot near the END of the list is the one place the title line
 * cannot hold: the open parked its header at the top, and once the well
 * collapses there is not enough list below it to keep that scroll, so the
 * scroller clamps. That settle is accepted, and it has to be a slide that
 * rides the collapse rather than a jump at the end of it.
 *
 * Deleting: the confirm popover guards written words, so an EMPTY jot's ✕
 * deletes outright.
 *
 * The end-of-list close and the delete run in
 * `at0593-jot-close-at-end-and-delete.test.ts`, and the deck, the jots file
 * and the gestures both files use are `jot-open-close-fixture.ts`; the split
 * keeps each file under the 20 s file budget.
 *
 * Runs against an isolated jots file (`TUG_JOTS_PATH`) so the user's
 * machine-global jots.json is never touched.
 *
 * @covers tugdeck/src/components/jots/jots-card.tsx
 * @covers tugdeck/src/components/jots/jots-card.css
 * @family at0593-jot-close
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import {
  EDITOR,
  jots,
  MID,
  OPEN_GEOMETRY,
  openCardAtTarget,
  type OpenGeometry,
  openTargetEditor,
  rowTop,
  SHOULD_RUN,
  tallJot,
  TEST_TIMEOUT_MS,
  withJots,
} from "./jot-open-close-fixture";

describe.skipIf(!SHOULD_RUN)("at0593 — opening and closing a jot", () => {
  test(
    "a jot that fits opens whole, scrolled by just enough to show it",
    async () => {
      await withJots(
        "at0593-jot-open-fits",
        MID,
        "A short jot\nsecond line\nthird line",
        async (app) => {
          await openCardAtTarget(app, MID);
          await openTargetEditor(app, MID);
          const g = await jots(app).evalJS<OpenGeometry>(OPEN_GEOMETRY);
          note(`at0593 fits: ${JSON.stringify(g)}`);
          // The row started on the port's bottom edge, so everything the open
          // added was out of view: the reveal must have scrolled, and by no
          // more than it takes to land the cell's bottom on that edge.
          expect(g.cellTop).toBeGreaterThanOrEqual(g.portTop);
          expect(g.cellBottom).toBeLessThanOrEqual(g.portBottom);
          expect(g.cellBottom).toBeGreaterThanOrEqual(g.portBottom - 1);
        },
      );
    },
    TEST_TIMEOUT_MS,
  );

  for (const route of ["Escape", "the header ✕"] as const) {
    test(
      `a tall jot opens with its header at the top, and ${route} closes it without moving its title line`,
      async () => {
        await withJots(
          `at0593-jot-close-${route === "Escape" ? "escape" : "button"}`,
          MID,
          tallJot(),
          async (app) => {
            await openCardAtTarget(app, MID);
            await openTargetEditor(app, MID);

            // Too tall to show whole, so the most of it: the header on the
            // port's top edge and the body under it to the bottom.
            const g = await jots(app).evalJS<OpenGeometry>(OPEN_GEOMETRY);
            note(`at0593 tall: ${JSON.stringify(g)}`);
            expect(Math.abs(g.cellTop - g.portTop)).toBeLessThanOrEqual(1);
            expect(g.cellBottom).toBeGreaterThan(g.portBottom);

            // The floor is FOUR rows of the editor's own measured row height
            // — `--tug-text-editor-row-height`, not `1lh`, which at this font
            // is 18px against a real row of 24px.
            expect(
              await jots(app).evalJS<number>(
                `(() => {
                   const host = document.querySelector('.jot-editor-well .tug-text-editor');
                   const row = parseFloat(
                     getComputedStyle(host).getPropertyValue('--tug-text-editor-row-height'));
                   const floor = parseFloat(
                     getComputedStyle(
                       document.querySelector('.jot-editor-well .cm-scroller')).minHeight);
                   return Math.round((floor - 16) / row);
                 })()`,
              ),
            ).toBe(4);

            const openTop = await jots(app).evalJS<number>(rowTop(MID));
            note(`at0593 ${route}: title line at ${openTop}px while open`);

            if (route === "Escape") {
              await app.nativeKey("Escape");
            } else {
              await jots(app).nativeClickAtElement('[aria-label="Close editor"]');
            }
            await jots(app).waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(EDITOR)}) === null`,
              { timeoutMs: 3_000 },
            );

            // The collapse is an animation; the title line must stand still
            // for the whole of it, not merely land back where it started.
            const closedTop = await jots(app).evalJS<number>(rowTop(MID));
            expect(closedTop).toBe(openTop);
            await new Promise((r) => setTimeout(r, 600));
            expect(await jots(app).evalJS<number>(rowTop(MID))).toBe(openTop);
          },
        );
      },
      TEST_TIMEOUT_MS,
    );
  }
});
