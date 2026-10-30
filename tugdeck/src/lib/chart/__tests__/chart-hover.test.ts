/**
 * `tipContent` — what the bubble says for a hit target, read from the table:
 * the row's label, its values under their heads, and the mark's own value marked.
 */

import { describe, expect, test } from "bun:test";

import { tipContent } from "../chart-hover";

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
