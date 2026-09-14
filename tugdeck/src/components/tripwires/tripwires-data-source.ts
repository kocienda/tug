/**
 * tripwires-data-source.ts — the `TugListView` data source the **Tripwires**
 * card stands on: one tripwire per row.
 *
 * A trivial projection of the store's snapshot, because the roster does not
 * filter, sort, or group: the ledger's order is the order — oldest-first, the
 * order the tripwires were laid in — and a card that re-sorted them would be
 * inventing a second opinion about a question the ledger already answered. A
 * tripwire's trip log has no source of its own: the fold draws its rows
 * directly, because a roll-up is not one row per trip and a list view over a
 * projection that collapses rows would have to be told so twice.
 *
 * One cell kind — a tripwire row's appearance evolves with its state and never
 * with its kind ([L26]).
 *
 * @module components/tripwires/tripwires-data-source
 */

import { useLayoutEffect, useRef } from "react";

import type { TugListViewDataSource } from "@/components/tugways/tug-list-view";
import type { TripwireRow } from "@/lib/tripwires-store";

/** A list over an array whose identity is its own change signal. */
class ArrayDataSource<T> implements TugListViewDataSource {
  private rows: readonly T[];
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(
    rows: readonly T[],
    private readonly kind: string,
    private readonly identify: (row: T) => string,
  ) {
    this.rows = rows;
  }

  numberOfItems(): number {
    return this.rows.length;
  }

  idForIndex(index: number): string {
    return this.identify(this.rows[index]);
  }

  kindForIndex(): string {
    return this.kind;
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

  rowAt(index: number): T {
    return this.rows[index];
  }

  setRowsWithoutNotify(next: readonly T[]): boolean {
    if (this.rows === next) return false;
    this.rows = next;
    this.version += 1;
    return true;
  }

  notifyAll(): void {
    for (const listener of this.listeners) listener();
  }
}

export type TripwiresDataSource = ArrayDataSource<TripwireRow>;

function useArrayDataSource<T>(
  rows: readonly T[],
  kind: string,
  identify: (row: T) => string,
): ArrayDataSource<T> {
  const ref = useRef<ArrayDataSource<T> | null>(null);
  if (ref.current === null) ref.current = new ArrayDataSource(rows, kind, identify);
  const ds = ref.current;
  const didChange = ds.setRowsWithoutNotify(rows);
  useLayoutEffect(() => {
    if (didChange) ds.notifyAll();
    // didChange is captured per render; intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });
  return ds;
}

/** The tripwire list — a tripwire's name is its address everywhere, so it is the id. */
export function useTripwiresDataSource(tripwires: readonly TripwireRow[]): TripwiresDataSource {
  return useArrayDataSource(tripwires, "tripwire", (w) => w.name);
}
