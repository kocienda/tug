/**
 * The compound emphasis × role class grammar [D02].
 *
 * `tugButtonEmphasisClass` was extracted from `TugButton`'s render site so a
 * DOM projection can swap a rendered button's look without restating the
 * template ([L20]). The extraction is only safe while it composes exactly what
 * the inline expression composed, so the whole matrix is pinned: a drifted
 * separator or a reordered pair would silently paint nothing.
 */

import { describe, expect, test } from "bun:test";

import {
  tugButtonEmphasisClass,
  type TugButtonEmphasis,
  type TugButtonRole,
} from "../internal/tug-button";
import { tugSlotLookClass } from "../tug-slot";

const EMPHASES: readonly TugButtonEmphasis[] = [
  "filled",
  "outlined",
  "ghost",
  "tinted",
  "primary",
];

const ROLES: readonly TugButtonRole[] = [
  "accent",
  "action",
  "agent",
  "data",
  "danger",
  "option",
];

describe("tugButtonEmphasisClass", () => {
  test("composes emphasis and role in that order, hyphen-joined", () => {
    for (const emphasis of EMPHASES) {
      for (const role of ROLES) {
        expect(tugButtonEmphasisClass(emphasis, role)).toBe(
          `tug-button-${emphasis}-${role}`,
        );
      }
    }
  });

  test("every pairing produces a distinct class", () => {
    const seen = new Set<string>();
    for (const emphasis of EMPHASES) {
      for (const role of ROLES) seen.add(tugButtonEmphasisClass(emphasis, role));
    }
    expect(seen.size).toBe(EMPHASES.length * ROLES.length);
  });
});

describe("tugSlotLookClass", () => {
  test("the exemplar form wears TugSlot's own vocabulary", () => {
    expect(tugSlotLookClass("rest", "exemplar")).toBe("tug-slot-exemplar-rest");
    expect(tugSlotLookClass("outlined", "exemplar")).toBe(
      "tug-slot-exemplar-outlined",
    );
    expect(tugSlotLookClass("filled", "exemplar")).toBe("tug-slot-exemplar-filled");
  });

  test("the control form wears the emphasis each resting look composes", () => {
    // The mapping is TugSlot's: rest is tinted rather than ghost, because an
    // empty slot still paints a card-shaped surface.
    expect(tugSlotLookClass("rest", "control")).toBe("tug-button-tinted-action");
    expect(tugSlotLookClass("outlined", "control")).toBe(
      "tug-button-outlined-action",
    );
    expect(tugSlotLookClass("filled", "control")).toBe("tug-button-filled-action");
  });

  test("the two forms never share a class", () => {
    for (const state of ["rest", "outlined", "filled"] as const) {
      expect(tugSlotLookClass(state, "exemplar")).not.toBe(
        tugSlotLookClass(state, "control"),
      );
    }
  });
});
