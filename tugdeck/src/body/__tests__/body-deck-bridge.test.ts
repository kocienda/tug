/**
 * The deck a body's card sees is synthesized from the shell's `card-context`:
 * its fold, its arrival and the deck's first responder read back through the
 * selectors the card uses, the card's activation fires on a flip to it and
 * only on one, and a verb that belongs to the deck's arrangement does nothing
 * and says so with its inert answer. A card that reads the whole deck reads
 * the shell's arrangement from its context instead — panes, band, workspaces
 * — is told when it moves, and sends the deck calls it makes to the shell;
 * a following card reads the card it follows.
 *
 * @covers tugdeck/src/body/body-deck-bridge.ts
 */
import { describe, expect, test } from "bun:test";
import type { CardAdvice, CardContext } from "@tugproto/bus";
import { cardArrivingOf, cardFoldedOf } from "../../deck-store-selectors";
import { BodyDeckBridge, bodyPaneId } from "../body-deck-bridge";
import type { BodyArrangement } from "../../lib/body-arrangement";
import type { DeckState, TugPaneState } from "../../layout-tree";

const CARD = "c-bridge";

function context(over: Partial<CardContext> = {}): CardContext {
  return {
    folded: false,
    arriving: false,
    firstResponderCardId: null,
    layerShown: true,
    spaceId: null,
    ...over,
  };
}

function bridge(advice: CardAdvice[] = []): BodyDeckBridge {
  return new BodyDeckBridge({
    cardId: CARD,
    componentId: "session",
    advise: (a) => advice.push(a),
    putCardState: () => Promise.resolve(true),
  });
}

function arrangementBridge(advice: CardAdvice[] = []): BodyDeckBridge {
  return new BodyDeckBridge({
    cardId: CARD,
    componentId: "cards",
    deckMode: "arrangement",
    advise: (a) => advice.push(a),
    putCardState: () => Promise.resolve(true),
  });
}

function paneState(id: string, cardIds: string[]): TugPaneState {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 600 },
    cardIds,
    activeCardId: cardIds[0],
    title: "",
    acceptsFamilies: ["standard"],
  };
}

function arrangement(bandWidth: number, spaceName = "Main"): BodyArrangement {
  const panes = [paneState("p-own", [CARD]), paneState("p-a", ["a"]), paneState("p-b", ["b"])];
  const deck: DeckState = {
    cards: panes.flatMap((p) => p.cardIds.map((id) => ({ id, componentId: "session", title: "", closable: true }))),
    panes,
    imposition: { sidebars: {} },
    hasFocus: true,
  };
  return {
    deck,
    spaces: {
      activeSpaceId: "s1",
      spaces: [{ id: "s1", name: spaceName }],
      mountedSpaceIds: ["s1"],
      decks: {},
      liveSessions: { s1: 2 },
      cardCounts: { s1: 3 },
    },
    bandWidth,
    columnRunHeight: 900,
    railRunHeight: 880,
    bindings: {},
    identities: {},
    titles: {},
  };
}

describe("the synthesized deck", () => {
  test("answers fold, arrival and first responder from each card-context in turn", () => {
    const b = bridge();
    expect(b.getSnapshot().panes.map((p) => p.id)).toEqual([bodyPaneId(CARD)]);
    expect(b.getSnapshot().cards.map((c) => c.id)).toEqual([CARD]);

    b.applyContext(context({ arriving: true }));
    expect(cardArrivingOf(b.getSnapshot(), CARD)).toBe(true);
    expect(cardFoldedOf(b.getSnapshot(), CARD)).toBe(false);
    expect(b.getFirstResponderCardId()).toBe(null);
    expect(b.getSnapshot().activePaneId).toBeUndefined();

    b.applyContext(context({ firstResponderCardId: CARD }));
    expect(cardArrivingOf(b.getSnapshot(), CARD)).toBe(false);
    expect(b.getFirstResponderCardId()).toBe(CARD);
    expect(b.getSnapshot().activePaneId).toBe(bodyPaneId(CARD));

    b.applyContext(context({ folded: true, firstResponderCardId: "another" }));
    expect(cardFoldedOf(b.getSnapshot(), CARD)).toBe(true);
    expect(b.getFirstResponderCardId()).toBe("another");
    expect(b.getSnapshot().activePaneId).toBeUndefined();
  });

  test("a context that changes nothing the snapshot carries does not notify", () => {
    const b = bridge();
    let notified = 0;
    b.subscribe(() => {
      notified += 1;
    });
    b.applyContext(context({ folded: true }));
    b.applyContext(context({ folded: true, spaceId: "space-2" }));
    expect(notified).toBe(1);
  });
});

describe("activation", () => {
  test("fires on the flips to and from the card, and only on them", () => {
    const b = bridge();
    const events: string[] = [];
    b.observeCardDidActivate(CARD, () => events.push("activate"));
    b.observeCardDidDeactivate(CARD, () => events.push("deactivate"));

    b.applyContext(context({ firstResponderCardId: "another" }));
    b.applyContext(context({ firstResponderCardId: CARD }));
    b.applyContext(context({ firstResponderCardId: CARD, folded: true }));
    b.applyContext(context({ firstResponderCardId: null }));
    b.applyContext(context({ firstResponderCardId: "another" }));

    expect(events).toEqual(["activate", "deactivate"]);
  });
});

describe("the shell's verbs", () => {
  test("a forwarded verb becomes advice, and an inert one answers inertly", () => {
    const advice: CardAdvice[] = [];
    const b = bridge(advice);
    b.setSheetReservation(CARD, 240);
    b.setOpeningBid(CARD, null);
    b.activateCard(CARD);
    b.removeCard(bodyPaneId(CARD), CARD);
    expect(advice).toEqual([
      { advice: "sheet-reservation", heightPx: 240 },
      { advice: "opening-bid", heightPx: null },
      { advice: "activate" },
      { advice: "close-request" },
    ]);

    expect(b.addCard("session")).toBe(null);
    expect(b.moveInColumn(bodyPaneId(CARD), "up")).toBe(false);
    expect(b.movePaneToSlot(bodyPaneId(CARD), 1)).toEqual({ ok: false });
    expect(b.getSpacesSnapshot().spaces).toEqual([]);
  });
});

describe("an arrangement card", () => {
  test("reads the shell's panes, band and workspaces from its context, its own pane re-keyed", () => {
    const b = arrangementBridge();
    b.applyContext(context({ arrangement: arrangement(1600) }));
    expect(b.getSnapshot().panes.length).toBe(3);
    expect(b.getSnapshot().panes[0].id).toBe(bodyPaneId(CARD));
    expect(b.getBandWidth()).toBe(1600);
    expect(b.getRailRunHeight()).toBe(880);
    expect(b.getSpacesSnapshot().spaces).toEqual([{ id: "s1", name: "Main" }]);
    expect(b.spaceHoldsLiveSessions("s1")).toBe(2);
    expect(b.spaceCardCount("s1")).toBe(3);
    expect(b.getSpaceDeck("s1")).toBe(b.getSnapshot());
  });

  test("a changed arrangement notifies the deck's and the workspaces' listeners; an unchanged one neither", () => {
    const b = arrangementBridge();
    let deckNotes = 0;
    let spaceNotes = 0;
    b.subscribe(() => deckNotes++);
    b.subscribeSpaces(() => spaceNotes++);
    b.applyContext(context({ arrangement: arrangement(1600) }));
    b.applyContext(context({ arrangement: arrangement(1600) }));
    expect([deckNotes, spaceNotes]).toEqual([1, 1]);
    b.applyContext(context({ arrangement: arrangement(1600, "Renamed") }));
    expect([deckNotes, spaceNotes]).toEqual([2, 2]);
    expect(b.getSpacesSnapshot().spaces[0].name).toBe("Renamed");
  });

  test("a deck call goes to the shell as advice", () => {
    const advice: CardAdvice[] = [];
    const b = arrangementBridge(advice);
    b.applyContext(context({ arrangement: arrangement(1600) }));
    b.setFlowOffset(120);
    b.activateSpace("s1");
    expect(advice).toEqual([
      { advice: "deck-call", method: "setFlowOffset", args: [120] },
      { advice: "deck-call", method: "activateSpace", args: ["s1"] },
    ]);
  });

  test("a card-mode bridge sends no deck call and keeps its one-pane deck", () => {
    const advice: CardAdvice[] = [];
    const b = bridge(advice);
    b.applyContext(context({ arrangement: arrangement(1600) }));
    b.setFlowOffset(120);
    expect(advice).toEqual([]);
    expect(b.getSnapshot().panes.map((p) => p.id)).toEqual([bodyPaneId(CARD)]);
    expect(b.getBandWidth()).toBe(null);
  });
});

describe("a following card", () => {
  test("reads the card it follows from its context, and is told when it changes", () => {
    const b = bridge();
    let notes = 0;
    b.subscribe(() => notes++);
    expect(b.getFollowedCardId()).toBe(null);
    b.applyContext(context({ followed: { cardId: "a", binding: null } }));
    expect(b.getFollowedCardId()).toBe("a");
    b.applyContext(context({ followed: { cardId: "a", binding: null } }));
    b.applyContext(context({ followed: { cardId: "b", binding: null } }));
    expect(b.getFollowedCardId()).toBe("b");
    expect(notes).toBe(2);
  });
});

describe("a rail card", () => {
  test("reads the edge it stands pinned to from its context, and is told when it moves or comes loose", () => {
    const b = bridge();
    let notes = 0;
    b.subscribe(() => notes++);
    expect(b.getRailSide()).toBe(null);
    b.applyContext(context({ railSide: "right" }));
    expect(b.getRailSide()).toBe("right");
    b.applyContext(context({ railSide: "right" }));
    b.applyContext(context({ railSide: "left" }));
    b.applyContext(context());
    expect(b.getRailSide()).toBe(null);
    expect(notes).toBe(3);
  });
});

describe("the shell's reads", () => {
  test("a call only the shell answers is recorded once, and nothing else is", () => {
    const b = bridge();
    expect(b.shellReads()).toEqual([]);
    b.setColumnOffset(0, 10);
    b.setColumnOffset(0, 12);
    b.getSnapshot();
    expect(b.shellReads()).toEqual(["setColumnOffset"]);
  });

  test("an arrangement card's band read before its first context is early, not a shell read", () => {
    const b = arrangementBridge();
    expect(b.getBandWidth()).toBe(null);
    expect(b.shellReads()).toEqual([]);
    const card = bridge();
    expect(card.getBandWidth()).toBe(null);
    expect(card.shellReads()).toEqual(["getBandWidth"]);
  });
});
