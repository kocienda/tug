/**
 * `resolveGesture` and `driveGesture` unit tests.
 *
 * Covers:
 * - Each settle gesture resolves to the action and payload its driver
 *   dispatches, or to a close of the named pane.
 * - Each missing argument yields an error naming it; a bad `slot` or
 *   `mode` is refused; an unknown gesture is refused with the list.
 * - A driven gesture opens the click's `pointer` hold before its call, and
 *   a close naming a pane the deck does not hold is refused, with no hold
 *   opened and nothing closed.
 */

import { afterEach, describe, test, expect } from "bun:test";

import type { IDeckManagerStore } from "../deck-manager-store";
import { registerDeckStore } from "./deck-store-registry";
import { driveGesture, resolveGesture, SETTLE_GESTURES } from "./gesture-drivers";

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

describe("driveGesture", () => {
  afterEach(() => registerDeckStore(null));

  /** A deck holding `paneIds`, recording every close into `log`. */
  function deckWith(paneIds: readonly string[], log: string[]): void {
    registerDeckStore({
      getSnapshot: () => ({ panes: paneIds.map((id) => ({ id })) }),
      handlePaneClosed: (paneId: string) => log.push(`close ${paneId}`),
    } as unknown as IDeckManagerStore);
  }

  /** A scope recording each open into `log`. */
  const scopeInto = (log: string[]) => ({ open: (reason: string) => log.push(`open ${reason}`) });

  test("a dispatched gesture opens the click's hold before it dispatches", () => {
    const log: string[] = [];
    const r = driveGesture((frame) => log.push(`dispatch ${frame.action}`), "rails", {}, scopeInto(log));
    expect(r).toEqual({ ok: true });
    expect(log).toEqual(["open pointer", "dispatch toggle-sidebars"]);
  });

  test("a close opens the click's hold before it closes the pane", () => {
    const log: string[] = [];
    deckWith(["p1", "p2"], log);
    const r = driveGesture(() => log.push("dispatch"), "close", { pane: "p2" }, scopeInto(log));
    expect(r).toEqual({ ok: true });
    expect(log).toEqual(["open pointer", "close p2"]);
  });

  test("a close naming a pane the deck does not hold is refused, and nothing is driven", () => {
    const log: string[] = [];
    deckWith(["p1"], log);
    const r = driveGesture(() => log.push("dispatch"), "close", { pane: "p9" }, scopeInto(log));
    expect(r).toEqual({ error: `close: no pane "p9" on the deck` });
    expect(log).toEqual([]);
  });

  test("a gesture that does not resolve opens no hold", () => {
    const log: string[] = [];
    const r = driveGesture(() => log.push("dispatch"), "flip", {}, scopeInto(log));
    expect("error" in r).toBe(true);
    expect(log).toEqual([]);
  });
});
