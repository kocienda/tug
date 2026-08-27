/**
 * The guard on the one rule: a breathing glyph claims work is executing
 * right now, so `running` is reachable only from a status that means
 * exactly that.
 *
 * These are exhaustive over each status enum on purpose. Adding a status
 * without deciding its liveness is how "pending" crept into `running` at
 * four independent call sites; a missing case here fails the build rather
 * than quietly breathing on a settled deck.
 */

import { describe, expect, it } from "bun:test";

import {
  goalRowState,
  jobRowState,
  ledgerRowState,
  taskRowState,
} from "../indicator-liveness";
import { sessionSessionPhaseVisual } from "../session-phase-visual";
import type { SessionPhaseKey } from "../session-phase-visual";
import { toolCallPhaseVisual } from "../tool-call-phase-visual";
import type { ToolCallPhase } from "../tool-call-phase-visual";
import { jobsCellPose } from "../select-jobs";
import type { JobItem, JobStatus } from "../select-jobs";
import type { GoalState } from "../select-goal";
import type { TaskStatus } from "../select-task-list";

const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "in_progress",
  "completed",
];

const JOB_STATUSES: readonly JobStatus[] = [
  "running",
  "scheduled",
  "completed",
  "failed",
  "stopped",
];

const SESSION_PHASE_KEYS: readonly SessionPhaseKey[] = [
  "offline",
  "restoring",
  "interrupting",
  "idle",
  "background",
  "submitting",
  "awaiting_first_token",
  "streaming",
  "tool_work",
  "awaiting_approval",
  "replaying",
  "waking",
  "errored",
];

const TOOL_CALL_PHASES: readonly ToolCallPhase[] = [
  "idle",
  "in_flight",
  "awaiting",
  "success",
  "error",
  "interrupted",
];

/**
 * The session phases during which the TURN is in flight. Everything else —
 * idle, dead — must not breathe.
 */
const EXECUTING_SESSION_PHASES: ReadonlySet<string> = new Set([
  "restoring",
  "interrupting",
  // The turn was submitted and has not committed: it is parked on the user
  // and resumes the moment they answer. Open, therefore breathing — and this
  // is the state that most needs to be seen from across the room.
  "awaiting_approval",
  // A backgrounded agent runs after its launching turn commits. The turn
  // is over; the work is not. That is executing, so it breathes.
  "background",
  "submitting",
  "awaiting_first_token",
  "streaming",
  "tool_work",
  "replaying",
  "waking",
]);

function goal(status: GoalState["status"]): GoalState {
  return {
    condition: "the tests pass",
    status,
    turnsEvaluated: 0,
    latestReason: null,
    setAtMs: null,
    cycleTurnKey: null,
  };
}

function job(status: JobStatus): JobItem {
  return { id: `job-${status}`, status } as unknown as JobItem;
}

describe("the liveness rule — only executing work breathes", () => {
  it("lets no task status breathe while the session is idle", () => {
    for (const status of TASK_STATUSES) {
      expect(taskRowState(status, true)).not.toBe("running");
    }
  });

  it("breathes for a working session's in-progress task, and only that one", () => {
    for (const status of TASK_STATUSES) {
      const live = taskRowState(status, false) === "running";
      expect(live).toBe(status === "in_progress");
    }
  });

  it("holds a ledger row to the same gate a task row is held to", () => {
    // The plan's own spellings, which are not the task list's. `in progress`
    // is a cell a step verb wrote into a document on disk — a run that stopped
    // mid-step leaves it saying so for as long as the file sits there — so it
    // breathes only while the session it belongs to is actually working.
    expect(ledgerRowState("done", false)).toBe("completed");
    expect(ledgerRowState("done", true)).toBe("completed");
    expect(ledgerRowState("in progress", false)).toBe("running");
    expect(ledgerRowState("in progress", true)).toBe("stopped");
    expect(ledgerRowState("pending", false)).toBe("stopped");
  });

  it("reads a withdrawn row as closed, never as one nobody started", () => {
    // Resting it at `stopped` is where `pending` rests too, so the row a run
    // deliberately skipped would be indistinguishable from one it never
    // reached.
    expect(ledgerRowState("withdrawn", false)).toBe("completed");
    expect(ledgerRowState("withdrawn", true)).toBe("completed");
  });

  it("rests an unrecognized ledger status, never breathes it", () => {
    // The conservative reading, and the one the plan-doc scan takes for the
    // same cell: a spelling nobody knows has not been shown to be running.
    for (const status of ["", "blocked", "IN PROGRESS", "skipped"]) {
      expect(ledgerRowState(status, false)).toBe("stopped");
    }
  });

  it("breathes for a running job, and only a running job", () => {
    for (const status of JOB_STATUSES) {
      expect(jobRowState(status) === "running").toBe(status === "running");
    }
  });

  it("never breathes for a goal — a goal is a standing condition, not work", () => {
    for (const status of ["active", "achieved", "cleared"] as const) {
      expect(goalRowState(goal(status))).not.toBe("running");
    }
  });

  it("breathes for exactly the session phases that are executing", () => {
    for (const key of SESSION_PHASE_KEYS) {
      const live = sessionSessionPhaseVisual(key).state === "running";
      expect([key, live]).toEqual([key, EXECUTING_SESSION_PHASES.has(key)]);
    }
  });

  it("breathes for the tool-call phases that are in flight or asking", () => {
    const live: ReadonlySet<string> = new Set(["in_flight", "awaiting"]);
    for (const phase of TOOL_CALL_PHASES) {
      const breathes = toolCallPhaseVisual(phase).state === "running";
      expect([phase, breathes]).toEqual([phase, live.has(phase)]);
    }
  });

  it("breathes the WORK/JOBS cell only when a job is actually running", () => {
    expect(jobsCellPose([job("running")])).toBe("running");
    expect(jobsCellPose([job("scheduled")])).toBe("stopped");
    expect(jobsCellPose([job("scheduled"), job("running")])).toBe("running");
  });
});

describe("waiting on the user pulses, wherever it is seen from", () => {
  // One wait, two vantage points — the session's dot in the Lens and the
  // blocked call's dot in the transcript. Both are yellow and both move, so
  // a user who learns the signal in one place reads it in the other.
  it("pulses the session's awaiting-approval dot, in the caution tone", () => {
    expect(sessionSessionPhaseVisual("awaiting_approval")).toEqual({
      role: "caution",
      state: "running",
    });
  });

  it("pulses a dialog-blocked tool call's dot, in the same tone", () => {
    expect(toolCallPhaseVisual("awaiting")).toEqual({
      role: "caution",
      state: "running",
    });
  });

  it("never lets either collapse into a quiet state", () => {
    expect(sessionSessionPhaseVisual("awaiting_approval").state).not.toBe(
      sessionSessionPhaseVisual("idle").state,
    );
    expect(toolCallPhaseVisual("awaiting").state).not.toBe(
      toolCallPhaseVisual("idle").state,
    );
  });
});

describe("waiting on a clock reads as stopped, never as motion", () => {
  it("does not breathe for a scheduled wakeup", () => {
    expect(jobRowState("scheduled")).toBe("stopped");
  });

  it("still lets a failure nag past a scheduled row", () => {
    expect(jobsCellPose([job("scheduled"), job("failed")])).toBe("aborted");
  });
});
