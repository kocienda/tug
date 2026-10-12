/**
 * `Pacer` on a manual clock: one flush per period however many patches land
 * in it, nothing armed while nothing is pending, and an immediate patch that
 * posts at once with whatever was waiting.
 *
 * And the guarantee the page's frame tick used to carry, re-asserted where it
 * now lives: several sessions streaming through one host produce one batch
 * per period, each mirror notifies once in it, and the period runs on a timer
 * rather than on `requestAnimationFrame` — so an occluded window, which gets
 * no frames, still moves.
 */

import { describe, expect, test } from "bun:test";
import { Pacer, PerMessageFlush } from "../pacer";
import { InProcessIngestChannel } from "../ingest-channel";
import { ManualClock } from "../testing/manual-clock";
import { FakeWebSocket, QUIET_TIMERS, handshake, installFakeWebSocket } from "../testing/fake-websocket";
import { TugConnection, ingestTaskCounter } from "@/connection";
import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import { FeedId, encodeFrame } from "@/protocol";

const PERIOD = 1000 / 60;

describe("Pacer", () => {
  test("N patches inside one period flush once", () => {
    const clock = new ManualClock();
    let flushes = 0;
    const pacer = new Pacer(() => (flushes += 1), PERIOD, clock);
    for (let i = 0; i < 30; i += 1) {
      pacer.note(false);
      clock.advance(0.3);
    }
    expect(flushes).toBe(0);
    clock.advance(PERIOD);
    expect(flushes).toBe(1);
    expect(clock.armed).toBe(0);
  });

  test("nothing pending means nothing armed", () => {
    const clock = new ManualClock();
    let flushes = 0;
    const pacer = new Pacer(() => (flushes += 1), PERIOD, clock);
    expect(pacer.armed).toBe(false);
    clock.advance(PERIOD * 10);
    expect(flushes).toBe(0);
    expect(clock.armed).toBe(0);
  });

  test("an immediate patch flushes at once and carries what is pending", () => {
    const clock = new ManualClock();
    const batches: number[] = [];
    let pending = 0;
    const pacer = new Pacer(() => {
      batches.push(pending);
      pending = 0;
    }, PERIOD, clock);
    pending += 1;
    pacer.note(false);
    pending += 1;
    pacer.note(false);
    expect(pacer.armed).toBe(true);
    pending += 1;
    pacer.note(true);
    expect(batches).toEqual([3]);
    // The period timer it superseded is gone.
    expect(clock.armed).toBe(0);
    clock.advance(PERIOD * 2);
    expect(batches).toEqual([3]);
  });

  test("flushes land on the period grid since the last flush", () => {
    const clock = new ManualClock();
    const at: number[] = [];
    const pacer = new Pacer(() => at.push(clock.now()), 10, clock);
    pacer.note(false);
    clock.advance(10);
    clock.advance(23);
    pacer.note(false);
    clock.advance(10);
    expect(at).toEqual([10, 40]);
  });
});

describe("PerMessageFlush", () => {
  test("posts at the end of a message that appended, and only then", () => {
    let flushes = 0;
    const policy = new PerMessageFlush(() => (flushes += 1));
    policy.endOfMessage();
    expect(flushes).toBe(0);
    policy.note();
    policy.note();
    expect(flushes).toBe(0);
    policy.endOfMessage();
    expect(flushes).toBe(1);
  });
});

describe("one host, several streaming sessions", () => {
  test("three sessions streaming in one period produce one batch and one notify each, on a timer", () => {
    // The page has no frames here, which is the point: the period is the
    // host's own timer, so nothing waits on `requestAnimationFrame`.
    expect(typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame).toBe("undefined");
    const restore = installFakeWebSocket();
    try {
      const clock = new ManualClock();
      const conn = new TugConnection("ws://test.invalid/ws", {
        channel: new InProcessIngestChannel({
          timers: QUIET_TIMERS,
          makePolicy: (flush) => new Pacer(flush, PERIOD, clock),
        }),
      });
      conn.connect();
      const ws = FakeWebSocket.last!;
      handshake(ws);
      clock.advance(PERIOD);

      const ids = [1, 2, 3].map((n) => `tug00000-0000-4000-8000-00000000000${n}`);
      const sessions = ids.map((tugSessionId) => {
        const store = new CodeSessionStore({
          conn,
          lifecycle: new ConnectionLifecycle(),
          tugSessionId,
          sessionMode: "new",
        });
        let count = 0;
        store.subscribe(() => {
          count += 1;
        });
        // The send's acknowledgment posts at once.
        store.send("hello", []);
        return { tugSessionId, store, count: () => count };
      });
      const wire = (tugSessionId: string, seq: number, blockIndex?: number): void => {
        const payload = new TextEncoder().encode(
          JSON.stringify({
            type: "assistant_text",
            tug_session_id: tugSessionId,
            status: "partial",
            msg_id: "msg00000-0000-4000-8000-000000000001",
            text: "x",
            is_partial: true,
            rev: 0,
            seq,
            ...(blockIndex === undefined ? {} : { block_index: blockIndex }),
          }),
        );
        ws.fireMessage(encodeFrame({ feedId: FeedId.CODE_OUTPUT, flags: 0, payload }));
      };
      // Past the phase boundaries, so every later delta is same-phase.
      for (const { tugSessionId } of sessions) {
        wire(tugSessionId, 0);
        wire(tugSessionId, 1);
      }
      clock.advance(PERIOD);
      expect(sessions.map((s) => s.store.getSnapshot().phase)).toEqual(["streaming", "streaming", "streaming"]);

      const before = sessions.map((s) => s.count());
      const tasks = ingestTaskCounter.tasks;
      // Each delta mints a Message, so each session has a structural publish
      // in the period; a text-only delta would publish nothing at all.
      for (let seq = 2; seq < 6; seq++) {
        for (const { tugSessionId } of sessions) wire(tugSessionId, seq, seq);
      }
      expect(sessions.map((s) => s.count())).toEqual(before);
      expect(ingestTaskCounter.tasks).toBe(tasks);
      expect(clock.armed).toBe(1);

      clock.advance(PERIOD);
      expect(ingestTaskCounter.tasks).toBe(tasks + 1);
      expect(sessions.map((s) => s.count())).toEqual(before.map((n) => n + 1));
      expect(clock.armed).toBe(0);
      for (const { store } of sessions) store.dispose();
    } finally {
      restore();
    }
  });
});
