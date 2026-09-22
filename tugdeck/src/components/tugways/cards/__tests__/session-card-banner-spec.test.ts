/**
 * Unit tests for `deriveSessionCardBannerSpec` — the pure helper that decides
 * whether the Session card surfaces its (locking) breakage banner.
 *
 * The banner is reserved for genuine breakage: the helper returns only
 * `error` or `none`. Every transient interruption (api-retry, transport,
 * replay-timeout dwell, unknown-event) now routes to non-blocking top-right
 * pane bulletins via `TransientNoticeController` — so a snapshot carrying
 * those conditions, with no `lastError`, must produce `none` here. The last
 * describe block pins that reservation.
 *
 * The helper is pure and synchronous, so each test crafts a minimal
 * `CodeSessionSnapshot` and asserts the returned spec. No render, no real
 * store.
 */

import { describe, it, expect } from "bun:test";

import {
  deriveSessionCardBannerSpec,
  humanizeErrorSummary,
  type SessionCardBannerSpec,
} from "@/components/tugways/cards/session-card-banner-spec";
import type { CodeSessionSnapshot } from "@/lib/code-session-store";

describe("humanizeErrorSummary", () => {
  it("maps known internal tokens to human copy", () => {
    expect(humanizeErrorSummary("crash_budget_exhausted")).toBe(
      "The session stopped unexpectedly and couldn't be restarted.",
    );
    expect(humanizeErrorSummary("resume_failed")).toBe(
      "Tug couldn't resume the previous session.",
    );
  });

  it("collapses a spawn-failure reason to a humane line", () => {
    expect(humanizeErrorSummary("spawn failed: ENOENT")).toBe(
      "Tug couldn't start the session process.",
    );
  });

  it("never leaks an internal lower_snake_case token or empty string", () => {
    expect(humanizeErrorSummary("")).toBe("The session ended unexpectedly.");
    expect(humanizeErrorSummary("some_new_token")).toBe(
      "The session ended unexpectedly.",
    );
  });

  it("passes an already-human summary through unchanged", () => {
    const human = "Claude exited with an unexpected error.";
    expect(humanizeErrorSummary(human)).toBe(human);
  });
});

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

describe("deriveSessionCardBannerSpec — breakage only", () => {
  it("returns kind=none when nothing of interest is true", () => {
    const spec = deriveSessionCardBannerSpec(baseSnap(), { dismissedAt: null });
    expect(spec).toEqual({ kind: "none" } satisfies SessionCardBannerSpec);
  });

  it("error surfaces when lastError is set with a banner-routable cause", () => {
    const at = 1_700_000_000_000;
    const spec = deriveSessionCardBannerSpec(
      baseSnap({
        lastError: { cause: "session_state_errored", message: "boom", at },
      }),
      { dismissedAt: null },
    );
    expect(spec).toEqual({
      kind: "error",
      cause: "session_state_errored",
      message: "boom",
      at,
    });
  });

  it("a genuine error still wins when a transport blip is also present", () => {
    // Real breakage that merely coincided with an outage must not be
    // swallowed by the outage. The reducer no longer mints a
    // `transport_closed` error at all, so the offline transportState
    // arrives on its own — the banner is owed to the other cause.
    const at = 1_700_000_000_000;
    const spec = deriveSessionCardBannerSpec(
      baseSnap({
        lastError: { cause: "session_state_errored", message: "boom", at },
        transportState: "offline",
      }),
      { dismissedAt: null },
    );
    expect(spec.kind).toBe("error");
  });

  it("a transport outage on its own raises no banner", () => {
    // The post-close snapshot: offline, errored phase, no `lastError`.
    // The "Reconnecting…" bulletin owns this condition; the banner is
    // reserved for breakage that does not heal itself.
    const spec = deriveSessionCardBannerSpec(
      baseSnap({
        lastError: null,
        transportState: "offline",
        phase: "errored",
      }),
      { dismissedAt: null },
    );
    expect(spec).toEqual({ kind: "none" });
  });

  it("a dismissed error falls through to none (transient blips don't banner)", () => {
    const at = 1_700_000_000_000;
    const spec = deriveSessionCardBannerSpec(
      baseSnap({
        lastError: { cause: "session_state_errored", message: "boom", at },
        transportState: "offline",
      }),
      { dismissedAt: at },
    );
    expect(spec).toEqual({ kind: "none" });
  });

  it("a fresh error (different at) re-raises after a dismiss", () => {
    const dismissedAt = 1_700_000_000_000;
    const newAt = dismissedAt + 1000;
    const spec = deriveSessionCardBannerSpec(
      baseSnap({
        lastError: { cause: "wire_error", message: "different boom", at: newAt },
      }),
      { dismissedAt },
    );
    expect(spec.kind).toBe("error");
    if (spec.kind === "error") {
      expect(spec.at).toBe(newAt);
      expect(spec.message).toBe("different boom");
    }
  });

  it("resume_failed never surfaces (intercepted upstream by useSessionCardObserver)", () => {
    const spec = deriveSessionCardBannerSpec(
      baseSnap({
        lastError: {
          cause: "resume_failed",
          message: "stale id",
          at: 1_700_000_000_000,
        },
      }),
      { dismissedAt: null },
    );
    expect(spec.kind).toBe("none");
  });

  it("the auth gate never surfaces a card banner (routes to ConfigureTug + picker)", () => {
    for (const message of ["auth_required", "claude_missing"]) {
      const spec = deriveSessionCardBannerSpec(
        baseSnap({
          lastError: {
            cause: "session_state_errored",
            message,
            at: 1_700_000_000_000,
          },
        }),
        { dismissedAt: null },
      );
      expect(spec).toEqual({ kind: "none" });
    }
  });
});

describe("deriveSessionCardBannerSpec — transient conditions no longer banner", () => {
  it("transport offline alone produces no banner (it's a bulletin now)", () => {
    expect(
      deriveSessionCardBannerSpec(baseSnap({ transportState: "offline" }), {
        dismissedAt: null,
      }),
    ).toEqual({ kind: "none" });
  });

  it("transport restoring alone produces no banner", () => {
    expect(
      deriveSessionCardBannerSpec(baseSnap({ transportState: "restoring" }), {
        dismissedAt: null,
      }),
    ).toEqual({ kind: "none" });
  });

  it("an active api-retry produces no banner", () => {
    expect(
      deriveSessionCardBannerSpec(
        baseSnap({
          apiRetry: {
            attempt: 3,
            maxRetries: 10,
            deadline: 1_700_000_010_000,
            error: "rate_limit",
            errorStatus: 429,
          },
        }),
        { dismissedAt: null },
      ),
    ).toEqual({ kind: "none" });
  });

  it("an active replay-timeout dwell produces no banner", () => {
    expect(
      deriveSessionCardBannerSpec(baseSnap({ replayTimeoutDwellActive: true }), {
        dismissedAt: null,
      }),
    ).toEqual({ kind: "none" });
  });

  it("an unknown-event produces no banner", () => {
    expect(
      deriveSessionCardBannerSpec(
        baseSnap({
          unknownEvent: {
            originalType: "future_telemetry",
            payloadHexPreview: "7b7d",
            at: 1_700_000_005_000,
          },
        }),
        { dismissedAt: null },
      ),
    ).toEqual({ kind: "none" });
  });

  it("a real error still wins over any concurrent transient condition", () => {
    const at = 1_700_000_000_000;
    const spec = deriveSessionCardBannerSpec(
      baseSnap({
        transportState: "offline",
        replayTimeoutDwellActive: true,
        apiRetry: {
          attempt: 1,
          maxRetries: 10,
          deadline: 1_700_000_010_000,
          error: "overloaded",
          errorStatus: 529,
        },
        lastError: { cause: "wire_error", message: "boom", at },
      }),
      { dismissedAt: null },
    );
    expect(spec.kind).toBe("error");
  });
});

/**
 * The cold-restore loading window is the `SessionRestoring` placeholder, not a
 * banner; this helper runs only once the body is mounted. These pin that the
 * replay-window signals never produce a banner and never suppress an error.
 */
describe("deriveSessionCardBannerSpec — replay-loading retired", () => {
  it("replayPreflightActive alone produces no banner", () => {
    expect(
      deriveSessionCardBannerSpec(baseSnap({ replayPreflightActive: true }), {
        dismissedAt: null,
      }),
    ).toEqual({ kind: "none" });
  });

  it("phase=replaying produces no banner", () => {
    expect(
      deriveSessionCardBannerSpec(
        baseSnap({ phase: "replaying", sessionMode: "resume" }),
        { dismissedAt: null },
      ),
    ).toEqual({ kind: "none" });
  });

  it("preflight no longer masks an error — the error surfaces", () => {
    const at = 1_700_000_000_000;
    const spec = deriveSessionCardBannerSpec(
      baseSnap({
        replayPreflightActive: true,
        lastError: { cause: "session_state_errored", message: "boom", at },
      }),
      { dismissedAt: null },
    );
    expect(spec).toEqual({
      kind: "error",
      cause: "session_state_errored",
      message: "boom",
      at,
    });
  });
});
