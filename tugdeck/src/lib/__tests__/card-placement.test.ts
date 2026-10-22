/**
 * A card shows only when it is painted and shown — the active card of its
 * pane, not arriving, in the shown workspace — and the placer tells the host
 * only what changed, in one `placeCards` composed from the placement and the
 * facts its stand-ins carry. A card a plan is carrying in is not hidden for
 * arriving while its settle runs, and a card measured at the rect a plan is
 * carrying it to names that plan, so the host leaves the plan to land it.
 *
 * @covers tugdeck/src/lib/card-placement.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { IDeckManagerStore } from "../../deck-manager-store";
import { bodyCardsStore } from "../body-cards-store";
import {
  bodyVisible,
  faceToCarry,
  heldForThePaint,
  hiddenSince,
  inReadingOrder,
  LANDING_GUARD_MS,
  landDrifts,
  landingHorizonMs,
  meetsAFace,
  namePlans,
  placeCardsOf,
  PlacementPoster,
  samePlacement,
  shownFactsOf,
  wantsFace,
  type BodyPlacement,
  type BodyShownFacts,
  type CardFacts,
  type InFlightPlan,
  type Placement,
} from "../card-placement";
import { CARD_APRON_PX } from "../chrome-placement";
import { SOLVE_GUARD_MS } from "../card-plan";
import { firstFamily, rgbaOf, rgbaOfBytes, svgPaintOf, withinView, type FaceDraw } from "../face-draw";

const SHOWN: BodyShownFacts = {
  painted: true,
  active: true,
  arriving: false,
  layerShown: true,
};

const APRON = { top: CARD_APRON_PX, right: CARD_APRON_PX, bottom: CARD_APRON_PX, left: CARD_APRON_PX };

const NO_DRAW: FaceDraw = { boxes: [], texts: [], images: [] };

function view(cardId: string, x: number, y: number, over: Partial<BodyPlacement> = {}): BodyPlacement {
  // A card that wants a face carries the display list the host draws it from.
  const drawn = over.face === true && !("faceDraw" in over) ? { faceDraw: NO_DRAW } : {};
  return { cardId, x, y, width: 300, height: 200, visible: true, z: 0, shell: [], insets: APRON, ...drawn, ...over };
}

describe("bodyVisible", () => {
  const cases: Array<[string, Partial<BodyShownFacts>, boolean]> = [
    ["painted, active, open, settled, shown", {}, true],
    ["ready but not yet painted", { painted: false }, false],
    ["an inactive tab", { active: false }, false],
    ["arriving", { arriving: true }, false],
    ["in a parked workspace", { layerShown: false }, false],
  ];
  for (const [name, over, visible] of cases) {
    test(name, () => {
      expect(bodyVisible({ ...SHOWN, ...over })).toBe(visible);
    });
  }
});

describe("wantsFace", () => {
  const UNPAINTED: BodyShownFacts = { ...SHOWN, painted: false };

  test("a card hidden only for want of its first paint wants a face", () => {
    expect(wantsFace(UNPAINTED, false)).toBe(true);
  });

  const cases: Array<[string, Partial<BodyShownFacts>]> = [
    ["an inactive tab", { active: false }],
    ["arriving", { arriving: true }],
    ["in a parked workspace", { layerShown: false }],
  ];
  for (const [name, over] of cases) {
    test(`${name} wants none`, () => {
      expect(wantsFace({ ...UNPAINTED, ...over }, false)).toBe(false);
    });
  }

  test("a card placed visible, or in no pane, wants none", () => {
    expect(wantsFace(SHOWN, true)).toBe(false);
    expect(wantsFace(null, false)).toBe(false);
  });

  test("a placement that changes only a face is news", () => {
    const plain: Placement = { bodies: [view("a", 0, 40, { visible: false })] };
    const faced: Placement = { bodies: [view("a", 0, 40, { visible: false, face: true })] };
    expect(samePlacement(plain, faced)).toBe(false);
    expect(samePlacement(faced, faced)).toBe(true);
  });
});

describe("the order cards are posted in", () => {
  test("is the deck's reading order, left to right and then down a column, whatever order they came in", () => {
    // Pane-id order — the canvas's — is a, b, text; the deck stands a, text, b.
    const posted = inReadingOrder([view("a", 0, 40), view("b", 640, 40), view("text", 320, 40), view("under-a", 0, 260)]);
    expect(posted.map((b) => b.cardId)).toEqual(["a", "under-a", "text", "b"]);
  });
});

describe("placeCardsOf", () => {
  const facts: CardFacts = {
    canvas: { x: 0, y: 28, width: 1440, height: 872 },
    zoom: 1.25,
    gap: 15,
    byCard: new Map([["a", { grips: ["e", "s"], free: true, min: { width: 240, height: 160 }, maxHeight: 820 }]]),
    rails: {},
    band: { band: 900, flow: null },
  };

  test("carries each card's pane, its view and insets, the shell's controls over it, and its stand-in's facts", () => {
    const seam = { x: 300, y: 40, width: 8, height: 200 };
    const cards = placeCardsOf({ bodies: [view("a", 0, 40, { z: 3, shell: [seam], insets: { ...APRON, right: 10.5 } })] }, facts);
    expect(cards.apron).toBe(CARD_APRON_PX);
    expect(cards.canvas).toEqual(facts.canvas);
    expect(cards.zoom).toBe(1.25);
    expect(cards.cards).toEqual([
      {
        cardId: "a",
        x: CARD_APRON_PX,
        y: 40 + CARD_APRON_PX,
        width: 300 - 2 * CARD_APRON_PX,
        height: 200 - 2 * CARD_APRON_PX,
        view: { x: 0, y: 40, width: 300, height: 200 },
        insets: { ...APRON, right: 10.5 },
        shell: [seam],
        visible: true,
        z: 3,
        grips: ["e", "s"],
        free: true,
        min: { width: 240, height: 160 },
        maxHeight: 820,
      },
    ]);
  });

  test("a hide composes the same facts with the card hidden, and a sibling says so", () => {
    const shown = placeCardsOf({ bodies: [view("a", 0, 40)] }, facts).cards[0];
    const hidden = placeCardsOf({ bodies: [view("a", 0, 40, { visible: false, sibling: true })] }, facts).cards[0];
    expect(hidden).toEqual({ ...shown, visible: false, sibling: true });
  });

  test("a card the measurement read no facts for offers no grip and no floor", () => {
    const card = placeCardsOf({ bodies: [view("b", 0, 40)] }, facts).cards[0];
    expect([card.grips, card.free, card.min, card.maxHeight]).toEqual([[], false, { width: 0, height: 0 }, undefined]);
  });

  test("a card a plan is carrying names its plan; one no plan carries names none", () => {
    const carried = placeCardsOf({ bodies: [view("a", 0, 40, { planId: 7 })] }, facts).cards[0];
    expect(carried.planId).toBe(7);
    const rest = placeCardsOf({ bodies: [view("a", 0, 40)] }, facts).cards[0];
    expect("planId" in rest).toBe(false);
  });

  test("a card that wants a face says so; one that does not says nothing", () => {
    const faced = placeCardsOf({ bodies: [view("a", 0, 40, { visible: false, face: true })] }, facts).cards[0];
    expect(faced.face).toBe(true);
    const plain = placeCardsOf({ bodies: [view("a", 0, 40, { visible: false })] }, facts).cards[0];
    expect("face" in plain).toBe(false);
  });
});

function placement(x: number, visible = true): Placement {
  return { bodies: [view("a", x, 40, { visible })] };
}

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

  const posted: Placement = { bodies: [view("rail", 0, 34, { width: 420, height: 1016, z: 1 })] };

  test("an arriving card is hidden unless a plan is carrying it in", () => {
    bodyCardsStore.mark("rail");
    bodyCardsStore.setState("rail", "painted");
    const deck = deckOf({ arriving: true });
    expect(hiddenSince(deck, posted)?.bodies[0].visible).toBe(false);
    expect(hiddenSince(deck, posted, new Set(["rail"]))).toBeNull();
  });

  test("a card carried in is still hidden by a fact that would hide it anyway", () => {
    bodyCardsStore.mark("rail");
    bodyCardsStore.setState("rail", "painted");
    const deck = deckOf({ arriving: true, parked: true });
    expect(hiddenSince(deck, posted, new Set(["rail"]))?.bodies[0].visible).toBe(false);
  });
});

describe("a revived card", () => {
  afterEach(() => bodyCardsStore._reset());

  const deck = {
    getSnapshot: () => ({ panes: [{ id: "p1", cardIds: ["b"], activeCardId: "b" }], cards: [{ id: "b", componentId: "session" }], arriving: {} }),
    spaceOf: () => null,
    getSpacesSnapshot: () => ({ activeSpaceId: "shown" }),
  } as unknown as IDeckManagerStore;

  /** `b`, evicted and asked for again: the shell's `askForBodyAgain` moves it to `creating`. */
  function askedAgain(): void {
    bodyCardsStore.mark("b");
    bodyCardsStore.setState("b", "painted");
    bodyCardsStore.setState("b", "evicted");
    bodyCardsStore.setState("b", "creating");
  }

  test("with no cover waits for its paint, its stand-in standing", () => {
    askedAgain();
    expect(shownFactsOf(deck, "b")?.painted).toBe(false);
    bodyCardsStore.setState("b", "painted");
    expect(shownFactsOf(deck, "b")?.painted).toBe(true);
  });

  test("under its last frame shows from the host's covered, and stands on its own once painted", () => {
    askedAgain();
    bodyCardsStore.markRevived("b");
    expect(bodyCardsStore.revivedNow("b")).toBe(true);
    expect(shownFactsOf(deck, "b")?.painted).toBe(true);
    bodyCardsStore.setState("b", "painted");
    expect(bodyCardsStore.revivedNow("b")).toBe(false);
  });

  test("is not marked covered while still evicted, nor once it is past its hand-off", () => {
    bodyCardsStore.mark("b");
    bodyCardsStore.setState("b", "evicted");
    bodyCardsStore.markRevived("b");
    expect(bodyCardsStore.revivedNow("b")).toBe(false);
    bodyCardsStore.setState("b", "creating");
    bodyCardsStore.setState("b", "ready");
    bodyCardsStore.markRevived("b");
    expect(bodyCardsStore.revivedNow("b")).toBe(false);
  });
});

describe("namePlans", () => {
  const inFlight = new Map<string, InFlightPlan>([["a", { planId: 3, landing: { x: 300, y: 40, width: 300, height: 200 }, arrives: false, lands: true, solves: false }]]);

  test("a card measured at the rect its plan lands it at names the plan", () => {
    const named = namePlans({ bodies: [view("a", 300, 40), view("b", 0, 40)] }, inFlight);
    expect(named.bodies.map((b) => b.planId)).toEqual([3, undefined]);
  });

  test("a card measured anywhere else — a drag took its frame — names no plan, and the host takes it from its beats", () => {
    const moved: Placement = { bodies: [view("a", 420, 40)] };
    expect(namePlans(moved, inFlight)).toBe(moved);
    expect(namePlans(moved, new Map())).toBe(moved);
  });

  test("naming the plan is news the poster carries", () => {
    const at = { bodies: [view("a", 300, 40)] };
    expect(samePlacement(at, namePlans(at, inFlight))).toBe(false);
    expect(samePlacement(namePlans(at, inFlight), namePlans(at, inFlight))).toBe(true);
  });
});

describe("landDrifts", () => {
  const landings = { a: { x: 300, y: 40, width: 300, height: 200 }, b: { x: 0, y: 40, width: 300, height: 200 } };

  test("a landed card measured at its plan's landing has nothing left to move", () => {
    expect(landDrifts({ bodies: [view("a", 300, 40), view("b", 0.4, 40)] }, ["a", "b"], landings)).toEqual([]);
  });

  test("one measured a pixel or more away is a drift, named with its delta", () => {
    const placement = { bodies: [view("a", 300, 40, { height: 188 }), view("b", 0, 40)] };
    expect(landDrifts(placement, ["a", "b"], landings)).toEqual([{ cardId: "a", dx: 0, dy: 0, dw: 0, dh: -12 }]);
  });

  test("a card the plan did not land, or the measurement does not place, says nothing", () => {
    const placement = { bodies: [view("a", 900, 40)] };
    expect(landDrifts(placement, ["b"], landings)).toEqual([]);
    expect(landDrifts(placement, ["c"], landings)).toEqual([]);
  });
});

describe("landingHorizonMs", () => {
  test("a solving plan's horizon waits out the host's solve guard as well as the landing guard", () => {
    expect(landingHorizonMs(300, false)).toBe(300 + LANDING_GUARD_MS);
    expect(landingHorizonMs(300, true)).toBe(300 + SOLVE_GUARD_MS + LANDING_GUARD_MS);
  });
});

describe("PlacementPoster", () => {
  test("an unchanged set posts nothing", () => {
    const posted: Placement[] = [];
    const poster = new PlacementPoster((p) => posted.push(p));
    expect(poster.offer(placement(10))).toBe(true);
    expect(poster.offer(placement(10))).toBe(false);
    expect(posted).toHaveLength(1);
  });

  test("a moved rect, a visibility flip, new insets and a new seam over the card each post", () => {
    const posted: Placement[] = [];
    const poster = new PlacementPoster((p) => posted.push(p));
    poster.offer(placement(10));
    poster.offer(placement(12));
    poster.offer(placement(12, false));
    poster.offer({ bodies: [view("a", 12, 40, { visible: false, insets: { ...APRON, left: 10.5 } })] });
    poster.offer({ bodies: [view("a", 12, 40, { visible: false, insets: { ...APRON, left: 10.5 }, shell: [{ x: 0, y: 0, width: 8, height: 8 }] })] });
    expect(posted.map((p) => [p.bodies[0].x, p.bodies[0].visible, p.bodies[0].insets.left, p.bodies[0].shell.length])).toEqual([
      [10, true, CARD_APRON_PX, 0],
      [12, true, CARD_APRON_PX, 0],
      [12, false, CARD_APRON_PX, 0],
      [12, false, 10.5, 0],
      [12, false, 10.5, 1],
    ]);
  });

  test("a deck with no cards says nothing until it has had one", () => {
    const posted: Placement[] = [];
    const poster = new PlacementPoster((p) => posted.push(p));
    expect(poster.offer({ bodies: [] })).toBe(false);
    expect(poster.posted).toBe(false);
    poster.offer(placement(10));
    // The last card going is news: the host hides what the set no longer names.
    expect(poster.offer({ bodies: [] })).toBe(true);
    expect(posted).toHaveLength(2);
  });

  test("a card plan's landing is adopted without posting, and the land's identical measurement posts nothing", () => {
    const posted: Placement[] = [];
    const poster = new PlacementPoster((p) => posted.push(p));
    poster.offer(placement(10));
    const landing: Placement = { bodies: [view("a", 300, 40, { planId: 1 })] };
    poster.adopt(landing);
    expect(posted).toHaveLength(1);
    expect(poster.lastPosted?.bodies[0].x).toBe(300);
    expect(poster.offer({ bodies: [view("a", 300, 40, { planId: 1 })] })).toBe(false);
    expect(posted).toHaveLength(1);
    // A land that measures somewhere else is news.
    expect(poster.offer(placement(301))).toBe(true);
  });
});

describe("heldForThePaint", () => {
  test("a placement that takes nothing down holds nothing", () => {
    expect(heldForThePaint(null, { bodies: [view("a", 0, 0)] })).toBeNull();
    expect(heldForThePaint({ bodies: [view("a", 0, 0)] }, { bodies: [view("a", 10, 0), view("b", 0, 0)] })).toBeNull();
    expect(heldForThePaint({ bodies: [view("a", 0, 0, { visible: false })] }, { bodies: [view("a", 0, 0, { visible: false })] })).toBeNull();
  });

  test("a view taken down stands where it was for the paint, and the release is the measurement's own", () => {
    const last = { bodies: [view("home", 40, 40), view("b", 0, 0, { visible: false })] };
    const next = { bodies: [view("home", 0, 0, { visible: false }), view("b", 0, 0)] };
    const hold = heldForThePaint(last, next);
    expect(hold?.held.bodies).toEqual([view("b", 0, 0), view("home", 40, 40)]);
    expect(hold?.releasing.bodies).toEqual([view("b", 0, 0), view("home", 0, 0, { visible: false })]);
  });

  test("a view whose place a shown view takes is not held: a tab put behind the card chosen in its pane", () => {
    const last = { bodies: [view("a", 40, 40), view("b", 40, 40, { visible: false, sibling: true })] };
    const next = { bodies: [view("a", 40, 40, { visible: false, sibling: true }), view("b", 40, 40)] };
    expect(heldForThePaint(last, next)).toBeNull();
  });

  test("a parked workspace's view is held even when it stays placed as a sibling", () => {
    const last = { bodies: [view("home", 40, 40)] };
    const next = { bodies: [view("home", 40, 40, { visible: false, sibling: true }), view("w1", 0, 0, { visible: false })] };
    expect(heldForThePaint(last, next)?.held.bodies).toEqual([view("w1", 0, 0, { visible: false }), view("home", 40, 40)]);
  });

  test("a view gone from the placement altogether is held too", () => {
    const hold = heldForThePaint({ bodies: [view("gone", 40, 40)] }, { bodies: [view("w1", 0, 0)] });
    expect(hold?.held.bodies).toEqual([view("w1", 0, 0), view("gone", 40, 40)]);
    expect(hold?.releasing.bodies).toEqual([view("w1", 0, 0), view("gone", 40, 40, { visible: false })]);
  });

  test("a view over a card that wants a face is not held: the host hands it over", () => {
    const last = { bodies: [view("home", 40, 40), view("w1", 60, 60, { visible: false })] };
    const next = { bodies: [view("home", 40, 40, { visible: false }), view("w1", 60, 60, { visible: false, face: true })] };
    expect(heldForThePaint(last, next)).toBeNull();
  });

  test("a view over no face keeps its paint, beside one handed over", () => {
    const last = { bodies: [view("over", 0, 0), view("clear", 1000, 0)] };
    const next = {
      bodies: [
        view("over", 0, 0, { visible: false }),
        view("clear", 1000, 0, { visible: false }),
        view("w1", 100, 100, { visible: false, face: true }),
      ],
    };
    const hold = heldForThePaint(last, next);
    expect(hold?.held.bodies.filter((b) => b.visible).map((b) => b.cardId)).toEqual(["clear"]);
    expect(hold?.releasing.bodies.find((b) => b.cardId === "over")?.visible).toBe(false);
  });

  test("a tab put behind a card that cannot show yet is handed over, not held", () => {
    const last = { bodies: [view("a", 0, 0), view("b", 0, 0, { visible: false })] };
    const next = { bodies: [view("a", 0, 0, { visible: false }), view("b", 0, 0, { visible: false, face: true })] };
    expect(meetsAFace(last.bodies[0], next)).toBe(true);
    expect(heldForThePaint(last, next)).toBeNull();
  });
});

describe("meetsAFace", () => {
  test("a view sharing area with a face meets it", () => {
    expect(meetsAFace(view("a", 0, 0), { bodies: [view("f", 299, 199, { visible: false, face: true })] })).toBe(true);
  });

  test("an edge in common, a card not marked face, and the card itself do not", () => {
    expect(meetsAFace(view("a", 0, 0), { bodies: [view("f", 300, 0, { visible: false, face: true })] })).toBe(false);
    expect(meetsAFace(view("a", 0, 0), { bodies: [view("f", 10, 10, { visible: false })] })).toBe(false);
    expect(meetsAFace(view("a", 0, 0), { bodies: [view("a", 0, 0, { visible: false, face: true })] })).toBe(false);
  });

  test("a face the host has no list to draw from is not met, so the view over it keeps its paint", () => {
    const undrawn = { bodies: [view("f", 10, 10, { visible: false, face: true, faceDraw: undefined })] };
    expect(meetsAFace(view("a", 0, 0), undrawn)).toBe(false);
    expect(heldForThePaint({ bodies: [view("a", 0, 0)] }, { bodies: [view("a", 0, 0, { visible: false }), ...undrawn.bodies] })).not.toBeNull();
  });
});

describe("faceToCarry", () => {
  const DRAWN: FaceDraw = { boxes: [], texts: [{ rect: { x: 0, y: 0, width: 10, height: 10 }, text: "Old", font: { family: "Inter", size: 12, weight: 400 }, color: "rgba(0, 0, 0, 1)" }], images: [] };
  const FRESH: FaceDraw = { boxes: [], texts: [], images: [] };

  test("a card becoming a face reads its stand-in, under the stand-in's key", () => {
    expect(faceToCarry(undefined, "k1", () => FRESH)).toEqual({ draw: FRESH, key: "k1" });
  });

  test("a face whose stand-in's facts stand carries its list, read nothing", () => {
    const carried = { draw: DRAWN, key: "k1" };
    let reads = 0;
    expect(faceToCarry(carried, "k1", () => ((reads += 1), FRESH))).toBe(carried);
    expect(reads).toBe(0);
  });

  test("a face whose stand-in's facts moved — a masthead, a name, the theme — is read again", () => {
    const next = faceToCarry({ draw: DRAWN, key: "k1" }, "k2", () => FRESH);
    expect(next).toEqual({ draw: FRESH, key: "k2" });
  });

  test("with no stand-in to read, a carried list stands and an uncarried face has none", () => {
    const carried = { draw: DRAWN, key: "k1" };
    expect(faceToCarry(carried, null, () => FRESH)).toBe(carried);
    expect(faceToCarry(undefined, null, () => FRESH)).toBeNull();
  });
});

describe("a face's display list, its pure parts", () => {
  test("computed rgb and rgba colours are written rgba, and a transparent one is nothing", () => {
    expect(rgbaOf("rgb(46, 48, 54)")).toBe("rgba(46, 48, 54, 1)");
    expect(rgbaOf("rgba(255, 255, 255, 0.06)")).toBe("rgba(255, 255, 255, 0.06)");
    expect(rgbaOf("rgb(10 20 30 / 50%)")).toBe("rgba(10, 20, 30, 0.5)");
    expect(rgbaOf("rgba(0, 0, 0, 0)")).toBeNull();
    expect(rgbaOf("oklch(1 0 0 / 0.06)")).toBeNull();
  });

  test("a canvas's pixel bytes are written rgba, and a clear one is nothing", () => {
    expect(rgbaOfBytes(46, 48, 54, 255)).toBe("rgba(46, 48, 54, 1)");
    expect(rgbaOfBytes(255, 255, 255, 51)).toBe("rgba(255, 255, 255, 0.2)");
    expect(rgbaOfBytes(0, 0, 0, 0)).toBeNull();
  });

  test("an icon's paint is written rgb with its alpha apart, which AppKit's SVG reader draws", () => {
    expect(svgPaintOf("rgba(190, 196, 210, 0.5)")).toEqual({ color: "rgb(190, 196, 210)", alpha: 0.5 });
    expect(svgPaintOf("rgba(0, 0, 0, 1)")).toEqual({ color: "rgb(0, 0, 0)", alpha: 1 });
    expect(svgPaintOf(null)).toEqual({ color: "none", alpha: 1 });
  });

  test("a rect is taken into its view's coordinates", () => {
    expect(withinView({ x: 70, y: 52, width: 100, height: 20 }, { x: 55, y: 47, width: 710, height: 510 })).toEqual({
      x: 15,
      y: 5,
      width: 100,
      height: 20,
    });
  });

  test("a font family list names its first family, unquoted", () => {
    expect(firstFamily('"IBM Plex Sans", system-ui, sans-serif')).toBe("IBM Plex Sans");
    expect(firstFamily("Menlo")).toBe("Menlo");
  });
});
