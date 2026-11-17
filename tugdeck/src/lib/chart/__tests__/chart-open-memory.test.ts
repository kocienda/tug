import { describe, expect, test } from "bun:test";

import {
  forgetOpenMark,
  newChartOpenMemory,
  recallOpenMark,
  rememberOpenMark,
} from "@/lib/chart/chart-open-memory";

describe("chart-open-memory", () => {
  test("a remembered mark is recalled until it is forgotten", () => {
    const store = newChartOpenMemory();
    expect(recallOpenMark("a", store)).toBeNull();
    rememberOpenMark("a", { anchor: "hit|2||||", reportId: "r1" }, store);
    expect(recallOpenMark("a", store)).toEqual({ anchor: "hit|2||||", reportId: "r1" });
    expect(forgetOpenMark("a", store)).toEqual({ anchor: "hit|2||||", reportId: "r1" });
    expect(recallOpenMark("a", store)).toBeNull();
    expect(forgetOpenMark("a", store)).toBeNull();
  });

  test("a second mark on the same chart replaces the first and evicts nothing", () => {
    const store = newChartOpenMemory();
    rememberOpenMark("a", { anchor: "hit|0||||", reportId: "r1" }, store);
    const evicted = rememberOpenMark("a", { anchor: "hit|1||||", reportId: "r2" }, store);
    expect(evicted).toEqual([]);
    expect(recallOpenMark("a", store)?.reportId).toBe("r2");
    expect(store.size).toBe(1);
  });

  test("past the limit the oldest entry goes, and the caller is handed it", () => {
    const store = newChartOpenMemory();
    expect(rememberOpenMark("a", { anchor: "x", reportId: "r1" }, store, 2)).toEqual([]);
    expect(rememberOpenMark("b", { anchor: "x", reportId: "r2" }, store, 2)).toEqual([]);
    // Remembering `a` again makes it the newest, so `b` is the one that goes.
    rememberOpenMark("a", { anchor: "y", reportId: "r3" }, store, 2);
    const evicted = rememberOpenMark("c", { anchor: "x", reportId: null }, store, 2);
    expect(evicted).toEqual([{ anchor: "x", reportId: "r2" }]);
    expect(recallOpenMark("b", store)).toBeNull();
    expect(recallOpenMark("a", store)?.reportId).toBe("r3");
    expect(recallOpenMark("c", store)).toEqual({ anchor: "x", reportId: null });
  });
});
