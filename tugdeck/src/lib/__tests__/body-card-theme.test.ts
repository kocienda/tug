/**
 * The `card.theme` the shell publishes for a body is its own workspace's:
 * a parked card wears its parked workspace's theme whatever theme is on
 * screen, a shown card its shown workspace's, and a card moved to another
 * workspace that workspace's. A workspace that names no theme wears the
 * screen's.
 *
 * @covers tugdeck/src/lib/body-shell.ts
 */
import { describe, expect, test } from "bun:test";

import { getOnScreenTheme } from "../../contexts/theme-provider";
import type { IDeckManagerStore } from "../../deck-manager-store";
import { cardThemeOf } from "../body-shell";

/** A shell showing `one` (ironclad) with `two` (sloop) parked and `three` naming no theme. */
function shell(placed: Record<string, string>): IDeckManagerStore {
  const spaces = {
    spaces: [
      { id: "one", name: "One", theme: "ironclad" },
      { id: "two", name: "Two", theme: "sloop" },
      { id: "three", name: "Three" },
    ],
    activeSpaceId: "one",
    mountedSpaceIds: ["one", "two", "three"],
  };
  return {
    getSpacesSnapshot: () => spaces,
    spaceOf: (cardId: string) => placed[cardId] ?? null,
  } as unknown as IDeckManagerStore;
}

describe("cardThemeOf", () => {
  test("a parked card wears its own workspace's theme, not the shown one's", () => {
    expect(cardThemeOf(shell({ k: "two" }), "k")).toBe("sloop");
  });

  test("a shown card wears the shown workspace's theme", () => {
    expect(cardThemeOf(shell({ a: "one" }), "a")).toBe("ironclad");
  });

  test("a card moved to another workspace wears that workspace's theme", () => {
    const placed: Record<string, string> = { k: "two" };
    const deck = shell(placed);
    expect(cardThemeOf(deck, "k")).toBe("sloop");
    placed.k = "one";
    expect(cardThemeOf(deck, "k")).toBe("ironclad");
  });

  test("a card the deck places nowhere reads the shown workspace", () => {
    expect(cardThemeOf(shell({}), "x")).toBe("ironclad");
  });

  test("a workspace naming no theme wears the screen's", () => {
    expect(cardThemeOf(shell({ t: "three" }), "t")).toBe(getOnScreenTheme());
  });
});
