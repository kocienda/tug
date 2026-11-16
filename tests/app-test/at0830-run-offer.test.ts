/**
 * at0830-run-offer.test.ts — pressing Play on a runnable offer runs it, and
 * the result is read under the command.
 *
 * An assistant turn carrying a `tugrun` fence is streamed into a Session
 * card. The fence draws as an offer frame with a Play control, and the test
 * holds it to four things only the running app can show:
 *
 *   1. **Play waits for the turn.** While the turn is still open the control
 *      is on screen and disabled: the command is not final until the turn is.
 *   2. **A press runs the command.** A native click on Play sends the command
 *      through the card's real shell session — tugcast's shell child executes
 *      it — with no confirmation in between.
 *   3. **The result attaches under the command.** The output, the exit and
 *      the directory it ran in appear inside the offer's own frame.
 *   4. **No turn is minted.** The transcript gains no shell row: the result is
 *      read where the command was offered, not at the foot of the transcript.
 *
 * @covers tugdeck/src/lib/markdown/enhance-run-offer.ts
 * @covers tugdeck/src/lib/run-offer-binding.ts
 * @covers tugdeck/src/lib/run-offer-store.ts
 * @covers tugdeck/src/components/tugways/cards/use-run-offers.ts
 * @covers tugdeck/src/lib/shell-session-store.ts
 * @covers tugrust/crates/tugcast/src/feeds/shell.rs
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp } from "./_harness";
import { sessionCardShape, SESSION_CARD_SIZE_SHORT } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const SID = "a7c0d1ea-0000-4000-8000-000000000830";
const FEED_CODE_OUTPUT = 0x40;

const CARD = '[data-card-id="A"]';
const FRAME = `${CARD} .tugx-md-run`;
const PLAY = `${FRAME} .tugx-md-run-play`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;

const MARK = "offer-ran-here";
const REPLY = "Run this to check:\n\n```tugrun\necho " + MARK + "\n```\n";

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  // realpath: the shell reports the resolved path as the directory it ran in.
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0830-proj-")));
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

interface OfferFacts {
  frames: number;
  playShown: boolean;
  playDisabled: boolean;
  pose: string;
  command: string;
  tone: string;
  output: string;
  status: string;
  cwd: string;
  shellRows: number;
}

describe.skipIf(!SHOULD_RUN)("AT0830: a runnable offer runs in place", () => {
  test("Play waits for the turn, runs the command, and the result lands under it", async () => {
    const app = await launchTugApp({ testName: "at0830-run-offer" });
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

      const facts = (): Promise<OfferFacts> =>
        app.body("A").evalJS<OfferFacts>(
          `(function(){
            var frames = document.querySelectorAll(${JSON.stringify(FRAME)});
            var frame = frames[0] || null;
            var q = function(sel){ return frame ? frame.querySelector(sel) : null; };
            var play = q(".tugx-md-run-play");
            var text = function(sel){ var el = q(sel); return el ? el.textContent : ""; };
            var result = q(".tugx-md-run-result");
            return {
              frames: frames.length,
              playShown: play !== null && getComputedStyle(play).display !== "none",
              playDisabled: play !== null && play.disabled,
              pose: play ? (play.getAttribute("data-pose") || "") : "",
              command: text(".tugx-md-run-row > pre > code").trim(),
              tone: result ? (result.getAttribute("data-tone") || "") : "",
              output: text(".tugx-md-run-output"),
              status: text(".tugx-md-run-status"),
              cwd: text(".tugx-md-run-cwd"),
              shellRows: document.querySelectorAll(${JSON.stringify(SHELL_ROWS)}).length,
            };
          })()`,
        );

      // --- A turn whose reply offers a command, left open. ---
      await app.driveSession("A", { op: "send", text: "how do I check it" });
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
      await app.body("A").waitForCondition<boolean>(
        `document.querySelector(${JSON.stringify(PLAY)}) !== null`,
        { timeoutMs: 8000 },
      );

      const open = await facts();
      expect(open.frames, "one offer frame").toBe(1);
      expect(open.command).toBe(`echo ${MARK}`);
      expect(open.playShown, "the transcript adopts the frame, so Play shows").toBe(true);
      expect(open.playDisabled, "Play is disabled while the turn is open").toBe(true);
      expect(open.tone, "no result before a run").toBe("");

      // --- The turn finishes: the command is final, and Play goes live. ---
      await frame({ type: "turn_complete", seq: 0, msg_id: "m1", result: "success" });
      await app.body("A").waitForCondition<boolean>(
        `(function(){
          var play = document.querySelector(${JSON.stringify(PLAY)});
          return play !== null && !play.disabled;
        })()`,
        { timeoutMs: 8000 },
      );

      // --- One press runs it through the real shell. ---
      await app.body("A").nativeClickAtElement(PLAY);
      await app.body("A").waitForCondition<boolean>(
        `(function(){
          var result = document.querySelector(${JSON.stringify(`${FRAME} .tugx-md-run-result`)});
          return result !== null && result.getAttribute("data-tone") !== "running";
        })()`,
        { timeoutMs: 20_000 },
      );

      const ran = await facts();
      expect(ran.frames, "still one frame").toBe(1);
      expect(ran.output, "the command's output is under the command").toContain(MARK);
      expect(ran.tone).toBe("ok");
      expect(ran.status).toBe("exit 0");
      expect(ran.cwd, "the footer names the directory it ran in").toBe(projectDir);
      expect(ran.pose, "Stop gives way to Play once the run settles").toBe("play");
      expect(ran.playDisabled, "the shell is free, so the offer can run again").toBe(false);
      expect(ran.shellRows, "an offer's run mints no transcript turn").toBe(0);
    } finally {
      await app.close();
    }
  });
});
