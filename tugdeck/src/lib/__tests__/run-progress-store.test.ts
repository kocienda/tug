import { describe, expect, test } from "bun:test";

import {
  RunProgressStore,
  RUN_PROGRESS_CAP,
  RUN_SETTLED_CAP,
  engineLiveness,
  formatRunProgressLine,
  liveElapsedMs,
  narrowRunUnits,
} from "../run-progress-store";

describe("RunProgressStore — a running command's reports", () => {
  test("the line joins label, count, failures and text", () => {
    expect(
      formatRunProgressLine({
        toolUseId: "t",
        label: "app-test",
        done: 7,
        total: 20,
        failures: 1,
        text: "at0603 PASS (14/14) 38s",
      }),
    ).toBe("app-test · 7/20 · 1 fail · at0603 PASS (14/14) 38s");
    expect(
      formatRunProgressLine({ toolUseId: "t", label: "rust", text: "compiling tugcast" }),
    ).toBe("rust · compiling tugcast");
    expect(
      formatRunProgressLine({ toolUseId: "t", label: "rust", done: 3, failures: 0, text: "x" }),
    ).toBe("rust · 3 · x");
  });

  test("a report with no call lands in the card slot", () => {
    const store = new RunProgressStore();
    let heard = 0;
    store.subscribe(null, () => heard++);
    store.applyReport({ tool_use_id: null, label: "rust", text: "linking" }, 1000);
    expect(store.get(null)?.text).toBe("linking");
    expect(store.get(null)?.reportAtMs).toBe(1000);
    expect(heard).toBe(1);
  });

  test("a report keeps the call's heartbeat and replaces the last report whole", () => {
    const store = new RunProgressStore();
    store.applyHeartbeat("t", 5, 1000);
    store.applyReport({ tool_use_id: "t", label: "rust", text: "a", done: 1, total: 9 }, 2000);
    store.applyReport({ tool_use_id: "t", label: "rust", text: "b" }, 3000);
    const p = store.get("t");
    expect(p?.text).toBe("b");
    expect(p?.done).toBeUndefined();
    expect(p?.engineElapsedMs).toBe(5000);
  });

  test("a closed call's report is ignored unless it is a running background job", () => {
    const store = new RunProgressStore();
    store.close("fg");
    store.applyReport({ tool_use_id: "fg", text: "late" }, 1000, () => false);
    expect(store.get("fg")).toBeNull();

    store.close("bg");
    store.applyReport({ tool_use_id: "bg", text: "still going" }, 1000, (id) => id === "bg");
    expect(store.get("bg")?.text).toBe("still going");
  });
});

describe("RunProgressStore — the engine heartbeat", () => {
  test("the elapsed reading carries forward from the last heartbeat", () => {
    const store = new RunProgressStore();
    store.applyHeartbeat("t", 125, 1000);
    expect(liveElapsedMs(0, store.get("t"), 3000)).toBe(127000);
  });

  test("with no heartbeat the local clock since the start is the reading", () => {
    expect(liveElapsedMs(1000, null, 4500)).toBe(3500);
    expect(liveElapsedMs(5000, null, 4500)).toBe(0);
  });

  test("a tick older than the heartbeat reads the heartbeat, never less", () => {
    const store = new RunProgressStore();
    store.applyHeartbeat("t", 125, 10_000);
    expect(liveElapsedMs(0, store.get("t"), 9_400)).toBe(125_000);
  });

  test("a heartbeat is live under ten seconds old and quiet after", () => {
    const store = new RunProgressStore();
    store.applyHeartbeat("t", 1, 1000);
    expect(engineLiveness(store.get("t"), 10_000)).toBe("live");
    expect(engineLiveness(store.get("t"), 12_000)).toBe("quiet");
    expect(engineLiveness(store.get("u"), 12_000)).toBeNull();
  });

  test("a subscriber hears its own key and no other", () => {
    const store = new RunProgressStore();
    let t = 0;
    let u = 0;
    store.subscribe("t", () => t++);
    store.subscribe("u", () => u++);
    store.applyHeartbeat("t", 1, 1000);
    expect([t, u]).toEqual([1, 0]);
  });

  test("the entry object is stable until it changes", () => {
    const store = new RunProgressStore();
    store.applyHeartbeat("t", 1, 1000);
    const first = store.get("t");
    expect(store.get("t")).toBe(first);
    store.applyHeartbeat("t", 2, 2000);
    expect(store.get("t")).not.toBe(first);
  });

  test("after close, a late heartbeat is ignored", () => {
    const store = new RunProgressStore();
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
    const store = new RunProgressStore();
    store.applyHeartbeat("t", 1, 1000);
    let heard = 0;
    store.subscribe("t", () => heard++);
    store.clear();
    expect(store.get("t")).toBeNull();
    expect(heard).toBe(1);
  });

  test("the least recently updated call is evicted past the cap", () => {
    const store = new RunProgressStore();
    for (let i = 0; i <= RUN_PROGRESS_CAP; i++) store.applyHeartbeat(`t${i}`, 1, i);
    expect(store.get("t0")).toBeNull();
    expect(store.get(`t${RUN_PROGRESS_CAP}`)).not.toBeNull();
  });
});

describe("RunProgressStore — a run that names its unit", () => {
  const ROWS = [
    { name: "at0310", status: "pass", index: 0, passed: 2, total: 2, secs: 5, median: 5 },
    { name: "at0339", status: "fail", index: 1, title: "clears", message: "timed out", history: "red in the last 7" },
    { name: "at0352", status: "running", index: 2, started_at_ms: 1_000, median: 11 },
  ];

  test("its rows are narrowed at the door, and a report without a unit carries none", () => {
    const store = new RunProgressStore();
    store.applyReport(
      { tool_use_id: "t", label: "app-test", text: "x", done: 2, total: 3, unit: "file", jobs: 4, units: ROWS },
      1000,
    );
    const p = store.get("t")!;
    expect(p.unit).toBe("file");
    expect(p.jobs).toBe(4);
    expect(p.units?.map((u) => [u.name, u.status])).toEqual([
      ["at0310", "pass"],
      ["at0339", "fail"],
      ["at0352", "running"],
    ]);
    expect(p.units?.[2]?.startedAtMs).toBe(1_000);
    expect(p.units?.[1]?.history).toBe("red in the last 7");

    store.applyReport({ tool_use_id: "u", text: "y", jobs: 4, units: ROWS }, 1000);
    expect(store.get("u")?.units).toBeUndefined();
    expect(store.get("u")?.jobs).toBeUndefined();
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

  test("the old word `wedged` arrives as `stalled`, and an unknown status is still dropped", () => {
    expect(
      narrowRunUnits([
        { name: "a", status: "wedged", index: 0 },
        { name: "b", status: "stalled", index: 1 },
        { name: "c", status: "frozen", index: 2 },
      ]),
    ).toEqual([
      { name: "a", status: "stalled", index: 0 },
      { name: "b", status: "stalled", index: 1 },
    ]);
  });

  test("closing settles the last report, and a run without a unit does not", () => {
    const store = new RunProgressStore();
    store.applyReport({ tool_use_id: "t", text: "x", unit: "file", units: ROWS }, 1000);
    store.applyReport({ tool_use_id: "u", text: "y" }, 1000);
    let heard = 0;
    store.subscribe("t", () => heard++);
    store.close("t");
    store.close("u");
    expect(store.get("t")).toBeNull();
    expect(store.getSettled("t")?.units?.length).toBe(3);
    expect(store.getSettled("u")).toBeNull();
    expect(heard, "the block hears the close, and reads the settled run on it").toBe(1);
  });

  test("settled runs outlive a cleared transport and are capped oldest first", () => {
    const store = new RunProgressStore();
    for (let i = 0; i <= RUN_SETTLED_CAP; i++) {
      store.applyReport({ tool_use_id: `t${i}`, text: "x", unit: "test", units: [] }, i);
      store.close(`t${i}`);
    }
    store.clear();
    expect(store.getSettled("t0")).toBeNull();
    expect(store.getSettled(`t${RUN_SETTLED_CAP}`)?.unit).toBe("test");
  });
});
