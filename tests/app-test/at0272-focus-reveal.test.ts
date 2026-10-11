/**
 * at0272-focus-reveal.test.ts — a keyboard focus move reveals its target.
 *
 * The focus engine writes DOM focus with `{ preventScroll: true }` ([D07]), so
 * for years a keyboard move that landed the key view below the fold rang an
 * element the user could not see. `focus-reveal.ts` closes that: whenever a
 * KEYBOARD key view changes, the engine scrolls the new key view into view in
 * every scrollable ancestor, minimally, clearing any stuck sticky header.
 *
 * The fixture is the question wizard in a short pane: three tall questions
 * overflow the card scrollport, and `Chat about this instead` sits at the very
 * foot of the dialog. Park the view at the TOP of the dialog — the foot is then
 * off the bottom edge — then arrow down out of the options list until the key
 * view reaches the foot button. The button must be inside the scrollport when
 * it takes the ring, without any manual scroll.
 *
 * "Visible" is measured against the block's sticky `.tool-call-header` as well
 * as the scrollport (see at0202): the stuck header overlays the top band, so a
 * target flush with the scrollport top is still pixel-hidden.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/focus-reveal.ts
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 * @covers tugdeck/src/components/tugways/internal/scroller-context.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const FEED_CODE_OUTPUT = 0x40;
const SID = "at0272-session";

const CARD = '[data-card-id="A"]';
const SCROLLER = `${CARD} [data-tug-scroll-key="session-card-transcript"]`;
const DIALOG = `${CARD} [data-slot="session-question-dialog"]`;
const OPTIONS = `${DIALOG} .session-question-dialog-options-list`;
const CHAT_ABOUT = `${DIALOG} [data-slot="session-question-dialog-chat-about"]`;
const CHAT_ABOUT_BUTTON = `${CHAT_ABOUT} .tug-button`;
const ACTIONBAR = `${DIALOG} [data-slot="session-question-dialog-actionbar"]`;
const RAIL_BUTTONS = `${ACTIONBAR} .tug-button`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Long option descriptions so the dialog overflows the short pane. */
function longOptions(prefix: string): Array<Record<string, string>> {
  return [1, 2, 3, 4].map((n) => ({
    label: `${prefix} option ${n}`,
    description:
      "A deliberately long option description that wraps across multiple " +
      "lines in the panel so the dialog grows well past the card scrollport " +
      "height and its foot controls start below the bottom edge.",
  }));
}

function tallQuestions(): Array<Record<string, unknown>> {
  return [1, 2, 3].map((n) => ({
    question: `Tall question ${n}?`,
    multiSelect: false,
    options: longOptions(`Q${n}`),
  }));
}

interface RevealState {
  scrollerTop: number;
  scrollerBottom: number;
  targetTop: number;
  targetBottom: number;
  headerBottom: number;
  ringed: boolean;
  scrollTop: number;
}

function readState(
  app: App,
  targetSel: string = CHAT_ABOUT,
  buttonSel: string = CHAT_ABOUT_BUTTON,
): Promise<RevealState> {
  return app.evalJS<RevealState>(
    `(function(){
      var s = document.querySelector(${JSON.stringify(SCROLLER)});
      var t = document.querySelector(${JSON.stringify(targetSel)});
      var bs = document.querySelectorAll(${JSON.stringify(buttonSel)});
      var d = document.querySelector(${JSON.stringify(DIALOG)});
      var chrome = d ? d.closest('.tool-block-chrome') : null;
      var h = chrome ? chrome.querySelector('.tool-call-header') : null;
      var sr = s ? s.getBoundingClientRect() : { top: -1, bottom: -1 };
      var tr = t ? t.getBoundingClientRect() : { top: -1, bottom: -1 };
      var hr = h ? h.getBoundingClientRect() : { bottom: -1 };
      return {
        scrollerTop: sr.top,
        scrollerBottom: sr.bottom,
        targetTop: tr.top,
        targetBottom: tr.bottom,
        headerBottom: hr.bottom,
        ringed: Array.prototype.some.call(bs, function(b){
          return b.hasAttribute("data-key-view-kbd");
        }),
        scrollTop: s ? s.scrollTop : -1
      };
    })()`,
  );
}

/** Fully inside the scrollport's band and clear of the stuck header. */
function visible(state: RevealState): boolean {
  return (
    state.targetTop >= state.scrollerTop - 1 &&
    state.targetTop >= state.headerBottom - 1 &&
    state.targetBottom <= state.scrollerBottom + 1
  );
}

async function openQuestion(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: sessionCardShape({ width: 820, height: 480 }), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  await app.bindSession("A", { tugSessionId: SID });
  await app.awaitEngineReady("A");

  await app.driveSession("A", { op: "send", text: "ask me" });
  await app.driveSession("A", {
    op: "ingestFrame",
    feedId: FEED_CODE_OUTPUT,
    decoded: {
      type: "assistant_text",
      status: "partial",
      tug_session_id: SID,
      msg_id: "at0272-msg-1",
      text: "Questions…",
      is_partial: true,
      rev: 0,
      seq: 0,
    },
  });
  const forward = {
    type: "control_request_forward",
    tug_session_id: SID,
    request_id: "at0272-q-1",
    tool_use_id: "at0272-tu-1",
    is_question: true,
    tool_name: "AskUserQuestion",
    input: { questions: tallQuestions() },
  };
  await app.driveSession("A", {
    op: "ingestFrame",
    feedId: FEED_CODE_OUTPUT,
    decoded: {
      type: "tool_use",
      tug_session_id: SID,
      msg_id: "at0272-msg-1",
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
    `document.querySelector(${JSON.stringify(DIALOG)}) !== null`,
    { timeoutMs: 6000 },
  );
  await app.waitForCondition<boolean>(
    `(function(){var el=document.querySelector(${JSON.stringify(OPTIONS)});return el!==null && el.hasAttribute("data-key-view-kbd");})()`,
    { timeoutMs: 6000 },
  );
  await sleep(300);
}

describe.skipIf(!SHOULD_RUN)("AT0272: keyboard focus reveals its target", () => {
  test(
    "arrowing to the dialog's foot button scrolls it into view",
    async () => {
      const app = await launchTugApp({ testName: "at0272-focus-reveal" });
      try {
        await openQuestion(app);

        // Park the view at the TOP of the dialog: the foot controls are then
        // below the bottom edge, which is the state the reveal must fix.
        await app.evalJS(
          `(function(){
            var s = document.querySelector(${JSON.stringify(SCROLLER)});
            var d = document.querySelector(${JSON.stringify(DIALOG)});
            if (!s || !d) return false;
            s.scrollTop += d.getBoundingClientRect().top - s.getBoundingClientRect().top;
            s.dispatchEvent(new Event('scroll', { bubbles: false }));
            return true;
          })()`,
        );
        await sleep(300);

        const before = await readState(app);
        expect(
          visible(before),
          `foot button starts off-screen — ${JSON.stringify(before)}`,
        ).toBe(false);

        // Arrow down out of the options list until the foot button rings.
        // Each press is one keyboard key-view move; the reveal rides the
        // move that finally lands on the button.
        let ringed = false;
        for (let i = 0; i < 8 && !ringed; i += 1) {
          await app.nativeKey("ArrowDown");
          await sleep(200);
          ringed = (await readState(app)).ringed;
        }

        const after = await readState(app);
        expect(
          after.ringed,
          `foot button took the ring — ${JSON.stringify(after)}`,
        ).toBe(true);
        expect(
          visible(after),
          `foot button revealed on focus — ${JSON.stringify(after)}`,
        ).toBe(true);
        expect(
          after.scrollTop,
          "the reveal actually scrolled",
        ).toBeGreaterThan(before.scrollTop);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0272] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
  test(
    "arrowing up to the action bar scrolls the rail into view",
    async () => {
      const app = await launchTugApp({ testName: "at0272-focus-reveal-rail" });
      try {
        await openQuestion(app);

        // Park at the live edge — the state a real conversation is in when the
        // question streams in. The action bar sits at the TOP of the dialog,
        // so it starts off the top edge.
        await app.evalJS(
          `(function(){
            var s = document.querySelector(${JSON.stringify(SCROLLER)});
            if (!s) return false;
            s.scrollTop = s.scrollHeight - s.clientHeight;
            s.dispatchEvent(new Event('scroll', { bubbles: false }));
            return true;
          })()`,
        );
        await sleep(300);

        const before = await readState(app, ACTIONBAR, RAIL_BUTTONS);
        expect(
          visible(before),
          `action bar starts off the top — ${JSON.stringify(before)}`,
        ).toBe(false);

        // ArrowUp off the options list's top edge seams to the rail.
        let ringed = false;
        for (let i = 0; i < 8 && !ringed; i += 1) {
          await app.nativeKey("ArrowUp");
          await sleep(200);
          ringed = (await readState(app, ACTIONBAR, RAIL_BUTTONS)).ringed;
        }

        const after = await readState(app, ACTIONBAR, RAIL_BUTTONS);
        expect(
          after.ringed,
          `a rail button took the ring — ${JSON.stringify(after)}`,
        ).toBe(true);
        expect(
          visible(after),
          `action bar revealed on focus — ${JSON.stringify(after)}`,
        ).toBe(true);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0272] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
