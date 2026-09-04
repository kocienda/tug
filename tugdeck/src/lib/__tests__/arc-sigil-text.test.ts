/**
 * arc-sigil-text.test.ts — the flat-text half of the arc sigil.
 *
 * The join is one line, and it is worth pinning for one reason: it is the
 * spelling the composer's baked session chip appends when the React run it
 * has to match is built from elements instead. The two agreeing is the whole
 * claim, so the character and the "no arc, no sigil" arm are both here.
 */

import { describe, expect, test } from "bun:test";

import { ARC_SIGIL, withArcSigil } from "@/lib/arc-sigil-text";

describe("withArcSigil", () => {
  test("appends the sigil and the name", () => {
    expect(withArcSigil("tug/salty-basin", "arc-unification")).toBe(
      "tug/salty-basin^arc-unification",
    );
  });

  test("the sigil is the grammar's `^`", () => {
    expect(ARC_SIGIL).toBe("^");
  });

  test("no arc leaves the run untouched", () => {
    expect(withArcSigil("tug/salty-basin", null)).toBe("tug/salty-basin");
  });

  // An arc named by the empty string is a sender's mistake, not a binding —
  // a bare `^` on the end of a name would read as a rendering bug.
  test("an empty name is no arc", () => {
    expect(withArcSigil("tug/salty-basin", "")).toBe("tug/salty-basin");
  });

  test("a custom-named session wears it just the same", () => {
    expect(withArcSigil("Parser fix", "arc-unification")).toBe(
      "Parser fix^arc-unification",
    );
  });
});
