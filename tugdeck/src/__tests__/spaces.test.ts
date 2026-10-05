/**
 * The pure helpers over the space record ([P01], [P02], List L01).
 *
 * `parkedDeck` is the one with teeth: it is the in-memory twin of the postures
 * `serialize` omits, and the reason a workspace that is switched away from and
 * back comes back the way a relaunch comes back rather than carrying a posture
 * nobody asked to keep. The strip offsets are the exception, and the test
 * below says why: a parked layer is laid out from this record, so its
 * standing is where the reader will find it.
 */

import { describe, test, expect } from "bun:test";
import {
  MAIN_SPACE_NAME,
  activeSpaceTheme,
  duplicatedDeck,
  moveCardBetweenDecks,
  nextSpaceName,
  parkedDeck,
  withFallbackTheme,
  wrapAsMainSpace,
} from "../spaces";
import type { DeckState } from "../layout-tree";
import { registerCard } from "../card-registry";

// `moveCardBetweenDecks` refuses a sidebar pane, and sidebar-ness is the
// registry's fact rather than the record's — so the rail card it refuses over
// has to be registered for the refusal to be reachable at all.
registerCard({
  componentId: "rail-card",
  contentFactory: () => null,
  defaultMeta: { title: "Rail", closable: true },
  layoutRole: "sidebar",
});

const plainDeck: DeckState = {
  cards: [{ id: "c1", componentId: "terminal", title: "T", closable: true }],
  panes: [
    {
      id: "p1",
      position: { x: 0, y: 0 },
      size: { width: 400, height: 300 },
      cardIds: ["c1"],
      activeCardId: "c1",
      title: "",
      acceptsFamilies: ["standard"],
    },
  ],
  activePaneId: "p1",
  imposition: { sidebars: { dashes: { side: "right" } } },
  hasFocus: true,
};

describe("parkedDeck", () => {
  test("strips every posture a parked deck must not carry, and keeps its standing", () => {
    const live: DeckState = {
      ...plainDeck,
      bullseyePaneId: "p1",
      flowOffset: 640,
      columnOffsets: { 1: 173 },
      railOffsets: { right: 88 },
      sheetReservations: { p1: 220 },
      openingBids: { p1: 180 },
      arriving: { p1: true },
    };
    const parked = parkedDeck(live);
    const json = JSON.stringify(parked);
    for (const field of [
      "bullseyePaneId",
      "sheetReservations",
      "openingBids",
      "arriving",
    ]) {
      expect(field in parked).toBe(false);
      expect(json).not.toContain(field);
    }
    // The strip offsets are STANDING, not posture: a parked layer is laid
    // out from this record ([B02] of workspace-switch-cheap), and a flow
    // strip parked at zero would slide to reveal its active card in the
    // first frames after the return — the whole-workspace move the cheap
    // switch exists to remove. Kept, the layer already stands there.
    expect(parked.flowOffset).toBe(640);
    expect(parked.columnOffsets).toEqual({ 1: 173 });
    expect(parked.railOffsets).toEqual({ right: 88 });
    // What the deck IS survives whole — the stripping is of postures, not of
    // the arrangement the user made.
    expect(parked.cards).toEqual(live.cards);
    expect(parked.panes).toEqual(live.panes);
    expect(parked.activePaneId).toBe("p1");
    expect(parked.imposition).toEqual(live.imposition);
  });

  test("re-seeds hasFocus to true, the way deserialize seeds it", () => {
    // What is parked is a placeholder: the live deck's own reading of window
    // focus is re-applied at the moment of return.
    expect(parkedDeck({ ...plainDeck, hasFocus: false }).hasFocus).toBe(true);
  });

  test("returns the deck itself when there is nothing to strip", () => {
    expect(parkedDeck(plainDeck)).toBe(plainDeck);
  });
});

describe("wrapAsMainSpace", () => {
  test("makes one space named Main, active, around the deck given", () => {
    const state = wrapAsMainSpace(plainDeck);
    expect(state.spaces.length).toBe(1);
    expect(state.spaces[0].name).toBe(MAIN_SPACE_NAME);
    expect(state.spaces[0].deck).toBe(plainDeck);
    expect(state.activeSpaceId).toBe(state.spaces[0].id);
    expect(state.spaces[0].focusedCardId).toBeUndefined();
  });

  test("mints a fresh id each time", () => {
    expect(wrapAsMainSpace(plainDeck).activeSpaceId).not.toBe(
      wrapAsMainSpace(plainDeck).activeSpaceId,
    );
  });
});

describe("a space's theme", () => {
  const state = {
    spaces: [
      { id: "s1", name: "Main", deck: plainDeck, theme: "sloop" },
      { id: "s2", name: "Side", deck: plainDeck, theme: "caravel" },
      { id: "s3", name: "Bare", deck: plainDeck },
    ],
    activeSpaceId: "s2",
  };

  // `createSpace` copies this onto the record it makes, which is the whole
  // of how a new workspace comes to wear the theme of the one being left.
  test("the active space's theme is the one a new space inherits", () => {
    expect(activeSpaceTheme(state)).toBe("caravel");
    expect(activeSpaceTheme({ ...state, activeSpaceId: "s1" })).toBe("sloop");
  });

  test("an active space with no theme, or no active space, has none to give", () => {
    expect(activeSpaceTheme({ ...state, activeSpaceId: "s3" })).toBeUndefined();
    expect(activeSpaceTheme({ ...state, activeSpaceId: "gone" })).toBeUndefined();
  });

  test("the fallback fills only the spaces that name no theme", () => {
    const filled = withFallbackTheme(state, "ketch");
    expect(filled.spaces.map((s) => s.theme)).toEqual([
      "sloop",
      "caravel",
      "ketch",
    ]);
    expect(filled.activeSpaceId).toBe("s2");
  });

  test("the state itself comes back when there is nothing to fill", () => {
    expect(withFallbackTheme(state, undefined)).toBe(state);
    const filled = withFallbackTheme(state, "ketch");
    expect(withFallbackTheme(filled, "skiff")).toBe(filled);
  });
});

describe("nextSpaceName", () => {
  test("counts from 1 on an empty list", () => {
    expect(nextSpaceName([])).toBe("Workspace 1");
  });

  test("skips names already taken rather than counting the list", () => {
    // Create three, delete the middle one, create again: the answer is the
    // gap, not four.
    expect(nextSpaceName(["Workspace 1", "Workspace 3"])).toBe("Workspace 2");
    expect(nextSpaceName(["Workspace 1", "Workspace 2"])).toBe("Workspace 3");
  });

  test("ignores names that are not of the pattern", () => {
    expect(nextSpaceName(["Main", "Scratch"])).toBe("Workspace 1");
  });
});

describe("duplicatedDeck ([P06])", () => {
  /**
   * A deck with two sidebar panes on the rail and one content pane holding a
   * Session card and a Text card — the shape a real workspace is in when
   * somebody reaches for Duplicate.
   */
  const source: DeckState = {
    cards: [
      { id: "cards-card", componentId: "cards", title: "Cards", closable: true },
      { id: "arcs-card", componentId: "arcs", title: "Arcs", closable: true },
      { id: "sess", componentId: "session", title: "Session", closable: true },
      { id: "text", componentId: "text", title: "Notes", closable: true },
    ],
    panes: [
      {
        id: "rail-cards",
        position: { x: 0, y: 0 },
        size: { width: 320, height: 800 },
        cardIds: ["cards-card"],
        activeCardId: "cards-card",
        title: "Cards",
        acceptsFamilies: [],
      },
      {
        id: "rail-arcs",
        position: { x: 0, y: 0 },
        size: { width: 280, height: 800 },
        cardIds: ["arcs-card"],
        activeCardId: "arcs-card",
        title: "Arcs",
        acceptsFamilies: [],
      },
      {
        id: "content",
        position: { x: 40, y: 20 },
        size: { width: 700, height: 600 },
        cardIds: ["sess", "text"],
        activeCardId: "text",
        title: "",
        acceptsFamilies: ["standard"],
        slot: 0,
      },
    ],
    activePaneId: "content",
    imposition: {
      kind: "two-up",
      contentWidth: "comfy",
      sidebars: { cards: { side: "right" }, arcs: { side: "right" } },
      rails: { right: { order: ["cards", "arcs"] } },
      columns: { 0: { mode: "split", order: ["content"] } },
    },
    hasFocus: true,
  };

  /** A counter, so the copy's ids are readable rather than random. */
  function counter(): () => string {
    let n = 0;
    return () => `new-${(n += 1)}`;
  }

  test("copies the sidebar panes and none of the content", () => {
    const copy = duplicatedDeck(source, counter());

    expect(copy.panes).toHaveLength(2);
    expect(copy.cards.map((c) => c.componentId)).toEqual(["cards", "arcs"]);
    // The Session card is the whole reason this copies so little: a fresh-id
    // copy of it would mount on the project picker.
    expect(copy.cards.some((c) => c.componentId === "session")).toBe(false);
    expect(copy.cards.some((c) => c.componentId === "text")).toBe(false);
  });

  test("mints a fresh id for every card and pane it copies", () => {
    const copy = duplicatedDeck(source, counter());

    const sourceIds = new Set([
      ...source.cards.map((c) => c.id),
      ...source.panes.map((p) => p.id),
    ]);
    for (const card of copy.cards) expect(sourceIds.has(card.id)).toBe(false);
    for (const pane of copy.panes) expect(sourceIds.has(pane.id)).toBe(false);
    // Each pane's activeCardId names a card that is actually in it.
    for (const pane of copy.panes) {
      expect(pane.cardIds).toContain(pane.activeCardId);
      expect(copy.cards.some((c) => c.id === pane.activeCardId)).toBe(true);
    }
  });

  test("keeps each copied pane's title, geometry and componentId", () => {
    const copy = duplicatedDeck(source, counter());

    const cardsPane = copy.panes.find((p) => p.title === "Cards");
    expect(cardsPane).toBeDefined();
    expect(cardsPane!.size).toEqual({ width: 320, height: 800 });
    const seat = copy.cards.find((c) => c.id === cardsPane!.activeCardId);
    expect(seat!.componentId).toBe("cards");
    expect(seat!.title).toBe("Cards");
  });

  test("drops imposition.columns and keeps the rest", () => {
    const copy = duplicatedDeck(source, counter());

    // `columns` names PANE ids, and every pane id here is freshly minted, so a
    // copied record would name nothing that exists.
    expect(copy.imposition.columns).toBeUndefined();
    expect(copy.imposition.kind).toBe("two-up");
    expect(copy.imposition.contentWidth).toBe("comfy");
    expect(copy.imposition.sidebars).toEqual(source.imposition.sidebars);
    expect(copy.imposition.rails).toEqual(source.imposition.rails);
  });

  test("carries no slot on a copied sidebar pane", () => {
    const slotted: DeckState = {
      ...source,
      panes: source.panes.map((p) =>
        p.id === "rail-cards" ? { ...p, slot: 1 } : p,
      ),
    };
    const copy = duplicatedDeck(slotted, counter());

    for (const pane of copy.panes) expect(pane.slot).toBeUndefined();
  });

  test("falls back to the frontmost copied pane when the active one is content", () => {
    const copy = duplicatedDeck(source, counter());

    // The source's active pane held the Session card, which is not here.
    expect(copy.activePaneId).toBe(copy.panes[copy.panes.length - 1].id);
  });

  test("a deck with no sidebar panes duplicates to an empty deck", () => {
    const contentOnly: DeckState = {
      ...source,
      imposition: { ...source.imposition, sidebars: {} },
    };
    const copy = duplicatedDeck(contentOnly, counter());

    expect(copy.cards).toEqual([]);
    expect(copy.panes).toEqual([]);
    expect(copy.activePaneId).toBeUndefined();
    expect(copy.hasFocus).toBe(true);
  });
});

describe("moveCardBetweenDecks ([B07])", () => {
  /** A pane holding `cardIds`, at a readable position. */
  function pane(
    id: string,
    cardIds: string[],
    extra: Record<string, unknown> = {},
  ) {
    return {
      id,
      position: { x: 30, y: 40 },
      size: { width: 640, height: 480 },
      cardIds,
      activeCardId: cardIds[0],
      title: "",
      acceptsFamilies: ["standard"],
      ...extra,
    };
  }

  /** A source deck: two content panes in a two-up column, `A` in the first. */
  function sourceDeck(): DeckState {
    return {
      cards: [
        { id: "A", componentId: "session", title: "A", closable: true },
        { id: "B", componentId: "text", title: "B", closable: true },
      ],
      panes: [pane("p-a", ["A"], { slot: 0 }), pane("p-b", ["B"], { slot: 0 })],
      activePaneId: "p-a",
      imposition: {
        kind: "two-up",
        sidebars: {},
        columns: {
          0: { mode: "split", order: ["p-a", "p-b"], shares: { "p-a": 0.6, "p-b": 0.4 } },
        },
      },
      hasFocus: true,
    };
  }

  /** An empty destination under `kind`. */
  function destDeck(kind: "one-up" | "two-up"): DeckState {
    return { cards: [], panes: [], imposition: { kind, sidebars: {} }, hasFocus: true };
  }

  test("carries the card and its pane across with every id unchanged", () => {
    const moved = moveCardBetweenDecks(sourceDeck(), destDeck("two-up"), "A");

    expect(moved).not.toBeNull();
    expect(moved!.source.cards.map((c) => c.id)).toEqual(["B"]);
    expect(moved!.source.panes.map((p) => p.id)).toEqual(["p-b"]);
    // The id is the whole claim: a Session card's binding is keyed by it.
    expect(moved!.dest.cards.map((c) => c.id)).toEqual(["A"]);
    expect(moved!.dest.panes.map((p) => p.id)).toEqual(["p-a"]);
    // And the geometry travels with the pane rather than being invented.
    expect(moved!.dest.panes[0].size).toEqual({ width: 640, height: 480 });
  });

  test("drops the pane from the source's column order and shares", () => {
    const moved = moveCardBetweenDecks(sourceDeck(), destDeck("two-up"), "A")!;

    const column = moved.source.imposition.columns![0];
    expect(column.order).toEqual(["p-b"]);
    // A share held for a pane standing in ANOTHER deck would divide this
    // column's run among a member that will never draw in it.
    expect(column.shares).toEqual({ "p-b": 0.4 });
  });

  test("drops the height the pane was given in its old slot", () => {
    const deck = sourceDeck();
    const source: DeckState = {
      ...deck,
      panes: deck.panes.map((p) => (p.id === "p-b" ? { ...p, slotHeight: 300 } : p)),
    };
    for (const kind of ["one-up", "two-up"] as const) {
      const moved = moveCardBetweenDecks(source, destDeck(kind), "B")!;
      // A height in the source's run is not one in the destination's.
      expect("slotHeight" in moved.dest.panes[0]).toBe(false);
    }
  });

  test("clears the source's activePaneId when it named the moved pane", () => {
    const moved = moveCardBetweenDecks(sourceDeck(), destDeck("two-up"), "A")!;

    expect(moved.source.activePaneId).toBeUndefined();
    expect("activePaneId" in moved.source).toBe(false);
  });

  test("leaves the source's activePaneId alone when it named another pane", () => {
    const moved = moveCardBetweenDecks(sourceDeck(), destDeck("two-up"), "B")!;

    expect(moved.source.activePaneId).toBe("p-a");
  });

  test("seats the arrival at the bottom of slot 0 under a multi-slot kind", () => {
    const dest: DeckState = {
      ...destDeck("two-up"),
      cards: [{ id: "S", componentId: "text", title: "Sitter", closable: true }],
      panes: [pane("p-s", ["S"], { slot: 0 })],
      imposition: {
        kind: "two-up",
        sidebars: {},
        columns: { 0: { mode: "split", order: ["p-s"] } },
      },
    };
    const moved = moveCardBetweenDecks(sourceDeck(), dest, "A")!;

    expect(moved.dest.panes.find((p) => p.id === "p-a")!.slot).toBe(0);
    // [D194]: a newcomer lands at the bottom, named in the same commit that
    // seats it, so the fallback never decides where it goes.
    expect(moved.dest.imposition.columns![0].order).toEqual(["p-s", "p-a"]);
  });

  test("drops the slot entirely into a one-up destination", () => {
    const moved = moveCardBetweenDecks(sourceDeck(), destDeck("one-up"), "A")!;

    const arrived = moved.dest.panes[0];
    expect(arrived.slot).toBeUndefined();
    expect("slot" in arrived).toBe(false);
    // With one place there is nothing to seat against, so the stored geometry
    // is what the pane stands on.
    expect(arrived.position).toEqual({ x: 30, y: 40 });
  });

  test("moves a tab stack whole", () => {
    const source: DeckState = {
      ...sourceDeck(),
      cards: [
        { id: "A", componentId: "session", title: "A", closable: true },
        { id: "A2", componentId: "text", title: "A2", closable: true },
      ],
      panes: [pane("p-a", ["A", "A2"], { slot: 0 })],
      imposition: { kind: "two-up", sidebars: {} },
    };
    const moved = moveCardBetweenDecks(source, destDeck("two-up"), "A2")!;

    expect(moved.source.cards).toEqual([]);
    expect(moved.dest.cards.map((c) => c.id)).toEqual(["A", "A2"]);
    expect(moved.dest.panes[0].cardIds).toEqual(["A", "A2"]);
  });

  test("refuses a pane holding a sidebar card", () => {
    const source: DeckState = {
      cards: [{ id: "R", componentId: "rail-card", title: "Rail", closable: true }],
      panes: [pane("p-r", ["R"])],
      imposition: { sidebars: { "rail-card": { side: "right" } } },
      hasFocus: true,
    };

    expect(moveCardBetweenDecks(source, destDeck("two-up"), "R")).toBeNull();
  });

  test("refuses a card no pane holds", () => {
    expect(
      moveCardBetweenDecks(sourceDeck(), destDeck("two-up"), "nobody"),
    ).toBeNull();
  });

  test("drops every session-only record that named the moved pane", () => {
    const source: DeckState = {
      ...sourceDeck(),
      bullseyePaneId: "p-a",
      sheetReservations: { "p-a": 300, "p-b": 100 },
      openingBids: { "p-a": 220 },
      arriving: { "p-a": true },
    };
    const moved = moveCardBetweenDecks(source, destDeck("two-up"), "A")!;

    expect(moved.source.bullseyePaneId).toBeUndefined();
    expect(moved.source.sheetReservations).toEqual({ "p-b": 100 });
    // Emptied records go away rather than standing as `{}` — absence is the
    // one reading of "nothing here".
    expect("openingBids" in moved.source).toBe(false);
    expect("arriving" in moved.source).toBe(false);
    // And none of them follows the pane into the destination.
    expect("arriving" in moved.dest).toBe(false);
  });
});
