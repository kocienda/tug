/**
 * at0605-find-reveal-range.test.ts — `revealRange` itself, with no find in
 * sight: it lands, it supersedes, it stands down, and it clamps.
 *
 * ## Why this exists
 *
 * The list view's own reveal is a machine with a deadline, a write budget, a
 * supersede rule and a cancellation rule, and find drives every reveal
 * through it. A machine like that has to be exercised where it is the only
 * thing in the frame — once the transcript host is on top of it, a red says
 * "find is broken" and names nothing. The door is the list-view probe
 * rather than the imperative handle, for the reason the probe registry's
 * own docstring gives: nothing in the app drives these.
 *
 * Every target is far past the mounted window, so each reveal takes the
 * estimated-jump path: mount, measure, place, verify.
 *
 *  - **Lands.** A far row ends in band, mounted.
 *  - **Supersedes.** A second reveal started while the first still waits
 *    for its row settles the first `superseded`, and runs to its own answer.
 *  - **Stands down.** Nothing in the old reveal loop yielded to a user
 *    gesture: it kept nudging the scroller until the match was in its band
 *    or its budget ran out, and a user who took the scroller back was pulled
 *    off what they were reading. The scroll-intent doctrine says no deferred
 *    scroll write survives a user gesture. The mover is a raw `scrollTop`
 *    write, not a `SmartScroll` call: the event-silent native scrollbar
 *    never raises `isUserScrolling`, which is exactly why a drift check is
 *    needed rather than a flag read. The reveal must settle `cancelled`,
 *    and over the frames after it the scroller must stay where the hand
 *    left it.
 *  - **Clamps.** An out-of-range index lands on the last row.
 *
 * ## Expected state
 *
 * Green. The stand-down was red when written, against a ⌘G reveal, and went
 * green at the step that gave the reveal its cancellation rule; the rest
 * was green from the step that wrote the machine.
 *
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/lib/find-trace.ts
 * @family at0605-find
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type BodyApp } from "./_harness";
import {
  SCROLLER,
  seedProseTurns,
  sessionDeckShape,
  sessionSelectors,
  standUpSession,
  waitFrames,
} from "./find-probes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;
const SEL = sessionSelectors("A");
const SID = "c7c0d1ea-0000-4000-8000-000000000606";
const TURNS = 30;

/** Far rows, all well past the window mounted at the top. */
const FAR_ROW = 50;
const OVERTAKEN_ROW = 10;
const OVERTAKING_ROW = 55;
/**
 * Far from the top, and far from the end: the hand grab moves 900 px past
 * the reveal's jump, and a row within that of the transcript's end is still
 * in band once the grab clamps at the bottom, so its reveal lands anyway.
 */
const CANCELLED_ROW = 35;

/** A frame the scroller may drift by and still be where the hand left it. */
const DRIFT_PX = 8;

function replyText(n: number): string {
  return [
    `## step ${n}`,
    "",
    `Reply number ${n} is prose long enough that the row occupies real`,
    "height and the transcript grows past a viewport.",
    "",
    `- line ${n}`,
  ].join("\n");
}

/**
 * Read one settled outcome, waiting for it. The reveal is asynchronous in
 * the page and `evalJS` cannot await a promise there, so the surface queues
 * outcomes and this drains one.
 */
async function nextRevealOutcome(
  body: BodyApp,
  timeoutMs = 12_000,
): Promise<string> {
  const started = Date.now();
  for (;;) {
    const got = await body.evalJS<string | null>(
      `window.__tug.takeListRevealOutcome()`,
    );
    if (got !== null) return got;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`no reveal outcome within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
}

/** The row's top edge against the scroller's band, after the reveal. */
async function rowBand(
  body: BodyApp,
  index: number,
): Promise<{ top: number; bandTop: number; bandBottom: number } | null> {
  return body.evalJS<{ top: number; bandTop: number; bandBottom: number } | null>(
    `(function () {
  var sc = document.querySelector('${SEL.card} ${SCROLLER}');
  var cell = document.querySelector('${SEL.card} [data-tug-list-cell-index="${index}"]');
  if (!sc || !cell) return null;
  var box = sc.getBoundingClientRect();
  var r = cell.getBoundingClientRect();
  return { top: r.top, bandTop: box.top, bandBottom: box.bottom };
})()`,
  );
}

/** Record the scroller's offset every frame for `ms`, and read it back. */
async function sampleOffsets(body: BodyApp, scroller: string, ms = 300): Promise<number[]> {
  await body.evalJS<boolean>(`(function () {
  window.__revealOffsets = [];
  window.__revealOffsetsDone = false;
  var el = document.querySelector('${scroller}');
  var deadline = performance.now() + ${ms};
  function tick() {
    window.__revealOffsets.push(el ? el.scrollTop : -1);
    if (performance.now() < deadline) requestAnimationFrame(tick);
    else window.__revealOffsetsDone = true;
  }
  requestAnimationFrame(tick);
  return true;
})()`);
  await body.waitForCondition<boolean>(`window.__revealOffsetsDone === true`, {
    timeoutMs: ms + 5000,
  });
  return body.evalJS<number[]>(`(window.__revealOffsets || [])`);
}

describe.skipIf(!SHOULD_RUN)("AT0605e: revealRange lands, supersedes, and stands down", () => {
  test(
    "a far row lands in band; a second reveal supersedes; a hand scroll cancels and is not undone",
    async () => {
      const app = await launchTugApp({ testName: "at0605e-reveal-range" });
      try {
        await standUpSession(app, "A", SID, sessionDeckShape(["A"]));
        await seedProseTurns(app, "A", SID, TURNS, replyText);
        // The Session card is a body: its transcript, and the list-view
        // probes that drive it, are in its own page.
        const body = app.body("A");
        await body.waitForCondition<boolean>(
          `document.querySelectorAll('${SEL.card} [data-tug-list-cell-index]').length > 4`,
          { timeoutMs: 60_000 },
        );
        const scroller = `${SEL.card} ${SCROLLER}`;
        await body.evalJS<number>(`(function () {
  var el = document.querySelector('${scroller}');
  el.scrollTop = 0;
  return el.scrollTop;
})()`);
        await waitFrames(body);

        // ---- A far row lands, in band ----
        await body.evalJS<boolean>(
          `(window.__tug.startListReveal(${JSON.stringify(scroller)}, ${FAR_ROW}), true)`,
        );
        const landed = await nextRevealOutcome(body);
        note(`far-row reveal outcome: ${landed}`);
        expect(landed, "a far row must land, not expire").toBe("landed");
        const band = await rowBand(body, FAR_ROW);
        note(`far-row band: ${JSON.stringify(band)}`);
        expect(band, "the revealed row must be mounted at the end").not.toBeNull();
        expect(
          band!.top >= band!.bandTop - 0.5 && band!.top < band!.bandBottom,
          `row ${FAR_ROW} top ${band!.top} outside band ${band!.bandTop}..${band!.bandBottom}`,
        ).toBe(true);

        // ---- A second reveal supersedes the first ----
        // Both calls in ONE evalJS, so the second starts while the first is
        // still waiting for its row to mount.
        await body.evalJS<boolean>(
          `(function () {
  window.__tug.startListReveal(${JSON.stringify(scroller)}, ${OVERTAKEN_ROW});
  window.__tug.startListReveal(${JSON.stringify(scroller)}, ${OVERTAKING_ROW});
  return true;
})()`,
        );
        const first = await nextRevealOutcome(body);
        const second = await nextRevealOutcome(body);
        note(`supersede outcomes: ${JSON.stringify([first, second])}`);
        expect(
          first,
          "the reveal that was overtaken must say so, not simply vanish",
        ).toBe("superseded");
        expect(second, "and the newer one runs to its own answer").toBe("landed");

        // ---- A hand scroll cancels, and is not undone ----
        // A raw `scrollTop` write, which is attribution-identical to the
        // event-silent native scrollbar: `isUserScrolling` never goes true
        // for it, so only the drift read-back can catch it.
        await body.evalJS<boolean>(`(function () {
  var el = document.querySelector('${scroller}');
  el.scrollTop = 0;
  return true;
})()`);
        await waitFrames(body);
        const grabbed = await body.evalJS<number>(`(function () {
  window.__tug.startListReveal(${JSON.stringify(scroller)}, ${CANCELLED_ROW});
  var el = document.querySelector('${scroller}');
  el.scrollTop = el.scrollTop + 900;
  return el.scrollTop;
})()`);
        note(`scroll offset after the hand grab: ${grabbed}`);
        const cancelled = await nextRevealOutcome(body);
        note(`hand-scroll reveal outcome: ${cancelled}`);
        expect(
          cancelled,
          "a reveal must stand down when the user takes the scroller",
        ).toBe("cancelled");
        const offsets = await sampleOffsets(body, scroller);
        note(`offsets after the hand grab: ${JSON.stringify([...new Set(offsets.map(Math.round))])}`);
        expect(
          offsets.length,
          "occlusion: a covered harness window suspends requestAnimationFrame; this is not a reveal failure",
        ).toBeGreaterThanOrEqual(10);
        // A reveal that respects the gesture leaves the scroller where the
        // hand put it; one that does not moves it on toward its row.
        const moved = offsets.slice(-10).filter((o) => Math.abs(o - grabbed) > DRIFT_PX);
        expect(
          moved.length,
          `the scroller was moved off the hand grab at ${grabbed} in ${moved.length}/10 frames: ${JSON.stringify(moved)}`,
        ).toBe(0);

        // ---- An out-of-range index clamps ----
        await body.evalJS<boolean>(
          `(window.__tug.startListReveal(${JSON.stringify(scroller)}, 99999), true)`,
        );
        const clamped = await nextRevealOutcome(body);
        note(`clamped reveal outcome: ${clamped}`);
        expect(
          clamped,
          "an out-of-range index clamps to the last row rather than failing",
        ).toBe("landed");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
