/**
 * slot-window-pref.test.ts — the width a row's slot window takes, and where
 * that width is read from.
 *
 * The preference is deck-wide, so it belongs to no card — which is why it has
 * a domain of its own rather than the retired rail's, whose it only ever
 * shared. Two pieces are pinned here: the parse, which refuses a width this
 * build cannot draw, and the resolution, which turns an unset reader into the
 * default.
 */

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SLOT_WINDOW,
  parseSlotWindow,
  resolveSlotWindow,
} from "../slot-window-pref";

describe("parseSlotWindow", () => {
  test("reads the two widths this build draws", () => {
    expect(parseSlotWindow({ kind: "i64", value: 3 })).toBe(3);
    expect(parseSlotWindow({ kind: "i64", value: 5 })).toBe(5);
  });

  test("a width outside the set stops steering the rows", () => {
    // A width a later build retired must not draw a run nobody can choose
    // again.
    for (const bogus of [4, 7, 0, -3, "3", null, undefined]) {
      expect(
        parseSlotWindow({ kind: "i64", value: bogus } as never),
      ).toBeNull();
    }
  });

  test("nothing stored is null, not a default", () => {
    // The default is the resolver's answer, not the parser's: a parser that
    // defaulted could not tell "unset" from "set to the default".
    expect(parseSlotWindow(undefined)).toBeNull();
  });
});

describe("resolveSlotWindow", () => {
  test("a stored width is the answer", () => {
    expect(resolveSlotWindow(3)).toBe(3);
  });

  test("nothing stored lands on the default", () => {
    expect(resolveSlotWindow(null)).toBe(DEFAULT_SLOT_WINDOW);
  });
});
