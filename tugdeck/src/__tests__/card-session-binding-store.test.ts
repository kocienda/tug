/**
 * card-session-binding-store unit tests.
 *
 * Tests cover:
 * - setBinding notifies subscribers
 * - setBinding on a known card id replaces the existing binding
 * - clearBinding notifies subscribers when the card was bound
 * - clearBinding on an unknown card id is a no-op (no listener notification)
 * - getSnapshot returns a stable Map reference between mutations
 */

import { describe, test, expect } from "bun:test";
import {
  CardSessionBindingStore,
  type CardSessionBinding,
} from "../lib/card-session-binding-store";

function makeBinding(overrides: Partial<CardSessionBinding> = {}): CardSessionBinding {
  return {
    tugSessionId: "sess-1",
    lineId: "line-1",
    workspaceKey: "/work/alpha",
    projectDir: "/work/alpha",
    sessionMode: "new",
    ...overrides,
  };
}

describe("CardSessionBindingStore – setBinding", () => {
  test("notifies listeners on set", () => {
    const store = new CardSessionBindingStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    store.setBinding("card-1", makeBinding());
    expect(notifications).toBe(1);
    expect(store.getBinding("card-1")).toEqual(makeBinding());

    unsubscribe();
  });

  test("replaces an existing binding and notifies again", () => {
    const store = new CardSessionBindingStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.setBinding("card-1", makeBinding({ workspaceKey: "/work/alpha" }));
    store.setBinding("card-1", makeBinding({ workspaceKey: "/work/beta" }));

    expect(notifications).toBe(2);
    expect(store.getBinding("card-1")?.workspaceKey).toBe("/work/beta");
  });
});

describe("CardSessionBindingStore – clearBinding", () => {
  test("notifies listeners when a bound card is cleared", () => {
    const store = new CardSessionBindingStore();
    store.setBinding("card-1", makeBinding());

    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.clearBinding("card-1");

    expect(notifications).toBe(1);
    expect(store.getBinding("card-1")).toBeUndefined();
  });

  test("is a no-op when clearing an unknown card id", () => {
    const store = new CardSessionBindingStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.clearBinding("never-bound");

    expect(notifications).toBe(0);
  });
});

describe("CardSessionBindingStore – snapshot stability", () => {
  test("getSnapshot returns the same Map reference between mutations", () => {
    const store = new CardSessionBindingStore();
    const first = store.getSnapshot();
    const second = store.getSnapshot();
    expect(first).toBe(second);
  });

  test("getSnapshot returns a new Map reference after setBinding", () => {
    const store = new CardSessionBindingStore();
    const before = store.getSnapshot();
    store.setBinding("card-1", makeBinding());
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
  });

  test("getSnapshot returns a new Map reference after clearBinding", () => {
    const store = new CardSessionBindingStore();
    store.setBinding("card-1", makeBinding());
    const before = store.getSnapshot();
    store.clearBinding("card-1");
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
  });
});

describe("CardSessionBindingStore – clearAll", () => {
  test("drops every binding in a single notify", () => {
    const store = new CardSessionBindingStore();
    store.setBinding("card-1", makeBinding({ tugSessionId: "sess-1" }));
    store.setBinding("card-2", makeBinding({ tugSessionId: "sess-2" }));
    store.setBinding("card-3", makeBinding({ tugSessionId: "sess-3" }));

    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.clearAll();

    expect(notifications).toBe(1);
    expect(store.getSnapshot().size).toBe(0);
    expect(store.getBinding("card-1")).toBeUndefined();
    expect(store.getBinding("card-2")).toBeUndefined();
    expect(store.getBinding("card-3")).toBeUndefined();
  });

  test("returns a new Map reference after clearing a populated store", () => {
    const store = new CardSessionBindingStore();
    store.setBinding("card-1", makeBinding());
    const before = store.getSnapshot();
    store.clearAll();
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.size).toBe(0);
  });

  test("is a no-op when the store is already empty", () => {
    const store = new CardSessionBindingStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.clearAll();

    expect(notifications).toBe(0);
    const before = store.getSnapshot();
    store.clearAll();
    const after = store.getSnapshot();
    expect(after).toBe(before);
  });
});

describe("CardSessionBindingStore – unsubscribe", () => {
  test("unsubscribed listeners stop receiving notifications", () => {
    const store = new CardSessionBindingStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    store.setBinding("card-1", makeBinding());
    unsubscribe();
    store.setBinding("card-2", makeBinding({ tugSessionId: "sess-2" }));

    expect(notifications).toBe(1);
  });
});

/**
 * `session_line_rebound` ([P03]): a plain `/new` on a bound card births a
 * fresh line, and the binding has to follow it — the merge keeps the
 * `workspaceKey` the pane's feed filter is built from.
 */
describe("CardSessionBindingStore – setLineBinding", () => {
  test("re-seats the card on a new session and line, preserving the rest", () => {
    const store = new CardSessionBindingStore();
    store.setBinding("card-1", makeBinding());
    store.setDashBinding("card-1", { id: "tugdash/demo#1-abc", name: "demo" });

    store.setLineBinding("card-1", "sess-2", "line-2");

    const bound = store.getBinding("card-1");
    expect(bound?.tugSessionId).toBe("sess-2");
    expect(bound?.lineId).toBe("line-2");
    expect(bound?.workspaceKey).toBe("/work/alpha");
    expect(bound?.projectDir).toBe("/work/alpha");
    expect(bound?.dash?.name).toBe("demo");
  });

  test("no-ops on a card with no binding, and on a rebind to the same pair", () => {
    const store = new CardSessionBindingStore();
    store.setLineBinding("card-nope", "sess-2", "line-2");
    expect(store.getBinding("card-nope")).toBeUndefined();

    store.setBinding("card-1", makeBinding());
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.setLineBinding("card-1", "sess-1", "line-1");
    expect(notifications).toBe(0);
  });
});
