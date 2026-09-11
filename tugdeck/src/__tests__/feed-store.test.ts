/**
 * FeedStore unit tests.
 *
 * Covers:
 * - Filter rejects a live frame → snapshot unchanged, listeners not notified.
 * - Filter accepts a live frame → snapshot updated, listeners notified.
 * - Filter runs on the replay path: pre-seed a cached `lastPayload` before
 *   constructing the FeedStore; the filter must run against the replayed
 *   payload inside the synchronous `onFrame` → cached-replay callback.
 * - Filter is optional: omitting it is passthrough (original behavior).
 */

import { describe, test, expect } from "bun:test";

import { FeedStore, defaultDecode, type FeedStoreFilter } from "../lib/feed-store";
import { FeedId, type FeedIdValue } from "../protocol";
import type { TugConnection } from "../connection";

// ---------------------------------------------------------------------------
// Minimal TugConnection mock that implements just what FeedStore uses.
// ---------------------------------------------------------------------------

class MockConnection {
  private callbacks: Map<number, Array<(payload: Uint8Array) => void>> = new Map();
  private cached: Map<number, Uint8Array> = new Map();

  onFrame(feedId: number, callback: (payload: Uint8Array) => void): () => void {
    if (!this.callbacks.has(feedId)) {
      this.callbacks.set(feedId, []);
    }
    const list = this.callbacks.get(feedId)!;
    list.push(callback);
    // Mirror `TugConnection.onFrame`'s synchronous replay-on-subscribe
    // behavior so the filter-runs-on-replay test exercises the same code
    // path the real connection uses.
    const cached = this.cached.get(feedId);
    if (cached) {
      callback(cached);
    }
    return () => {
      const idx = list.indexOf(callback);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  /** Number of live callbacks registered for `feedId` (leak check). */
  callbackCount(feedId: number): number {
    return this.callbacks.get(feedId)?.length ?? 0;
  }

  /** Dispatch a frame on the live path. */
  emit(feedId: number, payload: Uint8Array): void {
    this.cached.set(feedId, payload);
    const cbs = this.callbacks.get(feedId);
    if (cbs) {
      for (const cb of cbs) cb(payload);
    }
  }

  /** Pre-seed the replay cache without running any callback. */
  seedCache(feedId: number, payload: Uint8Array): void {
    this.cached.set(feedId, payload);
  }
}

function makeMockConn(): { conn: TugConnection; mock: MockConnection } {
  const mock = new MockConnection();
  return { conn: mock as unknown as TugConnection, mock };
}

function encodeJson(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("defaultDecode shared cache", () => {
  test("the same payload object decodes once — all consumers share the value", () => {
    // TugConnection.dispatch hands one payload object to every card's
    // FeedStore; the WeakMap cache makes the 2nd..Nth decodes free.
    const payload = encodeJson({ type: "assistant_text", text: "hi" });
    const first = defaultDecode(payload);
    const second = defaultDecode(payload);
    expect(second).toBe(first);
    // A distinct payload (even byte-identical) decodes independently.
    const other = defaultDecode(encodeJson({ type: "assistant_text", text: "hi" }));
    expect(other).not.toBe(first);
    expect(other).toEqual(first as Record<string, unknown>);
  });
});

describe("FeedStore filter", () => {
  test("rejects a live frame — snapshot unchanged, listeners not notified", () => {
    const { conn, mock } = makeMockConn();
    const filter: FeedStoreFilter = (_feedId, decoded) => {
      const obj = decoded as { tug_session_id?: string };
      return obj.tug_session_id === "keep";
    };
    const store = new FeedStore(
      conn,
      [FeedId.SESSION_SIDEBAND] as readonly FeedIdValue[],
      undefined,
      filter,
    );

    let notifyCount = 0;
    store.subscribe(() => {
      notifyCount += 1;
    });

    // Snapshot starts empty.
    expect(store.getSnapshot().size).toBe(0);

    // Emit a frame that the filter should reject.
    mock.emit(
      FeedId.SESSION_SIDEBAND,
      encodeJson({ tug_session_id: "drop", type: "system_metadata" }),
    );

    expect(store.getSnapshot().size).toBe(0);
    expect(store.getSnapshot().has(FeedId.SESSION_SIDEBAND)).toBe(false);
    expect(notifyCount).toBe(0);
  });

  test("accepts a live frame — snapshot updated, listeners notified", () => {
    const { conn, mock } = makeMockConn();
    const filter: FeedStoreFilter = (_feedId, decoded) => {
      const obj = decoded as { tug_session_id?: string };
      return obj.tug_session_id === "keep";
    };
    const store = new FeedStore(
      conn,
      [FeedId.SESSION_SIDEBAND] as readonly FeedIdValue[],
      undefined,
      filter,
    );

    let notifyCount = 0;
    store.subscribe(() => {
      notifyCount += 1;
    });

    const payload = { tug_session_id: "keep", type: "system_metadata", model: "opus" };
    mock.emit(FeedId.SESSION_SIDEBAND, encodeJson(payload));

    expect(store.getSnapshot().size).toBe(1);
    expect(store.getSnapshot().get(FeedId.SESSION_SIDEBAND)).toEqual(payload);
    expect(notifyCount).toBe(1);
  });

  test("runs on the replay path — cached payload flows through filter", () => {
    // Scenario: by the time the FeedStore is constructed, the connection
    // already has a cached `lastPayload` for SESSION_SIDEBAND from a
    // prior emission. `TugConnection.onFrame` synchronously replays the
    // cached payload into the newly registered callback. Our filter MUST
    // run against that replayed payload; otherwise any multi-session
    // filter would silently admit stale frames intended for another
    // session when a card mounts after the frame arrived.
    const { conn, mock } = makeMockConn();

    // Pre-seed a cached payload for a session the filter will reject.
    mock.seedCache(
      FeedId.SESSION_SIDEBAND,
      encodeJson({ tug_session_id: "drop", type: "system_metadata" }),
    );

    const filter: FeedStoreFilter = (_feedId, decoded) => {
      const obj = decoded as { tug_session_id?: string };
      return obj.tug_session_id === "keep";
    };
    const store = new FeedStore(
      conn,
      [FeedId.SESSION_SIDEBAND] as readonly FeedIdValue[],
      undefined,
      filter,
    );

    // The filter was invoked with the cached payload during
    // `FeedStore`'s constructor (via onFrame → replay). It rejected,
    // so the snapshot is still empty.
    expect(store.getSnapshot().size).toBe(0);
  });

  test("runs on the replay path — cached payload flows through and is kept", () => {
    // Mirror of the previous test: when the filter accepts the cached
    // payload, the snapshot must reflect it immediately on construction.
    const { conn, mock } = makeMockConn();
    const payload = { tug_session_id: "keep", type: "system_metadata" };
    mock.seedCache(FeedId.SESSION_SIDEBAND, encodeJson(payload));

    const filter: FeedStoreFilter = (_feedId, decoded) => {
      const obj = decoded as { tug_session_id?: string };
      return obj.tug_session_id === "keep";
    };
    const store = new FeedStore(
      conn,
      [FeedId.SESSION_SIDEBAND] as readonly FeedIdValue[],
      undefined,
      filter,
    );

    expect(store.getSnapshot().size).toBe(1);
    expect(store.getSnapshot().get(FeedId.SESSION_SIDEBAND)).toEqual(payload);
  });

  test("no filter is passthrough — every decoded frame admitted", () => {
    const { conn, mock } = makeMockConn();
    const store = new FeedStore(
      conn,
      [FeedId.SESSION_SIDEBAND] as readonly FeedIdValue[],
    );

    const payload = { tug_session_id: "anything", type: "system_metadata" };
    mock.emit(FeedId.SESSION_SIDEBAND, encodeJson(payload));

    expect(store.getSnapshot().size).toBe(1);
    expect(store.getSnapshot().get(FeedId.SESSION_SIDEBAND)).toEqual(payload);
  });

  test("setFilter swaps the predicate for subsequent frames", () => {
    // TugPane installs a reactive filter on the existing
    // FeedStore via setFilter when its `workspaceKey` binding arrives.
    // This test verifies the mechanism directly: install a fallback filter,
    // emit a passing frame, swap to a stricter filter, verify the next
    // non-matching frame is rejected while a matching one is accepted.
    const { conn, mock } = makeMockConn();

    const presenceFilter: FeedStoreFilter = (_feedId, decoded) =>
      typeof decoded === "object" && decoded !== null && "workspace_key" in decoded;

    const store = new FeedStore(
      conn,
      [FeedId.SESSION_SIDEBAND] as readonly FeedIdValue[],
      undefined,
      presenceFilter,
    );

    // Fallback accepts any frame with `workspace_key`.
    mock.emit(
      FeedId.SESSION_SIDEBAND,
      encodeJson({ workspace_key: "/any", payload: "a" }),
    );
    expect(store.getSnapshot().size).toBe(1);

    // Tighten to an exact value-check for "/work/alpha".
    const exactFilter: FeedStoreFilter = (_feedId, decoded) =>
      typeof decoded === "object" &&
      decoded !== null &&
      "workspace_key" in decoded &&
      (decoded as { workspace_key: unknown }).workspace_key === "/work/alpha";
    store.setFilter(exactFilter);

    // Non-matching frame is rejected — snapshot for this feedId should stay
    // on the previous payload (setFilter does not purge cached data, per
    // its JSDoc).
    mock.emit(
      FeedId.SESSION_SIDEBAND,
      encodeJson({ workspace_key: "/work/beta", payload: "b" }),
    );
    expect(
      (store.getSnapshot().get(FeedId.SESSION_SIDEBAND) as { payload: string }).payload,
    ).toBe("a");

    // Matching frame is accepted.
    mock.emit(
      FeedId.SESSION_SIDEBAND,
      encodeJson({ workspace_key: "/work/alpha", payload: "c" }),
    );
    expect(
      (store.getSnapshot().get(FeedId.SESSION_SIDEBAND) as { payload: string }).payload,
    ).toBe("c");
  });

  test("dispose unregisters every feed callback (no leak)", () => {
    const { conn, mock } = makeMockConn();
    const store = new FeedStore(
      conn,
      [FeedId.SESSION_SIDEBAND, FeedId.DIGEST] as readonly FeedIdValue[],
    );
    expect(mock.callbackCount(FeedId.SESSION_SIDEBAND)).toBe(1);
    expect(mock.callbackCount(FeedId.DIGEST)).toBe(1);

    store.dispose();

    // The connection outlives the store; without unregistering, the
    // callback closures would pin the dead store forever.
    expect(mock.callbackCount(FeedId.SESSION_SIDEBAND)).toBe(0);
    expect(mock.callbackCount(FeedId.DIGEST)).toBe(0);
  });
});
