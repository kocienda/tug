/**
 * at0832-run-offer-stream.test.ts — a runnable offer's output appears as it
 * is produced, grows to a cap, then scrolls inside itself at its tail.
 *
 * A committed assistant turn carries a `tugrun` fence whose command writes
 * forty lines, waits, and writes one more. Its Play is pressed and the
 * command runs through the card's real shell session, so the pieces the test
 * reads are the ones tugcast gathered and sent. Three things only the
 * running app can show:
 *
 *   1. **Output arrives before the command ends.** While the offer still
 *      reads `running`, the forty lines are already under the command.
 *   2. **The result stops growing at its cap.** The output is taller than the
 *      box it is shown in, and the box is about twenty lines high.
 *   3. **The box shows its tail.** It sits at its foot while the command
 *      runs, and again once the last line has landed and the run has settled.
 *
 * @covers tugdeck/src/lib/markdown/enhance-run-offer.ts
 * @covers tugdeck/src/lib/run-offer-store.ts
 * @covers tugdeck/src/lib/shell-session-store.ts
 * @covers tugdeck/styles/tugx-md.css
 * @covers tugrust/crates/tugcast/src/feeds/shell.rs
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, type App } from "./_harness";
import { sessionCardShape, SESSION_CARD_SIZE_SHORT } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const SID = "a7c0d1ea-0000-4000-8000-000000000832";
const FEED_CODE_OUTPUT = 0x40;

const CARD = '[data-card-id="A"]';
const FRAME = `${CARD} .tugx-md-run`;
const PLAY = `${FRAME} .tugx-md-run-play`;

const LINES = 40;
const TAIL = "stream-tail-mark";
const COMMAND = `seq 1 ${LINES}; sleep 2; echo ${TAIL}`;
const REPLY = "Run this:\n\n```tugrun\n" + COMMAND + "\n```\n";

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0832-proj-")));
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

interface StreamFacts {
  tone: string;
  /** The output's last line, as drawn. */
  lastLine: string;
  /** How many lines the output holds. */
  lines: number;
  /** The box's visible height over one line's height. */
  shownLines: number;
  /** Whether the output is taller than the box it is shown in. */
  overflows: boolean;
  /** How far the box sits from its foot, in px. */
  fromTail: number;
}

function streamFacts(app: App): Promise<StreamFacts> {
  return app.body("A").evalJS<StreamFacts>(
    `(function(){
      var result = document.querySelector(${JSON.stringify(`${FRAME} .tugx-md-run-result`)});
      var out = result ? result.querySelector(".tugx-md-run-output") : null;
      if (out === null) {
        return { tone: result ? (result.getAttribute("data-tone") || "") : "",
                 lastLine: "", lines: 0, shownLines: 0, overflows: false, fromTail: -1 };
      }
      var text = out.textContent.split("\\n");
      var cs = getComputedStyle(out);
      var pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      var lineHeight = parseFloat(cs.lineHeight);
      return {
        tone: result.getAttribute("data-tone") || "",
        lastLine: text[text.length - 1],
        lines: text.length,
        shownLines: (out.clientHeight - pad) / lineHeight,
        overflows: out.scrollHeight > out.clientHeight + 1,
        fromTail: out.scrollHeight - out.clientHeight - out.scrollTop,
      };
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0832: a runnable offer's output streams into a capped box", () => {
  test("output arrives while running, the box caps at its line count, and it shows its tail", async () => {
    const app = await launchTugApp({ testName: "at0832-run-offer-stream" });
    try {
      await app.seedDeckState({
        state: sessionCardShape(SESSION_CARD_SIZE_SHORT, { title: "Session A" }),
        focusCardId: "A",
      });
      await app.waitForCondition<boolean>(
        `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
      );
      await app.bindSession("A", { tugSessionId: SID, projectDir });
      await app.awaitEngineReady("A");

      // --- A committed turn whose reply offers the command. ---
      await app.driveSession("A", { op: "send", text: "show me" });
      const frame = (decoded: Record<string, unknown>) =>
        app.driveSession("A", {
          op: "ingestFrame",
          feedId: FEED_CODE_OUTPUT,
          decoded: { tug_session_id: SID, ...decoded },
        });
      await frame({ type: "prompt_anchor", promptUuid: "uuid-1" });
      await frame({ type: "content_block_start", msg_id: "m1", block_index: 0, kind: "text" });
      await frame({
        type: "assistant_text",
        seq: 0,
        rev: 0,
        status: "complete",
        msg_id: "m1",
        block_index: 0,
        text: REPLY,
        is_partial: false,
      });
      await frame({ type: "turn_complete", seq: 0, msg_id: "m1", result: "success" });
      await app.body("A").waitForCondition<boolean>(
        `(function(){
          var play = document.querySelector(${JSON.stringify(PLAY)});
          return play !== null && !play.disabled;
        })()`,
        { timeoutMs: 8000 },
      );

      // --- The press; the forty lines land while the command still sleeps. ---
      await app.body("A").nativeClickAtElement(PLAY);
      await app.body("A").waitForCondition<boolean>(
        `(function(){
          var out = document.querySelector(${JSON.stringify(`${FRAME} .tugx-md-run-output`)});
          if (out === null) return false;
          var text = out.textContent.split("\\n");
          return text[text.length - 1] === ${JSON.stringify(String(LINES))};
        })()`,
        { timeoutMs: 20_000 },
      );
      const running = await streamFacts(app);
      expect(running.tone, "the lines are under the command before it has ended").toBe("running");
      expect(running.lines).toBe(LINES);
      expect(running.overflows, "forty lines are more than the box shows").toBe(true);
      expect(running.shownLines, "the box is about twenty lines high").toBeGreaterThan(19);
      expect(running.shownLines).toBeLessThan(21);
      expect(running.fromTail, "the box sits at its foot while running").toBeLessThanOrEqual(4);

      // --- The last line lands and the run settles, still at its tail. ---
      await app.body("A").waitForCondition<boolean>(
        `(function(){
          var result = document.querySelector(${JSON.stringify(`${FRAME} .tugx-md-run-result`)});
          return result !== null && result.getAttribute("data-tone") === "ok";
        })()`,
        { timeoutMs: 20_000 },
      );
      const settled = await streamFacts(app);
      expect(settled.lastLine, "the settle carries the whole output").toBe(TAIL);
      expect(settled.lines).toBe(LINES + 1);
      expect(settled.shownLines).toBeLessThan(21);
      expect(settled.fromTail, "the box followed the last line to its foot").toBeLessThanOrEqual(4);
    } finally {
      await app.close();
    }
  });
});
