/**
 * at0835-share-run-offer.test.ts — a share renders a runnable offer as the
 * card shows it: Play drawn, and the run's result under the command.
 *
 * The share page renders the card's turns through the card's own cells, but
 * it has no shell session, so an offer frame there is never adopted the way
 * the live transcript adopts it. The card hands the page its offers' runs
 * instead, and the page draws them. An assistant turn carrying a `tugrun`
 * fence is streamed into a Session card, its Play is pressed so the command
 * runs through the real shell, and then the card's turns are rendered as a
 * PDF. The test reads the render's HTML, which drops any subtree the page
 * did not show, and holds it to two things:
 *
 *   1. **Play is drawn.** The control and its glyph are in the picture, as
 *      they are on the card for a finished turn.
 *   2. **The result is drawn under it.** The command's output and its exit
 *      status are in the picture, though no shell turn carries them.
 *
 * @covers tugdeck/src/share/share-main.ts
 * @covers tugdeck/src/share/share-root.tsx
 * @covers tugdeck/src/lib/share-turns.ts
 * @covers tugdeck/src/lib/run-offer-binding.ts
 * @covers tugdeck/src/components/tugways/cards/use-run-offers.ts
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp } from "./_harness";
import { sessionCardShape, SESSION_CARD_SIZE_SHORT } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const SID = "a7c0d1ea-0000-4000-8000-000000000835";
const FEED_CODE_OUTPUT = 0x40;

const CARD = '[data-card-id="A"]';
const FRAME = `${CARD} .tugx-md-run`;
const PLAY = `${FRAME} .tugx-md-run-play`;

const MARK = "offer-shared-here";
const REPLY = "Run this to check:\n\n```tugrun\necho " + MARK + "\n```\n";

/** The Play glyph's one shape, as the render's HTML carries it. */
const PLAY_GLYPH = 'points="6 3 20 12 6 21 6 3"';

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0835-proj-")));
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

interface Rendered {
  result: "ok" | "failed";
  path: string;
  html: string;
}

describe.skipIf(!SHOULD_RUN)("AT0835: a share draws a runnable offer as the card does", () => {
  test("Play and the run's result are in the rendered share", async () => {
    const app = await launchTugApp({ testName: "at0835-share-run-offer" });
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

      // --- A finished turn whose reply offers a command. ---
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
      await frame({ type: "turn_complete", seq: 0, msg_id: "m1", result: "success" });
      const card = app.body("A");
      await card.waitForCondition<boolean>(
        `(function(){
          var play = document.querySelector(${JSON.stringify(PLAY)});
          return play !== null && !play.disabled;
        })()`,
        { timeoutMs: 8000 },
      );

      // --- Run it through the real shell. ---
      await card.nativeClickAtElement(PLAY);
      await card.waitForCondition<boolean>(
        `(function(){
          var result = document.querySelector(${JSON.stringify(`${FRAME} .tugx-md-run-result`)});
          return result !== null && result.getAttribute("data-tone") === "ok";
        })()`,
        { timeoutMs: 20_000 },
      );

      // --- Render the card's turns as a PDF and read its HTML. ---
      await card.evalJS<null>(
        `(window.__at0835 = undefined,
          window.__tug.shareRender("A", "pdf", "summaries").then(function (r) {
            window.__at0835 = JSON.stringify(r);
          }),
          null)`,
      );
      await card.waitForCondition<boolean>("window.__at0835 !== undefined", { timeoutMs: 15_000 });
      const rendered = JSON.parse(await card.evalJS<string>("window.__at0835")) as Rendered;

      expect(rendered.result, "the render answers ok").toBe("ok");
      expect(rendered.html, "Play is drawn, as on the card").toContain('aria-label="Run command"');
      expect(rendered.html, "with its glyph").toContain(PLAY_GLYPH);
      const outputs = rendered.html.split(MARK).length - 1;
      // The mark is drawn twice: in the command (shell colouring puts `echo`
      // in a span of its own) and in the output under it.
      expect(outputs, "the output is drawn under the command, beside the command itself").toBeGreaterThanOrEqual(2);
      expect(rendered.html, "the result's status is drawn").toContain("exit 0");
    } finally {
      await app.close();
    }
  });
});
