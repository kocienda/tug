/**
 * `chart-share-state` — a report's snapshot and its sealed seed, the strings
 * a share scrubs, and the document field's reader.
 */

import { describe, expect, test } from "bun:test";

import { recallOpenMark } from "../chart-open-memory";
import {
  dropReport,
  loadReportPage,
  nestedReport,
  newReportId,
  receiveReportPage,
  registerReport,
  reportState,
  setNestedReport,
  snapshotReport,
  type ReportRow,
} from "../chart-report-store";
import {
  applyChartShareStrings,
  collectChartShareStrings,
  readChartShareState,
  type ChartShareState,
} from "../chart-share-state";
import { seedChartShareState } from "../chart-share-capture";
import { recallChartView } from "../chart-view-memory";

const SHA = "63de5762a9c1f0e4b7d2a8c5e3f1b6d9a0c4e7f2";

function commitRow(subject: string): ReportRow {
  return {
    kind: "commit",
    ref: `commit:${SHA}`,
    found: true,
    measure: null,
    measureText: null,
    group: "feat",
    commit: { sha: SHA, subject, author: "A. Author", date: "2026-10-23", body: "Why.", files: ["src/a.ts"] },
  };
}

function pathRow(path: string): ReportRow {
  return {
    kind: "file",
    ref: `file:${path}`,
    found: true,
    measure: 3,
    measureText: "3",
    group: null,
    path: { path, exists: true, commits: 2 },
  };
}

/** A registered report with one page landed, and a nested one under its path row. */
function openReport(): string {
  const id = newReportId();
  registerReport({ id, projectDir: "/repo", kind: "commit", rowLabel: "2026-10-23", seriesName: null, slotCount: 40 });
  receiveReportPage(id, {
    ok: true,
    total: 40,
    moved: false,
    sum: null,
    sumText: null,
    measure: null,
    rows: [commitRow("Fix the thing"), pathRow("src/a.ts")],
    received: 2,
  });
  const child = newReportId();
  registerReport({ id: child, projectDir: "/repo", kind: "commit", rowLabel: null, seriesName: null, slotCount: 1, of: "file:src/a.ts" });
  receiveReportPage(child, {
    ok: true,
    total: 1,
    moved: false,
    sum: null,
    sumText: null,
    measure: null,
    rows: [commitRow("Touch a")],
    received: 1,
  });
  setNestedReport(id, "file:src/a.ts", child);
  return id;
}

describe("a report's snapshot", () => {
  test("holds its rows and the reports unfolded under them, and seeds sealed", async () => {
    const id = openReport();
    const snapshot = snapshotReport(id)!;
    expect(snapshot.rows.length).toBe(2);
    expect(snapshot.total).toBe(40);
    expect(snapshot.fetched).toBe(2);
    expect(snapshot.nested.map((under) => under.ref)).toEqual(["file:src/a.ts"]);
    expect(snapshot.nested[0]!.report.rows[0]!.commit!.subject).toBe("Touch a");
    expect(snapshotReport("never-registered")).toBeNull();

    // Through JSON, as the document carries it, and into the open memory.
    const state: ChartShareState = JSON.parse(
      JSON.stringify({ tables: ["table-hash"], opens: [{ hash: "open-hash", anchor: "hit|3||||", report: snapshot }] }),
    );
    seedChartShareState(state);
    expect(recallChartView("table-hash")).toBe("table");
    const mark = recallOpenMark("open-hash")!;
    expect(mark.anchor).toBe("hit|3||||");
    const seeded = reportState(mark.reportId!);
    expect(seeded.descriptor!.id).toBe(mark.reportId!);
    expect(seeded.phase).toBe("ready");
    expect(seeded.sealed).toBe(true);
    expect(seeded.rows.length).toBe(2);
    expect(seeded.total).toBe(40);
    const under = nestedReport(mark.reportId!, "file:src/a.ts")!;
    expect(reportState(under).sealed).toBe(true);
    expect(reportState(under).rows[0]!.commit!.subject).toBe("Touch a");

    // A sealed report has rows left to read and reads none.
    await loadReportPage(mark.reportId!);
    expect(reportState(mark.reportId!).rows.length).toBe(2);
    expect(reportState(mark.reportId!).loadingMore).toBe(false);

    dropReport(id);
    dropReport(mark.reportId!);
  });
});

describe("the strings a share scrubs", () => {
  const state: ChartShareState = {
    tables: ["t"],
    opens: [
      { hash: "plain", anchor: "a", report: null },
      {
        hash: "h",
        anchor: "b",
        report: {
          descriptor: { id: "r1", projectDir: "/Users/me/repo", kind: "commit", rowLabel: "day", seriesName: null, slotCount: 2 },
          rows: [commitRow("Fix /Users/me"), pathRow("/Users/me/a.ts")],
          total: 2,
          sum: null,
          sumText: null,
          measure: null,
          moved: false,
          fetched: 2,
          nested: [],
        },
      },
    ],
  };

  test("are the rows' prose and paths, never a sha, a ref or the descriptor", () => {
    const texts = collectChartShareStrings(state);
    expect(texts).toEqual(["feat", "Fix /Users/me", "A. Author", "Why.", "src/a.ts", "/Users/me/a.ts"]);
  });

  test("go back where they came from, and a short answer is refused", () => {
    const texts = collectChartShareStrings(state).map((text) => text.replace("/Users/me", "~"));
    const applied = applyChartShareStrings(state, texts)!;
    const rows = applied.opens[1]!.report!.rows;
    expect(rows[0]!.commit!.subject).toBe("Fix ~");
    expect(rows[0]!.commit!.sha).toBe(SHA);
    expect(rows[0]!.ref).toBe(`commit:${SHA}`);
    expect(rows[1]!.path!.path).toBe("~/a.ts");
    expect(rows[1]!.ref).toBe("file:/Users/me/a.ts");
    expect(applied.opens[1]!.report!.descriptor.projectDir).toBe("/Users/me/repo");
    expect(applyChartShareStrings(state, texts.slice(1))).toBeNull();
    expect(applyChartShareStrings(state, [...texts, "extra"])).toBeNull();
  });
});

describe("the document field's reader", () => {
  test("an absent field says nothing, and a wrong shape is refused", () => {
    expect(readChartShareState(undefined)).toEqual({ tables: [], opens: [] });
    expect(readChartShareState({ tables: [], opens: [{ hash: "h", anchor: "a", report: null }] })).not.toBeNull();
    expect(readChartShareState({ tables: [] })).toBeNull();
    expect(readChartShareState({ tables: [], opens: [{ hash: "h", anchor: 1, report: null }] })).toBeNull();
    expect(readChartShareState({ tables: [], opens: [{ hash: "h", anchor: "a", report: { rows: [] } }] })).toBeNull();
  });
});
