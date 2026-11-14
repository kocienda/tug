/**
 * The slot badge's two facts, as truth tables.
 *
 * `slotBadgeCharacter` and `slotBadgeLit` ARE the badge's rendered
 * `data-` attributes and its text — the component does nothing else with the
 * props it is handed — so pinning them here pins the whole of the badge's
 * logic. That the component actually writes them onto the DOM is an app-test's
 * claim; there is no DOM substrate under `bun:test` and a render test would be
 * a banned shape.
 */

import { describe, expect, test } from "bun:test";

import {
  slotBadgeCharacter,
  slotBadgeLit,
} from "../tug-slot-badge";

describe("slotBadgeCharacter", () => {
  test("a stack draws how many cards share the slot", () => {
    expect(slotBadgeCharacter("stack", 2)).toBe("2");
    expect(slotBadgeCharacter("stack", 3)).toBe("3");
    expect(slotBadgeCharacter("stack", 4)).toBe("4");
    expect(slotBadgeCharacter("stack", 5)).toBe("5");
  });

  test("a stack's character ignores the member index", () => {
    // A visible card in a stack is the top one by construction, so nothing
    // downstream should be able to make a stack say a position.
    expect(slotBadgeCharacter("stack", 3, 2)).toBe("3");
  });

  test("a split draws its band letter, A at the topmost band", () => {
    expect(slotBadgeCharacter("split", 2, 0)).toBe("A");
    expect(slotBadgeCharacter("split", 2, 1)).toBe("B");
    expect(slotBadgeCharacter("split", 3, 1)).toBe("B");
    expect(slotBadgeCharacter("split", 4, 2)).toBe("C");
    expect(slotBadgeCharacter("split", 4, 3)).toBe("D");
  });

  test("a split with no index given reads as the topmost band", () => {
    expect(slotBadgeCharacter("split", 2)).toBe("A");
  });
});

describe("slotBadgeLit", () => {
  test("a run of two marks the end its member sits at", () => {
    expect(slotBadgeLit(2, 0)).toBe("top");
    expect(slotBadgeLit(2, 1)).toBe("bottom");
  });

  test("a run of three marks top, middle, bottom in order", () => {
    expect(slotBadgeLit(3, 0)).toBe("top");
    expect(slotBadgeLit(3, 1)).toBe("middle");
    expect(slotBadgeLit(3, 2)).toBe("bottom");
  });

  test("every interior member of a deeper run answers middle", () => {
    // The glyph names a REGION and the character names the exact position,
    // which is why the run is three elements however deep the place runs.
    expect(slotBadgeLit(4, 1)).toBe("middle");
    expect(slotBadgeLit(4, 2)).toBe("middle");
    expect(slotBadgeLit(6, 3)).toBe("middle");
    expect(slotBadgeLit(6, 4)).toBe("middle");
    expect(slotBadgeLit(6, 5)).toBe("bottom");
  });

  test("no index given reads as the front of the run", () => {
    expect(slotBadgeLit(3)).toBe("top");
  });
});
