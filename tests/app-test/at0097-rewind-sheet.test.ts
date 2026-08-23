/**
 * at0097-rewind-sheet.test.ts — `/rewind` cut-line picker + restore confirm,
 * end-to-end through the real sheet ([#step-7-3]).
 *
 * Drives a deterministic 3-turn dev session via `driveSession` (no live
 * claude — each turn is `send` + an injected `prompt_anchor` + `turn_complete`,
 * so the committed turns carry the rewind anchor). Then:
 *   1. Open `/rewind` via the real submit path (type, dismiss completion,
 *      Cmd+Enter) — the local-command dispatch opens the card-scoped sheet.
 *   2. Assert the sheet lists EVERY user message as typed, and that the cut
 *      line opens at the end — nothing discarded, Rewind disabled.
 *   3. Click message 2 → the line lands below it, message 3 reads as
 *      discarded, and Rewind enables.
 *   4. Press Rewind and assert the sheet does NOT dismiss: it turns into a
 *      progress surface (indeterminate bar in place of the actions row) and
 *      holds the card, because the ack it waits on means "the rewound session
 *      has loaded", not "the frame was sent".
 *   5. Inject the `rewind_result` ack (the backend round-trip, simulated) and
 *      assert the transcript truncated locally (the discarded turn dropped,
 *      the kept turns kept) and the sheet dismissed.
 *
 * The code-restore dimension's real file revert is covered at the tugcode
 * layer (test-37 / test-39 probes); here the store-only harness verifies the
 * conversation-restore round-trip through the sheet UI.
 *
 * @covers tugdeck/src/lib/slash-commands.ts
 * @covers tugdeck/src/lib/code-session-store/
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/cards/rewind-sheet.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0097-session";
const FEED_CODE_OUTPUT = 0x40;

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = '[data-slot="tug-sheet"]';
const USER_ROWS = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const PICKER_ROWS = `${SHEET} [data-prompt-uuid]`;
const REWIND_APPLY = `${SHEET} [data-testid="rewind-apply"]`;
const CUT = `${SHEET} [data-testid="rewind-cut"]`;
const PROGRESS = `${SHEET} [data-testid="rewind-progress"]`;

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 820, height: 620 },
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

/** Drive one committed turn carrying the `/rewind` anchor `uuid-<i>`. */
async function buildTurn(app: App, i: number): Promise<void> {
  const uuid = `uuid-${i}`;
  const msgId = `m-${i}`;
  const frame = (decoded: Record<string, unknown>) =>
    app.driveSession("A", {
      op: "ingestFrame",
      feedId: FEED_CODE_OUTPUT,
      decoded: { tug_session_id: SID, ...decoded },
    });
  await app.driveSession("A", { op: "send", text: `prompt ${i}` });
  await frame({ type: "prompt_anchor", promptUuid: uuid });
  await frame({ type: "content_block_start", msg_id: msgId, block_index: 0, kind: "text" });
  await frame({ type: "assistant_text", msg_id: msgId, block_index: 0, text: `reply ${i}`, is_partial: false });
  await frame({ type: "turn_complete", msg_id: msgId, result: "success" });
}

/** Each listed message's side of the cut: kept / point (the rewind point) /
 *  discarded. */
async function rowStates(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.from(document.querySelectorAll(${JSON.stringify(PICKER_ROWS)}))
       .map((el) => el.getAttribute("data-rewind-state"))`,
  );
}

async function userRowCount(app: App): Promise<number> {
  return app.evalJS<number>(`document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length`);
}

describe.skipIf(!SHOULD_RUN)("AT0097: /rewind sheet — cut line + conversation restore", () => {
  test(
    "open /rewind, place the line, restore conversation → transcript truncated locally",
    async () => {
      const app = await launchTugApp({ testName: "at0097-rewind-sheet" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");

        // Build a 3-turn anchored transcript.
        await buildTurn(app, 1);
        await buildTurn(app, 2);
        await buildTurn(app, 3);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length === 3`,
          { timeoutMs: 8000 },
        );

        // Open /rewind via the real submit path.
        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType("/rewind");
        await new Promise((r) => setTimeout(r, 200));
        await app.nativeKey("Escape");
        await new Promise((r) => setTimeout(r, 200));
        await app.nativeKey("Return", ["cmd"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 6000 },
        );

        // Every user message is listed, as typed — including the newest (no
        // synthetic `(current)` row).
        const pickerUuids = await app.evalJS<string[]>(
          `Array.from(document.querySelectorAll(${JSON.stringify(PICKER_ROWS)}))
             .map((el) => el.getAttribute("data-prompt-uuid"))`,
        );
        expect(pickerUuids).toEqual(["uuid-1", "uuid-2", "uuid-3"]);
        expect(await rowStates(app)).toEqual(["kept", "kept", "point"]);

        // The line opens at the end: nothing discarded, so Rewind is inert.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(REWIND_APPLY)}).disabled`,
          ),
        ).toBe(true);
        expect(await app.evalJS<number>(`document.querySelectorAll(${JSON.stringify(CUT)}).length`)).toBe(1);

        // Place the line below message 2 — message 3 falls into the discarded
        // set and Rewind enables (scope defaults to Conversation).
        await app.nativeClickAtElement(`${SHEET} [data-prompt-uuid="uuid-2"]`);
        await app.waitForCondition<boolean>(
          `(function () {
             var b = document.querySelector(${JSON.stringify(REWIND_APPLY)});
             return b !== null && !b.disabled;
           })()`,
          { timeoutMs: 4000 },
        );
        expect(await rowStates(app)).toEqual(["kept", "point", "discarded"]);

        // Rewind → the sheet sends `session_rewind` (conversation by default);
        // simulate the backend ack so the local L26-safe truncation runs.
        await app.nativeClickAtElement(REWIND_APPLY);

        // The press starts a run, it does not close the sheet: the picker
        // stays up over the cut it is applying, the actions row gives way to
        // the indeterminate bar, and the card is held until the ack — which
        // tugcode withholds until the respawned session has loaded.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PROGRESS)}) !== null`,
          { timeoutMs: 4000 },
        );
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(REWIND_APPLY)}).length`,
          ),
        ).toBe(0);

        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: FEED_CODE_OUTPUT,
          decoded: {
            type: "rewind_result",
            tug_session_id: SID,
            promptUuid: "uuid-3",
            scope: "conversation",
            canRewind: true,
          },
        });

        // The discarded turn (3) dropped; turns 1 + 2 kept; sheet dismissed.
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length === 2`,
          { timeoutMs: 6000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) === null`,
          { timeoutMs: 4000 },
        );
        expect(await userRowCount(app)).toBe(2);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
