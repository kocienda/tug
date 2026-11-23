/**
 * The shell's search for a Docket card already on a docket: a card's own
 * report of what it shows outranks its bag, which for a body card is the seed
 * it opened with.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  _resetShownDocketsForTest,
  findDocketCardInDeck,
  openDocketInCard,
  recordShownDocket,
} from "@/lib/open-docket-in-card";
import type { CardDeck } from "@/card-deck";

function deck(cards: Array<{ id: string; componentId: string; content?: unknown }>) {
  return {
    getSnapshot: () => ({ cards: cards.map(({ id, componentId }) => ({ id, componentId })) }),
    getCardState: (id: string) => {
      const card = cards.find((c) => c.id === id);
      return card?.content === undefined ? undefined : { content: card.content };
    },
  } as unknown as Parameters<typeof findDocketCardInDeck>[0];
}

const TARGET = { projectDir: "/repo", docketId: "0a1b2c3d" };

afterEach(() => _resetShownDocketsForTest());

describe("findDocketCardInDeck", () => {
  test("a card's bag answers until the card reports", () => {
    const store = deck([{ id: "D", componentId: "docket", content: { ...TARGET } }]);
    expect(findDocketCardInDeck(store, TARGET)).toBe("D");
  });

  test("a card whose bag is only its seed is found by its report", () => {
    const store = deck([{ id: "D", componentId: "docket", content: { projectDir: "/repo" } }]);
    expect(findDocketCardInDeck(store, TARGET)).toBeNull();
    recordShownDocket("D", TARGET);
    expect(findDocketCardInDeck(store, TARGET)).toBe("D");
  });

  test("a report of another docket, or of none, outranks a bag that matches", () => {
    const store = deck([{ id: "D", componentId: "docket", content: { ...TARGET } }]);
    recordShownDocket("D", { projectDir: "/repo", docketId: "ffff0000" });
    expect(findDocketCardInDeck(store, TARGET)).toBeNull();
    recordShownDocket("D", null);
    expect(findDocketCardInDeck(store, TARGET)).toBeNull();
  });

  test("only Docket cards are searched", () => {
    recordShownDocket("S", TARGET);
    const store = deck([{ id: "S", componentId: "session" }]);
    expect(findDocketCardInDeck(store, TARGET)).toBeNull();
  });
});

describe("openDocketInCard", () => {
  test("a fresh card's seed carries the editor to open, beside the thread", () => {
    const added: Array<{ componentId: string; seed: unknown }> = [];
    const store = {
      getSnapshot: () => ({ cards: [], panes: [] }),
      getCardState: () => undefined,
      getFirstResponderCardId: () => null,
      invokeSaveCallback: () => {},
      addCard: (componentId: string, seed: unknown) => {
        added.push({ componentId, seed });
        return null;
      },
    } as unknown as CardDeck;
    openDocketInCard(store, { ...TARGET, thread: "idea:1a2b3c4d", editSketch: "3f9a1c2e" });
    expect(added).toEqual([
      {
        componentId: "docket",
        seed: { ...TARGET, thread: "idea:1a2b3c4d", editSketch: "3f9a1c2e" },
      },
    ]);
  });
});
