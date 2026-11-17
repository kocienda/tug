/**
 * `chart-table-refs` — the pure reads over a chart table's refs: which ref a
 * mark stands for, what a set reads as, and what one ref reads as as an atom.
 */

import { describe, expect, test } from "bun:test";

import type { ChartTableRefs } from "@/lib/lazy/load-tuggraphics";

import type { AnnotationContext } from "@/lib/annotator/types";

import {
  canAsk,
  canReport,
  effectiveRef,
  foldItemSlots,
  isReportable,
  refLabel,
  slotAt,
  slotCount,
  slotLabel,
} from "../chart-table-refs";
import { wholeRowSlot } from "../chart-table-refs";

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

describe("canReport, isReportable and foldItemSlots", () => {
  const source = { recipe: "commits", args: { since: "2026-10-18" } };
  /** A context with only the two fields the answer reads. */
  function context(partial: Partial<AnnotationContext>): AnnotationContext {
    return { commitRoot: "/repo", ...partial } as AnnotationContext;
  }

  test("a figure reports only with a source, a context that can answer, and a repository", () => {
    expect(canReport(source, context({}))).toBe(true);
    expect(canReport(undefined, context({}))).toBe(false);
    expect(canReport(source, undefined)).toBe(false);
    expect(canReport(source, context({ unanswerable: true }))).toBe(false);
    expect(canReport(source, context({ commitRoot: null }))).toBe(false);
  });

  test("there is somebody to ask whatever the spec names", () => {
    expect(canAsk(context({}))).toBe(true);
    expect(canAsk(undefined)).toBe(false);
    expect(canAsk(context({ unanswerable: true }))).toBe(false);
    expect(canAsk(context({ commitRoot: null }))).toBe(false);
  });

  test("a set with members opens anywhere; a count form opens only where the figure reports", () => {
    expect(isReportable("commit:abcd", true)).toBe(false);
    expect(isReportable({ kind: "commit", members: ["commit:abcd"] }, false)).toBe(true);
    expect(isReportable({ kind: "commit", members: [] }, true)).toBe(false);
    expect(isReportable({ kind: "commit", count: 4 }, true)).toBe(true);
    expect(isReportable({ kind: "commit", count: 4 }, false)).toBe(false);
    expect(isReportable({ kind: "commit", count: 0 }, true)).toBe(false);
  });

  test("a slot counts one ref, its members, or its number", () => {
    expect(slotCount("commit:abcd")).toBe(1);
    expect(slotCount({ kind: "commit", members: ["commit:a1b2", "commit:c3d4"] })).toBe(2);
    expect(slotCount({ kind: "commit", count: 312 })).toBe(312);
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

describe("wholeRowSlot", () => {
  test("sums a row's cells under the kind they share", () => {
    const table = refs({
      rows: [null, "file:/a.ts", null, null],
      cells: [
        [null, { kind: "commit", members: ["commit:aaaa1111", "commit:bbbb2222"] }, "commit:cccc3333", { kind: "commit", count: 40 }],
        [null, "commit:dddd4444"],
        [null, null],
        [null, "commit:eeee5555", "session:048e4155"],
      ],
    });
    expect(wholeRowSlot(table, 0)).toEqual({ kind: "commit", count: 43 });
    expect(wholeRowSlot(table, 1), "a row with a slot of its own already has its atom").toBeNull();
    expect(wholeRowSlot(table, 2), "no cell holds anything").toBeNull();
    expect(wholeRowSlot(table, 3), "two kinds are not one count").toBeNull();
    expect(wholeRowSlot(table, 9)).toBeNull();
    expect(wholeRowSlot(undefined, 0)).toBeNull();
  });
});
