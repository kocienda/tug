/**
 * at0573-orphaned-chip-menu-no-fold.test.ts — a secondary press on the
 * orphaned row's prior-owner chip opens that session's menu and leaves the
 * row folded.
 *
 * The orphaned bucket names the dead owner with a session chip, and a chip
 * answers a secondary press with the session's own menu. The chip stands
 * inside `.tug-changes-list-row-hit` — the region whose click folds the file's
 * diff open — and stops a click of its own only while it is *interactive*,
 * which means a card is open for that session to raise. A dead owner has no
 * card, so the chip had no handler to stop with: a macOS Control-click is
 * button 0 and WebKit dispatches a `click` for it alongside the `contextmenu`,
 * and the row expanded under its own menu.
 *
 * The gesture is driven natively — Control held at the windowserver, a real
 * left press posted underneath — for the reason at0556 records: a synthesized
 * `contextmenu` carries no paired click, so it never meets this bug.
 *
 * The second half is the fix's other half: an ordinary click on the same row
 * must still fold it. A guard that bought a quiet menu by making the row
 * unfoldable would be the worse trade.
 *
 * @covers tugdeck/src/components/tugways/tug-changes-list.tsx
 * @covers tugdeck/src/lib/whole-entity-press.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "at0573-session";
// The dead owner: seeded `closed`, so the aggregate strands its file rather
// than composing a session entry for it.
const DEAD_SID = "at0573-dead-owner";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const USER_ROWS = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;

// The aggregate composes this checkout and no other, so the dirty file lives
// here — the constraint at0332/at0334 both record. It is removed afterwards.
const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", ".."));
const DIRTY_FILE = "at0573-scratch.txt";
const scratchPath = join(PROJECT_DIR, DIRTY_FILE);

const ORPHANED_ROW =
  `${SHEET} .tug-changes-list-file-list[data-entry-kind="orphaned"] ` +
  `[data-testid="tug-changes-list-file-block"][data-path="${DIRTY_FILE}"]`;
const CHIP = `${ORPHANED_ROW} .tug-changes-list-file-hint-from [data-slot="tug-session-identity"]`;
const FOLD_CUE = `${ORPHANED_ROW} [data-slot="tug-changes-list-fold"]`;
const MENU = '[data-slot="tug-editor-context-menu"]';

beforeAll(() => {
  if (!SHOULD_RUN) return;
  writeFileSync(scratchPath, "at0573 scratch\n");
});

afterAll(() => {
  if (existsSync(scratchPath)) rmSync(scratchPath, { force: true });
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 1000, height: 720 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SHOULD_RUN)("AT0573: the orphaned row's chip under a secondary press", () => {
  test(
    "a Control-click on the prior-owner chip opens a menu and folds nothing",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: PROJECT_DIR });
      const app = await launchTugApp({
        testName: "at0573-orphaned-chip-menu-no-fold",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        // A closed session with a proof-class row on the dirty file: an owner
        // that is gone, which is exactly what the orphaned bucket is for.
        app.seedLedger({
          sessions: [
            {
              session_id: DEAD_SID,
              workspace_key: PROJECT_DIR,
              project_dir: PROJECT_DIR,
              name: "at0573 dead owner",
              tag: "at0573-dead-owner",
              state: "closed",
            },
          ],
          file_events: [
            {
              tug_session_id: DEAD_SID,
              tool_use_id: "at0573-tu-1",
              file_path: scratchPath,
              tool_name: "Write",
              op: "created",
              origin: "exact",
              ambiguous: false,
              project_dir: PROJECT_DIR,
              at: Date.now(),
            },
          ],
        });
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", {
          tugSessionId: SID,
          projectDir: PROJECT_DIR,
          workspaceKey: PROJECT_DIR,
        });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // One committed turn so the card is a live, non-empty session.
        await app.driveSession("A", { op: "send", text: "hello" });
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: 0x40,
          decoded: { tug_session_id: SID, type: "prompt_anchor", promptUuid: "uuid-1" },
        });
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: 0x40,
          decoded: { tug_session_id: SID, type: "turn_complete", msg_id: "m1", result: "success" },
        });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length === 1`,
          { timeoutMs: 8000 },
        );

        // ── Raise the changes sheet ────────────────────────────────────────
        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType("/commit");
        await settle();
        await app.nativeKey("Escape"); // dismiss the completion popup
        await settle();
        await app.nativeKey("Return", ["cmd"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 8000 },
        );

        // ── The scratch file is stranded, and says whose it was ────────────
        try {
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CHIP)}) !== null`,
            { timeoutMs: 30000 },
          );
        } catch (err) {
          note(
            "at0573 shade contents when no orphaned chip appeared",
            await app.evalJS<unknown>(
              `(() => {
                 const sheet = document.querySelector(${JSON.stringify(SHEET)});
                 if (sheet === null) return "no sheet";
                 return {
                   entryKinds: Array.from(
                     sheet.querySelectorAll("[data-entry-kind]"),
                   ).map((el) => el.getAttribute("data-entry-kind")),
                   paths: Array.from(
                     sheet.querySelectorAll("[data-testid=\\"tug-changes-list-file-block\\"]"),
                   ).map((el) => el.getAttribute("data-path")).slice(0, 25),
                 };
               })()`,
            ),
          );
          throw err;
        }

        const isExpanded = async (): Promise<boolean> =>
          app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(
              `${ORPHANED_ROW}[data-expanded="true"]`,
            )}) !== null`,
          );
        expect(await isExpanded(), "the row starts folded").toBe(false);

        // ── The chip, Control-clicked ─────────────────────────────────────
        await app.evalJS<boolean>(
          `document.querySelector(${JSON.stringify(CHIP)})
             .scrollIntoView({ block: "center" }), true`,
        );
        await settle(300);
        await app.withModifiersHeld(["ctrl"], async () => {
          await app.nativeClickAtElement(CHIP);
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MENU)}) !== null`,
          { timeoutMs: 8000 },
        );
        const rows = await app.evalJS<readonly string[]>(
          `Array.prototype.map.call(
             document.querySelectorAll(${JSON.stringify(MENU)} + ' [role="menuitem"]'),
             function (item) { return item.getAttribute("data-item-action") || ""; })`,
        );
        note("at0573 menu", JSON.stringify(rows));
        // The chip's own menu, identified by the copy only a session offers.
        expect(rows).toContain("copy-session-citation");

        // …and the row did not fold open under it.
        await settle(400);
        expect(await isExpanded(), "a secondary press is not the fold's gesture").toBe(
          false,
        );

        await app.evalJS<null>(
          `(function(){
             document.dispatchEvent(
               new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
             );
             return null;
           })()`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MENU)}) === null`,
          { timeoutMs: 8000 },
        );

        // ── An ordinary click still folds the row ─────────────────────────
        for (let attempt = 0; attempt < 4; attempt += 1) {
          if (await isExpanded()) break;
          await app.nativeClickAtElement(FOLD_CUE);
          await settle(500);
        }
        expect(await isExpanded(), "the fold itself still works").toBe(true);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
