/**
 * A parked workspace's arrangement is re-solved when the canvas comes to rest
 * at a new size, so the switch that shows it finds nothing left to move.
 *
 * Every workspace is mounted, its layer laid out from its parked record, so a
 * record solved for a canvas that no longer exists would stand wrong until
 * its switch re-solved it. `resolveParkedArrangements` solves each parked
 * record as the switch would; the switch's own re-solve then changes nothing,
 * and a re-solve that moves nothing writes nothing.
 *
 * Read over a real `DeckManager` mounted into a jsdom container.
 *
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/spaces-store.ts
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
  manager.createSpace("Two");
});

afterEach(async () => {
  await unmountDeck(substrate, manager);
});

describe("a parked workspace's arrangement", () => {
  test("is solved as its switch would solve it, so the switch moves nothing", () => {
    manager.resolveParkedArrangements();
    const parked = manager.getSpaceDeck(one);
    expect(parked).not.toBeNull();
    manager.activateSpace(one);
    const shown = manager.getSnapshot();
    expect(shown.panes).toEqual(parked!.panes);
    expect([shown.flowOffset, shown.columnOffsets, shown.railOffsets]).toEqual([parked!.flowOffset, parked!.columnOffsets, parked!.railOffsets]);
  });

  test("a re-solve that moves nothing writes nothing and tells nobody", () => {
    manager.resolveParkedArrangements();
    const before = manager.getSpacesSnapshot();
    let told = 0;
    const off = manager.subscribeSpaces(() => {
      told += 1;
    });
    manager.resolveParkedArrangements();
    off();
    expect(told).toBe(0);
    expect(manager.getSpacesSnapshot()).toBe(before);
  });

  test("leaves the shown deck as it was", () => {
    const shown = manager.getSnapshot();
    manager.resolveParkedArrangements();
    expect(manager.getSnapshot()).toBe(shown);
  });
});
