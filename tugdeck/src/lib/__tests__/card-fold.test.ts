/**
 * card-fold.test.ts — `toggle-card-fold`'s body and the guard a card may set
 * in front of it ([B05]).
 *
 * The fold is the pane's, so the toggle writes for any card; a card with
 * something to close first (the Session card) or nothing to fold to (an
 * unbound Session card) says so through its guard. These pin the contract
 * between the two: the guard runs on the way down and never on the way up,
 * its refusal stops the write, and a stale unregister cannot clear the guard
 * that replaced it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { _resetForTest, registerAction } from "@/action-dispatch";
import type { DeckState } from "@/layout-tree";
import type { IDeckManagerStore } from "@/deck-manager-store";
import { registerDeckStore } from "@/lib/deck-store-registry";
import { registerCardFoldGuard, toggleCardFold } from "@/lib/card-fold";

/** Every SET_CARD_FOLDED the toggle dispatched, in order. */
let writes: { cardId: unknown; folded: unknown }[] = [];

/** A deck store holding one pane around `cardId`, folded or not. */
function installDeck(cardId: string, folded: boolean): void {
  const deck = {
    cards: [{ id: cardId, componentId: "text", title: "", closable: true }],
    panes: [
      {
        id: "pane-1",
        cardIds: [cardId],
        activeCardId: cardId,
        ...(folded ? { folded: true } : {}),
      },
    ],
  } as unknown as DeckState;
  registerDeckStore({
    getSnapshot: () => deck,
    subscribe: () => () => {},
  } as unknown as IDeckManagerStore);
}

beforeEach(() => {
  _resetForTest();
  writes = [];
  registerAction(TUG_ACTIONS.SET_CARD_FOLDED, (payload) => {
    writes.push({ cardId: payload.cardId, folded: payload.folded });
  });
});

afterEach(() => {
  registerDeckStore(null);
  _resetForTest();
});

describe("toggleCardFold", () => {
  test("folds a card with no guard — every content card folds", () => {
    installDeck("text-1", false);
    toggleCardFold("text-1");
    expect(writes).toEqual([{ cardId: "text-1", folded: true }]);
  });

  test("unfolds a folded card", () => {
    installDeck("text-1", true);
    toggleCardFold("text-1");
    expect(writes).toEqual([{ cardId: "text-1", folded: false }]);
  });

  test("asks the guard on the way down, and a refusal writes nothing", () => {
    installDeck("session-1", false);
    let asked = 0;
    const unregister = registerCardFoldGuard("session-1", () => {
      asked += 1;
      return false;
    });
    toggleCardFold("session-1");
    expect(asked).toBe(1);
    expect(writes).toEqual([]);
    unregister();
  });

  test("never asks the guard on the way up", () => {
    installDeck("session-1", true);
    let asked = 0;
    const unregister = registerCardFoldGuard("session-1", () => {
      asked += 1;
      return false;
    });
    toggleCardFold("session-1");
    expect(asked).toBe(0);
    expect(writes).toEqual([{ cardId: "session-1", folded: false }]);
    unregister();
  });

  test("a stale unregister leaves the guard that replaced it standing", () => {
    installDeck("session-1", false);
    const unregisterRefusal = registerCardFoldGuard("session-1", () => false);
    const unregisterBody = registerCardFoldGuard("session-1", () => true);
    unregisterRefusal();
    toggleCardFold("session-1");
    expect(writes).toEqual([{ cardId: "session-1", folded: true }]);
    unregisterBody();
  });
});
