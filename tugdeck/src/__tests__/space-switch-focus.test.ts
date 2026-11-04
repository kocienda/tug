/**
 * A workspace switch raises the arriving workspace's focused card inside the
 * swap's one commit: the first arrangement any subscriber reads names it, no
 * second commit follows to light it, and the responder chain's key is the
 * card once the switch returns.
 *
 * Read over a real `DeckManager` mounted into a jsdom container.
 *
 * @covers tugdeck/src/deck-manager.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { DeckManager } from "../deck-manager";
import { installJsdom, mountDeck, onePaneDeck, unmountDeck, type JsdomSubstrate } from "./jsdom-deck";

let substrate: JsdomSubstrate;
let manager: DeckManager;
let one: string;

beforeEach(async () => {
  substrate = installJsdom();
  manager = await mountDeck(substrate, onePaneDeck("hello", ["card-1"]));
  one = manager.getSpacesSnapshot().activeSpaceId;
  manager.activateCard("card-1");
  manager.createSpace("Two");
});

afterEach(async () => {
  await unmountDeck(substrate, manager);
});

describe("a workspace switch's focus", () => {
  test("is named by the one switched arrangement", () => {
    const heard: string[] = [];
    const stopNotify = manager.subscribeSync(() => heard.push(`notify ${manager.getFirstResponderCardId()}`));
    try {
      manager.activateSpace(one);
    } finally {
      stopNotify();
    }
    expect(heard).toEqual(["notify card-1"]);
    expect(manager.getFirstResponderCardId()).toBe("card-1");
  });
});
