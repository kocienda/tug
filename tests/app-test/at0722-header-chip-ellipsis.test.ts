/**
 * at0722-header-chip-ellipsis.test.ts — a long file name in a tool-call
 * header's chip identity ellipsizes instead of running into the trailing
 * cluster.
 *
 * A Read / Edit / Write header seats its file as a `TugAtomRef`, one
 * `nowrap` run in the header's detail column. The column shrinks
 * (`min-width: 0`), but the run inside it did not, so a long name (a
 * `tugapp-screenshot-<uuid>.png`) painted straight over the timing badge
 * and the actions. The chip is now capped at the column's width and clips
 * its name with an ellipsis.
 *
 * Asserts, on a completed Read of a 130-character file name in a 900px
 * card:
 *  - **the chip is clipped**: its content is wider than its box, so the
 *    name is ellipsized rather than laid out whole;
 *  - **the chip stays in its column**: its right edge is inside the detail
 *    column's, and left of the first trailing section (the timing).
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/blocks/block-header.css
 * @covers tugdeck/src/components/tugways/tug-atom-ref.css
 * @covers tugdeck/src/components/tugways/cards/blocks/read-tool-block.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "test-session-A";

const CARD = '[data-card-id="A"]';
const HEADER = `${CARD} [data-tool-use-id="tc-read"] .tool-call-header`;

const LONG_NAME = `tugapp-screenshot-${"44D4DC4A-021F-46A7-976A-7DF7C7B66E40-".repeat(3)}long.png`;

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 640 },
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

type Harness = Awaited<ReturnType<typeof launchTugApp>>;

/** Seed one Session card, bind it, and ingest a completed long-named `Read`. */
async function mountLongRead(app: Harness): Promise<void> {
  const ingest = (decoded: unknown) =>
    app.driveSession("A", { op: "ingestFrame", feedId: CODE_OUTPUT_FEED, decoded });

  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
  await app.bindSession("A", { tugSessionId: SID, sessionMode: "resume" });

  await ingest({ type: "replay_started", tug_session_id: SID });
  await ingest({
    type: "add_user_message",
    tug_session_id: SID,
    content: [{ type: "text", text: "read the screenshot" }],
  });
  await ingest({
    type: "tool_use",
    tug_session_id: SID,
    msg_id: "m1",
    tool_use_id: "tc-read",
    tool_name: "Read",
    input: { file_path: `/tmp/at0722/${LONG_NAME}` },
    seq: 1,
  });
  await ingest({
    type: "tool_result",
    tug_session_id: SID,
    tool_use_id: "tc-read",
    output: "alpha\nbravo\n",
  });
  await ingest({ type: "turn_complete", tug_session_id: SID, msg_id: "m1", result: "success" });
  await ingest({
    type: "replay_complete",
    tug_session_id: SID,
    count: 1,
    firstLoadedTurnIndex: 0,
    totalTurns: 1,
    hasOlder: false,
  });

  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(`${HEADER} .tug-atom-ref`)}) !== null &&
     document.querySelector(${JSON.stringify(`${HEADER} .tool-call-header-timing`)}) !== null`,
    { timeoutMs: 12_000 },
  );
}

interface ChipReading {
  chipRight: number;
  chipScrollWidth: number;
  chipClientWidth: number;
  detailRight: number;
  timingLeft: number;
}

describe.skipIf(!SHOULD_RUN)("AT0722: a long header chip ellipsizes", () => {
  test(
    "the chip clips inside its column and clears the timing",
    async () => {
      const app = await launchTugApp({ testName: "at0722-header-chip-ellipsis" });
      try {
        await mountLongRead(app);

        const reading = JSON.parse(
          await app.evalJS<string>(
            `(function(){
               var h = document.querySelector(${JSON.stringify(HEADER)});
               var chip = h.querySelector(".tug-atom-ref");
               var detail = h.querySelector(".tool-call-header-detail");
               var timing = h.querySelector(".tool-call-header-timing");
               return JSON.stringify({
                 chipRight: chip.getBoundingClientRect().right,
                 chipScrollWidth: chip.scrollWidth,
                 chipClientWidth: chip.clientWidth,
                 detailRight: detail.getBoundingClientRect().right,
                 timingLeft: timing.getBoundingClientRect().left,
               });
             })()`,
          ),
        ) as ChipReading;
        note(`at0722 reading: ${JSON.stringify(reading)}`);

        expect(
          reading.chipScrollWidth,
          "the long name is wider than its chip, so it is clipped",
        ).toBeGreaterThan(reading.chipClientWidth);
        expect(
          reading.chipRight,
          "the chip stays inside the detail column",
        ).toBeLessThanOrEqual(reading.detailRight + 0.5);
        expect(
          reading.chipRight,
          "the chip ends left of the timing",
        ).toBeLessThanOrEqual(reading.timingLeft);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0722] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
