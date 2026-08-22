/**
 * The column badge's two facts, as truth tables.
 *
 * `columnBadgeCharacter` and `columnBadgeLit` ARE the badge's rendered
 * `data-` attributes and its text — the component does nothing else with the
 * props it is handed — so pinning them here pins the whole of the badge's
 * logic. That the component actually writes them onto the DOM is an app-test's
 * claim; there is no DOM substrate under `bun:test` and a render test would be
 * a banned shape.
 */

import { describe, expect, test } from "bun:test";

import {
  columnBadgeCharacter,
  columnBadgeLit,
} from "../tug-column-badge";

describe("columnBadgeCharacter", () => {
  test("a stack draws how many cards share the slot", () => {
    expect(columnBadgeCharacter("stack", 2)).toBe("2");
    expect(columnBadgeCharacter("stack", 3)).toBe("3");
    expect(columnBadgeCharacter("stack", 4)).toBe("4");
    expect(columnBadgeCharacter("stack", 5)).toBe("5");
  });

  test("a stack's character ignores the member index", () => {
    // A visible card in a stack is the top one by construction, so nothing
    // downstream should be able to make a stack say a position.
    expect(columnBadgeCharacter("stack", 3, 2)).toBe("3");
  });

  test("a split draws its band letter, A at the topmost band", () => {
    expect(columnBadgeCharacter("split", 2, 0)).toBe("A");
    expect(columnBadgeCharacter("split", 2, 1)).toBe("B");
    expect(columnBadgeCharacter("split", 3, 1)).toBe("B");
    expect(columnBadgeCharacter("split", 4, 2)).toBe("C");
    expect(columnBadgeCharacter("split", 4, 3)).toBe("D");
  });

  test("a split with no index given reads as the topmost band", () => {
    expect(columnBadgeCharacter("split", 2)).toBe("A");
  });
});

describe("columnBadgeLit", () => {
  test("a run of two marks the end its member sits at", () => {
    expect(columnBadgeLit(2, 0)).toBe("top");
    expect(columnBadgeLit(2, 1)).toBe("bottom");
  });

  test("a run of three marks top, middle, bottom in order", () => {
    expect(columnBadgeLit(3, 0)).toBe("top");
    expect(columnBadgeLit(3, 1)).toBe("middle");
    expect(columnBadgeLit(3, 2)).toBe("bottom");
  });

  test("every interior member of a deeper run answers middle", () => {
    // The glyph names a REGION and the character names the exact position,
    // which is why the run is three elements however deep the place runs.
    expect(columnBadgeLit(4, 1)).toBe("middle");
    expect(columnBadgeLit(4, 2)).toBe("middle");
    expect(columnBadgeLit(6, 3)).toBe("middle");
    expect(columnBadgeLit(6, 4)).toBe("middle");
    expect(columnBadgeLit(6, 5)).toBe("bottom");
  });

  test("no index given reads as the front of the run", () => {
    expect(columnBadgeLit(3)).toBe("top");
  });
});
