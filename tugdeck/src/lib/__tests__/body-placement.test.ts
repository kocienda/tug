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

function placement(x: number, visible = true): PlaceBodies {
  return {
    radius: 6,
    bodies: [{ cardId: "a", x, y: 40, width: 300, height: 200, visible }],
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
