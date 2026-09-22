/**
 * Unit tests for the pure transient-notice seam — `projectNotices`
 * (snapshot → notices that should show) and `reconcileNotices`
 * (prev/next → post/dismiss actions). Pure in/out: no store, no toaster.
 */

import { describe, it, expect } from "bun:test";

import type { CodeSessionSnapshot } from "@/lib/code-session-store";
import {
  NOTICE_IDS,
  type NoticeDesc,
  projectNotices,
  reconcileNotices,
} from "@/components/tugways/cards/transient-notice";

function baseSnap(
  overrides: Partial<CodeSessionSnapshot> = {},
): CodeSessionSnapshot {
  return {
    phase: "idle",
    transportState: "online",
    interruptInFlight: false,
    stopStalled: false,
    streamStalled: false,
    tugSessionId: "tug-1",
    displayLabel: "test",
    sessionMode: "new",
    restoreWindowTurns: 25,
    activeMsgId: null,
    canSubmit: true,
    canInterrupt: false,
    pendingApproval: null,
    pendingAsk: null,
    pendingQuestion: null,
    queuedSends: [],
    transcript: [],
    rewindPreviews: new Map(),
    lastRewindResult: null,
    activeTurn: null,
    wakeTrigger: null,
    jobs: [],
    goal: null,
    pendingDraftRestore: null,
    pendingCommandInsert: null,
    pendingJotInsert: null,
    pendingAtomInsert: null,
    pendingFileInsert: null,
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
    ...overrides,
  };
}

const DEADLINE = 1_700_000_010_000;
// 8s before the deadline — exercises the live "next try in 8s" tail.
const NOW = DEADLINE - 8_000;

const retry = (attempt: number, error = "overloaded", errorStatus: number | null = 529) => ({
  attempt,
  maxRetries: 10,
  deadline: DEADLINE,
  error,
  errorStatus,
});

describe("projectNotices", () => {
  it("projects nothing for a clean snapshot", () => {
    expect(projectNotices(baseSnap(), NOW)).toEqual([]);
  });

  it("projects an api-retry notice with a live attempt count and countdown", () => {
    const [notice, ...rest] = projectNotices(baseSnap({ apiRetry: retry(2) }), NOW);
    expect(rest).toHaveLength(0);
    expect(notice.id).toBe(NOTICE_IDS.apiRetry);
    expect(notice.message).toBe("Servers overloaded");
    expect(notice.description).toBe("Retrying — attempt 2 of 10 · next try in 8s");
    expect(notice.countdownTo).toBe(DEADLINE);
    expect(notice.tone).toBe("caution");
    expect(notice.persistence).toBe("condition");
  });

  it("drops the countdown tail once the deadline passes (attempt in flight)", () => {
    const [notice] = projectNotices(baseSnap({ apiRetry: retry(2) }), DEADLINE + 500);
    expect(notice.description).toBe("Retrying — attempt 2 of 10");
    expect(notice.countdownTo).toBeUndefined();
  });

  it("escalates a likely-fatal retry to danger tone", () => {
    const [notice] = projectNotices(
      baseSnap({ apiRetry: retry(1, "authentication_failed", 401) }),
      NOW,
    );
    expect(notice.tone).toBe("danger");
    expect(notice.message).toBe("Authentication failed");
  });

  it("projects transport offline but not restoring (placeholder owns restoring)", () => {
    expect(projectNotices(baseSnap({ transportState: "offline" }), NOW)).toHaveLength(1);
    expect(projectNotices(baseSnap({ transportState: "restoring" }), NOW)).toEqual([]);
  });

  it("projects the unknown-event notice as an ack (sticky) FYI", () => {
    const [notice] = projectNotices(
      baseSnap({
        unknownEvent: {
          originalType: "future_telemetry",
          payloadHexPreview: "7b7d",
          at: 1,
        },
      }),
      NOW,
    );
    expect(notice.id).toBe(NOTICE_IDS.unknownEvent);
    expect(notice.persistence).toBe("ack");
    expect(notice.description).toContain("future_telemetry");
  });

  it("projects a one-shot ephemeral notice for a model-refusal fallback", () => {
    const [notice, ...rest] = projectNotices(
      baseSnap({
        refusalFallback: {
          originalModel: "claude-fable-5",
          fallbackModel: "claude-opus-4-8",
        },
      }),
      NOW,
    );
    expect(rest).toHaveLength(0);
    expect(notice.id).toBe(NOTICE_IDS.refusalFallback);
    expect(notice.persistence).toBe("ephemeral");
    expect(notice.description).toContain("claude-opus-4-8");
  });

  it("projects a one-shot ephemeral notice when the output truncated", () => {
    const [notice, ...rest] = projectNotices(
      baseSnap({ outputTruncated: true }),
      NOW,
    );
    expect(rest).toHaveLength(0);
    expect(notice.id).toBe(NOTICE_IDS.outputTruncated);
    expect(notice.persistence).toBe("ephemeral");
  });

  it("projects several notices at once (offline AND mid-retry)", () => {
    const ids = projectNotices(
      baseSnap({ transportState: "offline", apiRetry: retry(1) }),
      NOW,
    ).map((n) => n.id);
    expect(ids).toContain(NOTICE_IDS.apiRetry);
    expect(ids).toContain(NOTICE_IDS.transport);
  });
});

describe("reconcileNotices", () => {
  const note = (over: Partial<NoticeDesc> = {}): NoticeDesc => ({
    id: NOTICE_IDS.apiRetry,
    message: "Servers overloaded",
    description: "Retrying — attempt 1 of 10",
    tone: "caution",
    persistence: "condition",
    ...over,
  });

  it("shows a brand-new notice", () => {
    expect(reconcileNotices([], [note()])).toEqual([
      { type: "show", desc: note() },
    ]);
  });

  it("updates in place when the attempt count climbs", () => {
    const prev = note({ description: "Retrying — attempt 1 of 10" });
    const next = note({ description: "Retrying — attempt 2 of 10" });
    expect(reconcileNotices([prev], [next])).toEqual([
      { type: "show", desc: next },
    ]);
  });

  it("is a no-op when the set is unchanged (no re-nag)", () => {
    expect(reconcileNotices([note()], [note()])).toEqual([]);
  });

  it("dismisses a notice whose condition cleared", () => {
    expect(reconcileNotices([note()], [])).toEqual([
      { type: "dismiss", id: NOTICE_IDS.apiRetry },
    ]);
  });

  it("dismisses one while showing another in the same pass", () => {
    const gone = note({ id: NOTICE_IDS.transport, message: "Reconnecting…" });
    const fresh = note({ id: NOTICE_IDS.apiRetry });
    const actions = reconcileNotices([gone], [fresh]);
    expect(actions).toContainEqual({ type: "show", desc: fresh });
    expect(actions).toContainEqual({ type: "dismiss", id: NOTICE_IDS.transport });
  });
});
