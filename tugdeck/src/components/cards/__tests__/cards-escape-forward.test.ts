/**
 * Escape's shrink, answered in a page that holds no Cards card: the shell's
 * deck root. The Cards card stands in its own body with the filter this page
 * cannot see, so the table runs there — filter first — and its clear of the
 * selection comes back through the selection mirror. With no Cards body to
 * ask, the page clears its own copy as it always has.
 *
 * @covers tugdeck/src/components/cards/cards-escape.ts
 */

import { afterEach, describe, expect, test } from "bun:test";

import { setCardsFilterBinding, setCardsShrinkForwarder, shrinkCardsState } from "../cards-escape";
import { cardsSelectionStore } from "@/lib/cards-selection-store";

afterEach(() => {
  setCardsShrinkForwarder(null);
  setCardsFilterBinding(null);
  cardsSelectionStore.clear();
});

describe("shrinkCardsState with the Cards card in its own body", () => {
  test("hands the press to the Cards body, which holds the filter rung above the selection", () => {
    let asked = 0;
    setCardsShrinkForwarder(() => {
      asked += 1;
      return true;
    });
    cardsSelectionStore.pickOnly("A");
    expect(shrinkCardsState()).toBe("selection");
    expect(asked).toBe(1);
    // The body decides: a standing query there is cleared before the set.
    expect(cardsSelectionStore.getSnapshot().ids).toEqual(["A"]);
  });

  test("clears its own copy when no Cards body answers", () => {
    setCardsShrinkForwarder(() => false);
    cardsSelectionStore.pickOnly("A");
    expect(shrinkCardsState()).toBe("selection");
    expect(cardsSelectionStore.getSnapshot().ids).toEqual([]);
  });

  test("is not asked with nothing to shrink", () => {
    let asked = 0;
    setCardsShrinkForwarder(() => {
      asked += 1;
      return true;
    });
    expect(shrinkCardsState()).toBe("focus-out");
    expect(asked).toBe(0);
  });
});
