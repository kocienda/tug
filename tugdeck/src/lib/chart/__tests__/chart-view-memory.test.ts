/**
 * The chart view memory — set, get, and eviction past the bound, over a
 * memory of the test's own.
 */

import { describe, expect, test } from "bun:test";

import { newChartViewMemory, recallChartView, rememberChartView } from "../chart-view-memory";

describe("chart view memory", () => {
  test("a chart is a chart until it was put in table view", () => {
    const m = newChartViewMemory();
    expect(recallChartView("a", m)).toBe("chart");
    rememberChartView("a", "table", m);
    expect(recallChartView("a", m)).toBe("table");
    expect(recallChartView("b", m)).toBe("chart");
  });

  test("setting chart forgets the hash", () => {
    const m = newChartViewMemory();
    rememberChartView("a", "table", m);
    rememberChartView("a", "chart", m);
    expect(recallChartView("a", m)).toBe("chart");
    expect(m.size).toBe(0);
  });

  test("past the limit the oldest choice goes first, and a re-set counts as new", () => {
    const m = newChartViewMemory();
    rememberChartView("a", "table", m, 3);
    rememberChartView("b", "table", m, 3);
    rememberChartView("c", "table", m, 3);
    // Touching `a` makes it the newest, so `b` is now the oldest.
    rememberChartView("a", "table", m, 3);
    rememberChartView("d", "table", m, 3);
    expect(m.size).toBe(3);
    expect(recallChartView("b", m)).toBe("chart");
    expect(recallChartView("a", m)).toBe("table");
    expect(recallChartView("c", m)).toBe("table");
    expect(recallChartView("d", m)).toBe("table");
  });
});
