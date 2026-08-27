/**
 * The track's derivation is pure, so it is a table: the feed's fields in, the
 * phase and states out.
 */

import { describe, expect, test } from "bun:test";

import {
  dashCellState,
  dashTrackModel,
  dashTrackSteps,
  tickState,
  type DashPhase,
  type DashTrackInput,
} from "../tug-dash-track";

const PLAN = { brief: "/b", plan: "/p" };
const steps = (done: number, current: number | null, total: number) =>
  Array.from({ length: total }, (_, i) => ({
    title: `s${i + 1}`,
    status: i < done ? "done" : i + 1 === current ? "in progress" : "pending",
  }));

describe("dashTrackModel", () => {
  const cases: Array<[string, DashTrackInput, DashPhase, boolean]> = [
    ["a brief alone is the brief phase", { documents: { brief: "/b" } }, "brief", false],
    ["devise on the arc", { documents: { brief: "/b" }, arc: { stage: "devise" } }, "devise", false],
    ["review on the arc", { documents: PLAN, arc: { stage: "review" }, steps: steps(0, null, 4) }, "review", false],
    ["a plan nobody has begun, no arc, is review", { documents: PLAN, steps: steps(0, null, 4) }, "review", false],
    ["implement, a step in progress", { documents: PLAN, arc: { stage: "implement" }, steps: steps(1, 2, 4), stage: "implementing" }, "implement", false],
    ["a hand-driven walk is implement", { documents: PLAN, steps: steps(1, 2, 4), stage: "working" }, "implement", false],
    ["every step done is the join", { documents: PLAN, steps: steps(4, null, 4), stage: "draft-ready" }, "join", false],
    ["a walked plan is the join even before the stage moves", { documents: PLAN, steps: steps(4, null, 4), stage: "working" }, "join", false],
    ["no documents and no arc is direct, in implement", { stage: "working" }, "implement", true],
    ["a direct dash offered its join", { stage: "draft-ready" }, "join", true],
    // A direct dash's task list IS a plan document, so nothing about the
    // documents' presence can tell the two routes apart. `taskList` is the
    // server's reading of the document's own shape, and it is what does.
    ["a task list is direct, in implement before any step opens", { documents: { plan: "/p" }, taskList: true, steps: steps(0, null, 3), stage: "working" }, "implement", true],
    ["a direct dash mid-walk", { documents: { plan: "/p" }, taskList: true, steps: steps(1, 2, 3), stage: "implementing" }, "implement", true],
    ["a direct dash that walked its list is the join", { documents: { plan: "/p" }, taskList: true, steps: steps(3, null, 3), stage: "working" }, "join", true],
    // The same document shape WITHOUT the task-list reading is a devised plan
    // adopted onto a briefless dash — which stands at review, as it always has.
    ["a devised plan with no brief still reads review", { documents: { plan: "/p" }, steps: steps(0, null, 3), stage: "working" }, "review", false],
  ];
  for (const [name, input, phase, direct] of cases) {
    test(name, () => {
      const model = dashTrackModel(input);
      expect(model.phase).toBe(phase);
      expect(model.direct).toBe(direct);
    });
  }

  test("a stop lands in the stage it stopped in, and paints that cell", () => {
    const model = dashTrackModel({
      documents: PLAN,
      arc: { stage: "implement", stopped: "card closed", stopped_stage: "implement" },
      steps: steps(6, 7, 10),
      stage: "working",
    });
    expect(model.phase).toBe("implement");
    expect(model.stopped).toBe("card closed");
    expect(dashCellState(model, "implement")).toBe("stopped");
    expect(dashCellState(model, "review")).toBe("done");
    expect(dashCellState(model, "join")).toBe("pending");
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
    expect(dashTrackSteps(ledger("done", "withdrawn", "done"))).toEqual({
      total: 3,
      done: 3,
      current: null,
      withdrawn: new Set([2]),
      closed: new Set([1, 3]),
    });
  });

  test("is closed even when it is not the last row", () => {
    const statuses = Array.from({ length: 8 }, (_, i) => (i === 6 ? "withdrawn" : "done"));
    const steps = dashTrackSteps(ledger(...statuses));
    expect(steps?.done).toBe(8);
    expect(steps?.withdrawn).toEqual(new Set([7]));
  });

  test("wears its own tick while its neighbours read done", () => {
    const statuses = Array.from({ length: 8 }, (_, i) => (i === 6 ? "withdrawn" : "done"));
    const model = dashTrackModel({ documents: PLAN, steps: ledger(...statuses), stage: "working" });
    expect(tickState(model, 6)).toBe("done");
    expect(tickState(model, 7)).toBe("withdrawn");
    expect(tickState(model, 8)).toBe("done");
  });

  test("still leaves the plan walked, so the phase is the join", () => {
    const statuses = Array.from({ length: 8 }, (_, i) => (i === 6 ? "withdrawn" : "done"));
    const model = dashTrackModel({ documents: PLAN, steps: ledger(...statuses), stage: "working" });
    expect(model.phase).toBe("join");
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
    const model = dashTrackModel({
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
