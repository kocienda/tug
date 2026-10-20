/**
 * A body shows only when it is ready and its card is shown — the active card
 * of its pane, not folded (unless it draws its folded form in its body), not
 * arriving, in the shown workspace — and the
 * placer tells the host only what changed. A body a plan is carrying in is
 * not hidden for arriving while its settle runs, and a body measured in a
 * collapsed frame has no insets to land at.
 *
 * @covers tugdeck/src/lib/body-placement.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { IDeckManagerStore } from "../../deck-manager-store";
import { bodyCardsStore } from "../body-cards-store";
import {
  bodyHoles,
  bodyVisible,
  gripRects,
  hiddenSince,
  insetsWithin,
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
  foldsInBody: false,
  arriving: false,
  layerShown: true,
};

describe("a body's grips", () => {
  const rect = (x: number, y: number, width: number, height: number) => ({
    x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}),
  });
  const handle = (cls: string, r: ReturnType<typeof rect>) => ({
    className: cls,
    getBoundingClientRect: () => r,
  });
  const frame = (handles: ReturnType<typeof handle>[]) =>
    ({ querySelectorAll: (sel: string) => (sel === ":scope > .tug-pane-resize" ? handles : []) }) as unknown as Element;

  test("are the pane's resize handles, grown to whole points, and nothing for a pane with none", () => {
    expect(gripRects(frame([handle("tug-pane-resize tug-pane-resize-s", rect(48.5, 456.25, 544, 8)), handle("tug-pane-resize tug-pane-resize-e", rect(596, 48, 8, 404))]))).toEqual([
      { x: 48, y: 456, width: 545, height: 9 },
      { x: 596, y: 48, width: 8, height: 404 },
    ]);
    expect(gripRects(frame([]))).toEqual([]);
    expect(gripRects(null)).toEqual([]);
  });

  test("a handle with no area is no grip", () => {
    expect(gripRects(frame([handle("tug-pane-resize tug-pane-resize-s", rect(0, 0, 0, 8))]))).toEqual([]);
  });
});

describe("bodyVisible", () => {
  const cases: Array<[string, Partial<BodyShownFacts>, boolean]> = [
    ["painted, active, open, settled, shown", {}, true],
    ["ready but not yet painted", { painted: false }, false],
    ["an inactive tab", { active: false }, false],
    ["folded", { folded: true }, false],
    ["folded, drawing its folded form in its body", { folded: true, foldsInBody: true }, true],
    ["open, drawing its folded form in its body", { foldsInBody: true }, true],
    ["arriving", { arriving: true }, false],
    ["in a parked workspace", { layerShown: false }, false],
    ["folded in a parked workspace", { folded: true, layerShown: false }, false],
    ["folded in its own form, in a parked workspace", { folded: true, foldsInBody: true, layerShown: false }, false],
  ];
  for (const [name, over, visible] of cases) {
    test(name, () => {
      expect(bodyVisible({ ...SHOWN, ...over })).toBe(visible);
    });
  }
});

describe("the order bodies are posted in", () => {
  test("is the deck's reading order, left to right and then down a column, whatever order they came in", () => {
    const at = (cardId: string, x: number, y: number) => ({ cardId, x, y, width: 300, height: 200, visible: true, z: 0, grips: [] });
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
        { cardId: "a", x: 10, y: 40, width: 300, height: 200, visible: true, z: 0, grips: [] },
        { cardId: "b", x: 320, y: 40, width: 300, height: 200, visible: false, z: 0, grips: [] },
      ],
    });
    expect(holes).toEqual([{ x: 10, y: 40, width: 300, height: 200 }]);
  });

  test("two bodies on one rect cut one hole", () => {
    const holes = bodyHoles({
      radius: 6,
      bodies: [
        { cardId: "a", x: 10, y: 40, width: 300, height: 200, visible: true, z: 0, grips: [] },
        { cardId: "b", x: 10, y: 40, width: 300, height: 200, visible: true, z: 0, grips: [] },
      ],
    });
    expect(holes).toEqual([{ x: 10, y: 40, width: 300, height: 200 }]);
  });

  test("overlapping bodies cut disjoint holes covering their union", () => {
    const holes = bodyHoles({
      radius: 6,
      bodies: [
        { cardId: "a", x: 0, y: 0, width: 100, height: 100, visible: true, z: 0, grips: [] },
        { cardId: "b", x: 50, y: 50, width: 100, height: 100, visible: true, z: 0, grips: [] },
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
    bodies: [{ cardId: "a", x, y: 40, width: 300, height: 200, visible, z: 0, grips: [] }],
  };
}

describe("a pane behind bodies", () => {
  const placement: PlaceBodies = {
    radius: 6,
    bodies: [
      { cardId: "front", x: 500, y: 100, width: 400, height: 300, visible: true, z: 5, grips: [] },
      { cardId: "hidden", x: 100, y: 100, width: 400, height: 300, visible: false, z: 5, grips: [] },
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

describe("hiddenSince", () => {
  afterEach(() => bodyCardsStore._reset());

  /** A deck of one pane, `p1`, holding `rail`, arriving unless `arriving` is false, in a parked workspace when `parked`. */
  function deckOf(facts: { arriving: boolean; parked?: boolean }): IDeckManagerStore {
    const state = {
      panes: [{ id: "p1", cardIds: ["rail"], activeCardId: "rail" }],
      cards: [{ id: "rail", componentId: "layout" }],
      arriving: { p1: facts.arriving },
    };
    return {
      getSnapshot: () => state,
      spaceOf: () => (facts.parked === true ? "parked" : null),
      getSpacesSnapshot: () => ({ activeSpaceId: "shown" }),
    } as unknown as IDeckManagerStore;
  }

  const posted: PlaceBodies = {
    radius: 6,
    bodies: [{ cardId: "rail", x: 0, y: 34, width: 420, height: 1016, grips: [], visible: true, z: 1 }],
  };

  test("an arriving body is hidden unless a plan is carrying it in", () => {
    bodyCardsStore.mark("rail");
    bodyCardsStore.setState("rail", "painted");
    const deck = deckOf({ arriving: true });
    expect(hiddenSince(deck, posted)?.bodies[0].visible).toBe(false);
    expect(hiddenSince(deck, posted, new Set(["rail"]))).toBeNull();
  });

  test("a body carried in is still hidden by a fact that would hide it anyway", () => {
    bodyCardsStore.mark("rail");
    bodyCardsStore.setState("rail", "painted");
    const deck = deckOf({ arriving: true, parked: true });
    expect(hiddenSince(deck, posted, new Set(["rail"]))?.bodies[0].visible).toBe(false);
  });
});

describe("insetsWithin", () => {
  test("a body with room in a pane with room has its insets", () => {
    expect(insetsWithin({ x: 0, y: 33, width: 420, height: 1018 }, { x: 0, y: 33, width: 419, height: 1018 })).toEqual({
      top: 0,
      left: 0,
      right: 1,
      bottom: 0,
    });
  });

  test("a body in a collapsed rail, or a collapsed body, has none", () => {
    expect(insetsWithin({ x: 0, y: 33, width: 1, height: 1018 }, { x: 1, y: 34, width: 0, height: 1016 })).toBeNull();
    expect(insetsWithin({ x: 0, y: 33, width: 420, height: 1018 }, { x: 1, y: 34, width: 0, height: 1016 })).toBeNull();
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
