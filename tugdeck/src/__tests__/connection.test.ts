/**
 * `TugConnection` heartbeat-watchdog unit tests.
 *
 * Drives a real `TugConnection` against a stubbed `WebSocket` and a
 * manually controlled clock + interval table. The watchdog reads
 * `Date.now()` and runs on `window.setInterval`, so each test
 *
 *   - sets the simulated wall-clock with `setSystemTime`,
 *   - captures every `setInterval` callback the connection registers,
 *   - advances time in steps that fire those callbacks deterministically,
 *
 * which is enough to assert the watchdog's force-close behavior without
 * sleeping for tens of seconds.
 *
 * Coverage:
 *   - Crossing the silence threshold probes rather than closing.
 *   - An answer during the grace window re-arms the watchdog.
 *   - An unanswered probe force-closes once the grace window expires.
 *   - A frame mid-window defers the whole cycle by the size of the gap.
 *   - The wake pulse fires on a visibility transition, and only when
 *     there is an open socket to send it on.
 */

import { describe, it, expect, beforeEach, afterEach, setSystemTime } from "bun:test";

// `connection.ts` reaches for browser globals (`window.setInterval`,
// `window.setTimeout`, `WebSocket`) directly, so the bun test runtime
// — which does not ship a DOM — needs a minimal alias. Pointing
// `globalThis.window` at `globalThis` lets `window.setInterval` resolve
// to `globalThis.setInterval`; the test's `installFakes` then replaces
// those with captured stubs. Done before importing the SUT so the
// module sees the alias the moment its top-level statements run.
if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = globalThis;
}

import { TugConnection } from "@/connection";
import { encodeFrame, FeedId, FrameFlags } from "@/protocol";

// ---------------------------------------------------------------------------
// FakeWebSocket — a passive stand-in for the browser's WebSocket.
// ---------------------------------------------------------------------------
//
// The real client opens a socket in `connect()` and reacts to events the
// server pushes back. Tests need to drive those events in a controlled
// order, so this mock captures `onopen` / `onmessage` / `onclose`
// without doing any I/O. `close()` increments a counter; we assert on
// it directly rather than chaining the mock back into a synthetic
// onclose dispatch.

class FakeWebSocket {
  /** The most recently constructed socket, which the tests drive. */
  static last: FakeWebSocket | null = null;
  static readonly OPEN = 1;

  binaryType: string = "blob";
  readyState: number = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  url: string;
  readonly sent: Array<string | ArrayBufferLike> = [];
  closeCalls: number = 0;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.last = this;
  }

  send(data: string | ArrayBufferLike): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
  }

  // ── Test helpers ─────────────────────────────────────────────────────────

  fireOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  fireMessage(data: string | ArrayBuffer): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  /**
   * Synchronously dispatch the `onclose` event so tests can drive the
   * connection's close path directly. The real browser would fire this
   * after `close()` is called or on remote disconnect; the fake leaves
   * the trigger to the test for deterministic ordering.
   */
  fireClose(code: number = 1000, reason: string = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

// ---------------------------------------------------------------------------
// Manual interval / timeout table.
// ---------------------------------------------------------------------------
//
// Real `setInterval` would race with the test's assertions, and
// `setSystemTime` does not advance pending timers. Replacing
// `window.setInterval` / `window.setTimeout` with a captured table lets
// the test step time forward and fire the callbacks that fall due, in
// order, against the simulated clock.

interface IntervalEntry {
  id: number;
  cb: () => void;
  intervalMs: number;
  nextFire: number;
}

let intervals: Map<number, IntervalEntry>;
let nextTimerId: number;
let mockNow: number;
let scheduledTimeouts: Array<{ cb: () => void; ms: number }> = [];

let origSetInterval: typeof window.setInterval;
let origClearInterval: typeof window.clearInterval;
let origSetTimeout: typeof window.setTimeout;
let origClearTimeout: typeof window.clearTimeout;
let origWebSocket: typeof globalThis.WebSocket;
let origDocument: unknown;

// ---------------------------------------------------------------------------
// Minimal `document` stand-in for the wake pulse.
// ---------------------------------------------------------------------------
//
// The connection registers a `visibilitychange` listener and reads
// `document.visibilityState`. That is the whole surface it touches —
// no rendering, no tree, no layout. This stub is a listener registry
// and one string, in the same spirit as `FakeWebSocket` above: it lets
// the test drive the event the SUT actually listens for. (It is not a
// DOM substrate; nothing here renders anything.)

interface FakeDocument {
  visibilityState: string;
  listeners: Map<string, Set<() => void>>;
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
}

let fakeDocument: FakeDocument;

function makeFakeDocument(): FakeDocument {
  return {
    visibilityState: "visible",
    listeners: new Map(),
    addEventListener(type: string, cb: () => void): void {
      let set = this.listeners.get(type);
      if (set === undefined) {
        set = new Set();
        this.listeners.set(type, set);
      }
      set.add(cb);
    },
    removeEventListener(type: string, cb: () => void): void {
      this.listeners.get(type)?.delete(cb);
    },
  };
}

/** Set `visibilityState` and dispatch `visibilitychange` to listeners. */
function fireVisibilityChange(state: string): void {
  fakeDocument.visibilityState = state;
  for (const cb of fakeDocument.listeners.get("visibilitychange") ?? []) {
    cb();
  }
}

const BASE_TIME_MS = 1_700_000_000_000; // an arbitrary deterministic epoch

function installFakes(): void {
  intervals = new Map();
  nextTimerId = 1;
  mockNow = BASE_TIME_MS;
  setSystemTime(new Date(mockNow));

  origSetInterval = window.setInterval;
  origClearInterval = window.clearInterval;
  origSetTimeout = window.setTimeout;
  origClearTimeout = window.clearTimeout;
  origWebSocket = globalThis.WebSocket;
  origDocument = (globalThis as { document?: unknown }).document;
  fakeDocument = makeFakeDocument();
  (globalThis as unknown as { document: FakeDocument }).document = fakeDocument;

  // Simulated `setInterval`: capture the callback so the test can fire
  // it at the right simulated timestamp.
  (window as unknown as { setInterval: (cb: () => void, ms: number) => number })
    .setInterval = (cb: () => void, ms: number): number => {
      const id = nextTimerId++;
      intervals.set(id, { id, cb, intervalMs: ms, nextFire: mockNow + ms });
      return id;
    };

  (window as unknown as { clearInterval: (id?: number) => void })
    .clearInterval = (id?: number): void => {
      if (id !== undefined) intervals.delete(id);
    };

  // The connection schedules reconnection via `setTimeout`. The watchdog
  // tests never let `onclose` fire (a forced close in this mock just
  // bumps a counter), so the reconnect path never runs — but stubbing
  // these stops `connect()`'s reconnect machinery from leaking real
  // timers into the test. Registrations are recorded rather than
  // discarded so a test can assert that a reconnect was *scheduled*
  // without waiting for it to fire.
  scheduledTimeouts = [];
  (window as unknown as { setTimeout: (cb: () => void, ms: number) => number })
    .setTimeout = (cb: () => void, ms: number): number => {
      scheduledTimeouts.push({ cb, ms });
      return scheduledTimeouts.length;
    };
  (window as unknown as { clearTimeout: (id?: number) => void })
    .clearTimeout = (_id?: number): void => {};

  (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket =
    FakeWebSocket;
}

function uninstallFakes(): void {
  window.setInterval = origSetInterval;
  window.clearInterval = origClearInterval;
  window.setTimeout = origSetTimeout;
  window.clearTimeout = origClearTimeout;
  (globalThis as unknown as { WebSocket: typeof globalThis.WebSocket })
    .WebSocket = origWebSocket;
  // Assigned, never `delete`d — see `list-view-reveal.test.ts`.
  (globalThis as { document?: unknown }).document = origDocument;
  setSystemTime();
  FakeWebSocket.last = null;
}

/**
 * Advance the simulated clock by `deltaMs`, firing every captured
 * interval whose next-fire timestamp lands inside the window. Each
 * fire moves the clock to that timestamp before invoking the callback,
 * so callbacks observe `Date.now()` at their actual scheduled time —
 * not at the destination of the advance.
 */
function advanceTime(deltaMs: number): void {
  const target = mockNow + deltaMs;
  while (true) {
    let next: IntervalEntry | null = null;
    for (const entry of intervals.values()) {
      if (
        entry.nextFire <= target &&
        (next === null || entry.nextFire < next.nextFire)
      ) {
        next = entry;
      }
    }
    if (next === null) break;
    mockNow = next.nextFire;
    setSystemTime(new Date(mockNow));
    next.nextFire = mockNow + next.intervalMs;
    next.cb();
  }
  mockNow = target;
  setSystemTime(new Date(mockNow));
}

/** Drive a `TugConnection` through `connect()` and the handshake. */
function completeHandshake(conn: TugConnection): FakeWebSocket {
  conn.connect();
  const ws = FakeWebSocket.last;
  if (ws === null) throw new Error("WebSocket was not constructed");
  ws.fireOpen();
  ws.fireMessage(JSON.stringify({ protocol: "tugcast", version: 1 }));
  return ws;
}

/** A binary HEARTBEAT frame, encoded the same way the real server would. */
function heartbeatFrame(): ArrayBuffer {
  return encodeFrame({
    feedId: FeedId.HEARTBEAT,
    flags: FrameFlags.DATA,
    payload: new Uint8Array(0),
  });
}

// ---------------------------------------------------------------------------

describe("TugConnection — heartbeat watchdog", () => {
  beforeEach(() => {
    installFakes();
  });

  afterEach(() => {
    uninstallFakes();
  });

  it("probes instead of closing when the silence threshold is crossed", () => {
    const conn = new TugConnection("ws://test.invalid/");
    const ws = completeHandshake(conn);

    // t=45 s — the outbound heartbeat interval has fired three times by
    // now (15/30/45 s); the watchdog check at this tick sees exactly
    // 45 000 ms of silence, which does not *exceed* the threshold.
    advanceTime(45_000);
    const sentBeforeThreshold = ws.sent.length;

    // t=50 s — the first tick past the threshold. No outbound heartbeat
    // interval falls in this 5 s gap, so the single extra frame is the
    // watchdog's probe, and the socket is left open.
    advanceTime(5_000);
    expect(ws.closeCalls).toBe(0);
    expect(ws.sent.length).toBe(sentBeforeThreshold + 1);
  });

  it("re-arms and leaves the socket open when the probe is answered", () => {
    const conn = new TugConnection("ws://test.invalid/");
    const ws = completeHandshake(conn);

    // t=50 s — threshold crossed, probe sent, grace window open.
    advanceTime(50_000);
    expect(ws.closeCalls).toBe(0);

    // The server answers. `lastFrameAt` advances past the value it
    // held when the probe went out.
    ws.fireMessage(heartbeatFrame());

    // t=65 s — well past the 10 s grace window. Because the wire
    // answered, the watchdog closed the grace window instead of
    // condemning the socket.
    advanceTime(15_000);
    expect(ws.closeCalls).toBe(0);
  });

  it("force-closes once the grace window expires with no answer", () => {
    const conn = new TugConnection("ws://test.invalid/");
    const ws = completeHandshake(conn);

    // t=50 s — probe sent, grace window opens.
    advanceTime(50_000);
    expect(ws.closeCalls).toBe(0);

    // t=55 s — 5 s into a 10 s grace window; still waiting.
    advanceTime(5_000);
    expect(ws.closeCalls).toBe(0);

    // t=60 s — grace expired with the wire still silent. Dead.
    advanceTime(5_000);
    expect(ws.closeCalls).toBe(1);
  });

  it("a single mid-window frame defers the whole cycle by exactly the gap", () => {
    const conn = new TugConnection("ws://test.invalid/");
    const ws = completeHandshake(conn);

    // t=30 s — server delivers a HEARTBEAT echo. `lastFrameAt` resets.
    advanceTime(30_000);
    expect(ws.closeCalls).toBe(0);
    ws.fireMessage(heartbeatFrame());

    // t=50 s — only 20 s since the frame at t=30 s; under the
    // threshold, so not even a probe yet.
    advanceTime(20_000);
    expect(ws.closeCalls).toBe(0);

    // t=80 s — 50 s of silence since the frame; the probe goes out.
    advanceTime(30_000);
    expect(ws.closeCalls).toBe(0);

    // t=90 s — grace expired unanswered.
    advanceTime(10_000);
    expect(ws.closeCalls).toBe(1);
  });
});

describe("TugConnection — wake pulse", () => {
  beforeEach(() => {
    installFakes();
  });

  afterEach(() => {
    uninstallFakes();
  });

  it("sends exactly one heartbeat when the page becomes visible", () => {
    const conn = new TugConnection("ws://test.invalid/");
    const ws = completeHandshake(conn);
    const sentAfterHandshake = ws.sent.length;

    fireVisibilityChange("visible");

    expect(ws.sent.length).toBe(sentAfterHandshake + 1);
  });

  it("sends nothing when the page is hidden rather than revealed", () => {
    const conn = new TugConnection("ws://test.invalid/");
    const ws = completeHandshake(conn);
    const sentAfterHandshake = ws.sent.length;

    fireVisibilityChange("hidden");

    expect(ws.sent.length).toBe(sentAfterHandshake);
  });

  it("sends nothing on a wake with no open socket", () => {
    const conn = new TugConnection("ws://test.invalid/");
    const ws = completeHandshake(conn);
    const sentAfterHandshake = ws.sent.length;

    // The wire drops. `stopHeartbeat` releases the visibility listener
    // along with the timers, so a later wake finds nothing armed.
    ws.fireClose(1006, "abnormal");
    fireVisibilityChange("visible");

    expect(ws.sent.length).toBe(sentAfterHandshake);
  });
});

describe("TugConnection — the intentional-close latch is per-close, not per-instance", () => {
  beforeEach(() => {
    installFakes();
  });

  afterEach(() => {
    uninstallFakes();
  });

  it("schedules a reconnect after an unexpected close that follows an explicit close()", () => {
    const conn = new TugConnection("ws://test.invalid/");
    completeHandshake(conn);

    // An explicit close: no reconnect should be scheduled for it.
    conn.close();
    expect(scheduledTimeouts.length).toBe(0);

    // A fresh connect, then the wire drops on its own. The latch set by
    // `close()` must not still be holding, or this close returns early
    // from `onclose` and the transport stays dead forever.
    const ws = completeHandshake(conn);
    ws.fireClose(1006, "abnormal");

    expect(scheduledTimeouts.length).toBe(1);
  });
});

/**
 * Encode a SESSION_STATE frame whose decoded form is
 * `{ tug_session_id, state }` — sufficient to populate the
 * `lastPayload` cache for the SESSION_STATE feed without dragging in
 * the full server-side encoder. The bytes are opaque to the test —
 * the assertion is on whether the cache replays them or not.
 */
function sessionStateFrame(payload: object): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return encodeFrame({
    feedId: FeedId.SESSION_STATE,
    flags: FrameFlags.DATA,
    payload: bytes,
  });
}

describe("TugConnection — lastPayload cleared on close", () => {
  beforeEach(() => {
    installFakes();
  });

  afterEach(() => {
    uninstallFakes();
  });

  it("a callback registered after onclose receives no replay of pre-close frames", () => {
    const conn = new TugConnection("ws://test.invalid/");
    const ws = completeHandshake(conn);

    // Populate `lastPayload` for the SESSION_STATE feed via a normal
    // dispatch. The first subscriber sees the frame on arrival.
    const earlyDeliveries: Uint8Array[] = [];
    conn.onFrame(FeedId.SESSION_STATE, (payload) => {
      earlyDeliveries.push(payload);
    });
    ws.fireMessage(sessionStateFrame({
      tug_session_id: "tug-1",
      state: "live",
    }));
    expect(earlyDeliveries.length).toBe(1);

    // Drop the wire. `onclose` should clear `lastPayload` before any
    // reconnect logic runs; `notifyConnectionDidClose` and
    // `scheduleReconnect` consequently observe an empty cache.
    ws.fireClose(1006, "abnormal");

    // A late subscriber registers for the same feed. Without [D05]'s
    // cache clear, `onFrame`'s replay path would fire this callback
    // with the stale pre-close payload.
    const lateDeliveries: Uint8Array[] = [];
    conn.onFrame(FeedId.SESSION_STATE, (payload) => {
      lateDeliveries.push(payload);
    });
    expect(lateDeliveries.length).toBe(0);
  });
});
