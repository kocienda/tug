/**
 * AT0757 — a base-motion notice is a receipt in the transcript.
 *
 * When the base moves under a bound arc, tugcast's base-motion engine replays
 * the arc and tells the session: a `tug_notice` opener beside an injected
 * turn. The notice carries the outcome twice — as words the agent reads, and
 * as facts the deck draws. With the facts present, the transcript draws a
 * block with the replay's identity, its counts, its notice band and its
 * files; the quiet `tug-notice` line it used to be is not drawn for that turn.
 *
 * The frame is fed to the real deck's session store exactly as tugcast sends
 * it. Whether the engine sends it is pinned in tugcast's own tests, against
 * real repositories, where the replayed and stopped facts are both read back
 * off the wire; what only the app can show is that the deck turns them into
 * the receipt rather than a line.
 *
 * @covers tugdeck/src/components/tugways/cards/base-motion-receipt-block.tsx
 * @covers tugdeck/src/components/tugways/cards/base-motion-receipt-block.css
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugproto/src/outbound-decoders.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0757-session";
const CODE_OUTPUT_FEED = 0x40;

const RECEIPT = '[data-slot="base-motion-receipt-replayed"]';
const NOTICE_LINE = '[data-slot="tug-notice"]';

const FACTS = {
  kind: "replayed",
  arc: "at0757-arc",
  base: "main",
  sha: "fd5978f4e0123456789abcdef0123456789abcde",
  paths: ["src/moved.rs", "docs/notes.md"],
  rounds: 3,
};

async function seed(app: App): Promise<void> {
  await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
  await app.bindSession("A", { tugSessionId: SID });
  await app.awaitEngineReady("A", { timeoutMs: 30_000 });
}

describe.skipIf(!SHOULD_RUN)("at0757: the base-motion notice is a receipt", () => {
  test(
    "a replayed notice with facts draws the receipt block and no notice line",
    async () => {
      const app = await launchTugApp({ testName: "at0757-base-motion-receipt" });
      try {
        await seed(app);
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: CODE_OUTPUT_FEED,
          decoded: {
            type: "tug_notice",
            tug_session_id: SID,
            origin: "base-motion",
            text: 'Arc "at0757-arc" was replayed onto main at fd5978f4e while you were between turns.',
            facts: FACTS,
          },
        });
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(RECEIPT)}) !== null`,
          { timeoutMs: 10_000 },
        );
        const reading = await app.body("A").evalJS<{
          identity: string;
          rows: number;
          notice: string;
          lines: number;
        }>(
          `(function(){
            var r = document.querySelector(${JSON.stringify(RECEIPT)});
            return {
              identity: r.textContent || "",
              rows: r.querySelectorAll(".arc-fold-row").length,
              notice: (r.querySelector('[data-slot="tool-block-notice"]') || {}).textContent || "",
              lines: document.querySelectorAll(${JSON.stringify(NOTICE_LINE)}).length,
            };
          })()`,
        );
        note(`at0757 receipt: ${JSON.stringify(reading)}`);
        expect(reading.identity, "it names the arc").toContain("^at0757-arc");
        expect(reading.identity, "and the short base head").toContain("fd5978f");
        expect(reading.rows, "one row per file the base brought in").toBe(2);
        expect(reading.notice, "the band says nothing is asked").toContain("No action is required");
        expect(reading.lines, "the quiet notice line is not drawn for this turn").toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
