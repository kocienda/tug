/**
 * session-dot-overlay.test.ts — the well contract, read as data.
 *
 * The bake writes these two attributes and the layer reads them, and the two
 * ends are in different files that never call each other. A disagreement about
 * either spelling does not throw: the layer's selector simply matches nothing
 * and every chip shows an empty pill. So the spellings are pinned here, and the
 * round trip is asserted in both directions rather than each end tested alone.
 */

import { describe, expect, test } from "bun:test";

import {
  ATOM_WELL_SELECTOR,
  ATOM_WELL_X_ATTR,
  ATOM_WELL_Y_ATTR,
  applyDotWellAttrs,
  readDotWell,
} from "@/lib/session-dot-overlay";

/**
 * The smallest thing that answers `getAttribute` / `setAttribute`. The module
 * holds no DOM and neither does this file — `Element` is the only type it names
 * and these two methods are the whole of what it calls on one.
 */
function fakeElement(initial: Record<string, string> = {}): Element {
  const attrs = new Map(Object.entries(initial));
  return {
    getAttribute: (name: string) => attrs.get(name) ?? null,
    setAttribute: (name: string, value: string) => void attrs.set(name, value),
  } as unknown as Element;
}

describe("the well attribute names", () => {
  test("are the spellings both ends agree on", () => {
    expect(ATOM_WELL_X_ATTR).toBe("data-atom-well-x");
    expect(ATOM_WELL_Y_ATTR).toBe("data-atom-well-y");
  });

  test("the layer's selector is built from them, not spelled again", () => {
    expect(ATOM_WELL_SELECTOR).toBe("img[data-atom-type][data-atom-well-x]");
    expect(ATOM_WELL_SELECTOR).toContain(`[${ATOM_WELL_X_ATTR}]`);
  });
});

describe("applyDotWellAttrs / readDotWell", () => {
  test("a well written is the well read", () => {
    const el = fakeElement();
    applyDotWellAttrs(el, { x: 8, y: 11 });
    expect(el.getAttribute(ATOM_WELL_X_ATTR)).toBe("8");
    expect(el.getAttribute(ATOM_WELL_Y_ATTR)).toBe("11");
    expect(readDotWell(el)).toEqual({ x: 8, y: 11 });
  });

  test("a fractional centre survives the round trip unrounded", () => {
    // The chip's geometry is CSS px and `iconX + fontSize / 2` lands on a half
    // pixel at the register's default size. Rounding here would move the dot
    // against the pixels it sits in.
    const el = fakeElement();
    applyDotWellAttrs(el, { x: 7.5, y: 10.5 });
    expect(readDotWell(el)).toEqual({ x: 7.5, y: 10.5 });
  });

  test("a chip with no well reads null", () => {
    expect(readDotWell(fakeElement())).toBeNull();
  });

  test("one half alone reads null rather than a half-known centre", () => {
    expect(readDotWell(fakeElement({ [ATOM_WELL_X_ATTR]: "8" }))).toBeNull();
    expect(readDotWell(fakeElement({ [ATOM_WELL_Y_ATTR]: "11" }))).toBeNull();
  });

  test("an empty attribute is absent, not the origin", () => {
    // `Number("")` is 0, so the guard has to be explicit or an interrupted
    // write seats the dot at the chip's top-left corner.
    const el = fakeElement({ [ATOM_WELL_X_ATTR]: "", [ATOM_WELL_Y_ATTR]: "" });
    expect(readDotWell(el)).toBeNull();
  });

  test("a value that is not a number reads null", () => {
    const el = fakeElement({ [ATOM_WELL_X_ATTR]: "left", [ATOM_WELL_Y_ATTR]: "3" });
    expect(readDotWell(el)).toBeNull();
  });
});
