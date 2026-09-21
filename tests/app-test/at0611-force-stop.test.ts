/**
 * at0611-force-stop.test.ts — a stop that nothing answers becomes Force
 * Stop, and Force Stop settles the card ([AT0611]).
 *
 * ## Why this exists
 *
 * `at0610` covers the receipt arriving. This covers the receipt never
 * arriving at all — the case the whole arc came from, where a stop went out
 * and the protocol went quiet behind it. The deck's own deadline is the only
 * thing that can end that wait, and what it produces has to be a control the
 * user can press rather than a spinner that stops spinning.
 *
 * So this drives the full journey with every receipt withheld: a real turn, a
 * real Stop, six seconds of nothing, and then the three things the user sees —
 * the Z5 button reading Force Stop and *enabled* (the defect left it in the
 * inert `stopping` glyph forever), the STATE cell reading "Stop unanswered"
 * rather than "Interrupting", and a press that the card recovers from once
 * tugcode's teardown answers.
 *
 * What this test does **not** pin is the wire frame the press produces: the
 * harness has no seam onto outbound CODE_INPUT. That the press emits exactly
 * one `stop_all_work` with an empty `task_ids`, and emits nothing at all from
 * any other state, is pinned in `reducer.interrupt-silence.test.ts`. What is
 * pinned here is that the control exists, is live, and survives being pressed
 * — none of which the unit test can see.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/code-session-store/lifecycle-state.ts
 * @covers tugdeck/src/lib/code-session-store/reducer.ts
 * @covers tugdeck/src/components/tugways/tug-prompt-entry-submit-button.ts
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

/**
 * `INTERRUPT_SILENCE_DEADLINE_MS` is 6000 and runs on the app's real clock;
 * the waits below carry enough slack that a loaded machine does not read as a
 * deadline that never fired.
 */
const DEADLINE_WAIT_MS = 20_000;

const SUBMIT_BUTTON = ".tug-prompt-entry-submit-button";
const STATE_VALUE = ".session-telemetry-status-value";
const COMPOSER = '[data-slot="tug-text-editor"] .cm-content';

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0611-force-stop-"));
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

/** True iff the Z5 button is present and natively enabled. */
const SUBMIT_ENABLED = `(function(){var b=document.querySelector(${JSON.stringify(
  SUBMIT_BUTTON,
)});return b!==null && b.hasAttribute("disabled")===false;})()`;

/** The Z5 button's accessible name — the mode's own word for itself. */
const SUBMIT_LABEL = `(function(){var b=document.querySelector(${JSON.stringify(
  SUBMIT_BUTTON,
)});return b===null?"":(b.getAttribute("aria-label")||"");})()`;

/** Every STATE-cell reading on screen, joined — the card has one. */
const STATE_TEXT = `(function(){return Array.prototype.map.call(document.querySelectorAll(${JSON.stringify(
  STATE_VALUE,
)}),function(n){return n.textContent||"";}).join("|");})()`;

/** True iff the composer is editable and sits under nothing `inert`. */
const COMPOSER_ACCEPTS_TEXT = `(function(){var c=document.querySelector(${JSON.stringify(
  COMPOSER,
)});return c!==null && c.getAttribute("contenteditable")==="true" && c.closest("[inert]")===null;})()`;

describe.skipIf(!SHOULD_RUN)(
  "AT0611: an unanswered stop becomes Force Stop",
  () => {
    test(
      "the deadline offers Force Stop, and the answer to it settles the card",
      async () => {
        const app = await launchTugApp({ testName: "at0611-force-stop" });
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

          await app.waitForCondition<boolean>(`${SUBMIT_MODE} === "submit"`, {
            timeoutMs: 6000,
          });

          // ── a user turn, streaming ──────────────────────────────────
          await app.driveSession("A", {
            op: "send",
            text: "count to a million",
          });
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
          await app.waitForCondition<boolean>(`${SUBMIT_MODE} === "stop"`, {
            timeoutMs: 6000,
          });

          // ── the user presses Stop, and nothing at all comes back ────
          await app.driveSession("A", { op: "interrupt" });
          await app.waitForCondition<boolean>(`${SUBMIT_MODE} === "stopping"`, {
            timeoutMs: 6000,
          });
          expect(await app.evalJS<string>(STATE_TEXT)).toContain("Interrupting");

          // No `turn_complete`, no `turn_cancelled`, no `interrupt_noop`, no
          // terminal. This is where the card used to stay forever.

          // ── the deck's own clock is what ends the wait ──────────────
          await app.waitForCondition<boolean>(
            `${SUBMIT_MODE} === "force-stop"`,
            { timeoutMs: DEADLINE_WAIT_MS },
          );
          // And the control is live. The defect was not that the card said
          // the wrong thing — it was that the button was inert.
          expect(await app.evalJS<boolean>(SUBMIT_ENABLED)).toBe(true);
          expect(await app.evalJS<string>(SUBMIT_LABEL)).toBe("Force stop");
          // The card stops claiming an interrupt is in progress and names
          // what actually happened.
          const stalledState = await app.evalJS<string>(STATE_TEXT);
          expect(stalledState).toContain("Stop unanswered");
          expect(stalledState).not.toContain("Interrupting");

          // ── the user presses Force Stop ─────────────────────────────
          await app.click(SUBMIT_BUTTON);
          // The frame has gone out and nothing has come back, so the offer
          // stands: pressing it is not itself an answer.
          expect(await app.evalJS<string>(SUBMIT_MODE)).toBe("force-stop");

          // ── tugcode's teardown answers ──────────────────────────────
          // `handleStopAllWork` sets `activeTurn.interrupted` before it
          // sweeps the group, so the drain's EOF closes the turn as a
          // recovery cancel; `stop_all_work_done` follows once the respawn
          // acks. Both arrive here, as they would live.
          await frame({
            type: "turn_cancelled",
            msg_id: "m1",
            seq: 12,
            partial_result: "one, two",
            is_recovery: true,
            tug_session_id: TUG_SESSION_ID,
            ipc_version: 2,
          });
          await frame({
            type: "stop_all_work_done",
            tug_session_id: TUG_SESSION_ID,
            ipc_version: 2,
          });

          // The card comes all the way back.
          await app.waitForCondition<boolean>(`${SUBMIT_MODE} === "submit"`, {
            timeoutMs: 6000,
          });
          await app.waitForCondition<boolean>(
            `${STATE_TEXT}.indexOf("Stop unanswered") === -1`,
            { timeoutMs: 6000 },
          );
          expect(await app.evalJS<boolean>(COMPOSER_ACCEPTS_TEXT)).toBe(true);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(`\n[at0611] log tail:\n${tail}\n`);
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
