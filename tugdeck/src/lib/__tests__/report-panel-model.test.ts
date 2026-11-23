import { describe, expect, test } from "bun:test";

import {
  CELLS_UP_TO,
  FAILURE_PREVIEW_CHARS,
  FAILURE_PREVIEW_LINES,
  failurePreview,
  formatSecs,
  laneSlots,
  nextActFor,
  projectionText,
  reportPanelModel,
  reportPanels,
  unitWord,
  verdictSentence,
} from "../report-panel-model";
import type { Report, Run, RunUnit } from "../report-store";

const NOW = 100_000;

function file(name: string, index: number, rest: Partial<RunUnit>): RunUnit {
  return { name, index, status: "pending", ...rest };
}

/** Chunk c05, frozen mid-run: four landed (one red), two in flight, four to come. */
const MID_RUN: Run = {
  runId: "r",
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

describe("reportPanelModel", () => {
  test("mid-run: the tally, the lanes' elapsed, the reds, and cells for a whole small batch", () => {
    const m = reportPanelModel(MID_RUN, "running", NOW);
    expect(m.counts).toEqual({ pass: 3, red: 1, fail: 1, stalled: 0, skipped: 0, pending: 4, unreported: 0 });
    expect(m.track).toBe("cells");
    expect(m.lanes.map((l) => [l.unit.name, l.elapsedSecs])).toEqual([
      ["at0341", 12],
      ["at0352", 31],
    ]);
    expect(m.reds.map((u) => u.name)).toEqual(["at0339"]);
    expect(m.verdict).toBe("running");
  });

  test("the projection is the medians left, a running file's less what it has spent, over the jobs", () => {
    const m = reportPanelModel(MID_RUN, "running", NOW);
    // pending 7+6+8+12 = 33; at0341 9-12 → 0; at0352 11-31 → 0. Over 2 jobs.
    expect(m.projectionSecs).toBe(16.5);
    expect(projectionText(m)).toBe("~17s left");
  });

  test("units no median knows are counted at the typical median", () => {
    const units = MID_RUN.units!.map((u) => (u.name === "at0372" || u.name === "at0381" ? { ...u, median: undefined } : u));
    const m = reportPanelModel({ ...MID_RUN, units }, "running", NOW);
    // The two unknowns are taken at the typical median, (6+8+5+9+9+11+7+6)/8 = 7.625.
    expect(m.unknownCount).toBe(2);
    expect(m.projectionSecs).toBeCloseTo((7 + 6 + 7.625 + 7.625) / 2);
    expect(projectionText(m)).toBe("~14s left · 2 unknown");
    // Finished, there is no projection.
    const done = reportPanelModel({ ...MID_RUN, units }, "finished", NOW);
    expect(projectionText(done)).toBeNull();
  });

  test("a red verdict names the act that lists its reds; a green one names none", () => {
    expect(nextActFor("app-test", "file")).toBe("see the Failures section");
    expect(nextActFor("rust", "test")).toBe("tugtool test last --failures");
    expect(nextActFor("bun", "file")).toBe("tugtool test last --failures");
    expect(nextActFor("build-app", "phase")).toBeNull();
    expect(nextActFor("arc verify", "surface")).toBeNull();
    const red = reportPanelModel(MID_RUN, "finished", NOW);
    expect(red.nextAct).toBe("see the Failures section");
    const rust: Run = { runId: "r", label: "rust", done: 10, total: 10, failures: 0, unit: "test", units: [] };
    expect(reportPanelModel(rust, "finished", NOW).nextAct).toBeNull();
    expect(reportPanelModel({ ...rust, failures: 2 }, "finished", NOW).nextAct).toBe("tugtool test last --failures");
  });

  test("a green row with a history line is a recovery, and the verdict counts it", () => {
    const run: Run = {
      runId: "r",
      label: "app-test",
      done: 2,
      total: 2,
      unit: "file",
      finished: true,
      units: [
        file("at0578", 0, { status: "pass", secs: 9, history: "red in the last 2 recorded runs, back to abc (2026-10-19)" }),
        file("at0601", 1, { status: "pass", secs: 4 }),
      ],
    };
    const m = reportPanelModel(run, "finished", NOW);
    expect(m.recovered.map((u) => u.name)).toEqual(["at0578"]);
    expect(m.verdict).toBe("green");
    expect(verdictSentence(m)).toBe("2 files passed · 1 recovered");
  });

  test("phase rows ride above the units, and a phase still running lands once the units begin", () => {
    const phases: RunUnit[] = [
      file("build", 0, { status: "pass", secs: 40 }),
      file("sign", 1, { status: "running", startedAtMs: NOW - 5_000 }),
    ];
    const pending = { ...MID_RUN, units: MID_RUN.units!.map((u) => ({ ...u, status: "pending" as const })) };
    const before = reportPanelModel(pending, "running", NOW, { phases });
    expect(before.phases.map((u) => u.status)).toEqual(["pass", "running"]);
    const during = reportPanelModel(MID_RUN, "running", NOW, { phases });
    expect(during.phases.map((u) => u.status)).toEqual(["pass", "pass"]);
    expect(reportPanelModel(MID_RUN, "running", NOW).phases).toEqual([]);
  });

  test("a report carrying only some units is a band, and its tally comes from the counts", () => {
    const tests: Run = {
      runId: "r",
      label: "rust",
      done: 812,
      total: 1412,
      failures: 3,
      unit: "test",
      units: [{ name: "jots::reopen_keeps_chips", status: "fail", index: 437 }],
    };
    const m = reportPanelModel(tests, "running", NOW);
    expect(m.track).toBe("band");
    expect(m.listed).toBe(false);
    expect(m.counts.red).toBe(3);
    expect(m.counts.pass).toBe(809);
    expect(m.projectionSecs).toBeNull();
    expect(m.band.pass).toBeCloseTo(809 / 1412);
    expect(m.band.red).toBeCloseTo(3 / 1412);
    expect(m.band.marks).toBe(true);
  });

  test("a band paints outcome, not progress: one pass and one fail is half green, half red", () => {
    const swift: Run = {
      runId: "r",
      label: "swift test",
      done: 2,
      total: 2,
      failures: 1,
      finished: true,
      unit: "test",
      units: [{ name: "ExtentTests testFramesDrawnAtOnce", status: "fail", index: 0 }],
    };
    const m = reportPanelModel(swift, "finished", NOW, { callFailed: true });
    expect(m.track).toBe("band");
    expect(m.verdict).toBe("red");
    expect(m.band).toEqual({ pass: 0.5, red: 0.5, marks: false });
  });

  test("a whole batch past the cell limit is a band too; an unknown total is no track", () => {
    const units = Array.from({ length: CELLS_UP_TO + 1 }, (_, i) => file(`f${i}`, i, { status: "pass" }));
    const big = reportPanelModel({ ...MID_RUN, total: units.length, units }, "running", NOW);
    expect(big.track).toBe("band");
    const bun = reportPanelModel({ runId: "r", done: 120, unit: "test", units: [] }, "running", NOW);
    expect(bun.track).toBe("none");
  });

  test("finished, a phase still running resolves by the call's outcome", () => {
    const build: Run = {
      runId: "r",
      label: "build-app",
      done: 4,
      total: 5,
      unit: "phase",
      units: [
        file("Rust debug binaries", 0, { status: "pass", secs: 61 }),
        file("re-sign", 1, { status: "running", startedAtMs: NOW }),
      ],
    };
    const ok = reportPanelModel(build, "finished", NOW, { callFailed: false });
    expect(ok.units[1]?.status).toBe("pass");
    expect(ok.verdict).toBe("green");
    const broke = reportPanelModel(build, "finished", NOW, { callFailed: true });
    expect(broke.units[1]?.status).toBe("fail");
    expect(broke.verdict).toBe("red");
    expect(broke.lanes, "a finished run has nothing in flight").toEqual([]);
  });

  test("finished, a listed unit still running or pending never reported, whatever the call did", () => {
    const run: Run = {
      runId: "r",
      label: "app-test",
      done: 1,
      total: 3,
      unit: "file",
      finished: true,
      units: [
        file("a", 0, { status: "pass", secs: 4 }),
        file("b", 1, { status: "running", startedAtMs: NOW }),
        file("c", 2, {}),
      ],
    };
    for (const callFailed of [false, true]) {
      const m = reportPanelModel(run, "finished", NOW, { callFailed });
      expect(m.units.map((u) => u.status)).toEqual(["pass", "unreported", "unreported"]);
      expect(m.counts.unreported).toBe(2);
      expect(m.counts.pending).toBe(0);
    }
  });

  test("the verdict is green only for a finished, fully landed run with no reds", () => {
    const run: Run = {
      runId: "r",
      label: "app-test",
      done: 2,
      total: 2,
      unit: "file",
      finished: true,
      units: [file("a", 0, { status: "pass" }), file("b", 1, { status: "skipped" })],
    };
    expect(reportPanelModel(run, "finished", NOW).verdict).toBe("green");
    expect(reportPanelModel({ ...run, finished: undefined }, "finished", NOW).verdict).toBe("incomplete");
    expect(reportPanelModel(run, "finished", NOW, { callFailed: true }).verdict).toBe("red");
    const short = { ...run, units: [file("a", 0, { status: "pass" }), file("b", 1, {})] };
    expect(reportPanelModel(short, "finished", NOW).verdict).toBe("incomplete");
    expect(reportPanelModel(run, "running", NOW).verdict).toBe("running");
  });

  test("a finished run with cells that never reported is INCOMPLETE and says how many", () => {
    const run: Run = {
      runId: "r",
      label: "app-test",
      done: 3,
      total: 5,
      failures: 0,
      unit: "file",
      finished: true,
      units: [
        file("a", 0, { status: "pass" }),
        file("b", 1, { status: "pass" }),
        file("c", 2, { status: "skipped" }),
        file("d", 3, { status: "running", startedAtMs: NOW }),
        file("e", 4, {}),
      ],
    };
    const m = reportPanelModel(run, "finished", NOW);
    expect(m.verdict).toBe("incomplete");
    expect(m.counts.unreported).toBe(2);
    expect(m.units.filter((u) => u.status === "unreported").map((u) => u.name)).toEqual(["d", "e"]);
    expect(verdictSentence(m)).toBe("3 of 5 files reported · 2 never reported");
    // A run listing only some rows, short of its total, says how far it got.
    const tests: Run = { runId: "r", label: "rust", done: 800, total: 1412, failures: 0, unit: "test", finished: true, units: [] };
    const partial = reportPanelModel(tests, "finished", NOW);
    expect(partial.verdict).toBe("incomplete");
    expect(verdictSentence(partial)).toBe("800 of 1412 tests reported");
  });

  test("a fully landed run that never said it finished is INCOMPLETE", () => {
    const run: Run = {
      runId: "r",
      label: "loop",
      done: 2,
      total: 2,
      unit: "file",
      units: [file("a", 0, { status: "pass" }), file("b", 1, { status: "pass" })],
    };
    const m = reportPanelModel(run, "finished", NOW);
    expect(m.verdict).toBe("incomplete");
    expect(verdictSentence(m)).toBe("the run did not say it finished");
  });

  test("a run with reds is red, and counts what never reported", () => {
    const run: Run = {
      runId: "r",
      label: "app-test",
      done: 2,
      total: 3,
      failures: 1,
      unit: "file",
      finished: true,
      units: [file("a", 0, { status: "pass" }), file("b", 1, { status: "fail" }), file("c", 2, {})],
    };
    const m = reportPanelModel(run, "finished", NOW);
    expect(m.verdict).toBe("red");
    expect(verdictSentence(m)).toBe("1 of 3 files failed · 1 never reported");
  });

  test("a failed call is red, even with no red row", () => {
    const run: Run = {
      runId: "r",
      label: "loop",
      done: 1,
      total: 1,
      unit: "file",
      finished: true,
      units: [file("a", 0, { status: "pass" })],
    };
    expect(reportPanelModel(run, "finished", NOW, { callFailed: true }).verdict).toBe("red");
  });

  test("a phase run needs no flag, and its running phase resolves by the call", () => {
    const build: Run = {
      runId: "r",
      label: "build-app",
      done: 1,
      total: 2,
      unit: "phase",
      units: [file("compile", 0, { status: "pass" }), file("sign", 1, { status: "running", startedAtMs: NOW })],
    };
    const m = reportPanelModel(build, "finished", NOW);
    expect(m.verdict).toBe("green");
    expect(m.units[1]?.status).toBe("pass");
    expect(m.counts.unreported).toBe(0);
  });

  test("the verdict sentence names the unit and what went wrong", () => {
    const finished: Run = {
      ...MID_RUN,
      done: 10,
      finished: true,
      units: (MID_RUN.units ?? []).map((u) =>
        u.name === "at0352"
          ? { ...u, status: "stalled" as const, secs: 120 }
          : u.status === "pending" || u.status === "running"
            ? { ...u, status: "pass" as const, secs: 5 }
            : u,
      ),
    };
    const m = reportPanelModel(finished, "finished", NOW);
    expect(verdictSentence(m)).toBe("1 of 10 files failed, 1 stalled");
    const green = reportPanelModel(
      { ...finished, failures: 0, units: finished.units?.map((u) => ({ ...u, status: "pass" as const })) },
      "finished",
      NOW,
    );
    expect(verdictSentence(green)).toBe("10 files passed");
  });

  test("a run of errors says its count alone, never a fraction or a pass", () => {
    const clean: Run = { runId: "r", label: "bunx tsc", done: 0, total: 0, failures: 0, unit: "error", units: [] };
    expect(reportPanelModel(clean, "finished", NOW).countWords).toBe("no errors");
    expect(reportPanelModel(clean, "running", NOW).countWords).toBe("no errors yet");
    const red: Run = {
      ...clean,
      done: 3,
      total: 3,
      failures: 3,
      units: [{ name: "src/a.ts(1,14)", status: "fail", index: 0, message: "Type 'x' is not assignable" }],
    };
    const m = reportPanelModel(red, "finished", NOW);
    expect(m.countWords).toBe("3 errors");
    expect(m.verdict).toBe("red");
  });

  test("a finished run that counted nothing says so, rather than 0/0", () => {
    const none: Run = { runId: "r", label: "bun test", done: 0, total: 0, unit: "test", units: [] };
    expect(reportPanelModel(none, "finished", NOW).countWords).toBe("no tests");
    expect(reportPanelModel({ ...none, total: undefined }, "finished", NOW).countWords).toBe("no tests");
    expect(reportPanelModel(none, "running", NOW).countWords, "a run still going has not counted yet").toBeNull();
    expect(reportPanelModel(MID_RUN, "finished", NOW).countWords, "a counting run keeps its fraction").toBeNull();
  });

  test("words and times read as a person would say them", () => {
    expect(unitWord("file", 1)).toBe("file");
    expect(unitWord("phase", 4)).toBe("phases");
    expect(formatSecs(5)).toBe("5s");
    expect(formatSecs(250)).toBe("4m 10s");
    expect(formatSecs(16.5)).toBe("17s");
  });
});

describe("reportPanels", () => {
  const entry = (runs: Run[]): Report => ({ toolUseId: "t", runs });
  const BUILD: Run = {
    runId: "b",
    label: "build-app",
    unit: "phase",
    done: 1,
    total: 2,
    units: [file("build", 0, { status: "pass", secs: 40 }), file("sign", 1, { status: "running", startedAtMs: NOW - 5_000 })],
  };
  const surfaces = (deck: RunUnit["status"]): Run => ({
    runId: "v",
    label: "arc verify",
    unit: "surface",
    nests: true,
    done: 1,
    total: 3,
    units: [
      file("docs", 0, { status: "pass", passed: 1, total: 1 }),
      file("deck", 1, deck === "running" ? { status: "running", startedAtMs: NOW - 20_000 } : { status: deck }),
      file("rust", 2, {}),
    ],
  });

  test("a phase run beside a unit run is one panel with a phase band", () => {
    const files = { ...MID_RUN, runId: "f" };
    for (const runs of [[BUILD, files], [files, BUILD]]) {
      const panels = reportPanels(entry(runs), "running", NOW);
      expect(panels.map((m) => m.runId)).toEqual(["f"]);
      expect(panels[0]?.phases.map((u) => u.name)).toEqual(["build", "sign"]);
    }
    // Alone, a phase run is a panel of its own.
    expect(reportPanels(entry([BUILD]), "running", NOW).map((m) => m.unit)).toEqual(["phase"]);
    // Under one label a phase run does not pair: it is the same reporter's run.
    const same = { ...files, label: "build-app" };
    expect(reportPanels(entry([BUILD, same]), "running", NOW).length).toBe(2);
  });

  test("a phase run and a unit run under one parent row are one child with a phase band", () => {
    const under = { under: { runId: "v", slot: 1 } };
    const runs = [surfaces("running"), { ...BUILD, ...under }, { ...MID_RUN, runId: "f", ...under }];
    const [panel, ...rest] = reportPanels(entry(runs), "running", NOW);
    expect(rest).toEqual([]);
    expect(panel?.children.length).toBe(1);
    const child = panel!.children[0]!;
    expect(child.model.runId).toBe("f");
    expect(child.model.phases.map((u) => u.name)).toEqual(["build", "sign"]);
    expect(child.underSlot).toBe(1);
    expect(child.underName).toBe("deck");
  });

  test("two unit runs are two panels in order", () => {
    const panels = reportPanels(entry([{ ...MID_RUN, runId: "one" }, { ...MID_RUN, runId: "two", label: "rust" }]), "running", NOW);
    expect(panels.map((m) => m.runId)).toEqual(["one", "two"]);
  });

  test("a child stays under its row: unfolded while its unit runs, folded once it lands, and kept when the panel is finished", () => {
    const child: Run = {
      runId: "c",
      label: "bun test",
      text: "a FAIL",
      unit: "test",
      done: 120,
      total: 748,
      failures: 1,
      units: [file("a", 0, { status: "fail", title: "assertion failed" })],
      under: { runId: "v", slot: 1 },
      firstAtMs: NOW - 9_000,
      reportAtMs: NOW - 1_000,
    };
    const running = reportPanels(entry([surfaces("running"), child]), "running", NOW);
    expect(running.length).toBe(1);
    expect(running[0]!.children.length).toBe(1);
    const c = running[0]!.children[0]!;
    expect(c.folded).toBe(false);
    expect(c.underSlot).toBe(1);
    expect(c.underName).toBe("deck");
    expect(c.model.verdict).toBe("running");
    expect(c.model.counts.red).toBe(1);
    expect(c.text).toBe("a FAIL");
    expect(c.wallSecs).toBe(8);
    // Its unit landed: the child stays under its row, folded, a finished run of its own.
    const landedPanel = reportPanels(entry([surfaces("fail"), child]), "running", NOW)[0]!;
    expect(landedPanel.children.length).toBe(1);
    const landed = landedPanel.children[0]!;
    expect(landed.folded).toBe(true);
    expect(landed.underSlot).toBe(1);
    expect(landed.underName).toBe("deck");
    expect(landed.model.verdict).toBe("red");
    expect(landed.wallSecs).toBe(8);
    // A finished panel keeps its children, folded, each with its own verdict.
    const finished = reportPanels(entry([surfaces("fail"), child]), "finished", NOW)[0]!;
    expect(finished.children.length).toBe(1);
    expect(finished.children[0]!.folded).toBe(true);
    expect(finished.children[0]!.underName).toBe("deck");
    expect(finished.children[0]!.model.verdict).toBe("red");
  });

  test("two children under two surfaces keep parent slot order", () => {
    const verify: Run = {
      ...surfaces("pass"),
      units: [
        file("docs", 0, { status: "pass" }),
        file("deck", 1, { status: "pass" }),
        file("rust", 2, { status: "running", startedAtMs: NOW - 3_000 }),
      ],
    };
    const rust: Run = { ...MID_RUN, runId: "rust-run", label: "rust", under: { runId: "v", slot: 2 } };
    const deck: Run = { ...MID_RUN, runId: "deck-run", label: "deck", under: { runId: "v", slot: 1 } };
    // The rust child reported first; the deck child's row comes first.
    const [panel] = reportPanels(entry([verify, rust, deck]), "running", NOW);
    expect(panel!.children.map((c) => [c.underName, c.model.runId, c.folded])).toEqual([
      ["deck", "deck-run", true],
      ["rust", "rust-run", false],
    ]);
  });

  test("a child's verdict is its own rows', whatever the call did", () => {
    const green: Run = {
      runId: "c",
      label: "bun test",
      unit: "file",
      done: 2,
      total: 2,
      finished: true,
      units: [file("a", 0, { status: "pass" }), file("b", 1, { status: "pass" })],
      under: { runId: "v", slot: 1 },
    };
    const [panel] = reportPanels(entry([surfaces("pass"), green]), "finished", NOW, { callFailed: true });
    expect(panel!.verdict).toBe("red");
    expect(panel!.children[0]!.model.verdict).toBe("green");
  });

  test("a failed call is the last panel's: an earlier finished, all-green run stays green", () => {
    const green = (runId: string): Run => ({
      runId,
      label: runId,
      unit: "file",
      done: 2,
      total: 2,
      finished: true,
      units: [file("a", 0, { status: "pass" }), file("b", 1, { status: "pass" })],
    });
    const panels = reportPanels(entry([green("first"), green("second")]), "finished", NOW, { callFailed: true });
    expect(panels.map((m) => [m.runId, m.verdict])).toEqual([
      ["first", "green"],
      ["second", "red"],
    ]);
  });

  test("a run with no unit is no panel", () => {
    const line: Run = { runId: "label:rust", label: "rust", text: "compiling" };
    expect(reportPanels(entry([line]), "running", NOW)).toEqual([]);
    expect(reportPanels(entry([line, MID_RUN]), "running", NOW).map((m) => m.runId)).toEqual(["r"]);
  });

  test("a run whose parent is not in the list is a panel of its own", () => {
    const orphan: Run = { ...MID_RUN, runId: "o", under: { runId: "gone", slot: 0 } };
    expect(reportPanels(entry([orphan]), "running", NOW).map((m) => m.runId)).toEqual(["o"]);
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

describe("failurePreview", () => {
  test("a failure inside the budget comes back whole and uncut", () => {
    const p = failurePreview("drag > lands", "Expected 1\nReceived 0");
    expect(p).toEqual({ title: "drag > lands", message: "Expected 1\nReceived 0", cut: false, lines: 3 });
  });

  test("a unit with neither title nor message has nothing to fold", () => {
    expect(failurePreview(undefined, undefined)).toEqual({ cut: false, lines: 0 });
  });

  test("a long message is cut at the line budget the title left", () => {
    const message = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const p = failurePreview("t", message);
    expect(p.cut).toBe(true);
    expect(p.lines).toBe(41);
    expect(p.title).toBe("t");
    const shown = (p.message ?? "").split("\n");
    expect(shown.length).toBe(FAILURE_PREVIEW_LINES - 1);
    expect(shown[shown.length - 1]).toBe(`line ${FAILURE_PREVIEW_LINES - 2}…`);
  });

  test("one enormous line is cut at the character budget", () => {
    const p = failurePreview(undefined, "x".repeat(5000));
    expect(p.cut).toBe(true);
    expect(p.lines).toBe(1);
    expect(p.message).toBe(`${"x".repeat(FAILURE_PREVIEW_CHARS)}…`);
  });

  test("a title that spends the budget holds the whole message back", () => {
    const title = `just app-test-changed ${"'tugdeck/src/some/file.ts' ".repeat(200)}`;
    const p = failurePreview(title, "exit 1");
    expect(p.cut).toBe(true);
    expect(p.message).toBeUndefined();
    expect(p.title?.endsWith("…")).toBe(true);
    expect((p.title ?? "").length).toBeLessThanOrEqual(FAILURE_PREVIEW_CHARS + 1);
  });

  test("the cut never splits a surrogate pair", () => {
    const p = failurePreview(undefined, `${"x".repeat(FAILURE_PREVIEW_CHARS - 1)}😀 tail`);
    expect(p.message).toBe(`${"x".repeat(FAILURE_PREVIEW_CHARS - 1)}…`);
  });
});
