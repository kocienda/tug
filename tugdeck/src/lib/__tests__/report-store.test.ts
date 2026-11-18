import { describe, expect, test } from "bun:test";

import {
  ReportStore,
  REPORT_CAP,
  engineLiveness,
  formatReportLine,
  liveElapsedMs,
  narrowRunUnits,
} from "../report-store";

describe("ReportStore — a running command's reports", () => {
  test("the line joins label, count, failures and text", () => {
    expect(
      formatReportLine({
        toolUseId: "t",
        runs: [],
        label: "app-test",
        done: 7,
        total: 20,
        failures: 1,
        text: "at0603 PASS (14/14) 38s",
      }),
    ).toBe("app-test · 7/20 · 1 fail · at0603 PASS (14/14) 38s");
    expect(
      formatReportLine({ toolUseId: "t", runs: [], label: "rust", text: "compiling tugcast" }),
    ).toBe("rust · compiling tugcast");
    expect(
      formatReportLine({ toolUseId: "t", runs: [], label: "rust", done: 3, failures: 0, text: "x" }),
    ).toBe("rust · 3 · x");
  });

  test("a report with no call lands in the card slot", () => {
    const store = new ReportStore();
    let heard = 0;
    store.subscribe(null, () => heard++);
    store.applyReport({ tool_use_id: null, label: "rust", text: "linking" }, 1000);
    expect(store.get(null)?.text).toBe("linking");
    expect(store.get(null)?.reportAtMs).toBe(1000);
    expect(heard).toBe(1);
  });

  test("a card-level report keeps why no call claimed it; a call's report has no reason", () => {
    const store = new ReportStore();
    store.applyReport({ tool_use_id: null, label: "rust", text: "a", unattached: "no open run" }, 1000);
    expect(store.get(null)?.unattached).toBe("no open run");
    store.applyReport({ tool_use_id: null, label: "rust", text: "b" }, 2000);
    expect(store.get(null)?.unattached, "a reason is the latest report's, never kept").toBeUndefined();
    store.applyReport({ tool_use_id: "t", label: "rust", text: "c", unattached: "stray" }, 3000);
    expect(store.get("t")?.unattached).toBeUndefined();
  });

  test("a report keeps the call's heartbeat and replaces the last report whole", () => {
    const store = new ReportStore();
    store.applyHeartbeat("t", 5, 1000);
    store.applyReport({ tool_use_id: "t", label: "rust", text: "a", done: 1, total: 9 }, 2000);
    store.applyReport({ tool_use_id: "t", label: "rust", text: "b" }, 3000);
    const p = store.get("t");
    expect(p?.text).toBe("b");
    expect(p?.done).toBeUndefined();
    expect(p?.engineElapsedMs).toBe(5000);
  });

  test("a closed call's report is ignored unless it is a running background job", () => {
    const store = new ReportStore();
    store.close("fg");
    store.applyReport({ tool_use_id: "fg", text: "late" }, 1000, () => false);
    expect(store.get("fg")).toBeNull();

    store.close("bg");
    store.applyReport({ tool_use_id: "bg", text: "still going" }, 1000, (id) => id === "bg");
    expect(store.get("bg")?.text).toBe("still going");
  });
});

describe("ReportStore — the engine heartbeat", () => {
  test("the elapsed reading carries forward from the last heartbeat", () => {
    const store = new ReportStore();
    store.applyHeartbeat("t", 125, 1000);
    expect(liveElapsedMs(0, store.get("t"), 3000)).toBe(127000);
  });

  test("with no heartbeat the local clock since the start is the reading", () => {
    expect(liveElapsedMs(1000, null, 4500)).toBe(3500);
    expect(liveElapsedMs(5000, null, 4500)).toBe(0);
  });

  test("a tick older than the heartbeat reads the heartbeat, never less", () => {
    const store = new ReportStore();
    store.applyHeartbeat("t", 125, 10_000);
    expect(liveElapsedMs(0, store.get("t"), 9_400)).toBe(125_000);
  });

  test("a heartbeat is live under ten seconds old and quiet after", () => {
    const store = new ReportStore();
    store.applyHeartbeat("t", 1, 1000);
    expect(engineLiveness(store.get("t"), 10_000)).toBe("live");
    expect(engineLiveness(store.get("t"), 12_000)).toBe("quiet");
    expect(engineLiveness(store.get("u"), 12_000)).toBeNull();
  });

  test("a subscriber hears its own key and no other", () => {
    const store = new ReportStore();
    let t = 0;
    let u = 0;
    store.subscribe("t", () => t++);
    store.subscribe("u", () => u++);
    store.applyHeartbeat("t", 1, 1000);
    expect([t, u]).toEqual([1, 0]);
  });

  test("the entry object is stable until it changes", () => {
    const store = new ReportStore();
    store.applyHeartbeat("t", 1, 1000);
    const first = store.get("t");
    expect(store.get("t")).toBe(first);
    store.applyHeartbeat("t", 2, 2000);
    expect(store.get("t")).not.toBe(first);
  });

  test("after close, a late heartbeat is ignored", () => {
    const store = new ReportStore();
    store.applyHeartbeat("t", 1, 1000);
    let heard = 0;
    store.subscribe("t", () => heard++);
    store.close("t");
    expect(store.get("t")).toBeNull();
    expect(heard).toBe(1);
    store.applyHeartbeat("t", 2, 2000);
    expect(store.get("t")).toBeNull();
  });

  test("clear forgets every running call and tells its subscribers", () => {
    const store = new ReportStore();
    store.applyHeartbeat("t", 1, 1000);
    let heard = 0;
    store.subscribe("t", () => heard++);
    store.clear();
    expect(store.get("t")).toBeNull();
    expect(heard).toBe(1);
  });

  test("the least recently updated call is evicted past the cap", () => {
    const store = new ReportStore();
    for (let i = 0; i <= REPORT_CAP; i++) store.applyHeartbeat(`t${i}`, 1, i);
    expect(store.get("t0")).toBeNull();
    expect(store.get(`t${REPORT_CAP}`)).not.toBeNull();
  });
});

describe("ReportStore — a run that names its unit", () => {
  const ROWS = [
    { name: "at0310", status: "pass", index: 0, passed: 2, total: 2, secs: 5, median: 5 },
    { name: "at0339", status: "fail", index: 1, title: "clears", message: "timed out", history: "red in the last 7" },
    { name: "at0352", status: "running", index: 2, started_at_ms: 1_000, median: 11 },
  ];

  test("its rows are narrowed at the door, and a report without a unit carries none", () => {
    const store = new ReportStore();
    store.applyReport(
      { tool_use_id: "t", label: "app-test", text: "x", done: 2, total: 3, unit: "file", jobs: 4, units: ROWS },
      1000,
    );
    const p = store.get("t")!;
    expect(p.unit).toBe("file");
    const run = p.runs[0]!;
    expect(run.jobs).toBe(4);
    expect(run.units?.map((u) => [u.name, u.status])).toEqual([
      ["at0310", "pass"],
      ["at0339", "fail"],
      ["at0352", "running"],
    ]);
    expect(run.units?.[2]?.startedAtMs).toBe(1_000);
    expect(run.units?.[1]?.history).toBe("red in the last 7");

    store.applyReport({ tool_use_id: "u", text: "y", jobs: 4, units: ROWS }, 1000);
    expect(store.get("u")?.runs[0]?.units).toBeUndefined();
    expect(store.get("u")?.runs[0]?.jobs).toBeUndefined();
  });

  test("two runs under one label are two runs, in first-report order, and the first keeps its rows", () => {
    const store = new ReportStore();
    const rows = (status: string) => [{ name: "a", status, index: 0 }];
    store.applyReport({ tool_use_id: "t", label: "checks", unit: "file", units: rows("pass"), run_id: "r1", run_ord: 0, first_at_ms: 500 }, 1000);
    store.applyReport({ tool_use_id: "t", label: "checks", unit: "file", units: rows("running"), run_id: "r2", run_ord: 1, first_at_ms: 900 }, 2000);
    const p = store.get("t")!;
    expect(p.runs.map((r) => [r.runId, r.ord])).toEqual([["r1", 0], ["r2", 1]]);
    expect(p.runs[0]?.units?.[0]?.status, "the second run left the first one's rows alone").toBe("pass");
    expect(p.runs[1]?.units?.[0]?.status).toBe("running");
    // A later frame of a run replaces that run whole and keeps when it first arrived.
    store.applyReport({ tool_use_id: "t", label: "checks", unit: "file", units: rows("fail"), run_id: "r1", run_ord: 0 }, 3000);
    const again = store.get("t")!;
    expect(again.runs.length).toBe(2);
    expect(again.runs[0]?.units?.[0]?.status).toBe("fail");
    expect(again.runs[0]?.firstAtMs).toBe(500);
    expect(again.runs[0]?.reportAtMs).toBe(3000);
    // The entry's line is the latest frame's.
    expect(again.reportAtMs).toBe(3000);
  });

  test("a frame older than the one held is dropped", () => {
    const store = new ReportStore();
    store.applyReport({ tool_use_id: "t", text: "a landed", done: 1, total: 2, unit: "file", units: ROWS, run_id: "r", seq: 2 }, 1000);
    const held = store.get("t");
    // A frame tugcast published earlier arrives late: its run and the line stay.
    store.applyReport({ tool_use_id: "t", text: "starting", done: 0, total: 2, unit: "file", units: [], run_id: "r", seq: 1 }, 2000);
    store.applyReport({ tool_use_id: "t", text: "again", done: 0, total: 2, unit: "file", units: [], run_id: "r", seq: 2 }, 2500);
    expect(store.get("t")).toBe(held);
    expect(store.get("t")?.text).toBe("a landed");
    // A later one is applied.
    store.applyReport({ tool_use_id: "t", text: "b landed", done: 2, total: 2, unit: "file", units: ROWS, run_id: "r", seq: 3 }, 3000);
    expect(store.get("t")?.runs[0]?.seq).toBe(3);
    expect(store.get("t")?.text).toBe("b landed");
  });

  test("a frame with no sequence is applied", () => {
    const store = new ReportStore();
    store.applyReport({ tool_use_id: "t", text: "one", unit: "file", units: ROWS, run_id: "r", seq: 5 }, 1000);
    store.applyReport({ tool_use_id: "t", text: "two", unit: "file", units: ROWS, run_id: "r" }, 2000);
    expect(store.get("t")?.text).toBe("two");
    expect(store.get("t")?.runs[0]?.seq).toBeUndefined();
    // And a run that holds no sequence takes the next numbered frame.
    store.applyReport({ tool_use_id: "t", text: "three", unit: "file", units: ROWS, run_id: "r", seq: 1 }, 3000);
    expect(store.get("t")?.text).toBe("three");
  });

  test("a frame with no run id is keyed by its label", () => {
    const store = new ReportStore();
    store.applyReport({ tool_use_id: "t", label: "build", unit: "phase", units: [] }, 1000);
    store.applyReport({ tool_use_id: "t", label: "build", unit: "phase", units: [] }, 2000);
    store.applyReport({ tool_use_id: "t", label: "files", unit: "file", units: [] }, 3000);
    const p = store.get("t")!;
    expect(p.runs.map((r) => r.runId)).toEqual(["label:build", "label:files"]);
    expect(p.runs[0]?.firstAtMs, "the local clock at first arrival").toBe(1000);
  });

  test("a heartbeat before any report makes an entry with no runs", () => {
    const store = new ReportStore();
    store.applyHeartbeat("t", 3, 1000);
    expect(store.get("t")?.runs).toEqual([]);
    store.applyReport({ tool_use_id: "t", label: "rust", text: "x" }, 2000);
    expect(store.get("t")?.runs.length).toBe(1);
    expect(store.get("t")?.engineElapsedMs).toBe(3000);
  });

  test("a phase run and a unit run under one call share the entry as two runs", () => {
    const store = new ReportStore();
    const phase = (status: string) => [
      { name: "build", status: "pass", index: 0, secs: 40 },
      { name: "sign", status, index: 1 },
    ];
    store.applyReport({ tool_use_id: "t", label: "build-app", text: "sign", done: 1, total: 2, unit: "phase", units: phase("running"), run_id: "b", run_ord: 0 }, 1000);
    store.applyReport({ tool_use_id: "t", label: "app-test", text: "x", done: 0, total: 3, unit: "file", units: ROWS, run_id: "f", run_ord: 1 }, 2000);
    store.applyReport({ tool_use_id: "t", label: "build-app", text: "done", done: 2, total: 2, unit: "phase", units: phase("pass"), run_id: "b", run_ord: 0 }, 3000);
    const p = store.get("t")!;
    expect(p.runs.map((r) => [r.label, r.unit])).toEqual([["build-app", "phase"], ["app-test", "file"]]);
    expect(p.runs[0]?.units?.[1]?.status).toBe("pass");
    expect(p.runs[1]?.units?.length).toBe(3);
  });

  test("a nesting run's child is a run carrying the unit it ran under, and outlives the parent's next report and the close", () => {
    const store = new ReportStore();
    const surfaces = (rust: string) => [
      { name: "rust", status: rust, index: 0 },
      { name: "docs", status: "pending", index: 1 },
    ];
    store.applyReport(
      { tool_use_id: "t", label: "arc verify", text: "checking rust", done: 0, total: 2, unit: "surface", units: surfaces("running"), nests: true, run_id: "v", run_ord: 0 },
      1000,
    );
    store.applyReport(
      { tool_use_id: "t", label: "rust", text: "compiling", unit: "test", done: 0, total: 748, units: [], run_id: "c", run_ord: 1, under: { run_id: "v", slot: 0 } },
      2000,
    );
    let p = store.get("t")!;
    expect(p.runs[0]?.nests).toBe(true);
    expect(p.runs[1]?.under).toEqual({ runId: "v", slot: 0 });

    store.applyReport(
      { tool_use_id: "t", label: "arc verify", text: "rust FAIL (747/748)", done: 1, total: 2, failures: 1, unit: "surface", units: surfaces("fail"), nests: true, run_id: "v", run_ord: 0 },
      4000,
    );
    p = store.get("t")!;
    expect(p.runs.map((r) => r.runId)).toEqual(["v", "c"]);
    expect(p.runs[0]?.units?.[0]?.status).toBe("fail");
    expect(p.runs[1]?.label).toBe("rust");

    // The call closes: the settled entry keeps the child under its row.
    store.close("t");
    const settled = store.getSettled("t")!;
    expect(settled.runs.map((r) => r.runId)).toEqual(["v", "c"]);
    expect(settled.runs[1]?.under).toEqual({ runId: "v", slot: 0 });
    expect(settled.runs[1]?.label).toBe("rust");
  });

  test("a row with no name or a status it does not know is dropped; a mistyped field is absent", () => {
    expect(
      narrowRunUnits([
        { name: "a", status: "pass", secs: "7" },
        { status: "pass" },
        { name: "b", status: "exploded" },
        "c",
        null,
      ]),
    ).toEqual([{ name: "a", status: "pass" }]);
    expect(narrowRunUnits({ name: "a" })).toBeUndefined();
  });

  test("`wedged` is no status now, and an unknown status is dropped", () => {
    expect(
      narrowRunUnits([
        { name: "a", status: "wedged", index: 0 },
        { name: "b", status: "stalled", index: 1 },
        { name: "c", status: "frozen", index: 2 },
      ]),
    ).toEqual([{ name: "b", status: "stalled", index: 1 }]);
  });

  test("closing settles a call any of whose runs named a unit, and a call with none does not", () => {
    const store = new ReportStore();
    store.applyReport({ tool_use_id: "t", text: "x", unit: "file", units: ROWS }, 1000);
    store.applyReport({ tool_use_id: "t", label: "tail", text: "a line" }, 1500);
    store.applyReport({ tool_use_id: "u", text: "y" }, 1000);
    let heard = 0;
    store.subscribe("t", () => heard++);
    store.close("t");
    store.close("u");
    expect(store.get("t")).toBeNull();
    expect(store.getSettled("t")?.runs[0]?.units?.length).toBe(3);
    expect(store.getSettled("t")?.runs.length).toBe(2);
    expect(store.getSettled("u")).toBeNull();
    expect(heard, "the block hears the close, and reads the settled run on it").toBe(1);
  });

  test("settled runs outlive a cleared transport", () => {
    const store = new ReportStore();
    store.applyReport({ tool_use_id: "t", text: "x", unit: "test", units: [] }, 1);
    store.close("t");
    store.clear();
    expect(store.getSettled("t")?.unit).toBe("test");
  });

  test("a restored call's runs are its settled entry, even though the call is closed", () => {
    const store = new ReportStore();
    let heard = 0;
    store.subscribe("t", () => heard++);
    store.close("t");
    store.restoreSettled(
      "t",
      [
        { run_id: "v", run_ord: 0, label: "arc verify", text: "done", unit: "surface", units: [{ name: "deck", status: "pass", index: 0 }], nests: true, finished: true, first_at_ms: 100, at_ms: 900 },
        { run_id: "c", run_ord: 1, label: "bun test", text: "748 pass", unit: "test", done: 748, total: 748, units: [], under: { run_id: "v", slot: 0 }, first_at_ms: 200, at_ms: 800 },
        { run_id: "bad", unit: 7 },
        "not a run",
      ],
      5_000,
    );
    const settled = store.getSettled("t")!;
    expect(settled.runs.map((r) => r.runId)).toEqual(["v", "c"]);
    expect(settled.runs[1]?.under).toEqual({ runId: "v", slot: 0 });
    expect(settled.runs[1]?.firstAtMs).toBe(200);
    expect(settled.runs[1]?.reportAtMs).toBe(800);
    expect(settled.runs[0]?.units?.[0]?.status).toBe("pass");
    expect(settled.text).toBe("748 pass");
    expect(store.get("t")).toBeNull();
    expect(heard, "the block hears the restore").toBe(1);
    // A call whose recorded runs named no unit restores nothing.
    store.restoreSettled("u", [{ run_id: "l", text: "a line" }], 5_000);
    expect(store.getSettled("u")).toBeNull();
  });

  test("a restore does not replace a settled entry the page already holds", () => {
    const store = new ReportStore();
    store.applyReport({ tool_use_id: "t", text: "live", unit: "file", units: ROWS, run_id: "r" }, 1000);
    store.close("t");
    const live = store.getSettled("t");
    store.restoreSettled("t", [{ run_id: "r", text: "recorded", unit: "file", units: [] }], 2000);
    expect(store.getSettled("t")).toBe(live);
    expect(store.getSettled("t")?.text).toBe("live");
  });
});
