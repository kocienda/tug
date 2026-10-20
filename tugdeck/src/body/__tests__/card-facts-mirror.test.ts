/**
 * What a body page mirrors of the shell's cards, and the one fact it takes
 * for its own card: the arc that card's session is mated to.
 *
 * A bind through a door that names no card (`tugtool arc bind`, `arc
 * create`'s auto-bind) is answered by the shell, which holds every card's
 * binding. The page's own card follows the shell's arc when the shell's
 * moves, and only then, so a bind the page heard first is not undone by a
 * mirror push the shell sent before it had heard the same bind.
 *
 * @covers tugdeck/src/body/card-facts-mirror.ts
 */
import { afterEach, describe, expect, test } from "bun:test";

import { createCardFactsMirror } from "../card-facts-mirror";
import { cardSessionBindingStore, type CardSessionBinding } from "../../lib/card-session-binding-store";

const OWN = "own-card";
const OTHER = "other-card";

function binding(over: Partial<CardSessionBinding> = {}): CardSessionBinding {
  return {
    tugSessionId: "sess-own",
    lineId: "line-own",
    workspaceKey: "/work/alpha",
    projectDir: "/work/alpha",
    sessionMode: "new",
    ...over,
  };
}

const arcOf = (cardId: string) => cardSessionBindingStore.getBinding(cardId)?.arc ?? null;

afterEach(() => cardSessionBindingStore.clearAll());

describe("the card facts mirror", () => {
  test("the page's own card takes the arc the shell holds for it, and nothing else", () => {
    // The page's own binding, from its own spawn.
    cardSessionBindingStore.setBinding(OWN, binding());
    const mirror = createCardFactsMirror(OWN);
    const made = { id: "arc-made", name: "made" };
    mirror({ [OWN]: binding({ tugSessionId: "sess-shell-view", arc: made }) }, {}, {}, {});
    expect(arcOf(OWN)).toEqual(made);
    // The rest of the own card's binding stays the page's.
    expect(cardSessionBindingStore.getBinding(OWN)?.tugSessionId).toBe("sess-own");
  });

  test("a bind the page heard first stands until the shell's arc moves", () => {
    cardSessionBindingStore.setBinding(OWN, binding());
    const mirror = createCardFactsMirror(OWN);
    mirror({ [OWN]: binding() }, {}, {}, {});
    // The page hears its own bind before the shell does.
    const known = { id: "arc-known", name: "known" };
    cardSessionBindingStore.setArcBinding(OWN, known);
    // A push the shell sent before it heard the bind: its arc has not moved.
    mirror({ [OWN]: binding(), [OTHER]: binding({ tugSessionId: "sess-other" }) }, {}, {}, {});
    expect(arcOf(OWN)).toEqual(known);
    // The shell agrees, then unbinds: the page follows each move.
    mirror({ [OWN]: binding({ arc: known }) }, {}, {}, {});
    expect(arcOf(OWN)).toEqual(known);
    mirror({ [OWN]: binding() }, {}, {}, {});
    expect(arcOf(OWN)).toBeNull();
  });

  test("another card's binding is mirrored whole, and cleared when the shell drops it", () => {
    const mirror = createCardFactsMirror(OWN);
    const other = binding({ tugSessionId: "sess-other", arc: { id: "a", name: "a" } });
    mirror({ [OTHER]: other }, {}, {}, {});
    expect(cardSessionBindingStore.getBinding(OTHER)).toEqual(other);
    mirror({}, {}, {}, {});
    expect(cardSessionBindingStore.getBinding(OTHER)).toBeUndefined();
  });
});
