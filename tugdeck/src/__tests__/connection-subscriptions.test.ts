/**
 * `TugConnection` feed-subscription unit tests.
 *
 * The connection computes its own `subscribe_feeds` set: every feed with a
 * live `onFrame` callback, plus every feed it has ever written on. The set
 * only grows while a socket lives, registrations coalesce onto a microtask,
 * and a reconnect re-establishes the whole thing after its handshake.
 *
 * These drive a real `TugConnection` against a stubbed `WebSocket`, decode
 * what it actually put on the wire, and assert on frame *order* as well as
 * content — the ordering is the load-bearing part of the input-rejection
 * case, and membership alone passes even when the order is wrong.
 *
 * Coverage:
 *   - A burst of registrations in one tick sends exactly one frame.
 *   - Unregistering never shrinks the set and sends nothing.
 *   - A write adds its feed; a CONTROL write does not.
 *   - The first write's subscription precedes the write it protects.
 *   - A second write on the same feed adds no further frame.
 *   - A reconnect re-sends the pre-close union, non-empty.
 *   - A registration while disconnected rides the post-handshake send.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

// `connection.ts` reaches for browser globals directly, so the bun test
// runtime — which does not ship a DOM — needs a minimal alias. Done before
// importing the SUT so the module sees it at top-level evaluation.
if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = globalThis;
}

import { TugConnection } from "@/connection";
import { decodeFrame, FeedId } from "@/protocol";

// ---------------------------------------------------------------------------
// FakeWebSocket — a passive stand-in that records what was written.
// ---------------------------------------------------------------------------

class FakeWebSocket {
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
    lastWs = this;
  }

  send(data: string | ArrayBufferLike): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
  }

  fireOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  fireMessage(data: string | ArrayBuffer): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  fireClose(code: number = 1000, reason: string = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

let lastWs: FakeWebSocket | null = null;

let origSetInterval: typeof window.setInterval;
let origClearInterval: typeof window.clearInterval;
let origSetTimeout: typeof window.setTimeout;
let origClearTimeout: typeof window.clearTimeout;
let origWebSocket: typeof globalThis.WebSocket;
let origDocument: unknown;

function installFakes(): void {
  origSetInterval = window.setInterval;
  origClearInterval = window.clearInterval;
  origSetTimeout = window.setTimeout;
  origClearTimeout = window.clearTimeout;
  origWebSocket = globalThis.WebSocket;
  origDocument = (globalThis as { document?: unknown }).document;

  // The connection registers a `visibilitychange` listener and reads
  // `document.visibilityState`; that is its whole DOM surface.
  (globalThis as unknown as { document: unknown }).document = {
    visibilityState: "visible",
    addEventListener(): void {},
    removeEventListener(): void {},
  };

  // Swallow the timers so heartbeats and reconnect backoff never fire into
  // an assertion. These tests are about what goes on the wire in response to
  // registrations and writes, not about time.
  (window as unknown as { setInterval: (cb: () => void, ms: number) => number })
    .setInterval = (): number => 1;
  (window as unknown as { clearInterval: (id?: number) => void })
    .clearInterval = (): void => {};
  (window as unknown as { setTimeout: (cb: () => void, ms: number) => number })
    .setTimeout = (): number => 1;
  (window as unknown as { clearTimeout: (id?: number) => void })
    .clearTimeout = (): void => {};

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
  if (origDocument === undefined) {
    delete (globalThis as { document?: unknown }).document;
  } else {
    (globalThis as { document?: unknown }).document = origDocument;
  }
  lastWs = null;
}

// ---------------------------------------------------------------------------
// Wire readers
// ---------------------------------------------------------------------------

interface SentFrame {
  feedId: number;
  action: string | null;
  feeds: number[] | null;
}

/**
 * Decode every binary frame the connection has written, in order.
 *
 * The protocol hello is a text frame, so anything that is not an
 * ArrayBuffer is not a frame and is skipped rather than decoded.
 */
function wire(ws: FakeWebSocket): SentFrame[] {
  const frames: SentFrame[] = [];
  for (const raw of ws.sent) {
    if (typeof raw === "string") continue;
    const frame = decodeFrame(raw as ArrayBuffer);
    let action: string | null = null;
    let feeds: number[] | null = null;
    if (frame.feedId === FeedId.CONTROL) {
      try {
        const json = JSON.parse(new TextDecoder().decode(frame.payload));
        action = typeof json.action === "string" ? json.action : null;
        feeds = Array.isArray(json.feeds) ? json.feeds : null;
      } catch {
        // A CONTROL frame that is not JSON is not one of ours.
      }
    }
    frames.push({ feedId: frame.feedId, action, feeds });
  }
  return frames;
}

/** Just the `subscribe_feeds` frames, in order. */
function subscriptions(ws: FakeWebSocket): number[][] {
  return wire(ws)
    .filter((f) => f.action === "subscribe_feeds")
    .map((f) => f.feeds ?? []);
}

/** Drive a `TugConnection` through `connect()` and the handshake. */
function completeHandshake(conn: TugConnection): FakeWebSocket {
  conn.connect();
  const ws = lastWs;
  if (ws === null) throw new Error("WebSocket was not constructed");
  ws.fireOpen();
  ws.fireMessage(JSON.stringify({ protocol: "tugcast", version: 1 }));
  return ws;
}

/** Let the coalescing microtask run. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const noop = (): void => {};

// ---------------------------------------------------------------------------

describe("TugConnection — feed subscriptions", () => {
  beforeEach(() => {
    installFakes();
  });

  afterEach(() => {
    uninstallFakes();
  });

  it("coalesces a burst of registrations into one frame carrying the union", async () => {
    const conn = new TugConnection("ws://test.invalid/");
    const ws = completeHandshake(conn);
    ws.sent.length = 0;

    conn.onFrame(FeedId.JOTS, noop);
    conn.onFrame(FeedId.DEFAULTS, noop);
    conn.onFrame(FeedId.PULSE, noop);
    await settle();

    const sent = subscriptions(ws);
    expect(sent.length).toBe(1);
    expect(sent[0]).toEqual(
      [FeedId.DEFAULTS, FeedId.PULSE, FeedId.JOTS].sort((a, b) => a - b),
    );
  });

  it("does not shrink the set when every callback for a feed unregisters", async () => {
    const conn = new TugConnection("ws://test.invalid/");
    const ws = completeHandshake(conn);

    const off = conn.onFrame(FeedId.JOTS, noop);
    await settle();
    ws.sent.length = 0;

    off();
    await settle();

    expect(subscriptions(ws)).toEqual([]);

    // And the feed is still in the set, which is what keeps the replay cache
    // warm for a store that mounts later. Prove it by growing the set and
    // reading what the next frame carries.
    conn.onFrame(FeedId.PULSE, noop);
    await settle();
    expect(subscriptions(ws)).toEqual([
      [FeedId.PULSE, FeedId.JOTS].sort((a, b) => a - b),
    ]);
  });

  it("adds a written feed to the union, and never CONTROL", async () => {
    const conn = new TugConnection("ws://test.invalid/");
    const ws = completeHandshake(conn);
    ws.sent.length = 0;

    conn.trySend(FeedId.FILETREE_QUERY, new Uint8Array([1]));
    await settle();
    expect(subscriptions(ws)).toEqual([[FeedId.FILETREE_QUERY]]);

    // A CONTROL write records nothing: it is exempt server-side, and
    // recording it would make every subscribe_feeds frame schedule another.
    ws.sent.length = 0;
    conn.trySendControlFrame("some_action", {});
    await settle();
    expect(subscriptions(ws)).toEqual([]);
  });

  it("puts the subscription on the wire before the write it protects", async () => {
    // The router answers an input frame's rejection on that frame's own feed
    // id, inside the same receive turn that read it. So the subscription has
    // to precede the payload — not merely end up in the set, which is what a
    // membership-only assertion would let through.
    const conn = new TugConnection("ws://test.invalid/");
    const ws = completeHandshake(conn);
    ws.sent.length = 0;

    conn.trySend(FeedId.FILETREE_QUERY, new Uint8Array([1]));

    // No `await` — the ordering must hold within the same synchronous turn.
    const sent = wire(ws);
    expect(sent.length).toBe(2);
    expect(sent[0].action).toBe("subscribe_feeds");
    expect(sent[0].feeds).toEqual([FeedId.FILETREE_QUERY]);
    expect(sent[1].feedId).toBe(FeedId.FILETREE_QUERY);
  });

  it("flushes on the first write to a feed only, not on every write", async () => {
    const conn = new TugConnection("ws://test.invalid/");
    const ws = completeHandshake(conn);
    ws.sent.length = 0;

    conn.trySend(FeedId.FILETREE_QUERY, new Uint8Array([1]));
    conn.trySend(FeedId.FILETREE_QUERY, new Uint8Array([2]));
    conn.trySend(FeedId.FILETREE_QUERY, new Uint8Array([3]));
    await settle();

    expect(subscriptions(ws)).toEqual([[FeedId.FILETREE_QUERY]]);
  });

  it("re-sends the pre-close union after a reconnect handshake", async () => {
    const conn = new TugConnection("ws://test.invalid/");
    const first = completeHandshake(conn);

    conn.onFrame(FeedId.JOTS, noop);
    conn.trySend(FeedId.FILETREE_QUERY, new Uint8Array([1]));
    await settle();

    const beforeAll = subscriptions(first);
    const before = beforeAll[beforeAll.length - 1];
    expect(before).toEqual(
      [FeedId.JOTS, FeedId.FILETREE_QUERY].sort((a, b) => a - b),
    );

    first.fireClose();

    // Nothing re-registers in between: `callbacks` survives the close and no
    // store re-runs `onFrame`. This is exactly the situation in which sending
    // the accumulated field rather than a recompute would put an empty array
    // on the wire.
    const second = completeHandshake(conn);
    const after = subscriptions(second);

    expect(after.length).toBe(1);
    expect(after[0].length).toBeGreaterThan(0);
    expect(after[0]).toEqual(before);
  });

  it("carries a registration made while disconnected in the post-handshake send", async () => {
    const conn = new TugConnection("ws://test.invalid/");

    // Never connected: the registration updates the set but has no socket to
    // write to.
    conn.onFrame(FeedId.JOTS, noop);
    await settle();
    expect(lastWs).toBe(null);

    const ws = completeHandshake(conn);
    expect(subscriptions(ws)).toEqual([[FeedId.JOTS]]);
  });

  it("does not narrow the union across a reconnect a card unmounted before", async () => {
    // The reconnect send has to carry the accumulated set, not a fresh
    // recompute. `callbacks` survives the close with the unmounted card's
    // entry already spliced out, so a recompute would drop that feed — and
    // `lastPayload` was cleared by the same handler, so nothing on the deck
    // side would notice. SESSION_SIDEBAND is a stream feed, so the server's
    // latest-value pass would not re-deliver it either: the card would come
    // back blank and stay blank until the producer next spoke.
    const conn = new TugConnection("ws://test.invalid/");
    const first = completeHandshake(conn);

    const closeCard = conn.onFrame(FeedId.SESSION_SIDEBAND, noop);
    conn.onFrame(FeedId.JOTS, noop);
    await settle();

    // The card closes. The union is monotonic, so this is a no-op on the
    // wire — but it does empty that feed's callback array.
    closeCard();
    await settle();

    first.fireClose();
    const second = completeHandshake(conn);

    const after = subscriptions(second);
    expect(after.length).toBe(1);
    expect(after[0]).toEqual(
      [FeedId.SESSION_SIDEBAND, FeedId.JOTS].sort((a, b) => a - b),
    );
  });
});
