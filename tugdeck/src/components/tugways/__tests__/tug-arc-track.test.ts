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
    ["a walked plan is under audit until the stage moves", { documents: PLAN, steps: steps(4, null, 4), stage: "working" }, "audit", false],
    // The one the report was about: every git fact says joinable, and the run
    // that produced them is still in its test sweep.
    ["a joinable arc whose holder is still working is under audit", { documents: PLAN, steps: steps(4, null, 4), stage: "ready", holdersBusy: true }, "audit", false],
    ["and reads the join the moment that holder goes quiet", { documents: PLAN, steps: steps(4, null, 4), stage: "ready", holdersBusy: false }, "join", false],
    // The seam the wheel leaves: implement's last step is committed and the
    // audit stage is not seated yet, so nobody is busy and git says joinable.
    ["an arc still rotating has not arrived", { documents: PLAN, arc: { stage: "implement" }, steps: steps(4, null, 4), stage: "ready" }, "audit", false],
    ["the audit stage draws in the audit cell", { documents: PLAN, arc: { stage: "audit" }, steps: steps(4, null, 4), stage: "ready" }, "audit", false],
    ["and the arc calling itself done is the join", { documents: PLAN, arc: { stage: "audit", done: true }, steps: steps(4, null, 4), stage: "audited" }, "join", false],
    // Every git fact says joinable, and the stop says where it happened: the
    // strip lights the cell the stop names, not the one git would.
    ["a stopped audit lights the audit cell, not the join", { documents: PLAN, arc: { stage: "audit", stopped: "audit did not mark", stopped_stage: "audit" }, steps: steps(4, null, 4), stage: "ready" }, "audit", false],
    ["a stopped implement at a joinable stage stays in implement", { documents: PLAN, arc: { stage: "implement", stopped: "stopped by user", stopped_stage: "implement" }, steps: steps(4, null, 4), stage: "ready" }, "implement", false],
    ["no documents and no arc is direct, in implement", { stage: "working" }, "implement", true],
    ["a direct arc offered its join", { stage: "draft-ready" }, "join", true],
    // A direct arc's task list IS a plan document, so nothing about the
    // documents' presence can tell the two routes apart. `taskList` is the
    // server's reading of the document's own shape, and it is what does.
    ["a task list is direct, in implement before any step opens", { documents: { plan: "/p" }, taskList: true, steps: steps(0, null, 3), stage: "working" }, "implement", true],
    ["a direct arc mid-walk", { documents: { plan: "/p" }, taskList: true, steps: steps(1, 2, 3), stage: "implementing" }, "implement", true],
    ["a direct arc that walked its list is under audit", { documents: { plan: "/p" }, taskList: true, steps: steps(3, null, 3), stage: "working" }, "audit", true],
    ["a direct arc still under audit while its holder works", { documents: { plan: "/p" }, taskList: true, steps: steps(3, null, 3), stage: "ready", holdersBusy: true }, "audit", true],
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
 * Which cells the strip draws, and what decides it.
 *
 * The two sets differ by devise and review alone, and an arc's kind is a
 * recorded fact its log wrote when it opened. It used to be inferred from
 * `direct` — no run record, no brief, no devised plan — on the premise that
 * only the planned route wrote a brief. Both doors write one now, and a
 * wheel-driven arc always has a run record, so that inference read every arc
 * as planned and drew a plain one two cells it never had.
 *
 * So the recorded kind is taken at its word over any document reading, and
 * the old derivation survives only where there is no record to read.
 */
describe("the cell set the recorded kind chooses", () => {
  const cases: Array<[string, ArcTrackInput, boolean]> = [
    // The kind is taken at its word, against documents that say otherwise.
    ["planned with no brief and no plan still draws six", { arcKind: "planned", stage: "working" }, true],
    ["planned over a task list still draws six", { arcKind: "planned", documents: { plan: "/p" }, taskList: true, stage: "working" }, true],
    ["plain with a brief and a devised plan still draws four", { arcKind: "plain", documents: PLAN, stage: "working" }, false],
    // [F04]'s consequence, at the shape that produced it: an arc off the plain
    // door has a brief AND a run record, so every clause of `direct` is false.
    ["plain with the brief and run record its door writes draws four", { arcKind: "plain", documents: { brief: "/b", plan: "/p" }, taskList: true, arc: { stage: "implement" }, steps: steps(1, 2, 3), stage: "implementing" }, false],
    // And with no record, the derivation is exactly what it always was.
    ["a pre-kind arc with a brief and a devised plan falls back to six", { documents: PLAN, stage: "working" }, true],
    ["a pre-kind arc with nothing falls back to four", { stage: "working" }, false],
    ["a pre-kind arc on a task list falls back to four", { documents: { plan: "/p" }, taskList: true, stage: "working" }, false],
  ];
  for (const [name, input, planned] of cases) {
    test(name, () => {
      expect(arcTrackModel(input).planned).toBe(planned);
    });
  }

  test("the kind moves the cell set without moving `direct`", () => {
    // The two axes are independent, and this is the pair that proves it: the
    // same hand-worked input reads `direct` both times, and only the recorded
    // kind decides whether devise and review are drawn.
    const hand: ArcTrackInput = { documents: { plan: "/p" }, taskList: true, stage: "working" };
    const plain = arcTrackModel({ ...hand, arcKind: "plain" });
    const planned = arcTrackModel({ ...hand, arcKind: "planned" });
    expect(plain.direct).toBe(true);
    expect(planned.direct).toBe(true);
    expect(plain.planned).toBe(false);
    expect(planned.planned).toBe(true);
    // The phase arm still reads off `direct`, so it is unmoved by the kind.
    expect(plain.phase).toBe(planned.phase);
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

  test("still leaves the plan walked, so the phase is the audit", () => {
    const statuses = Array.from({ length: 8 }, (_, i) => (i === 6 ? "withdrawn" : "done"));
    const model = arcTrackModel({ documents: PLAN, steps: ledger(...statuses), stage: "working" });
    expect(model.phase).toBe("audit");
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
