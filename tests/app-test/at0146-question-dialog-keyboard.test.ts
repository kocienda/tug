/**
 * at0146-question-dialog-keyboard.test.ts — the QuestionDialog is **card-modal**:
 * inline display, trapped focus, archetype-decomposed controls, scrimmed
 * surround, no dead-zone ([P16]/[P17]/[P18]/[P19]).
 *
 * Mirrors the PermissionDialog redesign (at0145) for the AskUserQuestion wizard.
 * The dialog keeps its inline render but its controls are decomposed into
 * focus-language archetypes inside the trap: Cancel / Submit (and Back / Next on
 * multi-question payloads) are leaf buttons; the current question's options are a
 * single item-group stop (Tab to the group, arrows move a cursor, Space/Enter
 * pick). The old full-width `session-question-dialog-scope` dead-zone is gone.
 *
 * Driven with a single MULTI-select question (no auto-advance, so the sequence
 * is deterministic): the options group seeds as the key view; ArrowDown moves
 * the cursor; Space toggles the cursor option on (enabling Submit); Tab reaches
 * Submit without escaping to the editor; Return submits and the dialog
 * dismisses.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @foreground
 *
 * @covers tugdeck/src/components/tugways/chrome/session-question-dialog.tsx
 * @covers tugdeck/src/components/tugways/tug-jump-to-bottom-button.tsx
 * @covers tugdeck/src/components/tugways/internal/tug-button.tsx
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 * @covers tugdeck/src/components/tugways/question-summary-list.tsx
 * @covers tugdeck/src/components/tugways/tug-list-row.css
 * @covers tugdeck/src/components/tugways/tug-list-row.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";
import { sessionCardShape, SESSION_CARD_SIZE_COMPACT } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0146-session";
const FEED_CODE_OUTPUT = 0x40;

const CARD = '[data-card-id="A"]';
const CARD_ROOT = `${CARD} [data-slot="session-card"]`;
const DIALOG = `${CARD} [data-slot="session-question-dialog"]`;
const SUBMIT = `${DIALOG} .session-question-dialog-actionbar-buttons .tug-button-primary-action`;
// The current question's options are a flush TugListView authored into the
// trap as one item-group stop: the list holds the key view; the movement
// cursor (`data-key-cursor`) lands on a `.tug-list-view-cell`; the committed
// selection (`data-selected`) lands on the `TugListRow` inside it. Scoped to
// the options-list class so it never matches the multi-question RAIL (also a
// TugListView).
const OPTIONS = `${DIALOG} .session-question-dialog-options-list`;
const OPTION_CELLS = `${OPTIONS} .tug-list-view-cell`;
const OPTION_ROWS = `${OPTIONS} [data-slot="tug-list-row"]`;
const OLD_DEADZONE = `${CARD} [data-slot="session-question-dialog-scope"]`;
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
// The current question's free-text answer field ("or type your own answer…") —
// the CM6 substrate the wizard's [K3] Shift-Return submit chord runs through.
const FREE_TEXT = `${DIALOG} .session-question-dialog-freetext-field`;
const FREE_TEXT_CONTENT = `${FREE_TEXT} .cm-content`;

// Single- and multi-select options are the SAME flush TugListView now (the
// component unified both arities onto one item-group). So the "radio" fixtures
// alias the list-view group + its cells; only the leading glyph (radio dot vs
// checkbox) differs. The action row carries Cancel (outlined-danger) + Submit
// (primary). All controls now share one top action bar.
const CANCEL = `${DIALOG} .session-question-dialog-actionbar-buttons .tug-button-outlined-danger`;
const RADIO = OPTIONS;
const RADIO_ITEMS = OPTION_CELLS;
// Wizard-nav buttons (multi-question): Back then Next, both outlined-action,
// sharing the top action bar with Cancel + Submit.
const NAV_BUTTONS = `${DIALOG} .session-question-dialog-actionbar-buttons .tug-button-outlined-action`;

function controlRequestForward(): Record<string, unknown> {
  return {
    type: "control_request_forward",
    tug_session_id: SID,
    request_id: "at0146-q-1",
    tool_use_id: "at0146-tu-1",
    is_question: true,
    tool_name: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "Pick any that apply",
          header: "Pick",
          multiSelect: true,
          options: [{ label: "Alpha" }, { label: "Beta" }],
        },
      ],
    },
  };
}

// A single SINGLE-select question — the options render as a radio group
// (delegated item-group), so the dialog's spatial seams between the button row
// and the options are exercised. (The multi-select case renders a TugListView,
// which is Tab-reached, not part of the spatial grid.)
function controlRequestForwardSingle(): Record<string, unknown> {
  return {
    type: "control_request_forward",
    tug_session_id: SID,
    request_id: "at0146-q-2",
    tool_use_id: "at0146-tu-2",
    is_question: true,
    tool_name: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "Pick exactly one",
          header: "Pick",
          multiSelect: false,
          options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }],
        },
      ],
    },
  };
}

// Three single-select questions — the multi-question wizard the user drives.
function controlRequestForwardMultiQuestion(): Record<string, unknown> {
  return {
    type: "control_request_forward",
    tug_session_id: SID,
    request_id: "at0146-q-3",
    tool_use_id: "at0146-tu-3",
    is_question: true,
    tool_name: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "How should the calculator take input?",
          header: "Input",
          multiSelect: false,
          options: [{ label: "Expression argument" }, { label: "Interactive REPL" }, { label: "Both" }],
        },
        {
          question: "What math should it support?",
          header: "Math",
          multiSelect: false,
          options: [{ label: "Precedence + parens" }, { label: "Flat left-to-right" }],
        },
        {
          question: "What number type?",
          header: "Numbers",
          multiSelect: false,
          options: [{ label: "Floating point" }, { label: "Integer" }],
        },
      ],
    },
  };
}

// The AskUserQuestion `tool_use` that hosts the live wizard in place. The
// wizard now renders inside `AskUserQuestionToolBlock` at the tool_use
// position, so a question only mounts when its tool call exists; the forward
// and this tool_use share `tool_use_id`. Ingest this BEFORE the forward.
function toolUseFor(forward: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "tool_use",
    tug_session_id: SID,
    msg_id: "at0146-msg-1",
    tool_use_id: forward.tool_use_id,
    tool_name: "AskUserQuestion",
    input: forward.input,
    seq: 1,
  };
}

// Drive the asking state: feed the AskUserQuestion tool_use, then its
// is_question forward, so the block mounts and renders the live wizard.
async function ingestQuestion(
  app: App,
  forward: Record<string, unknown>,
): Promise<void> {
  await app.driveSession("A", {
    op: "ingestFrame",
    feedId: FEED_CODE_OUTPUT,
    decoded: toolUseFor(forward),
  });
  await app.driveSession("A", {
    op: "ingestFrame",
    feedId: FEED_CODE_OUTPUT,
    decoded: forward,
  });
}

// Diagnostic: which named stop currently holds the keyboard key view.
function keyViewReport(app: App): Promise<string> {
  return app.evalJS<string>(
    `(function(){
      function kv(sel){var e=document.querySelector(sel);return e&&e.hasAttribute("data-key-view-kbd");}
      var out=[];
      if(kv(${JSON.stringify(RADIO)})) out.push("radio");
      if(kv(${JSON.stringify(CANCEL)})) out.push("cancel");
      var navs=document.querySelectorAll(${JSON.stringify(NAV_BUTTONS)});
      for(var i=0;i<navs.length;i++){if(navs[i].hasAttribute("data-key-view-kbd"))out.push("nav"+i);}
      var any=document.querySelector("[data-key-view-kbd]");
      out.push("active="+(any?(any.getAttribute("data-slot")||any.className||any.tagName):"none"));
      return out.join(",");
    })()`,
  );
}

function hasAttr(app: App, selector: string, attr: string): Promise<boolean> {
  return app.evalJS<boolean>(
    `(function(){var el=document.querySelector(${JSON.stringify(selector)});return el!==null && el.hasAttribute(${JSON.stringify(attr)});})()`,
  );
}

function exists(app: App, selector: string): Promise<boolean> {
  return app.evalJS<boolean>(
    `document.querySelector(${JSON.stringify(selector)}) !== null`,
  );
}

// Whether the element at `index` of `listSelector` carries the given attribute.
function nthHasAttr(
  app: App,
  listSelector: string,
  index: number,
  attr: string,
): Promise<boolean> {
  return app.evalJS<boolean>(
    `(function(){var els=document.querySelectorAll(${JSON.stringify(listSelector)});var el=els[${index}];return el!=null && el.hasAttribute(${JSON.stringify(attr)});})()`,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SHOULD_RUN)("AT0146: QuestionDialog is card-modal", () => {
  test(
    "options item-group seeded; arrows move; Space toggles; Tab to Submit; Return submits",
    async () => {
      const app = await launchTugApp({
          testName: "at0146-question-dialog-keyboard",
          foreground: true,
        });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_COMPACT), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");

        await app.driveSession("A", { op: "send", text: "ask me something" });
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: FEED_CODE_OUTPUT,
          decoded: {
            type: "assistant_text",
            status: "partial",
            tug_session_id: SID,
            msg_id: "at0146-msg-1",
            text: "Let me ask…",
            is_partial: true,
            rev: 0,
            seq: 0,
          },
        });
        await ingestQuestion(app, controlRequestForward());

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DIALOG)}) !== null`,
          { timeoutMs: 6000 },
        );
        await app.waitForCondition<boolean>(`document.hasFocus()`, { timeoutMs: 10000 });

        // (1) The dead-zone is gone ([P18]); the card carries the scrim signal ([P19]).
        expect(await exists(app, OLD_DEADZONE), "old scope dead-zone is gone").toBe(false);
        expect(
          await hasAttr(app, CARD_ROOT, "data-inline-dialog-pending"),
          "card root carries the scrim signal while pending",
        ).toBe(true);

        // (2) On open the options item-group holds the key view (answering is the task).
        await app.waitForCondition<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(OPTIONS)});return el!==null && el.hasAttribute("data-key-view-kbd");})()`,
          { timeoutMs: 4000 },
        );

        // (2a) The cursor bar reaches the top of the row it marks. The bar is the
        // cursor cell's `::before` at `inset-block: 0`, so this is really a claim
        // about the list's leading edge: the transcript's own list-view tokens
        // (`session-card.css`) must not reach this nested option list, or its top
        // breathing spacer takes `--tugx-list-view-padding-block-start` and pushes
        // the first cell — and its bar — down off the list's inner top edge.
        const caretGeometry = await app.evalJS<{ gap: number; spacer: number }>(
          `(function(){
            var list=document.querySelector(${JSON.stringify(OPTIONS)});
            var cell=list.querySelector(".tug-list-view-cell");
            var spacer=list.querySelector(".tug-list-view-top-spacer");
            var border=parseFloat(getComputedStyle(list).borderTopWidth)||0;
            return {
              gap: cell.getBoundingClientRect().top - list.getBoundingClientRect().top - border,
              spacer: spacer ? spacer.getBoundingClientRect().height : -1,
            };
          })()`,
        );
        expect(caretGeometry.spacer, "the option list keeps no top breathing spacer").toBe(0);
        expect(
          caretGeometry.gap,
          "the first option's cell — and so its cursor bar — starts at the list's inner top edge",
        ).toBe(0);

        // (3) ArrowDown moves the cursor to the second option (no commit on move).
        await app.nativeKey("ArrowDown");
        await sleep(150);
        expect(
          await nthHasAttr(app, OPTION_CELLS, 1, "data-key-cursor"),
          "ArrowDown moves the cursor to the second option",
        ).toBe(true);

        // (4) Space toggles the cursor option ON (multi-select), enabling Submit.
        await app.nativeKey(" ");
        await sleep(150);
        expect(
          await nthHasAttr(app, OPTION_ROWS, 1, "data-selected"),
          "Space toggles the second option selected",
        ).toBe(true);

        // (5) The trap holds: Tab cycles to Submit and never lands on the editor.
        let onSubmit = false;
        for (let i = 0; i < 5 && !onSubmit; i += 1) {
          await app.nativeKey("Tab");
          await sleep(150);
          expect(
            await hasAttr(app, EDITOR, "data-key-view-kbd"),
            "Tab never escapes the trap to the editor",
          ).toBe(false);
          onSubmit = await hasAttr(app, SUBMIT, "data-key-view-kbd");
        }
        expect(onSubmit, "Tab reaches the Submit button").toBe(true);

        // (6) Return on the focused Submit submits → the dialog dismisses.
        await app.nativeKey("Return");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DIALOG)}) === null`,
          { timeoutMs: 4000 },
        );
        expect(await exists(app, DIALOG), "Return on Submit dismisses the dialog").toBe(false);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0146-question-dialog-keyboard] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "single-select: arrows seam between the radio options and the button row; never beeps",
    async () => {
      const app = await launchTugApp({
          testName: "at0146-question-dialog-keyboard",
          foreground: true,
        });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_COMPACT), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");

        await app.driveSession("A", { op: "send", text: "ask me something" });
        await ingestQuestion(app, controlRequestForwardSingle());

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DIALOG)}) !== null`,
          { timeoutMs: 6000 },
        );
        await app.waitForCondition<boolean>(`document.hasFocus()`, { timeoutMs: 10000 });

        // (1) On open a single-select question seeds the key view on the
        //     OPTIONS group — answering is the task — with the cursor on the
        //     first option (`seedFocusKey` → QUESTION_OPTIONS_ORDER, see
        //     session-question-dialog.tsx). The seam below starts from there.
        await app.waitForCondition<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(OPTIONS)});return el!==null && el.hasAttribute("data-key-view-kbd");})()`,
          { timeoutMs: 4000 },
        );

        // (2) Up from the top of the radio group crosses the seam to the button row.
        await app.nativeKey("ArrowUp");
        await app.waitForCondition<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(CANCEL)});return el!==null && el.hasAttribute("data-key-view-kbd");})()` +
            ` || (function(){var el=document.querySelector(${JSON.stringify(SUBMIT)});return el!==null && el.hasAttribute("data-key-view-kbd");})()`,
          { timeoutMs: 3000 },
        );
        expect(
          (await hasAttr(app, CANCEL, "data-key-view-kbd")) ||
            (await hasAttr(app, SUBMIT, "data-key-view-kbd")),
          "Up from the top of the radio group seams to the button row (Cancel or Submit)",
        ).toBe(true);
        expect(
          await hasAttr(app, EDITOR, "data-key-view-kbd"),
          "the arrow never escapes the trap to the editor",
        ).toBe(false);

        // (3) Down from the button row crosses the seam back into the radio options.
        await app.nativeKey("ArrowDown");
        await app.waitForCondition<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(RADIO)});return el!==null && el.hasAttribute("data-key-view-kbd");})()`,
          { timeoutMs: 3000 },
        );
        expect(
          await hasAttr(app, RADIO, "data-key-view-kbd"),
          "Down from the button row seams into the radio options",
        ).toBe(true);

        // (4) Inside the group, Down roves the cursor (no commit on move).
        await app.nativeKey("ArrowDown");
        await sleep(150);
        expect(
          await nthHasAttr(app, RADIO_ITEMS, 1, "data-key-cursor"),
          "ArrowDown roves the radio cursor to the second option",
        ).toBe(true);

        // (5) Never beeps anywhere: Up from the group again still lands a button
        //     (Cancel or Submit — both are in the row for a single-select
        //     question), and the editor never gains the key view.
        await app.nativeKey("ArrowUp"); // back to top of group
        await sleep(120);
        await app.nativeKey("ArrowUp"); // top edge → button row
        await sleep(150);
        expect(
          (await hasAttr(app, CANCEL, "data-key-view-kbd")) ||
            (await hasAttr(app, SUBMIT, "data-key-view-kbd")),
          "Up again seams to the button row, no dead-end",
        ).toBe(true);
        expect(
          await hasAttr(app, EDITOR, "data-key-view-kbd"),
          "the trap holds across the whole arrow sequence",
        ).toBe(false);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0146-question-dialog-keyboard] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "multi-question wizard: arrows seam off the radio bottom edge to the buttons; never dead-ends",
    async () => {
      const app = await launchTugApp({
          testName: "at0146-question-dialog-keyboard",
          foreground: true,
        });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_COMPACT), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");
        await app.driveSession("A", { op: "send", text: "ask me something" });
        await ingestQuestion(app, controlRequestForwardMultiQuestion());

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DIALOG)}) !== null`,
          { timeoutMs: 6000 },
        );
        await app.waitForCondition<boolean>(`document.hasFocus()`, { timeoutMs: 10000 });

        // On open the current question's radio options hold the key view.
        await app.waitForCondition<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(RADIO)});return el!==null && el.hasAttribute("data-key-view-kbd");})()`,
          { timeoutMs: 4000 },
        );

        // Rove the cursor to the LAST option (3 options → 2 downs), then one more
        // ArrowDown must seam OFF the group, not dead-end on the bottom row.
        await app.nativeKey("ArrowDown");
        await sleep(120);
        await app.nativeKey("ArrowDown");
        await sleep(120);
        expect(
          await nthHasAttr(app, RADIO_ITEMS, 2, "data-key-cursor"),
          "cursor roved to the last option",
        ).toBe(true);
        await app.nativeKey("ArrowDown");
        await sleep(200);
        const afterDown = await keyViewReport(app);
        process.stderr.write(`\n[multi-q] after bottom-edge ArrowDown: ${afterDown}\n`);
        expect(
          await hasAttr(app, RADIO, "data-key-view-kbd"),
          `bottom-edge ArrowDown must leave the radio group (report: ${afterDown})`,
        ).toBe(false);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0146-question-dialog-keyboard] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "multi-question wizard: Return picks the ringed option and advances to the next question (return-return-return)",
    async () => {
      const app = await launchTugApp({
          testName: "at0146-question-dialog-keyboard",
          foreground: true,
        });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_COMPACT), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");
        await app.driveSession("A", { op: "send", text: "ask me something" });
        await ingestQuestion(app, controlRequestForwardMultiQuestion());

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DIALOG)}) !== null`,
          { timeoutMs: 6000 },
        );
        await app.waitForCondition<boolean>(`document.hasFocus()`, { timeoutMs: 10000 });

        // On open, Q1's options hold the key view and show Q1's labels.
        await app.waitForCondition<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(RADIO)});return el!==null && el.hasAttribute("data-key-view-kbd");})()`,
          { timeoutMs: 4000 },
        );
        const q1Text = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(RADIO)})||{}).textContent || ""`,
        );
        expect(q1Text.includes("Expression argument"), "Q1 options render").toBe(true);

        // Return on the options picks the ringed option (like Space) and the
        // wizard auto-advances — the ring stays ON THE QUESTIONS, moving to Q2's
        // options (NOT onto a Next button). `return-return-return` walks the wizard.
        await app.nativeKey("Return");
        await app.waitForCondition<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(RADIO)});return el!==null && (el.textContent||"").indexOf("Precedence + parens") !== -1;})()`,
          { timeoutMs: 4000 },
        );
        const q2Text = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(RADIO)})||{}).textContent || ""`,
        );
        expect(
          q2Text.includes("Precedence + parens"),
          `Enter advanced to Q2 (current options now: ${q2Text.slice(0, 60)})`,
        ).toBe(true);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0146-question-dialog-keyboard] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "free-text answer: Shift-Return advances the wizard, not some other filled button",
    async () => {
      const app = await launchTugApp({
          testName: "at0146-question-dialog-keyboard",
          foreground: true,
        });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_COMPACT), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");
        await app.driveSession("A", { op: "send", text: "ask me something" });
        await ingestQuestion(app, controlRequestForwardMultiQuestion());

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DIALOG)}) !== null`,
          { timeoutMs: 6000 },
        );
        await app.waitForCondition<boolean>(`document.hasFocus()`, { timeoutMs: 10000 });
        await app.waitForCondition<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(RADIO)});return el!==null && el.hasAttribute("data-key-view-kbd");})()`,
          { timeoutMs: 4000 },
        );

        // Tab within the trap until the free-text field holds the key view.
        let onField = false;
        for (let i = 0; i < 10 && !onField; i += 1) {
          await app.nativeKey("Tab");
          await sleep(150);
          onField = await hasAttr(app, FREE_TEXT, "data-key-view-kbd");
        }
        expect(onField, "Tab reaches the free-text answer field").toBe(true);

        // The field takes real typing (the caret is in the CM6 document).
        await app.nativeType("my own answer");
        await sleep(250);
        const typed = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(FREE_TEXT_CONTENT)})||{}).textContent || ""`,
        );
        expect(typed, "the field holds the typed answer").toBe("my own answer");

        // The editor's submit chord defers to the scope's default button when one
        // is registered. Record every click so a stray default-button activation
        // (e.g. the transcript's filled "Scroll to latest" affordance) is caught
        // as itself, not as a silent no-advance.
        await app.evalJS<boolean>(
          `(function(){window.__at0146Clicks=[];document.addEventListener("click",function(e){var t=e.target;window.__at0146Clicks.push((t.getAttribute&&t.getAttribute("aria-label"))+"|"+(t.textContent||"").slice(0,24));},true);return true;})()`,
        );

        // [K3] Shift-Return commits the typed answer and advances to Q2.
        await app.nativeKey("Return", ["shift"]);
        await app.waitForCondition<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(RADIO)});return el!==null && (el.textContent||"").indexOf("Precedence + parens") !== -1;})()`,
          { timeoutMs: 4000 },
        );
        const clicks = await app.evalJS<string>(
          `JSON.stringify(window.__at0146Clicks)`,
        );
        expect(
          clicks,
          "Shift-Return runs the field's own submit, activating no other button",
        ).toBe("[]");

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0146-question-dialog-keyboard] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // The companion to the case above, on the seam where the two differ. There the
  // typed answer left an unanswered question behind, so Submit was disabled and
  // registered no default button. Here the typed answer is the LAST one — Submit
  // goes live the instant it lands, and the substrate's default-button deferral
  // would turn the very same Shift-Return into a click on it. Typing an answer
  // must step the wizard exactly like picking an option does; sending is the
  // user's separate act on the blue button.
  test(
    "free-text answer on the last question: Shift-Return moves the ring to Submit, it does not send",
    async () => {
      const app = await launchTugApp({
          testName: "at0146-question-dialog-keyboard",
          foreground: true,
        });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_COMPACT), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");
        await app.driveSession("A", { op: "send", text: "ask me something" });
        // A one-question payload: the only question IS the last one.
        await ingestQuestion(app, controlRequestForwardSingle());

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DIALOG)}) !== null`,
          { timeoutMs: 6000 },
        );
        await app.waitForCondition<boolean>(`document.hasFocus()`, { timeoutMs: 10000 });
        await app.waitForCondition<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(RADIO)});return el!==null && el.hasAttribute("data-key-view-kbd");})()`,
          { timeoutMs: 4000 },
        );

        let onField = false;
        for (let i = 0; i < 10 && !onField; i += 1) {
          await app.nativeKey("Tab");
          await sleep(150);
          onField = await hasAttr(app, FREE_TEXT, "data-key-view-kbd");
        }
        expect(onField, "Tab reaches the free-text answer field").toBe(true);

        await app.nativeType("my own answer");
        await sleep(250);

        // With every question answered, Submit is enabled — and an enabled
        // primary action button IS the scope's registered default button. This
        // is the precondition that makes the deferral reachable at all; assert
        // it so the test can't silently stop covering the seam.
        const submitEnabled = await app.evalJS<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(SUBMIT)});return el!==null && !el.disabled;})()`,
        );
        expect(submitEnabled, "the typed answer completes the payload, enabling Submit").toBe(true);

        await app.nativeKey("Return", ["shift"]);
        await sleep(400);

        // The dialog is still up: the answer was committed, not sent.
        const stillOpen = await app.evalJS<boolean>(
          `document.querySelector(${JSON.stringify(DIALOG)}) !== null`,
        );
        expect(stillOpen, "Shift-Return commits the answer without submitting the dialog").toBe(
          true,
        );

        // …and the ring has moved to Submit, so the follow-up Return sends.
        await app.waitForCondition<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(SUBMIT)});return el!==null && el.hasAttribute("data-key-view-kbd");})()`,
          { timeoutMs: 4000 },
        );

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0146-question-dialog-keyboard] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
