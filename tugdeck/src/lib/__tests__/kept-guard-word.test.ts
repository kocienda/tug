/**
 * The word an evicted page left that its card's close asks: kept through the
 * eviction and a shell reload, and cleared by the card's next page once it
 * has answered for itself, either way — so a clean page gives the card's
 * close its deadline back, and a `false` before the read-back is no answer.
 * The word outlives a page that fails, as it does one that is evicted, and
 * an eviction's word is durable before the eviction is done with.
 *
 * @covers tugdeck/src/lib/kept-guard-word.ts
 * @covers tugdeck/src/bus/shared-store.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { NO_CARD_HOLDS, cardGuardAsks, type CardHoldsValue } from "../../bus/declarations/card";
import { createTestBus, type TestBus } from "../../bus/test-bus";
import { createKeptGuardWords } from "../kept-guard-word";

/** The kept words over a plain map, with every durable write recorded. */
function words(persisted: string[] = []) {
  const store = new Map<string, boolean>();
  const writes: Array<[string, boolean]> = [];
  const kept = createKeptGuardWords(
    {
      get: (cardId) => store.get(cardId) ?? false,
      set: (cardId, asks) => store.set(cardId, asks),
      persist: (cardId, asks) => {
        writes.push([cardId, asks]);
        return Promise.resolve();
      },
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

  test("a page that paints with no guard — the card's save mode turned automatic while it was gone — answers, and the word goes", () => {
    const { kept, writes } = words();
    kept.evicted("c1", DIRTY);
    kept.heard("c1", holds({ closeGuardAsks: null, closeGuardAnswered: true }));
    expect(kept.asks("c1")).toBe(false);
    expect(writes).toEqual([
      ["c1", true],
      ["c1", false],
    ]);
  });

  test("the eviction is done with only once its word is durable", async () => {
    let land = (): void => {};
    const kept = createKeptGuardWords(
      {
        get: () => false,
        set: () => {},
        persist: () => new Promise<void>((resolve) => (land = resolve)),
      },
      [],
    );
    let settled = false;
    const eviction = kept.evicted("c1", DIRTY).then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    land();
    await eviction;
    expect(settled).toBe(true);
  });
});

describe("the kept guard word in the shell's card store", () => {
  let bus: TestBus | undefined;
  afterEach(() => bus?.dispose());

  test("outlives a page that fails before it answers, and its next page is sent it at hello", async () => {
    bus = createTestBus();
    const shell = bus.shell();
    bus.body("c1", "text");
    await bus.flush();
    const store = cardGuardAsks.on(shell.bus);
    const kept = createKeptGuardWords(
      { get: (cardId) => store.getFor(cardId), set: (cardId, asks) => store.setFor(cardId, asks), persist: () => Promise.resolve() },
      [],
    );

    await kept.evicted("c1", DIRTY);
    bus.detach("c1");
    // The page brought back fails: the host destroys it, and the card stays.
    bus.body("c1", "text");
    await bus.flush();
    bus.detach("c1");
    shell.bus.forgetPage("c1");

    expect(kept.asks("c1")).toBe(true);
    const next = bus.body("c1", "text");
    await bus.flush();
    expect(cardGuardAsks.on(next.bus).getSnapshot()).toBe(true);
  });
});
