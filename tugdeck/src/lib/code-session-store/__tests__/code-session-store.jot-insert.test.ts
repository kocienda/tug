/**
 * `pendingJotInsert` slot — the store side of dragging a Jots card jot
 * into the prompt entry. A drag/drop parks `{ text, at }` here for the entry
 * to insert (at the drop point when `at` is present, else appended); the entry
 * clears it once inserted.
 *
 * Driven through the real `CodeSessionStore` facade (no mock store) so the
 * snapshot-reference stability the seeding `useLayoutEffect` relies on is
 * exercised for real.
 */

import { describe, it, expect } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";

function constructStore(): CodeSessionStore {
  const conn = new TestFrameChannel();
  return new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: FIXTURE_IDS.TUG_SESSION_ID,
    sessionMode: "new",
  });
}

describe("CodeSessionStore — pendingJotInsert slot", () => {
  it("starts null", () => {
    const store = constructStore();
    expect(store.getSnapshot().pendingJotInsert).toBeNull();
  });

  it("insertJot parks text with a drop point", () => {
    const store = constructStore();
    store.insertJot("reusable text", { x: 120, y: 340 });
    expect(store.getSnapshot().pendingJotInsert).toEqual({
      text: "reusable text",
      at: { x: 120, y: 340 },
    });
  });

  it("insertJot parks text with a null point (append semantics)", () => {
    const store = constructStore();
    store.insertJot("appended text", null);
    expect(store.getSnapshot().pendingJotInsert).toEqual({
      text: "appended text",
      at: null,
    });
  });

  it("consumePendingJotInsert clears the slot back to null", () => {
    const store = constructStore();
    store.insertJot("x", { x: 1, y: 2 });
    store.consumePendingJotInsert();
    expect(store.getSnapshot().pendingJotInsert).toBeNull();
  });

  it("consume while already null is a snapshot-ref-stable no-op", () => {
    const store = constructStore();
    const before = store.getSnapshot();
    store.consumePendingJotInsert();
    expect(store.getSnapshot()).toBe(before);
  });
});
