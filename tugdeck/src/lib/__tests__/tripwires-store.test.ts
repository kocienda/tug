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
    description: "Reports anything that looks wrong on main",
    model: null,
    permission_mode: "acceptEdits",
    paused: false,
    running: false,
    adopted: false,
    open_session: null,
    awaiting: false,
    awaiting_arc: null,
    adopted_arc: null,
    last_trip: null,
    trip_count: 0,
    trip_log_revision: 7,
    ...over,
  };
}

const realFetch = globalThis.fetch;
let calls: string[] = [];
let methods: string[] = [];
let bodies: (string | null)[] = [];
let failTrips = false;

/** Every `/trips` answer is one row, so a load always commits something. */
function stubFetch(): void {
  calls = [];
  methods = [];
  bodies = [];
  failTrips = false;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    methods.push(init?.method ?? "GET");
    bodies.push(typeof init?.body === "string" ? init.body : null);
    if (failTrips && String(input).includes("/trips")) {
      return Promise.resolve({ ok: false, status: 503 } as Response);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ trips: [] } as unknown),
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
    // And it asks for the whole of what the ledger keeps, so the fold's
    // older-trips cue bottoms out at the log rather than at a server default
    // four hundred and fifty rows short of it.
    expect(calls[1]).toContain("limit=500");
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

  test("a log that will not read says so under its own row, not over the card", async () => {
    const { conn, push } = stubConnection();
    const store = new TripwiresStore(conn);
    push({ tripwires: [row(), row({ name: "edits" })], error: null });

    failTrips = true;
    await store.loadTrips("ci");
    await settle();

    // Scoped to the row whose log it is: `edits` is untouched, and no banner
    // goes over a card whose roster read perfectly well [B10].
    expect(store.getSnapshot().logErrors.ci).toContain("503");
    expect(store.getSnapshot().logErrors.edits).toBeUndefined();
    expect(store.getSnapshot().error).toBeNull();

    failTrips = false;
    await store.loadTrips("ci");
    await settle();

    expect(store.getSnapshot().logErrors.ci).toBeUndefined();
    expect(store.getSnapshot().trips.ci).toEqual([]);
    store.dispose();
  });

  test("a feed failure stays on the roster and a healthy log does not clear it", async () => {
    const { conn, push } = stubConnection();
    const store = new TripwiresStore(conn);
    push({ tripwires: [row()], error: "the ledger could not be read" });

    await store.loadTrips("ci");
    await settle();

    // The log read succeeding says nothing about the roster, so the reason the
    // roster is stale is still on the card.
    expect(store.getSnapshot().error).toBe("the ledger could not be read");
    store.dispose();
  });

  test("a knob write posts only the knob it was asked to move", async () => {
    const { conn, push } = stubConnection();
    const store = new TripwiresStore(conn);
    push({ tripwires: [row()], error: null });

    await store.setKnobs("ci", { paused: true });
    await store.setKnobs("ci", { model: "opus" });
    // The session default clears the column, and `null` has to survive the
    // round trip as a value rather than being dropped as an absent field —
    // an omitted `model` means "leave it alone", which is the opposite.
    await store.setKnobs("ci", { model: null });
    await settle();

    expect(calls.filter((c) => c.endsWith("/api/tripwires/ci"))).toHaveLength(3);
    expect(bodies.slice(0, 3)).toEqual([
      `{"paused":true}`,
      `{"model":"opus"}`,
      `{"model":null}`,
    ]);
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

  test("remove sends a DELETE and drops no row of its own", async () => {
    const { conn, push } = stubConnection();
    const store = new TripwiresStore(conn);
    push({ tripwires: [row(), row({ name: "edits" })], error: null });

    await store.remove("ci");

    expect(calls).toEqual(["/api/tripwires/ci"]);
    expect(methods).toEqual(["DELETE"]);
    expect(store.getSnapshot().tripwires.map((w) => w.name)).toEqual([
      "ci",
      "edits",
    ]);
    expect(store.getSnapshot().error).toBeNull();

    // The feed is what takes the row off, and it does so on the ledger's next
    // frame rather than on this call's return.
    push({ tripwires: [row({ name: "edits" })], error: null });
    expect(store.getSnapshot().tripwires.map((w) => w.name)).toEqual(["edits"]);
    store.dispose();
  });

  test("a refused remove reports why and moves nothing", async () => {
    const { conn, push } = stubConnection();
    const store = new TripwiresStore(conn);
    push({ tripwires: [row()], error: null });
    globalThis.fetch = ((): Promise<Response> =>
      Promise.resolve({
        ok: false,
        status: 409,
      } as Response)) as unknown as typeof fetch;

    await store.remove("ci");

    expect(store.getSnapshot().error).toContain("409");
    expect(store.getSnapshot().tripwires.map((w) => w.name)).toEqual(["ci"]);
    store.dispose();
  });
});
