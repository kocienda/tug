/**
 * arc-time — placing a card's turns inside its arc's windows.
 *
 * The fixture is `resolve-ledger-rollout` as its arc log read on 2026-10-27:
 * devise, review, five steps done with a compaction after steps 3 and 5, and
 * step 6 open. Turn times are a few seconds inside each window.
 */

import { describe, expect, test } from "bun:test";

import { compactNoteText, computeArcTime, median, type ArcTimeInput, type ArcTimeTurnInput } from "@/lib/arc-time";
import type { ArcStep, ArcTimeline } from "@/lib/changeset-types";

const MIN = 60_000;
const SEC = 1_000;
const T0 = Date.parse("2026-10-27T15:42:05.922Z");
const at = (m: number, s = 0) => T0 + m * MIN + s * SEC;

const timeline: ArcTimeline = {
  stages: [
    { stage: "devise", at_ms: at(0), model: "opus" },
    { stage: "review", at_ms: at(15, 30), model: "opus" },
    { stage: "implement", at_ms: at(26, 39), model: "opus" },
  ],
  steps: [
    { n: 1, total: 10, title: "Sheets, register and DOCUMENTS", spans: [{ start_ms: at(27, 7), end_ms: at(34, 55) }], end: "done", commit: "315f6074a" },
    { n: 2, total: 10, title: "The fold receipt, answered", spans: [{ start_ms: at(35, 9), end_ms: at(41, 29) }], end: "done", commit: "c58caa002" },
    { n: 3, total: 10, title: "REPORT as a ledger of blocks", spans: [{ start_ms: at(41, 45), end_ms: at(49, 17) }], end: "done", commit: "141592268" },
    { n: 4, total: 10, title: "Every rung reports", spans: [{ start_ms: at(50, 36), end_ms: at(64, 38) }], end: "done", commit: "f6c778d6c" },
    { n: 5, total: 10, title: "The resolver's stream is relayed", spans: [{ start_ms: at(64, 54), end_ms: at(72, 2) }], end: "done", commit: "86ce45a3a" },
    { n: 6, total: 10, title: "Resolve again", spans: [{ start_ms: at(73, 15) }] },
  ],
  marks: [
    { kind: "compact", at_ms: at(49, 29), note: "397050 > 300000" },
    { kind: "compact", at_ms: at(72, 10), note: "381982 > 300000" },
  ],
  run_through: 10,
  typical_audit_ms: 19 * MIN + 42 * SEC,
};

const ledger: ArcStep[] = [
  "Sheets, register and DOCUMENTS",
  "The fold receipt, answered",
  "REPORT as a ledger of blocks",
  "Every rung reports",
  "The resolver's stream is relayed",
  "Resolve again",
  "The durable ledger",
  "The base-motion receipt",
  "Migrate the spike's CSS and delete the spike",
  "Integration Checkpoint",
].map((title, i) => ({ title, status: i < 5 ? "done" : i === 5 ? "in progress" : "pending" }));

/** A turn that started at `start` and ran `wall`, `active` of it working. */
const turn = (start: number, wall: number, active = wall - 5 * SEC): ArcTimeTurnInput => ({
  endedAt: start + wall,
  wallClockMs: wall,
  activeMs: active,
});

const transcript: ArcTimeTurnInput[] = [
  turn(at(-3), 2 * MIN), // the /arc conversation, before the first rotation
  turn(at(0, 1), 15 * MIN + 25 * SEC), // devise
  turn(at(15, 31), 11 * MIN + 5 * SEC), // review
  turn(at(26, 40), 8 * MIN + 20 * SEC, 7 * MIN + 41 * SEC), // step 1
  turn(at(35, 0), 6 * MIN + 35 * SEC, 6 * MIN + 14 * SEC), // step 2
  turn(at(41, 30), 7 * MIN + 50 * SEC, 7 * MIN + 27 * SEC), // step 3
  turn(at(49, 25), 60 * SEC), // compaction
  turn(at(50, 30), 9 * MIN + 30 * SEC, 9 * MIN + 20 * SEC), // step 4, ends on a question
  turn(at(61, 10), 3 * MIN + 35 * SEC, 3 * MIN + 24 * SEC), // step 4, answered
  turn(at(64, 50), 7 * MIN + 20 * SEC, 7 * MIN + 2 * SEC), // step 5
  turn(at(72, 8), 60 * SEC), // compaction
];

const base: ArcTimeInput = {
  timeline,
  ledger,
  stopped: false,
  done: false,
  transcript,
  inflightMs: 2 * MIN + 14 * SEC,
  nowMs: at(75, 30),
};

describe("computeArcTime", () => {
  test("turns land in their stages, and the opening conversation sits before the arc", () => {
    const r = computeArcTime(base);
    expect(r.before?.turns.map((t) => t.index)).toEqual([0]);
    expect(r.stages.map((s) => s.stage)).toEqual(["devise", "review", "implement", "audit"]);
    expect(r.stages[0].turns.map((t) => t.index)).toEqual([1]);
    expect(r.stages[1].turns.map((t) => t.index)).toEqual([2]);
    expect(r.stages[2].current).toBe(true);
    expect(r.stages[2].live).toBe(true);
  });

  test("each step carries its own turns, and a question makes step 4 two", () => {
    const r = computeArcTime(base);
    const steps = r.stages[2].items.flatMap((i) => (i.kind === "step" ? [i.step] : []));
    expect(steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(steps.map((s) => s.turns.length)).toEqual([1, 1, 1, 2, 1, 1]);
    expect(steps[3].activeMs).toBe(12 * MIN + 44 * SEC);
    expect(steps[3].wallMs).toBe(14 * MIN + 2 * SEC);
    expect(steps[0].commit).toBe("315f6074a");
  });

  test("compaction turns are the compaction marks' cost, in time order", () => {
    const r = computeArcTime(base);
    const kinds = r.stages[2].items.map((i) => (i.kind === "step" ? `s${i.step.n}` : i.kind));
    expect(kinds).toEqual(["s1", "s2", "s3", "mark", "s4", "s5", "mark", "s6"]);
    const marks = r.stages[2].items.flatMap((i) => (i.kind === "mark" ? [i] : []));
    expect(marks.map((m) => m.turns.map((t) => t.index))).toEqual([[6], [10]]);
    expect(r.stages[2].items.some((i) => i.kind === "between")).toBe(false);
  });

  test("the median is the finished steps', and step 4 is slow against it", () => {
    const r = computeArcTime(base);
    expect(r.medianStepMs).toBe(7 * MIN + 27 * SEC);
    expect(r.slowestStep).toBe(4);
    const steps = r.stages[2].items.flatMap((i) => (i.kind === "step" ? [i.step] : []));
    expect(steps.filter((s) => s.slow).map((s) => s.n)).toEqual([4]);
  });

  test("the open step is live and projects what is left at the median", () => {
    const r = computeArcTime(base);
    const open = r.stages[2].items.flatMap((i) => (i.kind === "step" && i.step.state === "open" ? [i.step] : []))[0];
    expect(open.live).toBe(true);
    expect(open.activeMs).toBe(2 * MIN + 14 * SEC);
    expect(open.projectedMs).toBe(7 * MIN + 27 * SEC - (2 * MIN + 14 * SEC));
  });

  test("pending steps are the run's unopened rows, each at the median", () => {
    const r = computeArcTime(base);
    expect(r.pending.map((p) => p.n)).toEqual([7, 8, 9, 10]);
    expect(r.pending.every((p) => p.projectedMs === 7 * MIN + 27 * SEC)).toBe(true);
    expect(r.stepsDone).toBe(5);
    expect(r.stepsTotal).toBe(10);
  });

  test("the projected total adds the open step's rest, the pending steps and the typical audit", () => {
    const r = computeArcTime(base);
    const audit = r.stages[3];
    expect(audit.upcoming).toBe(true);
    expect(audit.projectedMs).toBe(19 * MIN + 42 * SEC);
    const left = 7 * MIN + 27 * SEC - (2 * MIN + 14 * SEC) + 4 * (7 * MIN + 27 * SEC) + 19 * MIN + 42 * SEC;
    expect(r.projectedTotalMs).toBe(r.soFarMs + left);
    expect(r.noProjection).toBeNull();
  });

  test("a stopped arc projects nothing and says why", () => {
    const r = computeArcTime({ ...base, stopped: true, inflightMs: null });
    expect(r.projectedTotalMs).toBeNull();
    expect(r.noProjection).toBe("stopped");
    expect(r.pending.every((p) => p.projectedMs === null)).toBe(true);
    expect(r.stages.some((s) => s.upcoming)).toBe(false);
  });

  test("one finished step is too early to take a pace from", () => {
    const early: ArcTimeline = { ...timeline, steps: timeline.steps!.slice(0, 2).map((s, i) => (i === 1 ? { ...s, end: undefined, commit: undefined, spans: [{ start_ms: s.spans[0].start_ms }] } : s)) };
    const r = computeArcTime({ ...base, timeline: early, transcript: transcript.slice(0, 5), nowMs: at(37) });
    expect(r.medianStepMs).toBeNull();
    expect(r.noProjection).toBe("too-early");
    expect(r.slowestStep).toBeNull();
  });

  test("a run of 5–7 owes nothing for the steps before it", () => {
    const run: ArcTimeline = { ...timeline, run_through: 7, steps: timeline.steps!.slice(4) };
    const open = ledger.map((s, i) => ({ ...s, status: i < 4 ? "pending" : s.status }));
    const r = computeArcTime({ ...base, timeline: run, ledger: open });
    expect(r.pending.map((p) => p.n)).toEqual([7]);
    expect(r.stepsTotal).toBe(3);
  });

  test("a turn outside every step and every compaction sits between steps", () => {
    const extra = [...transcript, turn(at(64, 39), 10 * SEC)];
    const r = computeArcTime({ ...base, transcript: extra });
    const between = r.stages[2].items.filter((i) => i.kind === "between");
    expect(between).toHaveLength(1);
  });
});

describe("median", () => {
  test("odd, even and empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(3);
    expect(median([])).toBeNull();
  });
});

describe("compactNoteText", () => {
  test("token counts read in thousands; anything else verbatim", () => {
    expect(compactNoteText("397050 > 300000")).toBe("397k > 300k");
    expect(compactNoteText("compacted at 0.73 > 0.60")).toBe("compacted at 0.73 > 0.60");
  });
});
