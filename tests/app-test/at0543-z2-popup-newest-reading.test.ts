/**
 * at0543-z2-popup-newest-reading.test.ts — a Z2 popup opens on the
 * newest thing it displays, never on the top of a stale list.
 *
 * ## Why this exists
 *
 * A Z2 cell is a live number, so the popup behind it is opened to see what
 * that number is saying *now*. A scroller left at its top is the one place a
 * long list does not say it: on a twenty-turn session the TIME log's visible
 * rows are all turns the session has long since finished, and the one whose
 * duration the cell is showing is below the fold.
 *
 * The two chronological logs (STATE, TIME) take `TugPopupListScroller`'s
 * `stickToBottom`, whose newest row is always its last. This pins TIME, the
 * one that runs through the shared `TugPopupListGrid` — the grid owns the
 * scroller its rows live in, so until it could forward `stickToBottom` there
 * was no way for a grid-shaped log to open anywhere but the top.
 *
 * The item lists (TASKS, JOBS, ARC) take `useRevealRow` instead, which centres
 * the row under way and falls back to the last row; `at0473-arc-cockpit` pins
 * that mechanism over the ARC placard's sixteen-step ledger.
 *
 * The vehicle is `driveSession`, which commits deterministic turns straight
 * into the store — no live claude, and no committed fixture is long enough to
 * overflow a ten-row cap. Twenty turns is comfortably over it.
 *
 * @covers tugdeck/src/components/tugways/tug-popup-list.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-popovers.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0543-session";
const FEED_CODE_OUTPUT = 0x40;

/** Turns to commit — over the log's `--tugx-popup-list-visible-rows: 10`. */
const TURNS = 20;

const CARD = '[data-card-id="A"]';
const USER_ROWS = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const Z2_TIME = `${CARD} [data-priority="time"]`;
const PLACARD = ".session-telemetry-status-placard";
const LOG_SCROLLER = `${PLACARD} .tug-popup-list-grid-scroller`;
const LOG_ROW = '[data-slot="tug-popup-list-row"]';

/** Distance from the bottom the scroller's own stick threshold allows. */
const STICK_TOLERANCE_PX = 8;

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
    ],
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

/** Commit one turn: a sent prompt, a text reply, and its `turn_complete`. */
async function buildTurn(app: App, i: number): Promise<void> {
  const msgId = `m-${i}`;
  const frame = (decoded: Record<string, unknown>): Promise<unknown> =>
    app.driveSession("A", {
      op: "ingestFrame",
      feedId: FEED_CODE_OUTPUT,
      decoded: { tug_session_id: SID, ...decoded },
    });
  await app.driveSession("A", { op: "send", text: `prompt ${i}` });
  await frame({
    type: "content_block_start",
    msg_id: msgId,
    block_index: 0,
    kind: "text",
  });
  await frame({
    type: "assistant_text",
    msg_id: msgId,
    block_index: 0,
    text: `reply ${i}`,
    is_partial: false,
  });
  await frame({ type: "turn_complete", msg_id: msgId, result: "success" });
}

describe.skipIf(!SHOULD_RUN)(
  "at0543: a Z2 popup opens on its newest row",
  () => {
    test(
      "the TIME log opens at the latest turn, not the first",
      async () => {
        const app = await launchTugApp({ testName: "at0543-z2-popup-newest" });
        try {
          // `isEngineReady` reads the deck trace, so the trace has to be on
          // before the card mounts its engine.
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          await app.bindSession("A", { tugSessionId: SID });
          await app.awaitEngineReady("A");

          for (let i = 1; i <= TURNS; i += 1) await buildTurn(app, i);
          // The transcript is windowed, so its DOM row count is not the turn
          // count; the wait that matters is the popup's own, below. This one
          // only says the drive is landing turns at all.
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length > 0`,
            { timeoutMs: 15000 },
          );

          // Open the TIME cell's placard by clicking the cell itself — the
          // same gesture the reader makes, and the one that mounts the popup
          // body fresh (the placard renders only while a surface is open).
          expect(
            await app.evalJS<boolean>(
              `(function(){
                var el = document.querySelector(${JSON.stringify(Z2_TIME)});
                if (el === null) return false;
                el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
                return true;
              })()`,
            ),
          ).toBe(true);
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(LOG_SCROLLER)});
              return el !== null &&
                el.querySelectorAll(${JSON.stringify(LOG_ROW)}).length === ${TURNS};
            })()`,
            { timeoutMs: 8000 },
          );

          const opened = await app.evalJS<{
            rows: number;
            scrollable: boolean;
            scrollTop: number;
            distanceFromBottom: number;
            firstVisibleIndex: number;
            lastRow: string;
            lastVisible: boolean;
          }>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(LOG_SCROLLER)});
              var rows = Array.from(el.querySelectorAll(${JSON.stringify(LOG_ROW)}));
              var box = el.getBoundingClientRect();
              var last = rows[rows.length - 1];
              var lastBox = last.getBoundingClientRect();
              return {
                rows: rows.length,
                scrollable: el.scrollHeight > el.clientHeight,
                scrollTop: el.scrollTop,
                distanceFromBottom: el.scrollHeight - (el.scrollTop + el.clientHeight),
                firstVisibleIndex: rows.findIndex(function(r){
                  return r.getBoundingClientRect().bottom > box.top + 1;
                }),
                lastRow: (last.textContent || "").trim(),
                lastVisible:
                  lastBox.bottom <= box.bottom + 1 && lastBox.top >= box.top - 1,
              };
            })()`,
          );
          note("at0543 TIME log on open", JSON.stringify(opened));

          // The premise: this log really does overflow its scroller. Without
          // it every assertion below would pass on a list that never had a
          // top to be stuck at, and the behaviour would be untested.
          expect(
            opened.scrollable,
            "a twenty-turn log overflows the ten-row cap",
          ).toBe(true);
          expect(opened.scrollTop).toBeGreaterThan(0);
          expect(
            opened.distanceFromBottom,
            "the log opens at its newest row",
          ).toBeLessThanOrEqual(STICK_TOLERANCE_PX);
          expect(opened.lastVisible, "the latest turn is in view").toBe(true);
          // And it is the log's tail that is showing, not merely some row of
          // it: the topmost row still in view is not the session's first turn.
          expect(opened.firstVisibleIndex).toBeGreaterThan(0);
          note("at0543 TIME placard", (await app.screenshot()).path);
        } finally {
          await app.quitGracefully();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
