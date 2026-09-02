/**
 * The dash half of a card's session binding.
 *
 * `setDashBinding` is a **merge**, not a set: a bind can arrive mid-session,
 * and replacing the whole record there would clobber the `workspaceKey` the
 * spawn ack established — the value the pane's feed filter is built from.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  CardSessionBindingStore,
  cardSessionBindingStore,
} from "@/lib/card-session-binding-store";

const BINDING = {
  tugSessionId: "sess-1",
  lineId: "line-1",
  workspaceKey: "a1b2c3d4e5f60718",
  projectDir: "/Users/dev/src/tugtool",
  sessionMode: "new" as const,
};

describe("card session binding — dash", () => {
  let store: CardSessionBindingStore;

  beforeEach(() => {
    store = new CardSessionBindingStore();
  });

  test("a binding with no dash is simply unbound", () => {
    store.setBinding("card-1", BINDING);
    expect(store.getBinding("card-1")?.dash).toBeUndefined();
  });

  test("setDashBinding merges, preserving workspaceKey and projectDir", () => {
    store.setBinding("card-1", BINDING);
    store.setDashBinding("card-1", {
      id: "tugdash/demo#1723500000000-a1b2c3",
      name: "demo",
    });

    const bound = store.getBinding("card-1");
    expect(bound?.dash).toEqual({
      id: "tugdash/demo#1723500000000-a1b2c3",
      name: "demo",
    });
    // The rest of the record survives — a set would have wiped these, and the
    // pane's feed filter with them.
    expect(bound?.workspaceKey).toBe(BINDING.workspaceKey);
    expect(bound?.projectDir).toBe(BINDING.projectDir);
    expect(bound?.tugSessionId).toBe(BINDING.tugSessionId);
    expect(bound?.sessionMode).toBe("new");
  });

  test("setDashBinding(null) clears only the dash", () => {
    store.setBinding("card-1", BINDING);
    store.setDashBinding("card-1", { id: "tugdash/demo#1-abc", name: "demo" });
    store.setDashBinding("card-1", null);

    const bound = store.getBinding("card-1");
    expect(bound?.dash).toBeUndefined();
    expect(bound?.workspaceKey).toBe(BINDING.workspaceKey);
  });

  test("setDashBinding no-ops on a card with no binding", () => {
    // The spawn ack is the only writer allowed to create a record; a bind
    // broadcast for a card the deck has not bound must not conjure one.
    store.setDashBinding("card-nope", { id: "tugdash/demo#1-abc", name: "demo" });
    expect(store.getBinding("card-nope")).toBeUndefined();
  });

  test("a dash write notifies subscribers", () => {
    store.setBinding("card-1", BINDING);
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.setDashBinding("card-1", { id: "tugdash/demo#1-abc", name: "demo" });
    expect(notifications).toBe(1);
    unsubscribe();
  });

  test("the module singleton exposes the merge setter", () => {
    expect(typeof cardSessionBindingStore.setDashBinding).toBe("function");
  });
});
