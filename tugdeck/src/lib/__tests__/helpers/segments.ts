/** Test helper: one `dom` segment per row from plain strings. */
import type { RowSegment } from "../../transcript-search";

export function buildSegments(rows: readonly string[]): RowSegment[][] {
  return rows.map((text) => [{ kind: "dom" as const, text }]);
}

/**
 * The row-id resolver the engine's heal overlay is keyed by. Stable per
 * row INDEX, which is what a fixture that only ever appends needs; a
 * fixture that re-bases its rows should supply its own.
 */
export function rowIds(row: number): string {
  return `row-${row}`;
}
