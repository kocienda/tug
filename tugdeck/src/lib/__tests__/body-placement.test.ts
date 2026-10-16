/**
 * A body shows only when it is ready and its card is shown — the active card
 * of its pane, not folded, not arriving, in the shown workspace — and the
 * placer tells the host only what changed.
 *
 * @covers tugdeck/src/lib/body-placement.ts
 */
import { describe, expect, test } from "bun:test";
import {
  bodyHoles,
  bodyVisible,
  inReadingOrder,
  mirrorInsets,
  paneClipPath,
  paneHoles,
  PlacementPoster,
  railSideFlipped,
  type BodyShownFacts,
  type PlaceBodies,
} from "../body-placement";

const SHOWN: BodyShownFacts = {
  painted: true,
  active: true,
  folded: false,
  arriving: false,
  layerShown: true,
};

describe("bodyVisible", () => {
  const cases: Array<[string, Partial<BodyShownFacts>, boolean]> = [
    ["painted, active, open, settled, shown", {}, true],
    ["ready but not yet painted", { painted: false }, false],
    ["an inactive tab", { active: false }, false],
    ["folded", { folded: true }, false],
    ["arriving", { arriving: true }, false],
    ["in a parked workspace", { layerShown: false }, false],
    ["folded in a parked workspace", { folded: true, layerShown: false }, false],
  ];
  for (const [name, over, visible] of cases) {
    test(name, () => {
      expect(bodyVisible({ ...SHOWN, ...over })).toBe(visible);
    });
  }
});

describe("the order bodies are posted in", () => {
  test("is the deck's reading order, left to right and then down a column, whatever order they came in", () => {
    const at = (cardId: string, x: number, y: number) => ({ cardId, x, y, width: 300, height: 200, visible: true, z: 0 });
    // Pane-id order — the canvas's — is a, b, text; the deck stands a, text, b.
    const posted = inReadingOrder([at("a", 0, 40), at("b", 640, 40), at("text", 320, 40), at("under-a", 0, 260)]);
    expect(posted.map((b) => b.cardId)).toEqual(["a", "under-a", "text", "b"]);
  });
});

describe("the holes bodies cut", () => {
  test("a visible body cuts a hole; a hidden one does not", () => {
    const holes = bodyHoles({
      radius: 6,
      bodies: [
        { cardId: "a", x: 10, y: 40, width: 300, height: 200, visible: true, z: 0 },
        { cardId: "b", x: 320, y: 40, width: 300, height: 200, visible: false, z: 0 },
      ],
    });
    expect(holes).toEqual([{ x: 10, y: 40, width: 300, height: 200 }]);
  });

  test("two bodies on one rect cut one hole", () => {
    const holes = bodyHoles({
      radius: 6,
      bodies: [
        { cardId: "a", x: 10, y: 40, width: 300, height: 200, visible: true, z: 0 },
        { cardId: "b", x: 10, y: 40, width: 300, height: 200, visible: true, z: 0 },
      ],
    });
    expect(holes).toEqual([{ x: 10, y: 40, width: 300, height: 200 }]);
  });

  test("overlapping bodies cut disjoint holes covering their union", () => {
    const holes = bodyHoles({
      radius: 6,
      bodies: [
        { cardId: "a", x: 0, y: 0, width: 100, height: 100, visible: true, z: 0 },
        { cardId: "b", x: 50, y: 50, width: 100, height: 100, visible: true, z: 0 },
      ],
    });
    const area = holes.reduce((s, h) => s + h.width * h.height, 0);
    expect(area).toBe(100 * 100 + 100 * 100 - 50 * 50);
    for (const p of holes) {
      for (const q of holes) {
        if (p === q) continue;
        const apart = p.x + p.width <= q.x || q.x + q.width <= p.x || p.y + p.height <= q.y || q.y + q.height <= p.y;
        expect(apart).toBe(true);
      }
    }
  });

  test("a hole with no area is no clip", () => {
    expect(paneClipPath([{ x: 10, y: 10, width: 0, height: 50 }])).toBe("");
  });

  test("two holes are two closed subpaths, never one ring through both", () => {
    expect(
      paneClipPath([
        { x: 10, y: 40, width: 100, height: 100 },
        { x: 300, y: 40, width: 100, height: 100 },
      ]),
    ).toBe(
      'path(evenodd, "M-100000 -100000H100000V100000H-100000ZM10 40H110V140H10ZM300 40H400V140H300Z")',
    );
  });

  test("a hole past the ring is clamped to it", () => {
    expect(paneClipPath([{ x: 99_950, y: 0, width: 100, height: 10 }])).toBe(
      'path(evenodd, "M-100000 -100000H100000V100000H-100000ZM99950 0H100000V10H99950Z")',
    );
  });
});

function placement(x: number, visible = true): PlaceBodies {
  return {
    radius: 6,
    bodies: [{ cardId: "a", x, y: 40, width: 300, height: 200, visible, z: 0 }],
  };
}

describe("a pane behind bodies", () => {
  const placement: PlaceBodies = {
    radius: 6,
    bodies: [
      { cardId: "front", x: 500, y: 100, width: 400, height: 300, visible: true, z: 5 },
      { cardId: "hidden", x: 100, y: 100, width: 400, height: 300, visible: false, z: 5 },
    ],
  };

  test("wears a hole at a front body's rect that meets its box, in its own px", () => {
    const holes = paneHoles(placement, { x: 100, y: 50, width: 600, height: 500, layoutWidth: 600, z: 2 });
    expect(holes).toEqual([{ x: 400, y: 50, width: 400, height: 300 }]);
  });

  test("wears none for a body behind it, beside it, or hidden", () => {
    expect(paneHoles(placement, { x: 100, y: 50, width: 600, height: 500, layoutWidth: 600, z: 9 })).toEqual([]);
    expect(paneHoles(placement, { x: 1000, y: 50, width: 600, height: 500, layoutWidth: 600, z: 2 })).toEqual([]);
    expect(paneHoles(placement, { x: 100, y: 100, width: 400, height: 300, layoutWidth: 400, z: 2 })).toEqual([]);
  });

  test("a zoomed pane's holes are in layout px", () => {
    const holes = paneHoles(placement, { x: 100, y: 50, width: 1200, height: 1000, layoutWidth: 600, z: 2 });
    expect(holes).toEqual([{ x: 200, y: 25, width: 200, height: 150 }]);
  });

  test("a parked pane with no box wears none", () => {
    expect(paneHoles(placement, { x: 0, y: 0, width: 0, height: 0, layoutWidth: 0, z: 2 })).toEqual([]);
  });

  test("the clip's ring reaches far past the pane, so only the holes cut", () => {
    expect(paneClipPath([])).toBe("");
    expect(paneClipPath([{ x: 400, y: 50, width: 400, height: 300 }])).toBe(
      'path(evenodd, "M-100000 -100000H100000V100000H-100000ZM400 50H800V350H400Z")',
    );
  });
});

describe("PlacementPoster", () => {
  test("an unchanged set posts nothing", () => {
    const posted: PlaceBodies[] = [];
    const poster = new PlacementPoster((p) => posted.push(p));
    expect(poster.offer(placement(10))).toBe(true);
    expect(poster.offer(placement(10))).toBe(false);
    expect(posted).toHaveLength(1);
  });

  test("a moved rect, a visibility flip and a new radius each post", () => {
    const posted: PlaceBodies[] = [];
    const poster = new PlacementPoster((p) => posted.push(p));
    poster.offer(placement(10));
    poster.offer(placement(12));
    poster.offer(placement(12, false));
    poster.offer({ ...placement(12, false), radius: 8 });
    expect(posted.map((p) => [p.bodies[0].x, p.bodies[0].visible, p.radius])).toEqual([
      [10, true, 6],
      [12, true, 6],
      [12, false, 6],
      [12, false, 8],
    ]);
  });

  test("a deck with no bodies says nothing until it has had one", () => {
    const posted: PlaceBodies[] = [];
    const poster = new PlacementPoster((p) => posted.push(p));
    expect(poster.offer({ radius: 0, bodies: [] })).toBe(false);
    expect(poster.posted).toBe(false);
    poster.offer(placement(10));
    // The last body going is news: the host hides what the set no longer names.
    expect(poster.offer({ radius: 6, bodies: [] })).toBe(true);
    expect(posted).toHaveLength(2);
  });

  test("a beat plan's landing is adopted without posting, and the land's identical measurement posts nothing", () => {
    const posted: PlaceBodies[] = [];
    const poster = new PlacementPoster((p) => posted.push(p));
    poster.offer(placement(10));
    poster.adopt(placement(300));
    expect(posted).toHaveLength(1);
    expect(poster.lastPosted?.bodies[0].x).toBe(300);
    expect(poster.offer(placement(300))).toBe(false);
    expect(posted).toHaveLength(1);
    // A land that measures somewhere else is news.
    expect(poster.offer(placement(301))).toBe(true);
  });
});

describe("a rail carried to the other edge", () => {
  test("mirrors its insets only when the edge it stands on has changed", () => {
    expect(railSideFlipped("right", "left")).toBe(true);
    expect(railSideFlipped("left", "left")).toBe(false);
    expect(railSideFlipped(null, "left")).toBe(false);
    expect(railSideFlipped("right", null)).toBe(false);
    expect(mirrorInsets({ top: 36, right: 1, bottom: 0, left: 0 })).toEqual({ top: 36, right: 0, bottom: 0, left: 1 });
  });
});
