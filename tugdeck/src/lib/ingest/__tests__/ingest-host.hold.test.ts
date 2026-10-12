/**
 * The ingest host's motion hold ([P08]), paced to a period on a manual clock:
 * while a settle's motion gate is closed the host keeps reducing and posts
 * nothing — not the period's batch, not an action's acknowledgment — and the
 * release posts everything as one batch, in order. A gate that never opens is
 * ended by the host's own cap, and a nested hold pushes that cap out. The
 * wire's own state is not held: a close and a reconnect inside a hold reach
 * the page at once, and what the hold keeps still waits for the release.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InProcessIngestChannel } from "../ingest-channel";
import { MIN_HOLD_CAP_MS } from "../ingest-host";
import { Pacer } from "../pacer";
import type { SessionBatch } from "../session-patch";
import { ManualClock } from "../testing/manual-clock";
import { FakeWebSocket, QUIET_TIMERS, handshake, installFakeWebSocket } from "../testing/fake-websocket";
import { FeedId, encodeFrame } from "@/protocol";

const PERIOD = 1000 / 60;

let restoreWebSocket: () => void = () => {};

beforeEach(() => {
  restoreWebSocket = installFakeWebSocket();
});

afterEach(() => {
  restoreWebSocket();
});

function openWire(): { channel: InProcessIngestChannel; batches: SessionBatch[]; ws: FakeWebSocket; clock: ManualClock } {
  const clock = new ManualClock();
  const channel = new InProcessIngestChannel({
    timers: QUIET_TIMERS,
    holdClock: clock,
    makePolicy: (flush, periodMs) => new Pacer(flush, periodMs, clock),
  });
  const batches: SessionBatch[] = [];
  channel.setBatchListener((batch) => batches.push(batch));
  channel.post({ kind: "init", wsUrl: "ws://test.invalid/ws", periodMs: PERIOD });
  channel.post({ kind: "connect" });
  const ws = FakeWebSocket.last!;
  handshake(ws);
  clock.advance(PERIOD);
  batches.length = 0;
  return { channel, batches, ws, clock };
}

/** One wire message carrying one sideband frame whose payload is `text`. */
function send(ws: FakeWebSocket, text: string): void {
  ws.fireMessage(encodeFrame({ feedId: FeedId.SESSION_SIDEBAND, flags: 0, payload: new TextEncoder().encode(text) }));
}

/** The sideband frames each batch carried, as their text. */
function frames(batches: SessionBatch[]): string[][] {
  return batches.map((b) =>
    b.entries.flatMap((p) =>
      p.kind === "frame" && p.payload.feedId === FeedId.SESSION_SIDEBAND
        ? [new TextDecoder().decode(new Uint8Array(p.payload.bytes))]
        : [],
    ),
  );
}

/** Each wire-state patch as `wire-state:<state>`, and each disconnect-state, in order. */
function lifecycle(batches: SessionBatch[]): string[] {
  return batches.flatMap((b) =>
    b.entries.flatMap((p) =>
      p.kind === "wire-state" ? [`wire-state:${p.payload.state}`] : p.kind === "disconnect-state" ? ["disconnect-state"] : [],
    ),
  );
}

describe("IngestHost — the motion hold", () => {
  test("nothing posts while held; the release posts one batch carrying it all, in order", () => {
    const { channel, batches, ws, clock } = openWire();
    channel.post({ kind: "motion", held: true, capMs: 2000 });
    send(ws, "a");
    clock.advance(PERIOD);
    send(ws, "b");
    clock.advance(PERIOD * 5);
    send(ws, "c");
    clock.advance(PERIOD);
    expect(batches).toEqual([]);
    // Nothing is armed for a held wire: the release is what posts.
    expect(clock.armed).toBe(1);

    channel.post({ kind: "motion", held: false });
    expect(frames(batches)).toEqual([["a", "b", "c"]]);
    expect(clock.armed).toBe(0);

    // The wire is live again, at the period.
    send(ws, "d");
    expect(batches).toHaveLength(1);
    clock.advance(PERIOD);
    expect(frames(batches)).toEqual([["a", "b", "c"], ["d"]]);
  });

  test("an action's acknowledgment waits for the release too", () => {
    const { channel, batches, clock } = openWire();
    channel.post({
      kind: "session-open",
      handle: "s#1",
      tugSessionId: "s",
      displayLabel: "s",
      sessionMode: "new",
      restoreWindowTurns: 20,
    });
    clock.advance(PERIOD);
    batches.length = 0;
    channel.post({ kind: "motion", held: true, capMs: 2000 });
    channel.post({ kind: "session-action", handle: "s#1", seq: 3, event: { type: "transport_close" } });
    clock.advance(PERIOD * 3);
    expect(batches).toEqual([]);
    channel.post({ kind: "motion", held: false });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.entries.find((p) => p.kind === "ack")?.payload).toEqual({ seq: 3 });
  });

  test("the cap posts what accumulated when no release comes", () => {
    const { channel, batches, ws, clock } = openWire();
    channel.post({ kind: "motion", held: true, capMs: 1500 });
    send(ws, "a");
    clock.advance(1499);
    expect(batches).toEqual([]);
    clock.advance(1);
    expect(frames(batches)).toEqual([["a"]]);
    // A late release finds nothing held and posts nothing.
    channel.post({ kind: "motion", held: false });
    expect(batches).toHaveLength(1);
  });

  test("a cap under the floor holds for the floor", () => {
    const { channel, batches, ws, clock } = openWire();
    channel.post({ kind: "motion", held: true, capMs: 200 });
    send(ws, "a");
    clock.advance(MIN_HOLD_CAP_MS - 1);
    expect(batches).toEqual([]);
    clock.advance(1);
    expect(frames(batches)).toEqual([["a"]]);
  });

  test("a close and a reconnect inside a hold post their wire state at once; the held frames wait", () => {
    const { channel, batches, ws, clock } = openWire();
    channel.post({ kind: "motion", held: true, capMs: 2000 });
    send(ws, "a");
    ws.fireClose(1006, "gone");
    // The banner and the page's open-socket mirror hear the close now, not at the cap.
    expect(lifecycle(batches)).toEqual(["wire-state:closed", "disconnect-state", "wire-state:reconnecting"]);
    expect(frames(batches).flat()).toEqual([]);

    channel.post({ kind: "force-reconnect" });
    const next = FakeWebSocket.last!;
    expect(next).not.toBe(ws);
    handshake(next);
    send(next, "b");
    clock.advance(PERIOD * 3);
    expect(lifecycle(batches).slice(3)).toEqual(["disconnect-state", "wire-state:will-open", "wire-state:open"]);
    // Every batch so far carried wire state alone.
    expect(batches.every((b) => b.entries.every((p) => p.kind === "wire-state" || p.kind === "disconnect-state"))).toBe(
      true,
    );

    const before = batches.length;
    channel.post({ kind: "motion", held: false });
    expect(batches).toHaveLength(before + 1);
    expect(frames(batches.slice(before))).toEqual([["a", "b"]]);
  });

  test("a nested hold pushes the cap out; one that ends sooner leaves it", () => {
    const { channel, batches, ws, clock } = openWire();
    channel.post({ kind: "motion", held: true, capMs: 1500 });
    send(ws, "a");
    clock.advance(1000);
    channel.post({ kind: "motion", held: true, capMs: 1500 });
    clock.advance(400);
    channel.post({ kind: "motion", held: true, capMs: 1000 });
    // The first cap has passed; the nested one holds until 2500.
    clock.advance(1000);
    expect(batches).toEqual([]);
    clock.advance(100);
    expect(frames(batches)).toEqual([["a"]]);
  });
});
