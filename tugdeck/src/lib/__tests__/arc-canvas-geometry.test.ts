import { describe, it, expect } from "bun:test";

import {
  ARC_CANVAS_PAD,
  ARC_CANVAS_RUNGS,
  ARC_CARD_WIDTH,
  ARC_CARD_WIDTH_EXPANDED,
  ARC_PORT_Y,
  arcCanvasDefaultState,
  arcCanvasExtent,
  arcCanvasHomePositions,
  arcConnectorPath,
  clampToArcCanvas,
  layoutArcCanvas,
  parseArcCanvasState,
  type ArcCanvasState,
} from "../arc-canvas-geometry";

const closed = { idea: false, sketch: false, brief: false, arc: false };

describe("home positions", () => {
  it("stand the four cards in the ladder's order, left to right, without overlap", () => {
    const home = arcCanvasHomePositions();
    for (let i = 0; i < ARC_CANVAS_RUNGS.length - 1; i += 1) {
      const here = home[ARC_CANVAS_RUNGS[i]];
      const next = home[ARC_CANVAS_RUNGS[i + 1]];
      expect(next.x).toBeGreaterThanOrEqual(here.x + ARC_CARD_WIDTH);
    }
  });

  it("step neighbours apart vertically, so every connector curves", () => {
    const home = arcCanvasHomePositions();
    for (let i = 0; i < ARC_CANVAS_RUNGS.length - 1; i += 1) {
      expect(home[ARC_CANVAS_RUNGS[i]].y).not.toBe(home[ARC_CANVAS_RUNGS[i + 1]].y);
    }
  });

  it("are on the canvas, and a fresh object each call", () => {
    const home = arcCanvasHomePositions();
    for (const rung of ARC_CANVAS_RUNGS) expect(clampToArcCanvas(home[rung])).toEqual(home[rung]);
    expect(arcCanvasHomePositions()).not.toBe(home);
  });
});

describe("the clamp that keeps a card on the canvas", () => {
  it("holds a card at the top and left edges", () => {
    expect(clampToArcCanvas({ x: -40, y: -3 })).toEqual({ x: 0, y: 0 });
    expect(clampToArcCanvas({ x: -40, y: 90 })).toEqual({ x: 0, y: 90 });
  });

  it("lets a card go as far right and down as it is put", () => {
    expect(clampToArcCanvas({ x: 5000, y: 3000 })).toEqual({ x: 5000, y: 3000 });
  });

  it("lands on whole pixels, and reads a non-number as the edge", () => {
    expect(clampToArcCanvas({ x: 10.6, y: 20.2 })).toEqual({ x: 11, y: 20 });
    expect(clampToArcCanvas({ x: Number.NaN, y: Number.POSITIVE_INFINITY })).toEqual({ x: 0, y: 0 });
  });
});

describe("the layout", () => {
  it("draws every closed card where it stands, at the resting width", () => {
    const positions = arcCanvasHomePositions();
    const shown = layoutArcCanvas({ positions, expanded: closed });
    for (const rung of ARC_CANVAS_RUNGS) {
      expect(shown[rung]).toEqual({ ...positions[rung], w: ARC_CARD_WIDTH });
    }
  });

  it("an open card is wider and pushes the cards to its right along by what it grew", () => {
    const positions = arcCanvasHomePositions();
    const shown = layoutArcCanvas({ positions, expanded: { ...closed, sketch: true } });
    const growth = ARC_CARD_WIDTH_EXPANDED - ARC_CARD_WIDTH;
    expect(shown.idea.x).toBe(positions.idea.x);
    expect(shown.sketch).toEqual({ ...positions.sketch, w: ARC_CARD_WIDTH_EXPANDED });
    expect(shown.brief.x).toBe(positions.brief.x + growth);
    expect(shown.arc.x).toBe(positions.arc.x + growth);
  });

  it("two open cards push a card to the right of both by both", () => {
    const positions = arcCanvasHomePositions();
    const shown = layoutArcCanvas({ positions, expanded: { ...closed, idea: true, brief: true } });
    const growth = ARC_CARD_WIDTH_EXPANDED - ARC_CARD_WIDTH;
    expect(shown.sketch.x).toBe(positions.sketch.x + growth);
    expect(shown.arc.x).toBe(positions.arc.x + 2 * growth);
  });
});

describe("the path between two cards", () => {
  it("leaves the first card's right edge and arrives at the second's left, at port height", () => {
    const path = arcConnectorPath({ x: 16, y: 40, w: 200 }, { x: 272, y: 16, w: 200 });
    expect(path.startsWith(`M216 ${40 + ARC_PORT_Y} C`)).toBe(true);
    expect(path.endsWith(`, 272 ${16 + ARC_PORT_Y}`)).toBe(true);
  });

  it("leaves and arrives level, with control points half the gap out", () => {
    // Ports 100 apart: the control points sit 50 out, at each port's height.
    expect(arcConnectorPath({ x: 0, y: 0, w: 200 }, { x: 300, y: 100, w: 200 })).toBe(
      "M200 64 C 250 64, 250 164, 300 164",
    );
  });

  it("still reaches out when the cards are close or the second stands to the left", () => {
    // Ports 10 apart: the reach holds at its minimum, 28.
    expect(arcConnectorPath({ x: 0, y: 0, w: 200 }, { x: 210, y: 0, w: 200 })).toBe(
      "M200 64 C 228 64, 182 64, 210 64",
    );
    // The second card is left of the first: the curve loops out and back.
    expect(arcConnectorPath({ x: 400, y: 0, w: 200 }, { x: 0, y: 0, w: 200 })).toBe(
      "M600 64 C 900 64, -300 64, 0 64",
    );
  });

  it("follows an open card's wider edge", () => {
    const path = arcConnectorPath({ x: 0, y: 0, w: ARC_CARD_WIDTH_EXPANDED }, { x: 600, y: 0, w: 200 });
    expect(path.startsWith(`M${ARC_CARD_WIDTH_EXPANDED} 64 `)).toBe(true);
  });
});

describe("the canvas's extent", () => {
  it("holds the rightmost and the lowest card, and the clear space beyond", () => {
    const shown = layoutArcCanvas({ positions: arcCanvasHomePositions(), expanded: closed });
    const extent = arcCanvasExtent(shown, { idea: 236, sketch: 236, brief: 300, arc: 236 });
    expect(extent.width).toBe(784 + ARC_CARD_WIDTH + ARC_CANVAS_PAD);
    expect(extent.height).toBe(40 + 300 + ARC_CANVAS_PAD);
  });
});

describe("the remembered canvas", () => {
  it("is null for an absent or non-json entry", () => {
    expect(parseArcCanvasState(undefined)).toBeNull();
    expect(parseArcCanvasState({ kind: "string", value: "x" })).toBeNull();
    expect(parseArcCanvasState({ kind: "json", value: null })).toBeNull();
  });

  it("round-trips a state", () => {
    const state: ArcCanvasState = {
      positions: { idea: { x: 1, y: 2 }, sketch: { x: 300, y: 4 }, brief: { x: 5, y: 600 }, arc: { x: 7, y: 8 } },
      expanded: { idea: true, sketch: false, brief: true, arc: false },
    };
    expect(parseArcCanvasState({ kind: "json", value: JSON.parse(JSON.stringify(state)) })).toEqual(state);
  });

  it("falls back per card, and brings a card remembered off the canvas back onto it", () => {
    const fallback = arcCanvasDefaultState();
    const parsed = parseArcCanvasState({
      kind: "json",
      value: {
        positions: { idea: { x: -50, y: 12 }, sketch: "nowhere", brief: { x: 9 } },
        expanded: { idea: "yes", arc: false },
      },
    });
    expect(parsed?.positions.idea).toEqual({ x: 0, y: 12 });
    expect(parsed?.positions.sketch).toEqual(fallback.positions.sketch);
    expect(parsed?.positions.brief).toEqual(fallback.positions.brief);
    expect(parsed?.positions.arc).toEqual(fallback.positions.arc);
    expect(parsed?.expanded.idea).toBe(fallback.expanded.idea);
    expect(parsed?.expanded.arc).toBe(false);
  });

  it("a fresh arc opens with every card at home and the Arc card open", () => {
    const fresh = arcCanvasDefaultState();
    expect(fresh.positions).toEqual(arcCanvasHomePositions());
    expect(fresh.expanded).toEqual({ idea: false, sketch: false, brief: false, arc: true });
  });
});
