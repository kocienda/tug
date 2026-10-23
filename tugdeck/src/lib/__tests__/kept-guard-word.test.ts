/**
 * The word an evicted page left that its card's close asks: kept through the
 * eviction and a shell reload, and cleared by the card's next page once it
 * has answered for itself, either way — so a clean page gives the card's
 * close its deadline back, and a `false` before the read-back is no answer.
 *
 * @covers tugdeck/src/lib/kept-guard-word.ts
 */

import { describe, expect, test } from "bun:test";
import { NO_CARD_HOLDS, type CardHoldsValue } from "../../bus/declarations/card";
import { createKeptGuardWords } from "../kept-guard-word";

/** The kept words over a plain map, with every durable write recorded. */
function words(persisted: string[] = []) {
  const store = new Map<string, boolean>();
  const writes: Array<[string, boolean]> = [];
  const kept = createKeptGuardWords(
    {
      get: (cardId) => store.get(cardId) ?? false,
      set: (cardId, asks) => store.set(cardId, asks),
      persist: (cardId, asks) => writes.push([cardId, asks]),
    },
    persisted,
  );
  return { kept, writes };
}

const holds = (patch: Partial<CardHoldsValue>): CardHoldsValue => ({ ...NO_CARD_HOLDS, ...patch });
const DIRTY = holds({ closeGuardAsks: true, closeGuardAnswered: true });

describe("the kept guard word", () => {
  test("an evicted page that said its guard asks leaves the word, durably; one that said it would not leaves none", () => {
    const { kept, writes } = words();
    kept.evicted("dirty", DIRTY);
    kept.evicted("clean", holds({ closeGuardAsks: false, closeGuardAnswered: true }));
    expect(kept.asks("dirty")).toBe(true);
    expect(kept.asks("clean")).toBe(false);
    expect(writes).toEqual([["dirty", true]]);
  });

  test("the next page that comes back clean clears the word once it has read its aside back", () => {
    const { kept, writes } = words();
    kept.evicted("c1", DIRTY);
    // The page's guard stands, its open still in flight: a clean buffer is no answer yet.
    kept.heard("c1", holds({ closeGuardAsks: false, closeGuardAnswered: false }));
    expect(kept.asks("c1")).toBe(true);
    // The read-back settled and found nothing set aside.
    kept.heard("c1", holds({ closeGuardAsks: false, closeGuardAnswered: true }));
    expect(kept.asks("c1")).toBe(false);
    expect(writes).toEqual([
      ["c1", true],
      ["c1", false],
    ]);
  });

  test("the next page that reads its edits back dirty says so itself, and the kept word goes", () => {
    const { kept } = words();
    kept.evicted("c1", DIRTY);
    kept.heard("c1", DIRTY);
    expect(kept.asks("c1")).toBe(false);
  });

  test("a page with no guard yet answers nothing, and the word stands", () => {
    const { kept } = words();
    kept.evicted("c1", DIRTY);
    kept.heard("c1", NO_CARD_HOLDS);
    expect(kept.asks("c1")).toBe(true);
  });

  test("a shell reload reads the durable words back, and closing the card lets its word go", () => {
    const { kept, writes } = words(["c1"]);
    expect(kept.asks("c1")).toBe(true);
    expect(writes).toEqual([]);
    kept.closed("c1");
    kept.closed("c2");
    expect(kept.asks("c1")).toBe(false);
    expect(writes).toEqual([["c1", false]]);
  });
});
