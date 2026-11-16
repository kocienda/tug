/**
 * `chart-table-refs` — the pure reads over a chart table's refs: which ref a
 * mark stands for, what a set reads as, and what one ref reads as as an atom.
 */

import { describe, expect, test } from "bun:test";

import type { ChartTableRefs } from "@/lib/lazy/load-tuggraphics";

import { effectiveRef, foldItemSlots, isActionableSet, refLabel, slotAt, slotLabel } from "../chart-table-refs";

function refs(partial: Partial<ChartTableRefs>): ChartTableRefs {
  return { rows: [], cols: [], cells: [], items: [], marks: [], ...partial };
}

describe("effectiveRef", () => {
  const table = refs({
    rows: ["file:/a.ts", null],
    cols: [null, "session:048e4155", "arc:other"],
    cells: [
      [null, "commit:aaaa1111", null],
      [null, null, null],
    ],
    items: [["commit:bbbb2222", null]],
    marks: [{ index: 3, at: 1, label: "freeze", slot: "url:https://example.com/x" }],
  });

  test("a mark reads its own ref and nothing else", () => {
    expect(effectiveRef(table, { row: 0, mark: 3 })).toBe("url:https://example.com/x");
    expect(effectiveRef(table, { row: 0, mark: 9 })).toBeNull();
  });

  test("a dot reads its own ref, then its row's", () => {
    expect(effectiveRef(table, { row: 0, item: 0 })).toBe("commit:bbbb2222");
    expect(effectiveRef(table, { row: 0, item: 1 })).toBe("file:/a.ts");
  });

  test("a cell reads its own ref, then its row's, then its column's", () => {
    expect(effectiveRef(table, { row: 0, col: 1 })).toBe("commit:aaaa1111");
    expect(effectiveRef(table, { row: 0, col: 2 })).toBe("file:/a.ts");
    expect(effectiveRef(table, { row: 1, col: 2 })).toBe("arc:other");
    expect(effectiveRef(table, { row: 1, col: 1 })).toBe("session:048e4155");
  });

  test("a band with no column reads its row", () => {
    expect(effectiveRef(table, { row: 0 })).toBe("file:/a.ts");
    expect(effectiveRef(table, { row: 1 })).toBeNull();
  });

  test("a table with no refs answers nothing", () => {
    expect(effectiveRef(undefined, { row: 0, col: 1 })).toBeNull();
  });
});

describe("slotAt", () => {
  const table = refs({
    rows: [{ kind: "commit", members: ["commit:a1", "commit:b2"] }, null],
    cols: [null, "session:048e4155"],
    cells: [[null, "commit:c3"]],
    items: [["commit:d4", { kind: "file", members: ["file:a", "file:b"] }, "commit:e5"]],
    marks: [{ index: 2, at: 0, label: "freeze", slot: { kind: "url", members: ["url:https://a.io", "url:https://b.io"] } }],
  });

  test("reads a Table atom's address back to its slot", () => {
    expect(slotAt(table, "row:0", "commit")).toEqual({ kind: "commit", members: ["commit:a1", "commit:b2"] });
    expect(slotAt(table, "row:1", null)).toBeNull();
    expect(slotAt(table, "col:1", null)).toBe("session:048e4155");
    expect(slotAt(table, "cell:0:1", null)).toBe("commit:c3");
    expect(slotAt(table, "mark:2", null)).toEqual({ kind: "url", members: ["url:https://a.io", "url:https://b.io"] });
    expect(slotAt(table, "mark:9", null)).toBeNull();
  });

  test("a folded items atom is found again by its prefix", () => {
    expect(slotAt(table, "items:0", "commit")).toEqual({ kind: "commit", members: ["commit:d4", "commit:e5"] });
    expect(slotAt(table, "items:0", "file")).toEqual({ kind: "file", members: ["file:a", "file:b"] });
    expect(slotAt(table, "items:0", "arc")).toBeNull();
  });

  test("nothing for no refs or an unknown address", () => {
    expect(slotAt(undefined, "row:0", null)).toBeNull();
    expect(slotAt(table, "thing:0", null)).toBeNull();
  });
});

describe("slotLabel", () => {
  test("a set counts its members with the kind's plural", () => {
    expect(slotLabel({ kind: "commit", members: ["commit:a1b2", "commit:c3d4"] })).toBe("2 commits");
    expect(slotLabel({ kind: "dir", members: ["dir:a", "dir:b", "dir:c"] })).toBe("3 directories");
    expect(slotLabel({ kind: "url", members: ["url:https://a.io", "url:https://b.io"] })).toBe("2 links");
    expect(slotLabel({ kind: "session", members: ["session:a", "session:b"] })).toBe("2 sessions");
    expect(slotLabel({ kind: "arc", members: ["arc:a", "arc:b"] })).toBe("2 arcs");
    expect(slotLabel({ kind: "command", members: ["command:a", "command:b"] })).toBe("2 commands");
    expect(slotLabel({ kind: "file", members: ["file:a", "file:b"] })).toBe("2 files");
  });

  test("one is singular", () => {
    expect(slotLabel({ kind: "dir", count: 1 })).toBe("1 directory");
    expect(slotLabel({ kind: "commit", count: 1 })).toBe("1 commit");
  });

  test("a count form reads its count", () => {
    expect(slotLabel({ kind: "commit", count: 312 })).toBe("312 commits");
  });

  test("a single ref reads its atom label", () => {
    expect(slotLabel("commit:63de5762a9")).toBe("commit:63de5762");
  });
});

describe("refLabel", () => {
  test("per prefix", () => {
    expect(refLabel("commit:63de5762a9c1")).toBe("commit:63de5762");
    expect(refLabel("file:tugdeck/src/lib/chart/render-chart.ts")).toBe("render-chart.ts");
    expect(refLabel("dir:tugdeck/src/lib/")).toBe("lib");
    expect(refLabel("session:tug/mighty-cabin")).toBe("tug/mighty-cabin");
    expect(refLabel("arc:chart-cross-references")).toBe("chart-cross-references");
    expect(refLabel("url:https://www.example.com/a/b/c")).toBe("example.com/…/c");
    expect(refLabel("command:just ci")).toBe("just ci");
  });
});

describe("isActionableSet and foldItemSlots", () => {
  test("only a set with members is actionable", () => {
    expect(isActionableSet({ kind: "commit", members: ["commit:abcd"] })).toBe(true);
    expect(isActionableSet({ kind: "commit", count: 4 })).toBe(false);
    expect(isActionableSet("commit:abcd")).toBe(false);
  });

  test("a row's dots fold to distinct refs per prefix, oldest first", () => {
    expect(
      foldItemSlots(["commit:aaaa", null, "commit:bbbb", "commit:aaaa", { kind: "commit", members: ["commit:cccc"] }]),
    ).toEqual([{ kind: "commit", members: ["commit:aaaa", "commit:bbbb", "commit:cccc"] }]);
    expect(foldItemSlots(["commit:aaaa", "commit:aaaa"])).toEqual(["commit:aaaa"]);
    expect(foldItemSlots([{ kind: "commit", count: 9 }])).toEqual([]);
    expect(foldItemSlots(undefined)).toEqual([]);
  });
});
