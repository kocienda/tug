/**
 * LensSelectionStore — the layout selection's own rules.
 *
 * The real store class, driven directly; no deck is stood up here because
 * `DeckManager`'s constructor calls `createRoot`, so the resolver ladder, the
 * prune subscription, and the collapse rule are covered against the live deck
 * in `tests/app-test/at0451-lens-multiselect.test.ts` instead of against a
 * stand-in here.
 */
import { describe, expect, test } from "bun:test";
import { LensSelectionStore } from "../lens-selection-store";

const ORDER = ["a", "b", "c", "d", "e"];

describe("pickOnly", () => {
  test("replaces the selection and seats the anchor", () => {
    const s = new LensSelectionStore();
    s.toggle("a");
    s.toggle("b");
    s.pickOnly("d");
    expect(s.getSnapshot().ids).toEqual(["d"]);
    expect(s.getSnapshot().anchorId).toBe("d");
  });
});

describe("toggle", () => {
  test("appends in pick order", () => {
    const s = new LensSelectionStore();
    s.toggle("c");
    s.toggle("a");
    s.toggle("b");
    expect(s.getSnapshot().ids).toEqual(["c", "a", "b"]);
  });

  test("removes a member and leaves the rest in order", () => {
    const s = new LensSelectionStore();
    s.toggle("c");
    s.toggle("a");
    s.toggle("b");
    s.toggle("a");
    expect(s.getSnapshot().ids).toEqual(["c", "b"]);
  });

  test("moves the anchor to the toggled row either way", () => {
    const s = new LensSelectionStore();
    s.pickOnly("a");
    s.toggle("d");
    expect(s.getSnapshot().anchorId).toBe("d");
    s.toggle("d");
    expect(s.getSnapshot().ids).toEqual(["a"]);
    expect(s.getSnapshot().anchorId).toBe("d");
  });
});

describe("extendTo", () => {
  test("selects the inclusive range in list order, downward", () => {
    const s = new LensSelectionStore();
    s.pickOnly("b");
    s.extendTo("d", ORDER);
    expect(s.getSnapshot().ids).toEqual(["b", "c", "d"]);
  });

  test("selects the inclusive range in list order, upward", () => {
    const s = new LensSelectionStore();
    s.pickOnly("d");
    s.extendTo("b", ORDER);
    expect(s.getSnapshot().ids).toEqual(["b", "c", "d"]);
  });

  test("leaves the anchor put, so successive extensions re-range", () => {
    const s = new LensSelectionStore();
    s.pickOnly("c");
    s.extendTo("e", ORDER);
    expect(s.getSnapshot().ids).toEqual(["c", "d", "e"]);
    s.extendTo("a", ORDER);
    expect(s.getSnapshot().ids).toEqual(["a", "b", "c"]);
    expect(s.getSnapshot().anchorId).toBe("c");
  });

  test("degenerates to a pick with no anchor", () => {
    const s = new LensSelectionStore();
    s.extendTo("c", ORDER);
    expect(s.getSnapshot().ids).toEqual(["c"]);
    expect(s.getSnapshot().anchorId).toBe("c");
  });

  test("degenerates to a pick when the order no longer holds the anchor", () => {
    const s = new LensSelectionStore();
    s.pickOnly("a");
    s.extendTo("d", ["b", "c", "d"]);
    expect(s.getSnapshot().ids).toEqual(["d"]);
    expect(s.getSnapshot().anchorId).toBe("d");
  });
});

describe("pruneTo", () => {
  test("drops ids whose cards are gone, keeping order", () => {
    const s = new LensSelectionStore();
    s.toggle("a");
    s.toggle("b");
    s.toggle("c");
    s.pruneTo(["a", "c"]);
    expect(s.getSnapshot().ids).toEqual(["a", "c"]);
  });

  test("never grows the selection", () => {
    const s = new LensSelectionStore();
    s.pickOnly("a");
    s.pruneTo(["a", "b", "c", "d"]);
    expect(s.getSnapshot().ids).toEqual(["a"]);
  });

  test("clears an anchor that is no longer live", () => {
    const s = new LensSelectionStore();
    s.pickOnly("a");
    s.toggle("b");
    s.toggle("b"); // b is the anchor but not a member
    s.pruneTo(["a"]);
    expect(s.getSnapshot().ids).toEqual(["a"]);
    expect(s.getSnapshot().anchorId).toBeNull();
  });

  test("prunes to empty rather than holding ghosts", () => {
    const s = new LensSelectionStore();
    s.toggle("a");
    s.toggle("b");
    s.pruneTo([]);
    expect(s.getSnapshot().ids).toEqual([]);
    expect(s.getSnapshot().anchorId).toBeNull();
  });
});

describe("subscribers", () => {
  test("fire on a change and stay quiet on a no-op", () => {
    const s = new LensSelectionStore();
    let calls = 0;
    const unsubscribe = s.subscribe(() => {
      calls += 1;
    });
    s.pickOnly("a");
    expect(calls).toBe(1);
    s.pickOnly("a");
    expect(calls).toBe(1);
    s.pruneTo(["a", "b"]);
    expect(calls).toBe(1);
    s.clear();
    expect(calls).toBe(2);
    unsubscribe();
    s.pickOnly("b");
    expect(calls).toBe(2);
  });

  test("the snapshot is stable between changes, so useSyncExternalStore holds", () => {
    const s = new LensSelectionStore();
    s.pickOnly("a");
    const first = s.getSnapshot();
    expect(s.getSnapshot()).toBe(first);
    s.pruneTo(["a"]);
    expect(s.getSnapshot()).toBe(first);
  });
});

describe("getSelectedIdSet", () => {
  test("reports membership for the current selection", () => {
    const s = new LensSelectionStore();
    s.toggle("a");
    s.toggle("c");
    const set = s.getSelectedIdSet();
    expect(set.has("a")).toBe(true);
    expect(set.has("c")).toBe(true);
    expect(set.has("b")).toBe(false);
  });
});
