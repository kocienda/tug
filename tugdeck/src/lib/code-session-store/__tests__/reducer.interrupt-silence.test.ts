/**
 * The interrupt deadline: what a card does when its stop is answered by
 * nothing at all.
 *
 * Steps 1 and 3 of this arc closed both ways a receipt could go missing —
 * the deck now handles `turn_cancelled`, and tugcode now answers an
 * interrupt that found nothing to interrupt. So this deadline should
 * never fire. It exists because the failure the arc came from *was* a
 * receipt that was supposed to be impossible to lose: the deck had no
 * horizon behind the protocol, so when the protocol went quiet the card
 * said "Interrupting" until it was closed.
 *
 * What the tick does, and deliberately does not do ([P01]): it clears
 * `interruptInFlight`, closes the interrupt segment so the turn clock is
 * honest, and raises `stopStalled` — and it leaves `pendingTurn` open.
 * The deck knows its stop went unanswered; it does not know the turn
 * ended, and committing one on a timer would be the same confident lie
 * the app-wide restore modal told.
 *
 * Driven through the real store with an injected `TimerSource`, because
 * the arming rule lives in the wrapper: the timer's life is tied to
 * `interruptInFlight`'s, which is what makes it impossible to forget at
 * one of the fourteen returns that clear the flag.
 */

import { describe, it, expect } from "bun:test";

import {
  CodeSessionStore,
  INTERRUPT_SILENCE_DEADLINE_MS,
  type TimerSource,
} from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";
import { interruptSilenceEffect } from "@/lib/code-session-store/reducer";
import { deriveInflightActiveMs } from "@/lib/code-session-store/telemetry";

const TUG = FIXTURE_IDS.TUG_SESSION_ID;
const IPC_VERSION = 2;

interface FakeTimerEntry {
  id: number;
  cb: () => void;
  fireAt: number;
  cleared: boolean;
}

/** The captured-table fake from `code-session-store.replay-clock.test.ts`. */
class FakeTimers {
  private now = 0;
  private nextId = 1;
  private entries: FakeTimerEntry[] = [];

  readonly source: TimerSource = {
    setTimeout: (cb, ms) => {
      const id = this.nextId++;
      this.entries.push({ id, cb, fireAt: this.now + ms, cleared: false });
      return id;
    },
    clearTimeout: (handle) => {
      if (typeof handle !== "number") return;
      const entry = this.entries.find((e) => e.id === handle);
      if (entry) entry.cleared = true;
    },
  };

  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      const due = this.entries
        .filter((e) => !e.cleared && e.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt);
      if (due.length === 0) break;
      const next = due[0]!;
      this.now = next.fireAt;
      next.cleared = true;
      next.cb();
    }
    this.now = target;
  }

  pendingCount(): number {
    return this.entries.filter((e) => !e.cleared).length;
  }

  /**
   * Pending timers due within `ms` of now.
   *
   * The store arms more than one named timer over a live turn — the
   * stream-stall deadline is armed by every stream event — and this fake
   * sees only `setTimeout`, with no names to filter on. The deadlines are
   * far enough apart in duration to tell apart by *when they fire*, which
   * is what this reads: `pendingDue(INTERRUPT_SILENCE_DEADLINE_MS)` is the
   * interrupt deadline and nothing else, because every other timer this
   * store arms is an order of magnitude further out.
   */
  pendingDue(ms: number): number {
    return this.entries.filter((e) => !e.cleared && e.fireAt <= this.now + ms)
      .length;
  }
}

function makeStore(): {
  store: CodeSessionStore;
  conn: TestFrameChannel;
  timers: FakeTimers;
} {
  const conn = new TestFrameChannel();
  const timers = new FakeTimers();
  const store = new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: TUG,
    sessionMode: "new",
    timerSource: timers.source,
  });
  return { store, conn, timers };
}

function emit(conn: TestFrameChannel, evt: Record<string, unknown>): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, { ...evt, tug_session_id: TUG });
}

/** Every CODE_INPUT frame the store has sent, decoded. */
function sentVerbs(conn: TestFrameChannel): Array<Record<string, unknown>> {
  return conn.recordedFrames
    .filter((f) => f.feedId === FeedId.CODE_INPUT)
    .map((f) => f.decoded as Record<string, unknown>);
}

/**
 * A live turn that has streamed one assistant block, then the user's
 * Stop — CASE B, the only branch that opens an interrupt round-trip.
 */
function caseBInterrupt(): ReturnType<typeof makeStore> {
  const fixture = makeStore();
  fixture.store.send("hi", []);
  emit(fixture.conn, {
    type: "assistant_text",
    msg_id: "m1",
    block_index: 0,
    text: "partial",
    is_partial: true,
    ipc_version: IPC_VERSION,
  });
  fixture.store.interrupt();
  return fixture;
}

const turnComplete = (result: string) => ({
  type: "turn_complete",
  msg_id: "m1",
  seq: 1,
  result,
  ipc_version: IPC_VERSION,
});

describe("interruptSilenceEffect — the arming rule", () => {
  it("arms when the flag rises and cancels when it falls", () => {
    expect(interruptSilenceEffect(false, true)).toEqual({
      kind: "schedule_timer",
      name: "interrupt_silence",
      ms: INTERRUPT_SILENCE_DEADLINE_MS,
      fire: { type: "tick_interrupt_silence" },
    });
    expect(interruptSilenceEffect(true, false)).toEqual({
      kind: "cancel_timer",
      name: "interrupt_silence",
    });
  });

  it("says nothing when the flag did not move", () => {
    // Which is every dispatch but two per interrupt. A rule that fired on
    // a steady flag would re-arm the deadline on every frame, and the
    // deadline would then be exactly the kind that cannot expire.
    expect(interruptSilenceEffect(false, false)).toBeNull();
    expect(interruptSilenceEffect(true, true)).toBeNull();
  });
});

describe("a stop that is answered — the deadline never fires", () => {
  it("CASE B arms the timer", () => {
    const { store, timers } = caseBInterrupt();
    expect(store.getSnapshot().interruptInFlight).toBe(true);
    expect(store.getSnapshot().stopStalled).toBe(false);
    expect(timers.pendingDue(INTERRUPT_SILENCE_DEADLINE_MS)).toBe(1);
  });

  it("a turn_complete inside the window cancels it and stopStalled never sets", () => {
    const { store, conn, timers } = caseBInterrupt();
    timers.advance(INTERRUPT_SILENCE_DEADLINE_MS - 1);
    expect(store.getSnapshot().stopStalled).toBe(false);
    emit(conn, turnComplete("error"));
    expect(timers.pendingDue(INTERRUPT_SILENCE_DEADLINE_MS)).toBe(0);
    // Past the original deadline, and nothing fires.
    timers.advance(INTERRUPT_SILENCE_DEADLINE_MS * 2);
    expect(store.getSnapshot().stopStalled).toBe(false);
    expect(store.getSnapshot().phase).toBe("idle");
  });

  it("a turn_cancelled inside the window cancels it too", () => {
    const { store, conn, timers } = caseBInterrupt();
    timers.advance(1_000);
    emit(conn, {
      type: "turn_cancelled",
      msg_id: "m1",
      seq: 1,
      partial_result: "User interrupted",
      ipc_version: IPC_VERSION,
    });
    expect(timers.pendingDue(INTERRUPT_SILENCE_DEADLINE_MS)).toBe(0);
    timers.advance(INTERRUPT_SILENCE_DEADLINE_MS * 2);
    expect(store.getSnapshot().stopStalled).toBe(false);
  });

  it("an interrupt_noop inside the window cancels it", () => {
    const { store, conn, timers } = caseBInterrupt();
    emit(conn, {
      type: "interrupt_noop",
      reason: "no_turn",
      ipc_version: IPC_VERSION,
    });
    expect(store.getSnapshot().interruptInFlight).toBe(false);
    expect(timers.pendingDue(INTERRUPT_SILENCE_DEADLINE_MS)).toBe(0);
    timers.advance(INTERRUPT_SILENCE_DEADLINE_MS * 2);
    expect(store.getSnapshot().stopStalled).toBe(false);
  });
});

describe("a stop that is not answered — the deadline is the answer", () => {
  it("the tick raises stopStalled, stands the interrupt down, and leaves the turn open", () => {
    const { store, timers } = caseBInterrupt();
    timers.advance(INTERRUPT_SILENCE_DEADLINE_MS - 1);
    expect(store.getSnapshot().interruptInFlight).toBe(true);

    timers.advance(1);
    const snap = store.getSnapshot();
    expect(snap.stopStalled).toBe(true);
    expect(snap.interruptInFlight).toBe(false);
    // [P01]: the deck knows its stop went unanswered. It does not know
    // the turn ended, and it does not say so.
    expect(snap.activeTurn).not.toBeNull();
    expect(snap.phase).not.toBe("idle");
    // Nothing was committed and no error was manufactured.
    expect(snap.lastError).toBeNull();
  });

  it("closes the interrupt segment, so the paused turn clock is not double-counted", () => {
    const { store, timers } = caseBInterrupt();
    const opened = store.getSnapshot().interruptInFlightSegmentStartedAt;
    expect(opened).not.toBeNull();

    timers.advance(INTERRUPT_SILENCE_DEADLINE_MS);
    const snap = store.getSnapshot();
    expect(snap.interruptInFlightSegmentStartedAt).toBeNull();
    expect(snap.interruptInFlightIntervals).toHaveLength(1);

    // With the segment closed, the live clock reports the turn's active
    // time with the unanswered window deducted once — not counted as
    // both an open segment and a closed interval.
    const now = Date.now() + 60_000;
    const active = deriveInflightActiveMs(snap, now);
    const closed = snap.interruptInFlightIntervals[0]!;
    expect(active).toBeLessThanOrEqual(now - (snap.activeTurn?.submitAt ?? now));
    expect(closed[1]).toBeGreaterThanOrEqual(closed[0]);
  });

  it("the tick is inert once the flag is already down", () => {
    // The race the guard exists for: a receipt landed in the same beat
    // the timer fired. Reached here by ticking twice — the first fires,
    // the second finds nothing.
    const { store, timers } = caseBInterrupt();
    timers.advance(INTERRUPT_SILENCE_DEADLINE_MS);
    const settled = store.getSnapshot();
    expect(settled.stopStalled).toBe(true);
    timers.advance(INTERRUPT_SILENCE_DEADLINE_MS * 2);
    expect(store.getSnapshot()).toBe(settled);
  });
});

describe("what clears a stalled stop", () => {
  it("a turn_cancelled arriving after the tick still commits the turn", () => {
    const { store, conn, timers } = caseBInterrupt();
    timers.advance(INTERRUPT_SILENCE_DEADLINE_MS);
    expect(store.getSnapshot().stopStalled).toBe(true);

    // The receipt was late, not lost — Force Stop's own answer looks
    // exactly like this.
    emit(conn, {
      type: "turn_cancelled",
      msg_id: "m1",
      seq: 1,
      partial_result: "User interrupted",
      is_recovery: true,
      ipc_version: IPC_VERSION,
    });
    const snap = store.getSnapshot();
    expect(snap.stopStalled).toBe(false);
    expect(snap.phase).toBe("idle");
    expect(snap.activeTurn).toBeNull();
  });

  it("a late interrupt_noop clears it without touching the turn", () => {
    const { store, conn, timers } = caseBInterrupt();
    timers.advance(INTERRUPT_SILENCE_DEADLINE_MS);
    const stalled = store.getSnapshot();
    emit(conn, {
      type: "interrupt_noop",
      reason: "no_process",
      ipc_version: IPC_VERSION,
    });
    const snap = store.getSnapshot();
    expect(snap.stopStalled).toBe(false);
    // By construction tugcode had no turn to end, so the deck's stays.
    expect(snap.phase).toBe(stalled.phase);
    expect(snap.activeTurn).not.toBeNull();
  });

  it("a terminal clears it", () => {
    const { store, conn, timers } = caseBInterrupt();
    timers.advance(INTERRUPT_SILENCE_DEADLINE_MS);
    expect(store.getSnapshot().stopStalled).toBe(true);
    emit(conn, {
      type: "error",
      message: "protocol error",
      site: "drain_eof",
      ipc_version: IPC_VERSION,
    });
    const snap = store.getSnapshot();
    expect(snap.phase).toBe("errored");
    expect(snap.stopStalled).toBe(false);
    expect(snap.interruptInFlight).toBe(false);
  });

  it("a send while stalled queues, and the flag survives to the real turn end", () => {
    // The [P01] claim from the composer's side: the turn is still open,
    // so a submission queues rather than starting one — which is exactly
    // what makes not committing the turn affordable. The stalled stop
    // stays true until something really ends the turn it belongs to.
    const { store, conn, timers } = caseBInterrupt();
    timers.advance(INTERRUPT_SILENCE_DEADLINE_MS);

    store.send("and also this", []);
    expect(store.getSnapshot().stopStalled).toBe(true);
    expect(store.getSnapshot().activeTurn).not.toBeNull();

    emit(conn, turnComplete("error"));
    const snap = store.getSnapshot();
    expect(snap.stopStalled).toBe(false);
    // The turn really ended, which is the only thing that was ever going
    // to clear the flag. (What became of the queued message is the error
    // path's own long-standing rule — it drops the queue — and not this
    // deadline's business.)
    expect(snap.activeTurn).toBeNull();
  });
});

describe("force stop — the control an unanswered stop turns Stop into", () => {
  it("emits exactly one stop_all_work with an empty task_ids", () => {
    const { store, conn, timers } = caseBInterrupt();
    timers.advance(INTERRUPT_SILENCE_DEADLINE_MS);
    expect(store.getSnapshot().stopStalled).toBe(true);

    const before = sentVerbs(conn).length;
    store.forceStop();
    const sent = sentVerbs(conn).slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe("stop_all_work");
    // tugcode keeps no open-job set of its own — the ids ride the verb from
    // tugcast's supervisor, and a deck-origin stop goes straight to the
    // group sweep.
    expect(sent[0]!.task_ids).toEqual([]);
    // The frame has gone out and nothing has come back; the card is in the
    // state it was already in.
    expect(store.getSnapshot().stopStalled).toBe(true);
  });

  it("from any other state it sends nothing and changes nothing ([P02])", () => {
    // There is no door to Force Stop that does not run through a stop the
    // session failed to answer.
    const { store, conn } = caseBInterrupt();
    const before = sentVerbs(conn).length;
    const mid = store.getSnapshot();
    store.forceStop();
    expect(sentVerbs(conn)).toHaveLength(before);
    expect(store.getSnapshot()).toBe(mid);
  });

  it("the unified pop escalates too, rather than repeating the stop ([F04])", () => {
    // Escape and the Z5 button are one gesture. Once a stop has gone
    // unanswered, repeating it would send a frame the session has already
    // proved it will not answer.
    const { store, conn, timers } = caseBInterrupt();
    timers.advance(INTERRUPT_SILENCE_DEADLINE_MS);
    const before = sentVerbs(conn).length;
    store.popInteractive();
    const sent = sentVerbs(conn).slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe("stop_all_work");
  });

  it("stop_all_work_done clears stopStalled even with no turn_cancelled", () => {
    // The belt to `turn_cancelled`'s braces: tugcode answers `done` on its
    // failure paths too, so a teardown that half-worked still settles the
    // card rather than leaving Force Stop standing over nothing.
    const { store, conn, timers } = caseBInterrupt();
    timers.advance(INTERRUPT_SILENCE_DEADLINE_MS);
    store.forceStop();
    const stalled = store.getSnapshot();

    emit(conn, { type: "stop_all_work_done", ipc_version: IPC_VERSION });
    const snap = store.getSnapshot();
    expect(snap.stopStalled).toBe(false);
    // The turn is not this frame's to end.
    expect(snap.phase).toBe(stalled.phase);
    expect(snap.activeTurn).not.toBeNull();
  });

  it("a stop_all_work_done with nothing stalled is inert", () => {
    const { store, conn } = caseBInterrupt();
    const before = store.getSnapshot();
    emit(conn, { type: "stop_all_work_done", ipc_version: IPC_VERSION });
    expect(store.getSnapshot()).toBe(before);
  });
});
