/**
 * The shell's claim over its bodies is the union of the surfaces it raises,
 * and a surface covering the whole viewport claims everything.
 *
 * @covers tugdeck/src/lib/pointer-claim.ts
 */
import { describe, expect, test } from "bun:test";
import { claimFor, sameClaim, type ClaimRect } from "../pointer-claim";

const VIEWPORT = { width: 1000, height: 800 };

function rect(x: number, y: number, width: number, height: number): ClaimRect {
  return { x, y, width, height };
}

describe("claimFor", () => {
  test("no surface is an empty claim", () => {
    expect(claimFor([], VIEWPORT)).toEqual({ rects: [] });
  });

  test("surfaces without an area claim nothing", () => {
    expect(claimFor([rect(10, 10, 0, 40), rect(5, 5, 30, 0)], VIEWPORT)).toEqual({ rects: [] });
  });

  test("separate surfaces claim each of their rects", () => {
    const a = rect(10, 10, 100, 50);
    const b = rect(400, 300, 200, 120);
    expect(claimFor([a, b], VIEWPORT)).toEqual({ rects: [a, b] });
  });

  test("a rect inside another adds nothing to the union", () => {
    const outer = rect(100, 100, 300, 300);
    const inner = rect(150, 150, 50, 50);
    expect(claimFor([inner, outer], VIEWPORT)).toEqual({ rects: [outer] });
  });

  test("two identical rects claim once", () => {
    const a = rect(10, 10, 100, 50);
    expect(claimFor([a, { ...a }], VIEWPORT)).toEqual({ rects: [a] });
  });

  test("a surface covering the whole viewport claims all", () => {
    expect(claimFor([rect(10, 10, 100, 50), rect(0, 0, 1000, 800)], VIEWPORT)).toEqual({
      all: true,
    });
    expect(claimFor([rect(-4, -4, 1010, 810)], VIEWPORT)).toEqual({ all: true });
  });

  test("a surface short of the viewport by a pixel is a rect, not all", () => {
    const nearly = rect(0, 0, 1000, 799);
    expect(claimFor([nearly], VIEWPORT)).toEqual({ rects: [nearly] });
  });
});

describe("sameClaim", () => {
  test("compares all, and rects by value", () => {
    expect(sameClaim(null, { all: true })).toBe(false);
    expect(sameClaim({ all: true }, { all: true })).toBe(true);
    expect(sameClaim({ all: true }, { rects: [] })).toBe(false);
    expect(sameClaim({ rects: [rect(1, 2, 3, 4)] }, { rects: [rect(1, 2, 3, 4)] })).toBe(true);
    expect(sameClaim({ rects: [rect(1, 2, 3, 4)] }, { rects: [rect(1, 2, 3, 5)] })).toBe(false);
  });
});
