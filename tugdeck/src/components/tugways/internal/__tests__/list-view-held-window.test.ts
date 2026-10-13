/**
 * The held commit: what a list renders while a settle's motion gate is
 * closed. It renders the rows the last unheld commit rendered and nothing
 * else, translated past any rows prepended under the hold.
 */

import { describe, expect, it } from "bun:test";

import { coldWindow, holdCommittedWindow, MEASURE_SEGMENT_MAX_ROWS } from "../list-view-window";

describe("holdCommittedWindow", () => {
  it("leaves the rendered count at the previous count when rows are appended under the hold", () => {
    const held = holdCommittedWindow({ first: 40, last: 50 }, null, 50, 0, 53);
    expect(held).toEqual({ firstIndex: 40, lastIndex: 50, segment: null, renderedCount: 50 });
  });

  it("translates the window and the segment by a prepend of 3", () => {
    const held = holdCommittedWindow(
      { first: 20, last: 30 },
      { firstIndex: 8, lastIndex: 12 },
      50,
      3,
      53,
    );
    expect(held).toEqual({
      firstIndex: 23,
      lastIndex: 33,
      segment: { firstIndex: 11, lastIndex: 15 },
      renderedCount: 53,
    });
  });

  it("keeps a segment that touched the window merged into it", () => {
    // The resolver merged the segment into the window, so the last commit
    // remembered no segment: the held commit renders the merged window as one.
    const held = holdCommittedWindow({ first: 12, last: 30 }, null, 50, 2, 55);
    expect(held).toEqual({ firstIndex: 14, lastIndex: 32, segment: null, renderedCount: 52 });
  });

  it("returns null when the data has fewer rows than the last commit rendered plus the prepend", () => {
    expect(holdCommittedWindow({ first: 40, last: 50 }, null, 50, 0, 49)).toBeNull();
    expect(holdCommittedWindow({ first: 40, last: 50 }, null, 50, 3, 52)).toBeNull();
  });
});

describe("coldWindow", () => {
  const M = MEASURE_SEGMENT_MAX_ROWS;

  it("takes the last rows at the tail", () => {
    expect(coldWindow(100, { kind: "tail" })).toEqual({ firstIndex: 100 - M, lastIndex: 100 });
  });

  it("centres on an anchor row", () => {
    expect(coldWindow(100, { kind: "row", index: 50 })).toEqual({
      firstIndex: 50 - Math.floor(M / 2),
      lastIndex: 50 - Math.floor(M / 2) + M,
    });
  });

  it("clamps a row near the top to start at row 0", () => {
    expect(coldWindow(100, { kind: "row", index: 1 })).toEqual({ firstIndex: 0, lastIndex: M });
  });

  it("clamps a row near the end to finish at the last row", () => {
    expect(coldWindow(100, { kind: "row", index: 99 })).toEqual({ firstIndex: 100 - M, lastIndex: 100 });
  });

  it("takes every row when there are fewer than the cap", () => {
    expect(coldWindow(3, { kind: "tail" })).toEqual({ firstIndex: 0, lastIndex: 3 });
    expect(coldWindow(3, { kind: "row", index: 2 })).toEqual({ firstIndex: 0, lastIndex: 3 });
  });
});
