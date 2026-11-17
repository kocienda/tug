/**
 * Back and Forward when the reader passes through a sidebar card: the rail is
 * the window's, so a landing on it is not a visit, and Back from it returns to
 * the last real card the reader was on.
 *
 * The shape is the one a reader makes switching workspaces from the
 * Workspaces card: a card in One, the sidebar card, the switch, a card in
 * Two. Counted as a visit, the sidebar card stood between the two
 * workspaces' cards, and Back from Two landed on it without crossing.
 *
 * Read over a real `DeckManager` mounted into a jsdom container.
 *
 * @covers tugdeck/src/deck-manager.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { registerCard } from "../card-registry";
import type { DeckManager } from "../deck-manager";
import { installJsdom, mountDeck, onePaneDeck, settle, unmountDeck, type JsdomSubstrate } from "./jsdom-deck";

// Sidebar-ness is the registry's fact, so the rail card has to be registered
// for the deck to treat it as the window's.
registerCard({
  componentId: "rail-card",
  contentFactory: () => null,
  defaultMeta: { title: "Rail", closable: true },
  layoutRole: "sidebar",
});

let substrate: JsdomSubstrate;
let manager: DeckManager;
let one: string;
let two: string;

function here(): { space: string; card: string | null } {
  return {
    space: manager.getSpacesSnapshot().activeSpaceId === one ? "one" : "two",
    card: manager.getFirstResponderCardId(),
  };
}

beforeEach(async () => {
  substrate = installJsdom();
  const seed = onePaneDeck("hello", ["card-1", "card-2"]);
  const far = onePaneDeck("hello", ["card-3", "card-4"]);
  manager = await mountDeck(
    substrate,
    {
      ...seed,
      cards: [...seed.cards, ...far.cards, { id: "rail-1", componentId: "rail-card", title: "Rail", closable: true }],
      panes: [
        { ...far.panes[0], id: "pane-2", position: { x: 660, y: 20 } },
        {
          ...seed.panes[0],
          id: "pane-rail",
          position: { x: 1300, y: 20 },
          cardIds: ["rail-1"],
          activeCardId: "rail-1",
        },
        seed.panes[0],
      ],
      imposition: { sidebars: { "rail-card": { side: "right" } } },
    },
    { focusCardId: "card-1" },
  );
  one = manager.getSpacesSnapshot().activeSpaceId;
  two = manager.createSpace("Two");
  manager.activateSpace(one);
  expect(manager.moveCardToSpace("card-3", two)).toBe(true);
  await settle();
});

afterEach(async () => {
  await unmountDeck(substrate, manager);
});

describe("Back and Forward past a sidebar card", () => {
  test("a switch made from the sidebar crosses back on the first Back", async () => {
    manager.activateCard("card-1");
    manager.activateCard("rail-1");
    manager.activateSpace(two);
    manager.activateCard("card-3");
    await settle();
    expect(here()).toEqual({ space: "two", card: "card-3" });

    expect(manager.goBack()).toBe(true);
    await settle();
    expect(here()).toEqual({ space: "one", card: "card-1" });
  });

  test("Back from the sidebar returns to the last real card, not the one before it", async () => {
    manager.activateCard("card-1");
    manager.activateCard("card-2");
    manager.activateCard("rail-1");
    await settle();
    expect(manager.canGoBack()).toBe(true);

    expect(manager.goBack()).toBe(true);
    await settle();
    expect(here()).toEqual({ space: "one", card: "card-2" });
    expect(manager.goBack()).toBe(true);
    await settle();
    expect(here()).toEqual({ space: "one", card: "card-1" });
  });

  test("standing on the sidebar right after a switch, Back crosses to the card left behind", async () => {
    manager.activateCard("card-2");
    manager.activateCard("rail-1");
    manager.activateSpace(two);
    // Where the switch arrived depends on Two's remembered focus; the reader
    // is standing on the sidebar, as after picking a row in the Workspaces card.
    manager.activateCard("rail-1");
    await settle();

    expect(manager.goBack()).toBe(true);
    await settle();
    expect(here()).toEqual({ space: "one", card: "card-2" });
  });
});
