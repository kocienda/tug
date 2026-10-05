import { describe, expect, test } from "bun:test";

import {
  fitEdgeRate,
  fitImposedLeft,
  fitWidthForEdge,
  flowResizeShift,
  slotHeightAfterDrag,
} from "@/lib/keep-slot-resize";
import type { DeckState, TugPaneState } from "@/layout-tree";

describe("slot-keeping width resize (fit)", () => {
  const bandStart = 40;
  const bandWidth = 2000;

  test("each edge moves at its own rate, and the pinned ones not at all", () => {
    // Slot 0: the left edge is the arrangement's, the right edge the hand's.
    expect(fitEdgeRate("left", 0, bandWidth, 800)).toBe(0);
    expect(fitEdgeRate("right", 0, bandWidth, 800)).toBe(1);
    // The last slot mirrors it.
    expect(fitEdgeRate("left", 1, bandWidth, 800)).toBe(1);
    expect(fitEdgeRate("right", 1, bandWidth, 800)).toBe(0);
    // The middle of three: symmetric, each edge at half the change.
    expect(fitEdgeRate("left", 0.5, bandWidth, 800)).toBe(0.5);
    expect(fitEdgeRate("right", 0.5, bandWidth, 800)).toBe(0.5);
    // Wider than the band: no travel, so the left edge stands at the start.
    expect(fitEdgeRate("left", 1, bandWidth, 2400)).toBe(0);
    expect(fitEdgeRate("right", 1, bandWidth, 2400)).toBe(1);
  });

  test("the solved width puts the dragged edge exactly where the hand is", () => {
    // Wherever the width is not held at a bound — a bound is where the edge
    // stops following the hand, which the next test covers.
    for (const fraction of [0, 0.2, 0.5, 0.75, 1]) {
      for (const width of [500, 800, 1300]) {
        const left = fitImposedLeft(fraction, bandStart, bandWidth, width);
        const right = left + width;
        for (const dx of [-120, -7, 0, 33, 260]) {
          if (fraction < 1) {
            const w = fitWidthForEdge("right", right + dx, fraction, bandStart, bandWidth, 100, Infinity);
            if (w > 100) {
              expect(fitImposedLeft(fraction, bandStart, bandWidth, w) + w).toBeCloseTo(right + dx, 6);
            }
          }
          if (fraction > 0) {
            const w = fitWidthForEdge("left", left + dx, fraction, bandStart, bandWidth, 100, Infinity);
            if (w > 100) {
              expect(fitImposedLeft(fraction, bandStart, bandWidth, w)).toBeCloseTo(left + dx, 6);
            }
          }
        }
      }
    }
  });

  test("the width is clamped to the card's bounds", () => {
    const left = fitImposedLeft(0, bandStart, bandWidth, 800);
    expect(fitWidthForEdge("right", left + 50, 0, bandStart, bandWidth, 300, 1200)).toBe(300);
    expect(fitWidthForEdge("right", left + 1900, 0, bandStart, bandWidth, 300, 1200)).toBe(1200);
  });

  test("a right edge dragged past the band carries the card wider than the band", () => {
    // Once the card is as wide as the band its left edge stands at the start,
    // and the right edge follows the hand one for one.
    const w = fitWidthForEdge("right", bandStart + 2300, 0.5, bandStart, bandWidth, 100, Infinity);
    expect(w).toBe(2300);
    expect(fitImposedLeft(0.5, bandStart, bandWidth, w)).toBe(bandStart);
  });
});

describe("slot-keeping width resize (flow)", () => {
  const pane = (id: string, slot: number, width: number): TugPaneState => ({
    id,
    position: { x: 0, y: 0 },
    size: { width, height: 300 },
    cardIds: [`card-${id}`],
    activeCardId: `card-${id}`,
    title: "",
    acceptsFamilies: ["standard"],
    slot,
  });
  const deck = (
    panes: TugPaneState[],
    layout: "fit" | "flow" = "flow",
  ): DeckState => ({
    cards: panes.map((p) => ({
      id: `card-${p.id}`,
      componentId: "probe",
      title: p.id,
      closable: true,
    })),
    panes,
    imposition: { kind: "three-up", layout, sidebars: {} },
    hasFocus: true,
  });

  test("the card's left stands and every later slot moves by the change", () => {
    const state = deck([pane("a", 0, 500), pane("b", 1, 600), pane("c", 2, 700)]);
    const narrower = flowResizeShift(state, "a", 400);
    expect(narrower?.shifts.get("a")).toBe(0);
    expect(narrower?.shifts.get("b")).toBe(-100);
    expect(narrower?.shifts.get("c")).toBe(-100);

    // The middle card moves only what stands after it.
    const wider = flowResizeShift(state, "b", 750);
    expect(wider?.shifts.get("a")).toBe(0);
    expect(wider?.shifts.get("b")).toBe(0);
    expect(wider?.shifts.get("c")).toBe(150);
  });

  test("the strip's length is the one the commit lays out", () => {
    const state = deck([pane("a", 0, 500), pane("b", 1, 600), pane("c", 2, 700)]);
    const before = flowResizeShift(state, "a", 500);
    const after = flowResizeShift(state, "a", 420);
    expect(before?.stripWidth).toBeDefined();
    expect((after?.stripWidth ?? 0) - (before?.stripWidth ?? 0)).toBe(-80);
  });

  test("a stack mate wider than the card holds the slot's extent", () => {
    // Slot 0's extent is its widest member's width, so the card can grow up
    // to its mate's width without moving anything, and past it moves the
    // later slots by only the excess.
    const state = deck([pane("a", 0, 500), pane("m", 0, 900), pane("c", 1, 600)]);
    expect(flowResizeShift(state, "a", 800)?.shifts.get("c")).toBe(0);
    expect(flowResizeShift(state, "a", 1000)?.shifts.get("c")).toBe(100);
    expect(flowResizeShift(state, "a", 1000)?.shifts.get("m")).toBe(0);
  });

  test("a fit deck has no strip to ask", () => {
    const state = deck([pane("a", 0, 500), pane("b", 1, 600)], "fit");
    expect(flowResizeShift(state, "a", 400)).toBeNull();
  });
});

describe("slot-keeping height resize", () => {
  test("a height short of the run's end is written", () => {
    expect(slotHeightAfterDrag(400, 900)).toBe(400);
    expect(slotHeightAfterDrag(899, 900)).toBe(899);
  });

  test("a height at or past the run's end clears the field", () => {
    expect(slotHeightAfterDrag(900, 900)).toBeNull();
    expect(slotHeightAfterDrag(899.6, 900)).toBeNull();
    expect(slotHeightAfterDrag(1200, 900)).toBeNull();
  });
});
