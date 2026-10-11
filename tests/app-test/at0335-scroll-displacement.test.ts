/**
 * at0335-scroll-displacement.test.ts — the scroller belongs to the user.
 *
 * A browser clamp is the one actor that moves `scrollTop` with no
 * JavaScript involved: when the scroll maximum shrinks, even for an
 * instant, the browser pulls the position down to meet it and does not
 * put it back when the height returns. Under transcript eviction that
 * happened constantly — a window swap removed rows in React's mutation
 * phase and grew the spacer back in a layout effect, so anything that
 * read geometry in between forced layout against a document short by
 * the evicted rows' full extent.
 *
 * The aftermath is what the user actually saw. `SmartScroll` read the
 * clamp as a person scrubbing upward and released follow-bottom, and
 * every route back required the user to move — so one clamp anywhere
 * in a session ended follow-bottom for the rest of it.
 *
 * The defense is the extent floor: an element that pins the scrollable
 * extent so it cannot dip mid-mutation, making the clamp impossible by
 * construction. The commit bracket that once repaired displacements is
 * now an assertion layer — it witnesses a `scrollTop` the machine
 * cannot account for, attributes it (`noteExternalWrite`, so intent
 * rules never read the browser's move as the user), and records it
 * loudly as a defect. It never counter-writes the position.
 *
 * | Test               | What would break without it                        |
 * |--------------------|----------------------------------------------------|
 * | counter published  | displacement is invisible; the next scroll defect  |
 * |                    | has to be diagnosed live through `/api/eval` again |
 * | clamp detected     | the detector is dead code — with the floor in      |
 * |                    | place a real clamp no longer occurs to exercise it |
 * | clamp witnessed    | a hole in the floor gets silently counter-written  |
 * |                    | instead of recorded, and the evidence is destroyed |
 * | window swaps clean | the tear is back: re-windowing displaces the user  |
 * | wheel reaches      | a downward gesture gets snapped back partway and   |
 * |                    | cannot reach the live edge                         |
 * | clamp never flips  | a machine displacement is read as user intent and  |
 * |                    | disengages follow-bottom                           |
 * | quiet arrival      | a turn appended after a long idle never scrolls in |
 * | idle recovery      | a user parked at the bottom with follow-bottom off |
 * |                    | is stranded — no gesture, no scroll event, no way  |
 * |                    | back, and every append silently fails to arrive    |
 *
 * **The success criterion is ZERO.** On every real drive — the
 * sixty-turn stand-up, the window swaps, the wheel run, the quiet
 * spell — `data-scroll-displacements` reads `"0"` and the trace ring
 * holds no records. The extent floor makes the clamp impossible by
 * construction, so a record is a defect, never a tolerance to measure
 * against. Earlier revisions pinned magnitude instead, because
 * eviction's ledger-settle dips produced honest ~24px records; the
 * floor spans those dips now, and a magnitude band would only give a
 * regression room to hide in. Only the `forceCommitClamp`-driven
 * tests see a nonzero count, because they take the floor down and
 * manufacture the record deliberately.
 *
 * The clamp cases are driven through `__tug.forceCommitClamp()`, which
 * reproduces a genuine browser clamp from *inside* a React commit.
 * `evalJS` runs outside any commit and so cannot produce one from the
 * outside.
 *
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/lib/smart-scroll.ts
 * @covers tugdeck/src/deck-trace.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;
const FEED_CODE_OUTPUT = 0x40;

const SID = "at0335-A";
const TURNS = 60;
const SCROLLER = '[data-tug-scroll-key="session-card-transcript"]';
const JUMP_BUTTON = ".tug-jump-to-bottom-button";

/** SmartScroll's at-bottom jitter band. */
const AT_BOTTOM_PX = 60;

function deckShape(): Record<string, unknown> {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 760 },
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

/** Stream one committed prompt→reply turn into the bound session. */
async function seedTurn(app: App, n: number): Promise<void> {
  const frame = (decoded: Record<string, unknown>): Promise<unknown> =>
    app.driveSession("A", {
      op: "ingestFrame",
      feedId: FEED_CODE_OUTPUT,
      decoded: { tug_session_id: SID, ...decoded },
    });
  const msgId = `${SID}-m${n}`;
  await app.driveSession("A", { op: "send", text: `prompt ${n}` });
  await frame({ type: "prompt_anchor", promptUuid: `${SID}-u${n}` });
  await frame({
    type: "content_block_start",
    msg_id: msgId,
    block_index: 0,
    kind: "text",
  });
  await frame({
    type: "assistant_text",
    seq: 0,
    rev: 0,
    status: "complete",
    msg_id: msgId,
    block_index: 0,
    text: replyText(n),
    is_partial: false,
  });
  await frame({ type: "turn_complete", seq: 0, msg_id: msgId, result: "success" });
}

/** Launch, seed a tall transcript, and wait until eviction has armed. */
async function standUp(testName: string): Promise<App> {
  const app = await launchTugApp({ testName });
  // `awaitEngineReady` is trace-gated — it waits on the `engine-ready`
  // deck-trace event, which is NOT one of the always-recorded kinds,
  // so the harness needs recording on to stand a card up at all. The
  // no-opt-in property is asserted directly instead, by switching
  // recording back OFF and checking that a displacement still lands.
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
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
  await new Promise((r) => setTimeout(r, 500));
  return app;
}

interface ScrollSnap {
  top: number;
  maxScroll: number;
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
//
// (Comments inside the evaluated source below must not use backticks:
// it is a template literal, and a backtick would end it.)
function readSnap(app: App): Promise<ScrollSnap> {
  return app.evalJS<ScrollSnap>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var btn = document.querySelector('${JUMP_BUTTON}');
  var spacer = document.querySelector('.tug-list-view-spacer--top');
  return {
    top: el.scrollTop,
    maxScroll: el.scrollHeight - el.clientHeight,
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

/** The honest criterion: nothing displaced, on either surface.
 *
 *  Zero was the original success criterion, retired while eviction's
 *  height ledger settled across commits — a cell measured at its new
 *  height in one commit, the spacer compensated in the next, and the
 *  browser clamped ~24px against the dip in between — and restored
 *  once the extent floor spanned those dips. The floor holds the
 *  scrollable extent through every mutation, so a real drive records
 *  nothing: not a small displacement, none.
 *
 *  Both surfaces are read — the published DOM attribute and the trace
 *  ring — so a record that reaches one but misses the other is still
 *  caught. */
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
  await new Promise((r) => setTimeout(r, 500));
  return top;
}

describe.skipIf(!SHOULD_RUN)("AT0335: scroll displacement", () => {
  test(
    "the displacement counter is published and reads zero on a settled transcript",
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

        // And it reads zero. Standing up sixty turns evicts, swaps
        // windows, and settles the height ledger across commits — the
        // extent floor spans all of it, so nothing clamps and nothing
        // is recorded.
        await expectZeroDisplacements(app);

        // The dev log carries follow-bottom flips with no opt-in of any
        // kind. Driven with a wheel-up rather than read off the
        // stand-up: a transcript that mounts at the live edge mounts
        // ALREADY engaged, and `_setFollowingBottom` early-returns on a
        // no-op, so a clean stand-up has no transition to log. Reading
        // the stand-up made this assertion pass only while something
        // was spuriously flipping the flag — it failed the moment the
        // machinery got that right, which is the opposite of what it
        // exists to check.
        await app.evalJS<boolean>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true, cancelable: true }));
  el.scrollTop = Math.max(0, el.scrollTop - 400);
  return true;
})()`);
        await new Promise((r) => setTimeout(r, 400));
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
        await parkMidHistory(app);
        const beforeClamp = await readSnap(app);
        await app.evalJS<boolean>(
          `(function () { window.__tug.forceCommitClamp('${SCROLLER}'); return true; })()`,
        );
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
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a commit-scoped clamp is detected and recorded",
    async () => {
      const app = await standUp("at0335-detect");
      try {
        const before = await readSnap(app);
        await expectZeroDisplacements(app);
        // A clamp only displaces when the shrink actually lowers the
        // scroll maximum below the live position, so the top spacer
        // must be carrying real evicted extent.
        expect(before.topSpacer).toBeGreaterThan(2_000);

        await app.evalJS<boolean>(
          `(function () { window.__tug.forceCommitClamp('${SCROLLER}'); return true; })()`,
        );
        await new Promise((r) => setTimeout(r, 500));

        expect(
          await app.evalJS<number>(
            `window.__tug.getScrollDisplacementCount('${SCROLLER}')`,
          ),
        ).toBeGreaterThan(0);

        const records = await readDisplacementRecords(app);
        expect(records.length).toBeGreaterThan(0);
        // Upward: a clamp pulls the position down toward a shrunken
        // maximum, which in scroller coordinates is a smaller
        // `scrollTop` than the baseline.
        expect(records[0]!.to).toBeLessThan(records[0]!.from);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a clamp on a user parked mid-history is witnessed loudly, never counter-written",
    async () => {
      const app = await standUp("at0335-witness");
      try {
        const parked = await parkMidHistory(app);
        // Parked deep in history with follow-bottom released — the
        // position is the user's, and parking is not a displacement.
        expect((await readSnap(app)).buttonVisible).toBe("true");
        await expectZeroDisplacements(app);

        await app.evalJS<boolean>(
          `(function () { window.__tug.forceCommitClamp('${SCROLLER}'); return true; })()`,
        );
        await new Promise((r) => setTimeout(r, 600));

        // The bracket asserts instead of repairing: the record names
        // the defect and the position stays exactly where the browser
        // put it. A counter-write here would hide the evidence — the
        // extent floor is the defense, and a record at all means the
        // floor has a hole (the simulation makes one deliberately by
        // taking the floor down for its synchronous window).
        const records = await readDisplacementRecords(app);
        expect(records.length).toBeGreaterThan(0);
        const witnessed = records[records.length - 1]!;
        expect(witnessed.to).toBeLessThan(witnessed.from);

        const after = await readSnap(app);
        expect(Math.abs(after.top - witnessed.to)).toBeLessThanOrEqual(4);
        expect(Math.abs(after.top - parked)).toBeGreaterThan(
          AT_BOTTOM_PX,
        );
        // Witnessing attributes the move (`noteExternalWrite`), so the
        // clamp's deferred scroll event is not read as the user
        // scrolling up and follow-bottom keeps the state the user gave
        // it: still released, still parked.
        expect(after.buttonVisible).toBe("true");

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
        await new Promise((r) => setTimeout(r, 800));

        // The clamp is machine-authored, so it never reaches the
        // intent rules: the affordance stays hidden and streaming
        // keeps tracking the live edge.
        const after = await readSnap(app);
        expect(after.buttonVisible).toBe("false");

        await seedTurn(app, TURNS);
        await new Promise((r) => setTimeout(r, 1000));
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
    "a genuine user scroll is never reverted",
    async () => {
      const app = await standUp("at0335-no-revert");
      try {
        // The scrollbar's silence, reproduced: a bare assignment with
        // no pointer or wheel events. This is the actor the repair
        // must never fight — its drag looks exactly like a clamp to
        // everything except the scroll events it delivers.
        const parked = await parkMidHistory(app);

        // Stream turns underneath. Every one of these commits runs the
        // bracket; none of them may pull the reader back.
        for (let n = 0; n < 3; n += 1) {
          await seedTurn(app, TURNS + n);
          await new Promise((r) => setTimeout(r, 400));
        }
        await new Promise((r) => setTimeout(r, 600));

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
    "a turn arriving after a long quiet spell scrolls into view",
    async () => {
      const app = await standUp("at0335-quiet");
      try {
        expect((await readSnap(app)).buttonVisible).toBe("false");

        // Sit still. Nothing touches the card — no gesture, no scroll
        // event, no commit driven by input. This is the state both
        // stranded sessions were found in.
        await new Promise((r) => setTimeout(r, 15_000));

        await seedTurn(app, TURNS);
        await new Promise((r) => setTimeout(r, 1500));

        const arrived = await readSnap(app);
        expect(arrived.maxScroll - arrived.top).toBeLessThanOrEqual(4);
        expect(arrived.buttonVisible).toBe("false");
        await expectZeroDisplacements(app);
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
        await new Promise((r) => setTimeout(r, 400));
        const stranded = await readSnap(app);
        expect(stranded.buttonVisible).toBe("true");
        expect(stranded.maxScroll - stranded.top).toBeLessThanOrEqual(
          AT_BOTTOM_PX,
        );

        // Touch nothing, then let a row arrive — the ordinary append
        // that a `/commit` receipt or a `Session compacted` note is.
        await seedTurn(app, TURNS);
        await new Promise((r) => setTimeout(r, 1500));

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

  test(
    "repeated window swaps displace nobody",
    async () => {
      const app = await standUp("at0335-swaps");
      try {
        // Drive the window up and down through the whole transcript
        // several times. Every one of these moves re-windows: rows
        // leave the DOM and the spacers absorb their extent. That is
        // exactly the moment the geometry used to tear.
        await app.evalJS<boolean>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var max = el.scrollHeight - el.clientHeight;
  var stops = [max, max * 0.6, max * 0.2, 0, max * 0.4, max * 0.8, max];
  window.__at0335 = { stops: stops, i: 0 };
  return true;
})()`);
        for (let i = 0; i < 7; i += 1) {
          await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = window.__at0335.stops[${i}];
  return el.scrollTop;
})()`);
          // Let the re-window commit and settle before the next move.
          await new Promise((r) => setTimeout(r, 400));
        }
        // Stream growth on top of the swaps — the streaming case is
        // where re-windowing and geometry reads collide most often.
        await seedTurn(app, TURNS);
        await new Promise((r) => setTimeout(r, 1000));

        await expectZeroDisplacements(app);
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
        await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = 0;
  return el.scrollTop;
})()`);
        await new Promise((r) => setTimeout(r, 600));
        expect((await readSnap(app)).buttonVisible).toBe("true");

        // A sustained downward burst. Synthetic wheel events do not
        // perform the browser's own scroll, so each tick pairs the
        // event with the movement it stands for — the phase machine
        // and the disengage rules see a genuine downward gesture, and
        // any upward jump between ticks is somebody else's doing.
        const run = await app.evalJS<{
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
        // scrollend that will never come) instead of idle. Draining
        // first makes the gesture end where a real one does.
        await new Promise((r) => setTimeout(r, 500));
        await app.evalJS<boolean>(`(function () {
  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  return true;
})()`);

        // The gesture ends engaged: it arrived at the live edge and
        // never scrolled away from it.
        await new Promise((r) => setTimeout(r, 800));
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
