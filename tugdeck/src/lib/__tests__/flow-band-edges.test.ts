/**
 * flow-band-edges.test.ts — the band has two edges, and both move with the
 * rails.
 *
 * `getBandWidth()` used to be the only thing the deck said about its band,
 * and a drag's flow trigger read `IMPOSITION_GAP_PX` as the band's start —
 * true with no rail on the left, and a full rail width wrong with one. The
 * edges are one function now, `flowBandEdges`, and the width is their
 * difference, so this file pins the three facts the drag rests on:
 *
 *  1. With no rails the band is one gap in from each canvas edge.
 *  2. A standing rail moves ITS side's edge in by `railSpanInsetPx`, and
 *     leaves the other edge where it was.
 *  3. The width the edges imply is the width `resolveSpan` implies —
 *     `span.width − 2 × gap` — so the trigger and the pins agree by
 *     construction.
 */

import { describe, expect, test } from "bun:test";

import {
  IMPOSITION_GAP_PX,
  flowBandEdges,
  railSpanInsetPx,
  resolveSpan,
  type SidebarRail,
} from "../layout-imposer";

const CANVAS = 1659;
const RAIL = 420;

const rail = (side: "left" | "right", width: number): SidebarRail =>
  ({ side, width }) as unknown as SidebarRail;

describe("flowBandEdges", () => {
  test("with no rails the band is one gap in from each canvas edge", () => {
    const edges = flowBandEdges(CANVAS, {});
    expect(edges.start).toBe(IMPOSITION_GAP_PX);
    expect(edges.end).toBe(CANVAS - IMPOSITION_GAP_PX);
  });

  test("a left rail moves the start in by its inset and leaves the end alone", () => {
    const bare = flowBandEdges(CANVAS, {});
    const edges = flowBandEdges(CANVAS, { left: RAIL });
    expect(edges.start).toBe(bare.start + railSpanInsetPx(RAIL));
    expect(edges.end).toBe(bare.end);
  });

  test("a right rail moves the end in by its inset and leaves the start alone", () => {
    const bare = flowBandEdges(CANVAS, {});
    const edges = flowBandEdges(CANVAS, { right: RAIL });
    expect(edges.start).toBe(bare.start);
    expect(edges.end).toBe(bare.end - railSpanInsetPx(RAIL));
  });

  test("a side with no rail costs nothing — it is not a rail of width zero", () => {
    const edges = flowBandEdges(CANVAS, { left: undefined });
    expect(edges.start).toBe(IMPOSITION_GAP_PX);
    // A zero-width rail would still stand its edge inset and gutter.
    expect(flowBandEdges(CANVAS, { left: 0 }).start).toBeGreaterThan(edges.start);
  });

  test("the edges imply the width resolveSpan implies, for every rail shape", () => {
    const shapes: { left?: number; right?: number }[] = [
      {},
      { left: RAIL },
      { right: RAIL },
      { left: 300, right: RAIL },
    ];
    for (const shape of shapes) {
      const rails: SidebarRail[] = [];
      if (shape.left !== undefined) rails.push(rail("left", shape.left));
      if (shape.right !== undefined) rails.push(rail("right", shape.right));
      const span = resolveSpan({ width: CANVAS, height: 1000 }, rails);
      const edges = flowBandEdges(CANVAS, shape);
      expect(edges.end - edges.start).toBe(span.width - IMPOSITION_GAP_PX * 2);
      expect(edges.start).toBe(span.x + IMPOSITION_GAP_PX);
    }
  });
});
