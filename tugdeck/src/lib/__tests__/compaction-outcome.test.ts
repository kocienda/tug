/**
 * `compactionOutcome` — a `/compact` run's settle read off the session
 * snapshot as it is now, never off an edge a listener had to see.
 *
 * Driven through the real store and reducer over real frames, paced to a
 * display period on a manual clock so several frames land as ONE batch — the
 * shape a reveal's catch-up delivers, and the shape that notifies a listener
 * once with only the last state. A test that dispatched one frame per batch
 * would see every transition and prove nothing.
 *
 * @covers tugdeck/src/lib/compaction-progress-store.ts
 * @covers tugdeck/src/lib/code-session-store/reducer.ts
 */

import { describe, it, expect } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import {
  COMPACTION_DID_NOT_RUN,
  compactionOutcome,
  type CompactionTurn,
  type CompactionVerdict,
} from "@/lib/compaction-progress-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import { Pacer } from "@/lib/ingest/pacer";
import { ManualClock } from "@/lib/ingest/testing/manual-clock";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";

const TUG = FIXTURE_IDS.TUG_SESSION_ID;
const PERIOD = 1000 / 60;
const RESUME_PROMPT = "/tugplug:arc-implement demo resume Step 5";
/** The envelope claude writes for a `/compact`, as a replay surfaces it. */
const COMPACT_ENVELOPE =
  "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>";
/** What claude recorded as the wheel `/compact`'s id — tugcast's, not the deck's key. */
const JOURNAL_ID = "d9ce3a30-df41-47c1-979e-59dc87df5218";

interface Harness {
  store: CodeSessionStore;
  conn: TestFrameChannel;
  /** End the display period: everything emitted since lands as one batch. */
  flush: () => void;
}

function makeStore(): Harness {
  const clock = new ManualClock();
  const conn = new TestFrameChannel();
  const store = new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: TUG,
    sessionMode: "resume",
    makeFlushPolicy: (flush) => new Pacer(flush, PERIOD, clock),
  });
  return { store, conn, flush: () => clock.advance(PERIOD) };
}

function emit(conn: TestFrameChannel, evt: Record<string, unknown>): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, { ...evt, tug_session_id: TUG });
}

function emitTurn(conn: TestFrameChannel, n: number): void {
  emit(conn, { type: "add_user_message", content: [{ type: "text", text: `prompt ${n}` }] });
  emit(conn, {
    type: "assistant_text",
    status: "complete",
    msg_id: FIXTURE_IDS.MSG_ID_N(n),
    text: `reply ${n}`,
    is_partial: false,
    rev: 0,
    seq: 0,
  });
  emit(conn, { type: "turn_complete", seq: 0, msg_id: FIXTURE_IDS.MSG_ID_N(n), result: "success" });
}

/** A loaded history of turns `0..n-1`. */
function history(h: Harness, n: number): void {
  emit(h.conn, { type: "replay_started" });
  for (let i = 0; i < n; i++) emitTurn(h.conn, i);
  emit(h.conn, { type: "replay_complete", count: n, firstLoadedTurnIndex: 0, totalTurns: n, hasOlder: false });
  h.flush();
}

/** The compaction's own ink, as claude streams it live or a replay re-emits it. */
function emitCompaction(conn: TestFrameChannel): void {
  emit(conn, { type: "compact_boundary", trigger: "manual", pre_tokens: 605_470, post_tokens: 9_205 });
  emit(conn, { type: "compact_summary", summary: "carry-forward summary" });
}

/** The wheel's `/compact`, as tugcast announces the turn it already sent. */
function wheelCompact(h: Harness): CompactionTurn {
  emit(h.conn, { type: "tug_notice", origin: "wheel", text: "/compact" });
  h.flush();
  const snap = h.store.getSnapshot();
  const active = snap.activeTurn;
  expect(active).not.toBeNull();
  return { turnKey: active!.turnKey, afterMsgId: snap.transcript[snap.transcript.length - 1]?.msgId ?? null };
}

/** Every outcome a listener computed, one per notify. */
function watch(store: CodeSessionStore, run: CompactionTurn): Array<CompactionVerdict | null> {
  const seen: Array<CompactionVerdict | null> = [];
  store.subscribe(() => {
    seen.push(compactionOutcome(run, store.getSnapshot()));
  });
  return seen;
}

const SUCCEEDED: CompactionVerdict = { outcome: "succeeded", failureReason: null };

describe("compactionOutcome — the run settles from what the snapshot holds", () => {
  it("a card that slept through the compaction settles from the catch-up's one batch", () => {
    const h = makeStore();
    history(h, 2);
    const run = wheelCompact(h);
    expect(compactionOutcome(run, h.store.getSnapshot())).toBeNull();

    // Hidden, the body sleeps mid-compaction and hears nothing more.
    h.store.noteDormant();
    // Revealed: the catch-up asks for what it slept through.
    h.store.catchUp();
    h.flush();
    const ask = h.conn.recordedFrames
      .filter((f) => f.feedId === FeedId.CONTROL)
      .map((f) => JSON.parse(new TextDecoder().decode(f.decoded as Uint8Array)) as Record<string, unknown>)
      .filter((f) => f.action === "request_replay" && f.reason === "catch-up")
      .pop()!.ask_id as string;

    const seen = watch(h.store, run);
    // ONE batch: the compact turn committed with its boundary and summary,
    // and the next wheel turn's in-flight snapshot behind it.
    emit(h.conn, { type: "replay_started", ask_id: ask });
    emitTurn(h.conn, 1);
    emit(h.conn, {
      type: "add_user_message",
      content: [{ type: "text", text: COMPACT_ENVELOPE }],
      submissionId: JOURNAL_ID,
    });
    emitCompaction(h.conn);
    emit(h.conn, { type: "turn_complete", seq: 1, msg_id: FIXTURE_IDS.MSG_ID_N(2), result: "success" });
    const next = FIXTURE_IDS.MSG_ID_N(3);
    emit(h.conn, { type: "add_user_message", content: [{ type: "text", text: RESUME_PROMPT }], inflightSnapshot: true });
    emit(h.conn, { type: "content_block_start", msg_id: next, block_index: 0, kind: "text" });
    emit(h.conn, { type: "assistant_text", msg_id: next, block_index: 0, seq: 0, rev: 0, text: "so far", is_partial: false, status: "streaming" });
    emit(h.conn, { type: "replay_complete", count: 2, firstLoadedTurnIndex: 0, totalTurns: 4, hasOlder: false, ask_id: ask });
    h.flush();

    const snap = h.store.getSnapshot();
    // The next turn is running — the run settles before it ends.
    expect(snap).toMatchObject({ phase: "streaming", catchingUp: false });
    expect(snap.activeTurn).not.toBeNull();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toEqual(SUCCEEDED);
  });

  it("with no dormancy, a batch carrying the turn's end and the next opener settles the same", () => {
    const h = makeStore();
    history(h, 2);
    const run = wheelCompact(h);
    const seen = watch(h.store, run);

    emitCompaction(h.conn);
    emit(h.conn, { type: "turn_complete", seq: 1, msg_id: FIXTURE_IDS.MSG_ID_N(2), result: "success" });
    emit(h.conn, { type: "tug_notice", origin: "wheel", text: RESUME_PROMPT });
    h.flush();

    expect(h.store.getSnapshot().activeTurn).not.toBeNull();
    expect(seen).toEqual([SUCCEEDED]);
  });

  it("a look taken after the turn ended settles on that first read", () => {
    const h = makeStore();
    history(h, 2);
    const turnKey = h.store.send("/compact", [])!;
    const run: CompactionTurn = { turnKey, afterMsgId: FIXTURE_IDS.MSG_ID_N(1) };
    emitCompaction(h.conn);
    emit(h.conn, { type: "turn_complete", seq: 1, msg_id: FIXTURE_IDS.MSG_ID_N(2), result: "success" });
    h.flush();

    // Nobody watched: one read is enough.
    expect(compactionOutcome(run, h.store.getSnapshot())).toEqual(SUCCEEDED);
  });

  it("a store rebuilt from a replay answers for a run that carries its key", () => {
    const h = makeStore();
    const run: CompactionTurn = { turnKey: JOURNAL_ID, afterMsgId: FIXTURE_IDS.MSG_ID_N(1) };
    emit(h.conn, { type: "replay_started" });
    emitTurn(h.conn, 0);
    emitTurn(h.conn, 1);
    emit(h.conn, {
      type: "add_user_message",
      content: [{ type: "text", text: COMPACT_ENVELOPE }],
      submissionId: JOURNAL_ID,
    });
    emitCompaction(h.conn);
    emit(h.conn, { type: "turn_complete", seq: 1, msg_id: FIXTURE_IDS.MSG_ID_N(2), result: "success" });
    emit(h.conn, { type: "replay_complete", count: 3, firstLoadedTurnIndex: 0, totalTurns: 3, hasOlder: false });
    h.flush();

    const snap = h.store.getSnapshot();
    expect(snap.transcript[2].compacted).toBe(true);
    expect(compactionOutcome(run, snap)).toEqual(SUCCEEDED);
    // Re-keyed and carrying neither id, the turn is still found by its place.
    expect(compactionOutcome({ turnKey: "deck-key", afterMsgId: FIXTURE_IDS.MSG_ID_N(1) }, snap)).toEqual(SUCCEEDED);
  });

  it("stays open while the turn runs, and a turn interrupted before any compaction is canceled", () => {
    const h = makeStore();
    history(h, 2);
    const run = wheelCompact(h);
    expect(compactionOutcome(run, h.store.getSnapshot())).toBeNull();

    emit(h.conn, { type: "turn_complete", seq: 1, msg_id: FIXTURE_IDS.MSG_ID_N(2), result: "interrupted" });
    h.flush();
    const ended = h.store.getSnapshot().transcript[h.store.getSnapshot().transcript.length - 1];
    expect(ended?.compacted).toBeUndefined();
    expect(ended?.turnEndReason).toBe("interrupted");
    expect(compactionOutcome(run, h.store.getSnapshot())).toEqual({ outcome: "canceled", failureReason: null });
  });

  it("a compaction that landed and then was interrupted still succeeded", () => {
    const h = makeStore();
    history(h, 2);
    const run = wheelCompact(h);
    emitCompaction(h.conn);
    emit(h.conn, { type: "turn_complete", seq: 1, msg_id: FIXTURE_IDS.MSG_ID_N(2), result: "interrupted" });
    h.flush();

    expect(compactionOutcome(run, h.store.getSnapshot())).toEqual(SUCCEEDED);
  });

  it("a turn that errored with no compaction fails", () => {
    const h = makeStore();
    history(h, 2);
    const run = wheelCompact(h);
    emit(h.conn, { type: "turn_complete", seq: 1, msg_id: FIXTURE_IDS.MSG_ID_N(2), result: "error" });
    h.flush();

    const snap = h.store.getSnapshot();
    expect(snap.transcript[h.store.getSnapshot().transcript.length - 1]?.turnEndReason).toBe("error");
    expect(compactionOutcome(run, snap)?.outcome).toBe("failed");
  });

  it("a turn that ended with no compaction fails, with the session's reason or the default", () => {
    const h = makeStore();
    history(h, 2);
    const run = wheelCompact(h);
    emit(h.conn, { type: "turn_complete", seq: 1, msg_id: FIXTURE_IDS.MSG_ID_N(2), result: "success" });
    h.flush();

    expect(compactionOutcome(run, h.store.getSnapshot())).toEqual({
      outcome: "failed",
      failureReason: h.store.getSnapshot().lastError?.message ?? COMPACTION_DID_NOT_RUN,
    });
  });
});
