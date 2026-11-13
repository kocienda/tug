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
  LANDING_GUARD_MS,
  landDrifts,
  landingHorizonMs,
  meetsAPicture,
  namePlans,
  placeCardsOf,
  PlacementPoster,
  samePlacement,
  shownFactsOf,
  stagedOf,
  wantsPicture,
  type BodyPlacement,
  type BodyShownFacts,
  type CardFacts,
  type InFlightPlan,
  type Placement,
} from "../card-placement";
import { CARD_APRON_PX } from "../chrome-placement";
import { SOLVE_GUARD_MS } from "../card-plan";

const SHOWN: BodyShownFacts = {
  painted: true,
  active: true,
  arriving: false,
  layerShown: true,
};

const APRON = { top: CARD_APRON_PX, right: CARD_APRON_PX, bottom: CARD_APRON_PX, left: CARD_APRON_PX };

function view(cardId: string, x: number, y: number, over: Partial<BodyPlacement> = {}): BodyPlacement {
  return { cardId, x, y, width: 300, height: 200, visible: true, z: 0, shell: [], insets: APRON, spaceId: "s1", staged: true, title: cardId, kind: "text", ...over };
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

describe("wantsPicture", () => {
  const UNPAINTED: BodyShownFacts = { ...SHOWN, painted: false };

  test("a card hidden only for want of its first paint stands as the host's picture", () => {
    expect(wantsPicture(UNPAINTED, false)).toBe(true);
  });

  const cases: Array<[string, Partial<BodyShownFacts>]> = [
    ["an inactive tab", { active: false }],
    ["arriving", { arriving: true }],
    ["in a parked workspace", { layerShown: false }],
  ];
  for (const [name, over] of cases) {
    test(`${name} wants none`, () => {
      expect(wantsPicture({ ...UNPAINTED, ...over }, false)).toBe(false);
    });
  }

  test("a card placed visible, or in no pane, wants none", () => {
    expect(wantsPicture(SHOWN, true)).toBe(false);
    expect(wantsPicture(null, false)).toBe(false);
  });

  test("a placement that changes only whether the host pictures a card is not news: the host derives it", () => {
    const plain: Placement = { bodies: [view("a", 0, 40, { visible: false })] };
    const pictured: Placement = { bodies: [view("a", 0, 40, { visible: false, pictured: true })] };
    expect(samePlacement(plain, pictured)).toBe(true);
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
    spaces: [
      { id: "s1", theme: "ironclad", focusedCardId: "a" },
      { id: "s2", theme: null, focusedCardId: null },
    ],
    activeSpaceId: "s1",
  };

  test("carries each card's pane, its view and insets, the shell's controls over it, its stage facts, and its stand-in's facts", () => {
    const seam = { x: 300, y: 40, width: 8, height: 200 };
    const cards = placeCardsOf({ bodies: [view("a", 0, 40, { z: 3, shell: [seam], insets: { ...APRON, right: 10.5 } })] }, facts);
    expect(cards.apron).toBe(CARD_APRON_PX);
    expect(cards.canvas).toEqual(facts.canvas);
    expect(cards.zoom).toBe(1.25);
    expect(cards.spaces).toEqual(facts.spaces);
    expect(cards.activeSpaceId).toBe("s1");
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
        spaceId: "s1",
        staged: true,
        title: "a",
        kind: "text",
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

  test("a parked workspace's card carries its workspace, its title and kind, and its fold, hidden but staged", () => {
    const parked = view("p", 0, 40, { visible: false, spaceId: "s2", title: "Notes", kind: "text", folded: true });
    const card = placeCardsOf({ bodies: [parked] }, facts).cards[0];
    expect([card.spaceId, card.staged, card.visible, card.title, card.kind, card.folded]).toEqual(["s2", true, false, "Notes", "text", true]);
  });

  test("a placement that changes only a card's stage facts is news", () => {
    const a: Placement = { bodies: [view("a", 0, 40)] };
    const changes: Partial<BodyPlacement>[] = [{ spaceId: "s2" }, { staged: false }, { title: "Renamed" }, { kind: "session" }, { folded: true }];
    for (const over of changes) {
      expect(samePlacement(a, { bodies: [view("a", 0, 40, over)] })).toBe(false);
    }
    expect(samePlacement(a, { bodies: [view("a", 0, 40)] })).toBe(true);
  });

  describe("a parked workspace's cards", () => {
    afterEach(() => bodyCardsStore._reset());

    /** The shown deck holds `a`; the parked workspace `two`'s pane holds `b` (active) and `c`. */
    const parkedDeck = {
      panes: [{ id: "p2", cardIds: ["b", "c"], activeCardId: "b" }],
      cards: [
        { id: "b", componentId: "text", title: "B" },
        { id: "c", componentId: "text", title: "C" },
      ],
      arriving: {},
    };
    const deck = {
      getSnapshot: () => ({ panes: [{ id: "p1", cardIds: ["a"], activeCardId: "a" }], cards: [{ id: "a", componentId: "text" }], arriving: {} }),
      spaceOf: (cardId: string) => (cardId === "a" ? "one" : "two"),
      getSpacesSnapshot: () => ({ activeSpaceId: "one", mountedDecks: new Map([["two", parkedDeck]]) }),
    } as unknown as IDeckManagerStore;

    test("are read in their own workspace's deck: the pane's active card is active, in a layer not shown", () => {
      expect(shownFactsOf(deck, "b")).toEqual({ painted: false, active: true, arriving: false, layerShown: false });
      expect(shownFactsOf(deck, "c")?.active).toBe(false);
    });

    test("a parked active card is staged and not visible; its sibling is not staged", () => {
      for (const cardId of ["b", "c"]) {
        bodyCardsStore.mark(cardId);
        bodyCardsStore.setState(cardId, "painted");
      }
      const b = shownFactsOf(deck, "b");
      const c = shownFactsOf(deck, "c");
      expect([bodyVisible(b!), stagedOf(b)]).toEqual([false, true]);
      expect([bodyVisible(c!), stagedOf(c)]).toEqual([false, false]);
      expect(stagedOf(null)).toBe(false);
    });

    test("a card whose page has not painted is staged: its picture is the host's to stand", () => {
      bodyCardsStore.mark("b");
      bodyCardsStore.setState("b", "creating");
      const b = shownFactsOf(deck, "b");
      expect(b?.painted).toBe(false);
      expect(stagedOf(b)).toBe(true);
    });
  });

  test("a card a plan is carrying names its plan; one no plan carries names none", () => {
    const carried = placeCardsOf({ bodies: [view("a", 0, 40, { planId: 7 })] }, facts).cards[0];
    expect(carried.planId).toBe(7);
    const rest = placeCardsOf({ bodies: [view("a", 0, 40)] }, facts).cards[0];
    expect("planId" in rest).toBe(false);
  });

  test("whether the host pictures a card is the shell's own, never posted", () => {
    const card = placeCardsOf({ bodies: [view("a", 0, 40, { visible: false, pictured: true })] }, facts).cards[0];
    expect(Object.keys(card).filter((k) => ["pictured", "face", "faceDraw", "parked"].includes(k))).toEqual([]);
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

  test("a view over a card the host pictures is not held: the host takes it down as the picture stands", () => {
    const last = { bodies: [view("home", 40, 40), view("w1", 60, 60, { visible: false })] };
    const next = { bodies: [view("home", 40, 40, { visible: false }), view("w1", 60, 60, { visible: false, pictured: true })] };
    expect(heldForThePaint(last, next)).toBeNull();
  });

  test("a view over no picture keeps its paint, beside one taken down", () => {
    const last = { bodies: [view("over", 0, 0), view("clear", 1000, 0)] };
    const next = {
      bodies: [
        view("over", 0, 0, { visible: false }),
        view("clear", 1000, 0, { visible: false }),
        view("w1", 100, 100, { visible: false, pictured: true }),
      ],
    };
    const hold = heldForThePaint(last, next);
    expect(hold?.held.bodies.filter((b) => b.visible).map((b) => b.cardId)).toEqual(["clear"]);
    expect(hold?.releasing.bodies.find((b) => b.cardId === "over")?.visible).toBe(false);
  });

  test("a tab put behind a card that cannot show yet is taken down, not held", () => {
    const last = { bodies: [view("a", 0, 0), view("b", 0, 0, { visible: false })] };
    const next = { bodies: [view("a", 0, 0, { visible: false }), view("b", 0, 0, { visible: false, pictured: true })] };
    expect(meetsAPicture(last.bodies[0], next)).toBe(true);
    expect(heldForThePaint(last, next)).toBeNull();
  });
});

describe("meetsAPicture", () => {
  test("a view sharing area with a pictured card meets it", () => {
    expect(meetsAPicture(view("a", 0, 0), { bodies: [view("f", 299, 199, { visible: false, pictured: true })] })).toBe(true);
  });

  test("an edge in common, a card not pictured, and the card itself do not", () => {
    expect(meetsAPicture(view("a", 0, 0), { bodies: [view("f", 300, 0, { visible: false, pictured: true })] })).toBe(false);
    expect(meetsAPicture(view("a", 0, 0), { bodies: [view("f", 10, 10, { visible: false })] })).toBe(false);
    expect(meetsAPicture(view("a", 0, 0), { bodies: [view("a", 0, 0, { visible: false, pictured: true })] })).toBe(false);
  });
});
