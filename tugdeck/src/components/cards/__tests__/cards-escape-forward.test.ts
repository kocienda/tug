/**
 * Escape's shrink, answered in a page that holds no Cards card: the shell's
 * deck root. The Cards card stands in its own body with the filter this page
 * cannot see, so the table runs there — filter first — as `cards.shrink`
 * sent to the shown workspace's Cards card, and its clear of the selection
 * comes back through `layout.selection`. With no Cards body to ask, the page
 * clears its own copy as it always has.
 *
 * @covers tugdeck/src/components/cards/cards-escape.ts
 */

import { afterEach, describe, expect, test } from "bun:test";

import { setCardsFilterBinding, shrinkCardsState } from "../cards-escape";
import { cardsSelectionStore } from "@/lib/cards-selection-store";
import { bodyCardsStore } from "@/lib/body-cards-store";
import { registerDeckStore } from "@/lib/deck-store-registry";
import { CARDS_CARD_ID } from "@/lib/cards-card-id";
import { cardsShrink } from "@/bus/declarations/verbs";
import { createTestBus, type TestBus } from "@/bus/test-bus";
import type { IDeckManagerStore } from "@/deck-manager-store";

let bus: TestBus;

afterEach(() => {
  bus?.dispose();
  registerDeckStore(null);
  bodyCardsStore._reset();
  setCardsFilterBinding(null);
  cardsSelectionStore.clear();
});

/** A shell whose shown workspace holds the Cards card `C`, and the count of shrinks its body ran. */
async function shellWithCardsCard(asBody: boolean): Promise<{ shrinks: () => number }> {
  bus = createTestBus();
  const shell = bus.shell();
  bus.install(shell);
  registerDeckStore({ getSnapshot: () => ({ cards: [{ id: "C", componentId: CARDS_CARD_ID }] }) } as unknown as IDeckManagerStore);
  let shrinks = 0;
  if (asBody) {
    bodyCardsStore.mark("C");
    const page = bus.body("C", CARDS_CARD_ID);
    cardsShrink.on(page.bus).handle(() => {
      shrinks += 1;
    });
  }
  await bus.flush();
  return { shrinks: () => shrinks };
}

describe("shrinkCardsState with the Cards card in its own body", () => {
  test("hands the press to the Cards body, which holds the filter rung above the selection", async () => {
    const { shrinks } = await shellWithCardsCard(true);
    cardsSelectionStore.pickOnly("A");
    expect(shrinkCardsState()).toBe("selection");
    await bus.flush();
    expect(shrinks()).toBe(1);
    // The body decides: a standing query there is cleared before the set.
    expect(cardsSelectionStore.getSnapshot().ids).toEqual(["A"]);
  });

  test("clears its own copy when the Cards card is not a body card", async () => {
    await shellWithCardsCard(false);
    cardsSelectionStore.pickOnly("A");
    expect(shrinkCardsState()).toBe("selection");
    expect(cardsSelectionStore.getSnapshot().ids).toEqual([]);
  });

  test("sends nothing with nothing to shrink", async () => {
    const { shrinks } = await shellWithCardsCard(true);
    expect(shrinkCardsState()).toBe("focus-out");
    await bus.flush();
    expect(shrinks()).toBe(0);
  });
});
