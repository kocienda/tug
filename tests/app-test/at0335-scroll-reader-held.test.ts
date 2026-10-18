/**
 * at0335-scroll-reader-held.test.ts — the scroller belongs to the user:
 * nothing the transcript does moves a reader who did not move.
 *
 * Under transcript eviction a window swap removes rows in React's
 * mutation phase and grows the spacer back in a layout effect. Before
 * the extent floor, anything that read geometry in between forced layout
 * against a document short by the evicted rows' full extent, and the
 * browser clamped the reader's position against it — a tear the user
 * saw as the transcript jumping under them. The floor pins the scrollable
 * extent through every mutation, so a real drive displaces nobody. The
 * clamp itself, and how it is witnessed when the floor is taken down,
 * are in `at0335-scroll-clamp.test.ts`.
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
 * **The success criterion is ZERO.** On every drive here
 * `data-scroll-displacements` reads `"0"` and the trace ring holds no
 * records. The floor makes the clamp impossible by construction, so a
 * record is a defect, never a tolerance to measure against.
 *
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/lib/smart-scroll.ts
 * @covers tugdeck/src/deck-trace.ts
 * @family at0335-scroll
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, type App } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";
import { enableDeckTrace, type SessionDriveAction } from "./_harness/client";
import { sessionCardShape } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;
const FEED_CODE_OUTPUT = 0x40;

const SID = "at0335-A";
const TURNS = 60;
const SCROLLER = '[data-tug-scroll-key="session-card-transcript"]';
const JUMP_BUTTON = ".tug-jump-to-bottom-button";

/** SmartScroll's at-bottom jitter band. */
const AT_BOTTOM_PX = 60;

function replyText(n: number): string {
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
function seedTurn(app: App, n: number): Promise<void> {
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
async function settle(app: App, grewFrom?: number): Promise<void> {
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
async function awaitQuietly(app: App, expr: string): Promise<void> {
  await app.body("A").waitForCondition<boolean>(expr, { timeoutMs: 3_000 }).catch(() => undefined);
}

const BUTTON_VISIBLE = `(function () {
  var b = document.querySelector('${JUMP_BUTTON}');
  return b !== null && b.getAttribute("data-visible") === "true";
})()`;

const BUTTON_HIDDEN = `(function () {
  var b = document.querySelector('${JUMP_BUTTON}');
  return b === null || b.getAttribute("data-visible") !== "true";
})()`;

// Kept local: every file's `standUp` launches into its own deck and transcript,
// so the name is shared and the function is not.
/** Launch, seed a tall transcript, and wait until eviction has armed. */
async function standUp(testName: string): Promise<App> {
  const app = await launchTugApp({ testName });
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: sessionCardShape({ width: 900, height: 760 }), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
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

interface ScrollSnap {
  top: number;
  maxScroll: number;
  scrollHeight: number;
  buttonVisible: string | null;
  displacements: string | null;
}

// Two ways the affordance says "not offering a jump", and both mean
// "false" to the user: the button may not be in the DOM at all, or it
// may be mounted with no data-visible attribute yet. Reading either as
// null would fail assertions about a state that is, behaviorally,
// exactly "not showing".
function readSnap(app: App): Promise<ScrollSnap> {
  return app.body("A").evalJS<ScrollSnap>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var btn = document.querySelector('${JUMP_BUTTON}');
  return {
    top: el.scrollTop,
    maxScroll: el.scrollHeight - el.clientHeight,
    scrollHeight: el.scrollHeight,
    buttonVisible: (btn === null ? null : btn.getAttribute("data-visible")) || "false",
    displacements: el.getAttribute("data-scroll-displacements"),
  };
})()`);
}

/** Displacement records in the deck-trace ring, newest last. */
function readDisplacementRecords(app: App): Promise<
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

/** The honest criterion: nothing displaced, on either surface — the
 *  published DOM attribute and the trace ring, so a record that reaches
 *  one but misses the other is still caught. */
async function expectZeroDisplacements(app: App): Promise<void> {
  expect((await readSnap(app)).displacements).toBe("0");
  expect(await readDisplacementRecords(app)).toHaveLength(0);
}

/** Park the transcript well above the live edge, the way a native
 *  scrollbar drag does — no pointer or wheel events. */
async function parkMidHistory(app: App): Promise<number> {
  const top = await app.body("A").evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = el.scrollTop - ${AT_BOTTOM_PX * 15};
  return el.scrollTop;
})()`);
  await settle(app);
  await awaitQuietly(app, BUTTON_VISIBLE);
  return top;
}

describe.skipIf(!SHOULD_RUN)("AT0335: a reader is held", () => {
  test(
    "a genuine user scroll is never reverted",
    async () => {
      const app = await standUp("at0335-no-revert");
      try {
        // The scrollbar's silence, reproduced: a bare assignment with
        // no pointer or wheel events. This is the actor the repair
        // must never fight — its drag looks exactly like a clamp to
        // everything except the scroll events it delivers.
        const parked = await parkMidHistory(app);
        // Disengaging opens the anchoring gate: the parked reader gets
        // the reading-position hold back. SmartScroll stamps
        // `overflow-anchor: none` only while following the bottom.
        expect(
          await app.body("A").evalJS<string>(
            `document.querySelector('${SCROLLER}').style.overflowAnchor`,
          ),
        ).toBe("");

        // Stream turns underneath. Every one of these commits runs the
        // bracket; none of them may pull the reader back.
        for (let n = 0; n < 3; n += 1) {
          const before = (await readSnap(app)).scrollHeight;
          await seedTurn(app, TURNS + n);
          await settle(app, before);
        }

        const held = await readSnap(app);
        expect(Math.abs(held.top - parked)).toBeLessThanOrEqual(50);
        await expectZeroDisplacements(app);
        expect(held.buttonVisible).toBe("true");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "repeated window swaps displace nobody",
    async () => {
      const app = await standUp("at0335-swaps");
      try {
        // Drive the window up and down through the whole transcript
        // several times. Every one of these moves re-windows: rows
        // leave the DOM and the spacers absorb their extent. That is
        // exactly the moment the geometry used to tear.
        await app.body("A").evalJS<boolean>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var max = el.scrollHeight - el.clientHeight;
  var stops = [max, max * 0.6, max * 0.2, 0, max * 0.4, max * 0.8, max];
  window.__at0335 = { stops: stops, i: 0 };
  return true;
})()`);
        for (let i = 0; i < 7; i += 1) {
          await app.body("A").evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = window.__at0335.stops[${i}];
  return el.scrollTop;
})()`);
          // Let the re-window commit and drain before the next move.
          await settle(app);
        }
        // Stream growth on top of the swaps — the streaming case is
        // where re-windowing and geometry reads collide most often.
        const before = (await readSnap(app)).scrollHeight;
        await seedTurn(app, TURNS);
        await settle(app, before);

        await expectZeroDisplacements(app);

        // The extent floor is standing and tracks the settled extent
        // (extent − 1, with a commit's rebase slack).
        const floor = await app.body("A").evalJS<{
          present: boolean;
          floorPx: number;
          scrollHeight: number;
        }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var floor = el.querySelector(".tug-list-view-floor");
  return {
    present: floor !== null,
    floorPx: floor === null ? -1 : parseFloat(floor.style.height || "0"),
    scrollHeight: el.scrollHeight,
  };
})()`);
        expect(floor.present).toBe(true);
        expect(Math.abs(floor.floorPx - (floor.scrollHeight - 1))).toBeLessThanOrEqual(2);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a sustained downward wheel gesture reaches the bottom and stays",
    async () => {
      const app = await standUp("at0335-wheel");
      try {
        // Park near the top, behind a large evicted top spacer — the
        // geometry the field report was captured on.
        await app.body("A").evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = 0;
  return el.scrollTop;
})()`);
        await settle(app);
        await awaitQuietly(app, BUTTON_VISIBLE);
        expect((await readSnap(app)).buttonVisible).toBe("true");

        // A sustained downward burst. Synthetic wheel events do not
        // perform the browser's own scroll, so each tick pairs the
        // event with the movement it stands for — the phase machine
        // and the disengage rules see a genuine downward gesture, and
        // any upward jump between ticks is somebody else's doing.
        const run = await app.body("A").evalJS<{
          worstUpJump: number;
          finalTop: number;
          maxScroll: number;
        }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var worstUpJump = 0;
  var prev = el.scrollTop;
  for (var i = 0; i < 120; i += 1) {
    el.dispatchEvent(new WheelEvent('wheel', {
      deltaY: 600, bubbles: true, cancelable: true,
    }));
    el.scrollTop = Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + 600);
    var now = el.scrollTop;
    var up = prev - now;
    if (up > worstUpJump) worstUpJump = up;
    prev = now;
  }
  return {
    worstUpJump: worstUpJump,
    finalTop: el.scrollTop,
    maxScroll: el.scrollHeight - el.clientHeight,
  };
})()`);
        // Nothing snapped the gesture back partway.
        expect(run.worstUpJump).toBeLessThanOrEqual(AT_BOTTOM_PX);
        expect(run.maxScroll - run.finalTop).toBeLessThanOrEqual(AT_BOTTOM_PX);

        // End the gesture, in two beats. A wheel-only gesture stays in
        // the dragging phase until scrollend arrives, and synthetic
        // wheel events paired with a manual assignment do not reliably
        // produce one — pointerup is the termination the harness can
        // drive. But it has to arrive on a quiet scroller: the
        // assignments above queue scroll events, and any that land
        // during the 50ms post-pointerup window read as momentum, so
        // the phase machine goes to decelerating (which waits for the
        // scrollend that will never come) instead of idle. Settling
        // first makes the gesture end where a real one does.
        await settle(app);
        await app.body("A").evalJS<boolean>(`(function () {
  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  return true;
})()`);

        // The gesture ends engaged: it arrived at the live edge and
        // never scrolled away from it.
        await awaitQuietly(app, BUTTON_HIDDEN);
        const settled = await readSnap(app);
        expect(settled.buttonVisible).toBe("false");
        await expectZeroDisplacements(app);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
