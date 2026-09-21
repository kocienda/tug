/**
 * Replay-clock tests for `CodeSessionStore`.
 *
 * The store owns three time-derived snapshot fields used by the
 * Session card's resume UX:
 *
 *   - `replayPreflightActive` — opens on `notifyResumeBindingLanded()`,
 *     closes on the first of `replay_started`, `replay_complete`,
 *     `transport_close`, or `REPLAY_PREFLIGHT_TIMEOUT_MS` (12s).
 *   - `replaySoftBudgetElapsed` — opens `REPLAY_SOFT_BUDGET_MS` (2s)
 *     after `replay_started` if the window is still open; resets
 *     when the window closes.
 *   - `replayTimeoutDwellActive` — opens on `replay_complete{
 *     replay_timeout}`, closes `REPLAY_TIMEOUT_DWELL_MS` (1.5s)
 *     later or on the next `replay_started`.
 *
 * and two deadlines with no field of their own:
 *
 *   - a bracket that hears no *bracket-borne* frame for
 *     `REPLAY_SILENCE_DEADLINE_MS` is abandoned with a `replay_stalled`
 *     `lastError`. Which frames count is `BRACKET_FRAME_TYPES`, and the
 *     partition tests at the bottom of this file are what keep that set
 *     total against the deck's accepted frame vocabulary.
 *   - a bracket that has not closed after `REPLAY_BRACKET_DEADLINE_MS`
 *     is abandoned with a `replay_bracket_timeout` `lastError`,
 *     whatever arrived inside it.
 *
 * Tests use an injected `TimerSource` so the store can be advanced
 * deterministically without racing real wall-clock delays. Each
 * scheduled timer lands in a captured table keyed by the order of
 * scheduling; `advance(ms)` fires every captured timer whose
 * deadline lands in the window. This mirrors the manual-table
 * pattern in `connection.test.ts` for `setInterval` fakes — the
 * abstractions are different but the principle (deterministic time
 * via captured callbacks) is shared.
 */

import { describe, it, expect } from "bun:test";

import {
  CodeSessionStore,
  BRACKET_FRAME_TYPES,
  KNOWN_CODE_OUTPUT_TYPES,
  REPLAY_BRACKET_DEADLINE_MS,
  REPLAY_BRACKET_MESSAGE,
  REPLAY_PREFLIGHT_TIMEOUT_MS,
  REPLAY_SILENCE_DEADLINE_MS,
  REPLAY_SOFT_BUDGET_MS,
  REPLAY_STALLED_MESSAGE,
  REPLAY_TIMEOUT_DWELL_MS,
  type TimerSource,
} from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";
import { replaySilenceEffect } from "@/lib/code-session-store/reducer";
import type { Effect } from "@/lib/code-session-store/effects";
import { deriveColdRestoreActive } from "@/components/tugways/cards/session-card-restore-gate";

const TUG = FIXTURE_IDS.TUG_SESSION_ID;
const IPC_VERSION = 2;

interface FakeTimerEntry {
  id: number;
  cb: () => void;
  fireAt: number;
  cleared: boolean;
}

/**
 * A captured-table fake timer source. `now` advances only when the
 * test calls `advance(ms)`; each call fires every callback whose
 * `fireAt` lands in the window in scheduling order. Callbacks that
 * schedule new timers during their fire are picked up on subsequent
 * iterations of the same `advance` call.
 */
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
      const next = due[0];
      this.now = next.fireAt;
      next.cleared = true; // a fired timer is one-shot
      next.cb();
    }
    this.now = target;
  }

  /** Number of pending (not-yet-fired, not-cleared) timers. */
  pendingCount(): number {
    return this.entries.filter((e) => !e.cleared).length;
  }
}

interface StoreFixture {
  store: CodeSessionStore;
  conn: TestFrameChannel;
  timers: FakeTimers;
}

function makeStore(): StoreFixture {
  const conn = new TestFrameChannel();
  const timers = new FakeTimers();
  const store = new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: TUG,
    // The replay-clock surfaces (preflight, soft-budget, timeout dwell)
    // are exercised in production only for resume-mode bindings — the
    // upstream call to `notifyResumeBindingLanded()` is gated on
    // `binding.sessionMode === "resume"` (`card-services-store.ts`).
    // Mirror that here so the fixture matches the production scenario,
    // even though the reducer itself is mode-agnostic for these
    // transitions.
    sessionMode: "resume",
    timerSource: timers.source,
  });
  return { store, conn, timers };
}

function emit(conn: TestFrameChannel, evt: Record<string, unknown>): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, { ...evt, tug_session_id: TUG });
}

const replayStarted = () => ({ type: "replay_started", ipc_version: IPC_VERSION });
const replayComplete = (
  count: number,
  error?: { kind: "replay_timeout"; message: string },
) =>
  error
    ? { type: "replay_complete", count, error, ipc_version: IPC_VERSION }
    : { type: "replay_complete", count, ipc_version: IPC_VERSION };

// ---------------------------------------------------------------------------
// replaySoftBudgetElapsed
// ---------------------------------------------------------------------------

describe("CodeSessionStore — replaySoftBudgetElapsed lifecycle", () => {
  it("flips true REPLAY_SOFT_BUDGET_MS after replay_started, clears on next replay_started", () => {
    const { store, conn, timers } = makeStore();

    expect(store.getSnapshot().replaySoftBudgetElapsed).toBe(false);

    emit(conn, replayStarted());
    expect(store.getSnapshot().replaySoftBudgetElapsed).toBe(false);

    timers.advance(REPLAY_SOFT_BUDGET_MS - 1);
    expect(store.getSnapshot().replaySoftBudgetElapsed).toBe(false);

    timers.advance(1);
    expect(store.getSnapshot().replaySoftBudgetElapsed).toBe(true);

    // Closing the window clears the flag.
    emit(conn, replayComplete(0));
    expect(store.getSnapshot().replaySoftBudgetElapsed).toBe(false);

    // A fresh window starts clean.
    emit(conn, replayStarted());
    expect(store.getSnapshot().replaySoftBudgetElapsed).toBe(false);
    timers.advance(REPLAY_SOFT_BUDGET_MS);
    expect(store.getSnapshot().replaySoftBudgetElapsed).toBe(true);
  });

  it("clears on replay_complete before the soft-budget timer fires", () => {
    const { store, conn, timers } = makeStore();
    emit(conn, replayStarted());
    timers.advance(REPLAY_SOFT_BUDGET_MS / 2); // mid-budget
    emit(conn, replayComplete(0));
    expect(store.getSnapshot().replaySoftBudgetElapsed).toBe(false);
    // Advancing past the original deadline must not flip it back.
    timers.advance(REPLAY_SOFT_BUDGET_MS);
    expect(store.getSnapshot().replaySoftBudgetElapsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// replayTimeoutDwellActive
// ---------------------------------------------------------------------------

describe("CodeSessionStore — replayTimeoutDwellActive lifecycle", () => {
  it("flips true on replay_complete{replay_timeout}; clears REPLAY_TIMEOUT_DWELL_MS later", () => {
    const { store, conn, timers } = makeStore();
    emit(conn, replayStarted());
    emit(
      conn,
      replayComplete(1, { kind: "replay_timeout", message: "timed out" }),
    );
    expect(store.getSnapshot().replayTimeoutDwellActive).toBe(true);

    timers.advance(REPLAY_TIMEOUT_DWELL_MS - 1);
    expect(store.getSnapshot().replayTimeoutDwellActive).toBe(true);

    timers.advance(1);
    expect(store.getSnapshot().replayTimeoutDwellActive).toBe(false);
  });

  it("does NOT fire for non-timeout replay errors", () => {
    const { store, conn, timers } = makeStore();
    emit(conn, replayStarted());
    emit(conn, {
      type: "replay_complete",
      count: 0,
      error: { kind: "jsonl_missing", message: "no JSONL" },
      ipc_version: IPC_VERSION,
    });
    expect(store.getSnapshot().replayTimeoutDwellActive).toBe(false);
    timers.advance(REPLAY_TIMEOUT_DWELL_MS * 2);
    expect(store.getSnapshot().replayTimeoutDwellActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// replayPreflightActive
// ---------------------------------------------------------------------------

describe("CodeSessionStore — replayPreflightActive lifecycle", () => {
  it("flips true on notifyResumeBindingLanded() from idle", () => {
    const { store } = makeStore();
    expect(store.getSnapshot().replayPreflightActive).toBe(false);
    store.notifyResumeBindingLanded();
    expect(store.getSnapshot().replayPreflightActive).toBe(true);
  });

  it("clears on replay_started", () => {
    const { store, conn } = makeStore();
    store.notifyResumeBindingLanded();
    expect(store.getSnapshot().replayPreflightActive).toBe(true);
    emit(conn, replayStarted());
    expect(store.getSnapshot().replayPreflightActive).toBe(false);
  });

  it("clears on replay_complete (replay landed without observable replay_started)", () => {
    // Synthetic — would require a supervisor bug — but the reducer
    // is total, so verify a stray replay_complete inside the
    // preflight beat clears the flag.
    const { store, conn } = makeStore();
    store.notifyResumeBindingLanded();
    // Force into replaying first (the reducer requires it for
    // replay_complete to take effect), then close.
    emit(conn, replayStarted());
    emit(conn, replayComplete(0));
    expect(store.getSnapshot().replayPreflightActive).toBe(false);
  });

  it("clears on transport_close", () => {
    const { store } = makeStore();
    const lifecycle = new ConnectionLifecycle();
    const conn = new TestFrameChannel();
    const timers = new FakeTimers();
    const store2 = new CodeSessionStore({
      conn: conn as unknown as TugConnection,
      lifecycle,
      tugSessionId: TUG,
      sessionMode: "resume",
      timerSource: timers.source,
    });
    store2.notifyResumeBindingLanded();
    expect(store2.getSnapshot().replayPreflightActive).toBe(true);
    lifecycle.notifyConnectionDidClose();
    expect(store2.getSnapshot().replayPreflightActive).toBe(false);
    expect(store2.getSnapshot().transportState).toBe("offline");
    // No leaked pending preflight timer.
    expect(timers.pendingCount()).toBe(0);
    // Pin to silence unused-var lint.
    expect(store).toBeDefined();
  });

  it("clears on REPLAY_PREFLIGHT_TIMEOUT_MS escape-hatch tick", () => {
    const { store, timers } = makeStore();
    store.notifyResumeBindingLanded();
    expect(store.getSnapshot().replayPreflightActive).toBe(true);
    timers.advance(REPLAY_PREFLIGHT_TIMEOUT_MS - 1);
    expect(store.getSnapshot().replayPreflightActive).toBe(true);
    timers.advance(1);
    expect(store.getSnapshot().replayPreflightActive).toBe(false);
  });

  it("a second notifyResumeBindingLanded() while preflight is active is a reducer no-op (no second timer scheduled)", () => {
    const { store, timers } = makeStore();
    store.notifyResumeBindingLanded();
    const pendingAfterFirst = timers.pendingCount();
    expect(pendingAfterFirst).toBe(1);
    store.notifyResumeBindingLanded();
    store.notifyResumeBindingLanded();
    expect(timers.pendingCount()).toBe(pendingAfterFirst);
    expect(store.getSnapshot().replayPreflightActive).toBe(true);
  });

  it("notifyResumeBindingLanded() while not idle (mid-replay) is a no-op", () => {
    const { store, conn, timers } = makeStore();
    emit(conn, replayStarted());
    expect(store.getSnapshot().phase).toBe("replaying");
    const pendingMidReplay = timers.pendingCount(); // soft_budget timer
    store.notifyResumeBindingLanded();
    expect(store.getSnapshot().replayPreflightActive).toBe(false);
    expect(timers.pendingCount()).toBe(pendingMidReplay);
  });

  it("notifyResumeBindingLanded() while transport offline is a no-op", () => {
    const lifecycle = new ConnectionLifecycle();
    const conn = new TestFrameChannel();
    const timers = new FakeTimers();
    const store = new CodeSessionStore({
      conn: conn as unknown as TugConnection,
      lifecycle,
      tugSessionId: TUG,
      sessionMode: "resume",
      timerSource: timers.source,
    });
    lifecycle.notifyConnectionDidClose();
    expect(store.getSnapshot().transportState).toBe("offline");
    store.notifyResumeBindingLanded();
    expect(store.getSnapshot().replayPreflightActive).toBe(false);
    expect(timers.pendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Snapshot identity stability
// ---------------------------------------------------------------------------

describe("CodeSessionStore — snapshot identity stability with replay-clock fields", () => {
  it("a no-op tick (e.g. tick_soft_budget while not replaying) preserves snapshot identity", () => {
    // Drive the store into a state where the soft_budget tick is
    // queued but the phase has already left replaying. The reducer
    // returns the same state ref on a no-op tick; the wrapper sees
    // `prev === state` and effects empty, so the cached snapshot
    // stays.
    const { store, conn, timers } = makeStore();
    emit(conn, replayStarted());
    const snapDuringReplay = store.getSnapshot();
    // Close the window before the soft-budget would fire. The
    // reducer emits a `cancel_timer "soft_budget"` effect, which
    // marks our captured timer as cleared; advancing past the
    // original deadline is a no-op.
    emit(conn, replayComplete(0));
    const snapAfterComplete = store.getSnapshot();
    expect(snapAfterComplete).not.toBe(snapDuringReplay);

    // Advance past the original soft-budget deadline. Nothing fires.
    timers.advance(REPLAY_SOFT_BUDGET_MS);
    expect(store.getSnapshot()).toBe(snapAfterComplete);
  });

  it("replay-clock field changes invalidate the cached snapshot", () => {
    const { store, conn, timers } = makeStore();
    emit(conn, replayStarted());
    const before = store.getSnapshot();
    timers.advance(REPLAY_SOFT_BUDGET_MS);
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.replaySoftBudgetElapsed).toBe(true);
    expect(before.replaySoftBudgetElapsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dispose: timers cancelled, no listener fires post-dispose
// ---------------------------------------------------------------------------

describe("CodeSessionStore — dispose cancels all replay-clock timers", () => {
  it("dispose() clears every in-flight replay-clock timer", () => {
    const { store, conn, timers } = makeStore();
    store.notifyResumeBindingLanded();
    emit(conn, replayStarted());
    // After replay_started: preflight cancelled, soft_budget scheduled.
    // After replay_complete{replay_timeout}: soft_budget cancelled,
    // timeout_dwell scheduled.
    emit(
      conn,
      replayComplete(0, { kind: "replay_timeout", message: "t/o" }),
    );
    expect(timers.pendingCount()).toBe(1); // timeout_dwell
    store.dispose();
    expect(timers.pendingCount()).toBe(0);
  });

  it("a stray timer fire post-dispose does not notify listeners", () => {
    // Real `setTimeout` cancellation is reliable so this case is
    // synthetic, but the dispose guard is what protects us either
    // way: even if the fake timer were to fire after dispose, the
    // `_disposed` guard inside the schedule_timer callback drops the
    // dispatch.
    const { store, timers } = makeStore();
    let notifyCount = 0;
    store.subscribe(() => {
      notifyCount += 1;
    });
    store.notifyResumeBindingLanded();
    notifyCount = 0;
    store.dispose();
    timers.advance(REPLAY_PREFLIGHT_TIMEOUT_MS * 2);
    expect(notifyCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// replay silence deadline
// ---------------------------------------------------------------------------

describe("replaySilenceEffect — the arming rule", () => {
  const schedule: Effect = {
    kind: "schedule_timer",
    name: "replay_silence",
    ms: REPLAY_SILENCE_DEADLINE_MS,
    fire: { type: "tick_replay_silence" },
  };
  const cancel: Effect = { kind: "cancel_timer", name: "replay_silence" };

  it("arms on entering replaying, from the wire or not", () => {
    // The entering event is whatever produced the transition, and it is
    // not required to be bracket-borne: a local `replay_started` arms
    // just as a wire one does.
    expect(
      replaySilenceEffect("idle", "replaying", true, "replay_started"),
    ).toEqual(schedule);
    expect(
      replaySilenceEffect("errored", "replaying", false, "replay_started"),
    ).toEqual(schedule);
  });

  it("restarts on a bracket-borne wire frame, and only on one", () => {
    expect(
      replaySilenceEffect("replaying", "replaying", true, "assistant_text"),
    ).toEqual(schedule);
    // A local action or a timer tick is not the relay talking.
    expect(
      replaySilenceEffect("replaying", "replaying", false, "assistant_text"),
    ).toBeNull();
    // And neither is a wire frame from outside the bracket — the
    // reported restore hang, as one line.
    expect(
      replaySilenceEffect("replaying", "replaying", true, "api_retry"),
    ).toBeNull();
  });

  it("every BRACKET_FRAME_TYPES member buys time, and a non-member does not", () => {
    for (const type of BRACKET_FRAME_TYPES) {
      expect(
        replaySilenceEffect("replaying", "replaying", true, type),
      ).toEqual(schedule);
    }
    for (const type of ["api_retry", "cost_update", "streaming_usage"]) {
      expect(
        replaySilenceEffect("replaying", "replaying", true, type),
      ).toBeNull();
    }
  });

  it("disarms on leaving replaying by any exit", () => {
    expect(
      replaySilenceEffect("replaying", "idle", true, "replay_complete"),
    ).toEqual(cancel);
    expect(
      replaySilenceEffect("replaying", "streaming", true, "turn_complete"),
    ).toEqual(cancel);
    expect(
      replaySilenceEffect("replaying", "errored", false, "tick_replay_silence"),
    ).toEqual(cancel);
  });

  it("is silent outside a bracket", () => {
    // Including for a bracket frame — `assistant_text` outside a bracket
    // is the live tail, and has no deadline to restart.
    expect(replaySilenceEffect("idle", "idle", true, "assistant_text")).toBeNull();
    expect(replaySilenceEffect("idle", "streaming", false, "send")).toBeNull();
  });
});

describe("BRACKET_FRAME_TYPES — the partition is total", () => {
  /**
   * The CODE_OUTPUT types deliberately excluded from the bracket set.
   * Together with `BRACKET_FRAME_TYPES` this must cover every type the
   * deck accepts, so a frame type added to `KNOWN_CODE_OUTPUT_TYPES`
   * cannot silently land on one side or the other — whoever adds it has
   * to say here whether a bracket hearing it is still being replayed to.
   */
  const EXCLUDED: ReadonlySet<string> = new Set([
    // Session identity and bridge bookkeeping — true of the session, not
    // evidence the replay is progressing.
    "session_init",
    "session_segment",
    "control_request_forward",
    // Display-only folds. `api_retry` is the one that produced the
    // reported hang: a claude retrying a dead API emits it more often
    // than every 15 s.
    "api_retry",
    "model_refusal_fallback",
    "output_truncated",
    "unknown_event",
    "goal_feedback",
    "interrupt_noop",
    // The Force Stop receipt. A group sweep says nothing about whether a
    // replay is still arriving — if anything it says the opposite.
    "stop_all_work_done",
    // Telemetry.
    "cost_update",
    "streaming_usage",
    "context_breakdown",
    // Background jobs — a live claude's, never a replay's.
    "task_started",
    "task_updated",
    "task_progress",
    // `/rewind`, which cannot run during a restore.
    "prompt_anchor",
    "rewind_preview_result",
    "rewind_result",
    // Terminals. Each leaves `replaying` on its own, so restarting a
    // deadline for one would be arming a timer on the way out.
    "error",
    "resume_failed",
    // Server-originated turn injection; not part of any bracket.
    "tug_notice",
  ]);

  it("classifies every type the deck accepts", () => {
    const unclassified = [...KNOWN_CODE_OUTPUT_TYPES].filter(
      (t) => !BRACKET_FRAME_TYPES.has(t) && !EXCLUDED.has(t),
    );
    expect(unclassified).toEqual([]);
  });

  it("classifies each type exactly once", () => {
    const both = [...KNOWN_CODE_OUTPUT_TYPES].filter(
      (t) => BRACKET_FRAME_TYPES.has(t) && EXCLUDED.has(t),
    );
    expect(both).toEqual([]);
  });

  it("covers every frame the replay translator emits", () => {
    // Sourced from `tugcode/src/replay.ts` — the frames a bracket is
    // actually made of. Any of these missing from the set would mean a
    // healthy replay could be cut off by the silence deadline.
    const REPLAY_EMITTED = [
      "replay_started",
      "replay_complete",
      "replay_stage",
      "add_user_message",
      "assistant_opener",
      "wake_started",
      "content_block_start",
      "assistant_text",
      "thinking_text",
      "tool_use",
      "tool_result",
      "tool_use_structured",
      "system_metadata",
      "turn_complete",
      "compact_boundary",
      "compact_summary",
    ];
    for (const type of REPLAY_EMITTED) {
      expect(BRACKET_FRAME_TYPES.has(type)).toBe(true);
    }
  });

  it("admits only the transport envelope from outside the accepted set", () => {
    // `replay_batch` is unwrapped by `routeFrame` and never reaches the
    // reducer, so it is the one member with no `KNOWN_CODE_OUTPUT_TYPES`
    // entry. Anything else here would be a member that can never match.
    const orphans = [...BRACKET_FRAME_TYPES].filter(
      (t) => !KNOWN_CODE_OUTPUT_TYPES.has(t),
    );
    expect(orphans).toEqual(["replay_batch"]);
  });
});

describe("CodeSessionStore — replay silence deadline", () => {
  const gateSignals = (store: CodeSessionStore) => {
    const snap = store.getSnapshot();
    return {
      phase: snap.phase,
      sessionMode: snap.sessionMode,
      replayPreflightActive: snap.replayPreflightActive,
      lastError: snap.lastError,
    };
  };

  it("a bracket that opens and then hears nothing errors the card and drops it out of the restore gate", () => {
    const { store, conn, timers } = makeStore();
    emit(conn, replayStarted());
    expect(deriveColdRestoreActive(gateSignals(store))).toBe(true);

    timers.advance(REPLAY_SILENCE_DEADLINE_MS - 1);
    expect(store.getSnapshot().phase).toBe("replaying");
    expect(deriveColdRestoreActive(gateSignals(store))).toBe(true);

    timers.advance(1);
    const snap = store.getSnapshot();
    expect(snap.phase).toBe("errored");
    expect(snap.lastError?.cause).toBe("replay_stalled");
    expect(snap.lastError?.message).toBe(REPLAY_STALLED_MESSAGE);
    expect(snap.replaySoftBudgetElapsed).toBe(false);
    expect(deriveColdRestoreActive(gateSignals(store))).toBe(false);
    // Nothing is left running on the abandoned bracket.
    expect(timers.pendingCount()).toBe(0);
  });

  it("measures silence, not duration: every frame ingested restarts it", () => {
    const { store, conn, timers } = makeStore();
    emit(conn, replayStarted());
    // Three times the deadline in total, never a full deadline of quiet.
    for (let i = 0; i < 6; i += 1) {
      timers.advance(REPLAY_SILENCE_DEADLINE_MS / 2);
      emit(conn, {
        type: "add_user_message",
        text: `turn ${i}`,
        ipc_version: IPC_VERSION,
      });
      expect(store.getSnapshot().phase).toBe("replaying");
    }
    // …and then the frames stop.
    timers.advance(REPLAY_SILENCE_DEADLINE_MS);
    expect(store.getSnapshot().lastError?.cause).toBe("replay_stalled");
  });

  it("the soft-budget tick inside the bracket does not buy more time", () => {
    const { store, conn, timers } = makeStore();
    emit(conn, replayStarted());
    timers.advance(REPLAY_SOFT_BUDGET_MS);
    expect(store.getSnapshot().replaySoftBudgetElapsed).toBe(true);
    timers.advance(REPLAY_SILENCE_DEADLINE_MS - REPLAY_SOFT_BUDGET_MS);
    expect(store.getSnapshot().lastError?.cause).toBe("replay_stalled");
  });

  it("replay_complete disarms it", () => {
    const { store, conn, timers } = makeStore();
    emit(conn, replayStarted());
    emit(conn, replayComplete(0));
    expect(timers.pendingCount()).toBe(0);
    timers.advance(REPLAY_SILENCE_DEADLINE_MS * 2);
    expect(store.getSnapshot().phase).toBe("idle");
    expect(store.getSnapshot().lastError).toBeNull();
  });
});
