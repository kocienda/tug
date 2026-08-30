/**
 * session-phase-visual — unit tests for the pure mapping from a
 * CodeSession's (phase × transportState × interruptInFlight × running
 * jobs) state onto the {@link TugProgressIndicator} phase /
 * phaseLabels / phaseVisual API.
 *
 * Pins the precedence chain (offline > restoring > interrupt >
 * background-over-idle > phase), every phase branch, and the
 * human-readable label resolution.
 */

import { describe, expect, test } from "bun:test";

import {
  SESSION_PHASE_LABELS,
  sessionSessionPhaseKey,
  sessionSessionPhaseVisual,
  type SessionPhaseInput,
} from "../session-phase-visual";

function input(
  overrides: Partial<SessionPhaseInput>,
): SessionPhaseInput {
  return {
    phase: "idle",
    transportState: "online",
    interruptInFlight: false,
    ...overrides,
  };
}

describe("sessionSessionPhaseKey — transport precedence", () => {
  test("offline transport overrides every phase", () => {
    for (const phase of [
      "idle",
      "streaming",
      "tool_work",
      "errored",
    ] as const) {
      expect(sessionSessionPhaseKey(input({ phase, transportState: "offline" }))).toBe(
        "offline",
      );
    }
  });

  test("offline transport overrides interrupt-in-flight", () => {
    expect(
      sessionSessionPhaseKey(
        input({
          phase: "streaming",
          transportState: "offline",
          interruptInFlight: true,
        }),
      ),
    ).toBe("offline");
  });

  test("restoring transport overrides every phase", () => {
    for (const phase of ["idle", "streaming", "errored"] as const) {
      expect(
        sessionSessionPhaseKey(input({ phase, transportState: "restoring" })),
      ).toBe("restoring");
    }
  });

  test("restoring transport overrides interrupt-in-flight", () => {
    expect(
      sessionSessionPhaseKey(
        input({
          phase: "streaming",
          transportState: "restoring",
          interruptInFlight: true,
        }),
      ),
    ).toBe("restoring");
  });
});

describe("sessionSessionPhaseKey — interrupt precedence", () => {
  test("interrupt-in-flight on an online wire reads 'interrupting'", () => {
    expect(
      sessionSessionPhaseKey(input({ phase: "streaming", interruptInFlight: true })),
    ).toBe("interrupting");
  });

  test("interrupt-in-flight wins over `errored` phase", () => {
    expect(
      sessionSessionPhaseKey(input({ phase: "errored", interruptInFlight: true })),
    ).toBe("interrupting");
  });
});

describe("sessionSessionPhaseKey — phase fallback", () => {
  test.each([
    "idle",
    "submitting",
    "awaiting_first_token",
    "streaming",
    "tool_work",
    "awaiting_approval",
    "replaying",
    "waking",
    "errored",
  ] as const)("phase %s falls through to itself", (phase) => {
    expect(sessionSessionPhaseKey(input({ phase }))).toBe(phase);
  });
});

describe("sessionSessionPhaseKey — background work promotes idle", () => {
  test("idle with a running job reads 'background', not 'idle'", () => {
    expect(
      sessionSessionPhaseKey(input({ phase: "idle", runningJobCount: 1 })),
    ).toBe("background");
  });

  test("idle with no running jobs stays 'idle'", () => {
    expect(
      sessionSessionPhaseKey(input({ phase: "idle", runningJobCount: 0 })),
    ).toBe("idle");
  });

  test("an omitted count makes no background claim", () => {
    // The persisted state-change log replays historical triples with no
    // ledger to consult; absent must not read as work.
    expect(sessionSessionPhaseKey(input({ phase: "idle" }))).toBe("idle");
  });

  test("errored keeps its own key even with a job still running", () => {
    expect(
      sessionSessionPhaseKey(input({ phase: "errored", runningJobCount: 2 })),
    ).toBe("errored");
  });

  test("transport degradation still dominates background work", () => {
    expect(
      sessionSessionPhaseKey(
        input({
          phase: "idle",
          transportState: "offline",
          runningJobCount: 3,
        }),
      ),
    ).toBe("offline");
  });

  test("a turn in flight keeps its own phase, jobs or not", () => {
    expect(
      sessionSessionPhaseKey(input({ phase: "streaming", runningJobCount: 1 })),
    ).toBe("streaming");
  });
});

describe("sessionSessionPhaseKey — a pending ask reads Awaiting", () => {
  // Every dialog holding the user's answer reports Awaiting. The permission
  // and question dialogs arrive here as `phase: "awaiting_approval"` (the
  // reducer sets it); an `/api/ask` dialog belongs to no turn and cannot, so
  // it lands on the same key from its own axis.
  test("an idle session showing an ask reads 'awaiting_approval'", () => {
    expect(sessionSessionPhaseKey(input({ phase: "idle", pendingAsk: true }))).toBe(
      "awaiting_approval",
    );
  });

  test("the ask outranks the turn's own phase", () => {
    // The common case: the agent's own Bash call raised the dialog mid-tool.
    // "Working" would name the one participant who is not the bottleneck.
    expect(
      sessionSessionPhaseKey(input({ phase: "tool_work", pendingAsk: true })),
    ).toBe("awaiting_approval");
  });

  test("the ask outranks background work", () => {
    expect(
      sessionSessionPhaseKey(
        input({ phase: "idle", runningJobCount: 2, pendingAsk: true }),
      ),
    ).toBe("awaiting_approval");
  });

  test("a dead wire still dominates — the answer cannot be delivered", () => {
    expect(
      sessionSessionPhaseKey(
        input({ phase: "idle", transportState: "offline", pendingAsk: true }),
      ),
    ).toBe("offline");
  });

  test("an interrupt in flight still dominates", () => {
    expect(
      sessionSessionPhaseKey(
        input({ phase: "tool_work", interruptInFlight: true, pendingAsk: true }),
      ),
    ).toBe("interrupting");
  });

  test("false and omitted both make no Awaiting claim", () => {
    expect(sessionSessionPhaseKey(input({ phase: "idle", pendingAsk: false }))).toBe(
      "idle",
    );
    expect(sessionSessionPhaseKey(input({ phase: "idle" }))).toBe("idle");
  });
});

describe("sessionSessionPhaseVisual — role/state mapping", () => {
  test("offline → danger/aborted", () => {
    expect(sessionSessionPhaseVisual("offline")).toEqual({
      role: "danger",
      state: "aborted",
    });
  });

  test("errored → danger/aborted", () => {
    expect(sessionSessionPhaseVisual("errored")).toEqual({
      role: "danger",
      state: "aborted",
    });
  });

  test.each(["restoring", "interrupting"] as const)(
    "%s → caution/running",
    (key) => {
      expect(sessionSessionPhaseVisual(key)).toEqual({
        role: "caution",
        state: "running",
      });
    },
  );

  test("awaiting_approval → caution/running — the turn is open, parked on the user", () => {
    expect(sessionSessionPhaseVisual("awaiting_approval")).toEqual({
      role: "caution",
      state: "running",
    });
  });

  test.each([
    "submitting",
    "awaiting_first_token",
    "streaming",
    "tool_work",
    "replaying",
    "waking",
  ] as const)("active phase %s → action/running", (key) => {
    expect(sessionSessionPhaseVisual(key)).toEqual({
      role: "action",
      state: "running",
    });
  });

  test("background → action/running as a diamond — working, turned", () => {
    expect(sessionSessionPhaseVisual("background")).toEqual({
      role: "action",
      state: "running",
      shape: "diamond",
    });
  });

  test("background reads apart from a live turn by shape, not by tone", () => {
    const background = sessionSessionPhaseVisual("background");
    const streaming = sessionSessionPhaseVisual("streaming");
    expect(background.role).toBe(streaming.role);
    expect(background.shape).not.toBe(streaming.shape ?? "dot");
  });

  test("idle's quiet tone is idle's alone — background never borrows it", () => {
    const background = sessionSessionPhaseVisual("background");
    const idle = sessionSessionPhaseVisual("idle");
    expect(background.role).not.toBe(idle.role);
    expect(background.state).not.toBe(idle.state);
  });

  test("idle → inherit/stopped", () => {
    expect(sessionSessionPhaseVisual("idle")).toEqual({
      role: "inherit",
      state: "stopped",
    });
  });

  test("unknown phase falls through to idle defaults", () => {
    expect(sessionSessionPhaseVisual("nonsense")).toEqual({
      role: "inherit",
      state: "stopped",
    });
  });
});

describe("SESSION_PHASE_LABELS — human-readable labels", () => {
  test.each([
    ["idle", "Idle"],
    ["submitting", "Sending"],
    ["awaiting_first_token", "Waiting"],
    ["streaming", "Streaming"],
    ["tool_work", "Working"],
    ["awaiting_approval", "Awaiting"],
    ["replaying", "Restoring"],
    ["waking", "Streaming"],
    ["errored", "Error"],
    ["offline", "Disconnected"],
    ["restoring", "Reconnecting"],
    ["interrupting", "Interrupting"],
    ["background", "Running"],
  ] as const)("key %s resolves to %s", (key, expected) => {
    expect(SESSION_PHASE_LABELS[key]).toBe(expected);
  });
});
