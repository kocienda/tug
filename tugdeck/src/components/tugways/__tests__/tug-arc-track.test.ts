/**
 * The track's derivation is pure, so it is a table: the feed's fields in, the
 * phase and states out.
 */

import { describe, expect, test } from "bun:test";

import {
  arcCellState,
  arcTrackModel,
  arcTrackSteps,
  tickState,
  type ArcPhase,
  type ArcTrackInput,
} from "../tug-arc-track";

const PLAN = { brief: "/b", plan: "/p" };
const steps = (done: number, current: number | null, total: number) =>
  Array.from({ length: total }, (_, i) => ({
    title: `s${i + 1}`,
    status: i < done ? "done" : i + 1 === current ? "in progress" : "pending",
  }));

describe("arcTrackModel", () => {
  const cases: Array<[string, ArcTrackInput, ArcPhase, boolean]> = [
    ["a brief alone is the brief phase", { documents: { brief: "/b" } }, "brief", false],
    ["devise on the arc", { documents: { brief: "/b" }, arc: { stage: "devise" } }, "devise", false],
    ["review on the arc", { documents: PLAN, arc: { stage: "review" }, steps: steps(0, null, 4) }, "review", false],
    ["a plan nobody has begun, no arc, is review", { documents: PLAN, steps: steps(0, null, 4) }, "review", false],
    ["implement, a step in progress", { documents: PLAN, arc: { stage: "implement" }, steps: steps(1, 2, 4), stage: "implementing" }, "implement", false],
    ["a hand-driven walk is implement", { documents: PLAN, steps: steps(1, 2, 4), stage: "working" }, "implement", false],
    ["every step done is the join", { documents: PLAN, steps: steps(4, null, 4), stage: "draft-ready" }, "join", false],
    ["a walked plan is checking until the stage moves", { documents: PLAN, steps: steps(4, null, 4), stage: "working" }, "check", false],
    // The one the report was about: every git fact says joinable, and the run
    // that produced them is still in its test sweep.
    ["a joinable arc whose holder is still working is checking", { documents: PLAN, steps: steps(4, null, 4), stage: "ready", holdersBusy: true }, "check", false],
    ["and reads the join the moment that holder goes quiet", { documents: PLAN, steps: steps(4, null, 4), stage: "ready", holdersBusy: false }, "join", false],
    // The seam the wheel leaves: implement's last step is committed and the
    // audit stage is not seated yet, so nobody is busy and git says joinable.
    ["an arc still rotating has not arrived", { documents: PLAN, arc: { stage: "implement" }, steps: steps(4, null, 4), stage: "ready" }, "check", false],
    ["the audit stage draws in the check cell", { documents: PLAN, arc: { stage: "audit" }, steps: steps(4, null, 4), stage: "ready" }, "check", false],
    ["and the arc calling itself done is the join", { documents: PLAN, arc: { stage: "audit", done: true }, steps: steps(4, null, 4), stage: "audited" }, "join", false],
    ["no documents and no arc is direct, in implement", { stage: "working" }, "implement", true],
    ["a direct arc offered its join", { stage: "draft-ready" }, "join", true],
    // A direct arc's task list IS a plan document, so nothing about the
    // documents' presence can tell the two routes apart. `taskList` is the
    // server's reading of the document's own shape, and it is what does.
    ["a task list is direct, in implement before any step opens", { documents: { plan: "/p" }, taskList: true, steps: steps(0, null, 3), stage: "working" }, "implement", true],
    ["a direct arc mid-walk", { documents: { plan: "/p" }, taskList: true, steps: steps(1, 2, 3), stage: "implementing" }, "implement", true],
    ["a direct arc that walked its list is checking", { documents: { plan: "/p" }, taskList: true, steps: steps(3, null, 3), stage: "working" }, "check", true],
    ["a direct arc still checking while its holder works", { documents: { plan: "/p" }, taskList: true, steps: steps(3, null, 3), stage: "ready", holdersBusy: true }, "check", true],
    // The same document shape WITHOUT the task-list reading is a devised plan
    // adopted onto a briefless arc — which stands at review, as it always has.
    ["a devised plan with no brief still reads review", { documents: { plan: "/p" }, steps: steps(0, null, 3), stage: "working" }, "review", false],
  ];
  for (const [name, input, phase, direct] of cases) {
    test(name, () => {
      const model = arcTrackModel(input);
      expect(model.phase).toBe(phase);
      expect(model.direct).toBe(direct);
    });
  }

  test("a stop lands in the stage it stopped in, and paints that cell", () => {
    const model = arcTrackModel({
      documents: PLAN,
      arc: { stage: "implement", stopped: "card closed", stopped_stage: "implement" },
      steps: steps(6, 7, 10),
      stage: "working",
    });
    expect(model.phase).toBe("implement");
    expect(model.stopped).toBe("card closed");
    expect(arcCellState(model, "implement")).toBe("stopped");
    expect(arcCellState(model, "review")).toBe("done");
    expect(arcCellState(model, "join")).toBe("pending");
    expect(model.steps).toEqual({
      total: 10,
      done: 6,
      current: 7,
      withdrawn: new Set(),
      closed: new Set([1, 2, 3, 4, 5, 6]),
    });
  });
});

/**
 * A withdrawn step is closed but not worked, and closed rows are no longer a
 * prefix — so the count and the positions are two separate facts.
 */
describe("a withdrawn step", () => {
  const ledger = (...statuses: string[]) =>
    statuses.map((status, i) => ({ title: `s${i + 1}`, status }));

  test("counts as closed and names its own position", () => {
    expect(arcTrackSteps(ledger("done", "withdrawn", "done"))).toEqual({
      total: 3,
      done: 3,
      current: null,
      withdrawn: new Set([2]),
      closed: new Set([1, 3]),
    });
  });

  test("is closed even when it is not the last row", () => {
    const statuses = Array.from({ length: 8 }, (_, i) => (i === 6 ? "withdrawn" : "done"));
    const steps = arcTrackSteps(ledger(...statuses));
    expect(steps?.done).toBe(8);
    expect(steps?.withdrawn).toEqual(new Set([7]));
  });

  test("wears its own tick while its neighbours read done", () => {
    const statuses = Array.from({ length: 8 }, (_, i) => (i === 6 ? "withdrawn" : "done"));
    const model = arcTrackModel({ documents: PLAN, steps: ledger(...statuses), stage: "working" });
    expect(tickState(model, 6)).toBe("done");
    expect(tickState(model, 7)).toBe("withdrawn");
    expect(tickState(model, 8)).toBe("done");
  });

  test("still leaves the plan walked, so the phase is the check", () => {
    const statuses = Array.from({ length: 8 }, (_, i) => (i === 6 ? "withdrawn" : "done"));
    const model = arcTrackModel({ documents: PLAN, steps: ledger(...statuses), stage: "working" });
    expect(model.phase).toBe("check");
  });
});

/**
 * The step in hand is the one reading the strip must never lose. A count
 * cannot carry it: a run that closes a later step first leaves `done` counting
 * rows that are not the first rows, and a prefix test then paints the tick
 * somebody is working as finished.
 */
describe("a step closed out of order", () => {
  const ledger = (...statuses: string[]) =>
    statuses.map((status, i) => ({ title: `s${i + 1}`, status }));

  test("does not take the tick in hand down with it", () => {
    // 1-3 done, 4 in hand, 5 closed early: `done` counts 4, so `n <= done`
    // would call tick 4 finished while it is the live one.
    const model = arcTrackModel({
      documents: PLAN,
      steps: ledger("done", "done", "done", "in progress", "done", "pending"),
      stage: "working",
    });
    expect(model.steps?.done).toBe(4);
    expect(tickState(model, 4)).toBe("active");
    expect(tickState(model, 5)).toBe("done");
    expect(tickState(model, 6)).toBe("pending");
  });
});
