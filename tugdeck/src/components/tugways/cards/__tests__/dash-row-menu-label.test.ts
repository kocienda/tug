/**
 * A disabled menu item still has to say why.
 *
 * This is the one part of the row menu that can go wrong silently. A disabled
 * item takes no pointer events, so a `title` on it can never be read and a
 * tooltip on it never fires — which is how a blocked verb turns into a dead
 * word with no explanation ([L31]). The reason therefore rides the label, and
 * that composition is what this pins.
 */

import { describe, test, expect } from "bun:test";

import { dashRowMenuLabel } from "@/components/tugways/cards/session-changes/dash-row-menu";

describe("the label carries its own refusal", () => {
  test("an available verb is the bare word", () => {
    expect(dashRowMenuLabel("Unbind", null)).toBe("Unbind");
    expect(dashRowMenuLabel("Discard", null)).toBe("Discard");
  });

  test("a blocked verb names the block beside the word", () => {
    expect(dashRowMenuLabel("Discard", "a turn is running")).toBe(
      "Discard — a turn is running",
    );
  });

  test("the empty reason is still a reason, and still shows", () => {
    // Not `?? null`-collapsed into the available case: a caller that hands over
    // an empty string has a blocked verb with nothing to say, and rendering it
    // as available would offer a press the gate refuses.
    expect(dashRowMenuLabel("Bind", "")).toBe("Bind — ");
  });
});
