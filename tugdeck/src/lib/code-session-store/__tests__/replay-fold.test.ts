/**
 * Replay-fold tests — the deck-side fold that collapses a replay
 * window's per-frame listener notifications into one snapshot tick
 * per flush.
 *
 * The fold is notification-deferral only: every wire event still
 * reduces and processes its effects immediately, so the final state
 * is byte-identical to per-frame dispatch (golden test). What changes
 * is publication: while the `replaying` phase is open, the snapshot
 * stays pinned and listeners stay quiet until a flush — which fires
 * only on semantic boundaries: the window closing (`replay_complete`
 * or any phase exit), the deferred-event threshold, or store
 * teardown. No timers, no rAF.
 *
 * Local-origin events (user actions, replay-clock ticks, transport
 * transitions) are exempt from deferral so mid-window UI (the
 * soft-budget banner, transport overlays) stays truthful.
 */

import { describe, it, expect } from "bun:test";

import {
  CodeSessionStore,
  REPLAY_FOLD_FLUSH_THRESHOLD,
} from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import { LivePublishTick } from "@/lib/live-publish-tick";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";

const TUG = FIXTURE_IDS.TUG_SESSION_ID;

function makeStore(): {
  store: CodeSessionStore;
  conn: TestFrameChannel;
  notifies: () => number;
} {
  const conn = new TestFrameChannel();
  const store = new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: TUG,
    sessionMode: "resume",
  });
  let count = 0;
  store.subscribe(() => {
    count += 1;
  });
  return { store, conn, notifies: () => count };
}

function emit(conn: TestFrameChannel, evt: Record<string, unknown>): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, { ...evt, tug_session_id: TUG });
}

function emitReplayedTurn(conn: TestFrameChannel, n: number): void {
  emit(conn, {
    type: "add_user_message",
    content: [{ type: "text", text: `prompt ${n}` }],
  });
  emit(conn, {
    type: "assistant_text",
    status: "complete",
    msg_id: FIXTURE_IDS.MSG_ID_N(n),
    text: `reply ${n}`,
    is_partial: false,
    rev: 0,
    seq: 0,
  });
  emit(conn, {
    type: "turn_complete",
    seq: 0,
    msg_id: FIXTURE_IDS.MSG_ID_N(n),
    result: "success",
  });
}

describe("replay fold — one snapshot tick per flush", () => {
  it("a 50-turn replay commits twice: window open + window close", () => {
    const { store, conn, notifies } = makeStore();

    emit(conn, { type: "replay_started" });
    expect(notifies()).toBe(1);

    for (let n = 1; n <= 50; n++) emitReplayedTurn(conn, n);
    // All 150 content frames deferred — no listener traffic.
    expect(notifies()).toBe(1);

    emit(conn, { type: "replay_complete", count: 50 });
    expect(notifies()).toBe(2);
    expect(store.getSnapshot().transcript).toHaveLength(50);

    const perf = store._getPerfForDevPanel().lastReplay!;
    expect(perf.commits).toBe(2);
    expect(perf.folds).toBe(1);
    expect(perf.frames).toBe(152);
  });

  it("pins the published snapshot while the fold is open", () => {
    const { store, conn } = makeStore();

    emit(conn, { type: "replay_started" });
    // Materialize the publication (what React does right after the
    // window-open notify).
    const pinned = store.getSnapshot();
    expect(pinned.phase).toBe("replaying");

    emitReplayedTurn(conn, 1);
    emitReplayedTurn(conn, 2);
    // Mid-fold reads return the SAME reference — deferred events are
    // reduced but unpublished.
    expect(store.getSnapshot()).toBe(pinned);
    expect(store.getSnapshot().transcript).toHaveLength(0);

    emit(conn, { type: "replay_complete", count: 2 });
    const published = store.getSnapshot();
    expect(published).not.toBe(pinned);
    expect(published.transcript).toHaveLength(2);
    expect(published.phase).toBe("idle");
  });

  it("flushes at the deferred-event threshold so whales paint progressively", () => {
    const { store, conn, notifies } = makeStore();

    emit(conn, { type: "replay_started" });
    // 100 turns = 300 deferred content frames: one threshold flush at
    // 250, the remaining 50 ride the replay_complete flush.
    for (let n = 1; n <= 100; n++) emitReplayedTurn(conn, n);
    expect(notifies()).toBe(2); // window open + threshold flush

    emit(conn, { type: "replay_complete", count: 100 });
    expect(notifies()).toBe(3);
    expect(store.getSnapshot().transcript).toHaveLength(100);

    const perf = store._getPerfForDevPanel().lastReplay!;
    expect(perf.folds).toBe(2);
    expect(REPLAY_FOLD_FLUSH_THRESHOLD).toBe(250);
  });

  it("teardown mid-replay flushes — nothing stranded", () => {
    const { store, conn, notifies } = makeStore();
    let transcriptAtLastNotify = -1;
    store.subscribe(() => {
      transcriptAtLastNotify = store.getSnapshot().transcript.length;
    });

    emit(conn, { type: "replay_started" });
    emitReplayedTurn(conn, 1);
    emitReplayedTurn(conn, 2);
    const before = notifies();

    store.dispose();
    expect(notifies()).toBe(before + 1);
    expect(transcriptAtLastNotify).toBe(2);
  });

  it("transport close mid-replay exits the phase and flushes immediately", () => {
    const { store, conn, notifies } = makeStore();

    emit(conn, { type: "replay_started" });
    emitReplayedTurn(conn, 1);
    expect(notifies()).toBe(1);

    store._simulateTransportForTest("close");
    // Phase exits `replaying` via a local-origin event — published in
    // its own notify, deferred turn included.
    expect(notifies()).toBe(2);
    const snap = store.getSnapshot();
    expect(snap.transcript).toHaveLength(1);
    expect(snap.phase).not.toBe("replaying");
  });

  it("live frames after replay_complete dispatch singly, untouched", () => {
    const { store, conn, notifies } = makeStore();

    emit(conn, { type: "replay_started" });
    emitReplayedTurn(conn, 1);
    emit(conn, { type: "replay_complete", count: 1 });
    const afterReplay = notifies();

    // A live turn: each state-changing event publishes immediately.
    store.send("hello", []);
    expect(notifies()).toBe(afterReplay + 1);
    emit(conn, {
      type: "assistant_text",
      status: "partial",
      msg_id: FIXTURE_IDS.MSG_ID_N(9),
      text: "live reply",
      is_partial: true,
      rev: 0,
      seq: 0,
    });
    expect(notifies()).toBe(afterReplay + 2);
    emit(conn, {
      type: "turn_complete",
      seq: 0,
      msg_id: FIXTURE_IDS.MSG_ID_N(9),
      result: "success",
    });
    expect(notifies()).toBe(afterReplay + 3);
    expect(store.getSnapshot().transcript).toHaveLength(2);
  });

  it("same-phase streaming bursts coalesce to one notify per frame tick", () => {
    // A tick of the store's own over a manual frame, so the coalesced
    // publish is deterministic. The coalescing contract's second half —
    // an immediate publish supersedes the pending one, so no double
    // notify — rests on the store taking its entry back out of the tick,
    // which `tick.size` shows.
    const frames: Array<() => void> = [];
    const tick = new LivePublishTick({
      requestFrame: (cb) => frames.push(cb),
      cancelFrame: () => {
        frames.length = 0;
      },
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    const conn = new TestFrameChannel();
    const store = new CodeSessionStore({
      conn: conn as unknown as TugConnection,
      lifecycle: new ConnectionLifecycle(),
      tugSessionId: TUG,
      sessionMode: "new",
      publishTick: tick,
    });
    const firePending = (): void => {
      for (const cb of frames.splice(0)) cb();
    };
    let count = 0;
    store.subscribe(() => {
      count += 1;
    });

    store.send("hello", []);
    const afterSend = count;
    const delta = (seq: number): void =>
      emit(conn, {
        type: "assistant_text",
        status: "partial",
        msg_id: FIXTURE_IDS.MSG_ID_N(1),
        text: "x",
        is_partial: true,
        rev: 0,
        seq,
      });
    // The first two deltas cross phase boundaries (submitting →
    // awaiting_first_token → streaming) — semantic boundaries, each
    // published immediately.
    delta(0);
    delta(1);
    expect(count).toBe(afterSend + 2);
    // Same-phase burst: every event still reduces immediately (reads
    // stay truthful) but the listener notification coalesces into ONE
    // publish on the next frame.
    delta(2);
    delta(3);
    delta(4);
    expect(count).toBe(afterSend + 2);
    expect(tick.size).toBe(1);
    expect(frames.length).toBe(1);
    firePending();
    expect(count).toBe(afterSend + 3);
    // A phase transition before the frame (turn_complete) publishes
    // immediately — end-of-turn paint never waits on the tick.
    delta(5);
    expect(tick.size).toBe(1);
    emit(conn, {
      type: "turn_complete",
      seq: 0,
      msg_id: FIXTURE_IDS.MSG_ID_N(1),
      result: "success",
    });
    expect(count).toBe(afterSend + 4);
    // The immediate publish took the pending entry back out of the tick,
    // which disarmed — the frame arrives with nothing pending, so the
    // burst that preceded turn_complete can never notify a second time.
    expect(tick.size).toBe(0);
    expect(frames.length).toBe(0);
    firePending();
    expect(count).toBe(afterSend + 4);
  });

  it("two streaming stores ride one frame: one frame requested, each notifies once in it", () => {
    const frames: Array<() => void> = [];
    const tick = new LivePublishTick({
      requestFrame: (cb) => frames.push(cb),
      cancelFrame: () => {
        frames.length = 0;
      },
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    const streams = [0, 1].map(() => {
      const conn = new TestFrameChannel();
      const store = new CodeSessionStore({
        conn: conn as unknown as TugConnection,
        lifecycle: new ConnectionLifecycle(),
        tugSessionId: TUG,
        sessionMode: "new",
        publishTick: tick,
      });
      let count = 0;
      store.subscribe(() => {
        count += 1;
      });
      store.send("hello", []);
      return { conn, count: () => count };
    });
    const delta = (conn: TestFrameChannel, seq: number): void =>
      emit(conn, {
        type: "assistant_text",
        status: "partial",
        msg_id: FIXTURE_IDS.MSG_ID_N(1),
        text: "x",
        is_partial: true,
        rev: 0,
        seq,
      });
    // Past the phase boundaries, so every later delta is same-phase.
    for (const { conn } of streams) {
      delta(conn, 0);
      delta(conn, 1);
    }
    const before = streams.map((s) => s.count());
    for (let seq = 2; seq < 6; seq++) {
      for (const { conn } of streams) delta(conn, seq);
    }
    expect(streams.map((s) => s.count())).toEqual(before);
    expect(frames.length).toBe(1);
    expect(tick.size).toBe(2);
    for (const cb of frames.splice(0)) cb();
    expect(streams.map((s) => s.count())).toEqual(before.map((n) => n + 1));
    expect(tick.size).toBe(0);
  });

  it("golden: folded ingest produces a final state deep-equal to a second identical run", () => {
    const a = makeStore();
    const b = makeStore();
    for (const { conn } of [a, b]) {
      emit(conn, { type: "replay_started" });
      for (let n = 1; n <= 10; n++) emitReplayedTurn(conn, n);
      emit(conn, { type: "replay_complete", count: 10 });
    }
    const snapA = a.store.getSnapshot();
    const snapB = b.store.getSnapshot();
    expect(snapA.transcript.length).toBe(snapB.transcript.length);
    expect(snapA.phase).toBe(snapB.phase);
    // Row-level equivalence on the content that drives rendering.
    for (let i = 0; i < snapA.transcript.length; i++) {
      const ta = snapA.transcript[i];
      const tb = snapB.transcript[i];
      expect(ta.messages.length).toBe(tb.messages.length);
      expect(ta.msgId).toBe(tb.msgId);
      expect(ta.result).toBe(tb.result);
    }
  });
});
