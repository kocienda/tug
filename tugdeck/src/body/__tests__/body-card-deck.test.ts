/**
 * The deck a body's card sees is a real object: every member acts.
 *
 * The evidence tables hold that by type. `CARD_DECK_EVIDENCE` has one entry
 * per `CardDeck` member and `DECK_VIEW_EVIDENCE` one per member a `DeckView`
 * adds, so a member with no entry fails `tsc`. Each entry calls its member
 * and asserts one of three things: an envelope left the page and the shell
 * heard it; the page's own state moved (a listener fired, a bag stored, a
 * registry entry made); or a read returned the replica's value.
 *
 * Beside them, the behaviours the deck is built for: the synthesized
 * one-pane deck answers fold, arrival and first responder from each
 * `card.context`; the card's activation fires on a flip to it and only on
 * one; a card
 * added takes the id the page minted; an arrangement card reads the shell's
 * panes, band and workspaces and is told when they move; a following card
 * reads the card it follows; and a rail card the edge it is pinned to.
 *
 * @covers tugdeck/src/body/body-card-deck.ts
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { installJsdom } from "../../__tests__/jsdom-deck";
import { cardActivate, cardAddSibling, cardClose } from "../../bus/declarations/verbs";
import type { CardContextValue, CardReservationsValue } from "../../bus/declarations/card";
import {
  deckActivateCard,
  deckActivateSpace,
  deckAddCard,
  deckChooseSpaceTheme,
  deckInterruptLiveSessions,
  deckMoveCardToSpace,
  deckPreviewFlowOffset,
  deckRenameSpace,
  deckReorderSpaces,
  deckSetFlowOffset,
  deckShowSingletonCard,
  type ArrangementDeckValue,
  type ArrangementSpaces,
} from "../../bus/declarations/arrangement";
import { paneRevealCard, paneRevealForQuestion } from "../../bus/declarations/pane";
import { createTestBus, type TestBus } from "../../bus/test-bus";
import type { CardDeck, DeckView } from "../../card-deck";
import { cardArrivingOf, cardFoldedOf } from "../../deck-store-selectors";
import type { CardStateBag, DeckState, TugPaneState } from "../../layout-tree";
import { bodyPaneId, createBodyCardDeck, createDeckView, type ArrangementReplicas, type BodyCardDeck } from "../body-card-deck";

const substrate = installJsdom();
afterAll(() => substrate.restore());

const CARD = "c-body-deck";
const BAG: CardStateBag = { content: { probe: 1 } } as CardStateBag;

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
    geometry: { moves: 0, resizes: 0 },
    ...over,
  };
}

/** What a member's evidence reads: what the shell heard, and what the page wrote. */
interface Probe {
  deck: BodyCardDeck;
  /** Each envelope the shell heard, in order, with the card that sent it. */
  shellHeard: Array<[string, unknown]>;
  /** Each `card.reservations` value the page set. */
  reserved: CardReservationsValue[];
  /** Each bag the page wrote durably. */
  puts: Array<[string, CardStateBag]>;
  flush(): Promise<void>;
}

/**
 * A shell and this card's body page on the test bus, the body's installed as
 * this page's bus, and a card deck on it. The shell records every verb a
 * card deck or a deck view sends, and answers the interrupt request.
 */
async function bodyPage(componentId = "session"): Promise<Probe> {
  testBus = createTestBus();
  const shell = testBus.shell();
  const shellHeard: Array<[string, unknown]> = [];
  const hear = (name: string) => (payload: unknown) => shellHeard.push([name, payload]);
  cardActivate.on(shell.bus).handle(hear("card.activate"));
  cardClose.on(shell.bus).handle(hear("card.close"));
  cardAddSibling.on(shell.bus).handle(hear("card.addSibling"));
  deckAddCard.on(shell.bus).handle(hear("deck.addCard"));
  deckShowSingletonCard.on(shell.bus).handle(hear("deck.showSingletonCard"));
  paneRevealCard.on(shell.bus).handle(hear("pane.revealCard"));
  deckActivateCard.on(shell.bus).handle(hear("deck.activateCard"));
  deckSetFlowOffset.on(shell.bus).handle(hear("deck.setFlowOffset"));
  deckPreviewFlowOffset.on(shell.bus).handle(hear("deck.previewFlowOffset"));
  deckActivateSpace.on(shell.bus).handle(hear("deck.activateSpace"));
  deckRenameSpace.on(shell.bus).handle(hear("deck.renameSpace"));
  deckChooseSpaceTheme.on(shell.bus).handle(hear("deck.chooseSpaceTheme"));
  deckReorderSpaces.on(shell.bus).handle(hear("deck.reorderSpaces"));
  deckMoveCardToSpace.on(shell.bus).handle(hear("deck.moveCardToSpace"));
  deckInterruptLiveSessions.on(shell.bus).handle(() => ({ interrupted: ["s-live"], unacknowledged: ["s-stuck"] }));
  paneRevealForQuestion.on(shell.bus).handle((payload) => {
    hear("pane.revealForQuestion")(payload);
    return { travelMs: 240 };
  });
  testBus.install(testBus.body(CARD, componentId));
  await testBus.flush();
  const reserved: CardReservationsValue[] = [];
  const puts: Array<[string, CardStateBag]> = [];
  const deck = createBodyCardDeck({
    cardId: CARD,
    componentId,
    reserve: (r) => reserved.push(r),
    putCardState: (cardId, bag) => {
      puts.push([cardId, bag]);
      return Promise.resolve(true);
    },
    initialBag: BAG,
  });
  const bus = testBus;
  return { deck, shellHeard, reserved, puts, flush: () => bus.flush() };
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

/** A replica the test sets, as a page's replica of a shell store is set by the bus. */
function replica<T>(initial: T): { getSnapshot: () => T; subscribe: (l: () => void) => () => void; set: (v: T) => void } {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set: (v) => {
      value = v;
      for (const l of [...listeners]) l();
    },
  };
}

function arrangementReplicas(band = 1600): ArrangementReplicas & {
  deck: ReturnType<typeof replica<ArrangementDeckValue | null>>;
  spaces: ReturnType<typeof replica<ArrangementSpaces>>;
} {
  const a = arrangement(band);
  return { deck: replica<ArrangementDeckValue | null>(a.value), spaces: replica(a.spaces) };
}

/** Counts a listener's calls. */
function counter(): { fn: () => void; readonly n: number } {
  let n = 0;
  return {
    fn: () => {
      n += 1;
    },
    get n() {
      return n;
    },
  };
}

type Evidence<T> = (deck: T, probe: Probe) => void | Promise<void>;

/** One entry per `CardDeck` member: without one, this does not type-check. */
const CARD_DECK_EVIDENCE: { [K in keyof CardDeck]-?: Evidence<CardDeck> } = {
  subscribe: (d, { deck }) => {
    const c = counter();
    d.subscribe(c.fn);
    deck.applyContext(context({ folded: true }));
    expect(c.n).toBe(1);
  },
  subscribeSync: (d, { deck }) => {
    const c = counter();
    d.subscribeSync!(c.fn);
    deck.applyContext(context({ folded: true }));
    expect(c.n).toBe(1);
  },
  flushPendingNotify: (d, { deck }) => {
    // A body's deck tells its subscribers on the commit's own task, so by the
    // flush the subscriber has heard, and the flush tells it nothing twice.
    const c = counter();
    d.subscribe(c.fn);
    deck.applyContext(context({ folded: true }));
    d.flushPendingNotify!();
    expect(c.n).toBe(1);
  },
  holdNotifyPastMotion: (d, { deck }) => {
    // Told on the commit's own task, so a hold voted after it changes nothing.
    const c = counter();
    d.subscribe(c.fn);
    deck.applyContext(context({ folded: true }));
    d.holdNotifyPastMotion!();
    expect(c.n).toBe(1);
  },
  getSnapshot: (d, { deck }) => {
    deck.applyContext(context({ folded: true, arriving: true }));
    expect(cardFoldedOf(d.getSnapshot(), CARD)).toBe(true);
    expect(cardArrivingOf(d.getSnapshot(), CARD)).toBe(true);
  },
  getPicture: (d, { deck }) => {
    deck.applyContext(context({ folded: true }));
    expect(d.getPicture()).toBe(d.getSnapshot());
  },
  getVersion: (d, { deck }) => {
    const before = d.getVersion();
    deck.applyContext(context({ folded: true }));
    expect(d.getVersion()).toBe(before + 1);
  },
  setSheetReservation: (d, { reserved }) => {
    d.setSheetReservation(CARD, 240);
    expect(reserved).toEqual([{ sheetPx: 240, openingBidPx: null }]);
  },
  setOpeningBid: (d, { reserved }) => {
    d.setOpeningBid(CARD, 120);
    expect(reserved).toEqual([{ sheetPx: null, openingBidPx: 120 }]);
  },
  handlePaneClosed: async (d, { shellHeard, flush }) => {
    d.handlePaneClosed(bodyPaneId(CARD));
    await flush();
    expect(shellHeard).toEqual([["card.close", {}]]);
  },
  focusCard: async (d, { shellHeard, flush }) => {
    d.focusCard(CARD);
    await flush();
    expect(shellHeard).toEqual([["card.activate", {}]]);
  },
  activateCard: async (d, { shellHeard, flush }) => {
    d.activateCard(CARD, { reveal: false });
    await flush();
    expect(shellHeard).toEqual([["card.activate", { reveal: false }]]);
  },
  revealCard: async (d, { shellHeard, flush }) => {
    d.revealCard(CARD);
    await flush();
    expect(shellHeard).toEqual([["pane.revealCard", { cardId: CARD }]]);
  },
  revealForQuestion: async (d, { shellHeard, flush }) => {
    const travel = d.revealForQuestion!(CARD);
    await flush();
    expect(await travel).toBe(240);
    expect(shellHeard).toEqual([["pane.revealForQuestion", { cardId: CARD }]]);
  },
  getFirstResponderCardId: (d, { deck }) => {
    deck.applyContext(context({ firstResponderCardId: "another" }));
    expect(d.getFirstResponderCardId()).toBe("another");
  },
  getFollowedCardId: (d, { deck }) => {
    deck.applyFollowed("followed");
    expect(d.getFollowedCardId!()).toBe("followed");
  },
  observeCardDidFinishConstruction: (d, { deck }) => {
    const c = counter();
    d.observeCardDidFinishConstruction(CARD, c.fn);
    deck.cardLifecycle.notifyCardDidFinishConstruction(CARD);
    expect(c.n).toBe(1);
  },
  observeCardDidActivate: (d, { deck }) => {
    const c = counter();
    d.observeCardDidActivate(CARD, c.fn);
    deck.applyContext(context({ firstResponderCardId: CARD }));
    expect(c.n).toBe(1);
  },
  observeCardDidDeactivate: (d, { deck }) => {
    const c = counter();
    d.observeCardDidDeactivate(CARD, c.fn);
    deck.applyContext(context({ firstResponderCardId: CARD }));
    deck.applyContext(context({ firstResponderCardId: "another" }));
    expect(c.n).toBe(1);
  },
  observeCardWillBeginDestruction: (d, { deck }) => {
    const c = counter();
    d.observeCardWillBeginDestruction(CARD, c.fn);
    deck.cardLifecycle.notifyCardWillBeginDestruction(CARD);
    expect(c.n).toBe(1);
  },
  observeCardDidMove: (d, { deck }) => {
    const c = counter();
    d.observeCardDidMove(CARD, c.fn);
    deck.applyContext(context());
    deck.applyContext(context({ geometry: { moves: 1, resizes: 0 } }));
    expect(c.n).toBe(1);
  },
  observeCardDidResize: (d, { deck }) => {
    const c = counter();
    d.observeCardDidResize(CARD, c.fn);
    deck.applyContext(context());
    deck.applyContext(context({ geometry: { moves: 0, resizes: 1 } }));
    expect(c.n).toBe(1);
  },
  addCard: async (d, { shellHeard, flush }) => {
    const id = d.addCard("text", { path: "/tmp/a.txt" }, { origin: CARD });
    await flush();
    expect(typeof id).toBe("string");
    expect(shellHeard).toEqual([
      ["deck.addCard", { cardId: id, componentId: "text", initialContent: { path: "/tmp/a.txt" }, origin: CARD }],
    ]);
  },
  showSingletonCard: async (d, { shellHeard, flush }) => {
    d.showSingletonCard("settings");
    await flush();
    expect(shellHeard).toEqual([["deck.showSingletonCard", { componentId: "settings" }]]);
  },
  addCardToPane: async (d, { shellHeard, flush }) => {
    d.addCardToPane(bodyPaneId(CARD), "spike-run-display");
    await flush();
    expect(shellHeard).toEqual([["card.addSibling", { componentId: "spike-run-display" }]]);
  },
  removeCard: async (d, { shellHeard, flush }) => {
    d.removeCard(bodyPaneId(CARD), CARD);
    await flush();
    expect(shellHeard).toEqual([["card.close", {}]]);
  },
  getCardState: (d) => {
    expect(d.getCardState(CARD)).toBe(BAG);
  },
  setCardState: (d) => {
    const next = { content: { probe: 2 } } as CardStateBag;
    d.setCardState(CARD, next);
    expect(d.getCardState(CARD)).toBe(next);
  },
  flushCardStateNow: async (d, { puts }) => {
    const captured = { content: { probe: 3 } } as CardStateBag;
    d.registerCardAssembler(CARD, { capture: () => captured });
    d.flushCardStateNow!(CARD);
    await Promise.resolve();
    expect(puts.map(([id, bag]) => [id, bag.content])).toEqual([[CARD, { probe: 3 }]]);
  },
  suspendCardStateSaves: async (d, { puts }) => {
    // While the gate holds, a durable write waits; the bag stays dirty.
    const resume = d.suspendCardStateSaves!();
    d.registerCardAssembler(CARD, { capture: () => ({ content: { probe: 4 } }) as CardStateBag });
    d.flushCardStateNow!(CARD);
    await Promise.resolve();
    expect(puts).toEqual([]);
    resume();
  },
  spaceOf: (d, { deck }) => {
    deck.applyContext(context({ spaceId: "s-own" }));
    expect(d.spaceOf(CARD)).toBe("s-own");
  },
  registerSaveCallback: (d) => {
    const c = counter();
    d.registerSaveCallback(CARD, c.fn);
    d.invokeSaveCallback(CARD, "manual");
    expect(c.n).toBe(1);
  },
  unregisterSaveCallback: (d) => {
    const c = counter();
    d.registerSaveCallback(CARD, c.fn);
    d.unregisterSaveCallback(CARD);
    d.invokeSaveCallback(CARD, "manual");
    expect(c.n).toBe(0);
  },
  invokeSaveCallback: (d) => {
    const sources: unknown[] = [];
    d.registerSaveCallback(CARD, (source) => sources.push(source));
    d.invokeSaveCallback(CARD, "manual");
    expect(sources).toEqual(["manual"]);
  },
  getComponentStatePreservationRegistry: (d) => {
    const registry = d.getComponentStatePreservationRegistry(CARD);
    expect(d.getComponentStatePreservationRegistry(CARD)).toBe(registry);
  },
  peekComponentStatePreservationRegistry: (d) => {
    expect(d.peekComponentStatePreservationRegistry(CARD)).toBeUndefined();
    const registry = d.getComponentStatePreservationRegistry(CARD);
    expect(d.peekComponentStatePreservationRegistry(CARD)).toBe(registry);
  },
  registerCardAssembler: (d) => {
    const release = d.registerCardAssembler(CARD, { capture: () => ({ content: { probe: 5 } }) as CardStateBag });
    expect(d.captureCardState(CARD).content).toEqual({ probe: 5 });
    release();
  },
  captureCardState: (d) => {
    d.registerCardAssembler(CARD, { capture: () => ({ content: { probe: 6 } }) as CardStateBag });
    expect(d.captureCardState(CARD, "manual").content).toEqual({ probe: 6 });
  },
  registerActivationCallback: (d) => {
    const c = counter();
    const release = d.registerActivationCallback(CARD, c.fn);
    d.invokeActivationCallback(CARD, "transfer-for-activation");
    release();
    d.invokeActivationCallback(CARD, "transfer-for-activation");
    expect(c.n).toBe(1);
  },
  invokeActivationCallback: (d) => {
    const c = counter();
    d.registerActivationCallback(CARD, c.fn);
    d.invokeActivationCallback(CARD, "transfer-for-activation");
    expect(c.n).toBe(1);
  },
  registerDeactivationCallback: (d) => {
    const c = counter();
    const release = d.registerDeactivationCallback(CARD, c.fn);
    d.invokeDeactivationCallback(CARD, "transfer-for-activation");
    release();
    d.invokeDeactivationCallback(CARD, "transfer-for-activation");
    expect(c.n).toBe(1);
  },
  invokeDeactivationCallback: (d) => {
    const c = counter();
    d.registerDeactivationCallback(CARD, c.fn);
    d.invokeDeactivationCallback(CARD, "transfer-for-activation");
    expect(c.n).toBe(1);
  },
  registerCardHostRoot: (d) => {
    const el = document.createElement("div");
    d.registerCardHostRoot(CARD, el);
    expect(d.peekCardHostRoot(CARD)).toBe(el);
    d.registerCardHostRoot(CARD, null);
    expect(d.peekCardHostRoot(CARD)).toBeNull();
  },
  peekCardHostRoot: (d) => {
    expect(d.peekCardHostRoot(CARD)).toBeNull();
    const el = document.createElement("div");
    d.registerCardHostRoot(CARD, el);
    expect(d.peekCardHostRoot(CARD)).toBe(el);
  },
  registerEngineHooks: (d) => {
    const release = d.registerEngineHooks(CARD, { paintMirrorAsActive: () => {}, paintMirrorAsInactive: () => {} });
    expect(d.hasEngineHooks(CARD)).toBe(true);
    release();
    expect(d.hasEngineHooks(CARD)).toBe(false);
  },
  invokeEnginePaintMirrorAsActive: (d) => {
    const c = counter();
    d.registerEngineHooks(CARD, { paintMirrorAsActive: c.fn, paintMirrorAsInactive: () => {} });
    d.invokeEnginePaintMirrorAsActive(CARD);
    expect(c.n).toBe(1);
  },
  invokeEnginePaintMirrorAsInactive: (d) => {
    const c = counter();
    d.registerEngineHooks(CARD, { paintMirrorAsActive: () => {}, paintMirrorAsInactive: c.fn });
    d.invokeEnginePaintMirrorAsInactive(CARD);
    expect(c.n).toBe(1);
  },
  hasEngineHooks: (d) => {
    expect(d.hasEngineHooks(CARD)).toBe(false);
    d.registerEngineHooks(CARD, { paintMirrorAsActive: () => {}, paintMirrorAsInactive: () => {} });
    expect(d.hasEngineHooks(CARD)).toBe(true);
  },
  subscribeEngineHooksChange: (d) => {
    const c = counter();
    d.subscribeEngineHooksChange(CARD, c.fn);
    d.registerEngineHooks(CARD, { paintMirrorAsActive: () => {}, paintMirrorAsInactive: () => {} });
    expect(c.n).toBeGreaterThan(0);
  },
  interruptLiveSessions: async (d, { flush }) => {
    const asked = d.interruptLiveSessions();
    await flush();
    expect(await asked).toEqual({ interrupted: ["s-live"], unacknowledged: ["s-stuck"] });
  },
};

/** One entry per member a `DeckView` adds to `CardDeck`. */
const DECK_VIEW_EVIDENCE: {
  [K in Exclude<keyof DeckView, keyof CardDeck>]-?: (view: DeckView, probe: Probe, replicas: ReturnType<typeof arrangementReplicas>) => void | Promise<void>;
} = {
  getBandWidth: (v, _p, r) => {
    expect(v.getBandWidth()).toBe(1600);
    r.deck.set({ ...r.deck.getSnapshot()!, bandWidth: 1200 });
    expect(v.getBandWidth()).toBe(1200);
  },
  getColumnRunHeight: (v) => {
    expect(v.getColumnRunHeight()).toBe(900);
  },
  getRailRunHeight: (v) => {
    expect(v.getRailRunHeight()).toBe(880);
  },
  setFlowOffset: async (v, { shellHeard, flush }) => {
    v.setFlowOffset(120, "cross");
    await flush();
    expect(shellHeard).toEqual([["deck.setFlowOffset", { offset: 120, landing: "cross" }]]);
  },
  previewFlowOffset: async (v, { shellHeard, flush }) => {
    v.previewFlowOffset(60);
    await flush();
    expect(shellHeard).toEqual([["deck.previewFlowOffset", { offset: 60 }]]);
  },
  subscribeSpaces: (v, _p, r) => {
    const c = counter();
    v.subscribeSpaces(c.fn);
    r.spaces.set(arrangement(1600, "Renamed").spaces);
    expect(c.n).toBe(1);
  },
  getSpacesSnapshot: (v) => {
    expect(v.getSpacesSnapshot().spaces).toEqual([{ id: "s1", name: "Main" }]);
    expect(v.getSpacesSnapshot().activeSpaceId).toBe("s1");
  },
  getSpaceDeck: (v) => {
    expect(v.getSpaceDeck("s1")).toBe(v.getSnapshot());
    expect(v.getSpaceDeck("nowhere")).toBeNull();
  },
  activateSpace: async (v, { shellHeard, flush }) => {
    v.activateSpace("s1");
    await flush();
    expect(shellHeard).toEqual([["deck.activateSpace", { spaceId: "s1" }]]);
  },
  renameSpace: async (v, { shellHeard, flush }) => {
    v.renameSpace("s1", "Work");
    await flush();
    expect(shellHeard).toEqual([["deck.renameSpace", { spaceId: "s1", name: "Work" }]]);
  },
  chooseSpaceTheme: async (v, { shellHeard, flush }) => {
    v.chooseSpaceTheme("s1", "sloop");
    await flush();
    expect(shellHeard).toEqual([["deck.chooseSpaceTheme", { spaceId: "s1", theme: "sloop" }]]);
  },
  reorderSpaces: async (v, { shellHeard, flush }) => {
    v.reorderSpaces(["s2", "s1"]);
    await flush();
    expect(shellHeard).toEqual([["deck.reorderSpaces", { order: ["s2", "s1"] }]]);
  },
  moveCardToSpace: async (v, { shellHeard, flush }) => {
    expect(v.moveCardToSpace("a", "s2")).toBe(true);
    await flush();
    expect(shellHeard).toEqual([["deck.moveCardToSpace", { cardId: "a", spaceId: "s2" }]]);
  },
  spaceHoldsLiveSessions: (v) => {
    expect(v.spaceHoldsLiveSessions("s1")).toBe(2);
    expect(v.spaceHoldsLiveSessions("nowhere")).toBe(0);
  },
  spaceCardCount: (v) => {
    expect(v.spaceCardCount("s1")).toBe(3);
  },
};

describe("every CardDeck member acts", () => {
  for (const [member, evidence] of Object.entries(CARD_DECK_EVIDENCE) as Array<[string, Evidence<CardDeck>]>) {
    test(member, async () => {
      const probe = await bodyPage();
      await evidence(probe.deck, probe);
    });
  }
});

describe("every DeckView member acts", () => {
  for (const [member, evidence] of Object.entries(DECK_VIEW_EVIDENCE)) {
    test(member, async () => {
      const probe = await bodyPage("cards");
      const replicas = arrangementReplicas();
      const view = createDeckView(probe.deck, replicas);
      await evidence(view, probe, replicas);
    });
  }
});

describe("the synthesized deck", () => {
  test("answers fold, arrival and first responder from each card.context in turn", async () => {
    const { deck: b } = await bodyPage();
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

  test("a context that changes nothing the snapshot carries does not notify", async () => {
    const { deck: b } = await bodyPage();
    const c = counter();
    b.subscribe(c.fn);
    b.applyContext(context({ folded: true }));
    b.applyContext(context({ folded: true, spaceId: "space-2" }));
    expect(c.n).toBe(1);
  });
});

describe("activation", () => {
  test("fires on the flips to and from the card, and only on them", async () => {
    const { deck: b } = await bodyPage();
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

  test("a parked card is not key: it activates only when the shell names it first responder", async () => {
    const { deck: b } = await bodyPage();
    const events: string[] = [];
    b.observeCardDidActivate(CARD, () => events.push("activate"));
    b.applyContext(context({ firstResponderCardId: "shown", layerShown: false, spaceId: "two" }));
    expect(b.getFocusedCardId()).toBeNull();
    expect(events).toEqual([]);
    b.applyContext(context({ firstResponderCardId: CARD, spaceId: "two" }));
    expect(events).toEqual(["activate"]);
  });
});

describe("a move and a resize, from the shell's counts", () => {
  /** Each move and resize the page's deck fires, in order. */
  function heard(b: BodyCardDeck): string[] {
    const events: string[] = [];
    b.observeCardDidMove(CARD, () => events.push("move"));
    b.observeCardDidResize(CARD, () => events.push("resize"));
    return events;
  }
  const at = (moves: number, resizes: number) => context({ geometry: { moves, resizes } });

  test("the first context sets the baseline and fires nothing, however much moved before it", async () => {
    const { deck: b } = await bodyPage();
    const events = heard(b);
    b.applyContext(at(3, 2));
    expect(events).toEqual([]);
  });

  test("a raised move count fires the move once", async () => {
    const { deck: b } = await bodyPage();
    const events = heard(b);
    b.applyContext(at(3, 2));
    b.applyContext(at(4, 2));
    expect(events).toEqual(["move"]);
  });

  test("both raised fire the resize, then the move", async () => {
    const { deck: b } = await bodyPage();
    const events = heard(b);
    b.applyContext(at(0, 0));
    b.applyContext(at(1, 1));
    expect(events).toEqual(["resize", "move"]);
  });

  test("a context whose counts did not move fires nothing", async () => {
    const { deck: b } = await bodyPage();
    const events = heard(b);
    b.applyContext(at(1, 1));
    b.applyContext({ ...at(1, 1), folded: true });
    b.applyContext({ ...at(1, 1), firstResponderCardId: CARD });
    expect(events).toEqual([]);
  });
});

describe("a card added from a body", () => {
  test("takes the id the page minted, which the caller holds before the card lands; a given id is kept", async () => {
    const { deck: b, shellHeard, flush } = await bodyPage();
    const minted = b.addCard("session", undefined, { opening: "bound" });
    const given = b.addCard("text", undefined, { cardId: "c-given" });
    expect(minted).not.toBe(null);
    expect(given).toBe("c-given");
    await flush();
    expect(shellHeard).toEqual([
      ["deck.addCard", { cardId: minted, componentId: "session", opening: "bound" }],
      ["deck.addCard", { cardId: "c-given", componentId: "text" }],
    ]);
  });
});

describe("an arrangement card", () => {
  test("reads the shell's panes, band and workspaces, its own pane re-keyed", async () => {
    const { deck: b } = await bodyPage("cards");
    const v = createDeckView(b, arrangementReplicas());
    expect(b.getSnapshot().panes.length).toBe(3);
    expect(b.getSnapshot().panes[0].id).toBe(bodyPaneId(CARD));
    expect(v.getSnapshot()).toBe(b.getSnapshot());
    expect(v.getBandWidth()).toBe(1600);
  });

  test("names the workspace each listed card stands in, a parked one's included", async () => {
    const { deck: b } = await bodyPage("cards");
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
    createDeckView(b, { deck: replica<ArrangementDeckValue | null>(listed.value), spaces: replica(listed.spaces) });
    expect(b.spaceOf(CARD)).toBe("s1");
    expect(b.spaceOf("a")).toBe("s1");
    // What lets `cardIdentity` reach a parked Session card's ledger row.
    expect(b.spaceOf("parked")).toBe("s2");
    expect(b.spaceOf("nowhere")).toBeNull();
  });

  test("a changed arrangement notifies the deck's and the workspaces' listeners; an unchanged one neither", async () => {
    const { deck: b } = await bodyPage("cards");
    const r = arrangementReplicas();
    const deckNotes = counter();
    b.subscribe(deckNotes.fn);
    const v = createDeckView(b, r);
    const spaceNotes = counter();
    v.subscribeSpaces(spaceNotes.fn);
    expect([deckNotes.n, spaceNotes.n]).toEqual([1, 0]);
    r.deck.set(r.deck.getSnapshot());
    expect([deckNotes.n, spaceNotes.n]).toEqual([1, 0]);
    r.spaces.set(arrangement(1600, "Renamed").spaces);
    expect([deckNotes.n, spaceNotes.n]).toEqual([2, 1]);
    expect(v.getSpacesSnapshot().spaces[0].name).toBe("Renamed");
    // A band that moved re-synthesizes the deck and leaves the workspaces be.
    r.deck.set({ ...r.deck.getSnapshot()!, bandWidth: 1200 });
    expect([deckNotes.n, spaceNotes.n]).toEqual([3, 1]);
    expect(v.getBandWidth()).toBe(1200);
  });

  test("before the shell's deck arrives, it keeps its one-pane deck and reads no band", async () => {
    const { deck: b } = await bodyPage("cards");
    const r = arrangementReplicas();
    r.deck.set(null);
    const v = createDeckView(b, r);
    expect(b.getSnapshot().panes.map((p) => p.id)).toEqual([bodyPaneId(CARD)]);
    expect(v.getBandWidth()).toBe(null);
  });

  test("raising another card names it to the shell; activating itself is its own card's", async () => {
    const { deck: b, shellHeard, flush } = await bodyPage("cards");
    createDeckView(b, arrangementReplicas());
    b.activateCard("other");
    b.activateCard(CARD);
    await flush();
    expect(shellHeard).toEqual([
      ["deck.activateCard", { cardId: "other" }],
      ["card.activate", {}],
    ]);
  });
});

describe("a following card", () => {
  test("reads the card it follows, and is told when it changes", async () => {
    const { deck: b } = await bodyPage();
    const c = counter();
    b.subscribe(c.fn);
    expect(b.getFollowedCardId()).toBe(null);
    b.applyFollowed("a");
    expect(b.getFollowedCardId()).toBe("a");
    b.applyFollowed("a");
    b.applyFollowed("b");
    expect(b.getFollowedCardId()).toBe("b");
    expect(c.n).toBe(2);
  });
});

describe("a rail card", () => {
  test("reads the edge it stands pinned to from its context, and is told when it moves or comes loose", async () => {
    const { deck: b } = await bodyPage();
    const c = counter();
    b.subscribe(c.fn);
    expect(b.getRailSide()).toBe(null);
    b.applyContext(context({ railSide: "right" }));
    expect(b.getRailSide()).toBe("right");
    b.applyContext(context({ railSide: "right" }));
    b.applyContext(context({ railSide: "left" }));
    b.applyContext(context());
    expect(b.getRailSide()).toBe(null);
    expect(c.n).toBe(3);
  });
});
