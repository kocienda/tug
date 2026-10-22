/**
 * What a body reads of the deck beyond its own card, and the deck verbs an
 * arrangement card asks of the shell: the declarations of
 * `bus/declarations/arrangement.ts` on the test bus, with the real library on
 * every page.
 *
 * @covers tugdeck/src/bus/declarations/arrangement.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { registerCard } from "../../card-registry";
import type { DeckState } from "../../layout-tree";
import type { CardSessionBinding } from "../../lib/card-session-binding-store";
import {
  arrangementDeck,
  arrangementSpaces,
  cardsSpaceVerb,
  deckRenameSpace,
} from "../declarations/arrangement";
import { cardContext, NO_CARD_CONTEXT } from "../declarations/card";
import { deckCards, type DeckCardFacts } from "../declarations/deck";
import { ROUTED_ACTIONS } from "../registry";
import { createTestBus, type TestBus } from "../test-bus";

registerCard({
  componentId: "arrangement-stores-lister",
  contentFactory: () => null,
  defaultMeta: { title: "Lister", closable: true },
  bodyDeck: "arrangement",
});

const LISTER = "arrangement-stores-lister";

let bus: TestBus;
afterEach(() => bus?.dispose());

const DECK: DeckState = { cards: [], panes: [], imposition: { sidebars: {} }, hasFocus: true };
const BINDING: CardSessionBinding = {
  tugSessionId: "tug-a",
  lineId: "line-a",
  workspaceKey: "wk",
  projectDir: "/p",
  sessionMode: "resume",
};

describe("the arrangement stores", () => {
  test("every body reads every card's record; only an arrangement card reads the arrangement", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const a: DeckCardFacts = {
      componentId: "session",
      title: "a",
      masthead: null,
      identity: null,
      activity: "streaming",
      binding: BINDING,
      sessionState: "live",
      parkedTitle: null,
      waivesClose: false,
    };
    deckCards.on(shell.bus).set({ a });
    arrangementDeck.on(shell.bus).set({ deck: DECK, bandWidth: 1600, columnRunHeight: null, railRunHeight: null });
    const session = bus.body("s1", "session");
    const lister = bus.body("l1", LISTER);
    await bus.flush();

    expect(deckCards.on(session.bus).getSnapshot()).toEqual({ a });
    expect(arrangementDeck.on(session.bus).arrived()).toBe(false);

    expect(deckCards.on(lister.bus).getSnapshot()).toEqual({ a });
    expect(arrangementDeck.on(lister.bus).getSnapshot()?.bandWidth).toBe(1600);

    // A move reaches the arrangement card and nobody else.
    const before = bus.frames().length;
    arrangementSpaces.on(shell.bus).set({
      activeSpaceId: "w1",
      spaces: [{ id: "w1", name: "Main" }],
      mountedSpaceIds: ["w1"],
      decks: {},
      liveSessions: {},
      cardCounts: {},
    });
    await bus.flush();
    const sent = bus.frames().slice(before);
    expect(sent.map((f) => f.to)).toEqual([[lister.pageId]]);
    expect(arrangementSpaces.on(lister.bus).getSnapshot().spaces).toEqual([{ id: "w1", name: "Main" }]);
  });

  test("a workspace rename from a body runs on the shell's deck", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    const renamed: Array<{ spaceId: string; name: string; cardId: string | null }> = [];
    deckRenameSpace.on(shell.bus).handle(({ spaceId, name }, from) => renamed.push({ spaceId, name, cardId: from.cardId }));
    const lister = bus.body("l1", LISTER);
    await bus.flush();
    deckRenameSpace.on(lister.bus).dispatch({ spaceId: "w1", name: "Renamed" });
    await bus.flush();
    expect(renamed).toEqual([{ spaceId: "w1", name: "Renamed", cardId: "l1" }]);
  });

  test("a workspace verb sent before the Cards body attaches is delivered after its stores", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    cardContext.on(shell.bus).setFor("cards-1", { ...NO_CARD_CONTEXT, layerShown: true });
    cardsSpaceVerb.on(shell.bus).dispatch({ verb: "rename", spaceId: "w1" }, { card: "cards-1" });
    await bus.flush();

    const cards = bus.body("cards-1", "cards");
    const seen: Array<{ verb: string; contextArrived: boolean }> = [];
    cardsSpaceVerb.on(cards.bus).handle(({ verb }) => {
      seen.push({ verb, contextArrived: cardContext.on(cards.bus).arrived() });
    });
    await bus.flush();
    expect(seen).toEqual([{ verb: "rename", contextArrived: true }]);
  });

  test("the deck verbs a body may ask are exactly the eight moves and the two any card makes, and never a workspace delete", () => {
    const deckVerbs = ROUTED_ACTIONS.map((a) => a.key).filter((key) => key.startsWith("deck."));
    expect(deckVerbs.sort()).toEqual(
      [
        "deck.activateCard",
        "deck.activateSpace",
        "deck.chooseSpaceTheme",
        "deck.moveCardToSpace",
        "deck.previewFlowOffset",
        "deck.renameSpace",
        "deck.reorderSpaces",
        "deck.setFlowOffset",
        "deck.addCard",
        "deck.showSingletonCard",
      ].sort(),
    );
  });
});
