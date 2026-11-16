/**
 * at0834-shell-fence-play.test.ts — a plain shell fence gains a Play in its
 * ordinary header, and runs like an offer.
 *
 * A committed assistant turn carries three fences: a `tugrun` offer, a
 * `python` fence, and a `bash` fence at its foot, where the short card shows
 * it clear of the masthead. What the running app has to show:
 *
 *   1. **The shell fence keeps its chrome and gains Play.** It is still the
 *      fence wrapper with its language label, Copy and fold; Play sits in
 *      the header's actions, before Copy.
 *   2. **No other fence gains one.** The `python` fence holds no Play.
 *   3. **A press runs the fence, and the result attaches under it.** The
 *      output lands inside the fence's own wrapper, below its code, and the
 *      offer above it, which was not pressed, has no result.
 *   4. **No turn is minted.** The transcript gains no shell row.
 *
 * @covers tugdeck/src/lib/markdown/enhance-fenced-code.ts
 * @covers tugdeck/src/lib/markdown/enhance-run-offer.ts
 * @covers tugdeck/src/lib/run-offer-binding.ts
 * @covers tugdeck/styles/tugx-md.css
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, type App } from "./_harness";
import { sessionCardShape, SESSION_CARD_SIZE_SHORT } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const SID = "a7c0d1ea-0000-4000-8000-000000000834";
const FEED_CODE_OUTPUT = 0x40;

const CARD = '[data-card-id="A"]';
const BASH = `${CARD} .tugx-md-fenced-code[data-lang="bash"]`;
const PYTHON = `${CARD} .tugx-md-fenced-code[data-lang="python"]`;
const OFFER = `${CARD} .tugx-md-run`;
const PLAY = `${BASH} .tugx-md-run-play`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;

const MARK = "fence-ran-here";
const REPLY =
  "Run this:\n\n```tugrun\necho offered\n```\n\n" +
  "In Python:\n\n```python\nprint('x')\n```\n\n" +
  "Or, for example:\n\n```bash\necho " + MARK + "\n```\n";

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0834-proj-")));
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

interface FenceFacts {
  bashLabel: string;
  /** The classes of the bash header's action buttons, in order. */
  bashActions: string[];
  bashPlayShown: boolean;
  bashPlayDisabled: boolean;
  pythonPlays: number;
  pythonActions: number;
  /** The bash fence's result: its tone, output and status. */
  tone: string;
  output: string;
  status: string;
  /** Whether the result sits below the fence's code, inside its wrapper. */
  resultUnderCode: boolean;
  offerResults: number;
  shellRows: number;
}

function fenceFacts(app: App): Promise<FenceFacts> {
  return app.body("A").evalJS<FenceFacts>(
    `(function(){
      var bash = document.querySelector(${JSON.stringify(BASH)});
      var python = document.querySelector(${JSON.stringify(PYTHON)});
      var q = function(root, sel){ return root ? root.querySelector(sel) : null; };
      var text = function(root, sel){ var el = q(root, sel); return el ? el.textContent : ""; };
      var play = q(bash, ".tugx-md-run-play");
      var result = q(bash, ":scope > .tugx-md-run-result");
      var pre = q(bash, ":scope > pre");
      var actions = bash ? bash.querySelectorAll(".tugx-md-chrome-header .tugx-md-chrome-actions > button") : [];
      return {
        bashLabel: text(bash, ".tugx-md-fenced-code-lang"),
        bashActions: Array.prototype.map.call(actions, function(b){ return b.className; }),
        bashPlayShown: play !== null && getComputedStyle(play).display !== "none" &&
          play.getBoundingClientRect().width > 0,
        bashPlayDisabled: play !== null && play.disabled,
        pythonPlays: python ? python.querySelectorAll(".tugx-md-run-play").length : -1,
        pythonActions: python
          ? python.querySelectorAll(".tugx-md-chrome-header .tugx-md-chrome-actions > button").length
          : -1,
        tone: result ? (result.getAttribute("data-tone") || "") : "",
        output: text(result, ".tugx-md-run-output"),
        status: text(result, ".tugx-md-run-status"),
        resultUnderCode: result !== null && pre !== null &&
          result.getBoundingClientRect().top >= pre.getBoundingClientRect().bottom - 1,
        offerResults: document.querySelectorAll(${JSON.stringify(`${OFFER} .tugx-md-run-result`)}).length,
        shellRows: document.querySelectorAll(${JSON.stringify(SHELL_ROWS)}).length,
      };
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0834: a plain shell fence can be played", () => {
  test("the bash fence gains Play, the python fence does not, and a press lands its result under it", async () => {
    const app = await launchTugApp({ testName: "at0834-shell-fence-play" });
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
          return play !== null && !play.disabled && getComputedStyle(play).display !== "none"
            && document.querySelector(${JSON.stringify(PYTHON)}) !== null
            && document.querySelector(${JSON.stringify(OFFER)}) !== null;
        })()`,
        { timeoutMs: 8000 },
      );

      const before = await fenceFacts(app);
      expect(before.bashLabel, "the fence keeps its language label").toBe("bash");
      expect(before.bashActions.length, "Play, Copy and fold").toBe(3);
      expect(before.bashActions[0], "Play comes first, beside Copy").toContain("tugx-md-run-play");
      expect(before.bashPlayShown).toBe(true);
      expect(before.pythonPlays, "a python fence gains no Play").toBe(0);
      expect(before.pythonActions, "it keeps Copy and fold alone").toBe(2);
      expect(before.tone, "no result before a run").toBe("");

      // The press must land on Play itself, clear of the card's masthead.
      const hit = await app.body("A").evalJS<string>(
        `(function(){
          var play = document.querySelector(${JSON.stringify(PLAY)});
          var r = play.getBoundingClientRect();
          var at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (at === null) return "nothing";
          return play.contains(at) ? "play" : (at.tagName + "." + at.className);
        })()`,
      );
      expect(hit, "Play is the topmost thing at its own centre").toBe("play");

      await app.body("A").nativeClickAtElement(PLAY);
      try {
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var result = document.querySelector(${JSON.stringify(`${BASH} > .tugx-md-run-result`)});
            return result !== null && result.getAttribute("data-tone") !== "running";
          })()`,
          { timeoutMs: 8000 },
        );
      } catch (err) {
        throw new Error(`no settled result under the fence: ${JSON.stringify(await fenceFacts(app))}`, {
          cause: err,
        });
      }

      const ran = await fenceFacts(app);
      expect(ran.output, "the fence's output is under the fence").toContain(MARK);
      expect(ran.tone).toBe("ok");
      expect(ran.status).toBe("exit 0");
      expect(ran.resultUnderCode, "the result sits below the code, in the wrapper").toBe(true);
      expect(ran.bashLabel, "the chrome is still the fence's").toBe("bash");
      expect(ran.bashPlayDisabled, "the fence can be run again").toBe(false);
      expect(ran.offerResults, "the offer that was not pressed has no result").toBe(0);
      expect(ran.shellRows, "a fence's run mints no transcript turn").toBe(0);
    } finally {
      await app.close();
    }
  });
});
