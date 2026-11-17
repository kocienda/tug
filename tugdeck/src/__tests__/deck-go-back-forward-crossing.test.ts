/**
 * Back and Forward across workspaces: a step whose card is in a parked
 * workspace switches to that workspace and arrives on the card, in the
 * switch's one commit, and records no visit of its own.
 *
 * The deck is two workspaces: `One` holding card-1 and card-2, `Two` holding
 * card-3 and card-4. Each case walks the reader through both and then steps.
 *
 * Read over a real `DeckManager` mounted into a jsdom container.
 *
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/lib/focus-trail.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { DeckManager } from "../deck-manager";
import { installJsdom, mountDeck, onePaneDeck, settle, unmountDeck, type JsdomSubstrate } from "./jsdom-deck";

let substrate: JsdomSubstrate;
let manager: DeckManager;
let one: string;
let two: string;

/** Where the reader is: the shown workspace and the focused card. */
function here(): { space: string; card: string | null } {
  return {
    space: manager.getSpacesSnapshot().activeSpaceId === one ? "one" : "two",
    card: manager.getFirstResponderCardId(),
  };
}

beforeEach(async () => {
  substrate = installJsdom();
  // Two panes, because a card moves between workspaces with its whole pane.
  const seed = onePaneDeck("hello", ["card-1", "card-2"]);
  const far = onePaneDeck("hello", ["card-3", "card-4"]);
  manager = await mountDeck(
    substrate,
    {
      ...seed,
      cards: [...seed.cards, ...far.cards],
      panes: [
        { ...far.panes[0], id: "pane-2", position: { x: 660, y: 20 } },
        seed.panes[0],
      ],
    },
    { focusCardId: "card-1" },
  );
  one = manager.getSpacesSnapshot().activeSpaceId;
  two = manager.createSpace("Two");
  manager.activateSpace(one);
  expect(manager.moveCardToSpace("card-3", two)).toBe(true);
  await settle();
  // The reader's walk: card-1, then Two's card-3 and card-4, then back to One.
  manager.activateCard("card-1");
  manager.activateSpace(two);
  manager.activateCard("card-3");
  manager.activateCard("card-4");
  manager.activateSpace(one);
  await settle();
  expect(here()).toEqual({ space: "one", card: "card-1" });
});

afterEach(async () => {
  await unmountDeck(substrate, manager);
});

describe("Back and Forward across workspaces", () => {
  test("Back crosses into the parked workspace and lands on its card", async () => {
    expect(manager.canGoBack()).toBe(true);
    expect(manager.goBack()).toBe(true);
    await settle();
    expect(here()).toEqual({ space: "two", card: "card-4" });
  });

  test("the crossing is one commit that already names the card", () => {
    const heard: string[] = [];
    const stop = manager.subscribeSync(() => heard.push(`notify ${manager.getFirstResponderCardId()}`));
    try {
      manager.goBack();
    } finally {
      stop();
    }
    expect(heard).toEqual(["notify card-4"]);
  });

  test("Forward returns across the boundary, and neither crossing is a visit", async () => {
    manager.goBack();
    await settle();
    // Had the arrival on card-4 been recorded, nothing would lie ahead.
    expect(manager.canGoForward()).toBe(true);
    expect(manager.goForward()).toBe(true);
    await settle();
    expect(here()).toEqual({ space: "one", card: "card-1" });
    // And had the return been recorded, Forward would now have somewhere to
    // go and Back would lead to card-4 through a visit that was never made.
    expect(manager.canGoForward()).toBe(false);
    const walked: (string | null)[] = [];
    while (manager.goBack()) {
      await settle();
      walked.push(here().card);
    }
    expect(walked).toEqual(["card-4", "card-3", "card-1"]);
    expect(here().space).toBe("one");
  });

  test("a step inside the arrived workspace stays in it", async () => {
    manager.goBack();
    manager.goBack();
    await settle();
    expect(here()).toEqual({ space: "two", card: "card-3" });
  });

  test("the card a switch arrives on gives way to the card the reader then picks", async () => {
    // Setup left the reader in One on card-1, arrived there by a switch from
    // card-4. Switch to Two, which remembers card-4, and pick card-3 instead.
    manager.activateSpace(two);
    await settle();
    expect(here()).toEqual({ space: "two", card: "card-4" });
    manager.activateCard("card-3");
    await settle();
    // Back goes to the card the reader left, across the boundary, and not to
    // card-4, which the switch chose and the reader did not.
    expect(manager.goBack()).toBe(true);
    await settle();
    expect(here()).toEqual({ space: "one", card: "card-1" });
  });

  test("the card a switch arrives on is kept when the reader stays on it", async () => {
    manager.activateSpace(two);
    await settle();
    expect(here()).toEqual({ space: "two", card: "card-4" });
    manager.activateSpace(one);
    await settle();
    expect(manager.goBack()).toBe(true);
    await settle();
    expect(here()).toEqual({ space: "two", card: "card-4" });
  });

  test("a card closed in the other workspace is passed over", async () => {
    // Close card-4 where it stands, then come back to One.
    manager.activateSpace(two);
    const pane = manager.getSnapshot().panes.find((p) => p.cardIds.includes("card-4"));
    expect(pane).toBeDefined();
    manager.activateCard("card-3");
    manager.removeCard(pane!.id, "card-4");
    manager.activateSpace(one);
    await settle();
    expect(here()).toEqual({ space: "one", card: "card-1" });
    // The trail behind card-1 is now card-3, then the closed card-4, then
    // card-3 and card-1 again: Back lands on card-3 across the boundary.
    expect(manager.goBack()).toBe(true);
    await settle();
    expect(here()).toEqual({ space: "two", card: "card-3" });
    expect(manager.goBack()).toBe(true);
    await settle();
    expect(here()).toEqual({ space: "one", card: "card-1" });
  });
});
