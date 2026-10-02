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
/** A target with the whole list's worth of rows below it — the card can
 *  always hold its header at the top, open or closed. */
const MID = "s60";
/** A target two rows from the end — the card cannot hold its header at the
 *  top once the jot closes. */
const END = "s148";

const rowSel = (id: string): string => `[data-jot-id="${id}"]`;

/** The target row's top in the viewport, rounded. Matches the display row and
 *  the editor's header row alike — both carry `data-jot-id`. */
const rowTop = (id: string): string => `(() => {
  const row = document.querySelector('${rowSel(id)}');
  return row === null ? null : Math.round(row.getBoundingClientRect().top);
})()`;

/** The card's scrollport and the open jot's cell, rounded viewport pixels. */
interface OpenGeometry {
  portTop: number;
  portBottom: number;
  cellTop: number;
  cellBottom: number;
}
const OPEN_GEOMETRY = `(() => {
  const c = document.querySelector('.jots-card');
  const cell = document.querySelector(${JSON.stringify(EDITOR)});
  if (c === null || cell === null) return null;
  const portTop = c.getBoundingClientRect().top + c.clientTop;
  const r = cell.getBoundingClientRect();
  return {
    portTop: Math.round(portTop),
    portBottom: Math.round(portTop + c.clientHeight),
    cellTop: Math.round(r.top),
    cellBottom: Math.round(r.bottom),
  };
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

/** A document that overflows the card: 150 jots, the target carrying `text`.
 *  The harness rail stands well over a thousand pixels tall, so it takes this
 *  many before the card has anything to scroll. */
function seedJots(path: string, target: string, targetText: string): void {
  const jots = [];
  for (let i = 1; i <= 150; i += 1) {
    jots.push({
      id: `s${i}`,
      text: `s${i}` === target ? targetText : `Jot number ${i}`,
    });
  }
  writeFileSync(path, `${JSON.stringify({ version: 1, jots }, null, 2)}\n`);
}

/**
 * Wait until the Jots sidebar has finished sliding in: its left edge has
 * stopped moving between polls and the whole card stands inside the viewport.
 * The rows exist from the first frame of that slide, so waiting on a row is
 * not waiting on the card, and a native click posted while it is still
 * travelling is aimed at a viewport coordinate outside the web view — which
 * the harness refuses outright.
 */
async function settleSidebar(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `(() => {
       const c = document.querySelector('.jots-card');
       if (c === null) return false;
       const box = c.getBoundingClientRect();
       const x = Math.round(box.left);
       const settled = window.__jotsCardX === x && box.right <= window.innerWidth;
       window.__jotsCardX = x;
       return settled;
     })()`,
    { timeoutMs: 5_000 },
  );
}

/**
 * Open the Jots card and park the target row on the BOTTOM edge of the
 * scrollport — in view to be clicked, with everything the open adds below it
 * out of view, so the open has to scroll to show any of it.
 */
async function openCardAtTarget(app: App, id: string): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 5_000 },
  );
  await app.dispatchControlAction("toggle-jots");
  await app.waitForCondition<boolean>(
    `document.querySelector('${rowSel(id)}') !== null`,
    { timeoutMs: 5_000 },
  );
  await settleSidebar(app);
  await app.evalJS(
    `(() => { const c = document.querySelector('.jots-card');
              const r = document.querySelector('${rowSel(id)}');
              const portBottom =
                c.getBoundingClientRect().top + c.clientTop + c.clientHeight;
              c.scrollTop += r.getBoundingClientRect().bottom - portBottom;
              return 1; })()`,
  );
  await app.waitForCondition<boolean>(
    `(() => { const r = document.querySelector('${rowSel(id)}');
              return r !== null && r.getBoundingClientRect().height > 0; })()`,
    { timeoutMs: 3_000 },
  );
}

/** Select the target row and open its editor, settled at its full height. */
async function openTargetEditor(app: App, id: string): Promise<void> {
  await app.nativeClickAtElement(`${rowSel(id)} .jot-row-label`);
  await app.waitForCondition<boolean>(
    `document.querySelector('.jots-card .jots-list[data-key-view-kbd]') !== null`,
    { timeoutMs: 3_000 },
  );
  await app.nativeKey("Return");
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(EDITOR)}) !== null`,
    { timeoutMs: 3_000 },
  );
  // The well opens on an animation, and the card's scroll rides it; wait for
  // both to stop moving so the measurement is of the settled card, not of a
  // frame mid-open.
  await app.waitForCondition<boolean>(
    `(() => {
       const w = document.querySelector('.jot-editor-well');
       const c = document.querySelector('.jots-card');
       if (w === null || c === null) return false;
       const h = Math.round(w.getBoundingClientRect().height);
       const key = h + ':' + Math.round(c.scrollTop);
       const settled = window.__at0593Open === key;
       window.__at0593Open = key;
       return settled && h > 0;
     })()`,
    { timeoutMs: 3_000 },
  );
}

/** A hundred body lines under a title — taller than the harness's card. */
function tallJot(): string {
  const body = Array.from({ length: 100 }, (_, k) => `body line ${k}`);
  return `Target jot title\n${body.join("\n")}`;
}

/** Launch against an isolated jots file whose `target` carries `text`. */
async function withJots(
  testName: string,
  target: string,
  text: string,
  run: (app: App) => Promise<void>,
): Promise<void> {
  const tugbankPath = mkTempTugbank();
  const jotsDir = mkdtempSync(join(tmpdir(), "tug-at0593-"));
  const jotsPath = join(jotsDir, "jots.json");
  seedJots(jotsPath, target, text);
  try {
    seedTugbankForLaunch(tugbankPath);
    const app = await launchTugApp({
      testName,
      env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
      persistInTestMode: true,
    });
    try {
      await run(app);
    } finally {
      await app.close();
    }
  } finally {
    rmSync(jotsDir, { recursive: true, force: true });
    rmTempTugbank(tugbankPath);
  }
}

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
          const g = await app.evalJS<OpenGeometry>(OPEN_GEOMETRY);
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
            const g = await app.evalJS<OpenGeometry>(OPEN_GEOMETRY);
            note(`at0593 tall: ${JSON.stringify(g)}`);
            expect(Math.abs(g.cellTop - g.portTop)).toBeLessThanOrEqual(1);
            expect(g.cellBottom).toBeGreaterThan(g.portBottom);

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

            const openTop = await app.evalJS<number>(rowTop(MID));
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
            const closedTop = await app.evalJS<number>(rowTop(MID));
            expect(closedTop).toBe(openTop);
            await new Promise((r) => setTimeout(r, 600));
            expect(await app.evalJS<number>(rowTop(MID))).toBe(openTop);
          },
        );
      },
      TEST_TIMEOUT_MS,
    );
  }

  test(
    "a tall jot at the end of the list slides back as it closes, never jumps",
    async () => {
      await withJots("at0593-jot-close-end", END, tallJot(), async (app) => {
        await openCardAtTarget(app, END);
        await openTargetEditor(app, END);
        const g = await app.evalJS<OpenGeometry>(OPEN_GEOMETRY);
        expect(Math.abs(g.cellTop - g.portTop)).toBeLessThanOrEqual(1);
        const openTop = await app.evalJS<number>(rowTop(END));

        // Sample the title line every frame from before the gesture until
        // well after the editor is gone — a jump is one frame's story, so
        // nothing coarser than a frame can tell it from a slide.
        await app.evalJS(
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
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(EDITOR)}) === null`,
          { timeoutMs: 3_000 },
        );
        await new Promise((r) => setTimeout(r, 600));
        const tops = await app.evalJS<number[]>(`window.__at0593Tops`);
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
          await app.waitForCondition<boolean>(
            `document.querySelector('[data-jot-id="e1"]') !== null`,
            { timeoutMs: 5_000 },
          );

          await settleSidebar(app);

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
