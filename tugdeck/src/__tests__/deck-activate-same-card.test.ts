/**
 * An activation of the card that is already key changes nothing, so it costs
 * nothing: no new deck state, no notify, no save.
 *
 * A card's body asks for activation on every press into it, because only the
 * shell knows whether the card is already key — what the body last heard can
 * be a press behind (`body-publisher.ts`, `pointerDown`). That ask lands here,
 * so a press into the key card must not re-render the deck.
 *
 * Read over a real `DeckManager` mounted into a jsdom container.
 *
 * @covers tugdeck/src/deck-manager.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { DeckManager } from "../deck-manager";
import { installJsdom, mountDeck, onePaneDeck, settle, unmountDeck } from "./jsdom-deck";

// Installed before any deck module loads; the deck is imported in `beforeAll`.
const substrate = installJsdom();

let manager: DeckManager;

beforeAll(async () => {
  manager = await mountDeck(substrate, onePaneDeck("hello", ["card-1", "card-2"]), { focusCardId: "card-1" });
});

afterAll(async () => {
  await unmountDeck(substrate, manager);
});

describe("activating the key card", () => {
  test("leaves the deck's state as it was and notifies nothing", async () => {
    expect(manager.getFirstResponderCardId()).toBe("card-1");
    const before = manager.getSnapshot();
    let notified = 0;
    const release = manager.subscribe(() => {
      notified += 1;
    });
    try {
      manager.activateCard("card-1");
      manager.activateCard("card-1");
      await settle();
      expect(manager.getSnapshot(), "the same deck state, not a copy of it").toBe(before);
      expect(notified).toBe(0);
    } finally {
      release();
    }
  });

  test("and activating another card still does", async () => {
    let notified = 0;
    const release = manager.subscribe(() => {
      notified += 1;
    });
    try {
      manager.activateCard("card-2");
      await settle();
      expect(manager.getFirstResponderCardId()).toBe("card-2");
      expect(notified).toBeGreaterThan(0);
    } finally {
      release();
    }
  });
});
