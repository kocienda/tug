/**
 * at0658-cards-unconnected-session-row.test.ts — a Session card that has not
 * connected yet stands in the Workspaces list at a connected row's height.
 *
 * A new Session card opens on its project picker, bound to no session. Its
 * Workspaces row used to fall through to the generic one-line row, so adding a
 * Session card dropped a short row into a column of three-line monitor rows,
 * and the row then grew the moment the card connected. It now wears the
 * monitor row's own shape with nothing in it yet.
 *
 * What this file pins:
 *
 *   1. **Same layout.** The unconnected row and a connected row in the same
 *      list measure the same height, and every part of the row — the dot, the
 *      title, the slot cluster, the description, the activity, the tape —
 *      stands at the same horizontal place in both. Height alone passed a row
 *      whose slots were pushed inward by a close box the connected row does
 *      not carry and which drew no tape.
 *   2. **The name reads like a connected row's.** `<project>/unconnected-session`,
 *      where the project is the leaf of the path the card's picker opens on —
 *      here the seeded `default-project-path`, since a fresh tugbank has no
 *      recents to outrank it.
 *   3. **Connecting does not move it.** Binding the card swaps it for the
 *      connected monitor row at the height it already stood at.
 *
 * @covers tugdeck/src/components/cards/cards-session-cell.tsx
 * @covers tugdeck/src/components/tugways/cards/session-picker-seed.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const CONNECTED = ".cards-list .cards-row[data-session-id]";
const UNCONNECTED = '.cards-list [data-testid="cards-unconnected-session-row"]';

/**
 * Two Session cards side by side — A to be bound, B left on its picker — and
 * the Workspaces card on the right rail so the rows are on screen.
 */
function deckShape(): Record<string, unknown> {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session A", closable: true },
      { id: "B", componentId: "session", title: "Session B", closable: true },
      { id: "W", componentId: "cards", title: "Workspaces", closable: true },
    ],
    panes: [
      {
        id: "pA",
        position: { x: 40, y: 40 },
        size: { width: 675, height: 520 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
        slot: 0,
      },
      {
        id: "pB",
        position: { x: 80, y: 40 },
        size: { width: 675, height: 520 },
        cardIds: ["B"],
        activeCardId: "B",
        title: "",
        acceptsFamilies: ["standard"],
        slot: 1,
      },
      {
        id: "pW",
        position: { x: 0, y: 0 },
        size: { width: 420, height: 900 },
        cardIds: ["W"],
        activeCardId: "W",
        title: "Workspaces",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "pA",
    imposition: { kind: "two-up", sidebars: { cards: { side: "right" } } },
    hasFocus: true,
  };
}

/** The parts of a session row whose placement the two rows must share. */
const PARTS = [
  ".tug-session-row-dot",
  ".tug-list-row-title",
  ".tug-session-row-slots",
  ".tug-session-row-description",
  ".tug-activity-line",
  ".session-activity-spark",
] as const;

/**
 * Each part's left and right edge, measured from its row's own left edge, so
 * two rows at different heights in the list compare directly. A missing part
 * reads `null`.
 */
function partEdges(
  app: App,
  rowSelector: string,
): Promise<Record<string, { left: number; right: number } | null>> {
  return app.evalJS(
    `(function () {
       var row = document.querySelector(${JSON.stringify(rowSelector)});
       var out = {};
       var parts = ${JSON.stringify(PARTS)};
       for (var i = 0; i < parts.length; i++) {
         var el = row === null ? null : row.querySelector(parts[i]);
         if (el === null) { out[parts[i]] = null; continue; }
         var r = el.getBoundingClientRect();
         var base = row.getBoundingClientRect().left;
         out[parts[i]] = { left: r.left - base, right: r.right - base };
       }
       return out;
     })()`,
  );
}

/** A row's border-box height, or -1 when no row matches. */
function heightOf(app: App, selector: string): Promise<number> {
  return app.evalJS<number>(
    `(function () {
       var row = document.querySelector(${JSON.stringify(selector)});
       return row === null ? -1 : row.getBoundingClientRect().height;
     })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0658 — an unconnected Session card's row", () => {
  test(
    "stands at a connected row's height, named for its picker's project",
    async () => {
      const project = mkdtempSync(join(tmpdir(), "at0658-proj-"));
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.app", "default-project-path", "string", project);
      const app = await launchTugApp({
        testName: "at0658-cards-unconnected-session-row",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.bindSession("A", {
          tugSessionId: "at0658-A",
          projectDir: project,
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONNECTED)}) !== null && ` +
            `document.querySelector(${JSON.stringify(UNCONNECTED)}) !== null`,
          { timeoutMs: 20_000 },
        );

        // ---- 1. Same height. -------------------------------------------
        const connected = await heightOf(app, CONNECTED);
        const unconnected = await heightOf(app, UNCONNECTED);
        note(`at0658 heights: connected ${connected}px, unconnected ${unconnected}px`);
        expect(connected, "a connected row is measured").toBeGreaterThan(0);
        expect(
          Math.abs(unconnected - connected),
          "the unconnected row stands at the connected row's height",
        ).toBeLessThan(0.5);
        const connectedParts = await partEdges(app, CONNECTED);
        const unconnectedParts = await partEdges(app, UNCONNECTED);
        note(
          `at0658 parts: connected ${JSON.stringify(connectedParts)} | ` +
            `unconnected ${JSON.stringify(unconnectedParts)}`,
        );
        for (const part of PARTS) {
          const c = connectedParts[part];
          const u = unconnectedParts[part];
          expect(c, `${part} is drawn on the connected row`).not.toBeNull();
          expect(u, `${part} is drawn on the unconnected row`).not.toBeNull();
          expect(
            Math.abs(u!.left - c!.left),
            `${part} starts where the connected row's does`,
          ).toBeLessThan(0.5);
          // The title and the activity end where their text ends, which
          // differs between the two rows by design; their START is the claim.
          if (part === ".tug-list-row-title" || part === ".tug-activity-line") {
            continue;
          }
          expect(
            Math.abs(u!.right - c!.right),
            `${part} ends where the connected row's does`,
          ).toBeLessThan(0.5);
        }

        // ---- 2. The name. ----------------------------------------------
        const title = await app.evalJS<string>(
          `document.querySelector(${JSON.stringify(
            `${UNCONNECTED} .tug-list-row-title`,
          )}).textContent`,
        );
        expect(title, "named for the project its picker opens on").toBe(
          `${basename(project)}/unconnected-session`,
        );

        // ---- 3. Connecting does not move it. ----------------------------
        await app.bindSession("B", {
          tugSessionId: "at0658-B",
          projectDir: project,
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(UNCONNECTED)}) === null && ` +
            `document.querySelectorAll(${JSON.stringify(CONNECTED)}).length === 2`,
          { timeoutMs: 20_000 },
        );
        const bound = await heightOf(app, `${CONNECTED}[data-session-id="at0658-B"]`);
        expect(
          Math.abs(bound - unconnected),
          "and binding the card keeps the row at that height",
        ).toBeLessThan(0.5);
      } finally {
        await app.close().catch(() => undefined);
        rmTempTugbank(tugbankPath);
        rmSync(project, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
