/**
 * The pin-to-tail rule of a runnable offer's result: whether an output that
 * scrolls inside itself is brought to its foot after a write. Pure over the
 * three numbers a scroller reports; no DOM.
 */
import { describe, expect, test } from "bun:test";

import { isPinnedToTail } from "../enhance-run-offer";

describe("isPinnedToTail", () => {
  test("an output shorter than its cap has nothing to scroll and is at its tail", () => {
    expect(isPinnedToTail({ scrollTop: 0, clientHeight: 120, scrollHeight: 120 })).toBe(true);
  });

  test("an output scrolled to its foot is at its tail", () => {
    expect(isPinnedToTail({ scrollTop: 480, clientHeight: 320, scrollHeight: 800 })).toBe(true);
  });

  test("a sub-pixel gap at the foot still counts", () => {
    expect(isPinnedToTail({ scrollTop: 478.5, clientHeight: 320, scrollHeight: 800 })).toBe(true);
  });

  test("a reader who has scrolled up a line is no longer at the tail", () => {
    expect(isPinnedToTail({ scrollTop: 460, clientHeight: 320, scrollHeight: 800 })).toBe(false);
  });

  test("a reader at the top of a long output is not at the tail", () => {
    expect(isPinnedToTail({ scrollTop: 0, clientHeight: 320, scrollHeight: 800 })).toBe(false);
  });

  test("the rule is read before the write, so growth alone never unpins", () => {
    // At the foot before the write: pinned, so the write is followed. The
    // same position measured against the grown output would read as scrolled
    // up, which is why the reading is taken first.
    const before = { scrollTop: 480, clientHeight: 320, scrollHeight: 800 };
    const afterGrowth = { ...before, scrollHeight: 960 };
    expect(isPinnedToTail(before)).toBe(true);
    expect(isPinnedToTail(afterGrowth)).toBe(false);
  });
});
