/**
 * `resolveGesture` unit tests.
 *
 * Covers:
 * - Each settle gesture resolves to the action and payload its driver
 *   dispatches, or to a close of the named pane.
 * - Each missing argument yields an error naming it; a bad `slot` or
 *   `mode` is refused; an unknown gesture is refused with the list.
 */

import { describe, test, expect } from "bun:test";

import { resolveGesture, SETTLE_GESTURES } from "./gesture-drivers";

describe("resolveGesture", () => {
  test("flip focuses the session card", () => {
    expect(resolveGesture("flip", { card: "c1" })).toEqual({
      kind: "action",
      action: "focus-session-card",
      payload: { cardId: "c1" },
    });
  });

  test("fold and unfold set the card's folded state", () => {
    expect(resolveGesture("fold", { card: "c1" })).toEqual({
      kind: "action",
      action: "set-card-folded",
      payload: { cardId: "c1", folded: true },
    });
    expect(resolveGesture("unfold", { card: "c1" })).toEqual({
      kind: "action",
      action: "set-card-folded",
      payload: { cardId: "c1", folded: false },
    });
  });

  test("close names the pane to close", () => {
    expect(resolveGesture("close", { pane: "p1" })).toEqual({
      kind: "close",
      paneId: "p1",
    });
  });

  test("rails toggles the sidebars and needs nothing", () => {
    expect(resolveGesture("rails")).toEqual({
      kind: "action",
      action: "toggle-sidebars",
      payload: {},
    });
  });

  test("split sets the slot's column mode, split by default", () => {
    expect(resolveGesture("split", { slot: 0 })).toEqual({
      kind: "action",
      action: "set-column-mode",
      payload: { slot: 0, mode: "split" },
    });
    expect(resolveGesture("split", { slot: 2, mode: "stack" })).toEqual({
      kind: "action",
      action: "set-column-mode",
      payload: { slot: 2, mode: "stack" },
    });
  });

  test("switch activates the space", () => {
    expect(resolveGesture("switch", { space: "s2" })).toEqual({
      kind: "action",
      action: "activate-space",
      payload: { spaceId: "s2" },
    });
  });

  test("each missing argument is named", () => {
    const missing: Array<[string, string]> = [
      ["flip", "card"],
      ["fold", "card"],
      ["unfold", "card"],
      ["close", "pane"],
      ["split", "slot"],
      ["switch", "space"],
    ];
    for (const [gesture, key] of missing) {
      const r = resolveGesture(gesture, {});
      expect("error" in r && r.error).toBe(`${gesture}: missing argument "${key}"`);
    }
    const empty = resolveGesture("close", { pane: "" });
    expect("error" in empty && empty.error).toContain(`"pane"`);
  });

  test("a bad slot or mode is refused", () => {
    for (const slot of [-1, 1.5, "0"]) {
      const r = resolveGesture("split", { slot });
      expect("error" in r && r.error).toContain(`"slot"`);
    }
    const r = resolveGesture("split", { slot: 0, mode: "grid" });
    expect("error" in r && r.error).toContain(`"mode"`);
  });

  test("an unknown gesture is refused with the list", () => {
    const r = resolveGesture("wiggle", {});
    expect("error" in r && r.error).toContain(`unknown gesture "wiggle"`);
    for (const g of SETTLE_GESTURES) {
      expect("error" in r && r.error).toContain(g);
    }
  });
});
