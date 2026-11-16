/**
 * Back and Forward inside one workspace: the deck keeps a trail of the cards
 * the reader had focused and steps along it.
 *
 * Every activation is a visit, a step's own arrival is not, a landing made
 * after going back starts a new future, and a closed card is passed over.
 * The trail's own rules are read as a pure module in
 * `lib/__tests__/focus-trail.test.ts`; what is read here is that the manager
 * writes it from its activations and that a step moves the first responder.
 *
 * Read over a real `DeckManager` mounted into a jsdom container, one deck per
 * case so no case inherits another's trail.
 *
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/lib/focus-trail.ts
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";

import type { DeckManager } from "../deck-manager";
import { installJsdom, mountDeck, onePaneDeck, settle } from "./jsdom-deck";

// Installed before any deck module loads; the deck is imported at the mount.
const substrate = installJsdom();

let manager: DeckManager | undefined;

/** A fresh deck of `cardIds` in one pane, the first focused. */
async function deckOf(...cardIds: string[]): Promise<DeckManager> {
  manager = await mountDeck(substrate, onePaneDeck("hello", cardIds), {
    focusCardId: cardIds[0],
  });
  return manager;
}

/** Activate each card in turn, as the reader would by any ordinary door. */
async function visit(deck: DeckManager, ...cardIds: string[]): Promise<void> {
  for (const cardId of cardIds) {
    deck.activateCard(cardId);
    await settle();
  }
}

afterEach(async () => {
  manager?.destroy();
  manager = undefined;
  await settle();
});

afterAll(() => {
  substrate.restore();
});

describe("Back and Forward inside one workspace", () => {
  test("a deck nobody has moved in has nowhere to go", async () => {
    const deck = await deckOf("card-1", "card-2");
    expect(deck.canGoBack()).toBe(false);
    expect(deck.canGoForward()).toBe(false);
    expect(deck.goBack()).toBe(false);
    expect(deck.goForward()).toBe(false);
    expect(deck.getFirstResponderCardId()).toBe("card-1");
  });

  test("Back returns to the card focused at launch", async () => {
    const deck = await deckOf("card-1", "card-2");
    await visit(deck, "card-2");
    expect(deck.canGoBack()).toBe(true);
    expect(deck.goBack()).toBe(true);
    await settle();
    expect(deck.getFirstResponderCardId()).toBe("card-1");
    expect(deck.canGoBack()).toBe(false);
  });

  test("Back retraces the visits in order and Forward retraces the Backs", async () => {
    const deck = await deckOf("card-1", "card-2", "card-3");
    await visit(deck, "card-2", "card-3", "card-2");
    const walked: (string | null)[] = [];
    for (const go of [deck.goBack, deck.goBack, deck.goBack, deck.goForward, deck.goForward, deck.goForward]) {
      expect(go()).toBe(true);
      await settle();
      walked.push(deck.getFirstResponderCardId());
    }
    expect(walked).toEqual(["card-3", "card-2", "card-1", "card-2", "card-3", "card-2"]);
    expect(deck.canGoForward()).toBe(false);
    expect(deck.goForward()).toBe(false);
  });

  test("a step's arrival is not a visit", async () => {
    const deck = await deckOf("card-1", "card-2", "card-3");
    await visit(deck, "card-2", "card-3");
    deck.goBack();
    await settle();
    // Had the arrival on card-2 been recorded, Back from it would lead to
    // card-3 and Forward would have nothing ahead.
    expect(deck.canGoForward()).toBe(true);
    deck.goBack();
    await settle();
    expect(deck.getFirstResponderCardId()).toBe("card-1");
  });

  test("a landing made after going back drops what was ahead", async () => {
    const deck = await deckOf("card-1", "card-2", "card-3");
    await visit(deck, "card-2", "card-3");
    deck.goBack();
    deck.goBack();
    await settle();
    await visit(deck, "card-3");
    expect(deck.canGoForward()).toBe(false);
    expect(deck.goBack()).toBe(true);
    await settle();
    expect(deck.getFirstResponderCardId()).toBe("card-1");
  });

  test("re-activating the focused card records nothing", async () => {
    const deck = await deckOf("card-1", "card-2");
    await visit(deck, "card-2", "card-2", "card-2");
    deck.goBack();
    await settle();
    expect(deck.getFirstResponderCardId()).toBe("card-1");
    expect(deck.canGoBack()).toBe(false);
  });

  test("Back passes over a card that was closed", async () => {
    const deck = await deckOf("card-1", "card-2", "card-3");
    await visit(deck, "card-2", "card-3");
    deck.removeCard("pane-1", "card-2");
    await settle();
    expect(deck.getFirstResponderCardId(), "closing an unfocused card moves no focus").toBe("card-3");
    expect(deck.goBack()).toBe(true);
    await settle();
    expect(deck.getFirstResponderCardId()).toBe("card-1");
    expect(deck.canGoBack()).toBe(false);
  });
});
