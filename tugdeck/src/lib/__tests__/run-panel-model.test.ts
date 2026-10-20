import { describe, expect, test } from "bun:test";

import { CELLS_UP_TO, formatSecs, laneSlots, runPanelModel, unitWord, verdictSentence } from "../run-panel-model";
import type { RunProgress, RunUnit } from "../run-progress-store";

const NOW = 100_000;

function file(name: string, index: number, rest: Partial<RunUnit>): RunUnit {
  return { name, index, status: "pending", ...rest };
}

/** Chunk c05, frozen mid-run: four landed (one red), two in flight, four to come. */
const MID_RUN: RunProgress = {
  toolUseId: "t",
  label: "app-test",
  text: "at0339 FAIL",
  done: 4,
  total: 10,
  failures: 1,
  unit: "file",
  jobs: 2,
  units: [
    file("at0277", 0, { status: "pass", secs: 7, median: 6 }),
    file("at0303", 1, { status: "pass", secs: 9, median: 8 }),
    file("at0310", 2, { status: "pass", secs: 5, median: 5 }),
    file("at0339", 3, { status: "fail", secs: 14, median: 9, title: "clears", message: "timed out" }),
    file("at0341", 4, { status: "running", startedAtMs: NOW - 12_000, median: 9 }),
    file("at0352", 5, { status: "running", startedAtMs: NOW - 31_000, median: 11 }),
    file("at0360", 6, { median: 7 }),
    file("at0366", 7, { median: 6 }),
    file("at0372", 8, { median: 8 }),
    file("at0381", 9, { median: 12 }),
  ],
};

describe("runPanelModel", () => {
  test("mid-run: the tally, the lanes' elapsed, the reds, and cells for a whole small batch", () => {
    const m = runPanelModel(MID_RUN, "running", NOW);
    expect(m.counts).toEqual({ pass: 3, red: 1, fail: 1, stalled: 0, skipped: 0, pending: 4 });
    expect(m.track).toBe("cells");
    expect(m.lanes.map((l) => [l.unit.name, l.elapsedSecs])).toEqual([
      ["at0341", 12],
      ["at0352", 31],
    ]);
    expect(m.reds.map((u) => u.name)).toEqual(["at0339"]);
    expect(m.verdict).toBe("running");
  });

  test("the projection is the medians left, a running file's less what it has spent, over the jobs", () => {
    const m = runPanelModel(MID_RUN, "running", NOW);
    // pending 7+6+8+12 = 33; at0341 9-12 → 0; at0352 11-31 → 0. Over 2 jobs.
    expect(m.projectionSecs).toBe(16.5);
  });

  test("a report carrying only some units is a band, and its tally comes from the counts", () => {
    const tests: RunProgress = {
      toolUseId: "t",
      label: "rust",
      done: 812,
      total: 1412,
      failures: 3,
      unit: "test",
      units: [{ name: "jots::reopen_keeps_chips", status: "fail", index: 437 }],
    };
    const m = runPanelModel(tests, "running", NOW);
    expect(m.track).toBe("band");
    expect(m.listed).toBe(false);
    expect(m.counts.red).toBe(3);
    expect(m.counts.pass).toBe(809);
    expect(m.projectionSecs).toBeNull();
  });

  test("a whole batch past the cell limit is a band too; an unknown total is no track", () => {
    const units = Array.from({ length: CELLS_UP_TO + 1 }, (_, i) => file(`f${i}`, i, { status: "pass" }));
    const big = runPanelModel({ ...MID_RUN, total: units.length, units }, "running", NOW);
    expect(big.track).toBe("band");
    const bun = runPanelModel({ toolUseId: "t", done: 120, unit: "test", units: [] }, "running", NOW);
    expect(bun.track).toBe("none");
  });

  test("finished, a unit still running resolves by the call's outcome", () => {
    const build: RunProgress = {
      toolUseId: "t",
      label: "build-app",
      done: 4,
      total: 5,
      unit: "phase",
      units: [
        file("Rust debug binaries", 0, { status: "pass", secs: 61 }),
        file("re-sign", 1, { status: "running", startedAtMs: NOW }),
      ],
    };
    const ok = runPanelModel(build, "finished", NOW, { callFailed: false });
    expect(ok.units[1]?.status).toBe("pass");
    expect(ok.verdict).toBe("green");
    const broke = runPanelModel(build, "finished", NOW, { callFailed: true });
    expect(broke.units[1]?.status).toBe("fail");
    expect(broke.verdict).toBe("red");
    expect(broke.lanes, "a finished run has nothing in flight").toEqual([]);
  });

  test("the verdict sentence names the unit and what went wrong", () => {
    const finished: RunProgress = {
      ...MID_RUN,
      done: 10,
      units: (MID_RUN.units ?? []).map((u) =>
        u.name === "at0352"
          ? { ...u, status: "stalled" as const, secs: 120 }
          : u.status === "pending" || u.status === "running"
            ? { ...u, status: "pass" as const, secs: 5 }
            : u,
      ),
    };
    const m = runPanelModel(finished, "finished", NOW);
    expect(verdictSentence(m)).toBe("1 of 10 files failed, 1 stalled");
    const green = runPanelModel(
      { ...finished, failures: 0, units: finished.units?.map((u) => ({ ...u, status: "pass" as const })) },
      "finished",
      NOW,
    );
    expect(verdictSentence(green)).toBe("10 files passed");
  });

  test("words and times read as a person would say them", () => {
    expect(unitWord("file", 1)).toBe("file");
    expect(unitWord("phase", 4)).toBe("phases");
    expect(formatSecs(5)).toBe("5s");
    expect(formatSecs(250)).toBe("4m 10s");
    expect(formatSecs(16.5)).toBe("17s");
  });
});

describe("laneSlots", () => {
  test("a row is never emptied: a landed unit stays until another takes its row", () => {
    let slots = laneSlots([], ["a"]);
    expect(slots).toEqual(["a"]);
    // Between units nothing runs, and the row still shows the last one.
    slots = laneSlots(slots, []);
    expect(slots).toEqual(["a"]);
    slots = laneSlots(slots, ["b"]);
    expect(slots).toEqual(["b"]);
  });

  test("a running unit keeps its row, and rows grow only to the most at once", () => {
    let slots = laneSlots([], ["a", "b"]);
    expect(slots).toEqual(["a", "b"]);
    // `a` lands and `c` starts: `c` takes `a`'s row, `b` does not move.
    slots = laneSlots(slots, ["b", "c"]);
    expect(slots).toEqual(["c", "b"]);
    // The tail of the run: one unit left, and both rows stand.
    slots = laneSlots(slots, ["b"]);
    expect(slots).toEqual(["c", "b"]);
    slots = laneSlots(slots, ["b", "d", "e"]);
    expect(slots).toEqual(["d", "b", "e"]);
  });
});
