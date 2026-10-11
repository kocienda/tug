/**
 * Regression: a replayed `turn_complete` carrying the JSONL-authoritative
 * `telemetry.cost` (+ `sessionInitTokens`) must commit onto the published
 * snapshot's `transcript[].cost`, restore `sessionInitTokens`, and yield a
 * non-zero CONTEXT-used window — the Z2 readouts that previously zeroed
 * out after restore/HMR when the `turn_telemetry` side-table was empty.
 *
 * Driven through the REAL store + reducer via the wire-frame channel (the
 * sanctioned pattern — no mock store, no hand-rolled core interface). The
 * reducer needs no change for this: it already adopts `event.telemetry`
 * via `mergeTurnTelemetry` and restores `sessionInitTokens` on resume.
 * This pins that end-to-end behavior at the snapshot boundary.
 */

import { describe, it, expect } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";
import {
  deriveContextWindows,
  turnWindowTokens,
} from "@/lib/code-session-store/end-state";

const TUG = FIXTURE_IDS.TUG_SESSION_ID;
const SESSION_INIT_TOKENS = 4_130;

function makeStore(): { store: CodeSessionStore; conn: TestFrameChannel } {
  const conn = new TestFrameChannel();
  const store = new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: TUG,
    sessionMode: "resume",
  });
  return { store, conn };
}

function emit(conn: TestFrameChannel, evt: Record<string, unknown>): void {
  conn.dispatchDecoded(FeedId.CODE_OUTPUT, { ...evt, tug_session_id: TUG });
}

/** A replayed turn whose `turn_complete` carries inline JSONL telemetry. */
function emitTurnWithCost(
  conn: TestFrameChannel,
  n: number,
  cost: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  },
): void {
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
    telemetry: {
      cost: { ...cost, totalCostUsd: 0 },
      wallClockMs: 0,
      awaitingApprovalMs: 0,
      transportDowntimeMs: 0,
      activeMs: 0,
      ttftMs: null,
      ttftcMs: null,
      reconnectCount: 0,
      maxStreamGapMs: 0,
      sessionInitTokens: SESSION_INIT_TOKENS,
      turnEndReason: "complete",
    },
  });
}

describe("replayed turn cost — lands on the published snapshot", () => {
  it("commits telemetry.cost onto transcript[].cost and restores sessionInitTokens", () => {
    const { store, conn } = makeStore();
    const cost = {
      inputTokens: 100,
      outputTokens: 200,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 4_000,
    };

    emit(conn, { type: "replay_started" });
    emitTurnWithCost(conn, 1, cost);
    emit(conn, { type: "replay_complete", count: 1 });

    const snap = store.getSnapshot();
    expect(snap.transcript).toHaveLength(1);
    expect(snap.transcript[0].cost).toEqual({ ...cost, totalCostUsd: 0 });
    // sessionInitTokens restored from the first replayed turn's telemetry.
    expect(snap.sessionInitTokens).toBe(SESSION_INIT_TOKENS);
  });

  it("yields a non-zero CONTEXT-used window from the replayed costs", () => {
    const { store, conn } = makeStore();
    const t1 = {
      inputTokens: 100,
      outputTokens: 200,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 4_000,
    };
    const t2 = {
      inputTokens: 2,
      outputTokens: 2_342,
      cacheCreationInputTokens: 995,
      cacheReadInputTokens: 121_167,
    };

    emit(conn, { type: "replay_started" });
    emitTurnWithCost(conn, 1, t1);
    emitTurnWithCost(conn, 2, t2);
    emit(conn, { type: "replay_complete", count: 2 });

    const snap = store.getSnapshot();
    expect(snap.transcript).toHaveLength(2);

    // CONTEXT used = window(latest), absolute — the Z2 readout. This was
    // 0 before the fix (no cost on replayed turns).
    const steps = deriveContextWindows(
      snap.transcript.map((t) => t.cost),
      snap.sessionInitTokens ?? 0,
    );
    const latest = steps[steps.length - 1];
    expect(latest.window).toBe(turnWindowTokens(t2));
    expect(latest.window).toBeGreaterThan(0);
    // turn-1 TOKENS delta = window(1) - sessionInit ≈ output (input-baseline
    // derivation): 4330 - 4130 = 200.
    expect(steps[0].perTurn).toBe(turnWindowTokens(t1) - SESSION_INIT_TOKENS);
  });
});
