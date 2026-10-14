/**
 * A key-card menu command goes to the key body when the deck's first
 * responder is a body card and no shell surface holds the chain ahead of it;
 * every other routing, a shell card, and a shell surface in front all keep
 * the command in the shell.
 *
 * @covers tugdeck/src/lib/body-command-route.ts
 */
import { describe, expect, test } from "bun:test";
import { bodyCommandRoute, shellSurfaceAhead, type BodyCommandFacts } from "../body-command-route";

const bodies = new Set(["body-card"]);

function facts(over: Partial<BodyCommandFacts>): BodyCommandFacts {
  return {
    routing: "first-responder",
    firstResponderCardId: "body-card",
    isBodyCard: (id) => bodies.has(id),
    shellResponderAhead: false,
    ...over,
  };
}

describe("bodyCommandRoute", () => {
  test("forwards first-responder and key-card commands on a body card", () => {
    expect(bodyCommandRoute(facts({ routing: "first-responder" }))).toBe("body-card");
    expect(bodyCommandRoute(facts({ routing: "key-card" }))).toBe("body-card");
  });

  test("never forwards registry, target or native commands", () => {
    expect(bodyCommandRoute(facts({ routing: "registry" }))).toBe(null);
    expect(bodyCommandRoute(facts({ routing: "target" }))).toBe(null);
    expect(bodyCommandRoute(facts({ routing: "native" }))).toBe(null);
  });

  test("keeps the command in the shell for a shell card or no card", () => {
    expect(bodyCommandRoute(facts({ firstResponderCardId: "shell-card" }))).toBe(null);
    expect(bodyCommandRoute(facts({ firstResponderCardId: null }))).toBe(null);
  });

  test("keeps the command in the shell while a shell surface holds the chain", () => {
    expect(bodyCommandRoute(facts({ shellResponderAhead: true }))).toBe(null);
    expect(bodyCommandRoute(facts({ routing: "key-card", shellResponderAhead: true }))).toBe(null);
  });
});

describe("shellSurfaceAhead", () => {
  // deck → pane → card → popover, as the shell's chain parents them.
  const parents: Record<string, string | null> = { deck: null, pane: "deck", card: "pane", popover: "card", overview: "deck" };
  const isWithin = (id: string, ancestorId: string): boolean => {
    for (let at: string | null = id; at !== null; at = parents[at] ?? null) if (at === ancestorId) return true;
    return false;
  };
  const ahead = (responder: string | null) => shellSurfaceAhead({ responder, paneId: "pane", cardId: "card", isWithin });

  test("the card's own node, its pane and the deck above it are the card", () => {
    // Focusing a card in the shell makes its own node first responder; a
    // menu command must still reach its body from there.
    expect(ahead("card")).toBe(false);
    expect(ahead("pane")).toBe(false);
    expect(ahead("deck")).toBe(false);
  });

  test("a shell surface in the card or beside it is ahead", () => {
    expect(ahead("popover")).toBe(true);
    expect(ahead("overview")).toBe(true);
  });

  test("no responder or no pane is nothing ahead", () => {
    expect(ahead(null)).toBe(false);
    expect(shellSurfaceAhead({ responder: "popover", paneId: null, cardId: null, isWithin })).toBe(false);
  });
});
