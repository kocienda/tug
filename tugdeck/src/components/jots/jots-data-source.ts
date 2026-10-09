/**
 * jots-data-source.ts — the `TugListView` data source for the **Jots** card:
 * one row per jot, in document order.
 *
 * Rows come straight from `jotsStore`'s `doc.jots`, narrowed by the
 * card's filter query; the source recomputes when that array reference, the
 * query, or the editing id changes. There is ONE cell kind (`"jot"`) — the
 * same row switches between its incipit-display and its in-place editor by
 * branching on the store's `editingId` inside the cell, never by changing kinds
 * (a kind change is a remount in disguise, [L26]).
 *
 * **The projection is the coordinate space.** Under a filter the row at index
 * `i` is NOT `doc.jots[i]`, so every consumer that turns a list index into
 * a jot must go through `rowAt` / `indexForId` here — never index the doc
 * array by a list index.
 *
 * The row being EDITED is exempt from the filter: an open editor whose text
 * stops matching mid-keystroke must not vanish out from under the caret.
 *
 * Laws:
 *  - [L02] external state via `useSyncExternalStore` — this IS such a store;
 *    the hook mints one stable instance and notifies from `useLayoutEffect`
 *    ([L03]).
 *  - [L19] component authoring — module docstring, exported types.
 *
 * @module components/jots/jots-data-source
 */

import { useLayoutEffect, useRef } from "react";

import type { TugListViewDataSource } from "@/components/tugways/tug-list-view";
import { filterAndRank } from "@/lib/text-match";
import type { Jot } from "@/lib/jots-doc";

export interface JotsInputs {
  readonly jots: readonly Jot[];
  /** The card's filter query. Empty / whitespace → every jot. */
  readonly filterQuery: string;
  /** The jot currently open in its editor, exempt from the filter. */
  readonly editingId: string | null;
}

export class JotsDataSource implements TugListViewDataSource {
  private inputs: JotsInputs;
  private rows: readonly Jot[];
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(inputs: JotsInputs) {
    this.inputs = inputs;
    this.rows = JotsDataSource.project(inputs);
  }

  private static project(inputs: JotsInputs): readonly Jot[] {
    const { jots, filterQuery, editingId } = inputs;
    if (filterQuery.trim().length === 0) return jots;
    // Ranked best-first while filtering; the document's drag order returns the
    // moment the query clears (and reorder is disabled meanwhile, so the two
    // orders never fight).
    const ranked = filterAndRank(jots, filterQuery, (jot) => [jot.text]);
    if (editingId === null || ranked.some((s) => s.id === editingId)) return ranked;
    // The row being edited is exempt from the filter, so an open editor never
    // vanishes mid-keystroke. Unranked, it leads: it is the row the user is
    // working in, and a fixed position beats being shuffled by every keystroke.
    const editing = jots.find((s) => s.id === editingId);
    return editing === undefined ? ranked : [editing, ...ranked];
  }

  numberOfItems(): number {
    return this.rows.length;
  }

  idForIndex(index: number): string {
    return this.rows[index].id;
  }

  kindForIndex(): string {
    return "jot";
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getVersion(): unknown {
    return this.version;
  }

  /** Typed row access for the cell renderer — in FILTERED coordinates. */
  rowAt(index: number): Jot {
    return this.rows[index];
  }

  /** Index of the jot with this id in the projection, or -1 when absent. */
  indexForId(id: string): number {
    return this.rows.findIndex((s) => s.id === id);
  }

  /** Whether a filter is narrowing the list right now. */
  isFiltering(): boolean {
    return this.inputs.filterQuery.trim().length > 0;
  }

  /** How many jots the document holds, filter or no filter. */
  unfilteredCount(): number {
    return this.inputs.jots.length;
  }

  setInputsWithoutNotify(next: JotsInputs): boolean {
    if (
      this.inputs.jots === next.jots &&
      this.inputs.filterQuery === next.filterQuery &&
      this.inputs.editingId === next.editingId
    ) {
      return false;
    }
    this.inputs = next;
    this.rows = JotsDataSource.project(next);
    this.version += 1;
    return true;
  }

  notifyAll(): void {
    for (const listener of this.listeners) listener();
  }
}

/**
 * Hook — mint a stable `JotsDataSource` and feed it the latest
 * `(jots, filterQuery, editingId)` triple each render, notifying
 * subscribers from a layout effect.
 */
export function useJotsDataSource(
  jots: readonly Jot[],
  filterQuery: string,
  editingId: string | null,
): JotsDataSource {
  const ref = useRef<JotsDataSource | null>(null);
  const inputs = { jots, filterQuery, editingId };
  if (ref.current === null) {
    ref.current = new JotsDataSource(inputs);
  }
  const ds = ref.current;
  const didChange = ds.setInputsWithoutNotify(inputs);

  useLayoutEffect(() => {
    if (didChange) ds.notifyAll();
    // didChange is captured per render; intentional.
  });

  return ds;
}
