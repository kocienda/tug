/**
 * The selection-extending chords, read the way the macOS text system reads
 * them. `keyboardExtensionFor` is the whole of which chord moves the extent
 * how; the extender only applies its answer, so the mapping is asserted here
 * over plain data and the application in the real app (`at0759`).
 */

import { describe, expect, test } from "bun:test";

import { keyboardExtensionFor, type ChordKeys } from "../selection-extension";

function chord(key: string, mods: Partial<Omit<ChordKeys, "key">> = {}): ChordKeys {
  return {
    key,
    shiftKey: mods.shiftKey ?? true,
    altKey: mods.altKey ?? false,
    metaKey: mods.metaKey ?? false,
    ctrlKey: mods.ctrlKey ?? false,
  };
}

describe("keyboardExtensionFor", () => {
  test("⇧ with an arrow steps a character or a line", () => {
    expect(keyboardExtensionFor(chord("ArrowRight"))).toEqual({
      kind: "modify",
      direction: "forward",
      granularity: "character",
    });
    expect(keyboardExtensionFor(chord("ArrowLeft"))).toEqual({
      kind: "modify",
      direction: "backward",
      granularity: "character",
    });
    expect(keyboardExtensionFor(chord("ArrowDown"))).toEqual({
      kind: "modify",
      direction: "forward",
      granularity: "line",
    });
    expect(keyboardExtensionFor(chord("ArrowUp"))).toEqual({
      kind: "modify",
      direction: "backward",
      granularity: "line",
    });
  });

  test("⇧⌥ widens to a word across and a paragraph's edge down", () => {
    expect(keyboardExtensionFor(chord("ArrowRight", { altKey: true }))?.kind).toBe("modify");
    expect(keyboardExtensionFor(chord("ArrowLeft", { altKey: true }))).toEqual({
      kind: "modify",
      direction: "backward",
      granularity: "word",
    });
    expect(keyboardExtensionFor(chord("ArrowDown", { altKey: true }))).toEqual({
      kind: "modify",
      direction: "forward",
      granularity: "paragraphboundary",
    });
  });

  test("⇧⌘ widens to the line's edge across and the document's down, over ⌥", () => {
    expect(keyboardExtensionFor(chord("ArrowRight", { metaKey: true }))).toEqual({
      kind: "modify",
      direction: "forward",
      granularity: "lineboundary",
    });
    expect(keyboardExtensionFor(chord("ArrowUp", { metaKey: true, altKey: true }))).toEqual({
      kind: "modify",
      direction: "backward",
      granularity: "documentboundary",
    });
  });

  test("⇧Home and ⇧End reach the document's edges; ⇧Page keys step a page", () => {
    expect(keyboardExtensionFor(chord("Home"))).toEqual({
      kind: "modify",
      direction: "backward",
      granularity: "documentboundary",
    });
    expect(keyboardExtensionFor(chord("End"))).toEqual({
      kind: "modify",
      direction: "forward",
      granularity: "documentboundary",
    });
    expect(keyboardExtensionFor(chord("PageDown"))).toEqual({ kind: "page", direction: "forward" });
    expect(keyboardExtensionFor(chord("PageUp"))).toEqual({ kind: "page", direction: "backward" });
  });

  test("a chord that extends nothing is left alone", () => {
    // No ⇧: a caret move, the editor's.
    expect(keyboardExtensionFor(chord("ArrowRight", { shiftKey: false }))).toBeNull();
    // ⌃ chords belong to the bindings.
    expect(keyboardExtensionFor(chord("ArrowRight", { ctrlKey: true }))).toBeNull();
    // A printable, even shifted, is typing.
    expect(keyboardExtensionFor(chord("A"))).toBeNull();
    // ⇧⌘Home and ⇧⌥PageDown mean nothing here.
    expect(keyboardExtensionFor(chord("Home", { metaKey: true }))).toBeNull();
    expect(keyboardExtensionFor(chord("PageDown", { altKey: true }))).toBeNull();
  });
});
