/**
 * The Choose Session sheet's list, as rows — and the selection that walks it.
 *
 * The list is one column of four row kinds: a project's band, its "New session
 * in X" row, its sessions, and, last, the "New session in another folder…" row.
 * Which rows stand is a pure function of the groups, which of them are
 * unfolded, and the filter ({@link pickerRowsFrom}):
 *
 * - With no filter, every group shows its band; an unfolded group adds its New
 *   session row (unless its folder is missing — there is nowhere to start one)
 *   and, once its listing has settled, its sessions. The other-folder row ends
 *   the list.
 * - With a filter, the reader has asked for rows rather than structure: every
 *   group with a match unfolds, every group without one is hidden, the New
 *   session rows and the other-folder row step aside, and each group's
 *   matches are ranked best first.
 *
 * The selection is the picker's, not the list's ([D17] keeps cells stateless),
 * and what it says is WHERE Open goes: a band or a New session row is "a new
 * session in this project", a session row is "resume this one", the
 * other-folder row is "a new session in the folder typed below". A selection
 * whose row the list no longer shows is not kept on faith — it falls back to
 * the nearest row that is shown ({@link effectiveSelection}), so Open never
 * acts on something the reader cannot see.
 *
 * {@link PickerRowsDataSource} is the `TugListView` face of the rows, minted
 * once per picker and fed new rows each render, notifying from a layout effect
 * — the pattern `useSessionsDataSource` set.
 *
 * Laws: [L02] the data source is an external store (`subscribe` +
 * `getVersion`); [L03] its notify lands in a layout effect.
 *
 * @module components/tugways/cards/session-picker-rows
 */

import { useLayoutEffect, useRef } from "react";

import type { TugListViewDataSource } from "@/components/tugways/tug-list-view";
import { Subscribable } from "@/lib/subscribable";
import { filterAndRank } from "@/lib/text-match";
import type { SessionRow } from "@/protocol";

import { isLiveSessionRow, type PickerGroup } from "./session-picker-groups";

/** One row of the grouped list. */
export type PickerRow =
  | { readonly kind: "group"; readonly group: PickerGroup; readonly expanded: boolean }
  | { readonly kind: "session-new"; readonly group: PickerGroup }
  | { readonly kind: "session-resume"; readonly group: PickerGroup; readonly row: SessionRow }
  | { readonly kind: "other" };

/** Where Open goes. */
export type PickerSelection =
  | { readonly kind: "group"; readonly projectDir: string }
  | { readonly kind: "session-new"; readonly projectDir: string }
  | {
      readonly kind: "session-resume";
      readonly projectDir: string;
      readonly sessionId: string;
    }
  | { readonly kind: "other" };

/**
 * The fields a filter term may match on a session row: its name, its callsign,
 * its last prompt, and its id — the rule the single-project list used.
 */
function filterFieldsForRow(row: SessionRow): (string | null | undefined)[] {
  return [row.name, row.tag, row.last_user_prompt, row.session_id];
}

/** The rows the list shows. See the module note for the rules. */
export function pickerRowsFrom(
  groups: readonly PickerGroup[],
  isExpanded: (projectDir: string) => boolean,
  filterQuery: string,
): PickerRow[] {
  const rows: PickerRow[] = [];
  const filtering = filterQuery.trim().length > 0;
  for (const group of groups) {
    if (filtering) {
      if (group.status !== "ready") continue;
      const matches = filterAndRank(group.rows, filterQuery, filterFieldsForRow);
      if (matches.length === 0) continue;
      rows.push({ kind: "group", group, expanded: true });
      for (const row of matches) rows.push({ kind: "session-resume", group, row });
      continue;
    }
    const expanded = isExpanded(group.projectDir);
    rows.push({ kind: "group", group, expanded });
    if (!expanded) continue;
    if (group.status !== "missing") rows.push({ kind: "session-new", group });
    for (const row of group.rows) rows.push({ kind: "session-resume", group, row });
  }
  if (!filtering) rows.push({ kind: "other" });
  return rows;
}

/** A row's stable id. Session ids are unique across projects; dirs key the rest. */
export function pickerRowId(row: PickerRow): string {
  switch (row.kind) {
    case "group":
      return `group:${row.group.projectDir}`;
    case "session-new":
      return `new:${row.group.projectDir}`;
    case "session-resume":
      return `resume:${row.row.session_id}`;
    case "other":
      return "other";
  }
}

/** The id of the row a selection names. */
export function pickerSelectionRowId(selection: PickerSelection): string {
  switch (selection.kind) {
    case "group":
      return `group:${selection.projectDir}`;
    case "session-new":
      return `new:${selection.projectDir}`;
    case "session-resume":
      return `resume:${selection.sessionId}`;
    case "other":
      return "other";
  }
}

/**
 * Whether a row can be picked. A session held by a live process — in another
 * card, or in a terminal — stays visible for context and cannot be chosen.
 */
export function pickerRowEnabled(row: PickerRow): boolean {
  return row.kind !== "session-resume" || !isLiveSessionRow(row.row);
}

/** The selection a row stands for, or `null` for a row that cannot be picked. */
export function pickerSelectionOf(row: PickerRow): PickerSelection | null {
  if (!pickerRowEnabled(row)) return null;
  switch (row.kind) {
    case "group":
      return { kind: "group", projectDir: row.group.projectDir };
    case "session-new":
      return { kind: "session-new", projectDir: row.group.projectDir };
    case "session-resume":
      return {
        kind: "session-resume",
        projectDir: row.group.projectDir,
        sessionId: row.row.session_id,
      };
    case "other":
      return { kind: "other" };
  }
}

/**
 * The selection Open acts on: the one the reader made, while the list still
 * shows it; otherwise the New session row of that selection's own project,
 * then the first New session row (the first group is the one that opens
 * unfolded, so with nothing chosen this is where a session goes), then the
 * first session that can be picked — which is what a filter leaves — and
 * `null` only when the list offers nothing.
 */
export function effectiveSelection(
  rows: readonly PickerRow[],
  chosen: PickerSelection | null,
): PickerSelection | null {
  if (chosen !== null) {
    const id = pickerSelectionRowId(chosen);
    const row = rows.find((r) => pickerRowId(r) === id);
    if (row !== undefined && pickerRowEnabled(row)) return chosen;
    if (chosen.kind !== "other") {
      const own = rows.find(
        (r) => r.kind === "session-new" && r.group.projectDir === chosen.projectDir,
      );
      if (own !== undefined) return pickerSelectionOf(own);
    }
  }
  const firstNew = rows.find((r) => r.kind === "session-new");
  if (firstNew !== undefined) return pickerSelectionOf(firstNew);
  const firstSession = rows.find(
    (r) => r.kind === "session-resume" && pickerRowEnabled(r),
  );
  return firstSession !== undefined ? pickerSelectionOf(firstSession) : null;
}

/** The group a selection's project is, among `groups`. */
export function groupOfSelection(
  groups: readonly PickerGroup[],
  selection: PickerSelection | null,
): PickerGroup | null {
  if (selection === null || selection.kind === "other") return null;
  return groups.find((g) => g.projectDir === selection.projectDir) ?? null;
}

/** The grouped list's `TugListView` data source. */
export class PickerRowsDataSource extends Subscribable implements TugListViewDataSource {
  private rows: readonly PickerRow[];
  private version = 0;

  constructor(rows: readonly PickerRow[]) {
    super();
    this.rows = rows;
  }

  numberOfItems(): number {
    return this.rows.length;
  }

  idForIndex(index: number): string {
    return pickerRowId(this.rows[index]);
  }

  kindForIndex(index: number): string {
    return this.rows[index].kind;
  }

  enabledForIndex(index: number): boolean {
    return pickerRowEnabled(this.rows[index]);
  }

  getVersion(): unknown {
    return this.version;
  }

  rowAt(index: number): PickerRow {
    return this.rows[index];
  }

  /** The index of the row with `id`, or `undefined` when it is not shown. */
  indexOfId(id: string): number | undefined {
    const index = this.rows.findIndex((r) => pickerRowId(r) === id);
    return index < 0 ? undefined : index;
  }

  /** Take new rows; `true` when they differ from the held ones. */
  setRowsWithoutNotify(rows: readonly PickerRow[]): boolean {
    if (rows === this.rows) return false;
    this.rows = rows;
    this.version += 1;
    return true;
  }
}

/**
 * Mint one {@link PickerRowsDataSource} per hook lifetime and feed it this
 * render's rows, notifying subscribers from a layout effect when they moved.
 */
export function usePickerRowsDataSource(
  rows: readonly PickerRow[],
): PickerRowsDataSource {
  const ref = useRef<PickerRowsDataSource | null>(null);
  if (ref.current === null) ref.current = new PickerRowsDataSource(rows);
  const ds = ref.current;
  const didChange = ds.setRowsWithoutNotify(rows);
  useLayoutEffect(() => {
    if (didChange) ds.notify();
  });
  return ds;
}
