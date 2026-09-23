/**
 * at0615-jot-row-menu.test.ts — a jot row answers a right-click with the jot's
 * own text verbs, and Copy and Paste really move the text.
 *
 * ## What this gates
 *
 * Jots is the one surface in the suite made entirely of kept text, and until
 * this it was the one surface with no text verbs on it: a right-click anywhere
 * on a row fell through to the app's "No Actions" ([D132] — the same hole
 * at0432 closed on a commit row). The row's hover-reveal Copy was the only
 * clipboard door, and there was no door at all for putting text back.
 *
 * So the press under test lands on a display row's ground, and what has to come
 * back is the whole jot menu — Edit, the four standard clipboard verbs, New and
 * Delete — with Cut / Copy / Copy as Plain Text live on a written jot. Then two
 * of them are taken all the way through the real gesture, because a menu that
 * LISTS a copy and a copy that HAPPENS are two different facts:
 *
 *  - **Copy** has to reach the pasteboard with the jot's whole text, not its
 *    incipit — the row shows one line and the jot is three.
 *  - **Paste** has to REPLACE the jot it landed on. That is the answered shape
 *    of the verb here (a jot is a slot the user keeps something in), and it is
 *    the half that would rot silently: a paste that appended, or that landed on
 *    the wrong row, still looks like "paste worked" in a screenshot.
 *
 * The second test is the empty-row case. A jot with nothing written in it has
 * nothing to take out of it, so the three copies dim rather than vanish — the
 * menu is the same height over every row, and the reader is told the verb
 * exists. Paste stays live: an empty jot is exactly the one worth filling.
 * It then takes Delete and New Jot through the real gesture too: Delete has to
 * find the row's ✕ column to anchor its confirm on, a lookup that goes silent
 * rather than loud when it misses, and New Jot has to land BELOW the row it was
 * asked from rather than at the end of the list.
 *
 * Runs against an isolated jots file (`TUG_JOTS_PATH`) so the user's
 * machine-global jots.json is never touched.
 *
 * @covers tugdeck/src/components/jots/jot-row-menu.tsx
 * @covers tugdeck/src/components/jots/jots-card.tsx
 * @covers tugdeck/src/components/jots/jots-card.css
 * @covers tugdeck/src/components/tugways/action-vocabulary.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const MENU = '[data-slot="tug-editor-context-menu"]';

/** The written jot under test — three lines, so the row's one-line incipit and
 *  the jot's text are visibly different strings. */
const WRITTEN = "s2";
const WRITTEN_TEXT = "the second jot\nwith a *middle* line\nand a last one";
/** The blank jot, for the dim half. */
const BLANK = "s3";

const rowOf = (id: string): string => `[data-jot-id="${id}"]`;

/** Distinguishes "the copy wrote this" from "the copy never happened". */
const SENTINEL = "at0615-sentinel-nothing-copied";
/** What the Paste half puts on the pasteboard and expects to find in the jot. */
const PASTED = "at0615 pasted over the top";

function setPasteboard(text: string): void {
  Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(text) });
}

function readPasteboard(): string {
  return Bun.spawnSync(["pbpaste"]).stdout.toString();
}

/** Every row of the open menu, in the order it renders. */
function menuRows(): string {
  return `Array.prototype.map.call(
     document.querySelectorAll(${JSON.stringify(MENU)} + ' [role="menuitem"]'),
     function (item) {
       return {
         action: item.getAttribute("data-item-action") || "",
         label: (item.querySelector(".tug-menu-item-label") || item).textContent || "",
         disabled: item.getAttribute("aria-disabled") === "true",
       };
     })`;
}

function priorCardDeck() {
  return {
    cards: [
      {
        id: "A",
        componentId: "gallery-accordion",
        title: "Accordion",
        closable: true,
      },
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

/** Three jots: one written, one blank, and a neighbour a misdirected Paste
 *  would land on. */
function seedJots(path: string): void {
  const jots = [
    { id: "s1", text: "the first jot" },
    { id: WRITTEN, text: WRITTEN_TEXT },
    { id: BLANK, text: "" },
  ];
  writeFileSync(path, `${JSON.stringify({ version: 1, jots }, null, 2)}\n`);
}

/** The document as it stands on disk right now. */
function readJots(path: string): ReadonlyArray<{ id: string; text: string }> {
  return JSON.parse(readFileSync(path, "utf8")).jots;
}

async function openJotsCard(app: App): Promise<void> {
  await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 5_000 },
  );
  await app.dispatchControlAction("toggle-jots");
  await app.waitForCondition<boolean>(
    `document.querySelector('${rowOf(WRITTEN)}') !== null`,
    { timeoutMs: 5_000 },
  );
}

/** Right-click the row's LABEL — its ground, not an accessory — and wait for
 *  the menu. */
async function openRowMenu(app: App, id: string): Promise<void> {
  await app.nativeRightClickAtElement(`${rowOf(id)} .jot-row-label`);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(MENU)}) !== null`,
    { timeoutMs: 8_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("at0615 — the jot row's own menu", () => {
  test(
    "the row's ground answers with the jot's verbs, and Copy and Paste move the text",
    async () => {
      const tugbankPath = mkTempTugbank();
      const jotsDir = mkdtempSync(join(tmpdir(), "tug-at0615-"));
      const jotsPath = join(jotsDir, "jots.json");
      seedJots(jotsPath);
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0615-jot-row-menu",
          env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
          persistInTestMode: true,
        });
        try {
          await openJotsCard(app);
          await openRowMenu(app, WRITTEN);

          // Nothing else answered the same press — no stack of menus, and no
          // fallback "No Actions" underneath.
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll('.tug-menu-content').length`,
            ),
          ).toBe(1);

          const rows = await app.evalJS<
            ReadonlyArray<{ action: string; label: string; disabled: boolean }>
          >(menuRows());
          note("at0615 menu", JSON.stringify(rows));
          expect(rows.map((r) => r.action)).toEqual([
            "edit-jot",
            "cut",
            "copy",
            "copy-as-plain-text",
            "paste",
            "new-jot-below",
            "delete-jot",
          ]);
          // The clipboard verbs keep their standard words, because they mean
          // here what they mean on every other text surface.
          expect(rows.map((r) => r.label)).toEqual([
            "Edit Jot",
            "Cut",
            "Copy",
            "Copy as Plain Text",
            "Paste",
            "New Jot",
            "Delete Jot",
          ]);
          // A written jot has something behind every one of them.
          expect(rows.every((r) => !r.disabled)).toBe(true);

          // ---- Copy carries the WHOLE jot, not the row's incipit. ---------
          setPasteboard(SENTINEL);
          await app.nativeClickAtElement(`${MENU} [data-item-action="copy"]`);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(MENU)}) === null`,
            { timeoutMs: 8_000 },
          );
          // The write lands asynchronously — the handler runs inside the item's
          // mousedown and the clipboard promise settles after it.
          let pasted = readPasteboard();
          for (let tries = 0; tries < 20 && pasted !== WRITTEN_TEXT; tries += 1) {
            await new Promise((r) => setTimeout(r, 200));
            pasted = readPasteboard();
          }
          expect(pasted).toBe(WRITTEN_TEXT);

          // ---- Paste REPLACES the jot it landed on. ----------------------
          setPasteboard(PASTED);
          await openRowMenu(app, WRITTEN);
          await app.nativeClickAtElement(`${MENU} [data-item-action="paste"]`);
          await app.waitForCondition<boolean>(
            `(() => {
               const row = document.querySelector('${rowOf(WRITTEN)}');
               return row !== null &&
                 (row.textContent || '').indexOf(${JSON.stringify(PASTED)}) >= 0;
             })()`,
            { timeoutMs: 8_000 },
          );

          // …and the document on disk agrees: the target replaced, its
          // neighbours untouched. A paste that appended, or that landed on the
          // wrong row, fails here and only here.
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(MENU)}) === null`,
            { timeoutMs: 8_000 },
          );
          let doc = readJots(jotsPath);
          for (
            let tries = 0;
            tries < 30 && doc.find((j) => j.id === WRITTEN)?.text !== PASTED;
            tries += 1
          ) {
            await new Promise((r) => setTimeout(r, 200));
            doc = readJots(jotsPath);
          }
          note("at0615 jots.json", JSON.stringify(doc));
          expect(doc.map((j) => j.text)).toEqual([
            "the first jot",
            PASTED,
            "",
          ]);
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

  test(
    "an empty jot dims the three copies, and Delete and New Jot land",
    async () => {
      const tugbankPath = mkTempTugbank();
      const jotsDir = mkdtempSync(join(tmpdir(), "tug-at0615b-"));
      const jotsPath = join(jotsDir, "jots.json");
      seedJots(jotsPath);
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0615b-jot-row-menu-empty",
          env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
          persistInTestMode: true,
        });
        try {
          await openJotsCard(app);
          await openRowMenu(app, BLANK);

          const rows = await app.evalJS<
            ReadonlyArray<{ action: string; disabled: boolean }>
          >(menuRows());
          note("at0615b menu", JSON.stringify(rows));
          const off = new Map(rows.map((r) => [r.action, r.disabled]));
          // Dim, not gone: the menu is the same height over every row.
          expect(off.get("cut")).toBe(true);
          expect(off.get("copy")).toBe(true);
          expect(off.get("copy-as-plain-text")).toBe(true);
          // Everything that puts something INTO the jot stays live — an empty
          // jot is the one most worth filling.
          expect(off.get("paste")).toBe(false);
          expect(off.get("edit-jot")).toBe(false);
          expect(off.get("new-jot-below")).toBe(false);
          expect(off.get("delete-jot")).toBe(false);

          // ---- Delete goes the ✕'s own route. ----------------------------
          // The confirm is anchored to the row's ✕ COLUMN, which the menu has
          // to find from the row rather than from the press — a lookup that
          // fails silently if it fails at all, which is why it is pinned here.
          // An EMPTY jot has no written words to guard, so this one deletes
          // outright: `requestDeleteJot`'s carve-out, reached through the menu.
          await app.nativeClickAtElement(
            `${MENU} [data-item-action="delete-jot"]`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelector('${rowOf(BLANK)}') === null`,
            { timeoutMs: 8_000 },
          );

          // ---- New Jot lands BELOW the row it was asked from. -------------
          await openRowMenu(app, "s1");
          await app.nativeClickAtElement(
            `${MENU} [data-item-action="new-jot-below"]`,
          );
          // The new jot opens for editing, which is the gesture's whole point.
          await app.waitForCondition<boolean>(
            `document.querySelector('.jots-list .jot-editor') !== null`,
            { timeoutMs: 8_000 },
          );
          const order = await app.evalJS<ReadonlyArray<string>>(
            `Array.prototype.map.call(
               document.querySelectorAll('.jots-list [data-jot-id]'),
               function (r) { return r.getAttribute('data-jot-id'); })`,
          );
          note("at0615b rows after New Jot", JSON.stringify(order));
          expect(order.length).toBe(3);
          expect(order[0]).toBe("s1");
          // Second, not appended: "below THIS one" is the verb's whole claim.
          expect(order[2]).toBe(WRITTEN);
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
