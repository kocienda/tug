/**
 * The Tripwires store over its feed: the roster is what the last frame said,
 * and the one thing still asked for — an open trip log — is re-asked exactly
 * when the roster says that log moved.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { TripwiresStore, type TripwireRow } from "../tripwires-store";
import type { TugConnection } from "../../connection";

type FrameHandler = (payload: Uint8Array) => void;

/** A connection that hands back the callback the store registered. */
function stubConnection(): { conn: TugConnection; push: (body: unknown) => void } {
  let handler: FrameHandler | null = null;
  const conn = {
    onFrame: (_feed: number, cb: FrameHandler) => {
      handler = cb;
      return () => {
        handler = null;
      };
    },
  } as unknown as TugConnection;
  return {
    conn,
    push: (body: unknown) => {
      const bytes =
        typeof body === "string"
          ? new TextEncoder().encode(body)
          : new TextEncoder().encode(JSON.stringify(body));
      handler?.(bytes);
    },
  };
}

function row(over: Partial<TripwireRow> = {}): TripwireRow {
  return {
    name: "ci",
    trigger: '{"fact":{"kind":"edit_failed"}}',
    scope: null,
    probe: null,
    brief: "report anything that looks wrong",
    model: null,
    branch: "main",
    permission_mode: "acceptEdits",
    paused: false,
    running: false,
    adopted: false,
    running_session: null,
    awaiting: false,
    awaiting_arc: null,
    last_trip: null,
    trip_log_revision: 7,
    ...over,
  };
}

const realFetch = globalThis.fetch;
let calls: string[] = [];

/** Every `/trips` answer is one row, so a load always commits something. */
function stubFetch(): void {
  calls = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    calls.push(String(input));
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ trips: [] }),
    } as Response);
  }) as typeof fetch;
}

/** Let the `loadTrips` promise chain settle before counting. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(stubFetch);
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("TripwiresStore over the TRIPWIRES feed", () => {
  test("a frame is the roster, and the first one is what `loaded` means", () => {
    const { conn, push } = stubConnection();
    const store = new TripwiresStore(conn);
    expect(store.getSnapshot().loaded).toBe(false);

    push({ tripwires: [row(), row({ name: "edits" })], error: null });

    const snapshot = store.getSnapshot();
    expect(snapshot.loaded).toBe(true);
    expect(snapshot.error).toBeNull();
    expect(snapshot.tripwires.map((w) => w.name)).toEqual(["ci", "edits"]);
    store.dispose();
  });

  test("a payload that will not parse keeps the rows it could not replace", () => {
    const { conn, push } = stubConnection();
    const store = new TripwiresStore(conn);
    push({ tripwires: [row()], error: null });

    push("{ not json at all");

    const snapshot = store.getSnapshot();
    expect(snapshot.tripwires.map((w) => w.name)).toEqual(["ci"]);
    expect(snapshot.error).toContain("tripwires frame");
    store.dispose();
  });

  test("an open log is re-asked when its revision moves, and not otherwise", async () => {
    const { conn, push } = stubConnection();
    const store = new TripwiresStore(conn);
    push({ tripwires: [row({ trip_log_revision: 7 })], error: null });

    await store.loadTrips("ci");
    await settle();
    expect(calls.length).toBe(1);

    // The same revision: nothing about that log changed, so nothing is asked.
    push({ tripwires: [row({ trip_log_revision: 7 })], error: null });
    await settle();
    expect(calls.length).toBe(1);

    // A revision that moved is the whole signal, and it buys exactly one ask.
    push({ tripwires: [row({ trip_log_revision: 8 })], error: null });
    await settle();
    expect(calls.length).toBe(2);
    expect(calls[1]).toContain("/api/tripwires/ci/trips");
    store.dispose();
  });

  test("a tripwire gone from the roster drops the log cached for it", async () => {
    const { conn, push } = stubConnection();
    const store = new TripwiresStore(conn);
    push({ tripwires: [row()], error: null });
    await store.loadTrips("ci");
    await settle();
    expect(Object.keys(store.getSnapshot().trips)).toEqual(["ci"]);

    push({ tripwires: [], error: null });
    await settle();

    expect(Object.keys(store.getSnapshot().trips)).toEqual([]);
    store.dispose();
  });

  test("no connection is a reason on the card, not a card that waits forever", () => {
    const store = new TripwiresStore(null);
    const snapshot = store.getSnapshot();
    expect(snapshot.loaded).toBe(true);
    expect(snapshot.error).toContain("no connection");
    store.dispose();
  });

  test("the snapshot is referentially stable when nothing was committed", () => {
    const { conn, push } = stubConnection();
    const store = new TripwiresStore(conn);
    push({ tripwires: [row()], error: null });

    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    push({ tripwires: [row()], error: null });
    expect(store.getSnapshot()).not.toBe(first);
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    store.dispose();
  });
});
