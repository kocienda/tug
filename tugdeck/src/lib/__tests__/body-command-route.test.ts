/**
 * A key-card menu command goes to the key body when the deck's first
 * responder is a body card and no shell surface holds the chain ahead of it;
 * every other routing, a shell card, and a shell surface in front all keep
 * the command in the shell.
 *
 * @covers tugdeck/src/lib/body-command-route.ts
 */
import { describe, expect, test } from "bun:test";
import {
  bodyCommandRoute,
  bodyUnhandledRoute,
  keyboardBodyFor,
  shellSurfaceAhead,
  type BodyCommandFacts,
} from "../body-command-route";
import { TUG_ACTIONS } from "../action-vocabulary";

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

describe("the deck's own verbs", () => {
  // Answered at the shell's chain root and by no card: the trip to the key
  // body and back made a workspace switch a beat late (at0663).
  test("stay in the shell whatever card is key", () => {
    for (const id of [
      TUG_ACTIONS.FOCUS_PANE,
      TUG_ACTIONS.ACTIVATE_SPACE,
      TUG_ACTIONS.NEW_SPACE,
      TUG_ACTIONS.RENAME_SPACE,
      TUG_ACTIONS.DUPLICATE_SPACE,
      TUG_ACTIONS.DELETE_SPACE,
    ]) {
      expect(bodyCommandRoute(facts({ id }))).toBe(null);
    }
  });

  test("a card's command still goes to the key body", () => {
    expect(bodyCommandRoute(facts({ id: TUG_ACTIONS.TOGGLE_CHANGES_VIEW, routing: "key-card" }))).toBe("body-card");
  });
});

describe("keyboardBodyFor", () => {
  const owner = (over: Partial<Parameters<typeof keyboardBodyFor>[0]>) =>
    keyboardBodyFor({
      firstResponderCardId: "body-card",
      isBodyCard: (id) => bodies.has(id),
      shellHoldsStop: () => false,
      shellTakesKeys: false,
      ...over,
    });

  test("the key body holds the keyboard at rest", () => {
    expect(owner({})).toBe("body-card");
  });

  test("a shell surface's trap or a shell gesture takes it to the shell", () => {
    // A title-bar menu, the masthead telemetry panel, a rail width drag: each
    // takes its Escape on the shell's window (at0574, at0423, at0677).
    expect(owner({ shellTakesKeys: true })).toBe(null);
  });

  test("a shell stop in the card's walk, a shell card or no card is the shell's", () => {
    expect(owner({ shellHoldsStop: () => true })).toBe(null);
    expect(owner({ firstResponderCardId: "shell-card" })).toBe(null);
    expect(owner({ firstResponderCardId: null })).toBe(null);
  });
});

describe("bodyUnhandledRoute", () => {
  test("Cancel goes to the shell without spending the key in the page", () => {
    // The shell's root takes Escape's last rung while a layout selection
    // stands, and a Cards row click puts the keyboard in another card's body
    // (at0451); the key still goes on to the page's editor and controls.
    expect(bodyUnhandledRoute(TUG_ACTIONS.CANCEL_DIALOG)).toBe("forward-unclaimed");
  });

  test("Undo and Redo stay in the page; anything else is the shell's", () => {
    expect(bodyUnhandledRoute(TUG_ACTIONS.UNDO)).toBe("decline");
    expect(bodyUnhandledRoute(TUG_ACTIONS.REDO)).toBe("decline");
    expect(bodyUnhandledRoute(TUG_ACTIONS.NUDGE_SLOT)).toBe("forward");
  });
});
