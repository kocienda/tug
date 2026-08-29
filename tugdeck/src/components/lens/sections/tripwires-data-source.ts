/**
 * tripwires-data-source.ts — the two `TugListView` data sources the
 * **Tripwires** section stands on: one tripwire per row at level one, one trip
 * per row at level two.
 *
 * Both are the same shape and both are trivial projections of the store's
 * snapshot, because neither level filters, sorts, or groups: the ledger's
 * order is the order (tripwires oldest-first, the order they were laid in;
 * trips newest-first, the order a log is read in), and a section that
 * re-sorted them would be inventing a second opinion about a question the
 * ledger already answered.
 *
 * One cell kind per source — a tripwire row's appearance evolves with its state
 * and never with its kind ([L26]).
 *
 * @module components/lens/sections/tripwires-data-source
 */

import { useLayoutEffect, useRef } from "react";

import type { TugListViewDataSource } from "@/components/tugways/tug-list-view";
import type { TripRow, TripwireRow } from "@/lib/tripwires-store";

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
export type TripsDataSource = ArrayDataSource<TripRow>;

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

/** One tripwire's trip log. */
export function useTripsDataSource(trips: readonly TripRow[]): TripsDataSource {
  return useArrayDataSource(trips, "trip", (t) => String(t.id));
}
