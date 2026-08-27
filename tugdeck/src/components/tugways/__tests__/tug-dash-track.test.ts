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
    ["no documents and no arc is a cut, in implement", { stage: "working" }, "implement", true],
    ["a cut offered its join", { stage: "draft-ready" }, "join", true],
  ];
  for (const [name, input, phase, dashCut] of cases) {
    test(name, () => {
      const model = dashTrackModel(input);
      expect(model.phase).toBe(phase);
      expect(model.dashCut).toBe(dashCut);
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
    expect(model.steps).toEqual({ total: 10, done: 6, current: 7, withdrawn: new Set() });
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
