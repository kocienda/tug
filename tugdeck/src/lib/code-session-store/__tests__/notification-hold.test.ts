/**
 * Notification-hold tests — the deferral a caller opens for the length
 * of something it is showing, and closes when it stops showing it.
 *
 * The hold is the replay fold's machinery with a different stop
 * condition. The fold ends when the `replaying` phase does; a hold ends
 * when its holder says so, or when the watchdog decides the holder is
 * not coming back. Everything else is shared and shared on purpose:
 * wire events reduce and run their effects as they arrive, the snapshot
 * stays pinned, and one flush at the end carries everything.
 *
 * Its first caller is the imposer's arrangement settle, where a React
 * commit landing inside the gesture window measured 81% more expensive
 * than the same commit landing outside it
 * (`arc/jul30-perf-brief.md#s5-imposer`).
 *
 * The rules with teeth, each pinned below: nothing is dropped (a held
 * run ends state-equal to an unheld one); the user's own gestures are
 * never held; a hold nobody releases still ends; and holding twice or
 * releasing twice is not a way to break it.
 */

import { describe, it, expect } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";

const TUG = FIXTURE_IDS.TUG_SESSION_ID;

/** A store with a hand-driven clock, so the watchdog is deterministic. */
function makeStore() {
  const pending = new Map<number, () => void>();
  let armed = 0;
  const conn = new TestFrameChannel();
  const store = new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: TUG,
    sessionMode: "resume",
    timerSource: {
      setTimeout: (cb: () => void) => {
        armed += 1;
        pending.set(armed, cb);
        return armed;
      },
      clearTimeout: (handle: unknown) => {
        pending.delete(handle as number);
      },
    },
  });
  let count = 0;
  store.subscribe(() => {
    count += 1;
  });
  return {
    store,
    conn,
    notifies: () => count,
    pendingTimers: () => pending.size,
    fireTimers: () => {
      for (const [id, cb] of [...pending]) {
        pending.delete(id);
        cb();
      }
    },
  };
}

function emit(conn: TestFrameChannel, evt: Record<string, unknown>): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, { ...evt, tug_session_id: TUG });
}

/** One replayed turn's three frames — only meaningful inside a replay window. */
function emitTurn(conn: TestFrameChannel, n: number): void {
  emit(conn, {
    type: "add_user_message",
    content: [{ type: "text", text: `prompt ${n}` }],
  });
  emit(conn, {
    type: "assistant_text",
    msg_id: FIXTURE_IDS.MSG_ID_N(n),
    text: `reply ${n}`,
    is_partial: false,
    rev: 0,
    seq: 0,
  });
  emit(conn, {
    type: "turn_complete",
    msg_id: FIXTURE_IDS.MSG_ID_N(n),
    result: "success",
  });
}

/**
 * One streamed token of a live turn. This is the traffic a settle
 * actually contends with, and — unlike a bare replayed frame, which
 * reduces to nothing outside a replay window — it moves the state on
 * every event.
 */
function delta(conn: TestFrameChannel, seq: number): void {
  emit(conn, {
    type: "assistant_text",
    msg_id: FIXTURE_IDS.MSG_ID_N(1),
    text: "x",
    is_partial: true,
    rev: 0,
    seq,
  });
}

/**
 * Open a live turn and cross the two phase boundaries at its start, so
 * a caller's subsequent deltas are same-phase — the streaming steady
 * state rather than the transitions into it.
 */
function startLiveTurn(store: CodeSessionStore, conn: TestFrameChannel): void {
  store.send("hello", []);
  delta(conn, 0);
  delta(conn, 1);
}

describe("notification hold — quiet while held, one flush at release", () => {
  it("holds every wire notification and publishes exactly once on release", () => {
    const { store, conn, notifies } = makeStore();

    startLiveTurn(store, conn);
    store.holdNotifications(1_000);
    const before = notifies();

    for (let seq = 2; seq <= 13; seq++) delta(conn, seq);
    expect(notifies()).toBe(before);

    store.releaseNotifications();
    expect(notifies()).toBe(before + 1);
  });

  it("pins the published snapshot while held", () => {
    const { store, conn } = makeStore();

    startLiveTurn(store, conn);
    const pinned = store.getSnapshot();
    store.holdNotifications(1_000);
    delta(conn, 2);
    delta(conn, 3);

    // Reduced, but unpublished — reads return the same reference.
    expect(store.getSnapshot()).toBe(pinned);

    store.releaseNotifications();
    expect(store.getSnapshot()).not.toBe(pinned);
  });

  it("defers nothing that changes what the user sees of their own actions", () => {
    const { store, conn, notifies } = makeStore();

    startLiveTurn(store, conn);
    emit(conn, {
      type: "turn_complete",
      msg_id: FIXTURE_IDS.MSG_ID_N(1),
      result: "success",
    });
    store.holdNotifications(1_000);
    delta(conn, 5);
    const held = notifies();

    // A local-origin action publishes immediately and carries the held
    // events with it — the same truthfulness rule the replay fold keeps.
    store.send("second", []);
    expect(notifies()).toBeGreaterThan(held);

    store.releaseNotifications();
  });

  it("a held run ends state-equal to an unheld control fed the same events", () => {
    const held = makeStore();
    const control = makeStore();

    held.store.holdNotifications(10_000);
    for (const { conn } of [held, control]) {
      emit(conn, { type: "replay_started" });
      for (let n = 1; n <= 8; n++) emitTurn(conn, n);
      emit(conn, { type: "replay_complete", count: 8 });
    }
    held.store.releaseNotifications();

    const a = held.store.getSnapshot();
    const b = control.store.getSnapshot();
    expect(a.phase).toBe(b.phase);
    expect(a.transcript).toHaveLength(b.transcript.length);
    for (let i = 0; i < a.transcript.length; i++) {
      expect(a.transcript[i].msgId).toBe(b.transcript[i].msgId);
      expect(a.transcript[i].result).toBe(b.transcript[i].result);
      expect(a.transcript[i].messages.length).toBe(
        b.transcript[i].messages.length,
      );
    }
  });

  it("the watchdog ends a hold nobody released, and the late release is a no-op", () => {
    const { store, conn, notifies, pendingTimers, fireTimers } = makeStore();

    startLiveTurn(store, conn);
    store.holdNotifications(500);
    delta(conn, 2);
    const held = notifies();
    expect(pendingTimers()).toBe(1);

    // The holder never came back. The cap is not the clock — it is the
    // guard against a card left showing stale content forever ([L23]).
    fireTimers();
    expect(notifies()).toBe(held + 1);

    // The holder finally releasing changes nothing.
    store.releaseNotifications();
    expect(notifies()).toBe(held + 1);
  });

  it("re-holding re-arms the watchdog rather than stacking one per call", () => {
    const { store, pendingTimers } = makeStore();

    store.holdNotifications(500);
    store.holdNotifications(500);
    store.holdNotifications(500);
    expect(pendingTimers()).toBe(1);

    store.releaseNotifications();
    expect(pendingTimers()).toBe(0);
  });

  it("releasing is idempotent, and releasing without a hold is harmless", () => {
    const { store, conn, notifies } = makeStore();

    // No hold open at all.
    store.releaseNotifications();
    const start = notifies();
    expect(start).toBe(0);

    startLiveTurn(store, conn);
    const beforeHold = notifies();
    store.holdNotifications(1_000);
    delta(conn, 2);
    store.releaseNotifications();
    const afterFirst = notifies();
    expect(afterFirst).toBe(beforeHold + 1);

    // A second release publishes nothing — there is nothing held.
    store.releaseNotifications();
    store.releaseNotifications();
    expect(notifies()).toBe(afterFirst);
  });

  it("releasing an empty hold publishes nothing", () => {
    const { store, notifies } = makeStore();

    store.holdNotifications(1_000);
    const before = notifies();
    store.releaseNotifications();
    expect(notifies()).toBe(before);
  });

  it("teardown mid-hold flushes — a card torn down mid-gesture strands nothing", () => {
    const { store, conn, notifies } = makeStore();
    let snapshotAtLastNotify: unknown = null;
    store.subscribe(() => {
      snapshotAtLastNotify = store.getSnapshot();
    });

    startLiveTurn(store, conn);
    store.holdNotifications(10_000);
    const pinned = store.getSnapshot();
    delta(conn, 2);
    delta(conn, 3);
    const before = notifies();
    // Still pinned: the deltas reduced, the publication waited.
    expect(store.getSnapshot()).toBe(pinned);

    store.dispose();
    expect(notifies()).toBe(before + 1);
    // The last thing listeners saw was the state AFTER the held deltas,
    // not the pinned one they were looking at when dispose was called.
    expect(snapshotAtLastNotify).not.toBe(pinned);
  });

  it("absorbs a coalesce flush armed before the hold rather than letting it publish mid-window", () => {
    const { store, conn, notifies, pendingTimers } = makeStore();

    // One steady-state delta past the streaming transition arms the
    // ~frame-cadence trailing flush (the transition itself publishes
    // immediately, so the timer only exists from the delta after it).
    startLiveTurn(store, conn);
    delta(conn, 2);
    const timersBefore = pendingTimers();
    const before = notifies();

    // Holding cancels that timer and folds what it carried into the
    // hold, then arms the watchdog — one out, one in. Without the
    // absorption the count would grow by one, and the stale flush would
    // fire a frame into the window and publish the one commit the
    // holder asked to keep out.
    store.holdNotifications(10_000);
    expect(pendingTimers()).toBe(timersBefore);

    delta(conn, 3);
    expect(notifies()).toBe(before);

    store.releaseNotifications();
    expect(notifies()).toBe(before + 1);
  });

  it("a hold opened onto a pending coalesce flush still flushes on release even with no further events", () => {
    const { store, conn, notifies } = makeStore();

    startLiveTurn(store, conn);
    delta(conn, 2);
    const before = notifies();
    store.holdNotifications(10_000);

    // Nothing else arrives. The absorbed flush's reductions must still
    // reach listeners — the release publishes them.
    store.releaseNotifications();
    expect(notifies()).toBe(before + 1);
  });

  it("holds the streaming firehose too, not just whole-turn frames", () => {
    const { store, conn, notifies, pendingTimers } = makeStore();

    startLiveTurn(store, conn);
    const afterSend = notifies();
    const beforeHold = notifies();

    store.holdNotifications(10_000);
    const timersBefore = pendingTimers();
    delta(conn, 2);
    delta(conn, 3);
    delta(conn, 4);
    // Nothing published, and no coalesce timer armed either: while held,
    // the deferral is the hold's, so the streaming branch is not reached
    // and the hold cannot be ended early by a timer it never set.
    expect(notifies()).toBe(beforeHold);
    expect(pendingTimers()).toBe(timersBefore);

    store.releaseNotifications();
    expect(notifies()).toBe(beforeHold + 1);
    expect(afterSend).toBeGreaterThan(0);
  });
});
