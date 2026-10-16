/**
 * at0333-follow-bottom-unattributed.test.ts — the scroll attribution
 * doctrine, pinned behaviorally: no deferred scroll write survives a user
 * gesture, a gesture ending at the live edge is following it, and a
 * machine-side close never re-engages a reader who left.
 *
 * A native scrollbar drag delivers NO pointer or wheel events to the
 * container in WKWebView — SmartScroll's phase machine sits in `idle` while
 * the user scrubs. These tests drive `scrollTop` by direct assignment
 * (attribution-identical to that scrollbar silence) and assert the machine
 * answers the way the doctrine demands:
 *
 * | Test                | What would break without it                        |
 * |---------------------|----------------------------------------------------|
 * | correction supersede| a two-pass turn-step correction armed before the   |
 * |                     | user moved fires late and snaps them back to the   |
 * |                     | stale target                                       |
 * | gesture end         | a wheel nudge at the live edge strands the user    |
 * |                     | disengaged on a transcript that looks pinned, and  |
 * |                     | every later append silently fails to arrive        |
 * | dialog close        | an inline dialog's close re-engages follow-bottom  |
 * |                     | over a user who scrolled away to read history, and |
 * |                     | the next growth pin yanks them to the bottom; and  |
 * |                     | an unattributed return to the bottom fails to      |
 * |                     | re-engage, so streaming stops tracking the edge    |
 *
 * The gesture-end test also pins the anchoring gate: scroll anchoring
 * holds mid-viewport content still against height changes above it,
 * which is definitionally opposed to the pin — so SmartScroll stamps
 * `overflow-anchor: none` on the container while following. That the
 * gate opens for a parked reader, and that an idle upward scroll is never
 * pulled back by growth, are in `at0335-scroll-reader-held.test.ts`.
 *
 * Growth pins are provoked by streaming a real turn into the seeded session
 * (`driveSessionBatch` ingest — the same channel live streaming uses), never
 * by synthetic DOM mutation.
 *
 * @covers tugdeck/src/lib/smart-scroll.ts
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/components/tugways/use-inline-dialog-scope.ts
 * @covers tugdeck/src/components/tugways/internal/scroller-context.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, type App } from "./_harness";
import type { SessionDriveAction } from "./_harness/client";
import { sessionCardShape } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;
const FEED_CODE_OUTPUT = 0x40;

const SID = "at0333-A";
const TURNS = 60;
const SCROLLER = '[data-tug-scroll-key="session-card-transcript"]';
const JUMP_BUTTON = ".tug-jump-to-bottom-button";

/** SmartScroll's at-bottom jitter band; an upward move must clear it to
 *  count as leaving the bottom. */
const AT_BOTTOM_PX = 60;

function replyText(n: number): string {
  return [
    `## step ${n}`,
    "",
    `Reply number ${n}. The band is measured from the canvas, not observed,`,
    "so the offset re-resolves on reflow and the row keeps its height.",
    "",
    `- marker ${n}`,
  ].join("\n");
}

function frame(decoded: Record<string, unknown>): SessionDriveAction {
  return {
    op: "ingestFrame",
    feedId: FEED_CODE_OUTPUT,
    decoded: { tug_session_id: SID, ...decoded },
  };
}

/** Stream one committed prompt→reply turn into the bound session, as
 *  one batch. */
function seedTurn(app: App, n: number): Promise<void> {
  const msgId = `${SID}-m${n}`;
  return app.driveSessionBatch("A", [
    { op: "send", text: `prompt ${n}` },
    frame({ type: "prompt_anchor", promptUuid: `${SID}-u${n}` }),
    frame({
      type: "content_block_start",
      msg_id: msgId,
      block_index: 0,
      kind: "text",
    }),
    frame({
      type: "assistant_text",
      seq: 0,
      rev: 0,
      status: "complete",
      msg_id: msgId,
      block_index: 0,
      text: replyText(n),
      is_partial: false,
    }),
    frame({ type: "turn_complete", seq: 0, msg_id: msgId, result: "success" }),
  ]);
}

/** Wait until the transcript has settled: two frames have passed, no
 *  eviction drain is under way, the rendered window covers the viewport
 *  (no spacer reaches into it), and — given `grewFrom` — the extent has
 *  grown past it, so a streamed turn has landed.
 *
 *  (Comments inside the evaluated source below must not use backticks:
 *  it is a template literal, and a backtick would end it.) */
async function settle(app: App, grewFrom?: number): Promise<void> {
  await app.evalJS<boolean>(`(function () {
  window.__at0333Frames = false;
  requestAnimationFrame(function () {
    requestAnimationFrame(function () { window.__at0333Frames = true; });
  });
  return true;
})()`);
  await app.waitForCondition<boolean>(
    `(function () {
  if (!window.__at0333Frames) return false;
  var el = document.querySelector('${SCROLLER}');
  if (el === null || el.hasAttribute("data-evict-stale")) return false;
  ${grewFrom === undefined ? "" : `if (el.scrollHeight <= ${grewFrom}) return false;`}
  var r = el.getBoundingClientRect();
  var ts = el.querySelector(".tug-list-view-spacer--top");
  if (ts !== null && ts.offsetHeight > 0 && ts.getBoundingClientRect().bottom > r.top + 1) return false;
  var bs = el.querySelector(".tug-list-view-spacer--bottom");
  if (bs !== null && bs.offsetHeight > 0 && bs.getBoundingClientRect().top < r.bottom - 1) return false;
  return true;
})()`,
    { timeoutMs: 10_000 },
  );
}

/** Give a condition the next assertion reads a bounded chance to come
 *  true. Never an assertion itself: the caller asserts what it reads
 *  next, so a condition that never arrives still fails there. */
async function awaitQuietly(app: App, expr: string): Promise<void> {
  await app.waitForCondition<boolean>(expr, { timeoutMs: 3_000 }).catch(() => undefined);
}

const AT_LIVE_EDGE = `(function () {
  var el = document.querySelector('${SCROLLER}');
  return el.scrollHeight - el.clientHeight - el.scrollTop <= 4;
})()`;

const BUTTON_VISIBLE = `(function () {
  var b = document.querySelector('${JUMP_BUTTON}');
  return b !== null && b.getAttribute("data-visible") === "true";
})()`;

const BUTTON_HIDDEN = `(function () {
  var b = document.querySelector('${JUMP_BUTTON}');
  return b === null || b.getAttribute("data-visible") !== "true";
})()`;

/** Launch, seed a tall transcript, and wait until eviction has armed —
 *  the list is settled and follow-bottom is engaged at the live edge. */
// Kept local: every file's `standUp` launches into its own deck and transcript,
// so the name is shared and the function is not.
async function standUp(testName: string): Promise<App> {
  const app = await launchTugApp({ testName });
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: sessionCardShape({ width: 900, height: 760 }), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  await app.bindSession("A", { tugSessionId: SID });
  await app.awaitEngineReady("A", { timeoutMs: 20_000 });
  for (let n = 0; n < TURNS; n += 1) {
    await seedTurn(app, n);
  }
  await app.waitForCondition<boolean>(
    `!!document.querySelector('${SCROLLER}[data-evict-active]')`,
    { timeoutMs: 30_000 },
  );
  await settle(app);
  return app;
}

interface ScrollSnap {
  top: number;
  maxScroll: number;
  scrollHeight: number;
  buttonVisible: string | null;
}

/** Follow-bottom transitions from the dev log, oldest first. Recorded
 *  with no opt-in, so the attribution chain is readable in exactly the
 *  sessions nobody thought to instrument. */
function readFollowBottomTransitions(
  app: App,
): Promise<{ source: string; following: boolean }[]> {
  return app.evalJS(`(function () {
  return window.tugDevLog.getSnapshot().entries
    .filter(function (e) {
      return e.source === "smart-scroll" && e.message === "follow-bottom";
    })
    .map(function (e) {
      return { source: e.data.source, following: e.data.following };
    });
})()`);
}

/** The container's anchoring gate, as SmartScroll stamped it:
 *  `"none"` while following the bottom, `""` while the user reads. */
function readAnchoringGate(app: App): Promise<string> {
  return app.evalJS<string>(
    `document.querySelector('${SCROLLER}').style.overflowAnchor`,
  );
}

/** Present a live AskUserQuestion dialog inside a streamed turn: the
 *  `tool_use` hosts the wizard at its transcript position, the
 *  `is_question` forward makes it live. The returned msgId's
 *  `turn_complete` withdraws the question and closes the dialog —
 *  the machine-side dismissal, no UI interaction involved. */
async function presentQuestion(app: App, tag: string): Promise<string> {
  const msgId = `${SID}-dlg-${tag}`;
  const questions = [
    {
      question: "Pick any that apply",
      header: "Pick",
      multiSelect: true,
      options: [{ label: "Alpha" }, { label: "Beta" }],
    },
  ];
  await app.driveSessionBatch("A", [
    { op: "send", text: `ask me something ${tag}` },
    frame({
      type: "tool_use",
      msg_id: msgId,
      tool_use_id: `${SID}-tu-${tag}`,
      tool_name: "AskUserQuestion",
      input: { questions },
      seq: 1,
    }),
    frame({
      type: "control_request_forward",
      request_id: `${SID}-q-${tag}`,
      tool_use_id: `${SID}-tu-${tag}`,
      is_question: true,
      tool_name: "AskUserQuestion",
      input: { questions },
    }),
  ]);
  await app.waitForCondition<boolean>(
    `!!document.querySelector('[data-slot="session-question-dialog"]')`,
    { timeoutMs: 10_000 },
  );
  return msgId;
}

/** End the turn that hosts a live question — the dialog closes the way
 *  a withdrawn request does, with no pointer or key anywhere near it. */
async function withdrawQuestion(app: App, msgId: string): Promise<void> {
  await app.driveSession(
    "A",
    frame({ type: "turn_complete", seq: 0, msg_id: msgId, result: "success" }),
  );
  await app.waitForCondition<boolean>(
    `document.querySelector('[data-slot="session-question-dialog"]') === null`,
    { timeoutMs: 10_000 },
  );
}

function readSnap(app: App): Promise<ScrollSnap> {
  return app.evalJS<ScrollSnap>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var btn = document.querySelector('${JUMP_BUTTON}');
  return {
    top: el.scrollTop,
    maxScroll: el.scrollHeight - el.clientHeight,
    scrollHeight: el.scrollHeight,
    buttonVisible: btn === null ? null : btn.getAttribute("data-visible"),
  };
})()`);
}

describe.skipIf(!SHOULD_RUN)("AT0333: unattributed scroll attribution", () => {
  test(
    "a user scroll voids a pending turn-step correction — no late snap",
    async () => {
      const app = await standUp("at0333-supersede");
      try {
        // Arm a two-pass correction, then move before it can fire — all
        // in ONE synchronous block, so no commit can land in between.
        // The ⌃⌘[ chord dispatch enters the responder chain's document-
        // level capture listener exactly as a real chord does (the same
        // route at0330's turn stepping uses). Synchronous presses outrun
        // the async re-window, so the later presses target entries that
        // are still unmounted and take the estimated-jump + post-commit-
        // correction path; the final scrollTop assignment then drifts
        // well past the supersede band before any commit runs.
        const armed = await app.evalJS<{
          afterPresses: number;
          assigned: number;
        }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  for (var i = 0; i < 8; i += 1) {
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "[", code: "BracketLeft",
      ctrlKey: true, metaKey: true,
      bubbles: true, cancelable: true, composed: true,
    }));
  }
  var afterPresses = el.scrollTop;
  el.scrollTop = afterPresses + 300;
  return { afterPresses: afterPresses, assigned: el.scrollTop };
})()`);
        expect(armed.assigned - armed.afterPresses).toBeGreaterThan(8);

        // Let commits settle; the voided correction must never fire.
        // A negative, so the window is time, not a condition.
        await app.evalJS<boolean>(`(function () {
  window.__at0333 = { minSeen: Infinity, maxSeen: -Infinity };
  window.__at0333Timer = setInterval(function () {
    var e = document.querySelector('${SCROLLER}');
    if (e === null) return;
    if (e.scrollTop < window.__at0333.minSeen) window.__at0333.minSeen = e.scrollTop;
    if (e.scrollTop > window.__at0333.maxSeen) window.__at0333.maxSeen = e.scrollTop;
  }, 16);
  return true;
})()`);
        await new Promise((r) => setTimeout(r, 1500));
        const result = await app.evalJS<{
          minSeen: number;
          maxSeen: number;
          finalTop: number;
        }>(`(function () {
  clearInterval(window.__at0333Timer);
  var el = document.querySelector('${SCROLLER}');
  return {
    minSeen: window.__at0333.minSeen,
    maxSeen: window.__at0333.maxSeen,
    finalTop: el.scrollTop,
  };
})()`);
        // The position the user chose holds: no write ever pulled
        // scrollTop back toward the stale step target (300px below the
        // band would show up in minSeen), and nothing moved it at all.
        expect(armed.assigned - result.minSeen).toBeLessThanOrEqual(50);
        expect(result.maxSeen - armed.assigned).toBeLessThanOrEqual(50);
        expect(Math.abs(result.finalTop - armed.assigned)).toBeLessThanOrEqual(
          50,
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a wheel nudge at the live edge re-engages when the gesture ends",
    async () => {
      const app = await standUp("at0333-gesture-end");
      try {
        // Following at stand-up, so the anchoring gate is closed.
        expect(await readAnchoringGate(app)).toBe("none");

        // A small upward wheel nudge that stays inside the at-bottom
        // band. The wheel disengage carries no band guard — a 20px
        // twitch releases follow-bottom — which is exactly why the
        // gesture-end route must exist: the gesture ends at the live
        // edge, and stranding the user disengaged there turns a twitch
        // into a transcript that silently stops arriving.
        await app.evalJS<boolean>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.dispatchEvent(new WheelEvent('wheel', {
    deltaY: -20, bubbles: true, cancelable: true,
  }));
  el.scrollTop = el.scrollTop - 20;
  return true;
})()`);

        // End the gesture the way at0335's wheel drive does: let the
        // queued scroll events drain, then pointerup — synthetic wheels
        // do not reliably produce a scrollend, and any that does arrive
        // early lands in the same gesture-end check.
        await settle(app);
        await app.evalJS<boolean>(`(function () {
  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  return true;
})()`);
        await awaitQuietly(
          app,
          `window.tugDevLog.getSnapshot().entries.some(function (e) {
  return e.source === "smart-scroll" && e.message === "follow-bottom" &&
    e.data.source === "gesture-end-at-bottom-reengage";
}) && ${BUTTON_HIDDEN}`,
        );

        // Re-engaged at gesture end through the at-bottom flavor: the
        // gesture was net-UPWARD, so the net-down path cannot claim
        // it — position inside the band is the whole statement.
        const transitions = await readFollowBottomTransitions(app);
        const wheelUp = transitions.findIndex(
          (t) => t.source === "wheel-up" && !t.following,
        );
        expect(wheelUp).toBeGreaterThanOrEqual(0);
        const reengage = transitions.findIndex(
          (t, i) =>
            i > wheelUp &&
            t.source === "gesture-end-at-bottom-reengage" &&
            t.following,
        );
        expect(reengage).toBeGreaterThan(wheelUp);
        expect((await readSnap(app)).buttonVisible).toBe("false");
        expect(await readAnchoringGate(app)).toBe("none");

        // And streaming still tracks the live edge.
        const before = (await readSnap(app)).scrollHeight;
        await seedTurn(app, TURNS);
        await settle(app, before);
        await awaitQuietly(app, AT_LIVE_EDGE);
        const pinned = await readSnap(app);
        expect(pinned.maxScroll - pinned.top).toBeLessThanOrEqual(4);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an inline dialog's close re-engages only a user still at the bottom",
    async () => {
      const app = await standUp("at0333-dialog");
      try {
        // A live question opens at the bottom: its scope releases
        // follow-bottom (a declared machine disengage) and reveals the
        // whole dialog. The user then scrolls away to read history
        // while the question waits.
        const first = await presentQuestion(app, "a");
        await settle(app);
        await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = el.scrollTop - ${AT_BOTTOM_PX * 15};
  return el.scrollTop;
})()`);
        await settle(app);

        // The question is withdrawn under them. Case B: re-engagement
        // requires attributed arrival at the bottom, and this user is
        // parked mid-history — the close must NOT flip follow-bottom
        // back on. The negative source assertion is the pin: an
        // unconditional close-side engage would record
        // `inline-dialog / following: true` right here. A negative, so
        // the close gets time to have done it.
        await withdrawQuestion(app, first);
        await new Promise((r) => setTimeout(r, 500));
        const transitions = await readFollowBottomTransitions(app);
        expect(
          transitions.some(
            (t) => t.source === "inline-dialog" && t.following,
          ),
        ).toBe(false);
        expect((await readSnap(app)).buttonVisible).toBe("true");

        // Growth stays away from the parked reader.
        const beforeGrowth = (await readSnap(app)).scrollHeight;
        await seedTurn(app, TURNS);
        await settle(app, beforeGrowth);
        const held = await readSnap(app);
        expect(held.maxScroll - held.top).toBeGreaterThan(AT_BOTTOM_PX * 4);
        expect(held.buttonVisible).toBe("true");

        // Now the other polarity: return to the bottom the same silent
        // way — an unattributed scroll INTO the at-bottom band, the idle
        // re-engage — sit through a second question, and let it close
        // with the user still settled at the dialog's edge. Behavioral
        // assert only — the machine may legitimately re-engage this
        // parked-in-band user before the close does (growth-at-bottom),
        // and either route is a correct arrival.
        await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = el.scrollHeight - el.clientHeight;
  return el.scrollTop;
})()`);
        await settle(app);
        await awaitQuietly(app, BUTTON_HIDDEN);
        expect((await readSnap(app)).buttonVisible).toBe("false");

        const second = await presentQuestion(app, "b");
        await settle(app);
        await withdrawQuestion(app, second);
        await settle(app);
        await awaitQuietly(app, BUTTON_HIDDEN);
        expect((await readSnap(app)).buttonVisible).toBe("false");

        // The next streamed turn tracks the live edge.
        const beforePin = (await readSnap(app)).scrollHeight;
        await seedTurn(app, TURNS + 1);
        await settle(app, beforePin);
        await awaitQuietly(app, `${AT_LIVE_EDGE} && ${BUTTON_HIDDEN}`);
        const pinned = await readSnap(app);
        expect(pinned.maxScroll - pinned.top).toBeLessThanOrEqual(4);
        expect(pinned.buttonVisible).toBe("false");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
