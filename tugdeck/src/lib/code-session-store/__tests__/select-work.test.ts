/**
 * select-work.test.ts — pure-logic coverage for the TASKS and JOBS
 * cell derivations: fractions, counts, pose truth-tables, and the
 * per-cell linger.
 *
 * Each cell keeps its source's semantics: TASKS holds [D100]'s idle
 * demotion, while JOBS never idle-demotes ([D102]'s divergence) and a
 * failed job holds the `aborted` pose past any linger.
 */

import { describe, expect, test } from "bun:test";

import type { GoalState } from "@/lib/code-session-store/select-goal";
import { countJobs, type JobItem } from "@/lib/code-session-store/select-jobs";
import type { TaskItem } from "@/lib/code-session-store/select-task-list";
import {
  cellDisplayCount,
  composeJobsCellSummary,
  formatCellCount,
  formatTaskFraction,
  jobsCellActiveCount,
  jobsCellDisplayPose,
  jobsRecentlyDone,
  nextLingerExpiryMs,
  tasksCellPose,
  tasksRecentlyDone,
} from "@/lib/code-session-store/select-work";

function job(overrides: Partial<JobItem> & { jobId: string }): JobItem {
  return {
    source: "claude",
    kind: "bash",
    toolUseId: overrides.jobId,
    description: `job ${overrides.jobId}`,
    status: "running",
    startedAtMs: 1000,
    endedAtMs: null,
    ...overrides,
  } as JobItem;
}

function task(id: string, status: TaskItem["status"]): TaskItem {
  return { taskId: id, subject: `task ${id}`, status };
}

function goal(status: GoalState["status"] = "active"): GoalState {
  return {
    condition: "tests pass",
    status,
    turnsEvaluated: 2,
    latestReason: "one failing",
    setAtMs: 1000,
    cycleTurnKey: "t1",
  };
}

describe("nextLingerExpiryMs", () => {
  const NOW = 1_000_000;
  const L = 300_000;
  const doneTask = (id: string, completedAtMs: number | undefined): TaskItem => ({
    taskId: id,
    subject: `task ${id}`,
    status: "completed",
    ...(completedAtMs !== undefined ? { completedAtMs } : {}),
  });

  test("earliest future expiry, else null", () => {
    const tasks = [doneTask("a", NOW - 60_000), doneTask("b", NOW - 120_000)];
    // earliest completion (b, older) ages out first.
    expect(nextLingerExpiryMs(tasks, [], NOW, L)).toBe(NOW - 120_000 + L);
    // nothing lingering → null.
    expect(nextLingerExpiryMs([doneTask("c", NOW - L - 1)], [], NOW, L)).toBe(null);
    expect(nextLingerExpiryMs([], [], NOW, L)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Per-cell derivations — TASKS and JOBS
// ---------------------------------------------------------------------------

describe("formatTaskFraction", () => {
  test("empty list reads None", () => {
    expect(formatTaskFraction({ completed: 0, total: 0 })).toBe("None");
  });

  test("partial and full fractions", () => {
    expect(formatTaskFraction({ completed: 3, total: 7 })).toBe("3/7");
    expect(formatTaskFraction({ completed: 12, total: 17 })).toBe("12/17");
    expect(formatTaskFraction({ completed: 4, total: 4 })).toBe("4/4");
    expect(formatTaskFraction({ completed: 0, total: 2 })).toBe("0/2");
  });
});

describe("tasksCellPose", () => {
  test("no tasks is quiet", () => {
    const empty = { hasTasks: false, allTasksComplete: false, isIdle: false };
    expect(tasksCellPose(empty, false)).toBe("stopped");
    expect(tasksCellPose(empty, true)).toBe("stopped");
  });

  test("in-flight runs, and idle demotes it", () => {
    const open = { hasTasks: true, allTasksComplete: false, isIdle: false };
    expect(tasksCellPose(open, false)).toBe("running");
    expect(tasksCellPose({ ...open, isIdle: true }, false)).toBe("stopped");
  });

  test("all complete reads green only while the finish is recent", () => {
    const done = { hasTasks: true, allTasksComplete: true, isIdle: true };
    expect(tasksCellPose(done, true)).toBe("completed");
    expect(tasksCellPose(done, false)).toBe("stopped");
  });
});

describe("per-cell recently-done splits", () => {
  const now = 10_000;
  const linger = 5_000;

  test("tasks count by completedAtMs; jobs never leak into the tasks half", () => {
    const tasks: TaskItem[] = [
      { ...task("t1", "completed"), completedAtMs: 8_000 },
      { ...task("t2", "completed"), completedAtMs: 1_000 },
      { ...task("t3", "completed") },
      task("t4", "pending"),
    ];
    const jobs = [job({ jobId: "f1", status: "completed", endedAtMs: 9_000 })];
    expect(tasksRecentlyDone(tasks, now, linger)).toBe(1);
    expect(jobsRecentlyDone(jobs, now, linger)).toBe(1);
    expect(tasksRecentlyDone([], now, linger)).toBe(0);
  });

  test("terminal jobs outside the window and running jobs do not count", () => {
    const jobs = [
      job({ jobId: "f1", status: "completed", endedAtMs: 9_000 }),
      job({ jobId: "f2", status: "failed", endedAtMs: 2_000 }),
      job({ jobId: "r1" }),
    ];
    expect(jobsRecentlyDone(jobs, now, linger)).toBe(1);
  });
});

describe("jobsCellActiveCount", () => {
  test("running + scheduled + one active goal", () => {
    const jobs = [
      job({ jobId: "r1" }),
      job({ jobId: "s1", kind: "cron", status: "scheduled" }),
      job({ jobId: "f1", status: "completed", endedAtMs: 2_000 }),
    ];
    expect(jobsCellActiveCount(countJobs(jobs), goal())).toBe(3);
    expect(jobsCellActiveCount(countJobs(jobs), null)).toBe(2);
    expect(jobsCellActiveCount(countJobs(jobs), goal("achieved"))).toBe(2);
  });

  test("an empty ledger with no goal is zero", () => {
    expect(jobsCellActiveCount(countJobs([]), null)).toBe(0);
  });
});

describe("jobsCellDisplayPose", () => {
  test("running passes through the linger gate", () => {
    expect(jobsCellDisplayPose([job({ jobId: "r1" })], false)).toBe("running");
  });

  test("a failure nags red regardless of linger", () => {
    const jobs = [job({ jobId: "f1", status: "failed", endedAtMs: 2_000 })];
    expect(jobsCellDisplayPose(jobs, false)).toBe("aborted");
    expect(jobsCellDisplayPose(jobs, true)).toBe("aborted");
  });

  test("completed demotes to quiet once the finish ages out", () => {
    const jobs = [job({ jobId: "c1", status: "completed", endedAtMs: 2_000 })];
    expect(jobsCellDisplayPose(jobs, true)).toBe("completed");
    expect(jobsCellDisplayPose(jobs, false)).toBe("stopped");
  });

  test("a scheduled row is not running, and an empty ledger is quiet", () => {
    const scheduled = [job({ jobId: "s1", kind: "wakeup", status: "scheduled" })];
    expect(jobsCellDisplayPose(scheduled, false)).toBe("stopped");
    expect(jobsCellDisplayPose([], false)).toBe("stopped");
  });
});

describe("cellDisplayCount / formatCellCount", () => {
  test("active wins; the linger only softens the drop to zero", () => {
    expect(cellDisplayCount(3, 2)).toBe(3);
    expect(cellDisplayCount(0, 2)).toBe(2);
    expect(cellDisplayCount(0, 0)).toBe(0);
  });

  test("zero reads None", () => {
    expect(formatCellCount(0)).toBe("None");
    expect(formatCellCount(4)).toBe("4");
  });
});

describe("composeJobsCellSummary", () => {
  test("zero buckets drop; the goal reads first", () => {
    const jobs = [
      job({ jobId: "r1" }),
      job({ jobId: "s1", kind: "cron", status: "scheduled" }),
      job({ jobId: "s2", kind: "wakeup", status: "scheduled" }),
      job({ jobId: "f1", status: "completed", endedAtMs: 2_000 }),
    ];
    expect(composeJobsCellSummary(countJobs(jobs), goal())).toBe(
      "goal active, 1 running, 2 scheduled, 1 finished",
    );
    expect(composeJobsCellSummary(countJobs(jobs), null)).toBe(
      "1 running, 2 scheduled, 1 finished",
    );
  });

  test("an empty surface reads No jobs, and tasks never appear here", () => {
    expect(composeJobsCellSummary(countJobs([]), null)).toBe("No jobs");
    expect(composeJobsCellSummary(countJobs([]), goal("achieved"))).toBe("No jobs");
  });
});
