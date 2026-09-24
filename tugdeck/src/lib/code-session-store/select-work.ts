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
 * The stages that are a resting point of the arc — the arc has
 * arrived somewhere and is waiting on a person, not advancing.
 */
const ARC_SETTLED_STAGES: ReadonlySet<string> = new Set([
  "ready",
  "built",
  "audited",
  "draft-ready",
]);

/**
 * The ARC reading's indicator pose — the arc lifecycle in the same
 * poses the TASKS reading it replaces uses, plus danger for a stop:
 *
 *  - a recorded stop (`wheel.stopped`) → `aborted`, which outranks every
 *    other reading;
 *  - a resting point of the arc (`ready` / `built` / `audited` /
 *    `draft-ready`) → `completed`;
 *  - an arc the wheel is driving — a wheel record present, not `done`,
 *    not stopped → `running`, **whatever the session is doing**;
 *  - an arc under way with no wheel record → `running`, demoted to
 *    `stopped` while the session is idle, on the same grounds as TASKS:
 *    nothing else is acting on it between turns, and a dot still
 *    pulsing over an idle session would say something was;
 *  - an arc nobody has begun — no arc, and no stage or `created` →
 *    `stopped`.
 *
 * **Under the wheel the idle edge is the arc's busiest moment.** A
 * rotation, a compaction, and every stage seat happen *at* the turn end,
 * never inside a turn, so the idle demotion that is right for a hand-run
 * arc painted a wheel-driven one as stopped at the door's turn end, at
 * every step boundary, and across every rotation gap — exactly the
 * moments the wheel was working. The wheel record is what says the arc
 * is being driven, so its liveness is what holds the pulse.
 *
 * **"Under way" is the ARC, not the git stage.** An arc writing its
 * brief, devising a plan, or reviewing one has no stage at all —
 * `arc create` has not cut a branch yet — so a pose read off the
 * stage alone showed two idle dots beside `Devise` on a session that
 * was plainly working, which is the same blindness the phase glyph was
 * moved off the stage to cure ([D168]). An arc with a stage in hand is
 * an arc under way whatever the git side says.
 *
 * An unrecognized stage from an older or newer sender falls into the
 * in-flight branch rather than a dead pose, so a stage added later
 * reads as work rather than as nothing.
 */
export function arcCellPose(
  arc: {
    stage: string | null;
    wheel: { stage?: string; stopped?: string; done?: boolean } | null;
  },
  isIdle: boolean,
): "stopped" | "running" | "completed" | "aborted" {
  const { stage, wheel } = arc;
  if (wheel?.stopped !== undefined) return "aborted";
  if (stage !== null && ARC_SETTLED_STAGES.has(stage)) return "completed";
  if (wheel !== null && wheel.done !== true) return "running";
  const arcStage = wheel?.stage ?? null;
  const begun = arcStage !== null || (stage !== null && stage !== "created");
  if (!begun) return "stopped";
  return isIdle ? "stopped" : "running";
}

/**
 * The pair the ARC reading may show, or null when it must say a word instead.
 *
 * **Z2's numerals are the implement stage's reading and no other stage's.**
 * The masthead counts a declared selection wherever the arc is — `3/3` on a
 * title is right — but the state cell says what the seated session is
 * *doing*, and a pair of numbers says "walking steps". Two moments used to
 * produce a pair that said the wrong thing: after the walk the run fraction
 * pins at `N/N` and the audit stage read `3/3`; before the first step opens
 * the fallback counts zero and a reviewed plan read `0/4`. So the pair shows
 * only while the wheel's stage is `implement` — or no wheel drives the arc at
 * all, since a hand-run arc's step verbs are its implement stage — and only
 * once a step is actually in hand. Everywhere else the caller says the seated
 * stage's word, which is the honest fact at those moments; the plan's size is
 * not lost, the placard's list and the track's ticks carry it.
 */
export function arcCellNumerals(
  wheel: { stage?: string; stopped?: string; done?: boolean } | null,
  fraction: { current: number; total: number } | null,
): { current: number; total: number } | null {
  if (fraction === null || fraction.current <= 0) return null;
  if (wheel === null) return fraction;
  const live = wheel.done !== true && wheel.stopped === undefined;
  return live && wheel.stage === "implement" ? fraction : null;
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
export function cellDisplayCount(
  activeCount: number,
  recentlyDone: number,
): number {
  return activeCount > 0 ? activeCount : recentlyDone;
}

/**
 * The widest reading a work cell (TASKS, JOBS) can show, declared beside the
 * formatter that produces it: at zero the cell reads this word, and any count
 * it shows is narrower than the fraction-shaped reservation beside it. The
 * cells render it as a hidden sizing face, so the box is set from the word
 * rather than from a `ch` count in a stylesheet ([D168]).
 */
export const WORK_CELL_WIDEST_WORD = "None";

/** Format a work cell's count — the number, or "None" at zero. */
export function formatCellCount(count: number): string {
  return count === 0 ? WORK_CELL_WIDEST_WORD : String(count);
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
