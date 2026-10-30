/**
 * `runMeasureLoop` — the deck's driver for the chart measure protocol,
 * run against a fake engine round and a fake measurer over plain data.
 */

import { describe, expect, test } from "bun:test";

import type { ChartRound, ChartTypeRole, MeasureTableJson } from "@/lib/lazy/load-tuggraphics";

import { NOT_CONVERGED, runMeasureLoop } from "../chart-measure";

const DONE: ChartRound = {
  status: "done",
  svg: "<svg/>",
  table: { caption: "", head: [], rows: [] },
  find_text: "",
  width: 10,
  height: 10,
};

function recordingMeasure() {
  const asked: string[] = [];
  const measure = (role: ChartTypeRole, text: string) => {
    asked.push(`${role}:${text}`);
    return { w: text.length, a: 8, d: 2 };
  };
  return { asked, measure };
}

describe("runMeasureLoop", () => {
  test("measures exactly the requested pairs and stops on done", () => {
    const tables: MeasureTableJson[] = [];
    const engine = (table: MeasureTableJson): ChartRound => {
      tables.push({ ...table });
      if (tables.length === 1) return { status: "measure", texts: [["title", "Commits"], ["label", "Mon"]] };
      if (tables.length === 2) return { status: "measure", texts: [["label", "We…"]] };
      return DONE;
    };
    const { asked, measure } = recordingMeasure();
    expect(runMeasureLoop(engine, measure)).toEqual(DONE);
    expect(asked).toEqual(["title:Commits", "label:Mon", "label:We…"]);
    expect(Object.keys(tables[0])).toEqual([]);
    expect(tables[1]).toEqual({
      "title\u0000Commits": { w: 7, a: 8, d: 2 },
      "label\u0000Mon": { w: 3, a: 8, d: 2 },
    });
    expect(Object.keys(tables[2]).length).toBe(3);
  });

  test("a first-round done measures nothing", () => {
    const { asked, measure } = recordingMeasure();
    expect(runMeasureLoop(() => DONE, measure)).toEqual(DONE);
    expect(asked).toEqual([]);
  });

  test("surfaces invalid as the engine said it", () => {
    const invalid: ChartRound = { status: "invalid", errors: [{ path: "/form", message: "unknown form" }] };
    const { measure } = recordingMeasure();
    expect(runMeasureLoop(() => invalid, measure)).toEqual(invalid);
  });

  test("a third request is the convergence error", () => {
    let calls = 0;
    const greedy = (): ChartRound => {
      calls += 1;
      return { status: "measure", texts: [["value", `ask ${calls}`]] };
    };
    const { asked, measure } = recordingMeasure();
    expect(runMeasureLoop(greedy, measure)).toEqual({
      status: "invalid",
      errors: [{ path: "", message: NOT_CONVERGED }],
    });
    expect(calls).toBe(3);
    // The third request is refused, not measured.
    expect(asked).toEqual(["value:ask 1", "value:ask 2"]);
  });
});
