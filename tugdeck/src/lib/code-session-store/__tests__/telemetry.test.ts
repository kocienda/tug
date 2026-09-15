/**
 * Pure-logic tests for `telemetry.ts` — `perTurnContextSize`,
 * `extractTurnCost`, `deriveSessionTotals`, and the `liveTurn*`
 * family. No reducer, no React.
 */

import { describe, it, expect } from "bun:test";

import {
  perTurnContextSize,
  extractTurnCost,
  deriveSessionTotals,
  liveTurnWallClockMs,
  liveTurnAwaitingApprovalMs,
  liveTurnTransportDowntimeMs,
  liveTurnActiveMs,
  unionPauseMs,
  deriveInflightActiveMs,
  deriveJobExtendedActiveMs,
  deriveTimeCellMs,
  computeTimeSummary,
  computeRichContextBreakdown,
  isCompactionLowEffect,
  turnHasTiming,
  type PauseSegment,
} from "@/lib/code-session-store/telemetry";
import { LOCAL_SLASH_COMMANDS } from "@/lib/slash-commands";
import { deriveContextWindows } from "@/lib/code-session-store/end-state";
import {
  createInitialState,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type {
  CodeSessionSnapshot,
  CostSnapshot,
  TurnEntry,
} from "@/lib/code-session-store/types";
import { TURN_ENTRY_TELEMETRY_DEFAULTS } from "@/lib/code-session-store/testing/turn-entry-defaults";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";

function fresh(): CodeSessionState {
  return createInitialState(FIXTURE_IDS.TUG_SESSION_ID, "test", "new");
}

function turn(overrides: Partial<TurnEntry>): TurnEntry {
  return {
    turnKey: "k",
    msgId: "m",
    messages: [],
    result: "success",
    endedAt: 0,
    ...TURN_ENTRY_TELEMETRY_DEFAULTS,
    ...overrides,
  };
}

function costSnap(overrides: Partial<CostSnapshot> = {}): CostSnapshot {
  return {
    totalCostUsd: 0,
    numTurns: null,
    durationMs: null,
    durationApiMs: null,
    usage: null,
    modelUsage: null,
    ...overrides,
  };
}

describe("telemetry — perTurnContextSize", () => {
  it("sums input + cache_read + cache_creation (NOT output)", () => {
    const t = turn({
      cost: {
        inputTokens: 100,
        outputTokens: 5_000,
        cacheReadInputTokens: 12_000,
        cacheCreationInputTokens: 6_000,
        totalCostUsd: 0,
      },
    });
    expect(perTurnContextSize(t)).toBe(18_100);
  });
});

describe("telemetry — extractTurnCost", () => {
  it("returns zeros when `after` is null", () => {
    expect(extractTurnCost(null, null)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalCostUsd: 0,
    });
  });

  it("returns `after` directly when `before` is null", () => {
    const after = costSnap({
      totalCostUsd: 0.05,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 40,
      },
    });
    expect(extractTurnCost(null, after)).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 40,
      totalCostUsd: 0.05,
    });
  });

  it("token fields pass through raw — `usage` is per-turn, not subtracted", () => {
    // `cost_update.usage` reports each turn's own usage; the four
    // token fields are taken straight from `after`, never differenced
    // against `before`. Only `totalCostUsd` is cumulative.
    const before = costSnap({
      totalCostUsd: 0.045,
      usage: {
        input_tokens: 3,
        output_tokens: 10,
        cache_creation_input_tokens: 6_180,
        cache_read_input_tokens: 12_507,
      },
    });
    const after = costSnap({
      totalCostUsd: 0.06,
      usage: {
        input_tokens: 4,
        output_tokens: 180,
        cache_creation_input_tokens: 6_349,
        cache_read_input_tokens: 31_204,
      },
    });
    const cost = extractTurnCost(before, after);
    expect(cost.inputTokens).toBe(4);
    expect(cost.outputTokens).toBe(180);
    expect(cost.cacheCreationInputTokens).toBe(6_349);
    expect(cost.cacheReadInputTokens).toBe(31_204);
    // `total_cost_usd` IS cumulative — it alone is differenced.
    expect(cost.totalCostUsd).toBeCloseTo(0.06 - 0.045);
  });

  it("a short turn after a long one keeps its real (small) token counts", () => {
    // Regression pin: the old `after - before` subtraction clamped a
    // short reply following a long turn to zero tokens. Token fields
    // are now raw, so the short turn reports its true usage.
    const longTurn = costSnap({
      totalCostUsd: 0.146,
      usage: {
        input_tokens: 4,
        output_tokens: 408,
        cache_creation_input_tokens: 9_901,
        cache_read_input_tokens: 33_281,
      },
    });
    const shortTurn = costSnap({
      totalCostUsd: 0.178,
      usage: {
        input_tokens: 4,
        output_tokens: 161,
        cache_creation_input_tokens: 402,
        cache_read_input_tokens: 50_200,
      },
    });
    const cost = extractTurnCost(longTurn, shortTurn);
    expect(cost.inputTokens).toBe(4);
    expect(cost.outputTokens).toBe(161);
    expect(cost.cacheCreationInputTokens).toBe(402);
    expect(cost.cacheReadInputTokens).toBe(50_200);
  });

  it("clamps totalCostUsd when cumulative cost goes non-monotonic", () => {
    const before = costSnap({ totalCostUsd: 1.0, usage: {} });
    const after = costSnap({ totalCostUsd: 0.5, usage: {} });
    expect(extractTurnCost(before, after).totalCostUsd).toBe(0);
  });
});

describe("telemetry — deriveSessionTotals", () => {
  it("sums per-turn fields across a multi-turn transcript", () => {
    const transcript: TurnEntry[] = [
      turn({
        wallClockMs: 1000,
        awaitingApprovalMs: 100,
        transportDowntimeMs: 50,
        activeMs: 850,
        cost: {
          inputTokens: 3,
          outputTokens: 10,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 40,
          totalCostUsd: 0.045,
        },
      }),
      turn({
        wallClockMs: 2000,
        awaitingApprovalMs: 0,
        transportDowntimeMs: 0,
        activeMs: 2000,
        cost: {
          inputTokens: 4,
          outputTokens: 180,
          cacheReadInputTokens: 60,
          cacheCreationInputTokens: 80,
          totalCostUsd: 0.015,
        },
      }),
    ];
    const totals = deriveSessionTotals(transcript);
    expect(totals.totalWallClockMs).toBe(3000);
    expect(totals.totalAwaitingApprovalMs).toBe(100);
    expect(totals.totalTransportDowntimeMs).toBe(50);
    expect(totals.totalActiveMs).toBe(2850);
    expect(totals.totalInputTokens).toBe(7);
    expect(totals.totalOutputTokens).toBe(190);
    expect(totals.totalCacheReadTokens).toBe(80);
    expect(totals.totalCacheCreationTokens).toBe(120);
    expect(totals.totalCostUsd).toBeCloseTo(0.06);
    expect(totals.turnCount).toBe(2);
  });

  it("zero turns produces zero totals", () => {
    const totals = deriveSessionTotals([]);
    expect(totals).toEqual({
      totalWallClockMs: 0,
      totalAwaitingApprovalMs: 0,
      totalTransportDowntimeMs: 0,
      totalActiveMs: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      totalCostUsd: 0,
      turnCount: 0,
    });
  });
});

describe("telemetry — liveTurn* helpers", () => {
  it("liveTurnWallClockMs returns 0 when no turn is in flight", () => {
    expect(liveTurnWallClockMs(fresh(), 1_000_000)).toBe(0);
  });

  it("liveTurnWallClockMs returns `now - submitAt` when a turn is in flight", () => {
    const state: CodeSessionState = {
      ...fresh(),
      pendingTurn: {
        turnKey: "k",
        submitAt: 1_000_000,
        origin: "user",
      },
    };
    expect(liveTurnWallClockMs(state, 1_001_500)).toBe(1_500);
  });

  it("liveTurnAwaitingApprovalMs folds the in-progress interval into the accumulator", () => {
    const state: CodeSessionState = {
      ...fresh(),
      awaitingApprovalAccumulatedMs: 500,
      awaitingApprovalSince: 1_000_000,
    };
    expect(liveTurnAwaitingApprovalMs(state, 1_000_750)).toBe(1_250);
  });

  it("liveTurnTransportDowntimeMs folds the in-progress non-online interval", () => {
    const state: CodeSessionState = {
      ...fresh(),
      transportDowntimeAccumulatedMs: 100,
      transportNonOnlineSince: 1_000_000,
    };
    expect(liveTurnTransportDowntimeMs(state, 1_000_300)).toBe(400);
  });

  it("liveTurnActiveMs = wall - awaiting - downtime, clamped ≥ 0", () => {
    const state: CodeSessionState = {
      ...fresh(),
      pendingTurn: {
        turnKey: "k",
        submitAt: 1_000_000,
        origin: "user",
      },
      awaitingApprovalAccumulatedMs: 200,
      awaitingApprovalSince: null,
      transportDowntimeAccumulatedMs: 100,
      transportNonOnlineSince: null,
    };
    // wall = 1000, awaiting = 200, downtime = 100 → active = 700
    expect(liveTurnActiveMs(state, 1_001_000)).toBe(700);
  });
});

// ---------------------------------------------------------------------------
// Overlap-correct live in-flight derivation — `unionPauseMs` +
// `deriveInflightActiveMs`. The headline regression this guards is
// the over-subtraction bug that scalar-sum derivations fall into
// whenever two pause axes overlap.
// ---------------------------------------------------------------------------

describe("unionPauseMs", () => {
  it("returns 0 for zero segments", () => {
    expect(unionPauseMs([], 1_000, 2_000)).toBe(0);
  });

  it("returns 0 for a degenerate window (end <= start)", () => {
    expect(unionPauseMs([[1_500, 1_800]], 2_000, 2_000)).toBe(0);
    expect(unionPauseMs([[1_500, 1_800]], 2_000, 1_900)).toBe(0);
  });

  it("treats an open segment ([start, null]) as ending at the window end", () => {
    const segments: PauseSegment[] = [[1_500, null]];
    expect(unionPauseMs(segments, 1_000, 2_000)).toBe(500);
  });

  it("sums two non-overlapping closed segments", () => {
    const segments: PauseSegment[] = [
      [1_100, 1_300],
      [1_500, 1_900],
    ];
    expect(unionPauseMs(segments, 1_000, 2_000)).toBe(200 + 400);
  });

  it("unions two overlapping closed segments (NOT their sum)", () => {
    const segments: PauseSegment[] = [
      [1_100, 1_500],
      [1_300, 1_700],
    ];
    // Naive sum would be 400 + 400 = 800. Union is [1_100, 1_700] = 600.
    expect(unionPauseMs(segments, 1_000, 2_000)).toBe(600);
  });

  it("unions three segments with pairwise overlap (A∩B, B∩C, A∩C)", () => {
    const segments: PauseSegment[] = [
      [1_100, 1_400], // A
      [1_300, 1_600], // B (overlaps A, overlaps C)
      [1_500, 1_700], // C (overlaps B; does not directly overlap A)
    ];
    // All three merge into [1_100, 1_700] = 600.
    // Naive sum would be 300 + 300 + 200 = 800.
    expect(unionPauseMs(segments, 1_000, 2_000)).toBe(600);
  });

  it("merges identical segments into a single contribution", () => {
    const segments: PauseSegment[] = [
      [1_200, 1_500],
      [1_200, 1_500],
    ];
    expect(unionPauseMs(segments, 1_000, 2_000)).toBe(300);
  });

  it("merges a segment fully contained within another into the outer", () => {
    const segments: PauseSegment[] = [
      [1_100, 1_900],
      [1_300, 1_500],
    ];
    expect(unionPauseMs(segments, 1_000, 2_000)).toBe(800);
  });

  it("clips a segment that starts before the window", () => {
    const segments: PauseSegment[] = [[500, 1_200]];
    expect(unionPauseMs(segments, 1_000, 2_000)).toBe(200);
  });

  it("clips a segment that ends after the window", () => {
    const segments: PauseSegment[] = [[1_800, 2_500]];
    expect(unionPauseMs(segments, 1_000, 2_000)).toBe(200);
  });

  it("clips a segment that straddles the entire window", () => {
    const segments: PauseSegment[] = [[500, 2_500]];
    expect(unionPauseMs(segments, 1_000, 2_000)).toBe(1_000);
  });

  it("drops a segment fully outside the window", () => {
    const segments: PauseSegment[] = [
      [200, 500],
      [2_500, 3_000],
    ];
    expect(unionPauseMs(segments, 1_000, 2_000)).toBe(0);
  });

  it("clips an open segment whose start is before the window", () => {
    const segments: PauseSegment[] = [[500, null]];
    expect(unionPauseMs(segments, 1_000, 2_000)).toBe(1_000);
  });
});

describe("deriveInflightActiveMs", () => {
  /**
   * Minimal `CodeSessionSnapshot` builder for the live-derivation
   * helper. Only fields `deriveInflightActiveMs` reads are populated
   * meaningfully; everything else defaults to a quiescent shape that
   * passes the type check.
   */
  function snap(
    overrides: Partial<CodeSessionSnapshot> = {},
  ): CodeSessionSnapshot {
    return {
      phase: "streaming",
      transportState: "online",
      interruptInFlight: false,
      tugSessionId: "tug-1",
      displayLabel: "test",
      sessionMode: "new",
      restoreWindowTurns: 25,
      activeMsgId: "msg",
      canSubmit: false,
      canInterrupt: true,
      pendingApproval: null,
      pendingAsk: null,
      pendingQuestion: null,
      queuedSends: [],
      transcript: [],
      rewindPreviews: new Map(),
      lastRewindResult: null,
      activeTurn: null,
      pendingDraftRestore: null,
      pendingCommandInsert: null,
      pendingJotInsert: null,
      pendingAtomInsert: null,
      lastCost: null,
      apiRetry: null,
      refusalFallback: null,
      outputTruncated: false,
      unknownEvent: null,
      compactionSeed: null,
      permissionDenials: [],
    sessionInitTokens: null,
      lastContextBreakdown: null,
      lastError: null,
      lastReplayResult: null,
    replayEverCompleted: false,
    replayWindow: null,
    sessionCreatedAtMs: null,
    loadingPrevious: false,
    loadingPreviousTarget: 0,
    loadingPreviousLoaded: 0,
      replayPreflightActive: false,
      replaySoftBudgetElapsed: false,
      replayTimeoutDwellActive: false,
      awaitingApprovalIntervals: [],
      awaitingApprovalSegmentStartedAt: null,
      transportDowntimeIntervals: [],
      transportDowntimeSegmentStartedAt: null,
      interruptInFlightIntervals: [],
      interruptInFlightSegmentStartedAt: null,
      wakeTrigger: null,
      jobs: [],
      goal: null,
      ...overrides,
    };
  }

  function inflight(submitAt: number): CodeSessionSnapshot["activeTurn"] {
    return { turnKey: "k", submitAt, origin: "user", suppressed: false, messages: [] };
  }

  it("returns null when no turn is in flight", () => {
    expect(deriveInflightActiveMs(snap(), 1_002_000)).toBeNull();
  });

  it("returns wall-clock since submit when no pause segments exist", () => {
    const s = snap({ activeTurn: inflight(1_000_000) });
    expect(deriveInflightActiveMs(s, 1_001_500)).toBe(1_500);
  });

  it("returns 0 when now == submitAt (degenerate window)", () => {
    const s = snap({ activeTurn: inflight(1_000_000) });
    expect(deriveInflightActiveMs(s, 1_000_000)).toBe(0);
  });

  it("returns 0 when now < submitAt (clock skew)", () => {
    const s = snap({ activeTurn: inflight(1_000_000) });
    expect(deriveInflightActiveMs(s, 999_000)).toBe(0);
  });

  it("subtracts a single open awaiting-approval segment", () => {
    const s = snap({
      activeTurn: inflight(1_000_000),
      awaitingApprovalSegmentStartedAt: 1_000_300,
    });
    // wall = 1_000, open pause = (now - 1_000_300) = 700, active = 300
    expect(deriveInflightActiveMs(s, 1_001_000)).toBe(300);
  });

  it("subtracts a closed transport-downtime interval", () => {
    const s = snap({
      activeTurn: inflight(1_000_000),
      transportDowntimeIntervals: [[1_000_200, 1_000_500]],
    });
    // wall = 1_000, pause = 300, active = 700
    expect(deriveInflightActiveMs(s, 1_001_000)).toBe(700);
  });

  it("unions two yellow axes overlapping (NOT sum) — the regression this design guards", () => {
    const s = snap({
      activeTurn: inflight(1_000_000),
      // Awaiting-approval dialog open [200, 600]
      awaitingApprovalIntervals: [[1_000_200, 1_000_600]],
      // Transport restoring [400, 800] — overlaps awaiting in [400, 600]
      transportDowntimeIntervals: [[1_000_400, 1_000_800]],
    });
    // Naive scalar sum would subtract 400 + 400 = 800 → active = 200.
    // Correct union [200, 800] = 600 → active = 400.
    expect(deriveInflightActiveMs(s, 1_001_000)).toBe(400);
  });

  it("unions all three yellow axes when interrupt-in-flight overlaps both", () => {
    const s = snap({
      activeTurn: inflight(1_000_000),
      awaitingApprovalIntervals: [[1_000_100, 1_000_400]],
      transportDowntimeIntervals: [[1_000_300, 1_000_700]],
      interruptInFlightSegmentStartedAt: 1_000_500,
    });
    // Now = 1_001_000. Open interrupt = [500, 1000]. Awaiting = [100, 400].
    // Transport = [300, 700]. Union = [100, 400] ∪ [300, 1000] = [100, 1000] = 900.
    // active = 1000 - 900 = 100.
    expect(deriveInflightActiveMs(s, 1_001_000)).toBe(100);
  });

  it("clamps to 0 when the union of pauses covers the entire wall-clock", () => {
    const s = snap({
      activeTurn: inflight(1_000_000),
      // Pause covers more than wall-clock (clipped to window).
      awaitingApprovalIntervals: [[500_000, 2_000_000]],
    });
    expect(deriveInflightActiveMs(s, 1_001_000)).toBe(0);
  });

  it("clips a pause segment that began before submitAt to the in-flight window", () => {
    const s = snap({
      activeTurn: inflight(1_000_000),
      // Transport disconnect that began 200 ms before submit, closed 300 ms after.
      transportDowntimeIntervals: [[999_800, 1_000_300]],
    });
    // Window = [1_000_000, 1_001_000]. Clipped interval = [1_000_000, 1_000_300] = 300.
    // active = 1_000 - 300 = 700.
    expect(deriveInflightActiveMs(s, 1_001_000)).toBe(700);
  });
});

describe("deriveTimeCellMs", () => {
  function snap(
    overrides: Partial<CodeSessionSnapshot> = {},
  ): CodeSessionSnapshot {
    return {
      phase: "streaming",
      transportState: "online",
      interruptInFlight: false,
      tugSessionId: "tug-1",
      displayLabel: "test",
      sessionMode: "new",
      restoreWindowTurns: 25,
      activeMsgId: "msg",
      canSubmit: false,
      canInterrupt: true,
      pendingApproval: null,
      pendingAsk: null,
      pendingQuestion: null,
      queuedSends: [],
      transcript: [],
      rewindPreviews: new Map(),
      lastRewindResult: null,
      activeTurn: null,
      pendingDraftRestore: null,
      pendingCommandInsert: null,
      pendingJotInsert: null,
      pendingAtomInsert: null,
      lastCost: null,
      apiRetry: null,
      refusalFallback: null,
      outputTruncated: false,
      unknownEvent: null,
      compactionSeed: null,
      permissionDenials: [],
    sessionInitTokens: null,
      lastContextBreakdown: null,
      lastError: null,
      lastReplayResult: null,
    replayEverCompleted: false,
    replayWindow: null,
    sessionCreatedAtMs: null,
    loadingPrevious: false,
    loadingPreviousTarget: 0,
    loadingPreviousLoaded: 0,
      replayPreflightActive: false,
      replaySoftBudgetElapsed: false,
      replayTimeoutDwellActive: false,
      awaitingApprovalIntervals: [],
      awaitingApprovalSegmentStartedAt: null,
      transportDowntimeIntervals: [],
      transportDowntimeSegmentStartedAt: null,
      interruptInFlightIntervals: [],
      interruptInFlightSegmentStartedAt: null,
      wakeTrigger: null,
      jobs: [],
      goal: null,
      ...overrides,
    };
  }
  function inflight(submitAt: number): CodeSessionSnapshot["activeTurn"] {
    return { turnKey: "k", submitAt, origin: "user", suppressed: false, messages: [] };
  }

  it("falls back to the post-commit value when no turn is in flight", () => {
    // Idle / post-commit: derivation returns null; helper returns the
    // fallback (typically the just-committed TurnEntry.activeMs).
    expect(deriveTimeCellMs(snap(), 1_001_000, 4_200)).toBe(4_200);
  });

  it("returns 0 fallback for a never-submitted card", () => {
    expect(deriveTimeCellMs(snap(), 1_001_000, 0)).toBe(0);
  });

  it("returns the live in-flight active duration when a turn is in flight", () => {
    const s = snap({ activeTurn: inflight(1_000_000) });
    // No pause segments, wall = 1_500. Live derivation wins over fallback.
    expect(deriveTimeCellMs(s, 1_001_500, 999_999)).toBe(1_500);
  });

  it("subtracts overlapping yellow axes (NOT scalar sum) when in flight", () => {
    const s = snap({
      activeTurn: inflight(1_000_000),
      awaitingApprovalIntervals: [[1_000_200, 1_000_600]],
      transportDowntimeIntervals: [[1_000_400, 1_000_800]],
    });
    // Union [200, 800] = 600; wall = 1_000; active = 400.
    expect(deriveTimeCellMs(s, 1_001_000, 999_999)).toBe(400);
  });

  it("uses the fallback the moment the snapshot's in-flight slot clears (turn-complete freeze)", () => {
    // Simulate a freshly-committed turn: snapshot's activeTurn
    // is null, and the caller passes the just-committed activeMs as
    // the fallback. The cell should freeze at that committed value
    // rather than ticking back to 0 or any other transient state.
    expect(deriveTimeCellMs(snap(), 1_001_000, 7_777)).toBe(7_777);
  });
});

describe("computeTimeSummary", () => {
  it("returns zeros for an empty transcript", () => {
    expect(computeTimeSummary([])).toEqual({
      count: 0,
      totalActiveMs: 0,
      avgActiveMs: 0,
    });
  });

  it("returns the single turn's activeMs as both total and average", () => {
    const result = computeTimeSummary([turn({ activeMs: 4_200 })]);
    expect(result).toEqual({
      count: 1,
      totalActiveMs: 4_200,
      avgActiveMs: 4_200,
    });
  });

  it("sums and averages across multiple committed turns", () => {
    const transcript = [
      turn({ activeMs: 1_000 }),
      turn({ activeMs: 3_000 }),
      turn({ activeMs: 5_000 }),
    ];
    expect(computeTimeSummary(transcript)).toEqual({
      count: 3,
      totalActiveMs: 9_000,
      avgActiveMs: 3_000,
    });
  });

  it("rounds the average to the nearest ms", () => {
    const transcript = [
      turn({ activeMs: 1_000 }),
      turn({ activeMs: 1_001 }),
      turn({ activeMs: 1_001 }),
    ];
    // total = 3_002, count = 3, avg = 1000.6667 → round → 1001
    expect(computeTimeSummary(transcript).avgActiveMs).toBe(1_001);
  });

  it("includes interrupted turns in the sum and count", () => {
    // The summary reflects all committed turns regardless of terminal
    // reason — interrupted turns are still committed transcript rows
    // and their accumulated activeMs is part of the session's total.
    const transcript = [
      turn({ activeMs: 2_000, result: "success" }),
      turn({ activeMs: 500, result: "interrupted" }),
    ];
    expect(computeTimeSummary(transcript)).toEqual({
      count: 2,
      totalActiveMs: 2_500,
      avgActiveMs: 1_250,
    });
  });
});

describe("computeRichContextBreakdown", () => {
  const CONTEXT_MAX = 1_000_000;

  // tugcode's static estimate: the five categories, summing to 15_500.
  const staticBreakdown = {
    contextMax: CONTEXT_MAX,
    categories: [
      { id: "system_prompt", label: "System prompt", tokens: 3_500 } as const,
      { id: "system_tools", label: "System tools", tokens: 7_300 } as const,
      { id: "custom_agents", label: "Custom agents", tokens: 800 } as const,
      { id: "memory_files", label: "Memory files", tokens: 2_600 } as const,
      { id: "skills", label: "Skills", tokens: 1_300 } as const,
    ],
  };
  const RAW_STATIC_TOTAL = 15_500;

  it("reconstructs a usage-derived breakdown when no static frame but usage exists", () => {
    // Fresh target / offline replay: no durable context_breakdown row, but the
    // replayed cost gives window + sessionInit. The popover must still populate
    // — a coarse baseline + messages + remainder — not stay empty.
    const r = computeRichContextBreakdown({
      staticBreakdown: null,
      sessionInitTokens: 18_575,
      windowTokens: 27_927,
      contextMax: CONTEXT_MAX,
    })!;
    expect(r).not.toBeNull();
    expect(r.totalUsed).toBe(27_927); // = windowTokens
    expect(r.contextMax).toBe(CONTEXT_MAX);
    const byId = Object.fromEntries(r.segments.map((s) => [s.id, s.value]));
    expect(byId.session_context).toBe(18_575); // the lumped baseline
    expect(byId.messages).toBe(27_927 - 18_575); // window − baseline
    expect(byId.remainder).toBe(CONTEXT_MAX - 27_927);
    // The reserved autocompact_buffer is NOT reconstructable without the row.
    expect(r.segments.some((s) => s.id === "autocompact_buffer")).toBe(false);
  });

  it("returns null when no static frame AND no usage yet (popover stays empty)", () => {
    expect(
      computeRichContextBreakdown({
        staticBreakdown: null,
        sessionInitTokens: null,
        windowTokens: 0,
        contextMax: CONTEXT_MAX,
      }),
    ).toBeNull();
  });

  it("messages is feed-exact: window − sessionInit; totalUsed = window", () => {
    const r = computeRichContextBreakdown({
      staticBreakdown,
      sessionInitTokens: 18_575,
      windowTokens: 27_927,
      contextMax: CONTEXT_MAX,
    })!;
    expect(r).not.toBeNull();
    const messages = r.segments.find((s) => s.id === "messages")!;
    expect(messages.value).toBe(27_927 - 18_575);
    // totalUsed equals the window — identical to the CONTEXT cell.
    expect(r.totalUsed).toBe(27_927);
  });

  it("scales the five static categories to sum exactly to sessionInit", () => {
    const r = computeRichContextBreakdown({
      staticBreakdown,
      sessionInitTokens: 18_575,
      windowTokens: 27_927,
      contextMax: CONTEXT_MAX,
    })!;
    const staticIds = [
      "system_prompt",
      "system_tools",
      "custom_agents",
      "memory_files",
      "skills",
    ];
    const staticSum = r.segments
      .filter((s) => staticIds.includes(s.id))
      .reduce((acc, s) => acc + s.value, 0);
    // The scaled split sums EXACTLY to the feed-exact bootstrap.
    expect(staticSum).toBe(18_575);
  });

  it("segments run statics → messages → remainder; the arc fills contextMax", () => {
    const r = computeRichContextBreakdown({
      staticBreakdown,
      sessionInitTokens: 18_575,
      windowTokens: 27_927,
      contextMax: CONTEXT_MAX,
    })!;
    expect(r.segments.map((s) => s.id)).toEqual([
      "system_prompt",
      "system_tools",
      "custom_agents",
      "memory_files",
      "skills",
      "messages",
      "remainder",
    ]);
    const arcSum = r.segments.reduce((acc, s) => acc + s.value, 0);
    expect(arcSum).toBe(CONTEXT_MAX);
    const remainder = r.segments[r.segments.length - 1];
    expect(remainder.value).toBe(CONTEXT_MAX - 27_927);
  });

  it("pre-turn-1: no sessionInit, no window — bootstrap is the raw estimate", () => {
    // The session-open case: before turn 1 the feed has nothing, so
    // the cell shows tugcode's static-estimate total and messages = 0.
    const r = computeRichContextBreakdown({
      staticBreakdown,
      sessionInitTokens: null,
      windowTokens: null,
      contextMax: CONTEXT_MAX,
    })!;
    expect(r.totalUsed).toBe(RAW_STATIC_TOTAL);
    expect(r.segments.find((s) => s.id === "messages")!.value).toBe(0);
    const staticSum = r.segments
      .filter((s) => s.id !== "messages" && s.id !== "remainder")
      .reduce((acc, s) => acc + s.value, 0);
    expect(staticSum).toBe(RAW_STATIC_TOTAL);
  });

  it("autocompact_buffer is a reserved segment, NOT part of totalUsed", () => {
    const withBuffer = {
      contextMax: CONTEXT_MAX,
      categories: [
        ...staticBreakdown.categories,
        {
          id: "autocompact_buffer",
          label: "Autocompact buffer",
          tokens: 33_000,
        } as const,
      ],
    };
    const r = computeRichContextBreakdown({
      staticBreakdown: withBuffer,
      sessionInitTokens: 18_575,
      windowTokens: 27_927,
      contextMax: CONTEXT_MAX,
    })!;
    // totalUsed is bootstrap + messages — the reserved buffer is NOT
    // counted (it is reserved headroom, not occupied content).
    expect(r.totalUsed).toBe(27_927);
    const buffer = r.segments.find((s) => s.id === "autocompact_buffer")!;
    expect(buffer.value).toBe(33_000);
    // remainder = contextMax − totalUsed − reservedBuffer.
    const remainder = r.segments[r.segments.length - 1];
    expect(remainder.value).toBe(CONTEXT_MAX - 27_927 - 33_000);
    // The arc still fills exactly to contextMax.
    expect(r.segments.reduce((acc, s) => acc + s.value, 0)).toBe(CONTEXT_MAX);
  });

  it("messages clamps to 0 when the window has not yet exceeded the bootstrap", () => {
    const r = computeRichContextBreakdown({
      staticBreakdown,
      sessionInitTokens: 18_575,
      windowTokens: 18_575,
      contextMax: CONTEXT_MAX,
    })!;
    expect(r.segments.find((s) => s.id === "messages")!.value).toBe(0);
    expect(r.totalUsed).toBe(18_575);
  });

  // The `@tug/satiny-disk` freeze, with that session's own numbers. Its
  // baseline was latched on a RESUME — `captureSessionInit` takes the first
  // token-bearing iteration, and on a resumed conversation that is the whole
  // resident transcript (205_698), not a session baseline. The `/compact` then
  // dropped the resident window to 91_432, BELOW the latch. Uncapped, every
  // window after the compaction stayed under it, so `messages` clamped to 0
  // and `totalUsed` pinned at 205_698 — CONTEXT read one number for the rest
  // of the session however much the conversation grew.
  it("a post-compaction window BELOW a resumed session's latched bootstrap still tracks", () => {
    const latchedOnResume = 205_698;
    const postCompactionWindow = 91_432;
    const r = computeRichContextBreakdown({
      staticBreakdown,
      sessionInitTokens: latchedOnResume,
      windowTokens: postCompactionWindow,
      contextMax: CONTEXT_MAX,
    })!;
    // The identity the docblock states, on the input that used to break it.
    expect(r.totalUsed).toBe(postCompactionWindow);
    // And the popover reads honestly with it: the stale latch gives way to
    // the static estimate, so the summary and everything said since it are
    // `messages` rather than being swallowed by a baseline that size.
    expect(r.segments.find((s) => s.id === "messages")!.value).toBe(
      postCompactionWindow - RAW_STATIC_TOTAL,
    );
    // And it MOVES with the next turn rather than pinning at the latch.
    const next = computeRichContextBreakdown({
      staticBreakdown,
      sessionInitTokens: latchedOnResume,
      windowTokens: 98_045,
      contextMax: CONTEXT_MAX,
    })!;
    expect(next.totalUsed).toBe(98_045);
    expect(next.totalUsed).toBeGreaterThan(r.totalUsed);
    // The static split still sums exactly to the bootstrap that stood in, and
    // the whole arc still fills contextMax.
    const staticSum = r.segments
      .filter((s) => s.id !== "messages" && s.id !== "remainder")
      .reduce((acc, s) => acc + s.value, 0);
    expect(staticSum).toBe(RAW_STATIC_TOTAL);
    expect(r.segments.reduce((acc, s) => acc + s.value, 0)).toBe(CONTEXT_MAX);
  });

  // A window of 0 is an UNMEASURED window, not an empty context: a zero-usage
  // turn reads 0 from `turnWindowTokens`, and a `/compact` turn streams
  // nothing for minutes so its in-flight frame reads 0 too. Read as a real
  // window, it pulled the latch fallback above down with it — bootstrap
  // `min(staticEstimate, 0)` — and CONTEXT showed a flat `0` on a session
  // holding a full context, which is the other half of what a compaction
  // looked like from the Z2 row.
  it("treats a window of 0 as unmeasured, not as an empty context", () => {
    const r = computeRichContextBreakdown({
      staticBreakdown,
      sessionInitTokens: 205_698,
      windowTokens: 0,
      contextMax: CONTEXT_MAX,
    })!;
    expect(r.totalUsed).toBe(205_698);
    expect(r.totalUsed).not.toBe(0);
    // And the same for a session with no latch at all: the static estimate
    // stands, which is what a fresh session shows before its first turn.
    const fresh = computeRichContextBreakdown({
      staticBreakdown,
      sessionInitTokens: null,
      windowTokens: 0,
      contextMax: CONTEXT_MAX,
    })!;
    expect(fresh.totalUsed).toBe(RAW_STATIC_TOTAL);
  });

  it("clamps a negative contextMax to 0; remainder clamps to 0", () => {
    const r = computeRichContextBreakdown({
      staticBreakdown,
      sessionInitTokens: 18_575,
      windowTokens: 27_927,
      contextMax: -1,
    })!;
    expect(r.contextMax).toBe(0);
    expect(r.segments[r.segments.length - 1].value).toBe(0);
  });
});

describe("turnHasTiming", () => {
  it("is true when any clock is real (a live-recorded turn)", () => {
    expect(turnHasTiming({ wallClockMs: 4200, activeMs: 3100, ttftMs: 250 })).toBe(true);
  });
  it("is true when only ttft is present", () => {
    expect(turnHasTiming({ wallClockMs: 0, activeMs: 0, ttftMs: 120 })).toBe(true);
  });
  it("is true when only the wall clock elapsed", () => {
    expect(turnHasTiming({ wallClockMs: 900, activeMs: 0, ttftMs: null })).toBe(true);
  });
  it("is FALSE for the replay zero-placeholder (no durable turn_telemetry row)", () => {
    // A turn restored from JSONL alone, no `turn_telemetry` overlay → all-zero
    // timing + null ttft. TIME must read `—`, not a fabricated `0:00`.
    expect(turnHasTiming({ wallClockMs: 0, activeMs: 0, ttftMs: null })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveJobExtendedActiveMs — the TIME cell across background work
// ---------------------------------------------------------------------------

describe("deriveJobExtendedActiveMs", () => {
  const base = { turnActiveMs: 9_300, turnEndedAt: 100_000 };

  it("returns the bare activeMs when the turn launched no background work", () => {
    expect(
      deriveJobExtendedActiveMs({ ...base, jobs: [], nowMs: 250_000 }),
    ).toBe(9_300);
  });

  it("keeps climbing while a launched job is still running", () => {
    const jobs = [{ status: "running", endedAtMs: null }];
    expect(
      deriveJobExtendedActiveMs({ ...base, jobs, nowMs: 160_000 }),
    ).toBe(9_300 + 60_000);
    expect(
      deriveJobExtendedActiveMs({ ...base, jobs, nowMs: 161_000 }),
    ).toBe(9_300 + 61_000);
  });

  it("freezes at the request total once every job is terminal", () => {
    const jobs = [
      { status: "completed", endedAtMs: 130_000 },
      { status: "completed", endedAtMs: 145_000 },
    ];
    // Latest job end wins; the readout never snaps back to bare activeMs.
    expect(
      deriveJobExtendedActiveMs({ ...base, jobs, nowMs: 999_000 }),
    ).toBe(9_300 + 45_000);
  });

  it("clamps a skewed job-end stamp instead of running backwards", () => {
    const jobs = [{ status: "completed", endedAtMs: 99_000 }];
    expect(
      deriveJobExtendedActiveMs({ ...base, jobs, nowMs: 999_000 }),
    ).toBe(9_300);
  });
});

describe("computeRichContextBreakdown — honest post-compaction ([P08] / Step 5)", () => {
  const CONTEXT_MAX = 1_000_000;

  // The honest post-compaction window fed by the CONTEXT cell walk:
  // sessionInit + post_tokens (base + Claude's small conversation figure). The
  // breakdown's `messages` slice must fall out to post_tokens, and totalUsed
  // must equal the window (the same figure the CONTEXT cell shows).
  function win(n: number): TurnEntry {
    return turn({
      cost: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: n,
        totalCostUsd: 0,
      },
    });
  }

  it("messages == post_tokens; totalUsed == the honest window == CONTEXT cell", () => {
    const sessionInit = 24_000;
    const postTokens = 1_442;
    // A trailing compaction turn carrying the honest total override.
    const compactionTurn = turn({
      cost: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalCostUsd: 0,
      },
      compactionPostTotal: sessionInit + postTokens,
    });
    const transcript = [win(807_000), compactionTurn];
    // The CONTEXT cell derives the window with the honest override.
    const windows = deriveContextWindows(
      transcript.map((t) => t.cost),
      sessionInit,
      transcript.map((t) => t.compactionPostTotal ?? null),
    );
    const cellWindow = windows[windows.length - 1]!.window;
    expect(cellWindow).toBe(sessionInit + postTokens);

    const r = computeRichContextBreakdown({
      staticBreakdown: null,
      sessionInitTokens: sessionInit,
      windowTokens: cellWindow,
      contextMax: CONTEXT_MAX,
    })!;
    expect(r.totalUsed).toBe(cellWindow); // == the CONTEXT cell value
    const messages = r.segments.find((s) => s.id === "messages")!;
    expect(messages.value).toBe(postTokens); // window − base = post_tokens (small)
    expect(r.totalUsed).toBeGreaterThanOrEqual(sessionInit); // never below base
  });
});

describe("isCompactionLowEffect ([P08] predicate)", () => {
  function win(n: number): TurnEntry {
    return turn({
      cost: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: n,
        totalCostUsd: 0,
      },
    });
  }

  it("true when the conversation is much smaller than the base", () => {
    // base 38K, conversation 4K → 4/38 ≈ 0.10 < 0.25 → hint.
    expect(isCompactionLowEffect([win(42_000)], 38_000)).toBe(true);
  });

  it("false when the conversation is a substantial fraction of the base", () => {
    // base 24K, conversation 10K → 10/24 ≈ 0.42 → no hint.
    expect(isCompactionLowEffect([win(34_000)], 24_000)).toBe(false);
  });

  it("false with no base, no turns, or an empty conversation", () => {
    expect(isCompactionLowEffect([win(42_000)], null)).toBe(false);
    expect(isCompactionLowEffect([], 38_000)).toBe(false);
    expect(isCompactionLowEffect([win(38_000)], 38_000)).toBe(false); // conversation 0
  });

  it("reads the honest override, so a just-compacted small session trips it", () => {
    // sessionInit 24K, compaction override 25.4K → conversation 1.4K → hint.
    const compactionTurn = turn({
      cost: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalCostUsd: 0,
      },
      compactionPostTotal: 25_442,
    });
    expect(isCompactionLowEffect([win(807_000), compactionTurn], 24_000)).toBe(true);
  });

  it("the compact command is always registered (never gated by the hint)", () => {
    expect(LOCAL_SLASH_COMMANDS.some((c) => c.name === "compact")).toBe(true);
  });
});
