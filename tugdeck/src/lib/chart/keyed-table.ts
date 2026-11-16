/**
 * `keyed-table.ts` — a diagram's keyed table, as data.
 *
 * A diagram is a figure and a table: each numbered mark in the figure has a
 * row beneath it saying what it does and where it is in the code. The engine
 * writes that table into the compile's `ChartTable` (`#`, `Step`, `What it
 * does`, `Where it is`); this module reads it back as rows, and says whether
 * a source is a diagram at all, which decides that the table is shown with
 * the figure rather than behind the chart's Table toggle.
 *
 * Pure: no DOM. The renderer (`render-chart.ts`) builds the `<table>` from
 * these rows, and the "where" cell is a path the annotator resolves there.
 *
 * @module lib/chart/keyed-table
 */

import type { ChartLayers, ChartTable } from "@/lib/lazy/load-tuggraphics";

/** One row of a diagram's keyed table. */
export interface KeyedRow {
  /** The number the figure shows. */
  key: string;
  /** The mark's name. */
  name: string;
  /** What it does; `""` when the author did not say. */
  what: string;
  /** Where it is in the code; `""` when the author did not say. */
  where: string;
}

/**
 * Whether `source`, read through a door taking `layers`, is a diagram. A
 * `tugdiagram` fence takes nothing else and a `tugchart` fence nothing of the
 * kind; a door taking any layer has to read the spec's own first key.
 */
export function isDiagramSource(source: string, layers: ChartLayers): boolean {
  if (layers === "diagram") return true;
  if (layers === "chart") return false;
  try {
    const value: unknown = JSON.parse(source);
    return typeof value === "object" && value !== null && !Array.isArray(value) && "tugdiagram" in value;
  } catch {
    return false;
  }
}

/** The rows of a diagram's keyed table, in key order as the engine wrote them. */
export function keyedRows(table: ChartTable): KeyedRow[] {
  return table.rows.map((cells) => ({
    key: cells[0] ?? "",
    name: cells[1] ?? "",
    what: cells[2] ?? "",
    where: cells[3] ?? "",
  }));
}
