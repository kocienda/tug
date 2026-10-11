/**
 * at0400-tab-release.test.ts — a text field that declares `tabMovesFocus`
 * really does release Tab.
 *
 * ## Why this exists
 *
 * The question dialog's free-text answer field was a tab jail. Tab into it and
 * Tab typed: an indent went into the document and the dialog's Cancel / Back /
 * Next / Submit stayed one gesture out of reach, with the mouse the only way
 * back out.
 *
 * The field had asked not to be. It has carried `tabMovesFocus` since it was
 * written — but all that prop did was SUPPRESS the "Tab is mine" marker, and the
 * focus walk's yield test does not depend on that marker. The test is
 * structural, and rightly so: a contentEditable or `TEXTAREA` is multi-line, and
 * indent is a real meaning a multi-line surface has. That default is why the
 * composer eats Tab, and it fired here too — over the field's own wishes,
 * because an absence cannot outrank a rule.
 *
 * So the declaration became positive and audible: `data-tug-tab-release` on the
 * content DOM, read by the walk BEFORE the structural test. The surface is the
 * one that knows whether its Tab means indent.
 *
 * This suite drives the real dialog: Tab onto the field, Tab again, and the ring
 * must have MOVED — with the document still empty, because a released Tab is
 * never also a typed one.
 *
 * @covers tugdeck/src/components/tugways/responder-chain-provider.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor.tsx
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 * @covers tugdeck/src/components/tugways/chrome/session-question-dialog.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0400-session";
const FEED_CODE_OUTPUT = 0x40;

const CARD = '[data-card-id="A"]';
const DIALOG = `${CARD} [data-slot="session-question-dialog"]`;
const FIELD = `${DIALOG} [data-slot="session-question-dialog-freetext"]`;
const FIELD_CONTENT = `${FIELD} .cm-content`;

const settle = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 860, height: 720 },
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

function questionForward(): Record<string, unknown> {
  return {
    type: "control_request_forward",
    tug_session_id: SID,
    request_id: "at0400-q-1",
    tool_use_id: "at0400-tu-1",
    is_question: true,
    tool_name: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "Which way out?",
          multiSelect: false,
          options: [{ label: "Left" }, { label: "Right" }],
        },
      ],
    },
  };
}

/** Where the keyboard rests, named. */
function keyViewName(app: App): Promise<string> {
  return app.evalJS<string>(
    `(function(){
      var el = document.querySelector("[data-key-view-kbd]");
      if (el === null) return "none";
      return el.getAttribute("data-testid") || el.getAttribute("data-slot") ||
        el.getAttribute("aria-label") || el.tagName.toLowerCase();
    })()`,
  );
}

/**
 * Is the free-text document still empty? Read from the placeholder, which CM6
 * shows for an empty document and drops on the first character — `textContent`
 * would return the placeholder's own words and read as typed text.
 */
function fieldEmpty(app: App): Promise<boolean> {
  return app.evalJS<boolean>(
    `document.querySelector(${JSON.stringify(FIELD_CONTENT)})?.querySelector(".cm-placeholder") !== null`,
  );
}

describe.skipIf(!SHOULD_RUN)(
  "AT0400: the question dialog's answer field releases Tab instead of indenting",
  () => {
    test(
      "Tab moves the ring off the field and types nothing into it",
      async () => {
        const app = await launchTugApp({ testName: "at0400-tab-release" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 15_000 },
          );
          await app.bindSession("A", { tugSessionId: SID });
          await app.awaitEngineReady("A");

          await app.driveSession("A", { op: "send", text: "ask me" });
          const forward = questionForward();
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: {
              type: "tool_use",
              tug_session_id: SID,
              msg_id: "at0400-msg-1",
              tool_use_id: forward.tool_use_id,
              tool_name: "AskUserQuestion",
              input: forward.input,
              seq: 1,
            },
          });
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: forward,
          });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(FIELD_CONTENT)}) !== null`,
            { timeoutMs: 10_000 },
          );
          await settle(500);

          // The field declares its release out loud — the walk reads this
          // attribute, not the absence of another one.
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(FIELD_CONTENT)})?.getAttribute("data-tug-tab-release") === "true"`,
            ),
            "the answer field states that Tab is not its own",
          ).toBe(true);

          // Click into the field the way a user reaches it, so the caret is
          // really inside a contentEditable when Tab arrives.
          await app.nativeClickAtElement(FIELD_CONTENT);
          await settle(350);
          expect(
            await app.evalJS<boolean>(
              `document.activeElement?.closest(${JSON.stringify(FIELD)}) !== null`,
            ),
            "the caret is in the answer field",
          ).toBe(true);

          const before = await keyViewName(app);
          await app.nativeKey("Tab", []);
          await settle(350);
          const after = await keyViewName(app);
          const stillEmpty = await fieldEmpty(app);
          note("tab out of the answer field", { before, after, stillEmpty });

          expect(stillEmpty, "a released Tab is not also a typed one").toBe(true);
          expect(
            await app.evalJS<boolean>(
              `document.activeElement?.closest(${JSON.stringify(FIELD)}) !== null`,
            ),
            "Tab took the caret out of the field",
          ).toBe(false);
          expect(after, "and landed it on a stop of the dialog").not.toBe("none");

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(`\n[at0400-tab-release] log tail:\n${tail}\n`);
          }
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
