/**
 * at0084-session-lifecycle-coordination.test.ts — end-to-end verification
 * of the session-card lifecycle state-to-zone coordination matrix.
 *
 * The capstone of the session-card lifecycle-coordination work. The
 * lifecycle matrix says what each zone (Z1 transcript trailing, Z2
 * status row, Z5 submit button) paints in each lifecycle state; the
 * pure projection (`deriveLifecycleSnapshot`) is unit-tested
 * exhaustively elsewhere.
 * This test closes the loop: it drives a *real* `CodeSessionStore`
 * inside a *real* session card through every distinct matrix row and
 * asserts the rendered DOM — no mock store, no fake DOM.
 *
 * It drives the store through the `driveSession` harness verb:
 *   - `send` — a user submission (mid-turn `send` queues).
 *   - `ingestFrame` — a decoded `CODE_OUTPUT` frame fed through the
 *     store's real decode → `dispatch` path.
 *   - `interrupt` / `transportClose` — the cancel + transport overlays.
 *
 * One card per scenario, one pane each, all mounted at once:
 *   - A: the clean turn lifecycle — IDLE → STREAMING → TOOL_WORK →
 *        COMPLETE.
 *   - B: AWAITING_USER (a permission forward).
 *   - C: QUEUED_NEXT_TURN — two mid-turn submits paint two ghost rows;
 *        the Stop button peels the newest (LIFO), the ghost row's ✕
 *        un-sends a targeted one (C1).
 *   - D: ERRORED (a wire error frame).
 *   - E: REPLAYING (a replay window).
 *   - F: TRANSPORT_DOWN (the wire goes offline).
 *   - G: C2 — a CASE A pull-down (interrupt before any answer content).
 *   - H: C3 — a CASE B interrupt (answer content has begun).
 *
 * The matrix is the contract; a regression against any asserted cell
 * is a bug.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/session-lifecycle.ts
 * @covers tugdeck/src/lib/session-lifecycle-log.ts
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 120_000;

/**
 * `FeedId.CODE_OUTPUT` — the wire feed every dev stream frame
 * (`assistant_text` / `tool_use` / `turn_complete` / …) arrives on.
 * Hardcoded rather than imported: the app-test graph does not couple
 * to tugdeck's `protocol.ts`. See `tugdeck/src/protocol.ts`.
 */
const FEED_CODE_OUTPUT = 0x40;

/** Card ids — one per matrix scenario; `tug_session_id` is `test-session-<id>`. */
const CARD_IDS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
type CardId = (typeof CARD_IDS)[number];

function sessionIdFor(cardId: CardId): string {
  return `test-session-${cardId}`;
}

// ---------------------------------------------------------------------------
// Deck seed — one session card per pane so every card mounts at once.
// ---------------------------------------------------------------------------

function deckShape() {
  return {
    cards: CARD_IDS.map((id) => ({
      id,
      componentId: "session",
      title: `Dev ${id}`,
      closable: true,
    })),
    panes: CARD_IDS.map((id, i) => ({
      id: `p-${id}`,
      // Offset positions so the panes don't fully stack; irrelevant to
      // DOM inspection (selectors key off `data-card-id`), but keeps
      // every card's pane independently active.
      position: { x: 40 + i * 24, y: 40 + i * 24 },
      size: { width: 640, height: 460 },
      cardIds: [id],
      activeCardId: id,
      title: "",
      acceptsFamilies: ["maker"],
    })),
    activePaneId: "p-A",
    hasFocus: true,
  };
}

// ---------------------------------------------------------------------------
// Frame builders — decoded CODE_OUTPUT payloads for a card's session.
// ---------------------------------------------------------------------------

function assistantText(
  cardId: CardId,
  msgId: string,
  text: string,
  rev: number,
): Record<string, unknown> {
  return {
    type: "assistant_text",
    status: "partial",
    tug_session_id: sessionIdFor(cardId),
    msg_id: msgId,
    text,
    is_partial: true,
    rev,
    seq: 0,
  };
}

function toolUse(
  cardId: CardId,
  msgId: string,
  toolName: string,
): Record<string, unknown> {
  return {
    type: "tool_use",
    tug_session_id: sessionIdFor(cardId),
    msg_id: msgId,
    tool_use_id: `${msgId}-tool-1`,
    tool_name: toolName,
    input: {},
    seq: 1,
  };
}

function turnCompleteSuccess(
  cardId: CardId,
  msgId: string,
): Record<string, unknown> {
  return {
    type: "turn_complete",
    seq: 0,
    tug_session_id: sessionIdFor(cardId),
    msg_id: msgId,
    result: "success",
  };
}

function turnCompleteError(
  cardId: CardId,
  msgId: string,
): Record<string, unknown> {
  return {
    type: "turn_complete",
    seq: 0,
    tug_session_id: sessionIdFor(cardId),
    msg_id: msgId,
    result: "error",
  };
}

function controlRequestForward(cardId: CardId): Record<string, unknown> {
  return {
    type: "control_request_forward",
    tug_session_id: sessionIdFor(cardId),
    request_id: `${cardId}-perm-1`,
    is_question: false,
    tool_name: "Bash",
    input: { command: "ls" },
  };
}

function wireError(cardId: CardId): Record<string, unknown> {
  return {
    type: "error",
    tug_session_id: sessionIdFor(cardId),
    message: "synthetic wire error",
    recoverable: false,
  };
}

function replayStarted(cardId: CardId): Record<string, unknown> {
  return { type: "replay_started", tug_session_id: sessionIdFor(cardId) };
}

// ---------------------------------------------------------------------------
// Zone readers — scoped to one card's DOM subtree.
// ---------------------------------------------------------------------------

/** Z5 — the submit button's `data-mode` (the matrix's Z5 column). */
function submitButtonMode(app: App, cardId: CardId): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function(){
      var el = document.querySelector(
        '[data-card-id="${cardId}"] .tug-prompt-entry-submit-button');
      return el ? el.getAttribute("data-mode") : null;
    })()`,
  );
}

/** Z2 — the status row's STATE-cell value text (the human-readable phase). */
function stateCellLabel(app: App, cardId: CardId): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function(){
      var cell = document.querySelector(
        '[data-card-id="${cardId}"] [data-priority="state"] .session-telemetry-status-value');
      return cell ? cell.textContent : null;
    })()`,
  );
}

/** Count of transcript ghost rows (queued, not-yet-sent user rows). */
function ghostRowCount(app: App, cardId: CardId): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll(
      '[data-card-id="${cardId}"] [data-slot="session-transcript-ghost-row"]').length`,
  );
}

/** The body text of each ghost row, in DOM (submit) order. */
function ghostRowTexts(app: App, cardId: CardId): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.from(document.querySelectorAll(
      '[data-card-id="${cardId}"] [data-slot="session-transcript-ghost-row"] [data-testid="session-card-transcript-user-body"]'
    )).map(function (el) { return (el.textContent || "").trim(); })`,
  );
}

/** Wait until card `cardId` has exactly `n` transcript ghost rows. */
async function waitForGhostRowCount(
  app: App,
  cardId: CardId,
  n: number,
): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelectorAll(
      '[data-card-id="${cardId}"] [data-slot="session-transcript-ghost-row"]').length === ${n}`,
    { timeoutMs: 5000 },
  );
}

/** Count of committed transcript user rows. */
function committedUserRowCount(app: App, cardId: CardId): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll(
      '[data-card-id="${cardId}"] [data-testid="session-card-transcript-user-body"]').length`,
  );
}

/** Wait until card `cardId`'s submit button reaches `mode`. */
async function waitForSubmitMode(
  app: App,
  cardId: CardId,
  mode: string,
): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector(
        '[data-card-id="${cardId}"] .tug-prompt-entry-submit-button');
      return el !== null && el.getAttribute("data-mode") === ${JSON.stringify(mode)};
    })()`,
    { timeoutMs: 5000 },
  );
}

// ---------------------------------------------------------------------------
// Mount — seed the deck, bind every card's session, wait for the
// status rows to paint.
// ---------------------------------------------------------------------------

async function mountAllCards(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  for (const id of CARD_IDS) {
    await app.waitForCondition<boolean>(
      `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("${id}")`,
    );
    await app.bindSession(id, { tugSessionId: sessionIdFor(id) });
  }
  // Each card's Z2 status row paints once `SessionCardBody` mounts.
  for (const id of CARD_IDS) {
    await app.waitForCondition<boolean>(
      `document.querySelector(
        '[data-card-id="${id}"] [data-slot="session-telemetry-status-row"]') !== null`,
      { timeoutMs: 8000 },
    );
  }
}

// ---------------------------------------------------------------------------
// The matrix sweep
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)(
  "AT0084: session-card lifecycle state-to-zone matrix",
  () => {
    test(
      "every matrix row and cancellation gesture paints the zones the matrix specifies",
      async () => {
        const app = await launchTugApp({
          testName: "at0084-session-lifecycle-coordination",
        });
        try {
          await mountAllCards(app);

          // --- Card A: IDLE → STREAMING → TOOL_WORK → COMPLETE -------
          // IDLE — a freshly-bound card, no turn, empty transcript.
          expect(
            await submitButtonMode(app, "A"),
            "IDLE: Z5 is an enabled Submit",
          ).toBe("submit");
          expect(
            await stateCellLabel(app, "A"),
            "IDLE: Z2 STATE cell reads Idle",
          ).toBe("Idle");

          // STREAMING — a submit plus two text deltas (the count ladder
          // `submitting → awaiting_first_token → streaming`).
          await app.driveSession("A", { op: "send", text: "hello" });
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: assistantText("A", "msg-A", "Hel", 0),
          });
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: assistantText("A", "msg-A", "Hello", 1),
          });
          await waitForSubmitMode(app, "A", "stop");
          expect(
            await stateCellLabel(app, "A"),
            "STREAMING: Z2 STATE cell reads Streaming",
          ).toBe("Streaming");

          // TOOL_WORK — a tool_use on the running turn.
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: toolUse("A", "msg-A", "Bash"),
          });
          await app.waitForCondition<boolean>(
            `(function(){
              var c = document.querySelector(
                '[data-card-id="A"] [data-priority="state"] .session-telemetry-status-value');
              return c !== null && c.textContent === "Working";
            })()`,
            { timeoutMs: 5000 },
          );
          expect(
            await submitButtonMode(app, "A"),
            "TOOL_WORK: Z5 is still Stop",
          ).toBe("stop");

          // COMPLETE — turn_complete(success) commits the turn.
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: turnCompleteSuccess("A", "msg-A"),
          });
          await waitForSubmitMode(app, "A", "submit");
          expect(
            await stateCellLabel(app, "A"),
            "COMPLETE: Z2 STATE cell returns to Idle",
          ).toBe("Idle");
          expect(
            await committedUserRowCount(app, "A"),
            "COMPLETE: Z1 — one committed turn in the transcript",
          ).toBe(1);

          // --- Card B: AWAITING_USER --------------------------------
          await app.driveSession("B", { op: "send", text: "run a tool" });
          await app.driveSession("B", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: controlRequestForward("B"),
          });
          await waitForSubmitMode(app, "B", "awaiting-user");
          expect(
            await stateCellLabel(app, "B"),
            "AWAITING_USER: Z2 STATE cell reads Awaiting",
          ).toBe("Awaiting");

          // --- Card C: QUEUED_NEXT_TURN + Stop-peel + C1 (✕) --------
          // A submit, one delta to reach a live phase, then two
          // mid-turn submits — each queues and paints a ghost row.
          await app.driveSession("C", { op: "send", text: "first" });
          await app.driveSession("C", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: assistantText("C", "msg-C", "working", 0),
          });
          await app.driveSession("C", { op: "send", text: "queued-1" });
          await app.driveSession("C", { op: "send", text: "queued-2" });
          await waitForGhostRowCount(app, "C", 2);
          expect(
            await ghostRowCount(app, "C"),
            "QUEUED_NEXT_TURN: one ghost row per queued send",
          ).toBe(2);
          expect(
            await submitButtonMode(app, "C"),
            "QUEUED_NEXT_TURN: the primary Z5 button stays Stop",
          ).toBe("stop");

          // The Stop button peels the newest cancellable thing — with
          // the queue non-empty that is the most-recent queued send
          // (LIFO), not the running turn. "queued-2" goes; "queued-1"
          // stays; the turn keeps running. (Esc invokes the identical
          // `peelNewest()` path — see `code-session-store.queue.test`.)
          await app.click('[data-card-id="C"] .tug-prompt-entry-submit-button');
          await waitForGhostRowCount(app, "C", 1);
          expect(
            await ghostRowTexts(app, "C"),
            "Stop peels LIFO — the newest queued send goes first",
          ).toEqual(["queued-1"]);
          expect(
            await submitButtonMode(app, "C"),
            "the peel hit the queue, not the turn — Z5 stays Stop",
          ).toBe("stop");

          // C1 — the ghost row's ✕ un-sends that one queued message.
          await app.click(
            '[data-card-id="C"] [data-slot="session-transcript-ghost-row"] ' +
              '[data-slot="tug-icon-button"]',
          );
          await waitForGhostRowCount(app, "C", 0);
          expect(
            await ghostRowCount(app, "C"),
            "C1: the ✕ removed the last queued send",
          ).toBe(0);

          // --- Card D: ERRORED --------------------------------------
          await app.driveSession("D", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: wireError("D"),
          });
          await app.waitForCondition<boolean>(
            `(function(){
              var c = document.querySelector(
                '[data-card-id="D"] [data-priority="state"] .session-telemetry-status-value');
              return c !== null && c.textContent === "Error";
            })()`,
            { timeoutMs: 5000 },
          );
          expect(
            await submitButtonMode(app, "D"),
            "ERRORED: Z5 is an enabled Submit (the user may retry)",
          ).toBe("submit");

          // --- Card E: REPLAYING ------------------------------------
          await app.driveSession("E", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: replayStarted("E"),
          });
          await waitForSubmitMode(app, "E", "restoring");
          expect(
            await stateCellLabel(app, "E"),
            "REPLAYING: Z2 STATE cell reads Restoring",
          ).toBe("Restoring");

          // --- Card F: TRANSPORT_DOWN -------------------------------
          // The wire goes offline on an idle card: Z5 becomes the inert
          // Reconnecting mode, overriding the base state.
          await app.driveSession("F", { op: "transportClose" });
          await waitForSubmitMode(app, "F", "reconnecting");

          // --- Card G: C2 — CASE A pull-down ------------------------
          // A submit with no answer content yet; interrupt pulls it
          // back to idle with no committed turn — a clean un-send.
          await app.driveSession("G", { op: "send", text: "pull me back" });
          await waitForSubmitMode(app, "G", "stop");
          await app.driveSession("G", { op: "interrupt" });
          await waitForSubmitMode(app, "G", "submit");
          expect(
            await stateCellLabel(app, "G"),
            "CASE A: Z2 STATE cell returns to Idle",
          ).toBe("Idle");
          expect(
            await committedUserRowCount(app, "G"),
            "CASE A: no committed turn — a clean pull-down",
          ).toBe(0);

          // --- Card H: C3 — CASE B interrupt ------------------------
          // A submit plus an answer-channel delta crosses into CASE B;
          // interrupt + the wire's turn_complete(error) commits one
          // interrupted turn.
          await app.driveSession("H", { op: "send", text: "interrupt me" });
          await app.driveSession("H", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: assistantText("H", "msg-H", "partial", 0),
          });
          await waitForSubmitMode(app, "H", "stop");
          await app.driveSession("H", { op: "interrupt" });
          await app.driveSession("H", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: turnCompleteError("H", "msg-H"),
          });
          await waitForSubmitMode(app, "H", "submit");
          expect(
            await committedUserRowCount(app, "H"),
            "CASE B: the interrupted turn commits one transcript row",
          ).toBe(1);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
