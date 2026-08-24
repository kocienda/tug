/**
 * `pendingCommandInsert` slot — the store side of clickable slash
 * commands. A click on a known slash command in the transcript parks
 * `{ name, args }` here for the prompt entry to seed as a ready-to-run
 * draft; the prompt entry clears it once seeded.
 *
 * Driven through the real `CodeSessionStore` facade (no mock store) so
 * the snapshot-reference stability the seeding `useLayoutEffect` relies
 * on is exercised for real.
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

describe("CodeSessionStore — pendingCommandInsert slot", () => {
  it("starts null", () => {
    const store = constructStore();
    expect(store.getSnapshot().pendingCommandInsert).toBeNull();
  });

  it("insertCommandDraft parks the bare name + argument text", () => {
    const store = constructStore();
    store.insertCommandDraft("tugplug:implement", "dash/find-route.md");
    expect(store.getSnapshot().pendingCommandInsert).toEqual({
      name: "tugplug:implement",
      args: "dash/find-route.md",
    });
  });

  it("insertCommandDraft with no args parks an empty argument string", () => {
    const store = constructStore();
    store.insertCommandDraft("diff", "");
    expect(store.getSnapshot().pendingCommandInsert).toEqual({
      name: "diff",
      args: "",
    });
  });

  it("consumePendingCommandInsert clears the slot back to null", () => {
    const store = constructStore();
    store.insertCommandDraft("model", "opus");
    store.consumePendingCommandInsert();
    expect(store.getSnapshot().pendingCommandInsert).toBeNull();
  });

  it("consume while already null is a snapshot-ref-stable no-op", () => {
    const store = constructStore();
    const before = store.getSnapshot();
    store.consumePendingCommandInsert();
    expect(store.getSnapshot()).toBe(before);
  });
});
