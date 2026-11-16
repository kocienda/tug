/**
 * at0833-run-offer-terminal.test.ts — a runnable offer whose command needs a
 * terminal can be copied and nothing more.
 *
 * A committed assistant turn carries two `tugrun` fences: one that begins
 * with `sudo`, and an ordinary one beside it. The card's shell runs a
 * command with no terminal, so the first could only fail. What the running
 * app has to show:
 *
 *   1. **No Play on the offer that needs a terminal.** Its Play is not
 *      drawn, and its Copy is.
 *   2. **A note says why.** It sits in the frame, under the command, and
 *      names the command that needs the terminal.
 *   3. **The neighbour is untouched.** The ordinary offer draws a live Play
 *      and carries no note.
 *
 * @covers tugdeck/src/lib/markdown/enhance-run-offer.ts
 * @covers tugdeck/src/lib/run-offer-terminal.ts
 * @covers tugdeck/src/lib/run-offer-binding.ts
 * @covers tugdeck/styles/tugx-md.css
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp } from "./_harness";
import { sessionCardShape, SESSION_CARD_SIZE_SHORT } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const SID = "a7c0d1ea-0000-4000-8000-000000000833";
const FEED_CODE_OUTPUT = 0x40;

const CARD = '[data-card-id="A"]';
const FRAME = `${CARD} .tugx-md-run`;

const REPLY =
  "Install it:\n\n```tugrun\nsudo make install\n```\n\nThen check:\n\n```tugrun\necho checked\n```\n";

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0833-proj-")));
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

interface FrameFacts {
  command: string;
  playShown: boolean;
  playDisabled: boolean;
  copyShown: boolean;
  note: string;
  /** Whether the note sits under the command's row, inside the frame. */
  noteUnderCommand: boolean;
}

describe.skipIf(!SHOULD_RUN)("AT0833: an offer that needs a terminal shows Copy only", () => {
  test("the sudo offer draws no Play and a note; its neighbour draws Play", async () => {
    const app = await launchTugApp({ testName: "at0833-run-offer-terminal" });
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

      await app.driveSession("A", { op: "send", text: "how do I install it" });
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

      // The ordinary offer's Play going live says the turn has settled and
      // both frames have been adopted.
      await app.body("A").waitForCondition<boolean>(
        `(function(){
          var frames = document.querySelectorAll(${JSON.stringify(FRAME)});
          if (frames.length !== 2) return false;
          var play = frames[1].querySelector(".tugx-md-run-play");
          return play !== null && !play.disabled && getComputedStyle(play).display !== "none";
        })()`,
        { timeoutMs: 8000 },
      );

      const facts = await app.body("A").evalJS<FrameFacts[]>(
        `(function(){
          var shown = function(el){
            if (el === null) return false;
            var r = el.getBoundingClientRect();
            return getComputedStyle(el).display !== "none" && r.width > 0 && r.height > 0;
          };
          return Array.prototype.map.call(
            document.querySelectorAll(${JSON.stringify(FRAME)}),
            function(frame){
              var play = frame.querySelector(".tugx-md-run-play");
              var copy = frame.querySelector(".tugx-md-run-actions > button:not(.tugx-md-run-play)");
              var note = frame.querySelector(".tugx-md-run-note");
              var row = frame.querySelector(".tugx-md-run-row");
              var code = frame.querySelector(".tugx-md-run-row > pre > code");
              return {
                command: code ? code.textContent.trim() : "",
                playShown: shown(play),
                playDisabled: play !== null && play.disabled,
                copyShown: shown(copy),
                note: note ? note.textContent : "",
                noteUnderCommand: note !== null && row !== null && shown(note) &&
                  note.getBoundingClientRect().top >= row.getBoundingClientRect().bottom - 1,
              };
            }
          );
        })()`,
      );

      expect(facts.length).toBe(2);
      const [needs, plain] = facts;

      expect(needs.command).toBe("sudo make install");
      expect(needs.playShown, "an offer that needs a terminal draws no Play").toBe(false);
      expect(needs.playDisabled, "and the hidden control cannot be pressed").toBe(true);
      expect(needs.copyShown, "it can still be copied").toBe(true);
      expect(needs.note, "the note names what needs the terminal").toContain("sudo needs a terminal");
      expect(needs.noteUnderCommand, "the note sits under the command").toBe(true);

      expect(plain.command).toBe("echo checked");
      expect(plain.playShown, "an ordinary offer keeps its Play").toBe(true);
      expect(plain.playDisabled).toBe(false);
      expect(plain.note).toBe("");
    } finally {
      await app.close();
    }
  });
});
