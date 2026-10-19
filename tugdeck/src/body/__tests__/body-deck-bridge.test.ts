/**
 * The deck a body's card sees is synthesized from the shell's `card.context`:
 * its fold, its arrival and the deck's first responder read back through the
 * selectors the card uses, the card's activation fires on a flip to it and
 * only on one, and a verb that belongs to the deck's arrangement does nothing
 * and says so with its inert answer. A card that reads the whole deck reads
 * the shell's arrangement instead — panes, band, workspaces — is told when it
 * moves, and the deck calls it makes run on the shell's deck; a following
 * card reads the card it follows. A warm workspace's key card is key while it
 * stands parked, and its first visit does not activate it again.
 *
 * @covers tugdeck/src/body/body-deck-bridge.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cardActivate, cardAddSibling, cardClose } from "../../bus/declarations/verbs";
import type { CardContextValue, CardReservationsValue } from "../../bus/declarations/card";
import {
  deckActivateCard,
  deckActivateSpace,
  deckSetFlowOffset,
  type ArrangementDeckValue,
  type ArrangementSpaces,
} from "../../bus/declarations/arrangement";
import { createTestBus, type TestBus } from "../../bus/test-bus";
import { cardArrivingOf, cardFoldedOf } from "../../deck-store-selectors";
import { BodyDeckBridge, bodyPaneId } from "../body-deck-bridge";
import type { DeckState, TugPaneState } from "../../layout-tree";

const CARD = "c-bridge";

let testBus: TestBus | undefined;
afterEach(() => {
  testBus?.dispose();
  testBus = undefined;
});

function context(over: Partial<CardContextValue> = {}): CardContextValue {
  return {
    folded: false,
    arriving: false,
    firstResponderCardId: null,
    layerShown: true,
    spaceId: null,
    ...over,
  };
}

function bridge(reserved: CardReservationsValue[] = []): BodyDeckBridge {
  return new BodyDeckBridge({
    cardId: CARD,
    componentId: "session",
    reserve: (r) => reserved.push(r),
    putCardState: () => Promise.resolve(true),
  });
}

function arrangementBridge(): BodyDeckBridge {
  return new BodyDeckBridge({
    cardId: CARD,
    componentId: "cards",
    deckMode: "arrangement",
    putCardState: () => Promise.resolve(true),
  });
}

/**
 * A shell and this card's body page on the test bus, the body's installed as
 * this page's, and the deck calls the shell runs, in order.
 */
async function bodyPage(componentId: string): Promise<{ shellCalls: Array<[string, unknown]> }> {
  testBus = createTestBus();
  const shell = testBus.shell();
  const shellCalls: Array<[string, unknown]> = [];
  deckSetFlowOffset.on(shell.bus).handle((p) => shellCalls.push(["setFlowOffset", p]));
  deckActivateSpace.on(shell.bus).handle((p) => shellCalls.push(["activateSpace", p]));
  deckActivateCard.on(shell.bus).handle((p) => shellCalls.push(["activateCard", p]));
  cardActivate.on(shell.bus).handle((_p, from) => shellCalls.push(["card.activate", from.cardId]));
  cardClose.on(shell.bus).handle((_p, from) => shellCalls.push(["card.close", from.cardId]));
  cardAddSibling.on(shell.bus).handle((p, from) => shellCalls.push(["card.addSibling", { ...p, from: from.cardId }]));
  testBus.install(testBus.body(CARD, componentId));
  await testBus.flush();
  return { shellCalls };
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

function arrangement(bandWidth: number, spaceName = "Main"): { value: ArrangementDeckValue; spaces: ArrangementSpaces } {
  const panes = [paneState("p-own", [CARD]), paneState("p-a", ["a"]), paneState("p-b", ["b"])];
  const deck: DeckState = {
    cards: panes.flatMap((p) => p.cardIds.map((id) => ({ id, componentId: "session", title: "", closable: true }))),
    panes,
    imposition: { sidebars: {} },
    hasFocus: true,
  };
  return {
    value: { deck, bandWidth, columnRunHeight: 900, railRunHeight: 880 },
    spaces: {
      activeSpaceId: "s1",
      spaces: [{ id: "s1", name: spaceName }],
      mountedSpaceIds: ["s1"],
      decks: {},
      liveSessions: { s1: 2 },
      cardCounts: { s1: 3 },
    },
  };
}

describe("the synthesized deck", () => {
  test("answers fold, arrival and first responder from each card.context in turn", () => {
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

  test("a warm workspace's key card activates while parked, and its first visit does not activate it again", () => {
    const b = bridge();
    const events: string[] = [];
    b.observeCardDidActivate(CARD, () => events.push("activate"));
    b.observeCardDidDeactivate(CARD, () => events.push("deactivate"));

    b.applyContext(context({ firstResponderCardId: "shown", layerShown: false, spaceId: "two", parkedKey: true }));
    expect(b.isParkedKey(CARD)).toBe(true);
    expect(b.getFirstResponderCardId()).toBe("shown");
    b.applyContext(context({ firstResponderCardId: CARD, spaceId: "two" }));
    expect(b.isParkedKey(CARD)).toBe(false);
    b.applyContext(context({ firstResponderCardId: "another", spaceId: "two" }));

    expect(events).toEqual(["activate", "deactivate"]);
  });

  test("a parked key card's bag focus waits for its first visit to name it first responder", () => {
    const b = bridge();
    let peeked = 0;
    const peek = b.peekCardHostRoot;
    b.peekCardHostRoot = (cardId: string) => {
      peeked += 1;
      return peek(cardId);
    };
    b.applyContext(context({ firstResponderCardId: "shown", layerShown: false, spaceId: "two", parkedKey: true }));
    expect(peeked).toBe(0);
    b.applyContext(context({ firstResponderCardId: CARD, spaceId: "two" }));
    expect(peeked).toBeGreaterThan(0);
  });

  test("a picker that subscribes after its parked key context came is told it is active", () => {
    const b = bridge();
    b.applyContext(context({ firstResponderCardId: "shown", layerShown: false, spaceId: "two", parkedKey: true }));
    const events: string[] = [];
    b.observeCardDidActivate(CARD, () => events.push("activate"));
    expect(events).toEqual(["activate"]);
  });
});

describe("the shell's verbs", () => {
  test("a forwarded verb is the shell's, a reservation the card's whole reservations, and an inert one answers inertly", async () => {
    const { shellCalls } = await bodyPage("session");
    const reserved: CardReservationsValue[] = [];
    const b = bridge(reserved);
    b.setSheetReservation(CARD, 240);
    b.setOpeningBid(CARD, 120);
    b.setSheetReservation(CARD, null);
    b.activateCard(CARD);
    b.removeCard(bodyPaneId(CARD), CARD);
    expect(b.addCardToPane(bodyPaneId(CARD), "spike-run-display")).toBe(null);
    expect(reserved).toEqual([
      { sheetPx: 240, openingBidPx: null },
      { sheetPx: 240, openingBidPx: 120 },
      { sheetPx: null, openingBidPx: 120 },
    ]);
    await testBus!.flush();
    expect(shellCalls).toEqual([
      ["card.activate", CARD],
      ["card.close", CARD],
      ["card.addSibling", { componentId: "spike-run-display", from: CARD }],
    ]);

    expect(b.addCard("session")).toBe(null);
    expect(b.moveInColumn(bodyPaneId(CARD), "up")).toBe(false);
    expect(b.movePaneToSlot(bodyPaneId(CARD), 1)).toEqual({ ok: false });
    expect(b.getSpacesSnapshot().spaces).toEqual([]);
  });
});

describe("an arrangement card", () => {
  test("reads the shell's panes, band and workspaces, its own pane re-keyed", () => {
    const b = arrangementBridge();
    const a = arrangement(1600);
    b.applyArrangement(a.value, a.spaces);
    expect(b.getSnapshot().panes.length).toBe(3);
    expect(b.getSnapshot().panes[0].id).toBe(bodyPaneId(CARD));
    expect(b.getBandWidth()).toBe(1600);
    expect(b.getRailRunHeight()).toBe(880);
    expect(b.getSpacesSnapshot().spaces).toEqual([{ id: "s1", name: "Main" }]);
    expect(b.spaceHoldsLiveSessions("s1")).toBe(2);
    expect(b.spaceCardCount("s1")).toBe(3);
    expect(b.getSpaceDeck("s1")).toBe(b.getSnapshot());
  });

  test("names the workspace each listed card stands in, a parked one's included", () => {
    const b = arrangementBridge();
    const listed = arrangement(1600);
    const parkedPane = paneState("p-away", ["parked"]);
    listed.spaces.spaces.push({ id: "s2", name: "Away" });
    listed.spaces.decks.s2 = {
      cards: [{ id: "parked", componentId: "session", title: "", closable: true }],
      panes: [parkedPane],
      imposition: { sidebars: {} },
      hasFocus: false,
    };
    b.applyContext(context({ spaceId: "s1" }));
    b.applyArrangement(listed.value, listed.spaces);
    expect(b.spaceOf(CARD)).toBe("s1");
    expect(b.spaceOf("a")).toBe("s1");
    // What lets `cardIdentity` reach a parked Session card's ledger row.
    expect(b.spaceOf("parked")).toBe("s2");
    expect(b.spaceOf("nowhere")).toBeNull();
  });

  test("a changed arrangement notifies the deck's and the workspaces' listeners; an unchanged one neither", () => {
    const b = arrangementBridge();
    let deckNotes = 0;
    let spaceNotes = 0;
    b.subscribe(() => deckNotes++);
    b.subscribeSpaces(() => spaceNotes++);
    const a = arrangement(1600);
    b.applyArrangement(a.value, a.spaces);
    b.applyArrangement(a.value, a.spaces);
    expect([deckNotes, spaceNotes]).toEqual([1, 1]);
    const renamed = arrangement(1600, "Renamed").spaces;
    b.applyArrangement(a.value, renamed);
    expect([deckNotes, spaceNotes]).toEqual([2, 2]);
    expect(b.getSpacesSnapshot().spaces[0].name).toBe("Renamed");
    // A band that moved re-synthesizes the deck and leaves the workspaces be.
    b.applyArrangement({ ...a.value, bandWidth: 1200 }, renamed);
    expect([deckNotes, spaceNotes]).toEqual([3, 2]);
    expect(b.getBandWidth()).toBe(1200);
  });

  test("a deck call runs on the shell's deck", async () => {
    const { shellCalls } = await bodyPage("cards");
    const b = arrangementBridge();
    const a = arrangement(1600);
    b.applyArrangement(a.value, a.spaces);
    b.setFlowOffset(120);
    b.activateSpace("s1");
    await testBus!.flush();
    expect(shellCalls).toEqual([
      ["setFlowOffset", { offset: 120 }],
      ["activateSpace", { spaceId: "s1" }],
    ]);
  });

  test("raising another card names it to the shell; activating itself is its own card's", async () => {
    const { shellCalls } = await bodyPage("cards");
    const b = arrangementBridge();
    const a = arrangement(1600);
    b.applyArrangement(a.value, a.spaces);
    b.activateCard("other");
    b.activateCard(CARD);
    await testBus!.flush();
    expect(shellCalls).toEqual([
      ["activateCard", { cardId: "other" }],
      ["card.activate", CARD],
    ]);
  });

  test("a card-mode bridge sends no deck call and keeps its one-pane deck", async () => {
    const { shellCalls } = await bodyPage("session");
    const b = bridge();
    const a = arrangement(1600);
    b.applyArrangement(a.value, a.spaces);
    b.setFlowOffset(120);
    await testBus!.flush();
    expect(shellCalls).toEqual([]);
    expect(b.getSnapshot().panes.map((p) => p.id)).toEqual([bodyPaneId(CARD)]);
    expect(b.getBandWidth()).toBe(null);
  });
});

describe("a following card", () => {
  test("reads the card it follows, and is told when it changes", () => {
    const b = bridge();
    let notes = 0;
    b.subscribe(() => notes++);
    expect(b.getFollowedCardId()).toBe(null);
    b.applyFollowed("a");
    expect(b.getFollowedCardId()).toBe("a");
    b.applyFollowed("a");
    b.applyFollowed("b");
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
