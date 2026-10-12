/**
 * The CODE_OUTPUT fan-out, collapsed to one route ([P14]): the ingest host
 * decodes each CODE_OUTPUT frame once, sends a `/skills` or `/hooks` response
 * or a `/btw` answer to the mirror of the session it names as a
 * `routed-frame` patch, and posts no raw CODE_OUTPUT frame to the page at
 * all. The mirror hands each routed frame to its store for the type, which is
 * what the narrow per-session stores read.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TugConnection } from "@/connection";
import { CodeSessionStore } from "@/lib/code-session-store";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import { FeedId, encodeFrame, type FeedIdValue } from "@/protocol";
import { InProcessIngestChannel } from "../ingest-channel";
import { ROUTED_CODE_OUTPUT_TYPES } from "../ingest-host";
import { RoutedFrameStore } from "../routed-frame-store";
import {
  applySessionBatch,
  type PatchTarget,
  type SessionBatch,
  type SessionPatchTarget,
} from "../session-patch";
import { FakeWebSocket, QUIET_TIMERS, handshake, installFakeWebSocket } from "../testing/fake-websocket";

let restoreWebSocket: () => void = () => {};

beforeEach(() => {
  restoreWebSocket = installFakeWebSocket();
});

afterEach(() => {
  restoreWebSocket();
});

const A = "session-a";
const B = "session-b";

function openWire(): { channel: InProcessIngestChannel; batches: SessionBatch[]; ws: FakeWebSocket } {
  const channel = new InProcessIngestChannel({ timers: QUIET_TIMERS });
  const batches: SessionBatch[] = [];
  channel.setBatchListener((batch) => batches.push(batch));
  channel.post({ kind: "init", wsUrl: "ws://test.invalid/ws", periodMs: 16, motionEnabled: false });
  channel.post({ kind: "connect" });
  const ws = FakeWebSocket.last!;
  handshake(ws);
  channel.post({ kind: "subscribe", feeds: [FeedId.SESSION_STATE] });
  return { channel, batches, ws };
}

function open(channel: InProcessIngestChannel, handle: string, tugSessionId: string): void {
  channel.post({
    kind: "session-open",
    handle,
    tugSessionId,
    displayLabel: tugSessionId,
    sessionMode: "resume",
    restoreWindowTurns: 20,
  });
}

/** One wire message carrying one frame of `value` on `feedId`. */
function send(ws: FakeWebSocket, feedId: number, value: unknown): void {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  ws.fireMessage(encodeFrame({ feedId: feedId as FeedIdValue, flags: 0, payload }));
}

const skills = (tugSessionId: string, requestId: string) => ({
  type: "skills_inventory",
  tug_session_id: tugSessionId,
  request_id: requestId,
  skills: [],
});

/** A mirror that keeps only its routed stores, one per type. */
function routedMirror(): { target: SessionPatchTarget; stores: Map<string, RoutedFrameStore> } {
  const stores = new Map<string, RoutedFrameStore>();
  const store = (type: string) => {
    let s = stores.get(type);
    if (s === undefined) stores.set(type, (s = new RoutedFrameStore(type)));
    return s;
  };
  const target: SessionPatchTarget = {
    stream: () => {},
    structure: () => {},
    progress: () => {},
    effect: () => {},
    ack: () => {},
    routedFrame: (patch) => store(patch.payload.type).accept(patch.payload.feedId, patch.payload.decoded),
    rendered: () => {},
    findResult: () => {},
    endOfBatch: () => {},
  };
  return { target, stores };
}

function rawFrames(batches: SessionBatch[], feedId: number): number {
  return batches.flatMap((b) => b.entries).filter((p) => p.kind === "frame" && p.payload.feedId === feedId).length;
}

describe("IngestHost — routed CODE_OUTPUT", () => {
  test("a skills_inventory frame for A reaches only A's routed store, and no raw CODE_OUTPUT frame is posted", () => {
    const { channel, batches, ws } = openWire();
    open(channel, `${A}#1`, A);
    open(channel, `${B}#1`, B);
    batches.length = 0;

    send(ws, FeedId.CODE_OUTPUT, skills(A, "si-1"));
    send(ws, FeedId.SESSION_STATE, { tug_session_id: B, state: "idle" });

    const routed = batches.flatMap((b) => b.entries).filter((p) => p.kind === "routed-frame");
    expect(routed.map((p) => `${p.session}:${p.kind === "routed-frame" ? p.payload.type : ""}`)).toEqual([
      `${A}#1:skills_inventory`,
    ]);
    expect(rawFrames(batches, FeedId.CODE_OUTPUT)).toBe(0);
    // Every other feed still reaches the page raw.
    expect(rawFrames(batches, FeedId.SESSION_STATE)).toBe(1);

    const a = routedMirror();
    const b = routedMirror();
    const mirrors = new Map([
      [`${A}#1`, a.target],
      [`${B}#1`, b.target],
    ]);
    const target: PatchTarget = { page: null, session: (h) => mirrors.get(h) ?? null };
    for (const batch of batches) applySessionBatch(batch.entries, target);
    expect(a.stores.get("skills_inventory")?.getSnapshot().get(FeedId.CODE_OUTPUT)).toEqual(skills(A, "si-1"));
    expect(b.stores.size).toBe(0);
  });

  test("every routed type skips the engine; an untagged one reaches nobody; none is replayed into a later open", () => {
    const { channel, batches, ws } = openWire();
    open(channel, `${A}#1`, A);
    batches.length = 0;
    for (const type of ROUTED_CODE_OUTPUT_TYPES) {
      send(ws, FeedId.CODE_OUTPUT, { type, tug_session_id: A, request_id: "r" });
    }
    send(ws, FeedId.CODE_OUTPUT, { type: "skills_inventory", request_id: "untagged" });
    const entries = batches.flatMap((b) => b.entries).filter((p) => p.session !== null);
    expect(entries.map((p) => (p.kind === "routed-frame" ? p.payload.type : p.kind))).toEqual([
      ...ROUTED_CODE_OUTPUT_TYPES,
    ]);

    batches.length = 0;
    open(channel, `${A}#2`, A);
    expect(batches.flatMap((b) => b.entries).filter((p) => p.kind === "routed-frame")).toEqual([]);
  });
});

describe("CodeSessionStore — routed frames", () => {
  test("a /skills response reaches the mirror's routed store for its type, and nothing else", () => {
    const channel = new TestFrameChannel();
    const code = new CodeSessionStore({
      conn: channel as unknown as TugConnection,
      lifecycle: new ConnectionLifecycle(),
      tugSessionId: A,
      sessionMode: "new",
    });
    const routed = code.routedFrames("skills_inventory");
    let routedNotifies = 0;
    routed.subscribe(() => (routedNotifies += 1));
    let codeNotifies = 0;
    code.subscribe(() => (codeNotifies += 1));
    const before = code.getSnapshot();

    const frame = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    channel.dispatchFrame(FeedId.CODE_OUTPUT, frame(skills(B, "si-1")));
    expect(routedNotifies).toBe(0);
    channel.dispatchFrame(FeedId.CODE_OUTPUT, frame(skills(A, "si-1")));
    expect(routedNotifies).toBe(1);
    expect(routed.getSnapshot().get(FeedId.CODE_OUTPUT)).toEqual(skills(A, "si-1"));
    expect(code.routedFrames("hooks_inventory").getSnapshot().size).toBe(0);

    // The transcript's store never saw it.
    expect(codeNotifies).toBe(0);
    expect(code.getSnapshot()).toBe(before);
    code.dispose();
  });
});
