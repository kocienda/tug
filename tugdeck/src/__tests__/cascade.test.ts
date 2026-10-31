/**
 * cascade.test.ts — where a new free pane lands, with and without rails.
 */

import { describe, expect, test } from "bun:test";

import { nextCascadePosition } from "@/cascade";

const CANVAS = { width: 1320, height: 900 };
const CARD = { width: 800, height: 720 };

describe("nextCascadePosition", () => {
  test("with no rail it starts at the canvas's corner", () => {
    expect(nextCascadePosition([], CANVAS, CARD)).toEqual({ x: 10, y: 10 });
  });

  test("a left rail moves every slot clear of it", () => {
    const insets = { left: 476, right: 0 };
    expect(nextCascadePosition([], CANVAS, CARD, insets)).toEqual({ x: 486, y: 10 });
    expect(nextCascadePosition([{ x: 486, y: 10 }], CANVAS, CARD, insets)).toEqual({ x: 516, y: 40 });
  });

  test("the walk restarts where it would run under a right rail", () => {
    const insets = { left: 0, right: 476 };
    expect(nextCascadePosition([{ x: 10, y: 10 }], CANVAS, CARD, insets)).toEqual({ x: 40, y: 40 });
    const taken = [{ x: 10, y: 10 }, { x: 40, y: 40 }];
    expect(nextCascadePosition(taken, CANVAS, CARD, insets)).toEqual({ x: 10, y: 10 });
  });

  test("a restart returns to the room's corner, not the canvas's", () => {
    const insets = { left: 476, right: 0 };
    const taken = [{ x: 486, y: 10 }];
    expect(nextCascadePosition(taken, CANVAS, { width: 830, height: 720 }, insets)).toEqual({ x: 486, y: 10 });
  });
});
