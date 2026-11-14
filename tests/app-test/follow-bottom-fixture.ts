/**
 * follow-bottom-fixture.ts — the seeded session, stand-up and readers the
 * at0333-follow-bottom-* files pin the scroll attribution doctrine with: no
 * deferred scroll write survives a user gesture, a gesture ending at the
 * live edge is following it, and a machine-side close never re-engages a
 * reader who left.
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
 * pulled back by growth, are in `at0335-scroll-reader-held-no-revert.test.ts`.
 *
 * Growth pins are provoked by streaming a real turn into the seeded session
 * (`driveSessionBatch` ingest — the same channel live streaming uses), never
 * by synthetic DOM mutation.
 *
 * Each at0333-follow-bottom file launches its own app on the same seed;
 * what they share is how that transcript is built and how it is read.
 *
 * @module tests/app-test/follow-bottom-fixture
 */

import { launchTugApp, type App } from "./_harness";
import type { SessionDriveAction } from "./_harness/client";
import { sessionCardShape } from "./_harness/shapes";
import { waitForBodyReady } from "./_harness/card-reach";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 300_000;
const FEED_CODE_OUTPUT = 0x40;

export const SID = "at0333-A";
export const TURNS = 60;
export const SCROLLER = '[data-tug-scroll-key="session-card-transcript"]';
export const JUMP_BUTTON = ".tug-jump-to-bottom-button";

/** SmartScroll's at-bottom jitter band; an upward move must clear it to
 *  count as leaving the bottom. */
export const AT_BOTTOM_PX = 60;

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

export function frame(decoded: Record<string, unknown>): SessionDriveAction {
  return {
    op: "ingestFrame",
    feedId: FEED_CODE_OUTPUT,
    decoded: { tug_session_id: SID, ...decoded },
  };
}

/** Stream one committed prompt→reply turn into the bound session, as
 *  one batch. */
export function seedTurn(app: App, n: number): Promise<void> {
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
export async function settle(app: App, grewFrom?: number): Promise<void> {
  await app.body("A").evalJS<boolean>(`(function () {
  window.__at0333Frames = false;
  requestAnimationFrame(function () {
    requestAnimationFrame(function () { window.__at0333Frames = true; });
  });
  return true;
})()`);
  await app.body("A").waitForCondition<boolean>(
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
export async function awaitQuietly(app: App, expr: string): Promise<void> {
  await app.body("A").waitForCondition<boolean>(expr, { timeoutMs: 3_000 }).catch(() => undefined);
}

export const AT_LIVE_EDGE = `(function () {
  var el = document.querySelector('${SCROLLER}');
  return el.scrollHeight - el.clientHeight - el.scrollTop <= 4;
})()`;

export const BUTTON_HIDDEN = `(function () {
  var b = document.querySelector('${JUMP_BUTTON}');
  return b === null || b.getAttribute("data-visible") !== "true";
})()`;

/** Launch, seed a tall transcript, and wait until eviction has armed —
 *  the list is settled and follow-bottom is engaged at the live edge. */
// Kept local to this family: every file's `standUp` launches into its own
// deck and transcript, so the name is shared and the function is not.
export async function standUp(testName: string): Promise<App> {
  const app = await launchTugApp({ testName });
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: sessionCardShape({ width: 900, height: 760 }), focusCardId: "A" });
  await waitForBodyReady(app, "A");
  await app.bindSession("A", { tugSessionId: SID });
  await app.awaitEngineReady("A", { timeoutMs: 20_000 });
  for (let n = 0; n < TURNS; n += 1) {
    await seedTurn(app, n);
  }
  await app.body("A").waitForCondition<boolean>(
    `!!document.querySelector('${SCROLLER}[data-evict-active]')`,
    { timeoutMs: 30_000 },
  );
  await settle(app);
  return app;
}

export interface ScrollSnap {
  top: number;
  maxScroll: number;
  scrollHeight: number;
  buttonVisible: string | null;
}

/** Follow-bottom transitions from the dev log, oldest first. Recorded
 *  with no opt-in, so the attribution chain is readable in exactly the
 *  sessions nobody thought to instrument. */
export function readFollowBottomTransitions(
  app: App,
): Promise<{ source: string; following: boolean }[]> {
  return app.body("A").evalJS(`(function () {
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
export function readAnchoringGate(app: App): Promise<string> {
  return app.body("A").evalJS<string>(
    `document.querySelector('${SCROLLER}').style.overflowAnchor`,
  );
}

/** Present a live AskUserQuestion dialog inside a streamed turn: the
 *  `tool_use` hosts the wizard at its transcript position, the
 *  `is_question` forward makes it live. The returned msgId's
 *  `turn_complete` withdraws the question and closes the dialog —
 *  the machine-side dismissal, no UI interaction involved. */
export async function presentQuestion(app: App, tag: string): Promise<string> {
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
  await app.body("A").waitForCondition<boolean>(
    `!!document.querySelector('[data-slot="session-question-dialog"]')`,
    { timeoutMs: 10_000 },
  );
  return msgId;
}

/** End the turn that hosts a live question — the dialog closes the way
 *  a withdrawn request does, with no pointer or key anywhere near it. */
export async function withdrawQuestion(app: App, msgId: string): Promise<void> {
  await app.driveSession(
    "A",
    frame({ type: "turn_complete", seq: 0, msg_id: msgId, result: "success" }),
  );
  await app.body("A").waitForCondition<boolean>(
    `document.querySelector('[data-slot="session-question-dialog"]') === null`,
    { timeoutMs: 10_000 },
  );
}

export function readSnap(app: App): Promise<ScrollSnap> {
  return app.body("A").evalJS<ScrollSnap>(`(function () {
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
