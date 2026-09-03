/**
 * at0211-btw-side-question-overlay.test.ts — `/btw` opens the side-question
 * placard and the exchange leaves the transcript untouched ([P02]/[P05],
 * arc/add-btw.md).
 *
 * A side question is answered from the live conversation with no tools and
 * MUST NOT enter the transcript. Tug renders it as the `/btw` body inside the
 * shared Z2 `TugPlacard` (in-DOM, just above the status row), fed by a
 * dedicated `SideQuestionStore` whose `side_question_answer` frame is
 * deliberately absent from `KNOWN_CODE_OUTPUT_TYPES` — so the code-session
 * (transcript) store drops it.
 *
 * This standard-tier test drives one committed turn (so the transcript has
 * entries to count), types `/btw <question>` and submits, and asserts:
 *   1. the placard opens (a side-question row appears), above Z2, within the
 *      card, and right-aligned to the strip rather than centred under a cell;
 *   2. the transcript entry count is UNCHANGED across the whole `/btw`
 *      exchange — the ask, and the settled answer (injected as a
 *      `side_question_answer` frame);
 *   3. the placard AUTO-DISMISSES — a click away closes it (there is no `×`);
 *      a bare `/btw` reopens it onto the same history (the only door back, now
 *      that the BTW cell is gone); and
 *   4. it is ONE-AT-A-TIME — opening a log cell (TIME) while `/btw` is open
 *      swaps the placard rather than stacking a second one.
 *
 * The mid-turn + reload-clean behaviors are covered against real claude in
 * the Step 6/7 tiers; here the answer is injected so the surface + the
 * transcript-invisibility invariant are proven without a live model.
 *
 * @covers tugdeck/src/lib/side-question-store.ts
 * @covers tugdeck/src/components/tugways/cards/side-question-overlay.tsx
 * @covers tugcode/
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx
 * @covers tugdeck/src/components/tugways/tug-popup-list.tsx
 * @covers tugdeck/src/components/tugways/tug-transcript-entry.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0211";
const FEED_CODE_OUTPUT = 0x40;

const PROMPT = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';
const TRANSCRIPT_ENTRIES = '[data-card-id="A"] [data-slot="tug-transcript-entry"]';
const SIDE_Q_ASK = '.side-question-question';
const SIDE_Q_ANSWER = '.side-question-answer';
// The `/btw` body inside the shared Z2 placard — its presence means the btw
// placard is open.
const SIDE_Q_BODY = '[data-card-id="A"] [data-slot="side-question-body"]';
/** One answered ask inside the placard body — the history it reopens onto. */
const SIDE_Q_ROW = '[data-card-id="A"] .side-question-exchange';
const TIME_CELL = '[data-card-id="A"] .session-telemetry-status-cell[data-priority="time"]';
const POPUP_LIST = '[data-card-id="A"] [data-slot="tug-popup-list"]';

let dir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  dir = mkdtempSync(join(tmpdir(), "at0211-"));
});

afterAll(() => {
  if (dir !== "" && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session A", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 820, height: 640 },
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

describe.skipIf(!SHOULD_RUN)(
  "AT0211: `/btw` opens the side-question overlay and never touches the transcript",
  () => {
    test(
      "a /btw ask + settled answer leaves the transcript entry count unchanged",
      async () => {
        const app = await launchTugApp({
          testName: "at0211-btw-side-question-overlay",
        });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );

          await app.bindSession("A", { tugSessionId: SID, projectDir: dir });
          await app.awaitEngineReady("A");

          // One committed turn so the transcript has entries to count.
          await app.driveSession("A", { op: "send", text: "hello" });
          const frame = (decoded: Record<string, unknown>) =>
            app.driveSession("A", {
              op: "ingestFrame",
              feedId: FEED_CODE_OUTPUT,
              decoded: { tug_session_id: SID, ...decoded },
            });
          await frame({ type: "prompt_anchor", promptUuid: "uuid-1" });
          await frame({
            type: "content_block_start",
            msg_id: "m1",
            block_index: 0,
            kind: "text",
          });
          await frame({
            type: "assistant_text",
            msg_id: "m1",
            block_index: 0,
            text: "hi there",
            is_partial: false,
          });
          await frame({ type: "turn_complete", msg_id: "m1", result: "success" });

          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(PROMPT)}) !== null`,
            { timeoutMs: 8000 },
          );

          const countEntries = () =>
            app.evalJS<number>(
              `document.querySelectorAll(${JSON.stringify(TRANSCRIPT_ENTRIES)}).length`,
            );
          const baseline = await countEntries();
          expect(baseline).toBeGreaterThan(0); // the committed turn rendered

          // There is no BTW cell: the Z2 diet removed it, and `/btw` reaches
          // its placard by being asked rather than by a stop on the strip.
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll('[data-card-id="A"] .session-telemetry-status-cell[data-priority="btw"]').length`,
            ),
          ).toBe(0);

          // Type `/btw <question>` and submit. Escape first dismisses any
          // open completion menu; Cmd+Return is the editor's forced submit.
          await app.nativeClickAtElement(PROMPT);
          await app.nativeType("/btw what did I just say");
          await new Promise((r) => setTimeout(r, 200));
          await app.nativeKey("Escape");
          await new Promise((r) => setTimeout(r, 200));
          await app.nativeKey("Enter", ["cmd"]);

          // The overlay opens with the ask (loading pose).
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(SIDE_Q_ASK)}) !== null`,
            { timeoutMs: 6000 },
          );

          // The ask must not have added a transcript entry.
          const afterAsk = await countEntries();
          expect(afterAsk).toBe(baseline);

          // Positioning ([P02]/[P06]): the placard floats ABOVE the Z2 status
          // row (never overlapping it), stays WITHIN the card's horizontal
          // bounds, and is RIGHT-ALIGNED to the strip rather than centred under
          // a cell — the re-anchor the Z2 diet forced, since the BTW cell it
          // used to hang from no longer exists. Measured against the live layout
          // so a regression (an in-flow anchor that displaces the status cells,
          // a placard escaping the card, or a silent slide back to centring)
          // fails here rather than only in the eye. The Z2 status bar spans the
          // card's content width, so it is the reliable reference.
          const geom = await app.evalJS<{
            paneLeft: number;
            paneRight: number;
            paneBottom: number;
            z2Top: number;
            z2Left: number;
            z2Right: number;
            z2Width: number;
          } | null>(
            `(() => {
               const pane = document.querySelector('.tug-placard');
               const z2 = document.querySelector('[data-card-id="A"] [data-slot="session-card-status-bar"]');
               if (!pane || !z2) return null;
               const p = pane.getBoundingClientRect();
               const s = z2.getBoundingClientRect();
               return { paneLeft: p.left, paneRight: p.right, paneBottom: p.bottom, z2Top: s.top, z2Left: s.left, z2Right: s.right, z2Width: s.width };
             })()`,
          );
          expect(geom).not.toBeNull();
          // Bottom sits above Z2 (no overlap; a small fudge for sub-pixel).
          expect(geom!.paneBottom).toBeLessThanOrEqual(geom!.z2Top + 1);
          // Within the card horizontally (never escaping left or right).
          expect(geom!.paneLeft).toBeGreaterThanOrEqual(geom!.z2Left - 1);
          expect(geom!.paneRight).toBeLessThanOrEqual(geom!.z2Right + 1);
          // Right-aligned to the strip: its right edge sits at the strip's own,
          // less the placard's inset from it. Stated as "much nearer the right
          // edge than the left" rather than an exact offset, so the inset stays
          // a styling detail — what is pinned is the anchor's SIDE, which is
          // what the re-anchor changed.
          expect(geom!.z2Right - geom!.paneRight).toBeLessThan(
            geom!.paneLeft - geom!.z2Left,
          );
          // Z2 is intact — the status row spans a real card width, proving the
          // placard did not collapse or displace the status cells.
          expect(geom!.z2Width).toBeGreaterThan(600);

          // Settle the answer (the shape the probe pinned) through the real
          // SideQuestionStore. The store minted `btw-1` for the first ask.
          // (The `side_question_answer` frame is intentionally absent from
          // KNOWN_CODE_OUTPUT_TYPES, so the codeSessionStore ingest path can't
          // deliver it — the dedicated store settles it instead.)
          await app.ingestSideQuestionAnswer("A", {
            type: "side_question_answer",
            request_id: "btw-1",
            answer: "You said: hello",
            synthetic: false,
          });

          // The overlay shows the settled answer...
          await app.waitForCondition<boolean>(
            `Array.from(document.querySelectorAll(${JSON.stringify(SIDE_Q_ANSWER)})).some((el) => el.textContent && el.textContent.indexOf("You said: hello") !== -1)`,
            { timeoutMs: 6000 },
          );

          // ...and the transcript is STILL unchanged (the [P05] invariant).
          const afterAnswer = await countEntries();
          expect(afterAnswer).toBe(baseline);

          // Auto-dismiss ([P05]/[Q01]): clicking away (into the editor) closes
          // the placard — there is no `×` on an auto-dismiss placard, and it no
          // longer survives losing focus the way the retired pinned pane did.
          await app.nativeClickAtElement(PROMPT);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(SIDE_Q_BODY)}) === null`,
            { timeoutMs: 4000 },
          );

          // The exchange survives the dismiss (the store is untouched), and a
          // BARE `/btw` reopens the placard onto that same history. With the
          // cell gone this is the only door back, so it is the one the test
          // drives.
          await app.nativeClickAtElement(PROMPT);
          await app.nativeType("/btw");
          await new Promise((r) => setTimeout(r, 200));
          await app.nativeKey("Escape");
          await new Promise((r) => setTimeout(r, 200));
          await app.nativeKey("Enter", ["cmd"]);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(SIDE_Q_BODY)}) !== null`,
            { timeoutMs: 4000 },
          );
          // …onto the history, not a blank placard: the earlier exchange is
          // still the thing being shown.
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll(${JSON.stringify(SIDE_Q_ROW)}).length`,
            ),
          ).toBeGreaterThan(0);

          // One-at-a-time ([P05]): opening the TIME cell while `/btw` is open
          // SWAPS the placard — the `/btw` body is gone, the TIME log popup is
          // shown, and exactly one placard is mounted (never stacked).
          await app.nativeClickAtElement(TIME_CELL);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(POPUP_LIST)}) !== null`,
            { timeoutMs: 4000 },
          );
          const swap = await app.evalJS<string>(
            `JSON.stringify({
               btwGone: document.querySelector(${JSON.stringify(SIDE_Q_BODY)}) === null,
               placards: document.querySelectorAll('[data-card-id="A"] .tug-placard').length,
             })`,
          );
          const swapped = JSON.parse(swap);
          expect(swapped.btwGone).toBe(true);
          expect(swapped.placards).toBe(1);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
