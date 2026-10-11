/**
 * at0402-caret-owns-arrows.test.ts — a granted caret keeps its caret keys while
 * KBF is engaged, and the plane takes them back the moment the stop parks.
 *
 * ## Why this exists
 *
 * The mode's paint answers to the keyboard ROUTE ({@link FocusManager.kbfPainting}):
 * engaged with a caret granted, the rings stand down and the doctrine says the
 * keyboard belongs to the text surface. The MOVEMENT stages did not get that
 * memo — they gated on `kbfEngaged()` — so wherever a surface declared a spatial
 * order the engine kept steering through the caret. Measured on the question
 * dialog's free-text answer field, which is a trapped (Class A) surface and so
 * is engaged from the moment it opens:
 *
 * | after            | key view      | ring          | activeElement    |
 * |------------------|---------------|---------------|------------------|
 * | typing           | message editor| none          | `cm-content`     |
 * | ArrowDown        | push button   | push button   | `tug-key-sink`   |
 * | ArrowUp          | message editor| message editor| `tug-key-sink`  |
 *
 * A user mid-sentence pressed ↓ and lost the caret; ↑ brought the ring back to
 * the field but PARKED, so they still could not type. Nothing painted at the
 * moment of the theft, which is exactly what kept it invisible for a phase.
 *
 * The rule is [P07]'s structural split applied to the arrow plane: horizontal
 * arrows belong to any caret, vertical arrows belong to a multi-line surface.
 * The discriminating half of this suite is the second act — Tab PARKS the field,
 * and then the very same ↓ moves the ring, which is what proves the fix is a
 * caret rule and not a blanket "arrows never move in a dialog".
 *
 * @covers tugdeck/src/components/tugways/responder-chain-provider.tsx
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 * @covers tugdeck/src/components/tugways/chrome/session-question-dialog.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0402-session";
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
    request_id: "at0402-q-1",
    tool_use_id: "at0402-tu-1",
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

/**
 * Where the keyboard is, what is painted, and whether the caret is really in
 * the field — the three answers this rule is about, read in one pass so they
 * cannot describe different instants.
 */
function probe(app: App): Promise<Record<string, unknown>> {
  return app.evalJS<Record<string, unknown>>(
    `(function(){
      // Named by LABEL first, not by slot: a dialog's button row is four
      // elements all slotted "tug-push-button", so a slot name cannot tell a
      // move from a stay — which is the whole question here.
      var name = function(el){
        if (el === null) return "none";
        var label = el.getAttribute("aria-label") ||
          (el.textContent || "").trim().slice(0, 24);
        var slot = el.getAttribute("data-slot") || el.tagName.toLowerCase();
        return label === "" ? slot : slot + ":" + label;
      };
      return {
        engaged: window.__tug.kbfEngaged(),
        painting: document.documentElement.hasAttribute("data-kbf"),
        ringed: name(document.querySelector("[data-key-view-kbd]")),
        keyView: name(document.querySelector("[data-key-view]")),
        caretInField:
          document.activeElement?.closest(${JSON.stringify(FIELD)}) !== null
      };
    })()`,
  );
}

async function openTheQuestionDialog(app: App): Promise<void> {
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
      msg_id: "at0402-msg-1",
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
}

describe.skipIf(!SHOULD_RUN)(
  "AT0402: a granted caret owns its arrows; a parked stop gives them back",
  () => {
    test(
      "arrows stay with the caret in an engaged dialog, and move the ring once it parks",
      async () => {
        const app = await launchTugApp({ testName: "at0402-caret-owns-arrows" });
        try {
          await openTheQuestionDialog(app);

          // Reach the field the way a user does, so the caret is genuinely
          // granted rather than seeded by the harness.
          await app.nativeClickAtElement(FIELD_CONTENT);
          await settle(350);
          await app.nativeType("abc");
          await settle(250);

          const armed = await probe(app);
          note("caret granted inside the engaged dialog", armed);

          // The precondition that makes this test mean anything: the trap has
          // the mode ON, and the granted caret has the paint standing down.
          // Without both, the arrow never reaches the branch under test.
          expect(armed.engaged, "the trapped dialog engages the mode").toBe(true);
          expect(
            armed.painting,
            "and the granted caret stands the paint down — no ring anywhere",
          ).toBe(false);
          expect(armed.caretInField, "the caret is in the answer field").toBe(true);

          // ---- Act one: the arrows belong to the caret ----
          await app.nativeKey("ArrowDown", []);
          await settle(300);
          const afterDown = await probe(app);
          note("after ArrowDown", afterDown);
          expect(
            afterDown.caretInField,
            "↓ in a multi-line field is a caret key, not a ring move",
          ).toBe(true);
          expect(afterDown.painting, "and nothing rings").toBe(false);

          await app.nativeKey("ArrowUp", []);
          await settle(300);
          expect(
            (await probe(app)).caretInField,
            "↑ likewise",
          ).toBe(true);

          await app.nativeKey("ArrowLeft", []);
          await settle(300);
          expect(
            (await probe(app)).caretInField,
            "and a horizontal arrow belongs to any caret",
          ).toBe(true);

          // ---- Act two: parking hands them back ----
          // This is the half that discriminates, and it is deliberately the
          // HORIZONTAL pair: act one watched ← stay with the caret, and the
          // same key must now move the ring. Same key, opposite outcome,
          // decided by nothing but whether a caret is live — which is the whole
          // claim. (↓ is the wrong probe here: Tab lands on the dialog's button
          // row, which is the bottom of its declared plane, so a ↓ that moved
          // nothing would prove nothing either way.)
          //
          // The field declares `data-tug-tab-release`, so Tab leaves it
          // (at0400), parking the walk on a dialog stop and bringing the rings
          // up.
          await app.nativeKey("Tab", []);
          await settle(350);
          const parked = await probe(app);
          note("after Tab parked the walk", parked);
          expect(parked.caretInField, "Tab took the caret out of the field").toBe(
            false,
          );
          expect(parked.painting, "and the mode is painting again").toBe(true);

          const keyViewBefore = parked.keyView;
          await app.nativeKey("ArrowRight", []);
          await settle(300);
          const moved = await probe(app);
          note("after ArrowRight with no caret live", moved);
          expect(
            moved.keyView !== keyViewBefore,
            "with no caret to protect, the horizontal arrow moves the ring again",
          ).toBe(true);
          expect(moved.painting, "and it lands painted").toBe(true);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(`\n[at0402-caret-owns-arrows] log tail:\n${tail}\n`);
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
