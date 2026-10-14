/**
 * A body shows only when it is ready and its card is shown — the active card
 * of its pane, not folded, not arriving, in the shown workspace — and the
 * placer tells the host only what changed.
 *
 * @covers tugdeck/src/lib/body-placement.ts
 */
import { describe, expect, test } from "bun:test";
import {
  bodyVisible,
  floorClipPath,
  floorHoles,
  PlacementPoster,
  type BodyShownFacts,
  type PlaceBodies,
} from "../body-placement";

const SHOWN: BodyShownFacts = {
  ready: true,
  active: true,
  folded: false,
  arriving: false,
  layerShown: true,
};

describe("bodyVisible", () => {
  const cases: Array<[string, Partial<BodyShownFacts>, boolean]> = [
    ["ready, active, open, settled, shown", {}, true],
    ["not yet ready", { ready: false }, false],
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

describe("the floor", () => {
  test("a visible body cuts a hole; a hidden one does not", () => {
    const holes = floorHoles({
      radius: 6,
      bodies: [
        { cardId: "a", x: 10, y: 40, width: 300, height: 200, visible: true, z: 0 },
        { cardId: "b", x: 320, y: 40, width: 300, height: 200, visible: false, z: 0 },
      ],
    });
    expect(holes).toEqual([{ x: 10, y: 40, width: 300, height: 200 }]);
  });

  test("two bodies on one rect cut one hole", () => {
    const holes = floorHoles({
      radius: 6,
      bodies: [
        { cardId: "a", x: 10, y: 40, width: 300, height: 200, visible: true, z: 0 },
        { cardId: "b", x: 10, y: 40, width: 300, height: 200, visible: true, z: 0 },
      ],
    });
    expect(holes).toEqual([{ x: 10, y: 40, width: 300, height: 200 }]);
  });

  test("overlapping bodies cut disjoint holes covering their union", () => {
    const holes = floorHoles({
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

  test("no holes is no clip", () => {
    expect(floorClipPath([], 800, 600)).toBe("");
    expect(floorClipPath([{ x: 10, y: 10, width: 0, height: 50 }], 800, 600)).toBe("");
  });

  test("the clip is the box less each hole, even-odd, one subpath each", () => {
    expect(floorClipPath([{ x: 10, y: 40, width: 300, height: 200 }], 800, 600)).toBe(
      'path(evenodd, "M0 0H800V600H0ZM10 40H310V240H10Z")',
    );
    // Two holes are two closed subpaths, never one ring through both.
    expect(
      floorClipPath(
        [
          { x: 10, y: 40, width: 100, height: 100 },
          { x: 300, y: 40, width: 100, height: 100 },
        ],
        800,
        600,
      ),
    ).toBe('path(evenodd, "M0 0H800V600H0ZM10 40H110V140H10ZM300 40H400V140H300Z")');
  });

  test("a hole past the box is clamped to it", () => {
    expect(floorClipPath([{ x: -20, y: 500, width: 100, height: 200 }], 800, 600)).toBe(
      'path(evenodd, "M0 0H800V600H0ZM0 500H80V600H0Z")',
    );
  });
});

function placement(x: number, visible = true): PlaceBodies {
  return {
    radius: 6,
    bodies: [{ cardId: "a", x, y: 40, width: 300, height: 200, visible, z: 0 }],
  };
}

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
});
