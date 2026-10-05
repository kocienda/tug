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
 * - The seven ask gestures (slot, go, bullseye, sidebar, fit, appear,
 *   slide) resolve to the doors their menu items and chords reach; `slot`
 *   and `bullseye` refuse what the deck does not hold, `appear` returns the
 *   arriving pane, and `slide` refuses a focus that did not move the strip.
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

  test("slot sends the card to the slot through the ⌘n door", () => {
    expect(resolveGesture("slot", { card: "c1", slot: 1 })).toEqual({
      kind: "action",
      action: "assign-slot",
      payload: { cardId: "c1", slot: 1 },
    });
  });

  test("go travels to the 1-based slot the ⌃⌘n door takes", () => {
    expect(resolveGesture("go", { slot: 2 })).toEqual({
      kind: "action",
      action: "go-to-slot",
      payload: { value: 3 },
    });
    expect(resolveGesture("go", { slot: 0 })).toEqual({
      kind: "action",
      action: "go-to-slot",
      payload: { value: 1 },
    });
  });

  test("bullseye toggles the named pane", () => {
    expect(resolveGesture("bullseye", { pane: "p1" })).toEqual({
      kind: "action",
      action: "set-bullseye",
      payload: { paneId: "p1" },
    });
  });

  test("sidebar sets one sidebar's open state", () => {
    expect(resolveGesture("sidebar", { component: "jots", open: false })).toEqual({
      kind: "action",
      action: "set-sidebar-open",
      payload: { componentId: "jots", open: false },
    });
  });

  test("fit and appear need nothing", () => {
    expect(resolveGesture("fit")).toEqual({
      kind: "action",
      action: "resize-sidebars-to-fit",
      payload: {},
    });
    expect(resolveGesture("appear")).toEqual({
      kind: "action",
      action: "show-card",
      payload: { component: "session" },
    });
  });

  test("slide focuses the session card, as flip does", () => {
    expect(resolveGesture("slide", { card: "c1" })).toEqual({
      kind: "action",
      action: "focus-session-card",
      payload: { cardId: "c1" },
    });
  });

  test("each new gesture's missing argument is named", () => {
    const missing: Array<[string, Record<string, unknown>, string]> = [
      ["slot", { slot: 0 }, "card"],
      ["slot", { card: "c1" }, "slot"],
      ["go", {}, "slot"],
      ["bullseye", {}, "pane"],
      ["sidebar", { open: true }, "component"],
      ["sidebar", { component: "jots" }, "open"],
      ["slide", {}, "card"],
    ];
    for (const [gesture, args, key] of missing) {
      const r = resolveGesture(gesture, args);
      expect("error" in r && r.error).toBe(`${gesture}: missing argument "${key}"`);
    }
  });

  test("an ill-typed slot or open is refused", () => {
    for (const slot of [-1, 1.5, "0"]) {
      const s = resolveGesture("slot", { card: "c1", slot });
      expect("error" in s && s.error).toBe(`slot: "slot" must be a non-negative integer`);
      const g = resolveGesture("go", { slot });
      expect("error" in g && g.error).toBe(`go: "slot" must be a non-negative integer`);
    }
    const r = resolveGesture("sidebar", { component: "jots", open: "yes" });
    expect("error" in r && r.error).toBe(`sidebar: "open" must be a boolean`);
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
    deckOf(() => ({ panes: paneIds.map((id) => ({ id, cardIds: [`${id}-card`] })) }), log);
  }

  /** A deck whose snapshot is whatever `snapshot` returns at each read. */
  function deckOf(snapshot: () => Record<string, unknown>, log: string[]): void {
    registerDeckStore({
      getSnapshot: snapshot,
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

  test("every new gesture opens the click's hold once, before its dispatch", () => {
    const drives: Array<[string, Record<string, unknown>, string]> = [
      ["slot", { card: "p1-card", slot: 1 }, "assign-slot"],
      ["go", { slot: 1 }, "go-to-slot"],
      ["bullseye", { pane: "p1" }, "set-bullseye"],
      ["sidebar", { component: "jots", open: false }, "set-sidebar-open"],
      ["fit", {}, "resize-sidebars-to-fit"],
      ["appear", {}, "show-card"],
    ];
    for (const [gesture, args, action] of drives) {
      const log: string[] = [];
      deckWith(["p1"], log);
      const r = driveGesture((frame) => log.push(`dispatch ${frame.action}`), gesture, args, scopeInto(log));
      expect("error" in r).toBe(false);
      expect(log).toEqual(["open pointer", `dispatch ${action}`]);
    }
  });

  test("slot naming a card no pane holds is refused, and nothing is driven", () => {
    const log: string[] = [];
    deckWith(["p1"], log);
    const r = driveGesture(() => log.push("dispatch"), "slot", { card: "c9", slot: 1 }, scopeInto(log));
    expect(r).toEqual({ error: `slot: no pane holds card "c9"` });
    expect(log).toEqual([]);
  });

  test("bullseye naming a pane the deck does not hold is refused, and nothing is driven", () => {
    const log: string[] = [];
    deckWith(["p1"], log);
    const r = driveGesture(() => log.push("dispatch"), "bullseye", { pane: "p9" }, scopeInto(log));
    expect(r).toEqual({ error: `bullseye: no pane "p9" on the deck` });
    expect(log).toEqual([]);
  });

  test("appear returns the pane the dispatch made active", () => {
    const log: string[] = [];
    let active = "p1";
    deckOf(() => ({ panes: [{ id: "p1", cardIds: [] }], activePaneId: active }), log);
    const r = driveGesture(
      () => {
        active = "p-new";
      },
      "appear",
      {},
      scopeInto(log),
    );
    expect(r).toEqual({ ok: true, paneId: "p-new" });
  });

  test("slide succeeds when the strip travels and is refused when it does not", () => {
    const log: string[] = [];
    let offset: number | undefined;
    deckOf(() => ({ panes: [], flowOffset: offset }), log);
    const moved = driveGesture(
      () => {
        offset = 240;
      },
      "slide",
      { card: "c3" },
      scopeInto(log),
    );
    expect(moved).toEqual({ ok: true });
    const still = driveGesture(() => {}, "slide", { card: "c3" }, scopeInto(log));
    expect(still).toEqual({
      error: "slide: the strip did not travel — c3 was already in the band",
    });
  });

  test("a gesture that needs the deck refuses without one", () => {
    const log: string[] = [];
    const r = driveGesture(() => log.push("dispatch"), "appear", {}, scopeInto(log));
    expect(r).toEqual({ error: "appear: no deck store is registered" });
    expect(log).toEqual([]);
  });
});
