/**
 * FocusManager — pure-logic tests for the keyboard-route classification
 * (Spec S02 of `dash/keyboard-as-engine-state.md`).
 *
 * Every placement classifies into exactly one of two routes, derived from the
 * `FocusTarget` kind plus the responder registry's focus-contract declaration —
 * never a per-call flag. These pin the full table (all six kinds × contract
 * presence) as data-in / data-out, with no DOM: `place` runs its in-memory
 * realization and the route cache is the exact surface under test. The
 * park/grant DOM side of the route is exercised in the real app via app-test.
 */

import { describe, expect, test } from "bun:test";

import { FocusManager } from "../focus-manager";
import { ResponderChainManager } from "../responder-chain";

function setup(): { fm: FocusManager; chain: ResponderChainManager } {
  const chain = new ResponderChainManager();
  const fm = new FocusManager();
  fm.attach(chain);
  return { fm, chain };
}

describe("FocusManager keyboard-route classification (Spec S02)", () => {
  test("starts engine-routed with no placement", () => {
    const { fm } = setup();
    expect(fm.keyboardRoute()).toBe("engine-routed");
  });

  test("`none` → engine-routed", () => {
    const { fm } = setup();
    fm.place(null, { kind: "none" });
    expect(fm.keyboardRoute()).toBe("engine-routed");
  });

  test("`focusable` → engine-routed", () => {
    const { fm } = setup();
    fm.registerFocusable({ id: "chip", group: "g", order: 0 });
    expect(fm.place(null, { kind: "focusable", id: "chip" })).toBe("placed");
    expect(fm.keyboardRoute()).toBe("engine-routed");
  });

  test("`focus-key` → engine-routed", () => {
    const { fm } = setup();
    fm.registerFocusable({ id: "row0", group: "list", order: 0 });
    expect(
      fm.place(null, { kind: "focus-key", focusKey: "list:0" }, {
        modality: "keyboard",
      }),
    ).toBe("placed");
    expect(fm.keyboardRoute()).toBe("engine-routed");
  });

  test("an unrealized `focus-key` leaves the previous route standing", () => {
    const { fm } = setup();
    fm.registerFocusable({ id: "row0", group: "list", order: 0 });
    fm.place(null, { kind: "focus-key", focusKey: "list:0" }, {
      modality: "keyboard",
    });
    expect(fm.keyboardRoute()).toBe("engine-routed");
    expect(
      fm.place(null, { kind: "focus-key", focusKey: "ghost:9" }, {
        modality: "keyboard",
      }),
    ).toBe("unrealized");
    expect(fm.keyboardRoute()).toBe("engine-routed");
  });

  test("`responder` WITH a focus contract → dom-granted", () => {
    const { fm, chain } = setup();
    chain.register({
      id: "editor",
      parentId: null,
      actions: {},
      focus: () => {},
    });
    expect(
      fm.place(null, { kind: "responder", responderId: "editor" }),
    ).toBe("placed");
    expect(fm.keyboardRoute()).toBe("dom-granted");
  });

  test("`responder` WITHOUT a focus contract → engine-routed", () => {
    const { fm, chain } = setup();
    chain.register({ id: "panel", parentId: null, actions: {} });
    expect(
      fm.place(null, { kind: "responder", responderId: "panel" }),
    ).toBe("placed");
    expect(fm.keyboardRoute()).toBe("engine-routed");
  });

  test("`responder` with no chain attached → engine-routed", () => {
    const fm = new FocusManager();
    expect(
      fm.place(null, { kind: "responder", responderId: "editor" }),
    ).toBe("placed");
    expect(fm.keyboardRoute()).toBe("engine-routed");
  });

  test("`state-key` and `engine` are unrealizable without a DOM/card and leave the route standing", () => {
    // Their dom-granted classification commits only on a successful grant —
    // exercised in the real app (app-test), since both kinds resolve against
    // the document / the deck store. DOM-free they return "unrealized" with
    // no route change.
    const { fm } = setup();
    expect(fm.place(null, { kind: "state-key", key: "field" })).toBe(
      "unrealized",
    );
    expect(fm.keyboardRoute()).toBe("engine-routed");
    expect(fm.place(null, { kind: "engine" })).toBe("unrealized");
    expect(fm.keyboardRoute()).toBe("engine-routed");
  });

  test("route transitions re-derive on every placement", () => {
    const { fm, chain } = setup();
    chain.register({
      id: "editor",
      parentId: null,
      actions: {},
      focus: () => {},
    });
    fm.registerFocusable({ id: "row0", group: "list", order: 0 });

    fm.place(null, { kind: "responder", responderId: "editor" });
    expect(fm.keyboardRoute()).toBe("dom-granted");

    fm.place(null, { kind: "focusable", id: "row0" }, { modality: "keyboard" });
    expect(fm.keyboardRoute()).toBe("engine-routed");

    fm.place(null, { kind: "responder", responderId: "editor" });
    expect(fm.keyboardRoute()).toBe("dom-granted");
  });
});

describe("FocusManager transactional placement ([P06] PlaceResult matrix)", () => {
  test("unmounted focus-key → unrealized: no key-view write, no route change", () => {
    const { fm } = setup();
    fm.registerFocusable({ id: "row0", group: "list", order: 0 });
    fm.place(null, { kind: "focusable", id: "row0" }, { modality: "keyboard" });
    expect(fm.keyView()).toBe("row0");

    expect(
      fm.place(null, { kind: "focus-key", focusKey: "ghost:3" }, {
        modality: "keyboard",
      }),
    ).toBe("unrealized");
    expect(fm.keyView()).toBe("row0");
    expect(fm.keyboardRoute()).toBe("engine-routed");
  });

  test("a late mount realizes an armed keyboard focus-key placement", () => {
    const { fm } = setup();
    expect(
      fm.place(null, { kind: "focus-key", focusKey: "list:2" }, {
        modality: "keyboard",
      }),
    ).toBe("unrealized");
    expect(fm.keyView()).toBeNull();
    fm.registerFocusable({ id: "row2", group: "list", order: 2 });
    expect(fm.keyView()).toBe("row2");
  });

  test("unregistered focusable id → unrealized: previous target stands", () => {
    const { fm } = setup();
    fm.registerFocusable({ id: "chip", group: "g", order: 0 });
    fm.place(null, { kind: "focusable", id: "chip" }, { modality: "keyboard" });
    expect(fm.keyView()).toBe("chip");

    expect(
      fm.place(null, { kind: "focusable", id: "ghost" }, {
        modality: "keyboard",
      }),
    ).toBe("unrealized");
    expect(fm.keyView()).toBe("chip");
  });

  test("responder unknown to an attached chain → unrealized", () => {
    const { fm, chain } = setup();
    chain.register({ id: "editor", parentId: null, actions: {} });
    fm.place(null, { kind: "responder", responderId: "editor" });
    expect(fm.keyView()).toBe("editor");

    expect(
      fm.place(null, { kind: "responder", responderId: "ghost" }),
    ).toBe("unrealized");
    expect(fm.keyView()).toBe("editor");
  });

  test("registered targets commit fully: key view + route set", () => {
    const { fm, chain } = setup();
    chain.register({
      id: "editor",
      parentId: null,
      actions: {},
      focus: () => {},
    });
    expect(
      fm.place(null, { kind: "responder", responderId: "editor" }),
    ).toBe("placed");
    expect(fm.keyView()).toBe("editor");
    expect(fm.keyboardRoute()).toBe("dom-granted");
  });

  test("background card placement → recorded: cache realized, active context untouched", () => {
    const { fm } = setup();
    fm.setKeyCard("cardA");
    const ctxB = fm.contextFor("cardB");
    ctxB.registerFocusable({ id: "b-row", group: "list", order: 0 });

    expect(
      fm.place("cardB", { kind: "focusable", id: "b-row" }, {
        modality: "keyboard",
      }),
    ).toBe("recorded");
    // The background context's cache holds its seed for the [P20] restore…
    expect(ctxB.keyView()).toBe("b-row");
    expect(ctxB.keyboardRoute()).toBe("engine-routed");
    // …and the active (key-card) context never saw a write.
    expect(fm.keyView()).toBeNull();
  });
});
