/**
 * The Z2 work cells' view-model — the derivations behind TASKS and
 * JOBS.
 *
 * The two cells split along the checklist / everything-else seam:
 * TASKS is the numbered checklist alone, JOBS is the session's
 * background machinery (running jobs, scheduled rows, the `/goal`).
 * Their storage stays separate and untouched — the task list is a
 * derived turn-scoped fold (`select-task-list.ts`), the jobs ledger is
 * session-lifetime state (`select-jobs.ts`), the goal its own snapshot
 * field (`select-goal.ts`). Everything here is pure projection over
 * those sources; no new persistence.
 *
 * Task counts arrive as a structural `{ completed, total }` rather than
 * as the components layer's `TaskCounts`, so the library boundary
 * stays one-way: `lib` does not depend on `components`.
 */

import type { GoalState } from "./select-goal";
import { goalIsActive } from "./select-goal";
import type { JobCounts, JobItem } from "./select-jobs";
import { isTerminalJobStatus, jobsCellPose } from "./select-jobs";
import type { TaskItem } from "./select-task-list";

/**
 * How long a finished item keeps contributing to its cell's reading
 * after it completes. Each cell holds its own recently-finished work
 * for this window rather than snapping to "None" the instant the last
 * item completes, then quietly settles. Five minutes.
 */
export const WORK_LINGER_MS = 300_000;

/**
 * The earliest future moment a lingering item ages out of the window
 * (`completion + lingerMs`), or `null` when nothing is currently
 * lingering. The renderer schedules one bounded timeout at this instant
 * to recompute the count once — no per-second ticker (the work cells
 * are deliberately tick-free). Only completions still inside the window are
 * considered, so the returned time is always `> nowMs`.
 */
export function nextLingerExpiryMs(
  tasks: readonly TaskItem[],
  jobs: readonly JobItem[],
  nowMs: number,
  lingerMs: number,
): number | null {
  let earliest: number | null = null;
  const consider = (completionMs: number): void => {
    const expiry = completionMs + lingerMs;
    if (expiry > nowMs && (earliest === null || expiry < earliest)) {
      earliest = expiry;
    }
  };
  for (const t of tasks) {
    if (t.status === "completed" && t.completedAtMs !== undefined) {
      consider(t.completedAtMs);
    }
  }
  for (const j of jobs) {
    if (isTerminalJobStatus(j.status) && j.endedAtMs !== null) {
      consider(j.endedAtMs);
    }
  }
  return earliest;
}

// ---------------------------------------------------------------------------
// Per-cell derivations — TASKS and JOBS
// ---------------------------------------------------------------------------

/** The checklist inputs the TASKS pose reads. */
export interface TasksChecklistPose {
  readonly hasTasks: boolean;
  readonly allTasksComplete: boolean;
  /** Session idle — demotes an in-progress checklist to quiet. */
  readonly isIdle: boolean;
}

/**
 * The TASKS cell's label: `completed/total`, or "None" for an empty
 * list. The fraction is the reading a plan-following session tracks —
 * an incomplete count alone hides how far along the list is.
 *
 * Counts arrive structurally so this module stays free of a
 * `components/` import; the caller supplies them from `countTasks`.
 */
export function formatTaskFraction(counts: {
  completed: number;
  total: number;
}): string {
  if (counts.total === 0) return "None";
  return `${counts.completed}/${counts.total}`;
}

/**
 * The TASKS cell's indicator pose — the checklist grammar:
 *
 *  - no tasks → `stopped`;
 *  - all complete → `completed` while the finish is recent, else
 *    `stopped` (the dot agrees with the lingered label rather than
 *    sitting green beside a settled list);
 *  - otherwise `running`, demoted to `stopped` while the session is
 *    idle — a half-done checklist does not glow over an idle session.
 */
export function tasksCellPose(
  checklist: TasksChecklistPose,
  recentlyCompleted: boolean,
): "stopped" | "running" | "completed" {
  if (!checklist.hasTasks) return "stopped";
  if (checklist.allTasksComplete) {
    return recentlyCompleted ? "completed" : "stopped";
  }
  return checklist.isIdle ? "stopped" : "running";
}

/**
 * How many tasks completed within `lingerMs` of `nowMs`. A task with
 * no completion timestamp (a resumed fold) never counts as recent.
 */
export function tasksRecentlyDone(
  tasks: readonly TaskItem[],
  nowMs: number,
  lingerMs: number,
): number {
  let n = 0;
  for (const t of tasks) {
    if (
      t.status === "completed" &&
      t.completedAtMs !== undefined &&
      nowMs - t.completedAtMs < lingerMs
    ) {
      n += 1;
    }
  }
  return n;
}

/** The jobs half of the same window — terminal rows by `endedAtMs`. */
export function jobsRecentlyDone(
  jobs: readonly JobItem[],
  nowMs: number,
  lingerMs: number,
): number {
  let n = 0;
  for (const j of jobs) {
    if (
      isTerminalJobStatus(j.status) &&
      j.endedAtMs !== null &&
      nowMs - j.endedAtMs < lingerMs
    ) {
      n += 1;
    }
  }
  return n;
}

/**
 * The JOBS cell's active count: running jobs, scheduled rows, and one
 * active goal. Terminal rows are history and do not count.
 */
export function jobsCellActiveCount(
  jobCounts: JobCounts,
  goal: GoalState | null,
): number {
  return jobCounts.running + jobCounts.scheduled + (goalIsActive(goal) ? 1 : 0);
}

/**
 * The JOBS cell's indicator pose: {@link jobsCellPose} with the linger
 * gate applied. `running` and `aborted` pass through — a running job
 * claims execution between turns, and a failure nags red until it is
 * cleared. `completed` demotes to quiet once the finish ages out of the
 * linger window. An active goal contributes to the count, never to the
 * pose: it is a standing condition, not an executing job.
 */
export function jobsCellDisplayPose(
  jobs: readonly JobItem[],
  recentlyCompleted: boolean,
): "stopped" | "running" | "completed" | "aborted" {
  const pose = jobsCellPose(jobs);
  if (pose === "completed" && !recentlyCompleted) return "stopped";
  return pose;
}

/**
 * The number a work cell shows: its live active count, else its
 * recently-finished count (the linger). Active work never inflates by
 * history — the linger only softens the drop to zero.
 */
export function cellDisplayCount(activeCount: number, recentlyDone: number): number {
  return activeCount > 0 ? activeCount : recentlyDone;
}

/** Format a work cell's count — the number, or "None" at zero. */
export function formatCellCount(count: number): string {
  return count === 0 ? "None" : String(count);
}

/**
 * Accessible summary of the JOBS cell — zero-bucket drop, reading
 * order matching the popover's sections.
 */
export function composeJobsCellSummary(
  jobCounts: JobCounts,
  goal: GoalState | null,
): string {
  const parts: string[] = [];
  if (goalIsActive(goal)) parts.push("goal active");
  if (jobCounts.running > 0) parts.push(`${jobCounts.running} running`);
  if (jobCounts.scheduled > 0) parts.push(`${jobCounts.scheduled} scheduled`);
  if (jobCounts.finished > 0) parts.push(`${jobCounts.finished} finished`);
  return parts.length === 0 ? "No jobs" : parts.join(", ");
}
