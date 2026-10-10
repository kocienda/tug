/**
 * Pin the `record_session_state_change` CONTROL emission on
 * `CodeSessionStore.dispatch`. The wrapper compares the prev/new
 * indicator-tone triple — `(phase, transportState, interruptInFlight)`
 * — after every reduce and fires a fire-and-forget CONTROL frame
 * when any axis changed.
 *
 * Covers:
 *   - First triple change fires.
 *   - Same triple does not fire.
 *   - Phase-only change fires.
 *   - Transport-only change fires.
 *   - The wire payload carries the new triple, not the prev.
 */

import { describe, it, expect } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";

interface StateChangeWire {
  action: string;
  tug_session_id: string;
  at_ms: number;
  phase: string;
  transport_state: string;
  interrupt_in_flight: boolean;
}

function constructStore(
  conn: TestFrameChannel,
  lifecycle: ConnectionLifecycle = new ConnectionLifecycle(),
): CodeSessionStore {
  return new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle,
    tugSessionId: FIXTURE_IDS.TUG_SESSION_ID,
    sessionMode: "new",
  });
}

function dispatch(store: CodeSessionStore, event: CodeSessionEvent): void {
  (store as unknown as { dispatch(e: CodeSessionEvent): void }).dispatch(event);
}

function stateChangeFrames(
  conn: TestFrameChannel,
): StateChangeWire[] {
  return conn.recordedFrames
    .filter((f) => f.feedId === FeedId.CONTROL)
    .map((f) => {
      const bytes = f.decoded as Uint8Array;
      const json = new TextDecoder().decode(bytes);
      return JSON.parse(json) as StateChangeWire;
    })
    .filter((p) => p.action === "record_session_state_change");
}

describe("CodeSessionStore — record_session_state_change emission", () => {
  it("does not fire on a no-op event (no triple change)", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);
    // Initial snapshot is idle/online/false. Dispatch an event that
    // the reducer ignores (no triple change).
    dispatch(store, { type: "transport_settled" });
    // transport_settled from already-online is a no-op for the triple.
    expect(stateChangeFrames(conn)).toEqual([]);
  });

  it("fires when phase changes (idle → submitting)", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);
    store.send("hello", []);
    const frames = stateChangeFrames(conn);
    expect(frames.length).toBe(1);
    expect(frames[0]!.tug_session_id).toBe(FIXTURE_IDS.TUG_SESSION_ID);
    expect(frames[0]!.phase).toBe("submitting");
    expect(frames[0]!.transport_state).toBe("online");
    expect(frames[0]!.interrupt_in_flight).toBe(false);
    expect(typeof frames[0]!.at_ms).toBe("number");
  });

  it("fires when transportState changes (online → offline)", () => {
    const conn = new TestFrameChannel();
    const lifecycle = new ConnectionLifecycle();
    constructStore(conn, lifecycle);
    lifecycle.notifyConnectionDidClose();
    const frames = stateChangeFrames(conn);
    expect(frames.length).toBe(1);
    expect(frames[0]!.transport_state).toBe("offline");
    expect(frames[0]!.phase).toBe("idle");
  });

  it("fires once per distinct triple across a sequence of transport transitions", () => {
    const conn = new TestFrameChannel();
    const lifecycle = new ConnectionLifecycle();
    const store = constructStore(conn, lifecycle);
    // idle/online/false → idle/offline/false (transport-only change;
    // phase stays idle per [D06]).
    lifecycle.notifyConnectionDidClose();
    // idle/offline/false → idle/restoring/false
    dispatch(store, { type: "transport_open" });
    // idle/restoring/false → idle/online/false
    dispatch(store, { type: "transport_settled" });
    const frames = stateChangeFrames(conn);
    expect(frames.length).toBe(3);
    expect(frames.map((f) => f.transport_state)).toEqual([
      "offline",
      "restoring",
      "online",
    ]);
    expect(frames.every((f) => f.phase === "idle")).toBe(true);
  });

  it("collapses a repeated identical triple (no duplicate row)", () => {
    const conn = new TestFrameChannel();
    const store = constructStore(conn);
    // Transition once.
    store.send("hello", []);
    expect(stateChangeFrames(conn).length).toBe(1);
    // A second `transport_settled` while already online does nothing
    // to the triple. The dedupe at the wrapper short-circuits the
    // emission.
    dispatch(store, { type: "transport_settled" });
    expect(stateChangeFrames(conn).length).toBe(1);
  });
});
