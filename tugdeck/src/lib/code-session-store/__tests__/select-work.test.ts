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
  WORK_CELL_WIDEST_WORD,
  formatTaskFraction,
  jobsCellActiveCount,
  jobsCellDisplayPose,
  jobsRecentlyDone,
  nextLingerExpiryMs,
  arcCellPose,
  arcCellNumerals,
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

describe("arcCellPose", () => {
  type Wheel = { stage?: string; stopped?: string; done?: boolean };
  const arc = (stage: string | null, wheel: Wheel | null = null) => ({
    stage,
    wheel,
  });

  test("an arc nobody has worked yet is quiet", () => {
    expect(arcCellPose(arc(null), false)).toBe("stopped");
    expect(arcCellPose(arc("created"), false)).toBe("stopped");
  });

  test("a resting point of the arc reads finished", () => {
    for (const stage of ["ready", "built", "audited", "draft-ready"]) {
      expect(arcCellPose(arc(stage), false)).toBe("completed");
      expect(arcCellPose(arc(stage), true)).toBe("completed");
    }
  });

  test("hand-run work in flight runs, and idle demotes it", () => {
    for (const stage of ["working", "implementing", "joining", "whatever"]) {
      expect(arcCellPose(arc(stage), false)).toBe("running");
      expect(arcCellPose(arc(stage), true)).toBe("stopped");
    }
  });

  // The half of an arc's life that happens in documents: the wheel is
  // driving a stage and `arc create` has not cut a branch, so the git stage
  // is null — and the wheel's liveness is what holds the pulse.
  test("a wheel-driven arc runs even with no git stage", () => {
    for (const stage of ["brief", "devise", "review", "implement"]) {
      expect(arcCellPose(arc(null, { stage }), false)).toBe("running");
      expect(arcCellPose(arc(null, { stage }), true)).toBe("running");
    }
  });

  // [B01]: under the wheel the idle edge is the arc's busiest moment — the
  // door's turn end, every step boundary, every rotation gap — so the
  // session's idleness never demotes a live wheel record. A recorded stop,
  // a settled stage, and an arc with no wheel record each keep their own
  // reading, idle or not.
  test("the pose rule across turn ends", () => {
    const live: Wheel = { stage: "implement" };
    const table: Array<[string, Parameters<typeof arcCellPose>[0], string]> = [
      ["live wheel, git stage in hand", arc("implementing", live), "running"],
      ["live wheel, no git stage yet", arc(null, live), "running"],
      ["live wheel, git stage still created", arc("created", live), "running"],
      [
        "stopped wheel",
        arc("implementing", { ...live, stopped: "implement idle" }),
        "aborted",
      ],
      [
        "stopped wheel over a settled stage",
        arc("ready", { ...live, stopped: "stalled" }),
        "aborted",
      ],
      ["settled stage under a live wheel", arc("ready", live), "completed"],
      [
        "settled stage, wheel done",
        arc("audited", { ...live, done: true }),
        "completed",
      ],
      ["no wheel, hand-run stage", arc("implementing"), "idle-demoted"],
      [
        "wheel done, stage not settled",
        arc("implementing", { ...live, done: true }),
        "idle-demoted",
      ],
    ];
    for (const [label, input, want] of table) {
      const busy = arcCellPose(input, false);
      const idle = arcCellPose(input, true);
      if (want === "idle-demoted") {
        expect([label, busy, idle]).toEqual([label, "running", "stopped"]);
      } else {
        expect([label, busy, idle]).toEqual([label, want, want]);
      }
    }
  });
});

describe("arcCellNumerals", () => {
  const pair = { current: 2, total: 4 };

  // [B03]: the pair is the implement stage's reading and no other stage's,
  // and a zero numerator is never a reading at all.
  test("the implement stage counts; every other stage says its word", () => {
    const table: Array<
      [string, Parameters<typeof arcCellNumerals>[0], boolean]
    > = [
      ["no wheel — a hand-run arc is in implement by definition", null, true],
      ["wheel at implement", { stage: "implement" }, true],
      ["wheel at devise", { stage: "devise" }, false],
      ["wheel at review", { stage: "review" }, false],
      ["wheel at audit", { stage: "audit" }, false],
      [
        "wheel stopped in implement",
        { stage: "implement", stopped: "stalled" },
        false,
      ],
      ["wheel done", { stage: "implement", done: true }, false],
      ["wheel with no stage yet", {}, false],
    ];
    for (const [label, wheel, counts] of table) {
      expect([label, arcCellNumerals(wheel, pair)]).toEqual([
        label,
        counts ? pair : null,
      ]);
    }
  });

  test("a zero numerator is a word, never 0/N", () => {
    expect(arcCellNumerals(null, { current: 0, total: 4 })).toBeNull();
    expect(
      arcCellNumerals({ stage: "implement" }, { current: 0, total: 4 }),
    ).toBeNull();
    expect(arcCellNumerals({ stage: "implement" }, null)).toBeNull();
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

/**
 * The work cells (TASKS, JOBS) reserve their box from two ghosts — the zero
 * word and a two-digit shape — so the readings the formatter produces are
 * closed against them ([D168]): the zero word IS the declaration, and every
 * count up to 99 is no wider than the digit shape the cells reserve.
 */
describe("the work cells' widest word", () => {
  test("the zero reading is the declared widest word", () => {
    expect(formatCellCount(0)).toBe(WORK_CELL_WIDEST_WORD);
  });

  test("no count up to 99 outgrows the two-digit shape", () => {
    for (let count = 1; count <= 99; count++) {
      expect(formatCellCount(count).length).toBeLessThanOrEqual("00".length);
    }
  });
});
