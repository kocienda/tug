/**
 * card-appetite-store.test.ts — the channel a card declares its vertical
 * appetite through.
 *
 * Three properties carry the whole design. The **equality guard** is what lets
 * a publisher run its effect on every render of the snapshot it computes from:
 * the same two numbers must reach nobody. The **stable snapshot** is what lets
 * the deck manager tell a notify that carried something from one that did not,
 * by identity. And **`sameAppetites`** is the entry-wise comparison the settled
 * copy in deck state needs, since that copy outlives any number of snapshots.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  cardAppetiteStore,
  sameAppetites,
  type CardAppetite,
} from "@/lib/card-appetite-store";

describe("cardAppetiteStore", () => {
  beforeEach(() => {
    cardAppetiteStore.reset();
  });

  test("a card's declaration is what the snapshot carries", () => {
    cardAppetiteStore.set("jots", { natural: 405 });
    expect(cardAppetiteStore.get("jots")).toEqual({
      natural: 405,
    });
    expect(cardAppetiteStore.snapshot()).toEqual({
      jots: { natural: 405 },
    });
  });

  test("the same number notifies nobody", () => {
    let notifies = 0;
    cardAppetiteStore.subscribe(() => {
      notifies += 1;
    });
    cardAppetiteStore.set("jots", { natural: 405 });
    expect(notifies).toBe(1);
    // A publisher's effect re-running with an unchanged number — the ordinary
    // case, and the one that must cost nothing.
    cardAppetiteStore.set("jots", { natural: 405 });
    expect(notifies).toBe(1);
    cardAppetiteStore.set("jots", { natural: 433 });
    expect(notifies).toBe(2);
  });

  test("the snapshot's identity is stable across a no-op set", () => {
    cardAppetiteStore.set("jots", { natural: 405 });
    const first = cardAppetiteStore.snapshot();
    cardAppetiteStore.set("jots", { natural: 405 });
    expect(cardAppetiteStore.snapshot()).toBe(first);
    cardAppetiteStore.set("jots", { natural: 433 });
    expect(cardAppetiteStore.snapshot()).not.toBe(first);
  });

  test("the revision is bumped before the listeners run", () => {
    // A `useSyncExternalStore` subscriber reads its snapshot from inside its
    // own notification. A revision bumped afterwards would hand it the value it
    // already had, and nothing downstream would recompute.
    const seen: number[] = [];
    cardAppetiteStore.subscribe(() => seen.push(cardAppetiteStore.version()));
    cardAppetiteStore.set("jots", { natural: 405 });
    cardAppetiteStore.set("cards", { natural: 300 });
    expect(seen).toEqual([1, 2]);
  });

  test("clearing withdraws the declaration, and only when there was one", () => {
    let notifies = 0;
    cardAppetiteStore.set("jots", { natural: 405 });
    cardAppetiteStore.subscribe(() => {
      notifies += 1;
    });
    cardAppetiteStore.clear("jots");
    expect(cardAppetiteStore.get("jots")).toBeUndefined();
    expect(cardAppetiteStore.snapshot()).toEqual({});
    expect(notifies).toBe(1);
    // A card that never declared one unmounting is not a change.
    cardAppetiteStore.clear("layout");
    expect(notifies).toBe(1);
  });

  test("reset empties the store", () => {
    cardAppetiteStore.set("jots", { natural: 405 });
    cardAppetiteStore.reset();
    expect(cardAppetiteStore.snapshot()).toEqual({});
    expect(cardAppetiteStore.version()).toBe(0);
  });

  test("an unsubscribed listener stops hearing", () => {
    let notifies = 0;
    const drop = cardAppetiteStore.subscribe(() => {
      notifies += 1;
    });
    cardAppetiteStore.set("jots", { natural: 405 });
    drop();
    cardAppetiteStore.set("jots", { natural: 433 });
    expect(notifies).toBe(1);
  });
});

describe("sameAppetites", () => {
  const jots: CardAppetite = { natural: 405 };

  test("two different objects of the same shape are the same appetites", () => {
    expect(sameAppetites({ jots }, { jots: { ...jots } })).toBe(true);
  });

  test("a changed number, a lost card and a gained one are all changes", () => {
    expect(sameAppetites({ jots }, { jots: { ...jots, natural: 433 } })).toBe(
      false,
    );
    expect(sameAppetites({ jots }, {})).toBe(false);
    expect(sameAppetites({}, { jots })).toBe(false);
  });

  test("a card swapped for another of the same count is a change", () => {
    // The length check alone would pass this; the per-key lookup is what
    // catches it.
    expect(sameAppetites({ jots }, { cards: jots })).toBe(false);
  });

  test("an Infinity natural compares equal to itself", () => {
    // A stream is never measured and so publishes nothing here — the selector
    // reads its natural as endless from the registry ([B05]). Endless still
    // has to compare equal to itself, because a member that declared NOTHING
    // reads endless too, and that is a value this store's own consumers hold.
    // `Infinity === Infinity` holds, and nothing here goes through arithmetic
    // that would turn it into a NaN.
    const stream: CardAppetite = { natural: Infinity };
    expect(sameAppetites({ overview: stream }, { overview: { ...stream } })).toBe(
      true,
    );
  });
});
