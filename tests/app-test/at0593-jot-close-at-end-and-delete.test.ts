/**
 * at0593-jot-close-at-end-and-delete.test.ts — the second half of at0593,
 * whose first half and claim are `at0593-jot-close-holds-its-place.test.ts`.
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
 * The deck, the isolated jots file and the gestures are
 * `jot-open-close-fixture.ts`; the split keeps each file under the 20 s file
 * budget.
 *
 * @covers tugdeck/src/components/jots/jots-card.tsx
 * @covers tugdeck/src/components/jots/jots-card.css
 * @family at0593-jot-close
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "./_harness";
import { priorCardDeck } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  EDITOR,
  END,
  jots,
  OPEN_GEOMETRY,
  openCardAtTarget,
  type OpenGeometry,
  openTargetEditor,
  rowSel,
  rowTop,
  settleSidebar,
  SHOULD_RUN,
  tallJot,
  TEST_TIMEOUT_MS,
  withJots,
} from "./jot-open-close-fixture";

describe.skipIf(!SHOULD_RUN)("at0593 — opening and closing a jot", () => {
  test(
    "a tall jot at the end of the list slides back as it closes, never jumps",
    async () => {
      await withJots("at0593-jot-close-end", END, tallJot(), async (app) => {
        await openCardAtTarget(app, END);
        await openTargetEditor(app, END);
        const g = await jots(app).evalJS<OpenGeometry>(OPEN_GEOMETRY);
        expect(Math.abs(g.cellTop - g.portTop)).toBeLessThanOrEqual(1);
        const openTop = await jots(app).evalJS<number>(rowTop(END));

        // Sample the title line every frame from before the gesture until
        // well after the editor is gone — a jump is one frame's story, so
        // nothing coarser than a frame can tell it from a slide.
        await jots(app).evalJS(
          `(() => {
             const tops = [];
             window.__at0593Tops = tops;
             let after = 0;
             const tick = () => {
               const r = document.querySelector('${rowSel(END)}');
               if (r !== null) tops.push(r.getBoundingClientRect().top);
               if (document.querySelector(${JSON.stringify(EDITOR)}) === null) after += 1;
               if (after < 20) requestAnimationFrame(tick);
             };
             requestAnimationFrame(tick);
             return 1;
           })()`,
        );
        await app.nativeKey("Escape");
        await jots(app).waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(EDITOR)}) === null`,
          { timeoutMs: 3_000 },
        );
        await new Promise((r) => setTimeout(r, 600));
        const tops = await jots(app).evalJS<number[]>(`window.__at0593Tops`);
        const steps = tops.slice(1).map((t, i) => t - tops[i]);
        const moving = steps.filter((s) => s > 0.5).length;
        const finalTop = tops[tops.length - 1];
        note(
          `at0593 end: ${openTop}px → ${Math.round(finalTop)}px over ` +
            `${moving} moving frame(s) of ${tops.length}`,
        );
        // The list settles back (the scroller had to clamp)…
        expect(finalTop).toBeGreaterThan(openTop);
        // …only ever downward, the way the collapse pulls it…
        expect(Math.min(...steps)).toBeGreaterThanOrEqual(-0.5);
        // …and spread across the collapse rather than landing in one frame.
        expect(moving).toBeGreaterThanOrEqual(2);
        expect(Math.max(...steps)).toBeLessThan(finalTop - openTop);
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an empty jot's ✕ deletes it outright; a written one still asks",
    async () => {
      const tugbankPath = mkTempTugbank();
      const jotsDir = mkdtempSync(join(tmpdir(), "tug-at0593c-"));
      const jotsPath = join(jotsDir, "jots.json");
      writeFileSync(
        jotsPath,
        `${JSON.stringify(
          {
            version: 1,
            jots: [
              { id: "e1", text: "" },
              { id: "w1", text: "There is a tide" },
            ],
          },
          null,
          2,
        )}\n`,
      );
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0593-jot-empty-delete",
          env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
          persistInTestMode: true,
        });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );
          await app.dispatchControlAction("toggle-jots");
          await jots(app).waitForCondition<boolean>(
            `document.querySelector('[data-jot-id="e1"]') !== null`,
            { timeoutMs: 5_000 },
          );

          await settleSidebar(app);

          // The empty jot: its ✕ takes it away with no question asked.
          await jots(app).nativeClickAtElement('[data-jot-id="e1"] .jot-row-delete');
          await jots(app).waitForCondition<boolean>(
            `document.querySelector('[data-jot-id="e1"]') === null`,
            { timeoutMs: 3_000 },
          );
          expect(
            await jots(app).evalJS<boolean>(
              `document.querySelector('[data-slot="tug-confirm-popover"]') !== null`,
            ),
          ).toBe(false);

          // The written one still does — the guard is over words, not rows.
          await jots(app).nativeClickAtElement('[data-jot-id="w1"] .jot-row-delete');
          await jots(app).waitForCondition<boolean>(
            `Array.from(document.querySelectorAll('*'))
               .some((el) => el.textContent === 'Delete this jot?')`,
            { timeoutMs: 3_000 },
          );
          expect(
            await jots(app).evalJS<boolean>(
              `document.querySelector('[data-jot-id="w1"]') !== null`,
            ),
          ).toBe(true);
        } finally {
          await app.close();
        }
      } finally {
        rmSync(jotsDir, { recursive: true, force: true });
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
