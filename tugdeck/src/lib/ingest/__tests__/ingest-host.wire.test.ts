/**
 * The ingest host's wire half, through the in-process channel, against a
 * fake socket: the lifecycle patches it posts across a connect, an
 * unexpected close and a reconnect, in the order the page fires them; and a
 * first write on a new feed reaching the socket behind its subscription.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InProcessIngestChannel } from "../ingest-channel";
import type { SessionBatch } from "../session-patch";
import { FakeWebSocket, QUIET_TIMERS, handshake, installFakeWebSocket } from "../testing/fake-websocket";
import { FeedId, decodeFrame, encodeFrame } from "@/protocol";
import { installDevLogSink } from "@/lib/dev-log-port";

let restoreWebSocket: () => void = () => {};

beforeEach(() => {
  restoreWebSocket = installFakeWebSocket();
});

afterEach(() => {
  restoreWebSocket();
});

function openChannel(sessions?: "all" | string[]): { channel: InProcessIngestChannel; batches: SessionBatch[] } {
  const channel = new InProcessIngestChannel({ timers: QUIET_TIMERS });
  const batches: SessionBatch[] = [];
  channel.setBatchListener((batch) => batches.push(batch));
  channel.post({ kind: "init", wsUrl: "ws://test.invalid/ws", periodMs: 16, ...(sessions === undefined ? {} : { sessions }) });
  return { channel, batches };
}

/** Each lifecycle patch, as `wire-state:<state>` or `disconnect-state`. */
function lifecycle(batches: SessionBatch[]): string[] {
  return batches.flatMap((b) =>
    b.entries.flatMap((p) =>
      p.kind === "wire-state" ? [`wire-state:${p.payload.state}`] : p.kind === "disconnect-state" ? ["disconnect-state"] : [],
    ),
  );
}

describe("IngestHost — the wire half", () => {
  test("connect, an unexpected close and a reconnect post the lifecycle in the page's order", () => {
    const { channel, batches } = openChannel();
    channel.post({ kind: "connect" });
    handshake(FakeWebSocket.last!);
    FakeWebSocket.last!.fireClose(1006, "gone");

    expect(lifecycle(batches)).toEqual([
      "wire-state:will-open",
      "wire-state:open",
      "wire-state:closed",
      "disconnect-state",
      "wire-state:reconnecting",
    ]);

    // The reconnect's own open arrives the same way on the next socket.
    channel.post({ kind: "force-reconnect" });
    handshake(FakeWebSocket.last!);
    expect(lifecycle(batches).slice(5)).toEqual(["disconnect-state", "wire-state:will-open", "wire-state:open"]);
  });

  test("the handshake reply is carried on the open patch", () => {
    const { channel, batches } = openChannel();
    channel.post({ kind: "connect" });
    const ws = FakeWebSocket.last!;
    ws.fireOpen();
    ws.fireMessage(JSON.stringify({ protocol: "tugcast", version: 1, host: { os: "macos", version: "27.0" } }));
    const open = batches.flatMap((b) => b.entries).find((p) => p.kind === "wire-state" && p.payload.state === "open");
    expect(open?.kind === "wire-state" ? open.payload.handshake?.host : null).toEqual({ os: "macos", version: "27.0" });
  });

  test("a frame split across messages reaches the page whole, as a raw frame patch", () => {
    const { channel, batches } = openChannel();
    channel.post({ kind: "connect" });
    const ws = FakeWebSocket.last!;
    handshake(ws);
    const bytes = new Uint8Array(
      encodeFrame({ feedId: FeedId.DEFAULTS, flags: 0, payload: new TextEncoder().encode('{"a":1}') }),
    );
    ws.fireMessage(bytes.slice(0, 4).buffer);
    ws.fireMessage(bytes.slice(4).buffer);
    const frames = batches.flatMap((b) => b.entries).filter((p) => p.kind === "frame");
    expect(frames.length).toBe(1);
    const f = frames[0]!;
    expect(f.kind === "frame" ? f.payload.feedId : null).toBe(FeedId.DEFAULTS);
    expect(f.kind === "frame" ? new TextDecoder().decode(f.payload.bytes) : null).toBe('{"a":1}');
  });

  test("a first write on a new feed reaches the socket behind its subscription", () => {
    const { channel } = openChannel();
    channel.post({ kind: "connect" });
    const ws = FakeWebSocket.last!;
    handshake(ws);
    ws.sent.length = 0;

    channel.post({ kind: "subscribe", feeds: [FeedId.FILETREE_QUERY] });
    const bytes = new Uint8Array([7]).buffer;
    channel.post({ kind: "send", feedId: FeedId.FILETREE_QUERY, flags: 0, bytes }, [bytes]);

    const sent = ws.sent.filter((d): d is ArrayBuffer => typeof d !== "string").map((d) => decodeFrame(d));
    expect(sent.map((f) => f.feedId)).toEqual([FeedId.CONTROL, FeedId.FILETREE_QUERY]);
    const control = JSON.parse(new TextDecoder().decode(sent[0]!.payload)) as { action: string; feeds: number[] };
    expect(control).toEqual({ action: "subscribe_feeds", feeds: [FeedId.FILETREE_QUERY] });
  });

  test("a subscription posted while the wire is down rides the next handshake", () => {
    const { channel } = openChannel();
    channel.post({ kind: "subscribe", feeds: [FeedId.JOTS] });
    channel.post({ kind: "connect" });
    const ws = FakeWebSocket.last!;
    handshake(ws);
    // The handshake also tells tugcast's render bridge the period and asks
    // for a resync on RENDER_INPUT; the subscription is the CONTROL frame.
    const sent = ws.sent
      .filter((d): d is ArrayBuffer => typeof d !== "string")
      .map((d) => decodeFrame(d))
      .filter((f) => f.feedId === FeedId.CONTROL);
    expect(sent.length).toBe(1);
    expect(JSON.parse(new TextDecoder().decode(sent[0]!.payload))).toEqual({
      action: "subscribe_feeds",
      feeds: [FeedId.JOTS],
    });
  });

  test("the sessions init names ride every subscription, and none means every session", () => {
    const subscriptionOf = (sessions?: "all" | string[]): unknown => {
      const { channel } = openChannel(sessions);
      channel.post({ kind: "subscribe", feeds: [FeedId.JOTS] });
      channel.post({ kind: "connect" });
      const ws = FakeWebSocket.last!;
      handshake(ws);
      const control = ws.sent
        .filter((d): d is ArrayBuffer => typeof d !== "string")
        .map((d) => decodeFrame(d))
        .find((f) => f.feedId === FeedId.CONTROL);
      return JSON.parse(new TextDecoder().decode(control!.payload));
    };
    expect(subscriptionOf(["s1"])).toEqual({ action: "subscribe_feeds", feeds: [FeedId.JOTS], sessions: ["s1"] });
    expect(subscriptionOf()).toEqual({ action: "subscribe_feeds", feeds: [FeedId.JOTS] });
    expect(subscriptionOf("all")).toEqual({ action: "subscribe_feeds", feeds: [FeedId.JOTS] });
  });

  test("a frame the page sent after the wire closed is refused with a reason, not dropped quietly", () => {
    const { channel } = openChannel();
    channel.post({ kind: "connect" });
    const ws = FakeWebSocket.last!;
    handshake(ws);
    ws.fireClose(1006, "gone");
    const reported: Array<{ level: string; message: string; data: unknown }> = [];
    const release = installDevLogSink({ log: (level, _source, message, data) => reported.push({ level, message, data }) });
    try {
      const bytes = new Uint8Array([7, 8]).buffer;
      channel.post({ kind: "send", feedId: FeedId.FILETREE_QUERY, flags: 0, bytes }, [bytes]);
    } finally {
      release();
    }
    expect(reported).toEqual([
      {
        level: "warn",
        message: "a frame the page sent was refused: the socket closed before it went out",
        data: { feedId: FeedId.FILETREE_QUERY, bytes: 2 },
      },
    ]);
  });
});
