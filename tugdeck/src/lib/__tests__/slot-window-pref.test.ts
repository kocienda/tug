/**
 * slot-window-pref.test.ts — the width a row's slot window takes, and where
 * that width is read from.
 *
 * The preference is deck-wide, so it belongs to no card — which is why it has
 * a domain of its own rather than the retired rail's, whose it only ever
 * shared. A reader who chose a width before the move keeps it, and the two
 * pieces that make that true are pinned here: the parse, which refuses a width
 * this build cannot draw, and the resolution, which prefers the new address
 * and falls back to the legacy one.
 */

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SLOT_WINDOW,
  LEGACY_SLOT_WINDOW_DOMAIN,
  SLOT_WINDOW_DOMAIN,
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
    // again — and the seed path now feeds this parse a second source, so a
    // stale legacy row cannot smuggle one in either.
    for (const bogus of [4, 7, 0, -3, "3", null, undefined]) {
      expect(parseSlotWindow({ kind: "i64", value: bogus } as never)).toBeNull();
    }
  });

  test("nothing stored is null, not a default", () => {
    // The default is the resolver's answer, not the parser's: a parser that
    // defaulted could not tell "unset" from "set to the default", which is the
    // distinction the fallback is built on.
    expect(parseSlotWindow(undefined)).toBeNull();
  });
});

describe("resolveSlotWindow", () => {
  test("the new address wins when both hold a width", () => {
    expect(resolveSlotWindow(3, 5)).toBe(3);
  });

  test("the legacy address answers when the new one is empty", () => {
    expect(resolveSlotWindow(null, 3)).toBe(3);
  });

  test("neither address lands on the default", () => {
    expect(resolveSlotWindow(null, null)).toBe(DEFAULT_SLOT_WINDOW);
  });

  test("the two addresses are distinct", () => {
    // The whole point of the move: were they the same string, the fallback
    // would be a second read of one row and every test above would pass over
    // a migration that never happened.
    expect(SLOT_WINDOW_DOMAIN).not.toBe(LEGACY_SLOT_WINDOW_DOMAIN);
  });
});
