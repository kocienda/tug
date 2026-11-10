/**
 * jot-open-close-fixture.ts — what the two halves of at0593 share: an isolated
 * jots file (`TUG_JOTS_PATH`, so the user's machine-global jots.json is never
 * touched), the deck that shows it, and the gestures and geometry reads that
 * open a jot and close it. The cases and the claim they make are in
 * `at0593-jot-close-holds-its-place.test.ts` (opening, and the two close
 * routes) and `at0593-jot-close-at-end-and-delete.test.ts` (closing at the
 * list's end, and deleting an empty jot), split so neither file crosses the
 * 20 s file budget.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, type App } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import { priorCardDeck } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 60_000;

export const EDITOR = `.jots-list .jot-editor`;
/** A target with the whole list's worth of rows below it — the card can
 *  always hold its header at the top, open or closed. */
export const MID = "s60";
/** A target two rows from the end — the card cannot hold its header at the
 *  top once the jot closes. */
export const END = "s148";

export const rowSel = (id: string): string => `[data-jot-id="${id}"]`;

/** The Jots card's own page, where its rows and editor stand. */
export const jots = (app: App) => kindBody(app, "jots");

/** The target row's top in the viewport, rounded. Matches the display row and
 *  the editor's header row alike — both carry `data-jot-id`. */
export const rowTop = (id: string): string => `(() => {
  const row = document.querySelector('${rowSel(id)}');
  return row === null ? null : Math.round(row.getBoundingClientRect().top);
})()`;

/** The card's scrollport and the open jot's cell, rounded viewport pixels. */
export interface OpenGeometry {
  portTop: number;
  portBottom: number;
  cellTop: number;
  cellBottom: number;
}
export const OPEN_GEOMETRY = `(() => {
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

/** A document that overflows the card: 150 jots, the target carrying `text`.
 *  The harness rail stands well over a thousand pixels tall, so it takes this
 *  many before the card has anything to scroll. */
export function seedJots(path: string, target: string, targetText: string): void {
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
 * Wait until the Jots sidebar has finished sliding in: its rail pane's left
 * edge has stopped moving between polls and the whole pane stands inside the
 * window. The card is a body the host places over that pane. The rows exist from the first frame of that slide, so waiting on a
 * row is not waiting on the card, and a native click posted while it is still
 * travelling is aimed at a point the card has not reached.
 */
export async function settleSidebar(app: App): Promise<void> {
  // card-dom: shell — the rail pane the host places the card's body over.
  await app.waitForCondition<boolean>(
    `(() => {
       const pane = document.querySelector('.tug-pane[data-rail-side="left"]');
       if (pane === null) return false;
       const box = pane.getBoundingClientRect();
       const x = Math.round(box.left);
       const settled = window.__jotsPaneX === x && box.left >= 0;
       window.__jotsPaneX = x;
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
export async function openCardAtTarget(app: App, id: string): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 5_000 },
  );
  await app.dispatchControlAction("toggle-jots");
  await jots(app).waitForCondition<boolean>(
    `document.querySelector('${rowSel(id)}') !== null`,
    { timeoutMs: 5_000 },
  );
  await settleSidebar(app);
  await jots(app).evalJS(
    `(() => { const c = document.querySelector('.jots-card');
              const r = document.querySelector('${rowSel(id)}');
              const portBottom =
                c.getBoundingClientRect().top + c.clientTop + c.clientHeight;
              c.scrollTop += r.getBoundingClientRect().bottom - portBottom;
              return 1; })()`,
  );
  await jots(app).waitForCondition<boolean>(
    `(() => { const r = document.querySelector('${rowSel(id)}');
              return r !== null && r.getBoundingClientRect().height > 0; })()`,
    { timeoutMs: 3_000 },
  );
}

/** Select the target row and open its editor, settled at its full height. */
export async function openTargetEditor(app: App, id: string): Promise<void> {
  await jots(app).nativeClickAtElement(`${rowSel(id)} .jot-row-label`);
  await jots(app).waitForCondition<boolean>(
    `document.querySelector('.jots-card .jots-list[data-key-view-kbd]') !== null`,
    { timeoutMs: 3_000 },
  );
  await app.nativeKey("Return");
  await jots(app).waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(EDITOR)}) !== null`,
    { timeoutMs: 3_000 },
  );
  // The well opens on an animation, and the card's scroll rides it; wait for
  // both to stop moving so the measurement is of the settled card, not of a
  // frame mid-open.
  await jots(app).waitForCondition<boolean>(
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
export function tallJot(): string {
  const body = Array.from({ length: 100 }, (_, k) => `body line ${k}`);
  return `Target jot title\n${body.join("\n")}`;
}

/** Launch against an isolated jots file whose `target` carries `text`. */
export async function withJots(
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

