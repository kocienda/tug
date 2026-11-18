/**
 * at0857-claim-keeps-auto-message-chord.test.ts — a Claim press in the
 * Changes shade leaves ⌃⌘M live.
 *
 * ⌃⌘M (Auto-Message) is a binding scoped to the composer, so it is live only
 * while the composer is on the first-responder walk. The shade is passive and
 * its view refuses focus, which is what is meant to keep the composer first
 * responder through any press in it. A body page classifies no gesture,
 * though, and its pointerdown promotion used to promote from the target
 * without asking whether the target refuses: a Claim press put the first
 * responder on the changes list, the composer fell off the walk, and the
 * chord did nothing until the next click into the composer.
 *
 * Driven with a typed message so the chord's effect is one that needs no
 * scribe: over a non-empty message, Auto-Message raises the Replace confirm.
 * The chord is pressed once before the Claim, to prove the reading, and once
 * after.
 *
 * The project must be the one tugcast registers at boot, as in at0332.
 *
 * @covers tugdeck/src/components/tugways/responder-chain-provider.tsx
 * @covers tugdeck/src/gesture-interpreter.ts
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/changes-list.tsx
 * @covers tugdeck/src/components/tugways/cards/prompt-entry.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0857-session";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const USER_ROWS = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;

// The registry keys a workspace by the canonical (realpath) project dir, and
// the binding must carry that same key or the shade never resolves the
// composed project. The scratch file lives in this checkout because that is
// the only project the aggregate composes; it is removed afterwards.
const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", ".."));
const DIRTY_FILE = "at0857-scratch.txt";
const scratchPath = join(PROJECT_DIR, DIRTY_FILE);

/** The scratch file's block inside the unattributed section of the list. */
const UNATTRIBUTED_ROW =
  `${SHEET} .tug-changes-list-file-list[data-entry-kind="unattributed"] ` +
  `[data-testid="tug-changes-list-file-block"][data-path="${DIRTY_FILE}"]`;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  // No tool call stands behind this write, so nothing attributes it.
  writeFileSync(scratchPath, "at0857 scratch\n");
});

afterAll(() => {
  if (existsSync(scratchPath)) rmSync(scratchPath, { force: true });
});

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SHOULD_RUN)("AT0857: a Claim click leaves the Auto-Message chord live", () => {
  test(
    "⌃⌘M raises the Replace confirm before a Claim press and after it",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: PROJECT_DIR });
      const app = await launchTugApp({
        testName: "at0857-claim-keeps-auto-message-chord",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
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
          decoded: { tug_session_id: SID, type: "turn_complete", seq: 0, msg_id: "m1", result: "success" },
        });
        await app.body("A").waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length === 1`,
          { timeoutMs: 8000 },
        );

        // ── Raise the changes sheet ────────────────────────────────────────
        await app.body("A").nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType("/commit");
        await settle();
        await app.nativeKey("Escape"); // dismiss the completion popup
        await settle();
        await app.nativeKey("Return", ["cmd"]);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 8000 },
        );

        // ── The scratch file arrives unattributed ──────────────────────────
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(UNATTRIBUTED_ROW)}) !== null`,
          { timeoutMs: 20000 },
        );

        const CONFIRM_UP = `document.body.innerText.includes("Replace message?")`;
        const composerIsFirstResponder = () =>
          app.body("A").evalJS<boolean>(
            `(() => {
               const el = document.querySelector(
                 '[data-responder-id="' + window.__tug.getFirstResponderId() + '"]',
               );
               return el !== null && el.matches('[data-slot="tug-text-editor"]');
             })()`,
          );

        // ── The reading: over a typed message the chord raises the confirm ──
        await app.nativeType("msg");
        await settle();
        await app.nativeKey("m", ["ctrl", "cmd"]);
        await app.body("A").waitForCondition<boolean>(CONFIRM_UP, { timeoutMs: 4000 });
        await app.nativeKey("Escape");
        await app.body("A").waitForCondition<boolean>(`!(${CONFIRM_UP})`, { timeoutMs: 4000 });
        expect(await composerIsFirstResponder()).toBe(true);

        // ── A Claim press moves no keyboard register ───────────────────────
        await app.body("A").nativeClickAtElement(
          `${UNATTRIBUTED_ROW} [data-testid="tug-changes-list-claim"]`,
        );
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(UNATTRIBUTED_ROW)}) === null`,
          { timeoutMs: 8000 },
        );
        expect(await composerIsFirstResponder()).toBe(true);

        // ── …so the chord still answers ────────────────────────────────────
        await app.nativeKey("m", ["ctrl", "cmd"]);
        await app.body("A").waitForCondition<boolean>(CONFIRM_UP, { timeoutMs: 4000 });
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
