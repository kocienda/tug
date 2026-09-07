/**
 * The track's derivation is pure, so it is a table: the feed's fields in, the
 * phase and states out.
 */

import { describe, expect, test } from "bun:test";

import {
  arcCellState,
  arcCellWord,
  arcCellTip,
  arcReading,
  arcSessionPurpose,
  arcTrackModel,
  arcTrackSteps,
  tickState,
  type ArcPhase,
  type ArcTrackInput,
  type ArcTrackModel,
} from "../tug-arc-track";
import { arcPhaseWord } from "@/components/tugways/arc-phase-mark";
import { PLANNED_KIND_SENTENCE } from "@/lib/arc-meta-facts";

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

/**
 * The one derivation every face that speaks the phase reads. Pure over the
 * model, so the words are a table and the `live` bit is read off inputs
 * separately — the two questions are "which word for this phase and state"
 * and "which state is this arc in", and conflating them was the old line's
 * whole fault.
 */
describe("arcReading", () => {
  const model = (over: Partial<ArcTrackModel>): ArcTrackModel => ({
    direct: false,
    planned: true,
    phase: "implement",
    stopped: null,
    stoppedWhy: null,
    live: false,
    steps: null,
    ...over,
  });

  // Every phase, both ways. The four that read the same either way say so by
  // repeating themselves, which is the fact rather than an omission.
  const words: Array<[ArcPhase, string, string]> = [
    ["brief", "Briefed", "Briefed"],
    ["devise", "Devising", "Devising"],
    ["review", "Reviewing", "Awaiting review"],
    ["implement", "Implementing", "Implementing"],
    ["audit", "Auditing", "Awaiting audit"],
    ["join", "Finished", "Finished"],
  ];
  for (const [phase, alive, resting] of words) {
    test(`${phase} reads ${alive} live and ${resting} at rest`, () => {
      expect(arcReading(model({ phase, live: true })).word).toBe(alive);
      expect(arcReading(model({ phase, live: false })).word).toBe(resting);
    });
  }

  test("the fraction follows the verb while a step is in hand", () => {
    const reading = arcReading(
      model({ phase: "implement", live: true, steps: arcTrackSteps(steps(2, 3, 6)) }),
    );
    expect(reading.word).toBe("Implementing");
    expect(reading.fraction).toBe("3/6");
  });

  // The case the fraction rule exists for: the ledger is walked, no step is
  // in hand, and a count after the verb would read as progress through an
  // audit that has no steps.
  test("a walked ledger under audit reads Auditing, not Auditing 6/6", () => {
    const walked = arcTrackModel({
      documents: PLAN,
      steps: steps(6, null, 6),
      stage: "ready",
      holdersBusy: true,
    });
    expect(walked.phase).toBe("audit");
    expect(walked.live).toBe(true);
    expect(arcReading(walked)).toEqual({ word: "Auditing", fraction: null });
  });

  // A stop outranks the phase entirely: the word is `Stopped`, the reason is
  // the log's own word left as written, and where it stopped is the red cell
  // on the strip rather than anything on the line.
  test("a stop reads Stopped and the reason word off the record", () => {
    const stopped = arcTrackModel({
      documents: PLAN,
      arc: {
        stage: "implement",
        stopped: "needs a decision",
        stopped_stage: "implement",
        stopped_why: "it met a decision that is yours to make, so it stopped rather than asking",
      },
      steps: steps(2, 3, 6),
      stage: "working",
    });
    expect(arcReading(stopped)).toEqual({ word: "Stopped · needs a decision", fraction: null });
    // The sentence rides on the model for the hover to say, and is never the
    // line's own words.
    expect(stopped.stoppedWhy).toBe(
      "it met a decision that is yours to make, so it stopped rather than asking",
    );
    expect(stopped.live).toBe(false);
  });

  test("an older server's stop carries no sentence, and that is not an error", () => {
    const stopped = arcTrackModel({
      documents: PLAN,
      arc: { stage: "review", stopped: "lint", stopped_stage: "review" },
      steps: steps(0, null, 4),
      stage: "working",
    });
    expect(arcReading(stopped).word).toBe("Stopped · lint");
    expect(stopped.stoppedWhy).toBeNull();
  });
});

/**
 * `live` is the bit the two done-*to*-an-arc phases read, and it is derived
 * from the same two facts `arrived` is: a run in flight, or a holder mid-turn.
 */
describe("the live bit", () => {
  test("a run in flight is live", () => {
    expect(arcTrackModel({ documents: PLAN, arc: { stage: "review" } }).live).toBe(true);
  });

  test("a plan nobody is reading is not, and says Awaiting review", () => {
    const resting = arcTrackModel({ documents: PLAN, steps: steps(0, null, 4) });
    expect(resting.phase).toBe("review");
    expect(resting.live).toBe(false);
    expect(arcReading(resting).word).toBe("Awaiting review");
  });

  test("a busy holder with no run is live", () => {
    expect(
      arcTrackModel({ documents: PLAN, steps: steps(0, null, 4), holdersBusy: true }).live,
    ).toBe(true);
  });

  test("a stopped run is not live, and neither is a finished one", () => {
    expect(
      arcTrackModel({
        documents: PLAN,
        arc: { stage: "review", stopped: "lint", stopped_stage: "review" },
      }).live,
    ).toBe(false);
    expect(
      arcTrackModel({ documents: PLAN, arc: { stage: "audit", done: true }, stage: "audited" }).live,
    ).toBe(false);
  });

  // Implement is not one of the two: a hand-worked arc between turns is still
  // in its implementing phase, and nobody is waiting on anything.
  test("implement reads the same at rest as in flight", () => {
    const resting = arcTrackModel({
      documents: PLAN,
      steps: steps(1, 2, 4),
      stage: "working",
    });
    expect(resting.live).toBe(false);
    expect(arcReading(resting)).toEqual({ word: "Implementing", fraction: "2/4" });
  });
});

/**
 * The cells' three-form grammar ([B09]): `Not yet <past participle>` before,
 * the verb in progress during, the participle after. Held as a table so a
 * reader learns the pattern once, and tested as one for the same reason.
 */
describe("arcCellTip", () => {
  const model = (over: Partial<ArcTrackModel>): ArcTrackModel => ({
    direct: false,
    planned: false,
    phase: "implement",
    stopped: null,
    stoppedWhy: null,
    live: false,
    steps: null,
    ...over,
  });

  const forms: Array<[ArcPhase, string, string, string]> = [
    ["brief", "Not yet briefed", "Briefed", "Briefed"],
    ["devise", "Not yet devised", "Devising", "Devised"],
    ["review", "Not yet reviewed", "Reviewing", "Reviewed"],
    ["implement", "Not yet implemented", "Implementing", "Implemented"],
    ["audit", "Not yet audited", "Auditing", "Audited"],
    // The join cell says what is LEFT: `Finished` alone on a cell reads as
    // though the arc were over, and the arc is over when it has joined.
    ["join", "Not yet joined", "Finished — the join is next", "Joined"],
  ];
  for (const [phase, pending, active, done] of forms) {
    test(`${phase}: ${pending} · ${active} · ${done}`, () => {
      const live = model({ phase, live: true });
      expect(arcCellTip(live, phase, "pending")).toBe(pending);
      expect(arcCellTip(live, phase, "active")).toBe(active);
      expect(arcCellTip(live, phase, "done")).toBe(done);
    });
  }

  test("the two phases that rest say so on their cells too", () => {
    const resting = model({ live: false });
    expect(arcCellTip(resting, "review", "active")).toBe("Awaiting review");
    expect(arcCellTip(resting, "audit", "active")).toBe("Awaiting audit");
  });

  // The one cell with ticks under it is the one that counts them.
  test("the implement cell counts, in the participle's own grammar", () => {
    const walking = model({ live: true, steps: arcTrackSteps(steps(3, 4, 6)) });
    expect(arcCellTip(walking, "implement", "active")).toBe(
      "Implementing · 3 of 6 steps closed",
    );
    expect(arcCellTip(walking, "implement", "done")).toBe("Implemented · 6 steps");
    const one = model({ steps: arcTrackSteps(steps(1, null, 1)) });
    expect(arcCellTip(one, "implement", "done")).toBe("Implemented · 1 step");
    // A plan the entry carries no ledger for keeps the bare participles.
    expect(arcCellTip(model({ live: true }), "implement", "active")).toBe("Implementing");
    expect(arcCellTip(model({}), "implement", "done")).toBe("Implemented");
  });

  /**
   * A stop happened while somebody was at it, so a stopped cell takes the
   * LIVE word whatever the model's `live` bit reads — `Reviewing — stopped: …`
   * and never `Awaiting review — stopped: …`, which would say nobody was
   * there when the thing that stopped was the person who was.
   */
  test("a stopped cell says what was being done, and the stop's own sentence", () => {
    const stopped = arcTrackModel({
      documents: PLAN,
      arc: {
        stage: "review",
        stopped: "lint",
        stopped_stage: "review",
        stopped_why: "the plan does not lint",
      },
      steps: steps(0, null, 4),
      stage: "working",
    });
    expect(stopped.live).toBe(false);
    expect(arcCellState(stopped, "review")).toBe("stopped");
    expect(arcCellTip(stopped, "review", "stopped")).toBe(
      "Reviewing — stopped: the plan does not lint",
    );
  });

  test("an older server's stop falls back to the log's word", () => {
    const stopped = arcTrackModel({
      documents: PLAN,
      arc: { stage: "review", stopped: "lint", stopped_stage: "review" },
      steps: steps(0, null, 4),
      stage: "working",
    });
    expect(arcCellTip(stopped, "review", "stopped")).toBe("Reviewing — stopped: lint");
  });

  test("the Devise cell of a planned arc says what the kind means, on a second line", () => {
    const planned = model({ planned: true });
    expect(arcCellTip(planned, "devise", "done")).toBe(`Devised\n${PLANNED_KIND_SENTENCE}`);
    expect(arcCellTip(planned, "review", "done")).toBe("Reviewed");
    expect(arcCellTip(model({ planned: false }), "devise", "pending")).toBe("Not yet devised");
  });
});

/**
 * The Z2 ARC cell, which shows a word only when it has no numbers — the same
 * vocabulary as the line, cut to what 18ch will hold.
 */
describe("the Z2 cell's word", () => {
  const face = (over: Partial<ArcTrackModel>): ArcTrackModel => ({
    direct: false,
    planned: true,
    phase: "implement",
    stopped: null,
    stoppedWhy: null,
    live: false,
    steps: null,
    ...over,
  });

  test("it is the line's own word for a phase", () => {
    expect(arcCellWord(face({ phase: "review", live: false }))).toBe("Awaiting review");
    expect(arcCellWord(face({ phase: "review", live: true }))).toBe("Reviewing");
    expect(arcCellWord(face({ phase: "join" }))).toBe("Finished");
  });

  // The longest word the cell can be asked to hold, against the box it holds
  // it in. A reading that elides is a reading that is not true.
  test("the longest reading fits the cell's 18ch", () => {
    expect("Awaiting review".length).toBeLessThanOrEqual(18);
  });

  // The clause the cell cannot hold: the reason is on the placard one press
  // away, and the cell says only that there is one.
  test("a stop is one word here, not the line's whole clause", () => {
    const stopped = arcTrackModel({
      documents: PLAN,
      arc: { stage: "implement", stopped: "needs a decision", stopped_stage: "implement" },
      steps: steps(2, 3, 6),
      stage: "working",
    });
    expect(arcReading(stopped).word).toBe("Stopped · needs a decision");
    expect(arcCellWord(stopped)).toBe("Stopped");
  });

  test("an arc with no ledger at all reads Cut", () => {
    const direct = arcTrackModel({ documents: {}, stage: "working" });
    expect(direct.direct).toBe(true);
    expect(arcCellWord(direct)).toBe("Cut");
  });

  // `Cut` is the branch and nothing else. A hand-worked arc that wrote itself
  // a task list has a ledger, so the cell owes it the phase word — it shows a
  // fraction while it walks one, and this once it stops.
  test("a hand-worked arc that wrote a task list is not a cut", () => {
    const walked = arcTrackModel({
      documents: { plan: "/tasks" },
      taskList: true,
      steps: steps(4, null, 4),
      stage: "working",
    });
    expect(walked.direct).toBe(true);
    expect(walked.phase).toBe("audit");
    expect(arcCellWord(walked)).toBe("Awaiting audit");
  });
});

/**
 * The compact register — the masthead's mark and the Arcs card's rows — reads
 * the same word, with the stop naming the phase its glyph gave up.
 */
describe("the mark's word", () => {
  test("it is the line's word while the arc runs", () => {
    const walking = arcTrackModel({
      documents: PLAN,
      arc: { stage: "implement" },
      steps: steps(1, 2, 4),
      stage: "implementing",
    });
    expect(arcPhaseWord(walking)).toBe("Implementing");
    expect(
      arcPhaseWord(arcTrackModel({ documents: PLAN, steps: steps(4, null, 4), stage: "working" })),
    ).toBe("Awaiting audit");
  });

  // The glyph is the stop's octagon by then, so the phase is nowhere else in
  // the reading — unlike the line, whose track lights the cell it stopped in.
  test("a stop names the phase the glyph stopped showing", () => {
    const stopped = arcTrackModel({
      documents: PLAN,
      arc: { stage: "review", stopped: "needs a decision", stopped_stage: "review" },
      steps: steps(0, null, 4),
      stage: "working",
    });
    expect(arcPhaseWord(stopped)).toBe("Stopped in review · needs a decision");
  });
});

/**
 * The description line's register: what the SESSION seated on the arc is here
 * to do. The rung exists because a wheel-seated stage session reaches it — the
 * two rungs above it are facts about the user typing, and a stage session's
 * only submission is the `/tugplug:arc-…` command neither of them reads.
 */
describe("a seated session's purpose", () => {
  const model = (over: Partial<ArcTrackModel>): ArcTrackModel => ({
    direct: false,
    planned: true,
    phase: "implement",
    stopped: null,
    stoppedWhy: null,
    live: false,
    steps: null,
    ...over,
  });

  // Every phase, so a phase added to the union cannot reach the description
  // line with nothing to say — which is the failure this rung was added for.
  const purposes: Array<[ArcPhase, string]> = [
    ["brief", "Writing the brief"],
    ["devise", "Devising a plan"],
    ["review", "Reviewing the plan"],
    ["implement", "Implementing the plan"],
    ["audit", "Auditing the branch"],
    ["join", "Finished — the join is next"],
  ];
  for (const [phase, purpose] of purposes) {
    test(`${phase} is for ${purpose.toLowerCase()}`, () => {
      expect(arcSessionPurpose(model({ phase }))).toBe(purpose);
    });
  }

  // Both ways round, because a purpose is what the session is FOR and that
  // does not change when the work pauses — unlike the cell's own reading,
  // where two phases read differently at rest.
  test("it reads the same live and at rest", () => {
    for (const [phase] of purposes) {
      expect(arcSessionPurpose(model({ phase, live: true }))).toBe(
        arcSessionPurpose(model({ phase, live: false })),
      );
    }
  });

  // The one phase where the two kinds do different work under one phase word.
  test("a plain arc walks a task list where a planned one implements a plan", () => {
    expect(arcSessionPurpose(model({ phase: "implement", planned: false }))).toBe(
      "Walking the task list",
    );
    expect(arcSessionPurpose(model({ phase: "implement", planned: true }))).toBe(
      "Implementing the plan",
    );
  });

  // Only at implement: the kind is what the ledger IS, and no other stage
  // reads it.
  test("the kind changes no other stage's sentence", () => {
    for (const [phase, purpose] of purposes) {
      if (phase === "implement") continue;
      expect(arcSessionPurpose(model({ phase, planned: false }))).toBe(purpose);
    }
  });

  // A stopped session is not doing the thing its stage is named for, and it
  // says so in the same words the line does.
  test("a stop outranks the purpose, in the line's own words", () => {
    const stopped = model({ phase: "devise", stopped: "needs a decision" });
    expect(arcSessionPurpose(stopped)).toBe("Stopped · needs a decision");
    expect(arcSessionPurpose(stopped)).toBe(arcReading(stopped).word);
  });

  // The floor is a floor: no model reaches the description line empty.
  test("no phase, kind, or liveness yields an empty line", () => {
    for (const [phase] of purposes) {
      for (const planned of [true, false]) {
        for (const live of [true, false]) {
          expect(arcSessionPurpose(model({ phase, planned, live })).length).toBeGreaterThan(0);
        }
      }
    }
  });
});
