/**
 * Reducer tests for the live-vs-replay branch in `handleTurnComplete`
 * (plan `#step-20-3-4`).
 *
 * Two paths funnel through `handleTurnComplete`:
 *   - **Live** — `event.telemetry === undefined`. The reducer derives
 *     the per-turn telemetry block from in-memory clock anchors + cost
 *     snapshots (`deriveTurnTelemetry`) and emits a `record-telemetry`
 *     effect so the supervisor persists it to the SessionLedger.
 *   - **Replay** — `event.telemetry !== undefined`. The supervisor
 *     attached the persisted block onto the replayed `turn_complete`
 *     before forwarding; the reducer adopts it verbatim
 *     (`mergeTurnTelemetry` prefers `inline`) AND does not re-persist
 *     (the row already exists, which is how the inline made it onto
 *     the wire in the first place).
 *
 * These tests pin both paths at the reducer boundary — no store, no
 * wire, no mocks.
 */

import { describe, it, expect } from "bun:test";

import {
  reduce,
  createInitialState,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import type {
  AppendTranscriptEffect,
  Effect,
  RecordTelemetryEffect,
} from "@/lib/code-session-store/effects";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import type { TurnTelemetry } from "@/lib/code-session-store/telemetry";

/** The wall-clock a replayed JSONL entry carries, held fixed across a turn. */
const REPLAYED_AT = 1_750_000_000_000;

function fresh(): CodeSessionState {
  return createInitialState(FIXTURE_IDS.TUG_SESSION_ID, "test", "new");
}

function applyAll(
  state: CodeSessionState,
  events: ReadonlyArray<CodeSessionEvent>,
): { state: CodeSessionState; effects: Effect[] } {
  let current = state;
  const collected: Effect[] = [];
  for (const ev of events) {
    const r = reduce(current, ev);
    current = r.state;
    collected.push(...r.effects);
  }
  return { state: current, effects: collected };
}

function appended(effects: ReadonlyArray<Effect>): AppendTranscriptEffect[] {
  return effects.filter(
    (e): e is AppendTranscriptEffect => e.kind === "append-transcript",
  );
}

function recordTelemetryEffects(
  effects: ReadonlyArray<Effect>,
): RecordTelemetryEffect[] {
  return effects.filter(
    (e): e is RecordTelemetryEffect => e.kind === "record-telemetry",
  );
}

const SAMPLE_INLINE_TELEMETRY: TurnTelemetry = {
  cost: {
    inputTokens: 999,
    outputTokens: 888,
    cacheCreationInputTokens: 77,
    cacheReadInputTokens: 66,
    totalCostUsd: 0.12345,
  },
  wallClockMs: 12_345,
  awaitingApprovalMs: 1_234,
  transportDowntimeMs: 234,
  activeMs: 10_877,
  ttftMs: 250,
  ttftcMs: 600,
  reconnectCount: 1,
  maxStreamGapMs: 99,
  sessionInitTokens: 18_575,
};

describe("handleTurnComplete — live path", () => {
  it("derives telemetry from reducer state and emits a record-telemetry effect", () => {
    const initial = fresh();
    const { state, effects } = applyAll(initial, [
      { type: "send", text: "hello", atoms: [], content: [{ type: "text" as const, text: "hello" }], turnKey: "tk1" },
      {
        type: "assistant_text",
        msg_id: "msg-A",
      block_index: 0,
      text: "hi",
        is_partial: false,
        rev: 0,
        seq: 0,
      },
      {
        type: "cost_update",
        total_cost_usd: 0.05,
        num_turns: 1,
        duration_ms: 1_000,
        duration_api_ms: 800,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 20,
        },
      },
      { type: "turn_complete", msg_id: "msg-A", result: "success" },
    ]);

    // Live commit appended one TurnEntry with derived telemetry.
    const turns = appended(effects);
    expect(turns).toHaveLength(1);
    expect(turns[0].entry.cost.totalCostUsd).toBe(0.05);
    expect(turns[0].entry.cost.inputTokens).toBe(100);

    // ...and emitted a `record-telemetry` effect carrying the same block.
    const persists = recordTelemetryEffects(effects);
    expect(persists).toHaveLength(1);
    expect(persists[0].msgId).toBe("msg-A");
    expect(persists[0].telemetry.cost.totalCostUsd).toBe(0.05);
    expect(persists[0].telemetry.cost.inputTokens).toBe(100);
    expect(persists[0].endedAt).toBe(turns[0].entry.endedAt);

    // State settles into `idle`.
    expect(state.phase).toBe("idle");
  });

  it("persists interrupted turns too (telemetry block has real timing intervals even when cost is zero)", () => {
    const initial = fresh();
    const { effects } = applyAll(initial, [
      { type: "send", text: "ask", atoms: [], content: [{ type: "text" as const, text: "ask" }], turnKey: "tk1" },
      // No cost_update — turn ends without one.
      { type: "turn_complete", msg_id: "msg-A", result: "error" },
    ]);

    const persists = recordTelemetryEffects(effects);
    expect(persists).toHaveLength(1);
    expect(persists[0].msgId).toBe("msg-A");
    expect(persists[0].telemetry.cost.totalCostUsd).toBe(0);
    expect(persists[0].telemetry.cost.inputTokens).toBe(0);
  });
});

describe("handleTurnComplete — replay path", () => {
  it("adopts inline telemetry verbatim and does NOT emit a record-telemetry effect", () => {
    // Drive the reducer into `replaying` phase via the bracket open;
    // this is the surface where the wire delivers inlined telemetry.
    const initial = fresh();
    const { state: afterReplayStarted } = applyAll(initial, [
      { type: "replay_started" },
    ]);
    expect(afterReplayStarted.phase).toBe("replaying");

    const { state, effects } = applyAll(afterReplayStarted, [
      {
        type: "add_user_message",
        // No `msg_id` per [D15] — the reducer's `activeMsgId` is set
        // by the first content event below, not pre-bound by this
        // opener per [D14].
        text: "old turn",
        atoms: [],
        turnKey: "tk-replay",
      },
      {
        type: "assistant_text",
        msg_id: "msg-replay-A",
      block_index: 0,
      text: "old response",
        is_partial: false,
        rev: 0,
        seq: 0,
      },
      {
        type: "turn_complete",
        msg_id: "msg-replay-A",
        result: "success",
        telemetry: SAMPLE_INLINE_TELEMETRY,
      },
    ]);

    // The replayed commit lands a TurnEntry whose telemetry block is
    // byte-identical to the inline payload — the merge prefers inline.
    const turns = appended(effects);
    expect(turns).toHaveLength(1);
    expect(turns[0].entry.msgId).toBe("msg-replay-A");
    expect(turns[0].entry.cost).toEqual(SAMPLE_INLINE_TELEMETRY.cost);
    expect(turns[0].entry.wallClockMs).toBe(SAMPLE_INLINE_TELEMETRY.wallClockMs);
    expect(turns[0].entry.awaitingApprovalMs).toBe(
      SAMPLE_INLINE_TELEMETRY.awaitingApprovalMs,
    );
    expect(turns[0].entry.transportDowntimeMs).toBe(
      SAMPLE_INLINE_TELEMETRY.transportDowntimeMs,
    );
    expect(turns[0].entry.activeMs).toBe(SAMPLE_INLINE_TELEMETRY.activeMs);
    expect(turns[0].entry.ttftMs).toBe(SAMPLE_INLINE_TELEMETRY.ttftMs);
    expect(turns[0].entry.ttftcMs).toBe(SAMPLE_INLINE_TELEMETRY.ttftcMs);
    expect(turns[0].entry.reconnectCount).toBe(
      SAMPLE_INLINE_TELEMETRY.reconnectCount,
    );
    expect(turns[0].entry.maxStreamGapMs).toBe(
      SAMPLE_INLINE_TELEMETRY.maxStreamGapMs,
    );

    // No record-telemetry effect — the row already exists in the
    // SessionLedger (that's how the inline got onto the wire).
    expect(recordTelemetryEffects(effects)).toHaveLength(0);

    // Phase stays `replaying`; only `replay_complete` returns it to
    // `idle`. The replaying branch is the canonical replay path.
    expect(state.phase).toBe("replaying");
  });

  it("falls back to zero-derived telemetry when wire omits inline (no persisted row)", () => {
    // This is the "no retroactive backfill" caveat: a turn that
    // committed before the persistence feature shipped (or whose row
    // was forgotten) replays without an inline telemetry block. The
    // reducer derives the block from state — but during replay the
    // reducer's clock anchors and lastCost are null/zero, so the
    // derived block reads zero. Correct behavior, no crash, no
    // fabricated value.
    const initial = fresh();
    const { state: afterReplayStarted } = applyAll(initial, [
      { type: "replay_started" },
    ]);

    const { effects } = applyAll(afterReplayStarted, [
      {
        type: "add_user_message",
        // No `msg_id` per [D15]. This turn has no content event, so
        // `activeMsgId` stays `null` — `handleTurnComplete`'s
        // no-content fallback (#spec-reducer-state rule 2) commits
        // `pendingTurn` regardless of the turn_complete's msg_id.
        text: "pre-persistence turn",
        atoms: [],
        turnKey: "tk-old",
        // Both events carry the replay path's own wall-clock stamp, the way
        // the supervisor emits them from JSONL. Without it each event reads
        // `Date.now()` independently and `wallClockMs` is `0` only when the
        // two reads land in the same millisecond.
        timestamp: REPLAYED_AT,
      },
      {
        type: "turn_complete",
        msg_id: "msg-old",
        result: "success",
        timestamp: REPLAYED_AT,
        // No `telemetry` field — pre-feature turn or evicted row.
      },
    ]);

    const turns = appended(effects);
    expect(turns).toHaveLength(1);
    expect(turns[0].entry.cost.totalCostUsd).toBe(0);
    expect(turns[0].entry.cost.inputTokens).toBe(0);
    expect(turns[0].entry.wallClockMs).toBe(0);
    expect(turns[0].entry.activeMs).toBe(0);
    expect(turns[0].entry.ttftMs).toBeNull();

    // Replay branch — no persistence effect dispatched.
    expect(recordTelemetryEffects(effects)).toHaveLength(0);
  });
});

describe("handleTurnComplete — [replay-2] terminal-reason recovery", () => {
  it("recovers `interrupted` from the inline block when replay re-derivation would say `error`", () => {
    // A turn the user interrupted commits on the wire as
    // `result: "error"` (CASE B). On the live path `interruptInFlight`
    // distinguishes it from a genuine protocol error; on the replay
    // path that flag never ran, so the re-derivation alone would
    // mislabel the turn `error`. The persisted telemetry block carries
    // the original `turnEndReason` and `buildTurnEntry` prefers it.
    const initial = fresh();
    const { state: afterReplayStarted } = applyAll(initial, [
      { type: "replay_started" },
    ]);

    const { effects } = applyAll(afterReplayStarted, [
      {
        type: "add_user_message",
        // No `msg_id` per [D15] — no-content fallback commits
        // `pendingTurn` via #spec-reducer-state rule 2.
        text: "interrupted turn",
        atoms: [],
        turnKey: "tk-int",
      },
      {
        type: "turn_complete",
        msg_id: "msg-int",
        result: "error",
        telemetry: { ...SAMPLE_INLINE_TELEMETRY, turnEndReason: "interrupted" },
      },
    ]);

    const turns = appended(effects);
    expect(turns).toHaveLength(1);
    // The persisted reason wins over the `error` re-derivation.
    expect(turns[0].entry.turnEndReason).toBe("interrupted");
    expect(turns[0].entry.result).toBe("interrupted");
  });

  it("falls back to the re-derived reason when the inline block omits `turnEndReason`", () => {
    // A telemetry row persisted before the field existed: the inline
    // block has no `turnEndReason`, so the freshly-derived reason
    // stands. During replay `interruptInFlight` is false, so a
    // `result: "error"` turn derives `error`.
    const initial = fresh();
    const { state: afterReplayStarted } = applyAll(initial, [
      { type: "replay_started" },
    ]);

    const { effects } = applyAll(afterReplayStarted, [
      {
        type: "add_user_message",
        // No `msg_id` per [D15] — no-content fallback commits
        // `pendingTurn` via #spec-reducer-state rule 2.
        text: "pre-field turn",
        atoms: [],
        turnKey: "tk-pre",
      },
      {
        type: "turn_complete",
        msg_id: "msg-pre",
        result: "error",
        telemetry: SAMPLE_INLINE_TELEMETRY,
      },
    ]);

    const turns = appended(effects);
    expect(turns).toHaveLength(1);
    expect(turns[0].entry.turnEndReason).toBe("error");
  });

  it("live path persists the derived `turnEndReason` on the record-telemetry effect", () => {
    // The live commit's record-telemetry effect must carry the
    // terminal reason so the NEXT resume can recover it.
    const initial = fresh();
    const { effects } = applyAll(initial, [
      { type: "send", text: "hello", atoms: [], content: [{ type: "text" as const, text: "hello" }], turnKey: "tk1" },
      {
        type: "assistant_text",
        msg_id: "msg-A",
      block_index: 0,
      text: "hi",
        is_partial: false,
        rev: 0,
        seq: 0,
      },
      { type: "turn_complete", msg_id: "msg-A", result: "success" },
    ]);

    const persists = recordTelemetryEffects(effects);
    expect(persists).toHaveLength(1);
    expect(persists[0].telemetry.turnEndReason).toBe("complete");
  });
});
