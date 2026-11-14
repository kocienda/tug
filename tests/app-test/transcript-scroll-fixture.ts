/**
 * transcript-scroll-fixture.ts — the tall evicting transcript, the settle
 * wait and the scroll readers the at0335-scroll-* files share.
 *
 * Split out of `at0335-scroll-clamp.test.ts` and
 * `at0335-scroll-reader-held.test.ts` when those were cut, a test to a file,
 * so each launch fits its own budget: the clamp half is
 * `at0335-scroll-clamp-{witnessed,no-flip,idle-recovery}`, the reader half
 * `at0335-scroll-reader-held-{no-revert,swaps,wheel}`.
 *
 * ## The scroller belongs to the user
 *
 * Under transcript eviction a window swap removes rows in React's mutation
 * phase and grows the spacer back in a layout effect. Before the extent
 * floor, anything that read geometry in between forced layout against a
 * document short by the evicted rows' full extent, and the browser clamped
 * the reader's position against it — a tear the user saw as the transcript
 * jumping under them. The floor pins the scrollable extent through every
 * mutation, so a real drive displaces nobody.
 *
 * | Test               | What would break without it                        |
 * |--------------------|----------------------------------------------------|
 * | never reverted     | a scrollbar drag (no pointer, no wheel) is pulled  |
 * |                    | back by the next streamed turn, or the parked      |
 * |                    | reader loses the anchoring hold                    |
 * | window swaps clean | the tear is back: re-windowing displaces the user, |
 * |                    | or the extent floor stops tracking the extent      |
 * | wheel reaches      | a downward gesture gets snapped back partway and   |
 * |                    | cannot reach the live edge                         |
 *
 * ## A browser clamp is witnessed, never repaired, and never read as the user
 *
 * A browser clamp is the one actor that moves `scrollTop` with no
 * JavaScript involved: when the scroll maximum shrinks, even for an
 * instant, the browser pulls the position down to meet it and does not
 * put it back when the height returns. Under transcript eviction that
 * happened constantly. `SmartScroll` read the clamp as a person scrubbing
 * upward and released follow-bottom, and every route back required the
 * user to move.
 *
 * The defense is the extent floor, which makes the clamp impossible by
 * construction. The commit bracket is an assertion layer: it witnesses
 * a `scrollTop` the machine cannot account for, attributes it
 * (`noteExternalWrite`, so intent rules never read the browser's move
 * as the user), and records it loudly as a defect. It never
 * counter-writes the position.
 *
 * | Test               | What would break without it                        |
 * |--------------------|----------------------------------------------------|
 * | counter + witness  | displacement is invisible, or the detector is dead |
 * |                    | code, or a hole in the floor is silently counter-  |
 * |                    | written instead of recorded and the evidence lost  |
 * | clamp never flips  | a machine displacement is read as user intent and  |
 * |                    | disengages follow-bottom                           |
 * | idle recovery      | a user parked at the bottom with follow-bottom off |
 * |                    | is stranded — no gesture, no scroll event, no way  |
 * |                    | back, and every append silently fails to arrive    |
 *
 * **The success criterion is ZERO** on every real drive: the stand-up
 * reads `data-scroll-displacements="0"` and the trace ring holds no
 * records. The floor makes the clamp impossible by construction, so a
 * record is a defect, never a tolerance to measure against. Only the
 * `forceCommitClamp` drives see a nonzero count, because they take the
 * floor down and manufacture the record deliberately — from *inside* a
 * React commit, which `evalJS` cannot reach from the outside.
 *
 * @module tests/app-test/transcript-scroll-fixture
 */

import { expect } from "bun:test";

import { launchTugApp, type App } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";
import { enableDeckTrace, type SessionDriveAction } from "./_harness/client";
import { sessionCardShape } from "./_harness/shapes";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 300_000;
export const FEED_CODE_OUTPUT = 0x40;

export const SID = "at0335-A";
export const TURNS = 60;
export const SCROLLER = '[data-tug-scroll-key="session-card-transcript"]';
export const JUMP_BUTTON = ".tug-jump-to-bottom-button";

/** SmartScroll's at-bottom jitter band. */
export const AT_BOTTOM_PX = 60;

export function replyText(n: number): string {
  return [
    `## step ${n}`,
    "",
    `Reply number ${n}. Long enough that sixty of these build a transcript`,
    "tall enough for eviction to arm and for the top spacer to carry tens",
    "of thousands of pixels of evicted extent.",
    "",
    `- marker ${n}`,
  ].join("\n");
}

/** Stream one committed prompt→reply turn into the bound session, as
 *  one batch. */
export function seedTurn(app: App, n: number): Promise<void> {
  const frame = (decoded: Record<string, unknown>): SessionDriveAction => ({
    op: "ingestFrame",
    feedId: FEED_CODE_OUTPUT,
    decoded: { tug_session_id: SID, ...decoded },
  });
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
  window.__at0335Frames = false;
  requestAnimationFrame(function () {
    requestAnimationFrame(function () { window.__at0335Frames = true; });
  });
  return true;
})()`);
  await app.body("A").waitForCondition<boolean>(
    `(function () {
  if (!window.__at0335Frames) return false;
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

export const BUTTON_VISIBLE = `(function () {
  var b = document.querySelector('${JUMP_BUTTON}');
  return b !== null && b.getAttribute("data-visible") === "true";
})()`;

export const BUTTON_HIDDEN = `(function () {
  var b = document.querySelector('${JUMP_BUTTON}');
  return b === null || b.getAttribute("data-visible") !== "true";
})()`;

/**
 * Launch, seed a tall transcript, and wait until eviction has armed.
 *
 * `awaitHostRoot` is the one difference between the two halves' stand-ups
 * as they stood before the split: the reader-held files waited for the
 * card's host root to register before waiting for its body; the clamp files
 * did not. Each file passes what its original did.
 */
export async function standUp(
  testName: string,
  opts: { awaitHostRoot?: boolean } = {},
): Promise<App> {
  const app = await launchTugApp({ testName });
  // `awaitEngineReady` is trace-gated — it waits on the `engine-ready`
  // deck-trace event, which is NOT one of the always-recorded kinds,
  // so the harness needs recording on to stand a card up at all. The
  // no-opt-in property is asserted directly instead (in the clamp's
  // witnessed file), by switching recording back OFF and checking that a
  // displacement still lands.
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: sessionCardShape({ width: 900, height: 760 }), focusCardId: "A" });
  if (opts.awaitHostRoot === true) {
    await app.waitForCondition<boolean>(
      `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    );
  }
  await waitForBodyReady(app, "A");
  // The transcript is in A's body, which records into its own trace.
  await enableDeckTrace(app.body("A"), true);
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
  displacements: string | null;
  topSpacer: number;
}

// Two ways the affordance says "not offering a jump", and both mean
// "false" to the user: the button may not be in the DOM at all, or it
// may be mounted with no data-visible attribute yet. The host drives
// that attribute imperatively on transition, so a card that has never
// disengaged has never written it. Reading either as null would fail
// assertions about a state that is, behaviorally, exactly "not
// showing".
export function readSnap(app: App): Promise<ScrollSnap> {
  return app.body("A").evalJS<ScrollSnap>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var btn = document.querySelector('${JUMP_BUTTON}');
  var spacer = document.querySelector('.tug-list-view-spacer--top');
  return {
    top: el.scrollTop,
    maxScroll: el.scrollHeight - el.clientHeight,
    scrollHeight: el.scrollHeight,
    buttonVisible: (btn === null ? null : btn.getAttribute("data-visible")) || "false",
    displacements: el.getAttribute("data-scroll-displacements"),
    topSpacer: spacer === null ? 0 : spacer.offsetHeight,
  };
})()`);
}

/** Displacement records in the deck-trace ring, newest last. */
export function readDisplacementRecords(app: App): Promise<
  {
    from: number;
    to: number;
    following: boolean;
  }[]
> {
  return app.body("A").evalJS(`(function () {
  return window.__deckTrace.dump()
    .filter(function (e) { return e.kind === "scroll-displacement"; })
    .map(function (e) {
      return { from: e.from, to: e.to, following: e.following };
    });
})()`);
}

/** Follow-bottom sources recorded in the dev log, oldest first. */
export function readFollowBottomSources(app: App): Promise<string[]> {
  return app.body("A").evalJS<string[]>(`(function () {
  return window.tugDevLog.getSnapshot().entries
    .filter(function (e) {
      return e.source === "smart-scroll" && e.message === "follow-bottom";
    })
    .map(function (e) { return e.data.source; });
})()`);
}

export function devLogHasSource(source: string): string {
  return `window.tugDevLog.getSnapshot().entries.some(function (e) {
  return e.source === "smart-scroll" && e.message === "follow-bottom" &&
    e.data.source === "${source}";
})`;
}

/** The honest criterion: nothing displaced, on either surface — the
 *  published DOM attribute and the trace ring, so a record that reaches
 *  one but misses the other is still caught. */
export async function expectZeroDisplacements(app: App): Promise<void> {
  expect((await readSnap(app)).displacements).toBe("0");
  expect(await readDisplacementRecords(app)).toHaveLength(0);
}

/** Park the transcript well above the live edge, the way a native
 *  scrollbar drag does — no pointer or wheel events. */
export async function parkMidHistory(app: App): Promise<number> {
  const top = await app.body("A").evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = el.scrollTop - ${AT_BOTTOM_PX * 15};
  return el.scrollTop;
})()`);
  await settle(app);
  await awaitQuietly(app, BUTTON_VISIBLE);
  return top;
}
