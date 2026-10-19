/**
 * FocusManager -- pure-logic tests for the Tab-walk engine.
 *
 * Exercises the manager's data model directly, with no DOM: walk ordering
 * (group ordinal then item order then registration sequence), focus-mode
 * filtering and trapping, keyboard-access policy filtering (`skip`), wrap
 * arithmetic at both ends, and default-action resolution against the current
 * mode. The DOM projection of the key view (`data-key-view`) is exercised in
 * the real app via app-test, not here -- bun:test has no document, so
 * `setKeyView` only mutates the in-memory key view, which is exactly the
 * surface these tests pin.
 *
 * No fake-DOM, no mock stores: the manager is the implementation and these
 * call it as data-in / data-out.
 */

import { describe, expect, test } from "bun:test";

import { advanceKeyViewFocus, BASE_FOCUS_MODE, FocusManager } from "../focus-manager";
import type { FocusableInput } from "../focus-manager";
import { installKeyCardRoute } from "@/bus/command-route";

function register(manager: FocusManager, inputs: FocusableInput[]): void {
  for (const input of inputs) {
    manager.registerFocusable(input);
  }
}

function walkIds(manager: FocusManager): string[] {
  return manager.walkOrder().map((r) => r.id);
}

describe("FocusManager walk ordering", () => {
  test("sorts by (group ordinal, item order)", () => {
    const m = new FocusManager();
    m.setGroupOrder(["prompt", "toolbar", "transcript"]);
    // Register out of order to prove the sort, not insertion, decides.
    register(m, [
      { id: "t1", group: "transcript", order: 0 },
      { id: "p2", group: "prompt", order: 1 },
      { id: "tb1", group: "toolbar", order: 0 },
      { id: "p1", group: "prompt", order: 0 },
    ]);
    expect(walkIds(m)).toEqual(["p1", "p2", "tb1", "t1"]);
  });

  test("reordering groups reorders the walk (no DOM move)", () => {
    const m = new FocusManager();
    m.setGroupOrder(["prompt", "toolbar"]);
    register(m, [
      { id: "tb", group: "toolbar", order: 0 },
      { id: "p", group: "prompt", order: 0 },
    ]);
    expect(walkIds(m)).toEqual(["p", "tb"]);
    m.setGroupOrder(["toolbar", "prompt"]);
    expect(walkIds(m)).toEqual(["tb", "p"]);
  });

  test("groups not in the authored order sort after, by registration sequence", () => {
    const m = new FocusManager();
    m.setGroupOrder(["known"]);
    register(m, [
      { id: "u-second", group: "unlisted-b", order: 0 },
      { id: "k", group: "known", order: 0 },
      { id: "u-first", group: "unlisted-a", order: 0 },
    ]);
    // Known group first; the two unlisted groups follow in the order they
    // were registered (seq tiebreak).
    expect(walkIds(m)).toEqual(["k", "u-second", "u-first"]);
  });

  test("equal group and order fall back to registration sequence", () => {
    const m = new FocusManager();
    m.setGroupOrder(["g"]);
    register(m, [
      { id: "first", group: "g", order: 0 },
      { id: "second", group: "g", order: 0 },
    ]);
    expect(walkIds(m)).toEqual(["first", "second"]);
  });
});

describe("FocusManager policy filtering", () => {
  test("standard mode excludes skip; accessibility includes it", () => {
    const m = new FocusManager();
    m.setGroupOrder(["g"]);
    register(m, [
      { id: "a", group: "g", order: 0, policy: "accept" },
      { id: "s", group: "g", order: 1, policy: "skip" },
      { id: "b", group: "g", order: 2 },
    ]);
    // Default policy is `accept`; standard drops only the explicit `skip`.
    expect(walkIds(m)).toEqual(["a", "b"]);
    m.setKeyboardAccessMode("accessibility");
    expect(walkIds(m)).toEqual(["a", "s", "b"]);
  });
});

describe("FocusManager focus modes", () => {
  test("a trapped mode services only its own focusables", () => {
    const m = new FocusManager();
    m.setGroupOrder(["g"]);
    register(m, [
      { id: "base1", group: "g", order: 0 },
      { id: "base2", group: "g", order: 1 },
      { id: "sheet1", group: "g", order: 0, modes: ["sheet"] },
      { id: "sheet2", group: "g", order: 1, modes: ["sheet"] },
    ]);
    expect(walkIds(m)).toEqual(["base1", "base2"]);
    m.pushFocusMode("sheet", { trapped: true });
    expect(walkIds(m)).toEqual(["sheet1", "sheet2"]);
    m.popFocusMode("sheet");
    expect(walkIds(m)).toEqual(["base1", "base2"]);
  });

  test("a non-trapped (descend) mode contains the walk to its own focusables", () => {
    // A descend scope (accordion section / list row) pushes a non-trapped mode.
    // `trapped: false` selects Escape-ascends (vs dismiss), but it must NOT widen
    // the Tab walk: a descend is a LOCKED loop inside the descended content, never
    // unioning the enclosing scope or base. (Base spans every other card under the
    // single deck-wide manager — the cross-card Tab leak this guards against.)
    const m = new FocusManager();
    m.setGroupOrder(["g"]);
    register(m, [
      { id: "base1", group: "g", order: 0 },
      { id: "overlay1", group: "g", order: 1, modes: ["overlay"] },
    ]);
    m.pushFocusMode("overlay", { trapped: false });
    expect(walkIds(m)).toEqual(["overlay1"]);
    m.popFocusMode("overlay");
    expect(walkIds(m)).toEqual(["base1"]);
  });

  test("a descend inside a trap stays locked to the descend scope (no leak)", () => {
    // Regression: descending into an accordion/list scope INSIDE a modal sheet
    // must keep Tab inside the descend scope — not the sheet, and never base /
    // another card. ([impossible-by-construction] focus containment.)
    const m = new FocusManager();
    m.setGroupOrder(["g"]);
    register(m, [
      { id: "otherCard", group: "g", order: 0 },
      { id: "sheetField", group: "g", order: 0, modes: ["sheet"] },
      { id: "sectionField", group: "g", order: 0, modes: ["section"] },
    ]);
    m.pushFocusMode("sheet", { trapped: true });
    expect(walkIds(m)).toEqual(["sheetField"]);
    m.pushFocusMode("section", { trapped: false });
    expect(walkIds(m)).toEqual(["sectionField"]);
    m.popFocusMode("section");
    expect(walkIds(m)).toEqual(["sheetField"]);
  });

  test("currentFocusMode reflects the top of the stack", () => {
    const m = new FocusManager();
    expect(m.currentFocusMode()).toBe(BASE_FOCUS_MODE);
    m.pushFocusMode("a", { trapped: true });
    m.pushFocusMode("b", { trapped: true });
    expect(m.currentFocusMode()).toBe("b");
    m.popFocusMode("b");
    expect(m.currentFocusMode()).toBe("a");
  });

  test("pushing an existing scope moves it to the top", () => {
    const m = new FocusManager();
    m.pushFocusMode("a", { trapped: true });
    m.pushFocusMode("b", { trapped: true });
    m.pushFocusMode("a", { trapped: true });
    expect(m.currentFocusMode()).toBe("a");
    m.popFocusMode("a");
    expect(m.currentFocusMode()).toBe("b");
  });
});

describe("FocusManager key-view capture / restore on push / pop", () => {
  test("popping the top mode restores the key view captured at push", () => {
    const m = new FocusManager();
    m.setKeyView("opener");
    m.pushFocusMode("sheet", { trapped: true });
    m.setKeyView("inside-sheet");
    expect(m.keyView()).toBe("inside-sheet");
    m.popFocusMode("sheet");
    expect(m.keyView()).toBe("opener");
  });

  test("nested modes restore their own captured key view in LIFO order", () => {
    const m = new FocusManager();
    m.setKeyView("kv0");
    m.pushFocusMode("a", { trapped: true });
    m.setKeyView("kvA");
    m.pushFocusMode("b", { trapped: true });
    m.setKeyView("kvB");
    m.popFocusMode("b");
    expect(m.keyView()).toBe("kvA");
    m.popFocusMode("a");
    expect(m.keyView()).toBe("kv0");
  });

  test("popping a buried (non-top) mode leaves the key view alone", () => {
    const m = new FocusManager();
    m.setKeyView("kv0");
    m.pushFocusMode("a", { trapped: true });
    m.pushFocusMode("b", { trapped: true });
    m.setKeyView("kvB");
    // 'a' is buried under 'b'; popping it must not steal the key view from
    // the still-current 'b'.
    m.popFocusMode("a");
    expect(m.keyView()).toBe("kvB");
    expect(m.currentFocusMode()).toBe("b");
  });

  test("a null key view at push restores to null on pop", () => {
    const m = new FocusManager();
    expect(m.keyView()).toBeNull();
    m.pushFocusMode("sheet", { trapped: true });
    m.setKeyView("inside");
    m.popFocusMode("sheet");
    expect(m.keyView()).toBeNull();
  });
});

describe("FocusManager focusFirstInMode", () => {
  test("moves the key view to the first focusable in the current mode", () => {
    const m = new FocusManager();
    m.setGroupOrder(["g"]);
    register(m, [
      { id: "base1", group: "g", order: 0 },
      { id: "sheet1", group: "g", order: 0, modes: ["sheet"] },
      { id: "sheet2", group: "g", order: 1, modes: ["sheet"] },
    ]);
    m.pushFocusMode("sheet", { trapped: true });
    expect(m.focusFirstInMode()).toBe("sheet1");
    expect(m.keyView()).toBe("sheet1");
  });

  test("returns null and leaves the key view when the mode is empty", () => {
    const m = new FocusManager();
    m.setKeyView("x");
    m.pushFocusMode("empty", { trapped: true });
    expect(m.focusFirstInMode()).toBeNull();
    expect(m.keyView()).toBe("x");
  });
});

describe("FocusManager Tab walk + wrap", () => {
  test("focusNext advances and wraps past the last to the first", () => {
    const m = new FocusManager();
    m.setGroupOrder(["g"]);
    register(m, [
      { id: "a", group: "g", order: 0 },
      { id: "b", group: "g", order: 1 },
      { id: "c", group: "g", order: 2 },
    ]);
    // No key view yet: a forward step starts at the first.
    expect(m.focusNext()).toBe("a");
    expect(m.focusNext()).toBe("b");
    expect(m.focusNext()).toBe("c");
    expect(m.focusNext()).toBe("a"); // wrap
    expect(m.keyView()).toBe("a");
  });

  test("focusPrevious retreats and wraps past the first to the last", () => {
    const m = new FocusManager();
    m.setGroupOrder(["g"]);
    register(m, [
      { id: "a", group: "g", order: 0 },
      { id: "b", group: "g", order: 1 },
      { id: "c", group: "g", order: 2 },
    ]);
    // No key view yet: a backward step starts at the last.
    expect(m.focusPrevious()).toBe("c");
    expect(m.focusPrevious()).toBe("b");
    expect(m.focusPrevious()).toBe("a");
    expect(m.focusPrevious()).toBe("c"); // wrap
  });

  test("a key view outside the walk starts the forward walk at the first", () => {
    const m = new FocusManager();
    m.setGroupOrder(["g"]);
    register(m, [
      { id: "a", group: "g", order: 0 },
      { id: "b", group: "g", order: 1 },
    ]);
    m.setKeyView("not-a-focusable");
    expect(m.focusNext()).toBe("a");
  });

  test("an empty walk leaves the key view untouched and returns null", () => {
    const m = new FocusManager();
    m.setKeyView("x");
    expect(m.focusNext()).toBeNull();
    expect(m.focusPrevious()).toBeNull();
    expect(m.keyView()).toBe("x");
  });

  test("the walk respects the current trapped mode", () => {
    const m = new FocusManager();
    m.setGroupOrder(["g"]);
    register(m, [
      { id: "base1", group: "g", order: 0 },
      { id: "sheet1", group: "g", order: 0, modes: ["sheet"] },
      { id: "sheet2", group: "g", order: 1, modes: ["sheet"] },
    ]);
    m.pushFocusMode("sheet", { trapped: true });
    expect(m.focusNext()).toBe("sheet1");
    expect(m.focusNext()).toBe("sheet2");
    expect(m.focusNext()).toBe("sheet1"); // wraps within the mode, never to base
  });
});

describe("FocusManager walk edge", () => {
  function threeStops(): FocusManager {
    const m = new FocusManager();
    m.setGroupOrder(["g"]);
    register(m, [
      { id: "a", group: "g", order: 0 },
      { id: "b", group: "g", order: 1 },
      { id: "c", group: "g", order: 2 },
    ]);
    return m;
  }

  test("the base walk's edge is ahead only from the stop at that end", () => {
    const m = threeStops();
    m.setKeyView("c");
    expect(m.walkEdgeAhead(1)).toBe(true);
    expect(m.walkEdgeAhead(-1)).toBe(false);
    m.setKeyView("a");
    expect(m.walkEdgeAhead(-1)).toBe(true);
    expect(m.walkEdgeAhead(1)).toBe(false);
    m.setKeyView("b");
    expect(m.walkEdgeAhead(1)).toBe(false);
    expect(m.walkEdgeAhead(-1)).toBe(false);
  });

  test("a key view outside the walk steps onto an end, not past one", () => {
    const m = threeStops();
    m.setKeyView(null);
    expect(m.walkEdgeAhead(1)).toBe(false);
    expect(m.walkEdgeAhead(-1)).toBe(false);
  });

  test("an empty base walk is all edge", () => {
    const m = new FocusManager();
    expect(m.walkEdgeAhead(1)).toBe(true);
    expect(m.walkEdgeAhead(-1)).toBe(true);
  });

  test("a pushed mode has no edge: it wraps by design", () => {
    const m = threeStops();
    register(m, [{ id: "t1", group: "g", order: 0, modes: ["trap"] }]);
    m.pushFocusMode("trap", { trapped: true });
    m.setKeyView("t1");
    expect(m.walkEdgeAhead(1)).toBe(false);
    expect(m.walkEdgeAhead(-1)).toBe(false);
  });

  test("focusWalkEnd lands the first or the last stop, and null on an empty walk", () => {
    const m = threeStops();
    expect(m.focusWalkEnd("last")).toBe("c");
    expect(m.keyView()).toBe("c");
    expect(m.focusWalkEnd("first")).toBe("a");
    expect(m.keyView()).toBe("a");
    expect(new FocusManager().focusWalkEnd("first")).toBeNull();
  });

  test("advanceKeyViewFocus offers the step past the edge to the shell's key-card route", () => {
    const m = threeStops();
    m.setKeyView("c");
    const offered: number[] = [];
    const uninstall = installKeyCardRoute({
      target: () => null,
      sent: () => {},
      walkEdge: (direction) => {
        offered.push(direction);
        return true;
      },
    });
    try {
      expect(advanceKeyViewFocus(m, 1)).toBe(true);
      // Taken by the edge: the walk did not wrap to the first stop.
      expect(offered).toEqual([1]);
      expect(m.keyView()).toBe("c");
      m.setKeyView("a");
      expect(advanceKeyViewFocus(m, -1)).toBe(true);
      expect(offered).toEqual([1, -1]);
      expect(m.keyView()).toBe("a");
    } finally {
      uninstall();
    }
  });
});

describe("FocusManager default-action resolution", () => {
  test("resolves against the current focus mode", () => {
    const m = new FocusManager();
    m.setDefaultAction(BASE_FOCUS_MODE, "submit");
    m.setDefaultAction("sheet", "close");
    expect(m.resolveDefaultAction()).toBe("submit");
    m.pushFocusMode("sheet", { trapped: true });
    expect(m.resolveDefaultAction()).toBe("close");
    m.popFocusMode("sheet");
    expect(m.resolveDefaultAction()).toBe("submit");
  });

  test("returns null when the current mode declares none", () => {
    const m = new FocusManager();
    expect(m.resolveDefaultAction()).toBeNull();
    m.pushFocusMode("sheet", { trapped: true });
    expect(m.resolveDefaultAction()).toBeNull();
  });

  test("clearing a default action removes it", () => {
    const m = new FocusManager();
    m.setDefaultAction(BASE_FOCUS_MODE, "submit");
    expect(m.resolveDefaultAction()).toBe("submit");
    m.setDefaultAction(BASE_FOCUS_MODE, null);
    expect(m.resolveDefaultAction()).toBeNull();
  });
});

describe("FocusManager per-card contexts (key-window model)", () => {
  test("the no-card path routes to the default context (additive refactor)", () => {
    // A bare manager with no key card set services the default context — the
    // entire existing suite above exercises exactly this path, unchanged.
    const m = new FocusManager();
    m.setGroupOrder(["g"]);
    m.registerFocusable({ id: "a", group: "g", order: 0 });
    expect(m.keyCard()).toBeNull();
    expect(walkIds(m)).toEqual(["a"]);
  });

  test("the key card's walk sees only its own context's focusables", () => {
    const m = new FocusManager();
    const a = m.contextFor("A");
    const b = m.contextFor("B");
    a.setGroupOrder(["g"]);
    b.setGroupOrder(["g"]);
    a.registerFocusable({ id: "a1", group: "g", order: 0 });
    b.registerFocusable({ id: "b1", group: "g", order: 0 });
    m.setKeyCard("A");
    expect(walkIds(m)).toEqual(["a1"]);
    m.setKeyCard("B");
    expect(walkIds(m)).toEqual(["b1"]);
  });

  test("switching the key card swaps contexts losslessly (mode stack + key view intact on return)", () => {
    const m = new FocusManager();
    const a = m.contextFor("A");
    m.setKeyCard("A");
    a.setKeyView("editorA");
    // A pending card-modal dialog: a trap + its seeded default key view.
    a.pushFocusMode("dialogA", { trapped: true });
    a.setKeyView("dialogDefaultA", true);
    expect(a.currentFocusMode()).toBe("dialogA");
    expect(a.keyView()).toBe("dialogDefaultA");

    // Switch away — A's universe is untouched, B starts fresh at base.
    m.setKeyCard("B");
    expect(a.currentFocusMode()).toBe("dialogA");
    expect(a.keyView()).toBe("dialogDefaultA");
    expect(a.isFocusModePushed("dialogA")).toBe(true);
    expect(m.currentFocusMode()).toBe(BASE_FOCUS_MODE);

    // Return — the dialog is still the card's destination, by construction.
    m.setKeyCard("A");
    expect(m.currentFocusMode()).toBe("dialogA");
    expect(m.keyView()).toBe("dialogDefaultA");
  });

  test("a background card's pushed mode is never the key card's current mode (cross-card containment)", () => {
    const m = new FocusManager();
    const a = m.contextFor("A");
    const b = m.contextFor("B");
    // A holds a pending dialog's trap; B is the key card.
    a.pushFocusMode("trapA", { trapped: true });
    b.registerFocusable({ id: "b1", group: "g", order: 0 });
    m.setKeyCard("B");
    // The active card never sees the background card's mode (the R05 root fix).
    expect(m.currentFocusMode()).toBe(BASE_FOCUS_MODE);
    expect(m.isFocusModePushed("trapA")).toBe(false);
    expect(walkIds(m)).toEqual(["b1"]);
    // But A still owns it, ready for restore.
    expect(a.isFocusModePushed("trapA")).toBe(true);
  });

  test("adoptKeyCard reports a pushed key destination ([P20]) and only that", () => {
    const m = new FocusManager();
    const a = m.contextFor("A");
    // Resting card: no pushed destination — the activation path focuses the editor.
    m.setKeyCard("A");
    expect(a.hasPushedKeyDestination()).toBe(false);
    expect(m.adoptKeyCard("A")).toBe(false);
    // A pending dialog (trap + seeded default) IS the card's destination.
    a.pushFocusMode("dialogA", { trapped: true });
    a.setKeyView("dialogDefaultA", true);
    expect(a.hasPushedKeyDestination()).toBe(true);
    expect(m.adoptKeyCard("A")).toBe(true);
    // A fresh card with no context still rests.
    expect(m.adoptKeyCard("B")).toBe(false);
    expect(m.keyCard()).toBe("B");
  });

  test("HMR re-register robustness: unregister/re-register + push/pop leaves no stale state", () => {
    // HMR keeps the manager alive while remounting components. A rebuilt context
    // (register → unregister → re-register, push → pop → push) must not leave a
    // stale key view, a double-trap, or a doubled walk entry.
    const m = new FocusManager();
    const a = m.contextFor("A");
    a.setGroupOrder(["g"]);
    m.setKeyCard("A");
    a.registerFocusable({ id: "x", group: "g", order: 0 });
    a.pushFocusMode("trap", { trapped: true });
    a.registerFocusable({ id: "y", group: "g", order: 0, modes: ["trap"] });
    expect(walkIds(m)).toEqual(["y"]);

    // Remount: tear the trap's focusable + mode down…
    a.unregisterFocusable("y");
    a.popFocusMode("trap");
    expect(m.currentFocusMode()).toBe(BASE_FOCUS_MODE);
    expect(walkIds(m)).toEqual(["x"]);

    // …then re-register and re-push (the HMR re-mount). Pushing the same scope
    // keeps the stack unique (no double-trap); one pop returns to base.
    a.registerFocusable({ id: "y", group: "g", order: 0, modes: ["trap"] });
    a.pushFocusMode("trap", { trapped: true });
    expect(walkIds(m)).toEqual(["y"]);
    a.popFocusMode("trap");
    expect(m.currentFocusMode()).toBe(BASE_FOCUS_MODE);
    expect(walkIds(m)).toEqual(["x"]);
  });
});

describe("FocusManager subscription", () => {
  test("notifies subscribers on change and bumps the version", () => {
    const m = new FocusManager();
    let notifications = 0;
    const unsubscribe = m.subscribe(() => {
      notifications += 1;
    });
    const before = m.getVersion();
    m.registerFocusable({ id: "a", group: "g", order: 0 });
    expect(notifications).toBe(1);
    expect(m.getVersion()).toBe(before + 1);
    unsubscribe();
    m.registerFocusable({ id: "b", group: "g", order: 0 });
    expect(notifications).toBe(1); // no longer subscribed
  });
});
