/**
 * `tipContent` — what the bubble says for a hit target, read from the table:
 * the row's label, its values under their heads, and the mark's own value marked.
 */

import { describe, expect, test } from "bun:test";

import { footLine, tipContent } from "../chart-hover";

const TABLE = {
  caption: "Both suites got slower",
  head: ["", "unit", "integration"],
  rows: [
    ["Mon", "41s", "2m02s"],
    ["Tue", "43s", ""],
  ],
};

describe("tipContent", () => {
  test("gives the row's label and every value under its head", () => {
    expect(tipContent(TABLE, 0, null)).toEqual({
      label: "Mon",
      rows: [
        { name: "unit", value: "41s", current: false },
        { name: "integration", value: "2m02s", current: false },
      ],
    });
  });

  test("marks the column the mark draws", () => {
    const content = tipContent(TABLE, 0, 2);
    expect(content?.rows.map((r) => r.current)).toEqual([false, true]);
  });

  test("leaves out a gap", () => {
    expect(tipContent(TABLE, 1, 1)?.rows).toEqual([{ name: "unit", value: "43s", current: true }]);
  });

  test("a row holding nothing but a gap says only its label", () => {
    const table = { ...TABLE, rows: [["Wed", "", ""]] };
    expect(tipContent(table, 0, null)).toEqual({ label: "Wed", rows: [] });
  });

  test("a column the chart's title names shows its value alone", () => {
    const heat = { caption: "Commits cluster late", head: ["", "Commits cluster late"], rows: [["Mon", "2"]] };
    expect(tipContent(heat, 0, 1)?.rows).toEqual([{ name: "", value: "2", current: true }]);
  });

  test("a row the table does not have is nothing", () => {
    expect(tipContent(TABLE, 9, null)).toBeNull();
  });
});

describe("footLine", () => {
  test("says what a press on each kind of mark does", () => {
    expect(footLine({ payload: { kind: "file-path", path: "/repo/src/app.ts" } }, null)).toBe("Open app.ts");
    expect(footLine({ payload: { kind: "directory", path: "/repo/src/" } }, null)).toBe("Show src in Finder");
    expect(footLine({ payload: { kind: "commit-sha", sha: "63de5762a9c1", root: "/repo", paths: [] } }, null)).toBe(
      "Open commit:63de5762",
    );
    expect(footLine({ payload: { kind: "arc", name: "x", root: "/repo", joinSha: "302d43b5d1" } }, null)).toBe(
      "Open the join commit",
    );
    expect(footLine({ payload: { kind: "arc", name: "x", root: "/repo" } }, null)).toBe("Show x in Arcs");
    expect(footLine({ payload: { kind: "url", url: "https://www.example.com/a/b" } }, null)).toBe("Open example.com");
    expect(footLine({ payload: { kind: "slash-command", name: "commit", args: "" } }, null)).toBe(
      "Put the command in the prompt",
    );
    expect(footLine({ payload: { kind: "shell-command", command: "just ci" } }, null)).toBe("Put the command in the prompt");
    expect(footLine({ report: "run" }, null)).toBe("Show the run");
    expect(footLine({ report: "span" }, null)).toBe("Show the stage");
    expect(footLine({ report: "runs" }, null)).toBe("Show the runs");
  });

  test("a session mark says the act the press would take now", () => {
    const session = { payload: { kind: "session" as const, target: "048e4155-f644-46f7-a839-d22ac02a564f" } };
    expect(footLine(session, "raise")).toBe("Go to session");
    expect(footLine(session, "resume")).toBe("Resume session");
    expect(footLine(session, null)).toBe("Session not open here");
  });

  test("a set offers its list; a count form and a bare mark offer nothing", () => {
    expect(footLine({ set: { kind: "commit", members: ["commit:a1", "commit:b2"] }, reports: false }, null)).toBe(
      "Show 2 commits",
    );
    expect(footLine({ set: { kind: "commit", count: 312 }, reports: false }, null)).toBeNull();
    expect(footLine({ set: { kind: "commit", count: 312 }, reports: true }, null)).toBe("Show 312 commits");
    expect(footLine(null, null)).toBeNull();
  });

  test("a kind no chart ref is has no foot", () => {
    expect(footLine({ payload: { kind: "email", address: "a@b.c" } }, null)).toBeNull();
  });
});
