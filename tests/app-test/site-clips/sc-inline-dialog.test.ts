/**
 * sc-inline-dialog.test.ts — the site's inline-dialog clip: a question
 * Claude asks lands in the transcript as a wizard, the user picks an answer
 * and submits it, and the same block settles into the answered record while
 * the turn goes on beneath it.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene is built the way at0333 builds its question: one Session card
 * bound synthetically, a prompt sent, then an `AskUserQuestion` tool_use
 * with its `is_question` forward ingested on the code feed,
 * which mounts the wizard at the tool_use position. During the burst the
 * driver clicks an option and then Submit — real clicks, so the selection
 * and the submit are the app's own — and ingests the result, a closing line
 * of prose streamed a word at a time, and the turn's end. The capture
 * covers the card; the site's `make-clip --crop` cuts the transcript out
 * of it.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { App } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { pollFor } from "../body-grounding/_frames";
import { CODE_OUTPUT_FEED } from "../arc-run-transcript-fixture";
import { RUNS, cropFor, expectRecorded, launchForMode, outDirFor, scene } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
const CARD = "sc-dialog";
const TUG_SESSION_ID = "sc-dialog-session";
const TOOL_USE_ID = "toolu_sc_dialog_1";
const REQUEST_ID = "sc-dialog-q1";
const PROJECT_NAME = "tug-site";

const WIZARD = '[data-slot="session-question-dialog"]';
const OPTION_ROWS = `${WIZARD} [data-slot="session-question-dialog-panel-face"] [data-slot="tug-list-row"]`;
const ACTION_BUTTONS = `${WIZARD} [data-slot="session-question-dialog-actionbar"] button`;
const BLOCK = '[data-slot="ask-user-question-tool-block"]';
/** The attribute the driver stamps on the element it is about to click. */
const TARGET = "data-sc-target";

/** The scene's beats: the question arrives, is read, answered, sent, and the turn goes on. */
const REST_MS = 700;
const READ_MS = 2_300;
const CHOSEN_MS = 1_400;
/** From Submit to the tool's result, the result to the prose, and the prose's pace. */
const RESULT_MS = 300;
const PROSE_MS = 900;
const WORD_MS = 45;
/** From the turn's end to the block's rect being noted, and to the loop's end. */
const NOTE_MS = 400;
const TAIL_MS = 1_200;

const PROMPT = "The overlay has no controls now. What should a click on the picture do?";
/**
 * The question, kept to what the transcript's viewport holds: the card's
 * body lays out at 1:1 whatever the window or the page zoom, its composer
 * takes the height the transcript does not, and the viewport comes to some
 * 676 points. The prompt row and a wizard with three option rows, the
 * free-text field and the chat-about row fit that; option descriptions,
 * at a line each, do not.
 */
const QUESTION = {
  question: "What should a click on the clip overlay’s picture do?",
  header: "Click",
  multiSelect: false,
  options: [{ label: "Pause and play (Recommended)" }, { label: "Close the overlay" }, { label: "Nothing" }],
};
const CHOSEN = QUESTION.options[0].label;
const CLOSING = "Pause and play it is. The click handler toggles the video and leaves the scrim to close the overlay.";

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: CARD, componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: `${CARD}-pane`,
        position: { x: 40, y: 40 },
        // The one-up fits the card to the window. The transcript's viewport
        // is what {@link QUESTION} is sized to: a transcript that scrolls to
        // follow its bottom would move the block as it changes shape, and
        // would carry the wizard's action bar out of the clicks' reach.
        size: { width: 720, height: 1000 },
        cardIds: [CARD],
        activeCardId: CARD,
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: `${CARD}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

function ingest(app: App, decoded: Record<string, unknown>): Promise<unknown> {
  return app.driveSession(CARD, {
    op: "ingestFrame",
    feedId: CODE_OUTPUT_FEED,
    decoded: { tug_session_id: TUG_SESSION_ID, ipc_version: 2, ...decoded },
  });
}

/** Stamp {@link TARGET} on the `index`th element `selector` matches, or on the one whose text is `text`. */
async function aim(app: App, selector: string, pick: { index: number } | { text: string }): Promise<void> {
  const found = await app.body(CARD).evalJS<boolean>(
    `(function(){
       var all = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(selector)}));
       all.forEach(function (el) { el.removeAttribute(${JSON.stringify(TARGET)}); });
       document.querySelectorAll("[" + ${JSON.stringify(TARGET)} + "]").forEach(function (el) { el.removeAttribute(${JSON.stringify(TARGET)}); });
       var el = ${"index" in pick ? `all[${pick.index}]` : `all.find(function (e) { return (e.textContent || "").trim() === ${JSON.stringify(pick.text)}; })`};
       if (!el) return false;
       el.setAttribute(${JSON.stringify(TARGET)}, "");
       return true;
     })()`,
  );
  expect(found, `an element to click: ${selector} ${JSON.stringify(pick)}`).toBe(true);
}

describe.skipIf(!RUNS)("site clip: inline dialog", () => {
  test(
    "records a question asked, answered and settled in the transcript",
    async () => {
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sc-dialog-")));
      onTestRunEnd(() => rmSync(scratch, { recursive: true, force: true }));
      const projectDir = join(scratch, PROJECT_NAME);
      mkdirSync(projectDir);
      const app = await launchForMode("sc-inline-dialog", deck());
      try {
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(CARD)})`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession(CARD, { tugSessionId: TUG_SESSION_ID, projectDir, workspaceKey: projectDir });
        await app.awaitEngineReady(CARD, { timeoutMs: 30_000 });
        await Bun.sleep(800);

        // The turn, up to the question: the prompt, and the turn opened on
        // it. No prose before the question: the wizard is tall, and every
        // line above it is a line the transcript's viewport has to hold.
        await app.driveSession(CARD, { op: "send", text: PROMPT });
        await ingest(app, { type: "prompt_anchor", promptUuid: "sc-dialog-p1" });
        await ingest(app, { type: "session_init", session_id: "claude-sc-dialog" });
        await app.body(CARD).waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(".tug-transcript-entry")).some((el) => (el.textContent || "").includes(${JSON.stringify(PROMPT.slice(0, 24))}))`,
          { timeoutMs: 10_000 },
        );
        await Bun.sleep(600);

        const crop = await cropFor(app, [CARD]);

        const notes: Record<string, unknown> = {};
        const s = scene().mark("loop-start", 0);
        s.at(REST_MS, async () => {
          // The question arrives: the tool_use hosts the wizard, the forward makes it live.
          await ingest(app, { type: "tool_use", msg_id: "m1", seq: 1, tool_name: "AskUserQuestion", tool_use_id: TOOL_USE_ID, input: { questions: [QUESTION] } });
          await ingest(app, {
            type: "control_request_forward",
            request_id: REQUEST_ID,
            tool_use_id: TOOL_USE_ID,
            is_question: true,
            tool_name: "AskUserQuestion",
            input: { questions: [QUESTION] },
          });
          await app.body(CARD).waitForCondition<boolean>(`document.querySelectorAll(${JSON.stringify(OPTION_ROWS)}).length >= 3`, { timeoutMs: 10_000 });
        });
        const chooseAt = REST_MS + READ_MS;
        s.at(chooseAt, async () => {
          notes.scroll = await app.body(CARD).evalJS<unknown>(
            `(function(){ var s = document.querySelector('[data-tug-scroll-key="session-card-transcript"]'); if (!s) return null; return { scrollHeight: s.scrollHeight, clientHeight: s.clientHeight, scrollTop: s.scrollTop }; })()`,
          );
          // The answer: a click on the first option, a beat, and Submit.
          await aim(app, OPTION_ROWS, { index: 0 });
          await app.body(CARD).nativeClickAtElement(`[${TARGET}]`);
        });
        const submitAt = chooseAt + CHOSEN_MS;
        s.at(submitAt, async () => {
          notes.afterOption = await app.body(CARD).evalJS<unknown>(
            `(function(){
               var rows = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(OPTION_ROWS)}));
               var buttons = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(ACTION_BUTTONS)}));
               return {
                 rows: rows.map(function (r) { return { checked: r.getAttribute("aria-checked"), state: r.getAttribute("data-state"), selected: r.getAttribute("aria-selected"), text: (r.textContent || "").slice(0, 30) }; }),
                 buttons: buttons.map(function (b) { return { text: (b.textContent || "").trim(), disabled: b.disabled, ariaDisabled: b.getAttribute("aria-disabled") }; }),
               };
             })()`,
          );
          await aim(app, ACTION_BUTTONS, { text: "Submit" });
          await app.body(CARD).nativeClickAtElement(`[${TARGET}]`);
          notes.submitted = await pollFor(
            () => app.body(CARD).evalJS<boolean>(`document.querySelector(${JSON.stringify(WIZARD)}) === null`).catch(() => false),
            (gone) => gone,
            4_000,
          ).catch(() => false);
        });
        // The tool returns, and the turn goes on: the closing prose a word at a time.
        const resultAt = submitAt + RESULT_MS;
        s.at(resultAt, () =>
          ingest(app, {
            type: "tool_result",
            tool_use_id: TOOL_USE_ID,
            output: `User has answered your questions: "${QUESTION.question}"="${CHOSEN}". You can now continue with the user's answers in mind.`,
            is_error: false,
          }),
        );
        const proseAt = resultAt + PROSE_MS;
        s.at(proseAt, () => ingest(app, { type: "content_block_start", msg_id: "m2", block_index: 0, kind: "text" }));
        const words = CLOSING.match(/\S+\s*/g) ?? [CLOSING];
        words.forEach((w, i) => {
          s.at(proseAt + (i + 1) * WORD_MS, () => ingest(app, { type: "assistant_text", msg_id: "m2", block_index: 0, seq: 2, rev: i, text: w, is_partial: true, status: "partial" }));
        });
        const doneAt = proseAt + (words.length + 1) * WORD_MS;
        s.at(doneAt, async () => {
          await ingest(app, { type: "assistant_text", msg_id: "m2", block_index: 0, seq: 2, rev: words.length, text: CLOSING, is_partial: false, status: "complete" });
          await ingest(app, { type: "turn_complete", msg_id: "m2", seq: 3, result: "success" });
        });
        s.at(doneAt + NOTE_MS, async () => {
          // Where the block stands, in the crop's points, for the cut the site makes.
          const block = await app.elementRect(CARD, BLOCK);
          notes.block = block === null ? null : { x: block.x - crop.x, y: block.y - crop.y, width: block.width, height: block.height };
        });
        s.mark("loop-end", doneAt + TAIL_MS);
        const reading = await s.record(app, { outDir: outDirFor("inline-dialog"), crop });
        writeFileSync(join(outDirFor("inline-dialog"), "notes.json"), JSON.stringify(notes, null, 2));
        expectRecorded(reading);
        expect(notes.submitted, "the answer was submitted and the wizard settled").toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
