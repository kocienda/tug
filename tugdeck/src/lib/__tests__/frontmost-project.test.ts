import { afterEach, describe, expect, test } from "bun:test";

import {
  cardSessionBindingStore,
  type CardSessionBinding,
} from "../card-session-binding-store";
import type { CardDeck } from "../../card-deck";
import { registerCardDeck } from "../deck-store-registry";
import {
  _resetRelayedFrontmostProjectForTest,
  frontmostProjectBinding,
  relayFrontmostProjectBinding,
  relayWorkspaceProjectDirs,
  workspaceProjectDirs,
} from "../frontmost-project";

const binding = (projectDir: string): CardSessionBinding =>
  ({ tugSessionId: "s1", lineId: "l1", workspaceKey: "w1", projectDir }) as unknown as CardSessionBinding;

const BOUND_CARDS = ["a1", "a2", "b1", "c1"];

afterEach(() => {
  _resetRelayedFrontmostProjectForTest();
  registerCardDeck(null);
  for (const cardId of BOUND_CARDS) cardSessionBindingStore.clearBinding(cardId);
});

/** A deck of panes, back to front, as the walk reads it. */
function deckOf(panes: { activeCardId: string; cardIds: string[] }[]): CardDeck {
  return {
    getSnapshot: () => ({ panes }),
    subscribe: () => () => {},
  } as unknown as CardDeck;
}

describe("frontmostProjectBinding on a body page", () => {
  test("answers with the shell's relayed binding, and with its null", () => {
    const p = binding("/p");
    relayFrontmostProjectBinding(p);
    expect(frontmostProjectBinding()).toBe(p);
    relayFrontmostProjectBinding(null);
    expect(frontmostProjectBinding()).toBeNull();
  });

  test("an equal relay keeps the held reference, so a snapshot does not churn", () => {
    const first = binding("/p");
    relayFrontmostProjectBinding(first);
    relayFrontmostProjectBinding(binding("/p"));
    expect(frontmostProjectBinding()).toBe(first);
    const moved = binding("/q");
    relayFrontmostProjectBinding(moved);
    expect(frontmostProjectBinding()).toBe(moved);
  });
});

describe("workspaceProjectDirs — the workspace's project set", () => {
  test("is every bound card's project, frontmost pane first, active card first, deduplicated", () => {
    cardSessionBindingStore.setBinding("a1", binding("/back"));
    cardSessionBindingStore.setBinding("a2", binding("/shared"));
    cardSessionBindingStore.setBinding("b1", binding("/front-tab"));
    cardSessionBindingStore.setBinding("c1", binding("/shared"));
    registerCardDeck(
      deckOf([
        // Back pane: its active card is a2, so /shared is read before /back.
        { activeCardId: "a2", cardIds: ["a1", "a2"] },
        // Front pane: its active card is unbound; its background tab is not.
        { activeCardId: "unbound", cardIds: ["unbound", "b1", "c1"] },
      ]),
    );
    expect(workspaceProjectDirs()).toEqual(["/front-tab", "/shared", "/back"]);
  });

  test("is empty when no card is bound, and stable while the set is unchanged", () => {
    registerCardDeck(deckOf([{ activeCardId: "x", cardIds: ["x"] }]));
    expect(workspaceProjectDirs()).toEqual([]);
    cardSessionBindingStore.setBinding("b1", binding("/p"));
    registerCardDeck(deckOf([{ activeCardId: "b1", cardIds: ["b1"] }]));
    const first = workspaceProjectDirs();
    expect(workspaceProjectDirs()).toBe(first);
  });

  test("on a body page answers with the shell's relayed set, keeping an equal one's reference", () => {
    const relayed = ["/p", "/q"];
    relayWorkspaceProjectDirs(relayed);
    expect(workspaceProjectDirs()).toBe(relayed);
    relayWorkspaceProjectDirs(["/p", "/q"]);
    expect(workspaceProjectDirs()).toBe(relayed);
  });
});
