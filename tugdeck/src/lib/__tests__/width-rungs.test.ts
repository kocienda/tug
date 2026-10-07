/**
 * width-rungs — the threshold mapping that replaced the `@container` rungs.
 * The point of the move is that the width asked about is the CSS-px content
 * box, which a page zoom leaves alone; these pin the mapping against the
 * readings that showed the container queries drifting.
 */

import { describe, expect, test } from "bun:test";

import { rungsAt } from "../width-rungs";
import { STATUS_ROW_WIDTH_RUNGS } from "@/components/tugways/tug-status-cell";

describe("rungsAt", () => {
  test("max-width semantics: a rung applies at its own width", () => {
    const rungs = [{ name: "a", maxWidth: 100 }];
    expect(rungsAt(100, rungs)).toBe("a");
    expect(rungsAt(100.5, rungs)).toBe("");
  });

  test("every rung at or above the width applies, in the order given", () => {
    const rungs = [
      { name: "wide", maxWidth: 900 },
      { name: "narrow", maxWidth: 700 },
    ];
    expect(rungsAt(950, rungs)).toBe("");
    expect(rungsAt(800, rungs)).toBe("wide");
    expect(rungsAt(675, rungs)).toBe("wide narrow");
  });

  test("a box with no width answers nothing, so a hidden card keeps its rungs", () => {
    expect(rungsAt(0, STATUS_ROW_WIDTH_RUNGS)).toBeNull();
    expect(rungsAt(Number.NaN, STATUS_ROW_WIDTH_RUNGS)).toBeNull();
  });
});

describe("the Z2 status row at every zoom", () => {
  // The slim card's strip content box, read live at each factor. The
  // container queries hid TIME at 90 % and 80 % and TASKS at 80 %, because
  // they saw these widths multiplied by the zoom.
  const SLIM_STRIP_CONTENT_PX = {
    "80 %": 657.75,
    "90 %": 657.889,
    "100 %": 657,
    "110 %": 657.182,
  };

  for (const [zoom, width] of Object.entries(SLIM_STRIP_CONTENT_PX)) {
    test(`a slim card shows all five cells at ${zoom}`, () => {
      expect(rungsAt(width, STATUS_ROW_WIDTH_RUNGS)).toBe("");
    });
  }

  test("the rungs still collapse a card dragged narrower than any preset", () => {
    expect(rungsAt(653, STATUS_ROW_WIDTH_RUNGS)).toBe("time");
    expect(rungsAt(500, STATUS_ROW_WIDTH_RUNGS)).toBe("time tasks");
    expect(rungsAt(400, STATUS_ROW_WIDTH_RUNGS)).toBe("time tasks jobs");
  });
});
