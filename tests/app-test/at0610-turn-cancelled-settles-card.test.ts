/**
 * at0610-turn-cancelled-settles-card.test.ts — a `turn_cancelled` frame
 * settles a card whose Stop went to the escalation ladder ([AT0610]).
 *
 * ## Why this exists
 *
 * tugcode closes an interrupted turn with `turn_cancelled` whenever the turn
 * ended with `ActiveTurn.interrupted` set — the escalation ladder that
 * force-terminates a wedged claude after `INTERRUPT_ACK_GRACE_MS`, the drain's
 * EOF path, and `stop_all_work`. The deck had no entry for the type in
 * `KNOWN_CODE_OUTPUT_TYPES`, so `frameToEvent`'s guard dropped it with no
 * dispatch and no log — and the only clearer of `interruptInFlight` was
 * `turn_complete`. A stop that escalated therefore left the card reading
 * "Interrupting" with a Stop button stuck in `stopping` and no frame in the
 * protocol able to settle it.
 *
 * On a good network claude answers its own stdin inside two seconds and sends
 * `turn_complete`, which is why the defect stayed hidden: the ladder only runs
 * when claude is wedged, and a bad network is what wedges it.
 *
 * The reducer's commit is unit-tested in `reducer.turn-cancelled.test.ts`.
 * This drives the live surface: a real user turn, a real Stop, and then the
 * cancel receipt injected through the store's real `frameToEvent → dispatch`
 * path, asserting the three things the user actually sees come back —
 * the Z5 button, the STATE cell, and the composer.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/code-session-store.ts
 * @covers tugdeck/src/lib/code-session-store/reducer.ts
 * @covers tugdeck/src/lib/code-session-store/events.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const TUG_SESSION_ID = "test-session-A"; // bindSession default

const SUBMIT_BUTTON = ".tug-prompt-entry-submit-button";
const STATE_VALUE = ".session-telemetry-status-value";
const COMPOSER = '[data-slot="tug-text-editor"] .cm-content';

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0610-turn-cancelled-"));
});
afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 680 },
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

/** The Z5 button's current `data-mode`, or "" when it is not mounted. */
const SUBMIT_MODE = `(function(){var b=document.querySelector(${JSON.stringify(
  SUBMIT_BUTTON,
)});return b===null?"":(b.getAttribute("data-mode")||"");})()`;

/** Every STATE-cell reading on screen, joined — the card has one. */
const STATE_TEXT = `(function(){return Array.prototype.map.call(document.querySelectorAll(${JSON.stringify(
  STATE_VALUE,
)}),function(n){return n.textContent||"";}).join("|");})()`;

/** True iff the composer is editable and sits under nothing `inert`. */
const COMPOSER_ACCEPTS_TEXT = `(function(){var c=document.querySelector(${JSON.stringify(
  COMPOSER,
)});return c!==null && c.getAttribute("contenteditable")==="true" && c.closest("[inert]")===null;})()`;

describe.skipIf(!SHOULD_RUN)(
  "AT0610: turn_cancelled settles a card whose stop escalated",
  () => {
    test(
      "the cancel receipt returns the Z5 button, the STATE cell, and the composer",
      async () => {
        const app = await launchTugApp({
          testName: "at0610-turn-cancelled-settles-card",
        });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", { projectDir });
          await app.awaitEngineReady("A", { timeoutMs: 30_000 });

          const frame = (decoded: unknown) =>
            app.driveSession("A", {
              op: "ingestFrame",
              feedId: CODE_OUTPUT_FEED,
              decoded,
            });

          // Baseline: idle card, composer live, Z5 offering submit.
          await app.waitForCondition<boolean>(
            `${SUBMIT_MODE} === "submit"`,
            { timeoutMs: 6000 },
          );
          expect(await app.evalJS<boolean>(COMPOSER_ACCEPTS_TEXT)).toBe(true);

          // ── a user turn, streaming ──────────────────────────────────
          await app.driveSession("A", { op: "send", text: "count to a million" });
          await frame({
            type: "content_block_start",
            msg_id: "m1",
            block_index: 0,
            kind: "text",
            tug_session_id: TUG_SESSION_ID,
          });
          await frame({
            type: "assistant_text",
            msg_id: "m1",
            block_index: 0,
            text: "one, two",
            is_partial: true,
            tug_session_id: TUG_SESSION_ID,
          });
          await app.waitForCondition<boolean>(
            `${SUBMIT_MODE} === "stop"`,
            { timeoutMs: 6000 },
          );

          // ── the user presses Stop; content had arrived, so CASE B ───
          await app.driveSession("A", { op: "interrupt" });
          await app.waitForCondition<boolean>(
            `${SUBMIT_MODE} === "stopping"`,
            { timeoutMs: 6000 },
          );
          // This is the state the defect stranded the card in.
          expect(await app.evalJS<string>(STATE_TEXT)).toContain("Interrupting");

          // ── claude never answered; the ladder cancelled the turn ────
          await frame({
            type: "turn_cancelled",
            msg_id: "m1",
            seq: 12,
            partial_result: "one, two",
            tug_session_id: TUG_SESSION_ID,
            ipc_version: 2,
          });

          // The Z5 leaves `stopping`.
          await app.waitForCondition<boolean>(
            `${SUBMIT_MODE} === "submit"`,
            { timeoutMs: 6000 },
          );
          // The STATE cell stops reading "Interrupting".
          await app.waitForCondition<boolean>(
            `${STATE_TEXT}.indexOf("Interrupting") === -1`,
            { timeoutMs: 6000 },
          );
          // And the composer takes text again.
          expect(await app.evalJS<boolean>(COMPOSER_ACCEPTS_TEXT)).toBe(true);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(`\n[at0610] log tail:\n${tail}\n`);
          }
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
