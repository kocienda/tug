/**
 * at0865-quiet-command-band.test.ts — a command that goes quiet is asked
 * about and left running, on a runnable offer and on the `$` route alike.
 *
 * The app is launched with a one-second quiet horizon, so the question the
 * shell feed asks after two minutes of silence arrives in about a second.
 * Both commands are a bare `sleep`, which prints nothing and uses no CPU, and
 * both run through the card's real shell session. What only the running app
 * can show:
 *
 *   1. **The offer's band.** A second after Play, the result under the
 *      command carries the question and its two buttons, and the footer
 *      reads how long the command has run and that it has printed nothing.
 *   2. **Keep Waiting leaves the command running.** The band goes at the
 *      press and the offer still reads `running`.
 *   3. **The `$` route's band.** A `/shell` command's block carries the same
 *      question under its header, and Terminate settles it as `killed`.
 *
 * @covers tugdeck/src/lib/markdown/enhance-run-offer.ts
 * @covers tugdeck/src/lib/run-offer-binding.ts
 * @covers tugdeck/src/lib/run-liveness.ts
 * @covers tugdeck/src/lib/run-offer-store.ts
 * @covers tugdeck/src/lib/shell-session-store.ts
 * @covers tugdeck/src/components/tugways/cards/use-run-offers.ts
 * @covers tugdeck/src/components/tugways/cards/shell-live-band.tsx
 * @covers tugdeck/src/components/tugways/cards/shell-live-band.css
 * @covers tugdeck/src/components/tugways/cards/shell-exchange-block.tsx
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

const SID = "a7c0d1ea-0000-4000-8000-000000000863";
const FEED_CODE_OUTPUT = 0x40;

/** The silence the shell feed allows before it asks, for this launch. */
const HORIZON_MS = 1000;
const QUESTION = "No output for 1 second. This command might be stuck.";

const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const FRAME = `${CARD} .tugx-md-run`;
const PLAY = `${FRAME} .tugx-md-run-play`;
const RESULT = `${FRAME} .tugx-md-run-result`;
const BAND = `${FRAME} .tugx-md-run-quiet`;
const KEEP = `${FRAME} .tugx-md-run-keep`;
const SHELL_ROW = `${CARD} [data-slot="session-transcript-shell-row"]`;
const SHELL_BAND = `${SHELL_ROW} [data-slot="shell-quiet-band"]`;
const SHELL_TERMINATE = `${SHELL_ROW} [data-slot="shell-quiet-terminate"]`;

const COMMAND = "sleep 300";
const REPLY = "Run this:\n\n```tugrun\n" + COMMAND + "\n```\n";

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0865-proj-")));
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

interface OfferFacts {
  tone: string;
  /** The band's sentence, or `""` when no band is drawn. */
  question: string;
  /** The band's button labels, in order. */
  buttons: string[];
  /** The footer's reading: elapsed time, then the age of the last output. */
  elapsed: string;
  lastOutput: string;
}

function offerFacts(app: App): Promise<OfferFacts> {
  return app.body("A").evalJS<OfferFacts>(
    `(function(){
      var result = document.querySelector(${JSON.stringify(RESULT)});
      var band = result ? result.querySelector(".tugx-md-run-quiet") : null;
      var text = band ? band.querySelector(".tugx-md-run-quiet-text") : null;
      var elapsed = result ? result.querySelector("[data-run-elapsed]") : null;
      var last = result ? result.querySelector("[data-run-last-output]") : null;
      return {
        tone: result ? (result.getAttribute("data-tone") || "") : "",
        question: text ? text.textContent : "",
        buttons: band
          ? Array.from(band.querySelectorAll("button")).map(function(b){ return b.textContent; })
          : [],
        elapsed: elapsed ? elapsed.textContent : "",
        lastOutput: last ? last.textContent : "",
      };
    })()`,
  );
}

function present(selector: string): string {
  return `document.querySelector(${JSON.stringify(selector)}) !== null`;
}

/**
 * Press a band's button once it has stopped moving. The band's arrival grows
 * its row and the transcript re-pins to its foot, so a press sent the moment
 * the band exists can land where the button was. The button is still when
 * two reads in a row find it at the same place, on top at its own centre.
 */
async function pressWhenStill(app: App, selector: string): Promise<void> {
  await app.body("A").waitForCondition<boolean>(
    `(function(){
      var b = document.querySelector(${JSON.stringify(selector)});
      if (b === null) return false;
      var r = b.getBoundingClientRect();
      var at = [Math.round(r.left), Math.round(r.top)].join(",");
      var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      var still = b.getAttribute("data-at0865-at") === at && hit !== null && b.contains(hit);
      b.setAttribute("data-at0865-at", at);
      return still;
    })()`,
    { timeoutMs: 4000 },
  );
  await app.body("A").nativeClickAtElement(selector);
}

describe.skipIf(!SHOULD_RUN)("AT0865: a quiet command is asked about and left running", () => {
  test("the offer's band, Keep Waiting, and the `$` route's band with Terminate", async () => {
    const app = await launchTugApp({
      testName: "at0865-quiet-command-band",
      env: { TUG_SHELL_QUIET_HORIZON_MS: String(HORIZON_MS) },
    });
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

      // --- The press; a second of silence later the band is on the result. ---
      await app.body("A").nativeClickAtElement(PLAY);
      await app.body("A").waitForCondition<boolean>(present(BAND), { timeoutMs: 12_000 });
      const asked = await offerFacts(app);
      expect(asked.tone, "the command was asked about, not stopped").toBe("running");
      expect(asked.question, "the silence is the one the feed reported").toBe(QUESTION);
      expect(asked.buttons).toEqual(["Terminate", "Keep Waiting"]);
      expect(asked.elapsed, "the footer reads how long the command has run").toMatch(/^\d+s$/);
      expect(asked.lastOutput).toBe("no output yet");

      // --- Keep Waiting: the band goes, the command does not. ---
      await pressWhenStill(app, KEEP);
      await app.body("A").waitForCondition<boolean>(`!(${present(BAND)})`, { timeoutMs: 4000 });
      const kept = await offerFacts(app);
      expect(kept.tone, "Keep Waiting leaves the command running").toBe("running");
      expect(kept.elapsed).toMatch(/^\d+s$/);

      // --- Stop it, so the card's one shell is free for the `$` route. ---
      await app.body("A").nativeClickAtElement(PLAY);
      await app.body("A").waitForCondition<boolean>(
        `(function(){
          var result = document.querySelector(${JSON.stringify(RESULT)});
          return result !== null && result.getAttribute("data-tone") === "fail";
        })()`,
        { timeoutMs: 8000 },
      );
      const stopped = await offerFacts(app);
      expect(stopped.question, "a settled run carries no question").toBe("");
      expect(stopped.elapsed, "and no running clock").toBe("");

      // --- The `$` route: the same question on the exchange's block. ---
      await app.body("A").nativeClickAtElement(PROMPT);
      await app.nativeType(`/shell ${COMMAND}`);
      await new Promise((r) => setTimeout(r, 150));
      await app.nativeKey("Enter", ["cmd"]);
      await app.body("A").waitForCondition<boolean>(present(SHELL_BAND), { timeoutMs: 12_000 });
      const shell = await app.body("A").evalJS<{ question: string; clock: string }>(
        `(function(){
          var row = document.querySelector(${JSON.stringify(SHELL_ROW)});
          var text = row.querySelector(".shell-quiet-text");
          var last = row.querySelector("[data-run-last-output]");
          return {
            question: text ? text.textContent : "",
            clock: last ? last.textContent : "",
          };
        })()`,
      );
      expect(shell.question).toBe(QUESTION);
      expect(shell.clock).toBe("no output yet");

      // --- Terminate settles it as killed. ---
      await pressWhenStill(app, SHELL_TERMINATE);
      await app.body("A").waitForCondition<boolean>(
        `(function(){
          var row = document.querySelector(${JSON.stringify(SHELL_ROW)});
          var foot = row ? row.querySelector('[data-slot="session-z1b-end-state"]') : null;
          return foot !== null && foot.textContent.indexOf("killed") !== -1;
        })()`,
        { timeoutMs: 8000 },
      );
      expect(
        await app.body("A").evalJS<boolean>(present(SHELL_BAND)),
        "a settled exchange carries no question",
      ).toBe(false);
    } finally {
      await app.close();
    }
  });
});
