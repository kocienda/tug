/**
 * CardsSelectionStore — the layout selection's own rules.
 *
 * The real store class, driven directly; no deck is stood up here because
 * `DeckManager`'s constructor calls `createRoot`, so the resolver ladder, the
 * prune subscription, and the collapse rule are covered against the live deck
 * in `tests/app-test/at0451-cards-multiselect.test.ts` instead of against a
 * stand-in here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { IDeckManagerStore } from "@/deck-manager-store";
import {
  attachLayoutSelectionToDeck,
  CardsSelectionStore,
} from "../cards-selection-store";

const ORDER = ["a", "b", "c", "d", "e"];

describe("pickOnly", () => {
  test("replaces the selection and seats the anchor", () => {
    const s = new CardsSelectionStore();
    s.toggle("a");
    s.toggle("b");
    s.pickOnly("d");
    expect(s.getSnapshot().ids).toEqual(["d"]);
    expect(s.getSnapshot().anchorId).toBe("d");
  });
});

describe("toggle", () => {
  test("appends in pick order", () => {
    const s = new CardsSelectionStore();
    s.toggle("c");
    s.toggle("a");
    s.toggle("b");
    expect(s.getSnapshot().ids).toEqual(["c", "a", "b"]);
  });

  test("removes a member and leaves the rest in order", () => {
    const s = new CardsSelectionStore();
    s.toggle("c");
    s.toggle("a");
    s.toggle("b");
    s.toggle("a");
    expect(s.getSnapshot().ids).toEqual(["c", "b"]);
  });

  test("moves the anchor to the toggled row either way", () => {
    const s = new CardsSelectionStore();
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
    const s = new CardsSelectionStore();
    s.pickOnly("b");
    s.extendTo("d", ORDER);
    expect(s.getSnapshot().ids).toEqual(["b", "c", "d"]);
  });

  test("selects the inclusive range in list order, upward", () => {
    const s = new CardsSelectionStore();
    s.pickOnly("d");
    s.extendTo("b", ORDER);
    expect(s.getSnapshot().ids).toEqual(["b", "c", "d"]);
  });

  test("leaves the anchor put, so successive extensions re-range", () => {
    const s = new CardsSelectionStore();
    s.pickOnly("c");
    s.extendTo("e", ORDER);
    expect(s.getSnapshot().ids).toEqual(["c", "d", "e"]);
    s.extendTo("a", ORDER);
    expect(s.getSnapshot().ids).toEqual(["a", "b", "c"]);
    expect(s.getSnapshot().anchorId).toBe("c");
  });

  test("degenerates to a pick with no anchor", () => {
    const s = new CardsSelectionStore();
    s.extendTo("c", ORDER);
    expect(s.getSnapshot().ids).toEqual(["c"]);
    expect(s.getSnapshot().anchorId).toBe("c");
  });

  test("degenerates to a pick when the order no longer holds the anchor", () => {
    const s = new CardsSelectionStore();
    s.pickOnly("a");
    s.extendTo("d", ["b", "c", "d"]);
    expect(s.getSnapshot().ids).toEqual(["d"]);
    expect(s.getSnapshot().anchorId).toBe("d");
  });
});

describe("pruneTo", () => {
  test("drops ids whose cards are gone, keeping order", () => {
    const s = new CardsSelectionStore();
    s.toggle("a");
    s.toggle("b");
    s.toggle("c");
    s.pruneTo(["a", "c"]);
    expect(s.getSnapshot().ids).toEqual(["a", "c"]);
  });

  test("never grows the selection", () => {
    const s = new CardsSelectionStore();
    s.pickOnly("a");
    s.pruneTo(["a", "b", "c", "d"]);
    expect(s.getSnapshot().ids).toEqual(["a"]);
  });

  test("clears an anchor that is no longer live", () => {
    const s = new CardsSelectionStore();
    s.pickOnly("a");
    s.toggle("b");
    s.toggle("b"); // b is the anchor but not a member
    s.pruneTo(["a"]);
    expect(s.getSnapshot().ids).toEqual(["a"]);
    expect(s.getSnapshot().anchorId).toBeNull();
  });

  test("prunes to empty rather than holding ghosts", () => {
    const s = new CardsSelectionStore();
    s.toggle("a");
    s.toggle("b");
    s.pruneTo([]);
    expect(s.getSnapshot().ids).toEqual([]);
    expect(s.getSnapshot().anchorId).toBeNull();
  });
});

describe("subscribers", () => {
  test("fire on a change and stay quiet on a no-op", () => {
    const s = new CardsSelectionStore();
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
    const s = new CardsSelectionStore();
    s.pickOnly("a");
    const first = s.getSnapshot();
    expect(s.getSnapshot()).toBe(first);
    s.pruneTo(["a"]);
    expect(s.getSnapshot()).toBe(first);
  });
});

describe("suppressNextAutoSelect", () => {
  test("is one-shot: the next consume reads true, the one after reads false", () => {
    const s = new CardsSelectionStore();
    expect(s.consumeAutoSelectSuppression()).toBe(false);
    s.suppressNextAutoSelect();
    expect(s.consumeAutoSelectSuppression()).toBe(true);
    expect(s.consumeAutoSelectSuppression()).toBe(false);
  });

  test("does not stack: two arms are still one skip", () => {
    const s = new CardsSelectionStore();
    s.suppressNextAutoSelect();
    s.suppressNextAutoSelect();
    expect(s.consumeAutoSelectSuppression()).toBe(true);
    expect(s.consumeAutoSelectSuppression()).toBe(false);
  });

  test("is not part of the snapshot, so arming it notifies nobody", () => {
    const s = new CardsSelectionStore();
    let calls = 0;
    s.subscribe(() => {
      calls += 1;
    });
    const before = s.getSnapshot();
    s.suppressNextAutoSelect();
    expect(calls).toBe(0);
    expect(s.getSnapshot()).toBe(before);
  });
});

describe("getSelectedIdSet", () => {
  test("reports membership for the current selection", () => {
    const s = new CardsSelectionStore();
    s.toggle("a");
    s.toggle("c");
    const set = s.getSelectedIdSet();
    expect(set.has("a")).toBe(true);
    expect(set.has("c")).toBe(true);
    expect(set.has("b")).toBe(false);
  });
});

/**
 * The prune's deferral ([B02]).
 *
 * `attachLayoutSelectionToDeck` takes an `IDeckManagerStore`, not a
 * `DeckManager`, so the seam is drivable from a stand-in — which is what the
 * header above means by "no deck is stood up here". What it needs instead is
 * an after-paint door it can turn by hand, so the test can distinguish "ran
 * inline" from "ran a paint later" rather than reading a timing.
 */
describe("the prune behind the after-paint door", () => {
  const rafs: Array<() => void> = [];
  const timers: Array<() => void> = [];
  let saved: Record<string, unknown> = {};

  /** Drain one painted frame: the rAF, then the zero timer queued inside it. */
  function paint(): void {
    const frame = rafs.splice(0, rafs.length);
    for (const cb of frame) cb();
    const due = timers.splice(0, timers.length);
    for (const fn of due) fn();
  }

  beforeEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    saved = {
      requestAnimationFrame: g.requestAnimationFrame,
      window: g.window,
      document: g.document,
    };
    g.requestAnimationFrame = (cb: () => void) => rafs.push(cb);
    g.window = { setTimeout: (fn: () => void) => timers.push(fn) };
    // Motion ON, read off the inline `--tug-motion` fast path, so the
    // stand-down branch is not the one under test.
    g.document = {
      documentElement: { style: { getPropertyValue: () => "1" } },
    };
  });

  afterEach(() => {
    rafs.length = 0;
    timers.length = 0;
    const g = globalThis as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete g[key];
      else g[key] = value;
    }
  });

  /** A deck whose commits this test lands by hand. */
  function fakeDeck(cards: string[]): {
    deck: IDeckManagerStore;
    commit: (next: string[]) => void;
  } {
    let ids = cards;
    let listener: (() => void) | null = null;
    const deck = {
      getSnapshot: () => ({ cards: ids.map((id) => ({ id })) }),
      getFirstResponderCardId: () => null,
      subscribeSync: (cb: () => void) => {
        listener = cb;
        return () => {
          listener = null;
        };
      },
      subscribe: () => () => {},
    } as unknown as IDeckManagerStore;
    return {
      deck,
      commit: (next: string[]) => {
        ids = next;
        listener?.();
      },
    };
  }

  test("a prune inside a sync-door commit publishes after paint, not inline", () => {
    const selection = new CardsSelectionStore();
    selection.toggle("a");
    selection.toggle("b");
    const seen: string[][] = [];
    selection.subscribe(() => {
      seen.push([...selection.getSnapshot().ids]);
    });

    const { deck, commit } = fakeDeck(["a", "b"]);
    const detach = attachLayoutSelectionToDeck(deck, selection);

    // The commit closes "b". React's subscribers run synchronously inside it;
    // the store's must not, or the canvas re-renders in the click task.
    commit(["a"]);
    expect(seen).toEqual([]);
    expect(selection.getSnapshot().ids).toEqual(["a", "b"]);

    paint();
    expect(seen).toEqual([["a"]]);
    expect(selection.getSnapshot().ids).toEqual(["a"]);

    detach();
  });

  test("N commits in one frame cost one prune, against the last card list", () => {
    const selection = new CardsSelectionStore();
    selection.toggle("a");
    selection.toggle("b");
    selection.toggle("c");
    const seen: string[][] = [];
    selection.subscribe(() => {
      seen.push([...selection.getSnapshot().ids]);
    });

    const { deck, commit } = fakeDeck(["a", "b", "c"]);
    const detach = attachLayoutSelectionToDeck(deck, selection);

    commit(["a", "b"]);
    commit(["a"]);
    expect(seen).toEqual([]);

    paint();
    expect(seen).toEqual([["a"]]);

    detach();
  });

  test("a detach before the frame lands drops the pending prune", () => {
    const selection = new CardsSelectionStore();
    selection.toggle("a");
    selection.toggle("b");
    const seen: string[][] = [];
    selection.subscribe(() => {
      seen.push([...selection.getSnapshot().ids]);
    });

    const { deck, commit } = fakeDeck(["a", "b"]);
    const detach = attachLayoutSelectionToDeck(deck, selection);
    commit(["a"]);
    detach();

    paint();
    expect(seen).toEqual([]);
    expect(selection.getSnapshot().ids).toEqual(["a", "b"]);
  });

  test("reduced motion prunes inline, where there is no tween to protect", () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.document = {
      documentElement: { style: { getPropertyValue: () => "0" } },
    };
    const selection = new CardsSelectionStore();
    selection.toggle("a");
    selection.toggle("b");

    const { deck, commit } = fakeDeck(["a", "b"]);
    const detach = attachLayoutSelectionToDeck(deck, selection);
    commit(["a"]);

    expect(selection.getSnapshot().ids).toEqual(["a"]);
    expect(rafs.length).toBe(0);

    detach();
  });
});
