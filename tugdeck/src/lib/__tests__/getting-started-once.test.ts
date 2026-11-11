/**
 * getting-started-once.test.ts — the Getting Started card stands beside the
 * setup wizard's first session once, and never again.
 *
 * The card's standing door is Help ▸ Getting Started. This is its other one:
 * `openFirstSession` asks `showGettingStartedOnce`, which opens the card only
 * while tugbank has no `getting-started-seen`, and records that it did. A
 * second setup in the same launch, a later launch, and a page with no tugbank
 * to remember the answer all leave the deck alone.
 *
 * Only the focus-transfer seam is mocked, the way the other opener tests
 * reduce it; the fresh-card path under test never reaches it.
 *
 * @covers tugdeck/src/lib/shell-gate-deck.ts
 * @covers tugdeck/src/settings-api.ts
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

import { setTugbankClient } from "@/lib/tugbank-singleton";

mock.module("@/focus-transfer", () => ({
  transferFocusForActivation: ({ commitMutation }: { commitMutation: () => void }) =>
    commitMutation(),
  mayDeferCommitInView: () => false,
}));

let showGettingStartedOnce: typeof import("@/lib/shell-gate-deck").showGettingStartedOnce;
const realFetch = globalThis.fetch;
const puts: Array<{ url: string; body: unknown }> = [];

beforeAll(async () => {
  ({ showGettingStartedOnce } = await import("@/lib/shell-gate-deck"));
  globalThis.fetch = ((url: string, init?: { body?: string }) => {
    puts.push({ url, body: init?.body === undefined ? null : JSON.parse(init.body) });
    return Promise.resolve(new Response("{}"));
  }) as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  setTugbankClient(null);
});

function makeDeck() {
  const added: unknown[][] = [];
  const deck = {
    getFirstResponderCardId: () => null,
    getSnapshot: () => ({ panes: [], cards: [] }),
    getCardState: () => undefined,
    invokeSaveCallback: () => {},
    addCard: (...args: unknown[]) => {
      added.push(args);
      return "cHelp";
    },
  };
  return { deck, added };
}

/** A tugbank holding `getting-started-seen` as given, or nothing at all. */
function bank(seen: boolean | null) {
  return {
    get: (domain: string, key: string) =>
      seen !== null && domain === "dev.tugapp.app" && key === "getting-started-seen"
        ? { kind: "bool", value: seen }
        : undefined,
  };
}

describe("the Getting Started card after setup", () => {
  test("with no tugbank to remember it, nothing opens", () => {
    setTugbankClient(null);
    const { deck, added } = makeDeck();
    expect(showGettingStartedOnce(deck as never)).toBe(false);
    expect(added).toHaveLength(0);
  });

  test("an instance that has seen it gets no second card", () => {
    setTugbankClient(bank(true) as never);
    const { deck, added } = makeDeck();
    expect(showGettingStartedOnce(deck as never)).toBe(false);
    expect(added).toHaveLength(0);
    expect(puts).toHaveLength(0);
  });

  test("the first setup opens the walk and records that it did", () => {
    setTugbankClient(bank(null) as never);
    const { deck, added } = makeDeck();
    expect(showGettingStartedOnce(deck as never)).toBe(true);
    expect(added).toEqual([["help", { doc: "getting-started" }, { origin: null }]]);
    expect(puts).toEqual([
      {
        url: "/api/defaults/dev.tugapp.app/getting-started-seen",
        body: { kind: "bool", value: true },
      },
    ]);
  });

  test("a second setup in the same launch opens nothing, before the write has come back", () => {
    // The cache still reads unseen: the launch's own latch is what answers.
    setTugbankClient(bank(null) as never);
    const { deck, added } = makeDeck();
    expect(showGettingStartedOnce(deck as never)).toBe(false);
    expect(added).toHaveLength(0);
    expect(puts).toHaveLength(1);
  });
});
