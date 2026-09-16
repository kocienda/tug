/**
 * deck-trace.test.ts — pure-logic unit tests for the ring buffer
 * and public API surface of `deck-trace.ts`.
 *
 * These tests intentionally avoid DOM-level coverage: integration
 * tests that wire the trace into real focus / observer behavior are
 * separate. The event-union shape, the bounded ring's eviction
 * policy, the `since(seq)` slice, the enable-gate, and the `mark()`
 * monotonic counter are all exercisable without touching the DOM.
 *
 * The trace module is a module-level singleton, so every test starts
 * by calling `deckTrace.clear()` and `deckTrace.enable(true)` (or
 * `false` where a test asserts the gate). `clear()` preserves the
 * sequence counter by contract, so assertions that compare seq
 * values compute them relative to `mark()` rather than against
 * absolute constants.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  deckTrace,
  DECK_TRACE_CAPACITY,
  type DeckTraceEvent,
} from "../deck-trace";
import { registerDeckStore } from "../lib/deck-store-registry";

/**
 * Record `n` `commit-tick` events with increasing `count`, returning
 * the first and last `seq` assigned. `commit-tick` is the simplest
 * variant — no payload beyond `count` — so it is the natural choice
 * for bulk-append tests.
 */
function recordTicks(n: number, startCount = 0): { firstSeq: number; lastSeq: number } {
  const before = deckTrace.mark();
  for (let i = 0; i < n; i++) {
    deckTrace.record({ kind: "commit-tick", count: startCount + i });
  }
  const after = deckTrace.mark();
  return { firstSeq: before + 1, lastSeq: after };
}

beforeEach(() => {
  deckTrace.clear();
  deckTrace.enable(true);
});

describe("deckTrace ring buffer", () => {
  test("appends events up to capacity; the (capacity + 1)th evicts the oldest", () => {
    recordTicks(DECK_TRACE_CAPACITY);

    const filled = deckTrace.dump();
    expect(filled.length).toBe(DECK_TRACE_CAPACITY);
    // Oldest is the first count we recorded (0).
    expect((filled[0] as Extract<DeckTraceEvent, { kind: "commit-tick" }>).count).toBe(0);
    // Newest is count = capacity - 1.
    expect(
      (filled[filled.length - 1] as Extract<DeckTraceEvent, { kind: "commit-tick" }>).count,
    ).toBe(DECK_TRACE_CAPACITY - 1);

    // One more record should evict the oldest and keep the length pinned
    // at capacity.
    deckTrace.record({ kind: "commit-tick", count: DECK_TRACE_CAPACITY });

    const afterEvict = deckTrace.dump();
    expect(afterEvict.length).toBe(DECK_TRACE_CAPACITY);
    // New oldest is count = 1 (original count = 0 was evicted).
    expect(
      (afterEvict[0] as Extract<DeckTraceEvent, { kind: "commit-tick" }>).count,
    ).toBe(1);
    // New newest is count = capacity.
    expect(
      (afterEvict[afterEvict.length - 1] as Extract<DeckTraceEvent, { kind: "commit-tick" }>)
        .count,
    ).toBe(DECK_TRACE_CAPACITY);
  });

  test("seq counter is monotonic across eviction — `since` returns a strictly forward slice even after wrap", () => {
    // Fill the ring and overrun by 10 entries so several evictions have
    // happened. `since(markBefore)` should still return exactly the
    // events whose seq is greater than the mark, and their seqs must
    // be strictly increasing.
    const markBefore = deckTrace.mark();
    recordTicks(DECK_TRACE_CAPACITY + 10);

    const slice = deckTrace.since(markBefore);
    // Ring can hold at most `DECK_TRACE_CAPACITY` events; the 10 oldest
    // were evicted, leaving `DECK_TRACE_CAPACITY`.
    expect(slice.length).toBe(DECK_TRACE_CAPACITY);

    for (let i = 0; i < slice.length - 1; i++) {
      expect(slice[i]!.seq).toBeLessThan(slice[i + 1]!.seq);
      // Every event is strictly greater than markBefore.
      expect(slice[i]!.seq).toBeGreaterThan(markBefore);
    }
  });
});

describe("deckTrace.since(seq)", () => {
  test("returns only events with seq strictly greater than the provided mark", () => {
    recordTicks(3);
    const mid = deckTrace.mark();
    recordTicks(2, 100);

    const after = deckTrace.since(mid);
    expect(after.length).toBe(2);
    for (const e of after) {
      expect(e.seq).toBeGreaterThan(mid);
      expect(e.kind).toBe("commit-tick");
    }

    // Since(before-everything) returns everything.
    const all = deckTrace.since(0);
    expect(all.length).toBe(5);

    // Since(latest mark) returns nothing.
    const latest = deckTrace.mark();
    const tail = deckTrace.since(latest);
    expect(tail.length).toBe(0);
  });

  test("returns a fresh array — mutating the result does not affect the ring", () => {
    recordTicks(3);
    const slice = deckTrace.since(0) as DeckTraceEvent[];
    slice.length = 0;

    expect(deckTrace.dump().length).toBe(3);
  });
});

describe("deckTrace.enable(false) gates recording", () => {
  test("record is a no-op under enable(false); dump returns empty and seq does not advance", () => {
    deckTrace.enable(false);
    const seqBefore = deckTrace.mark();

    deckTrace.record({ kind: "commit-tick", count: 1 });
    deckTrace.record({
      kind: "fr-flip",
      from: null,
      to: "card-a",
      trigger: "test",
    });
    deckTrace.record({
      kind: "save-callback",
      cardId: "card-a",
      source: "manual",
    });

    expect(deckTrace.dump().length).toBe(0);
    expect(deckTrace.mark()).toBe(seqBefore);
  });

  test("toggling enable(false) → enable(true) resumes recording without clearing prior events", () => {
    // Prior events, recorded with enable(true).
    recordTicks(2);
    const afterWarm = deckTrace.dump().length;
    expect(afterWarm).toBe(2);

    // Gate closed — new records are dropped.
    deckTrace.enable(false);
    deckTrace.record({ kind: "commit-tick", count: 99 });
    expect(deckTrace.dump().length).toBe(2);

    // Gate reopened — new records append.
    deckTrace.enable(true);
    deckTrace.record({ kind: "commit-tick", count: 100 });
    const final = deckTrace.dump();
    expect(final.length).toBe(3);
    expect(
      (final[final.length - 1] as Extract<DeckTraceEvent, { kind: "commit-tick" }>).count,
    ).toBe(100);
  });

  test("scroll-displacement and follow-bottom record through a closed gate", () => {
    // These two kinds are records of a defect that arrives
    // unannounced, so they ignore the gate: a session found stranded
    // hours later must carry its own evidence, and nobody was there
    // to call `enable(true)` first.
    deckTrace.enable(false);
    const seqBefore = deckTrace.mark();

    deckTrace.record({ kind: "commit-tick", count: 1 });
    expect(deckTrace.dump().length).toBe(0);

    deckTrace.record({
      kind: "follow-bottom",
      following: false,
      source: "unattributed-scroll-up",
    });
    deckTrace.record({
      kind: "scroll-displacement",
      from: 39_000,
      to: 36_340,
      scrollHeight: 44_262,
      clientHeight: 700,
      following: true,
      evicting: true,
    });

    const recorded = deckTrace.dump();
    expect(recorded.length).toBe(2);
    expect(recorded.map((e) => e.kind)).toEqual([
      "follow-bottom",
      "scroll-displacement",
    ]);
    // The gate-exempt kinds still stamp seq like any other record.
    expect(deckTrace.mark()).toBe(seqBefore + 2);
  });
});

describe("deckTrace.mark()", () => {
  test("returns the current sequence counter and is monotonic", () => {
    const start = deckTrace.mark();
    expect(typeof start).toBe("number");

    recordTicks(1);
    const after1 = deckTrace.mark();
    expect(after1).toBe(start + 1);

    recordTicks(4);
    const after5 = deckTrace.mark();
    expect(after5).toBe(start + 5);
  });

  test("mark() is preserved across clear() — sequence never rewinds", () => {
    recordTicks(3);
    const before = deckTrace.mark();

    deckTrace.clear();
    expect(deckTrace.dump().length).toBe(0);
    expect(deckTrace.mark()).toBe(before);

    // Record after clear — new seq strictly greater than pre-clear mark.
    deckTrace.record({ kind: "commit-tick", count: 0 });
    expect(deckTrace.mark()).toBe(before + 1);
    const dumped = deckTrace.dump();
    expect(dumped[0]!.seq).toBe(before + 1);
  });
});

describe("deckTrace.record stamps caller loc", () => {
  test("loc points at the test file (not deck-trace itself)", () => {
    deckTrace.record({ kind: "commit-tick", count: 0 });
    const events = deckTrace.dump();
    expect(events).toHaveLength(1);
    const loc = events[0]!.loc;
    expect(typeof loc).toBe("string");
    // The caller is this test file. deck-trace.ts frames are skipped
    // by captureCallerLoc, so the first non-internal frame should be
    // deck-trace.test.ts on bun/JSC's stack.
    expect(loc).toMatch(/deck-trace\.test\.ts:\d+:\d+$/);
  });

  test("loc is stamped on every variant, not just commit-tick", () => {
    deckTrace.record({
      kind: "fr-flip",
      from: "a",
      to: "b",
      trigger: "activateCard",
    });
    deckTrace.record({
      kind: "destination-flip",
      cardId: "b",
      from: false,
      to: true,
    });
    deckTrace.record({
      kind: "save-callback",
      cardId: "a",
      source: "manual",
    });
    for (const e of deckTrace.dump()) {
      expect(typeof e.loc).toBe("string");
      // Every event's loc should either be empty (capture failure,
      // tolerated) or reference a .ts / .tsx file and not the trace
      // module itself.
      if (e.loc!.length > 0) {
        expect(e.loc).toMatch(/\.tsx?:\d+:\d+$/);
        expect(e.loc).not.toMatch(/deck-trace\.ts:/);
      }
    }
  });
});

describe("deckTrace.record stamps store snapshot", () => {
  test("store is null when no DeckManager is registered", () => {
    // beforeEach clears the trace and enables recording, but does
    // NOT register a store — so the registry sits at its default
    // null. captureStoreSnapshot must tolerate this rather than
    // crashing the record call.
    registerDeckStore(null);
    deckTrace.record({ kind: "commit-tick", count: 0 });
    const events = deckTrace.dump();
    expect(events).toHaveLength(1);
    expect(events[0]!.store).toBeNull();
  });

  test("store carries activePaneId, derived activeCardId, and hasFocus when registered", () => {
    const fakeState = {
      cards: [
        { id: "c1", componentId: "noop", paneId: "p1", flags: {}, componentState: {} },
        { id: "c2", componentId: "noop", paneId: "p1", flags: {}, componentState: {} },
      ],
      panes: [
        {
          id: "p1",
          position: { x: 0, y: 0 },
          size: { width: 100, height: 100 },
          cardIds: ["c1", "c2"],
          activeCardId: "c2",
          title: "",
          acceptsFamilies: [],
        },
      ],
      activePaneId: "p1",
      hasFocus: true,
    } as const;
    const fakeStore = {
      subscribe: (_: () => void) => () => {},
      getSnapshot: () => fakeState as unknown as ReturnType<NonNullable<Parameters<typeof registerDeckStore>[0]>["getSnapshot"]>,
      getVersion: () => 0,
    } as unknown as Parameters<typeof registerDeckStore>[0];
    registerDeckStore(fakeStore);
    try {
      deckTrace.record({
        kind: "fr-flip",
        from: "c1",
        to: "c2",
        trigger: "activateCard",
      });
      const events = deckTrace.dump();
      expect(events).toHaveLength(1);
      const store = events[0]!.store;
      expect(store).not.toBeNull();
      expect(store!.activePaneId).toBe("p1");
      expect(store!.activeCardId).toBe("c2");
      expect(store!.hasFocus).toBe(true);
    } finally {
      // Reset the singleton so later tests see the default null state.
      registerDeckStore(null);
    }
  });

  test("store handles missing active pane / null activePaneId gracefully", () => {
    const fakeState = {
      cards: [],
      panes: [],
      // No activePaneId — this is the empty-deck state.
      hasFocus: false,
    } as const;
    const fakeStore = {
      subscribe: (_: () => void) => () => {},
      getSnapshot: () => fakeState as unknown as ReturnType<NonNullable<Parameters<typeof registerDeckStore>[0]>["getSnapshot"]>,
      getVersion: () => 0,
    } as unknown as Parameters<typeof registerDeckStore>[0];
    registerDeckStore(fakeStore);
    try {
      deckTrace.record({ kind: "commit-tick", count: 0 });
      const events = deckTrace.dump();
      expect(events).toHaveLength(1);
      const store = events[0]!.store;
      expect(store).not.toBeNull();
      expect(store!.activePaneId).toBeNull();
      expect(store!.activeCardId).toBeNull();
      expect(store!.hasFocus).toBe(false);
    } finally {
      registerDeckStore(null);
    }
  });

  test("store snapshot tolerates getSnapshot throwing (captureStoreSnapshot returns null)", () => {
    const fakeStore = {
      subscribe: (_: () => void) => () => {},
      getSnapshot: () => {
        throw new Error("deliberate failure for test");
      },
      getVersion: () => 0,
    } as unknown as Parameters<typeof registerDeckStore>[0];
    registerDeckStore(fakeStore);
    try {
      deckTrace.record({ kind: "commit-tick", count: 0 });
      const events = deckTrace.dump();
      expect(events).toHaveLength(1);
      expect(events[0]!.store).toBeNull();
    } finally {
      registerDeckStore(null);
    }
  });
});

describe("deckTrace space-switch-timing", () => {
  test("every Spec S01 field survives the ring, and the kind is opt-in", () => {
    const reading = {
      kind: "space-switch-timing",
      fromSpaceId: "space-a",
      toSpaceId: "space-b",
      outgoingCards: 3,
      incomingCards: 2,
      commitMs: 1.25,
      restoreMs: 0.75,
      totalMs: 7,
      paintMs: 41,
    } as const;

    // Off by default for this kind: it is a measurement under study, not
    // evidence of a defect, so it must not be in ALWAYS_RECORDED_KINDS.
    deckTrace.enable(false);
    deckTrace.record({ ...reading });
    expect(deckTrace.dump()).toHaveLength(0);

    deckTrace.enable(true);
    deckTrace.record({ ...reading });

    const events = deckTrace.dump();
    expect(events).toHaveLength(1);
    const event = events[0] as Extract<
      DeckTraceEvent,
      { kind: "space-switch-timing" }
    >;
    // The whole payload, field for field — this test is the instrument's
    // own contract. No timing assertion: what the numbers say is the
    // measurement's business, not the ring's.
    expect(event.fromSpaceId).toBe("space-a");
    expect(event.toSpaceId).toBe("space-b");
    expect(event.outgoingCards).toBe(3);
    expect(event.incomingCards).toBe(2);
    expect(event.commitMs).toBe(1.25);
    expect(event.restoreMs).toBe(0.75);
    expect(event.totalMs).toBe(7);
    expect(event.paintMs).toBe(41);
    expect(typeof event.timestamp).toBe("number");
    expect(typeof event.seq).toBe("number");
  });
});
