/**
 * The facade's half of the motion hold ([P08]): every gate transition goes to
 * the host as a `motion` control, and a batch the host posted before it heard
 * of a hold — one that reaches the page while the gate is closed — is parked
 * and applied when the gate opens, in arrival order, before the tells the
 * gate held. Each applied batch leaves an `ingest-batch` trace row.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TugConnection, type MotionGateSource } from "@/connection";
import { deckTrace } from "@/deck-trace";
import type { MotionGateChange } from "@/lib/gesture-scope";
import { InProcessIngestChannel } from "@/lib/ingest/ingest-channel";
import type { IngestChannel } from "@/lib/ingest/ingest-channel";
import type { SessionBatch, SessionControl } from "@/lib/ingest/session-patch";
import { FakeWebSocket, QUIET_TIMERS, handshake, installFakeWebSocket } from "@/lib/ingest/testing/fake-websocket";
import { FeedId, encodeFrame } from "@/protocol";

let restoreWebSocket: () => void = () => {};

beforeEach(() => {
  restoreWebSocket = installFakeWebSocket();
  deckTrace.clear();
});

afterEach(() => {
  restoreWebSocket();
  deckTrace.enable(false);
  deckTrace.clear();
});

/** A gate the test closes and opens by hand. */
class HandGate implements MotionGateSource {
  held = false;
  private readonly listeners = new Set<(change: MotionGateChange) => void>();
  isMotionHeld(): boolean {
    return this.held;
  }
  observeMotionGate(listener: (change: MotionGateChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  tell(change: MotionGateChange): void {
    this.held = change.held;
    for (const listener of this.listeners) listener(change);
  }
}

/** An in-process channel that records the controls the facade posts. */
class RecordingChannel extends InProcessIngestChannel {
  readonly motion: SessionControl[] = [];
  override post(control: SessionControl, transfer?: ArrayBuffer[]): void {
    if (control.kind === "motion") this.motion.push(control);
    super.post(control, transfer);
  }
}

function sideband(ws: FakeWebSocket, text: string): void {
  ws.fireMessage(encodeFrame({ feedId: FeedId.SESSION_SIDEBAND, flags: 0, payload: new TextEncoder().encode(text) }));
}

describe("TugConnection — the motion gate", () => {
  test("posts each gate transition to the host", () => {
    const gate = new HandGate();
    const channel = new RecordingChannel({ timers: QUIET_TIMERS });
    const conn = new TugConnection("ws://test.invalid/ws", { channel, motionGate: gate });
    conn.connect();
    gate.tell({ held: true, capMs: 400 });
    gate.tell({ held: true, capMs: 900 });
    gate.tell({ held: false });
    expect(channel.motion).toEqual([
      { kind: "motion", held: true, capMs: 400 },
      { kind: "motion", held: true, capMs: 900 },
      { kind: "motion", held: false },
    ]);
  });

  test("a batch that arrives inside a closed gate is applied at its open, in arrival order", () => {
    const gate = new HandGate();
    const conn = new TugConnection("ws://test.invalid/ws", {
      channel: new InProcessIngestChannel({ timers: QUIET_TIMERS }),
      motionGate: gate,
    });
    const seen: string[] = [];
    conn.onFrame(FeedId.SESSION_SIDEBAND, (payload) => seen.push(new TextDecoder().decode(payload)));
    conn.connect();
    const ws = FakeWebSocket.last!;
    handshake(ws);
    deckTrace.enable(true);

    // The host posted these before it heard of the hold: the page holds them.
    gate.held = true;
    sideband(ws, "a");
    sideband(ws, "b");
    expect(seen).toEqual([]);
    expect(deckTrace.dump().filter((e) => e.kind === "ingest-batch")).toEqual([]);

    gate.tell({ held: false });
    expect(seen).toEqual(["a", "b"]);
    const rows = deckTrace.dump().filter((e) => e.kind === "ingest-batch");
    expect(rows).toHaveLength(2);
    expect(rows.every((e) => e.kind === "ingest-batch" && e.patches === 1 && e.parked)).toBe(true);

    // An open gate applies at once.
    sideband(ws, "c");
    expect(seen).toEqual(["a", "b", "c"]);
    const after = deckTrace.dump().filter((e) => e.kind === "ingest-batch");
    const last = after[after.length - 1];
    expect(after).toHaveLength(3);
    expect(last?.kind === "ingest-batch" && last.parked).toBe(false);
  });

  test("closing inside a held gate lets the wire go and applies what was parked", () => {
    const gate = new HandGate();
    const channel = new RecordingChannel({ timers: QUIET_TIMERS });
    const conn = new TugConnection("ws://test.invalid/ws", { channel, motionGate: gate });
    const seen: string[] = [];
    conn.onFrame(FeedId.SESSION_SIDEBAND, (payload) => seen.push(new TextDecoder().decode(payload)));
    conn.connect();
    const ws = FakeWebSocket.last!;
    handshake(ws);

    gate.held = true;
    sideband(ws, "a");
    expect(seen).toEqual([]);

    conn.close();
    expect(seen).toEqual(["a"]);
    expect(channel.motion).toEqual([{ kind: "motion", held: false }]);
    // No longer observed: a later transition posts nothing.
    gate.tell({ held: true, capMs: 400 });
    expect(channel.motion).toHaveLength(1);
  });
});

describe("TugConnection — the host's logs", () => {
  test("a session lifecycle entry the host logged reaches the page's lifecycle log", () => {
    const batch: SessionBatch = {
      kind: "batch",
      entries: [{ kind: "log", session: null, payload: { lifecycle: { tag: "code_store.session_init_recv", fields: { n: 1 } } } }],
    };
    const channel: IngestChannel = {
      post: () => {},
      setBatchListener: (listener) => listener(batch),
      dispose: () => {},
    };
    new TugConnection("ws://test.invalid/ws", { channel, motionGate: new HandGate() }).connect();
    const rows = deckTrace.dump().filter((e) => e.kind === "session-lifecycle");
    expect(rows).toEqual([expect.objectContaining({ event: "code_store.session_init_recv", fields: { n: 1 } })]);
  });
});
