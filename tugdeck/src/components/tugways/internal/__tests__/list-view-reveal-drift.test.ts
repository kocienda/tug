/**
 * list-view-reveal-drift — the live `revealRange`'s "has the user taken the
 * scroller?" verdict.
 *
 * The defect this pins: an embedded editor's own scroll-into-view moved
 * the transcript scroller under a find reveal, the reveal's baseline never
 * moved with it, and the reveal settled `cancelled:user-scroll` with nobody
 * scrolling (at0494). A declared write re-bases the baseline; an
 * undeclared move — the event-silent native scrollbar — still cancels, and
 * so does a user move AFTER a declared write. Pure function, no DOM.
 */

import { describe, expect, test } from "bun:test";

import { judgeRevealDrift } from "../list-view-reveal-drift";

const THRESHOLD = 8;

const base = {
  armedTop: 1000,
  armedWriteSeq: 5,
  scrollTop: 1000,
  writeSeq: 5,
  lastWriteTop: 1000,
  userScrolling: false,
  thresholdPx: THRESHOLD,
};

describe("judgeRevealDrift — declared writes are not the user", () => {
  test("an editor's declared write that moved the scroller does not cancel", () => {
    // FileBlock wrote 1000 → 640 and declared it: the count advanced and
    // the position it left is recorded.
    const v = judgeRevealDrift({
      ...base,
      scrollTop: 640,
      writeSeq: 6,
      lastWriteTop: 640,
    });
    expect(v.cancel).toBe(false);
    expect(v.armedTop).toBe(640);
    expect(v.armedWriteSeq).toBe(6);
  });

  test("a user move after a declared write still cancels", () => {
    // The write left 640; the scrollbar then dragged to 300.
    const v = judgeRevealDrift({
      ...base,
      scrollTop: 300,
      writeSeq: 6,
      lastWriteTop: 640,
    });
    expect(v.cancel).toBe(true);
  });

  test("an animated declared write leaves no position, so movement counts", () => {
    const v = judgeRevealDrift({
      ...base,
      scrollTop: 640,
      writeSeq: 6,
      lastWriteTop: null,
    });
    expect(v.cancel).toBe(true);
    expect(v.armedTop).toBe(1000);
  });
});

describe("judgeRevealDrift — the user still takes the scroller", () => {
  test("an undeclared move past the threshold cancels (native scrollbar)", () => {
    const v = judgeRevealDrift({ ...base, scrollTop: 1000 + THRESHOLD + 1 });
    expect(v.cancel).toBe(true);
  });

  test("jitter within the threshold does not", () => {
    const v = judgeRevealDrift({ ...base, scrollTop: 1000 + THRESHOLD });
    expect(v.cancel).toBe(false);
  });

  test("a visible gesture cancels with no drift at all", () => {
    const v = judgeRevealDrift({ ...base, userScrolling: true });
    expect(v.cancel).toBe(true);
  });

  test("before the reveal has armed a baseline, only a gesture cancels", () => {
    const v = judgeRevealDrift({
      ...base,
      armedTop: null,
      scrollTop: 0,
      writeSeq: 9,
      lastWriteTop: 0,
    });
    expect(v.cancel).toBe(false);
    expect(v.armedTop).toBeNull();
  });
});
