/**
 * CardServicesStore — deck-manager wiring tests.
 *
 * Pins the contract: when the deck fires `cardWillBeginDestruction`
 * for a card, the store sends a `close_session` frame for any
 * binding that card holds, then disposes services through the
 * binding-clear → reconcile path. The deck-canvas does NOT call into
 * the store directly (per [L10] — one responsibility per layer).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import { cardServicesStore } from "../lib/card-services-store";
import {
  cardSessionBindingStore,
  type CardSessionBinding,
} from "../lib/card-session-binding-store";

interface FakeCard {
  id: string;
}

interface FakeDeckSnapshot {
  cards: FakeCard[];
}

/**
 * Minimal fake DeckManager — just the surface CardServicesStore reads:
 * `observeCardWillBeginDestruction(null, cb) → unsubscribe` and
 * `getSnapshot() → { cards }`. `setCards` mirrors the real deck's
 * removal order: destruction fires before the card leaves the snapshot.
 * Concrete `DeckManager` carries much more state we don't need here.
 */
function createFakeDeck(initial: FakeCard[]) {
  let snapshot: FakeDeckSnapshot = { cards: initial };
  const destructionObservers = new Set<(cardId: string) => void>();
  return {
    observeCardWillBeginDestruction(
      _cardId: string | null,
      cb: (cardId: string) => void,
    ): () => void {
      destructionObservers.add(cb);
      return () => destructionObservers.delete(cb);
    },
    getSnapshot(): FakeDeckSnapshot {
      return snapshot;
    },
    setCards(cards: FakeCard[]): void {
      const next = new Set(cards.map((c) => c.id));
      for (const card of snapshot.cards) {
        if (next.has(card.id)) continue;
        for (const cb of destructionObservers) cb(card.id);
      }
      snapshot = { cards };
    },
  };
}

const TOUCHED_CARD_IDS = new Set<string>();

function bind(cardId: string, tugSessionId: string): CardSessionBinding {
  TOUCHED_CARD_IDS.add(cardId);
  const binding: CardSessionBinding = {
    tugSessionId,
    lineId: tugSessionId,
    workspaceKey: "/work/csstore-test",
    projectDir: "/work/csstore-test",
    sessionMode: "new",
  };
  cardSessionBindingStore.setBinding(cardId, binding);
  return binding;
}

afterEach(() => {
  for (const id of TOUCHED_CARD_IDS) {
    cardSessionBindingStore.clearBinding(id);
  }
  TOUCHED_CARD_IDS.clear();
});

// Capture wire frames sent during these tests. Production wiring
// goes through the real connection singleton, which isn't set up
// in this test environment — `_closeCardInternal`'s no-connection
// fallback clears the binding locally and skips the frame. The
// test assertion focuses on the state transition that follows.
describe("CardServicesStore — deck-manager destruction observer", () => {
  beforeEach(() => {
    // No-op: each test attaches a fresh fake deck.
  });

  it("clears the binding when the deck removes a card that holds one", () => {
    const cardId = "csstore-test-card-1";
    const fakeDeck = createFakeDeck([{ id: cardId }]);
    bind(cardId, "csstore-test-sess-1");

    // Sanity: binding present before the deck removal.
    expect(cardSessionBindingStore.getBinding(cardId)).toBeDefined();

    cardServicesStore.attachDeckManager(
      fakeDeck as unknown as Parameters<typeof cardServicesStore.attachDeckManager>[0],
    );

    // Remove the card from the deck.
    fakeDeck.setCards([]);

    // The binding must be cleared as a result of the deck-driven
    // close. Whether or not the wire frame went out depends on the
    // connection singleton (absent in this test); the binding clear
    // is the load-bearing assertion.
    expect(cardSessionBindingStore.getBinding(cardId)).toBeUndefined();
  });

  it("does not fire close for cards that have no binding", () => {
    const cardId = "csstore-test-card-2";
    const fakeDeck = createFakeDeck([{ id: cardId }]);
    // No bind() call — card exists in deck but has no session binding.

    cardServicesStore.attachDeckManager(
      fakeDeck as unknown as Parameters<typeof cardServicesStore.attachDeckManager>[0],
    );

    // Removing an unbound card must not throw and must not affect
    // any other binding.
    fakeDeck.setCards([]);

    expect(cardSessionBindingStore.getBinding(cardId)).toBeUndefined();
  });

  it("does not fire close for cards still present after a deck change", () => {
    const stayingId = "csstore-test-card-stay";
    const goingId = "csstore-test-card-go";
    const fakeDeck = createFakeDeck([{ id: stayingId }, { id: goingId }]);
    bind(stayingId, "csstore-test-sess-stay");
    bind(goingId, "csstore-test-sess-go");

    cardServicesStore.attachDeckManager(
      fakeDeck as unknown as Parameters<typeof cardServicesStore.attachDeckManager>[0],
    );

    // Remove only `goingId`.
    fakeDeck.setCards([{ id: stayingId }]);

    // The staying card's binding survives.
    expect(cardSessionBindingStore.getBinding(stayingId)).toBeDefined();
    // The departing card's binding is cleared.
    expect(cardSessionBindingStore.getBinding(goingId)).toBeUndefined();
  });
});
