/**
 * The ingest host's session half, through the in-process channel, with the
 * host holding its own (fake) socket as it does in the Worker: a session
 * feed's frame is decoded once and routed to the engines of the session it
 * names and no other; the last frame of each session feed is replayed into an
 * engine as it opens, and forgotten when the wire closes; and every patch
 * names the handle of the open it came from, so a store rebuilt for the same
 * session never applies its predecessor's patches ([P06]).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InProcessIngestChannel } from "../ingest-channel";
import { Pacer } from "../pacer";
import { ManualClock } from "../testing/manual-clock";
import { SessionEngine } from "@/lib/code-session-store/session-engine";
import {
  applyPatch,
  type PatchTarget,
  type SessionBatch,
  type SessionPatch,
  type SessionPatchTarget,
} from "../session-patch";
import { FakeWebSocket, QUIET_TIMERS, handshake, installFakeWebSocket } from "../testing/fake-websocket";
import { FeedId, encodeFrame } from "@/protocol";

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
  ws.fireMessage(encodeFrame({ feedId: feedId as 0x50, flags: 0, payload }));
}

/** A SESSION_STATE frame the reducer turns into an errored session. */
const errored = (tugSessionId: string | undefined, detail: string) => ({
  ...(tugSessionId !== undefined ? { tug_session_id: tugSessionId } : {}),
  state: "errored",
  detail,
});

/** The session-scoped patches in the batches, as `<kind>@<handle>`. */
function sessionPatches(batches: SessionBatch[]): string[] {
  return batches.flatMap((b) => b.entries.filter((p) => p.session !== null).map((p) => `${p.kind}@${p.session}`));
}

function structures(batches: SessionBatch[], handle: string): Extract<SessionPatch, { kind: "structure" }>[] {
  return batches.flatMap((b) =>
    b.entries.filter((p): p is Extract<SessionPatch, { kind: "structure" }> => p.kind === "structure" && p.session === handle),
  );
}

describe("IngestHost — the session half", () => {
  test("a frame reaches only the engines of the session it names", () => {
    const { channel, batches, ws } = openWire();
    open(channel, `${A}#1`, A);
    open(channel, `${B}#1`, B);
    batches.length = 0;

    send(ws, FeedId.SESSION_STATE, errored(A, "a broke"));
    expect(sessionPatches(batches).every((p) => p.endsWith(`@${A}#1`))).toBe(true);
    expect(structures(batches, `${A}#1`)).toHaveLength(1);
    expect(structures(batches, `${A}#1`)[0]!.payload.state?.lastError).toMatchObject({ message: "a broke" });

    batches.length = 0;
    send(ws, FeedId.SESSION_STATE, errored(B, "b broke"));
    expect(sessionPatches(batches).every((p) => p.endsWith(`@${B}#1`))).toBe(true);
    expect(structures(batches, `${B}#1`)).toHaveLength(1);
  });

  test("an untagged CONTROL error reaches no engine", () => {
    const { channel, batches, ws } = openWire();
    open(channel, `${A}#1`, A);
    open(channel, `${B}#1`, B);
    // Both sessions have a turn in flight, which a session error would end.
    for (const handle of [`${A}#1`, `${B}#1`]) {
      channel.post({
        kind: "session-action",
        handle,
        seq: 1,
        event: { type: "send", text: "hi", atoms: [], content: [{ type: "text", text: "hi" }], turnKey: `t-${handle}` },
      });
    }
    batches.length = 0;

    send(ws, FeedId.CONTROL, { type: "error", detail: "session_unknown" });
    expect(sessionPatches(batches)).toEqual([]);

    // The same error, addressed, ends the addressed session's turn only.
    send(ws, FeedId.CONTROL, { type: "error", detail: "session_unknown", tug_session_id: B });
    expect(structures(batches, `${B}#1`)).toHaveLength(1);
    expect(sessionPatches(batches).every((p) => p.endsWith(`@${B}#1`))).toBe(true);
  });

  test("an engine that opens gets the session's last frame, and none from before a close", () => {
    const { channel, batches, ws } = openWire();
    send(ws, FeedId.SESSION_STATE, errored(A, "before open"));

    batches.length = 0;
    open(channel, `${A}#1`, A);
    const replayed = structures(batches, `${A}#1`);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.payload.state?.lastError).toMatchObject({ message: "before open" });

    // A frame for another session is not replayed into this one.
    batches.length = 0;
    open(channel, `${B}#1`, B);
    expect(structures(batches, `${B}#1`)).toEqual([]);

    // The wire closes; a session opened after it must not reduce the old frame.
    ws.fireClose(1006, "gone");
    batches.length = 0;
    open(channel, `${A}#2`, A);
    expect(structures(batches, `${A}#2`)).toEqual([]);
  });

  test("a store rebuilt for the same session never applies its predecessor's patches", () => {
    const { channel, batches, ws } = openWire();
    open(channel, `${A}#1`, A);
    batches.length = 0;

    // The old engine posts a structure patch that is still in flight…
    send(ws, FeedId.SESSION_STATE, errored(A, "old engine"));
    const inFlight = batches.splice(0);
    expect(structures(inFlight, `${A}#1`)).toHaveLength(1);

    // …while the reconnect restore disposes the store and rebuilds it.
    channel.post({ kind: "session-close", handle: `${A}#1` });
    open(channel, `${A}#2`, A);

    const applied: string[] = [];
    const mirror = (name: string): SessionPatchTarget => ({
      stream: () => applied.push(`${name}:stream`),
      structure: () => applied.push(`${name}:structure`),
      progress: () => applied.push(`${name}:progress`),
      effect: () => applied.push(`${name}:effect`),
      ack: () => applied.push(`${name}:ack`),
      routedFrame: () => applied.push(`${name}:routed-frame`),
      endOfBatch: () => {},
    });
    const live = new Map<string, SessionPatchTarget>([[`${A}#2`, mirror("new")]]);
    const target: PatchTarget = { page: null, session: (handle) => live.get(handle) ?? null };

    // The in-flight batch lands after the new mirror registered: dropped.
    for (const batch of inFlight) for (const patch of batch.entries) applyPatch(patch, target);
    expect(applied).toEqual([]);

    // The new engine's own patches reach the new mirror.
    send(ws, FeedId.SESSION_STATE, errored(A, "new engine"));
    for (const batch of batches) for (const patch of batch.entries) applyPatch(patch, target);
    expect(applied).toContain("new:structure");
  });

  test("a local action is reduced and acknowledged with its sequence number", () => {
    const { channel, batches } = openWire();
    open(channel, `${A}#1`, A);
    batches.length = 0;

    channel.post({ kind: "session-action", handle: `${A}#1`, seq: 7, event: { type: "transport_close" } });
    const patches = batches.flatMap((b) => b.entries);
    const ack = patches.find((p) => p.kind === "ack");
    expect(ack?.kind === "ack" ? ack.payload.seq : null).toBe(7);
    expect(patches.findIndex((p) => p.kind === "structure")).toBeLessThan(patches.indexOf(ack!));
  });

  test("an action whose engine throws is still acknowledged", () => {
    const { channel, batches } = openWire();
    open(channel, `${A}#1`, A);
    batches.length = 0;

    const action = SessionEngine.prototype.action;
    const quiet = console.error;
    SessionEngine.prototype.action = () => {
      throw new Error("reducer defect");
    };
    console.error = () => {};
    try {
      channel.post({ kind: "session-action", handle: `${A}#1`, seq: 3, event: { type: "transport_close" } });
    } finally {
      SessionEngine.prototype.action = action;
      console.error = quiet;
    }
    // A reader awaiting its own action must hear back whatever the engine did.
    const ack = batches.flatMap((b) => b.entries).find((p) => p.kind === "ack");
    expect(ack?.kind === "ack" ? ack.payload.seq : null).toBe(3);
  });

  test("each session's streamed text crosses once per batch, however the sessions interleave", () => {
    const clock = new ManualClock();
    const channel = new InProcessIngestChannel({
      timers: QUIET_TIMERS,
      makePolicy: (flush) => new Pacer(flush, 16, clock),
    });
    const batches: SessionBatch[] = [];
    channel.setBatchListener((batch) => batches.push(batch));
    channel.post({ kind: "init", wsUrl: "ws://test.invalid/ws", periodMs: 16, motionEnabled: false });
    channel.post({ kind: "connect" });
    const ws = FakeWebSocket.last!;
    handshake(ws);
    const ids = [A, B];
    for (const id of ids) {
      open(channel, `${id}#1`, id);
      channel.post({
        kind: "session-action",
        handle: `${id}#1`,
        seq: 1,
        event: { type: "send", text: "hi", atoms: [], content: [{ type: "text", text: "hi" }], turnKey: `t-${id}` },
      });
    }
    const delta = (id: string, seq: number): void =>
      send(ws, FeedId.CODE_OUTPUT, {
        type: "assistant_text",
        tug_session_id: id,
        status: "partial",
        msg_id: "msg00000-0000-4000-8000-000000000001",
        text: "x",
        is_partial: true,
        rev: 0,
        seq,
      });
    // Past the phase boundaries, so every later delta only grows text.
    for (const id of ids) {
      delta(id, 0);
      delta(id, 1);
    }
    clock.advance(16);
    batches.length = 0;

    for (let seq = 2; seq < 12; seq++) for (const id of ids) delta(id, seq);
    clock.advance(16);

    expect(batches).toHaveLength(1);
    const streams = batches[0]!.entries.filter((p): p is Extract<SessionPatch, { kind: "stream" }> => p.kind === "stream");
    expect(streams.map((p) => p.session)).toEqual([`${A}#1`, `${B}#1`]);
    for (const p of streams) {
      expect(p.payload.textGrew).toBe(true);
      // One write per path, carrying the Message's whole text as of the last delta.
      expect(p.payload.writes).toHaveLength(1);
      expect(p.payload.writes[0]!.value).toBe("x".repeat(12));
    }
  });
});
