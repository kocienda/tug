/**
 * A key-card menu command goes to the key body when the deck's first
 * responder is a body card and no shell surface holds the chain ahead of it;
 * every other routing, a shell card, and a shell surface in front all keep
 * the command in the shell. On the test bus, the shell's `dispatchCommand`
 * sends it to the key card's body as `command`, and to no other body.
 *
 * @covers tugdeck/src/lib/body-command-route.ts
 * @covers tugdeck/src/bus/command-route.ts
 * @covers tugdeck/src/command-dispatch.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import { COMMANDS_BY_ID } from "../../components/tugways/command-registry";
import { _resetForTest, dispatchAction, registerAction } from "../../action-dispatch";
import { dispatchCommand } from "../../command-dispatch";
import { installKeyCardRoute, ownerOf } from "../../bus/command-route";
import { commandForCard, type CommandPayload } from "../../bus/declarations/verbs";
import { createTestBus, type TestBus } from "../../bus/test-bus";
import {
  bodyCommandRoute,
  bodyUnhandledRoute,
  keyboardBodyFor,
  shellResponderAboveCard,
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

  test("keeps a first-responder command in the shell while the shell's chain stands above the card", () => {
    // ⌘D with the chain on the deck canvas: a walk from there passes through
    // no card, so no composer's mic opens (at0648).
    expect(bodyCommandRoute(facts({ routing: "first-responder", shellResponderAbove: true }))).toBe(null);
    // A key-card command starts at the key card whatever the chain holds.
    expect(bodyCommandRoute(facts({ routing: "key-card", shellResponderAbove: true }))).toBe("body-card");
    expect(bodyCommandRoute(facts({ routing: "registry", owner: "key-card", shellResponderAbove: true }))).toBe("body-card");
  });

  test("forwards a registry command whose row names the key card its owner", () => {
    expect(bodyCommandRoute(facts({ routing: "registry", owner: "key-card" }))).toBe("body-card");
    expect(bodyCommandRoute(facts({ routing: "registry", owner: "shell" }))).toBe(null);
  });

  test("keeps the walk's steps in the shell while the shell holds a stop of the card's", () => {
    for (const id of [TUG_ACTIONS.NEXT_KEYBOARD_FOCUS, TUG_ACTIONS.PREVIOUS_KEYBOARD_FOCUS]) {
      const step = { id, routing: "registry" as const, owner: "key-card" as const };
      expect(bodyCommandRoute(facts({ ...step, shellHoldsStop: () => true }))).toBe(null);
      expect(bodyCommandRoute(facts({ ...step, shellHoldsStop: () => false }))).toBe("body-card");
    }
  });
});

describe("ownerOf", () => {
  test("a chain routing is the key card's, registry the shell's, native AppKit's", () => {
    expect(ownerOf({ routing: "first-responder" })).toBe("key-card");
    expect(ownerOf({ routing: "key-card" })).toBe("key-card");
    expect(ownerOf({ routing: "target" })).toBe("key-card");
    expect(ownerOf({ routing: "registry" })).toBe("shell");
    expect(ownerOf({ routing: "native" })).toBe("here");
  });

  test("the handlers a body registers for its own card name the key card their owner", () => {
    // `bindBody` registers these, and `registerRunCardCommand` the last: a
    // shell-owned row would run in the shell, where the card has no stops,
    // no cycle and no surface map.
    for (const id of [
      TUG_ACTIONS.NEXT_KEYBOARD_FOCUS,
      TUG_ACTIONS.PREVIOUS_KEYBOARD_FOCUS,
      TUG_ACTIONS.CYCLE_FOCUS_MODE,
      "run-card-command",
    ]) {
      const entry = COMMANDS_BY_ID.get(id);
      expect(entry?.routing).toBe("registry");
      expect(entry === undefined ? null : ownerOf(entry)).toBe("key-card");
    }
  });
});

describe("a key-card command dispatched in the shell", () => {
  let bus: TestBus;
  const releases: Array<() => void> = [];
  afterEach(() => {
    for (const release of releases.splice(0)) release();
    bus?.dispose();
    _resetForTest();
  });

  /** A shell whose key card is `key`, and two bodies that record what reaches them. */
  async function stand(route: { key: string | null; ahead?: boolean; holdsStop?: boolean }) {
    bus = createTestBus();
    const shell = bus.shell();
    bus.install(shell);
    const received: Record<string, CommandPayload[]> = { A: [], B: [] };
    for (const card of ["A", "B"]) {
      const page = bus.body(card, "session");
      commandForCard.on(page.bus).handle((payload) => received[card].push(payload));
    }
    const sent: string[] = [];
    releases.push(
      installKeyCardRoute({
        target: (entry) =>
          bodyCommandRoute({
            id: entry.id,
            routing: entry.routing,
            owner: entry.owner,
            firstResponderCardId: route.key,
            isBodyCard: (id) => id === "A" || id === "B",
            shellResponderAhead: route.ahead === true,
            shellHoldsStop: () => route.holdsStop === true,
          }),
        sent: (cardId) => sent.push(cardId),
        walkEdge: () => false,
      }),
    );
    await bus.flush();
    return { received, sent };
  }

  test("reaches the key card's body, and no other body", async () => {
    const { received, sent } = await stand({ key: "A" });
    expect(dispatchCommand(TUG_ACTIONS.TOGGLE_CHANGES_VIEW)).toBe(true);
    // A menu's `run-card-command` with arguments rides the same action.
    dispatchAction({ action: "run-card-command", name: "resume", args: "quiet-harbor" });
    await bus.flush();
    expect(received.A).toEqual([
      { id: TUG_ACTIONS.TOGGLE_CHANGES_VIEW },
      { id: "run-card-command", payload: { action: "run-card-command", name: "resume", args: "quiet-harbor" } },
    ]);
    expect(received.B).toEqual([]);
    // The keyboard follows each one into the body.
    expect(sent).toEqual(["A", "A"]);
  });

  test("runs in the shell while a shell surface holds the chain ahead of the card", async () => {
    const { received } = await stand({ key: "A", ahead: true });
    const ran: string[] = [];
    registerAction(TUG_ACTIONS.CYCLE_FOCUS_MODE, () => ran.push("cycle"));
    expect(dispatchCommand(TUG_ACTIONS.CYCLE_FOCUS_MODE)).toBe(true);
    await bus.flush();
    expect(ran).toEqual(["cycle"]);
    expect(received.A).toEqual([]);
  });

  test("a walk step stays in the shell while it holds a stop of the card's", async () => {
    const { received } = await stand({ key: "A", holdsStop: true });
    const ran: string[] = [];
    registerAction(TUG_ACTIONS.NEXT_KEYBOARD_FOCUS, () => ran.push("next"));
    dispatchCommand(TUG_ACTIONS.NEXT_KEYBOARD_FOCUS);
    await bus.flush();
    expect(ran).toEqual(["next"]);
    expect(received.A).toEqual([]);
  });

  test("a registry command with no owner of its own stays in the shell", async () => {
    const { received } = await stand({ key: "A" });
    const entry = [...COMMANDS_BY_ID.values()].find((e) => e.routing === "registry" && e.owner === undefined);
    expect(entry).toBeDefined();
    dispatchCommand(entry!.id);
    await bus.flush();
    expect(received.A).toEqual([]);
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

  const above = (responder: string | null) => shellResponderAboveCard({ responder, paneId: "pane", cardId: "card", isWithin });

  test("only the deck above the pane stands above the card", () => {
    expect(above("deck")).toBe(true);
    expect(above("card")).toBe(false);
    expect(above("pane")).toBe(false);
    expect(above("popover")).toBe(false);
    expect(above("overview")).toBe(false);
    expect(above(null)).toBe(false);
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
