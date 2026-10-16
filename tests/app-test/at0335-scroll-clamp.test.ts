/**
 * at0335-scroll-clamp.test.ts — a browser clamp is witnessed, never
 * repaired, and never read as the user.
 *
 * A browser clamp is the one actor that moves `scrollTop` with no
 * JavaScript involved: when the scroll maximum shrinks, even for an
 * instant, the browser pulls the position down to meet it and does not
 * put it back when the height returns. Under transcript eviction that
 * happened constantly — a window swap removed rows in React's mutation
 * phase and grew the spacer back in a layout effect, so anything that
 * read geometry in between forced layout against a document short by
 * the evicted rows' full extent. `SmartScroll` read the clamp as a
 * person scrubbing upward and released follow-bottom, and every route
 * back required the user to move.
 *
 * The defense is the extent floor, which makes the clamp impossible by
 * construction. The commit bracket is an assertion layer: it witnesses
 * a `scrollTop` the machine cannot account for, attributes it
 * (`noteExternalWrite`, so intent rules never read the browser's move
 * as the user), and records it loudly as a defect. It never
 * counter-writes the position. The reader-side guarantees — window
 * swaps and streaming never move a parked reader, a wheel reaches the
 * live edge — are in `at0335-scroll-reader-held.test.ts`.
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
 * records. Only the `forceCommitClamp` drives see a nonzero count,
 * because they take the floor down and manufacture the record
 * deliberately — from *inside* a React commit, which `evalJS` cannot
 * reach from the outside.
 *
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/lib/smart-scroll.ts
 * @covers tugdeck/src/deck-trace.ts
 * @family at0335-scroll
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import type { SessionDriveAction } from "./_harness/client";
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
  await app.evalJS<boolean>(`(function () {
  window.__at0335Frames = false;
  requestAnimationFrame(function () {
    requestAnimationFrame(function () { window.__at0335Frames = true; });
  });
  return true;
})()`);
  await app.waitForCondition<boolean>(
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

// Kept local: every file's `standUp` launches into its own deck and transcript,
// so the name is shared and the function is not.
/** Launch, seed a tall transcript, and wait until eviction has armed. */
async function standUp(testName: string): Promise<App> {
  const app = await launchTugApp({ testName });
  // `awaitEngineReady` is trace-gated — it waits on the `engine-ready`
  // deck-trace event, which is NOT one of the always-recorded kinds,
  // so the harness needs recording on to stand a card up at all. The
  // no-opt-in property is asserted directly instead, by switching
  // recording back OFF and checking that a displacement still lands.
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
function readSnap(app: App): Promise<ScrollSnap> {
  return app.evalJS<ScrollSnap>(`(function () {
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
function readDisplacementRecords(app: App): Promise<
  {
    from: number;
    to: number;
    following: boolean;
  }[]
> {
  return app.evalJS(`(function () {
  return window.__deckTrace.dump()
    .filter(function (e) { return e.kind === "scroll-displacement"; })
    .map(function (e) {
      return { from: e.from, to: e.to, following: e.following };
    });
})()`);
}

/** Follow-bottom sources recorded in the dev log, oldest first. */
function readFollowBottomSources(app: App): Promise<string[]> {
  return app.evalJS<string[]>(`(function () {
  return window.tugDevLog.getSnapshot().entries
    .filter(function (e) {
      return e.source === "smart-scroll" && e.message === "follow-bottom";
    })
    .map(function (e) { return e.data.source; });
})()`);
}

function devLogHasSource(source: string): string {
  return `window.tugDevLog.getSnapshot().entries.some(function (e) {
  return e.source === "smart-scroll" && e.message === "follow-bottom" &&
    e.data.source === "${source}";
})`;
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
  const top = await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = el.scrollTop - ${AT_BOTTOM_PX * 15};
  return el.scrollTop;
})()`);
  await settle(app);
  await awaitQuietly(app, BUTTON_VISIBLE);
  return top;
}

describe.skipIf(!SHOULD_RUN)("AT0335: scroll clamp", () => {
  test(
    "the displacement counter reads zero, and a clamp is witnessed loudly, never counter-written",
    async () => {
      const app = await standUp("at0335-counter");
      try {
        const snap = await readSnap(app);
        // Present from mount, so the attribute is readable rather
        // than absent — an absent attribute would read the same as a
        // clean run.
        expect(snap.displacements).not.toBeNull();
        expect(
          await app.evalJS<number>(
            `window.__tug.getScrollDisplacementCount('${SCROLLER}')`,
          ),
        ).toBe(Number(snap.displacements));
        // A clamp only displaces when the shrink actually lowers the
        // scroll maximum below the live position, so the top spacer
        // must be carrying real evicted extent for the clamp below to
        // have room to happen.
        expect(snap.topSpacer).toBeGreaterThan(2_000);

        // And it reads zero. Standing up sixty turns evicts, swaps
        // windows, and settles the height ledger across commits — the
        // extent floor spans all of it, so nothing clamps and nothing
        // is recorded.
        await expectZeroDisplacements(app);

        // The dev log carries follow-bottom flips with no opt-in of any
        // kind. Driven with a wheel-up rather than read off the
        // stand-up: a transcript that mounts at the live edge mounts
        // ALREADY engaged, and `_setFollowingBottom` early-returns on a
        // no-op, so a clean stand-up has no transition to log.
        await app.evalJS<boolean>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true, cancelable: true }));
  el.scrollTop = Math.max(0, el.scrollTop - 400);
  return true;
})()`);
        await awaitQuietly(app, devLogHasSource("wheel-up"));
        const sources = await readFollowBottomSources(app);
        expect(sources).toContain("wheel-up");

        // Now the no-opt-in property itself, asserted rather than
        // assumed: switch deck-trace recording OFF, clear the ring,
        // and drive a displacement. Ordinary kinds are gated by that
        // flag; `scroll-displacement` and `follow-bottom` are not,
        // because the sessions that hold this evidence are the ones
        // nobody thought to instrument.
        await app.enableDeckTrace(false);
        await app.evalJS<boolean>(
          `(function () { window.__tug.clearDeckTrace(); return true; })()`,
        );
        const parkedSnap = await readSnap(app);
        const parked = await parkMidHistory(app);
        // Parked deep in history with follow-bottom released — the
        // position is the user's, and parking is not a displacement.
        const beforeClamp = await readSnap(app);
        expect(beforeClamp.buttonVisible).toBe("true");
        await expectZeroDisplacements(app);

        await app.evalJS<boolean>(
          `(function () { window.__tug.forceCommitClamp('${SCROLLER}'); return true; })()`,
        );
        // Long enough for the clamp's deferred scroll event to be
        // delivered, which is what the "still released" check below
        // is about.
        await new Promise((r) => setTimeout(r, 600));
        const afterClamp = await readSnap(app);
        // The simulation only clamps when the shrink lowers the maximum
        // BELOW the live position, so the arithmetic it depends on is
        // worth printing: a run that records nothing should say whether
        // the clamp had room to happen at all.
        note("at0335-gated-clamp", {
          shrinkPx: 2_000,
          settled: `top=${parkedSnap.top} max=${parkedSnap.maxScroll} spacer=${parkedSnap.topSpacer}`,
          parked: `top=${beforeClamp.top} max=${beforeClamp.maxScroll} spacer=${beforeClamp.topSpacer}`,
          after: `top=${afterClamp.top} max=${afterClamp.maxScroll} disp=${afterClamp.displacements}`,
        });

        // Detected, on both surfaces, with recording off.
        expect(
          await app.evalJS<number>(
            `window.__tug.getScrollDisplacementCount('${SCROLLER}')`,
          ),
        ).toBeGreaterThan(0);
        const gated = await app.evalJS<{ displacement: number; other: number }>(
          `(function () {
  var rows = window.__deckTrace.dump();
  return {
    displacement: rows.filter(function (e) { return e.kind === "scroll-displacement"; }).length,
    other: rows.filter(function (e) { return e.kind === "commit-tick" || e.kind === "focus-call"; }).length,
  };
})()`,
        );
        expect(gated.displacement).toBeGreaterThan(0);
        expect(gated.other).toBe(0);

        // Upward: a clamp pulls the position down toward a shrunken
        // maximum, which in scroller coordinates is a smaller
        // `scrollTop` than the baseline.
        const records = await readDisplacementRecords(app);
        expect(records.length).toBeGreaterThan(0);
        expect(records[0]!.to).toBeLessThan(records[0]!.from);

        // The bracket asserts instead of repairing: the record names
        // the defect and the position stays exactly where the browser
        // put it. A counter-write here would hide the evidence — the
        // extent floor is the defense, and a record at all means the
        // floor has a hole (the simulation makes one deliberately by
        // taking the floor down for its synchronous window).
        const witnessed = records[records.length - 1]!;
        expect(witnessed.to).toBeLessThan(witnessed.from);
        expect(Math.abs(afterClamp.top - witnessed.to)).toBeLessThanOrEqual(4);
        expect(Math.abs(afterClamp.top - parked)).toBeGreaterThan(
          AT_BOTTOM_PX,
        );
        // Witnessing attributes the move (`noteExternalWrite`), so the
        // clamp's deferred scroll event is not read as the user
        // scrolling up and follow-bottom keeps the state the user gave
        // it: still released, still parked.
        expect(afterClamp.buttonVisible).toBe("true");

        // Loud means the dev log carries it at warn with no opt-in —
        // the defect record must exist in sessions nobody instrumented.
        const warned = await app.evalJS<number>(`(function () {
  return window.tugDevLog.getSnapshot().entries.filter(function (e) {
    return e.source === "list-view" && e.message === "scroll-displacement" &&
      e.level === "warn";
  }).length;
})()`);
        expect(warned).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a clamp does not release follow-bottom",
    async () => {
      const app = await standUp("at0335-no-flip");
      try {
        // Engaged at the live edge, which is where the two field
        // reports were sitting when their session stopped tracking.
        const before = await readSnap(app);
        expect(before.buttonVisible).toBe("false");

        await app.evalJS<boolean>(
          `(function () { window.__tug.forceCommitClamp('${SCROLLER}'); return true; })()`,
        );
        // A negative: nothing to wait on but time for the clamp's
        // deferred scroll event to arrive and be judged.
        await new Promise((r) => setTimeout(r, 800));

        // The clamp is machine-authored, so it never reaches the
        // intent rules: the affordance stays hidden and streaming
        // keeps tracking the live edge.
        const after = await readSnap(app);
        expect(after.buttonVisible).toBe("false");

        await seedTurn(app, TURNS);
        await settle(app, after.scrollHeight);
        await awaitQuietly(app, AT_LIVE_EDGE);
        const streamed = await readSnap(app);
        expect(streamed.maxScroll - streamed.top).toBeLessThanOrEqual(4);
        expect(streamed.buttonVisible).toBe("false");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an idle user at the bottom is never stranded by a disengaged flag",
    async () => {
      const app = await standUp("at0335-idle-recovery");
      try {
        // The state the field reports describe: parked at the live
        // edge with follow-bottom off. It has to be forced — a
        // downward `scrollTop` assignment into the band re-engages
        // before a test can observe it.
        await app.evalJS<boolean>(`(function () {
  window.__tug.setTranscriptFollowBottom('${SCROLLER}', false);
  return true;
})()`);
        await awaitQuietly(app, BUTTON_VISIBLE);
        const stranded = await readSnap(app);
        expect(stranded.buttonVisible).toBe("true");
        expect(stranded.maxScroll - stranded.top).toBeLessThanOrEqual(
          AT_BOTTOM_PX,
        );

        // Touch nothing, then let a row arrive — the ordinary append
        // that a `/commit` receipt or a `Session compacted` note is.
        await seedTurn(app, TURNS);
        await settle(app, stranded.scrollHeight);
        await awaitQuietly(app, `${AT_LIVE_EDGE} && ${BUTTON_HIDDEN}`);

        const recovered = await readSnap(app);
        expect(recovered.maxScroll - recovered.top).toBeLessThanOrEqual(4);
        expect(recovered.buttonVisible).toBe("false");

        // And it is visible as such: the growth-time route is tagged
        // distinctly, so a re-engagement that should not have happened
        // can be found rather than guessed at.
        const sources = await readFollowBottomSources(app);
        expect(sources).toContain("growth-at-bottom-reengage");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
