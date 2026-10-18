/**
 * A parked workspace keeps its sheets' floor claims, and a claim whose sheet
 * goes while its workspace is parked is dropped from the parked record. A
 * sheet that reports while its workspace is parked — a warm workspace's
 * picker — claims on the parked record.
 *
 * A parked layer stays mounted with its sheets up, so the claim is still the
 * floor its card needs when the workspace comes back. Stripped at the park,
 * the member fell back to its ordinary floor and the return resized the pane
 * once the sheet re-reported — after the switch had landed (`at0620`). Kept,
 * the one way it could go stale is its sheet going while nobody is looking,
 * and that drop lands on the record the return swaps in.
 *
 * Read over a real `DeckManager` mounted into a jsdom container.
 *
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/spaces.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { DeckManager } from "../deck-manager";
import { installJsdom, mountDeck, onePaneDeck, unmountDeck, type JsdomSubstrate } from "./jsdom-deck";

let substrate: JsdomSubstrate;
let manager: DeckManager;
let one: string;

beforeEach(async () => {
  substrate = installJsdom();
  manager = await mountDeck(substrate, { ...onePaneDeck("hello", ["card-1"]), sheetReservations: { "pane-1": 300 } });
  one = manager.getSpacesSnapshot().activeSpaceId;
  manager.createSpace("Two");
});

afterEach(async () => {
  await unmountDeck(substrate, manager);
});

describe("a parked workspace's sheet claims", () => {
  test("are kept at the park and come back with the workspace", () => {
    expect(manager.getSpaceDeck(one)?.sheetReservations).toEqual({ "pane-1": 300 });
    manager.activateSpace(one);
    expect(manager.getSnapshot().sheetReservations).toEqual({ "pane-1": 300 });
  });

  test("are dropped from the parked record when the sheet goes while parked", () => {
    manager.setSheetReservation("pane-1", null);
    const parked = manager.getSpaceDeck(one);
    expect(parked !== null && "sheetReservations" in parked).toBe(false);
    manager.activateSpace(one);
    expect(manager.getSnapshot().sheetReservations).toBeUndefined();
  });

  test("take a report made while parked, and come back with it", () => {
    manager.setParkedSheetReservation(one, "pane-1", 420);
    expect(manager.getSpaceDeck(one)?.sheetReservations).toEqual({ "pane-1": 420 });
    manager.activateSpace(one);
    expect(manager.getSnapshot().sheetReservations).toEqual({ "pane-1": 420 });
  });

  test("a parked report leaves the shown workspace alone, and is a no-op on it", () => {
    const shown = manager.getSpacesSnapshot().activeSpaceId;
    const before = manager.getSnapshot().sheetReservations;
    manager.setParkedSheetReservation(shown, "pane-1", 420);
    expect(manager.getSnapshot().sheetReservations).toBe(before);
    manager.setParkedSheetReservation(one, "pane-1", null);
    const parked = manager.getSpaceDeck(one);
    expect(parked !== null && "sheetReservations" in parked).toBe(false);
  });
});
