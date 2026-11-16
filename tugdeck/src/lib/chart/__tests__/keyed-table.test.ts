/**
 * `keyed-table` — which sources are diagrams, and a diagram's keyed rows.
 *
 * Pure-logic: plain data, no DOM, no WASM.
 */

import { describe, expect, test } from "bun:test";

import { isDiagramSource, keyedRows } from "../keyed-table";

const FLOW = `{"tugdiagram": 1, "form": "flow", "title": "t", "columns": [[{"id": "a", "name": "A"}]]}`;
const BAR = `{"tugchart": 1, "form": "bar"}`;

describe("isDiagramSource", () => {
  test("a fence's door says it without reading the source", () => {
    expect(isDiagramSource("not even JSON", "diagram")).toBe(true);
    expect(isDiagramSource(FLOW, "chart")).toBe(false);
  });

  test("a door taking any layer reads the spec's own key", () => {
    expect(isDiagramSource(FLOW, "any")).toBe(true);
    expect(isDiagramSource(BAR, "any")).toBe(false);
    expect(isDiagramSource(`{"tugdraw": 1}`, "any")).toBe(false);
    expect(isDiagramSource(`[{"tugdiagram": 1}]`, "any")).toBe(false);
    expect(isDiagramSource(`{"tugdiagram": 1`, "any")).toBe(false);
  });
});

describe("keyedRows", () => {
  test("reads the engine's four columns as rows, in the order given", () => {
    const rows = keyedRows({
      caption: "A shell edit the gate cannot read never reaches the file",
      head: ["#", "Step", "What it does", "Where it is"],
      rows: [
        ["1", "Read the command", "Parses the command line.", "tugrust/crates/tugchanges-core/src/shell_ops.rs"],
        ["3", "Find the receipt", "", ""],
      ],
    });
    expect(rows).toEqual([
      {
        key: "1",
        name: "Read the command",
        what: "Parses the command line.",
        where: "tugrust/crates/tugchanges-core/src/shell_ops.rs",
      },
      { key: "3", name: "Find the receipt", what: "", where: "" },
    ]);
  });

  test("a figure with no key has no rows", () => {
    expect(keyedRows({ caption: "t", head: [], rows: [] })).toEqual([]);
  });
});
