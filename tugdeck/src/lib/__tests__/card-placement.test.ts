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
  heldForThePaint,
  hiddenSince,
  inReadingOrder,
  namePlans,
  placeCardsOf,
  PlacementPoster,
  samePlacement,
  type BodyPlacement,
  type BodyShownFacts,
  type CardFacts,
  type InFlightPlan,
  type Placement,
} from "../card-placement";
import { CARD_APRON_PX } from "../chrome-placement";

const SHOWN: BodyShownFacts = {
  painted: true,
  active: true,
  arriving: false,
  layerShown: true,
};

const APRON = { top: CARD_APRON_PX, right: CARD_APRON_PX, bottom: CARD_APRON_PX, left: CARD_APRON_PX };

function view(cardId: string, x: number, y: number, over: Partial<BodyPlacement> = {}): BodyPlacement {
  return { cardId, x, y, width: 300, height: 200, visible: true, z: 0, shell: [], insets: APRON, ...over };
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

describe("namePlans", () => {
  const inFlight = new Map<string, InFlightPlan>([["a", { planId: 3, landing: { x: 300, y: 40, width: 300, height: 200 }, arrives: false, lands: true }]]);

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
});
