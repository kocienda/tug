/**
 * at0593-jot-close-holds-its-place.test.ts — closing a jot must not move the
 * card, and an empty jot must not raise the confirm.
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
 * Deleting: the confirm popover guards written words, so an EMPTY jot's ✕
 * deletes outright.
 *
 * Runs against an isolated jots file (`TUG_JOTS_PATH`) so the user's
 * machine-global jots.json is never touched.
 *
 * @covers tugdeck/src/components/jots/jots-card.tsx
 * @covers tugdeck/src/components/jots/jots-card.css
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const EDITOR = `.jots-list .jot-editor`;
/** The jot both halves act on — long enough to make the card scroll, and last
 *  enough in the list that the reveal has somewhere to scroll it to. */
const TARGET = "s38";
const TARGET_ROW = `[data-jot-id="${TARGET}"]`;

/** The target row's top in the viewport, rounded. Matches the display row and
 *  the editor's header row alike — both carry `data-jot-id`. */
const ROW_TOP = `(() => {
  const row = document.querySelector('${TARGET_ROW}');
  return row === null ? null : Math.round(row.getBoundingClientRect().top);
})()`;

function priorCardDeck() {
  return {
    cards: [
      { id: "A", componentId: "gallery-accordion", title: "Accordion", closable: true },
    ],
    panes: [
      {
        id: "pA",
        position: { x: 60, y: 60 },
        size: { width: 520, height: 420 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "pA",
    hasFocus: true,
  };
}

/** A document that overflows the card: 40 jots, the target one 31 lines long. */
function seedJots(path: string, targetText: string): void {
  const jots = [];
  for (let i = 1; i <= 40; i += 1) {
    jots.push({
      id: `s${i}`,
      text: i === 38 ? targetText : `Jot number ${i}`,
    });
  }
  writeFileSync(path, `${JSON.stringify({ version: 1, jots }, null, 2)}\n`);
}

/** Open the Jots card and bring the target row into view. */
async function openCardAtTarget(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 5_000 },
  );
  await app.dispatchControlAction("toggle-jots");
  await app.waitForCondition<boolean>(
    `document.querySelector('${TARGET_ROW}') !== null`,
    { timeoutMs: 5_000 },
  );
  await app.evalJS(
    `(() => { const c = document.querySelector('.jots-card');
              c.scrollTop = c.scrollHeight; return 1; })()`,
  );
  await app.waitForCondition<boolean>(
    `(() => { const r = document.querySelector('${TARGET_ROW}');
              return r !== null && r.getBoundingClientRect().height > 0; })()`,
    { timeoutMs: 3_000 },
  );
}

/** Select the target row and open its editor, settled at its full height. */
async function openTargetEditor(app: App): Promise<void> {
  await app.nativeClickAtElement(`${TARGET_ROW} .jot-row-label`);
  await app.waitForCondition<boolean>(
    `document.querySelector('.jots-card .jots-list[data-key-view-kbd]') !== null`,
    { timeoutMs: 3_000 },
  );
  await app.nativeKey("Return");
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(EDITOR)}) !== null`,
    { timeoutMs: 3_000 },
  );
  // The well opens on an animation; wait for it to stop growing so the
  // measurement is of the settled card, not of a frame mid-open.
  await app.waitForCondition<boolean>(
    `(() => {
       const w = document.querySelector('.jot-editor-well');
       if (w === null) return false;
       const h = Math.round(w.getBoundingClientRect().height);
       const settled = window.__at0593WellH === h;
       window.__at0593WellH = h;
       return settled && h > 0;
     })()`,
    { timeoutMs: 3_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("at0593 — closing a jot holds its place", () => {
  for (const route of ["Escape", "the header ✕"] as const) {
    test(
      `${route} closes the jot without moving its title line`,
      async () => {
        const tugbankPath = mkTempTugbank();
        const jotsDir = mkdtempSync(join(tmpdir(), "tug-at0593-"));
        const jotsPath = join(jotsDir, "jots.json");
        const body = Array.from({ length: 30 }, (_, k) => `body line ${k}`);
        seedJots(jotsPath, `Target jot title\n${body.join("\n")}`);
        try {
          seedTugbankForLaunch(tugbankPath);
          const app = await launchTugApp({
            testName: `at0593-jot-close-${route === "Escape" ? "escape" : "button"}`,
            env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
            persistInTestMode: true,
          });
          try {
            await openCardAtTarget(app);
            await openTargetEditor(app);

            // The floor is FOUR rows of the editor's own measured row height
            // — `--tug-text-editor-row-height`, not `1lh`, which at this font
            // is 18px against a real row of 24px.
            expect(
              await app.evalJS<number>(
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

            const openTop = await app.evalJS<number>(ROW_TOP);
            note(`at0593 ${route}: title line at ${openTop}px while open`);

            if (route === "Escape") {
              await app.nativeKey("Escape");
            } else {
              await app.nativeClickAtElement('[aria-label="Close editor"]');
            }
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(EDITOR)}) === null`,
              { timeoutMs: 3_000 },
            );

            // The collapse is an animation; the title line must stand still
            // for the whole of it, not merely land back where it started.
            const closedTop = await app.evalJS<number>(ROW_TOP);
            expect(closedTop).toBe(openTop);
            await new Promise((r) => setTimeout(r, 600));
            expect(await app.evalJS<number>(ROW_TOP)).toBe(openTop);
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
  }

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
          await app.waitForCondition<boolean>(
            `document.querySelector('[data-jot-id="e1"]') !== null`,
            { timeoutMs: 5_000 },
          );

          // The empty jot: its ✕ takes it away with no question asked.
          await app.nativeClickAtElement('[data-jot-id="e1"] .jot-row-delete');
          await app.waitForCondition<boolean>(
            `document.querySelector('[data-jot-id="e1"]') === null`,
            { timeoutMs: 3_000 },
          );
          expect(
            await app.evalJS<boolean>(
              `document.querySelector('[data-slot="tug-confirm-popover"]') !== null`,
            ),
          ).toBe(false);

          // The written one still does — the guard is over words, not rows.
          await app.nativeClickAtElement('[data-jot-id="w1"] .jot-row-delete');
          await app.waitForCondition<boolean>(
            `Array.from(document.querySelectorAll('*'))
               .some((el) => el.textContent === 'Delete this jot?')`,
            { timeoutMs: 3_000 },
          );
          expect(
            await app.evalJS<boolean>(
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
