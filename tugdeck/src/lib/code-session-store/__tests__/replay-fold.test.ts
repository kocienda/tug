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
import { Pacer } from "@/lib/ingest/pacer";
import { ManualClock } from "@/lib/ingest/testing/manual-clock";
import { TugConnection } from "@/connection";
import { InProcessIngestChannel, type IngestChannel } from "@/lib/ingest/ingest-channel";
import type { SessionBatch, SessionControl, SessionPatchOf } from "@/lib/ingest/session-patch";
import { FakeWebSocket, QUIET_TIMERS, handshake, installFakeWebSocket } from "@/lib/ingest/testing/fake-websocket";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId, encodeFrame } from "@/protocol";
import { deckTrace } from "@/deck-trace";

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

/** The inner frames of one replayed turn, as a `replay_batch` carries them. */
function turnFrames(n: number): Array<Record<string, unknown>> {
  return [
    { type: "add_user_message", content: [{ type: "text", text: `prompt ${n}` }] },
    {
      type: "assistant_text",
      status: "complete",
      msg_id: FIXTURE_IDS.MSG_ID_N(n),
      text: `reply ${n}`,
      is_partial: false,
      rev: 0,
      seq: 0,
    },
    { type: "turn_complete", seq: 0, msg_id: FIXTURE_IDS.MSG_ID_N(n), result: "success" },
  ];
}

/** An in-process channel that keeps a copy of every batch the host posts. */
class TappedChannel implements IngestChannel {
  readonly batches: SessionBatch[] = [];
  private readonly inner: InProcessIngestChannel;
  private listener: ((batch: SessionBatch) => void) | null = null;

  constructor(clock: ManualClock, periodMs: number) {
    this.inner = new InProcessIngestChannel({
      timers: QUIET_TIMERS,
      makePolicy: (flush) => new Pacer(flush, periodMs, clock),
    });
    this.inner.setBatchListener((batch) => {
      this.batches.push(batch);
      this.listener?.(batch);
    });
  }
  post(control: SessionControl, transfer?: ArrayBuffer[]): void {
    this.inner.post(control, transfer);
  }
  setBatchListener(listener: (batch: SessionBatch) => void): void {
    this.listener = listener;
  }
  setFailureListener(): void {}
  dispose(): void {
    this.inner.dispose();
  }
}

/** What a transcript draws, row by row, for comparing two runs. */
function rows(store: CodeSessionStore): unknown[] {
  return store.getSnapshot().transcript.map((t) => ({
    msgId: t.msgId,
    result: t.result,
    messages: t.messages.map((m) => m.kind),
  }));
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

  it("same-phase text-only deltas publish nothing; a period's structural deltas publish once, at its batch", () => {
    // The session's host paced to a period on a manual clock, so the batch
    // the mirror publishes on is deterministic. Every delta reduces where it
    // lands; what the period decides is when the mirror hears about it, and
    // a batch notifies each mirror once however many publishing patches it
    // carried — a phase transition included, so the burst before it can
    // never notify a second time.
    const PERIOD = 1000 / 60;
    const clock = new ManualClock();
    const conn = new TestFrameChannel();
    const store = new CodeSessionStore({
      conn: conn as unknown as TugConnection,
      lifecycle: new ConnectionLifecycle(),
      tugSessionId: TUG,
      sessionMode: "new",
      makeFlushPolicy: (flush) => new Pacer(flush, PERIOD, clock),
    });
    let count = 0;
    store.subscribe(() => {
      count += 1;
    });
    const nextPeriod = (): void => clock.advance(PERIOD);

    // A local action's acknowledgment posts at once, carrying its publish.
    store.send("hello", []);
    const afterSend = count;
    expect(afterSend).toBe(1);
    const delta = (seq: number, blockIndex?: number): void =>
      emit(conn, {
        type: "assistant_text",
        status: "partial",
        msg_id: FIXTURE_IDS.MSG_ID_N(1),
        text: "x",
        is_partial: true,
        rev: 0,
        seq,
        ...(blockIndex === undefined ? {} : { block_index: blockIndex }),
      });
    // The first two deltas cross phase boundaries (submitting →
    // awaiting_first_token → streaming); both publish, in one batch.
    delta(0);
    delta(1);
    expect(count).toBe(afterSend);
    nextPeriod();
    expect(count).toBe(afterSend + 1);
    expect(store.getSnapshot().phase).toBe("streaming");
    // Same-phase text-only burst: the text reaches the DOM through the
    // PropertyStore, so the snapshot stays pinned and nobody is told —
    // not now, and not at the batch. The stream-text signal (what the
    // open find bar follows) moves once at the batch instead.
    const pinned = store.getSnapshot();
    const version = store.getStreamTextVersion();
    delta(2);
    delta(3);
    delta(4);
    nextPeriod();
    expect(count).toBe(afterSend + 1);
    expect(store.getSnapshot()).toBe(pinned);
    expect(store.getStreamTextVersion()).toBe(version + 1);
    // Same-phase burst that mints Messages (blocks with no
    // `content_block_start`): structural, so each publishes — and the
    // period's batch carries them all to ONE notify.
    delta(5, 1);
    delta(6, 2);
    delta(7, 3);
    expect(count).toBe(afterSend + 1);
    expect(clock.armed).toBe(1);
    nextPeriod();
    expect(count).toBe(afterSend + 2);
    // A phase transition in the same period as a structural delta rides the
    // same batch: one notify for both, and nothing armed after it.
    delta(8, 4);
    emit(conn, {
      type: "turn_complete",
      seq: 0,
      msg_id: FIXTURE_IDS.MSG_ID_N(1),
      result: "success",
    });
    nextPeriod();
    expect(count).toBe(afterSend + 3);
    expect(store.getSnapshot().phase).toBe("idle");
    expect(clock.armed).toBe(0);
    nextPeriod();
    expect(count).toBe(afterSend + 3);
  });

  it("mid-stream, a tool call and an error still publish at once", () => {
    const { store, conn, notifies } = makeStore();
    store.send("hello", []);
    const text = (seq: number): void =>
      emit(conn, {
        type: "assistant_text",
        status: "partial",
        msg_id: FIXTURE_IDS.MSG_ID_N(1),
        text: "x",
        is_partial: true,
        rev: 0,
        seq,
      });
    text(0);
    text(1);
    expect(store.getSnapshot().phase).toBe("streaming");
    const streaming = notifies();
    text(2);
    expect(notifies()).toBe(streaming);
    emit(conn, {
      type: "content_block_start",
      msg_id: FIXTURE_IDS.MSG_ID_N(1),
      block_index: 1,
      kind: "tool_use",
      tool_use_id: "tu1",
      tool_name: "Bash",
    });
    expect(notifies()).toBe(streaming + 1);
    expect(store.getSnapshot().activeTurn?.messages.some((m) => m.kind === "tool_use")).toBe(true);
    conn.dispatchDecoded(FeedId.CONTROL, {
      type: "error",
      detail: "session_unknown",
      tug_session_id: TUG,
    });
    expect(notifies()).toBe(streaming + 2);
    expect(store.getSnapshot().phase).toBe("errored");
  });

  it("a 600-frame replay_batch through the paced host crosses as two structure patches and the phase exit", () => {
    // The host as the Worker runs it — its own socket, paced to a period —
    // with the page's facade and mirror on the other side of the channel.
    const restore = installFakeWebSocket();
    try {
      const PERIOD = 1000 / 60;
      const clock = new ManualClock();
      const channel = new TappedChannel(clock, PERIOD);
      const conn = new TugConnection("ws://test.invalid/ws", { channel });
      conn.connect();
      const ws = FakeWebSocket.last!;
      handshake(ws);
      clock.advance(PERIOD);
      const store = new CodeSessionStore({
        conn,
        lifecycle: new ConnectionLifecycle(),
        tugSessionId: TUG,
        sessionMode: "resume",
      });
      let notifies = 0;
      store.subscribe(() => {
        notifies += 1;
      });
      const wire = (evt: Record<string, unknown>): void => {
        const payload = new TextEncoder().encode(JSON.stringify({ ...evt, tug_session_id: TUG }));
        ws.fireMessage(encodeFrame({ feedId: FeedId.CODE_OUTPUT, flags: 0, payload }));
        clock.advance(PERIOD);
      };
      const structures = (): SessionPatchOf<"structure">[] =>
        channel.batches.flatMap((b) =>
          b.entries.filter((p): p is SessionPatchOf<"structure"> => p.kind === "structure" && p.session !== null),
        );

      const TURNS = 200;
      deckTrace.clear();
      wire({ type: "replay_started" });
      expect(store.getSnapshot().phase).toBe("replaying");
      const opened = structures().length;
      const notifiesOpen = notifies;

      wire({ type: "replay_batch", frames: Array.from({ length: TURNS }, (_, i) => turnFrames(i + 1)).flat() });
      const folded = structures().slice(opened);
      // One structure patch per threshold flush, and none for the frames between.
      expect(folded).toHaveLength(2);
      // The two threshold flushes publish, in the period's one batch: one
      // notify, and the frames after the second stay unread — the snapshot is
      // pinned where that flush left it, not partway through a turn.
      expect(notifies).toBe(notifiesOpen + 1);
      const pinned = store.getSnapshot();
      expect(pinned.phase).toBe("replaying");
      expect(pinned.transcript).toHaveLength(Math.floor((2 * REPLAY_FOLD_FLUSH_THRESHOLD) / 3));
      expect(store.getSnapshot()).toBe(pinned);

      wire({ type: "replay_complete", count: TURNS });
      const exit = structures().slice(opened + folded.length);
      expect(exit).toHaveLength(1);
      expect(exit[0]!.payload.state?.phase).toBe("idle");
      expect(notifies).toBe(notifiesOpen + 2);

      // The logged window counts the notifies the mirror made — three —
      // not the engine's four publishing posts, two of which shared a batch.
      expect(store._getPerfForDevPanel().lastReplay!.commits).toBe(3);
      const logged = deckTrace
        .dump()
        .filter((e) => e.kind === "session-lifecycle" && e.event === "perf.replay_ingest");
      expect(logged).toHaveLength(1);
      expect(logged[0]!.kind === "session-lifecycle" && logged[0]!.fields).toMatchObject({
        tug_session_id: TUG,
        frames: 3 * TURNS + 2,
        commits: 3,
      });
      deckTrace.clear();

      // The same frames reduced in-process, one message at a time, leave the
      // same transcript.
      const local = makeStore();
      emit(local.conn, { type: "replay_started" });
      for (let n = 1; n <= TURNS; n++) emitReplayedTurn(local.conn, n);
      emit(local.conn, { type: "replay_complete", count: TURNS });
      expect(store.getSnapshot().transcript).toHaveLength(TURNS);
      expect(rows(store)).toEqual(rows(local.store));
      store.dispose();
      local.store.dispose();
    } finally {
      restore();
    }
  });

  it("a long replayed turn, a frame per period, crosses once per flush and clones each message once", () => {
    // The fold's cost is what crosses the thread boundary. A folded event
    // that posted would carry the growing turn every period it was built
    // across — quadratic in the turn — where one diff at the flush carries
    // each message once.
    const restore = installFakeWebSocket();
    try {
      const PERIOD = 1000 / 60;
      const clock = new ManualClock();
      const channel = new TappedChannel(clock, PERIOD);
      const conn = new TugConnection("ws://test.invalid/ws", { channel });
      conn.connect();
      const ws = FakeWebSocket.last!;
      handshake(ws);
      clock.advance(PERIOD);
      const store = new CodeSessionStore({
        conn,
        lifecycle: new ConnectionLifecycle(),
        tugSessionId: TUG,
        sessionMode: "resume",
      });
      const wire = (evt: Record<string, unknown>): void => {
        const payload = new TextEncoder().encode(JSON.stringify({ ...evt, tug_session_id: TUG }));
        ws.fireMessage(encodeFrame({ feedId: FeedId.CODE_OUTPUT, flags: 0, payload }));
        clock.advance(PERIOD);
      };
      const structures = (): SessionPatchOf<"structure">[] =>
        channel.batches.flatMap((b) =>
          b.entries.filter((p): p is SessionPatchOf<"structure"> => p.kind === "structure" && p.session !== null),
        );
      /** The Messages a patch carries across the boundary, in its scratch turns and its transcript splices. */
      const carried = (p: SessionPatchOf<"structure">): number => {
        let n = 0;
        for (const entry of p.payload.state?.scratch?.values() ?? []) n += entry.messages.length;
        for (const splice of p.payload.transcript ?? []) {
          for (const turn of splice.entries) n += turn.messages.length;
        }
        return n;
      };

      const MESSAGES = 120;
      wire({ type: "replay_started" });
      const opened = structures().length;
      wire({ type: "add_user_message", content: [{ type: "text", text: "prompt" }] });
      for (let i = 1; i <= MESSAGES; i++) {
        wire({
          type: "assistant_text",
          status: "complete",
          msg_id: FIXTURE_IDS.MSG_ID_N(i),
          text: `reply ${i}`,
          is_partial: false,
          rev: 0,
          seq: 0,
        });
      }
      // Every frame reduced in its own period, under the threshold: nothing crossed.
      expect(structures()).toHaveLength(opened);
      wire({ type: "turn_complete", seq: 0, msg_id: FIXTURE_IDS.MSG_ID_N(MESSAGES), result: "success" });
      wire({ type: "replay_complete", count: 1 });

      const flushed = structures().slice(opened);
      expect(flushed).toHaveLength(1);
      const turn = store.getSnapshot().transcript;
      expect(turn).toHaveLength(1);
      const built = turn[0]!.messages.length;
      expect(built).toBeGreaterThanOrEqual(MESSAGES);
      // Linear in the turn: the flush carries the turn's Messages once.
      expect(flushed.reduce((sum, p) => sum + carried(p), 0)).toBe(built);
      store.dispose();
    } finally {
      restore();
    }
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
