/**
 * CardAppetiteStore — what each card would LIKE of the vertical run it shares.
 *
 * A card's registration declares its floor (`min.height`): the shortest box at
 * which its title bar and one row still paint. That number is a fact about the
 * card's chrome and never moves. What a card wants *beyond* its floor is a fact
 * about its CONTENT — six jots want less room than sixty — and content changes
 * while the app runs, so it cannot live in the registry.
 *
 * This store is the channel for the two tiers above the floor ([B02]):
 *
 * - **comfort** — the height at which the card reads well: enough rows to be
 *   worth looking at, not the whole list.
 * - **natural** — the height at which the card wants nothing more. A list is
 *   its rows; a stream that never ends declares `Infinity`.
 *
 * Every number is computed from the card's own STATE, never measured off the
 * DOM ([B03]): a `ResizeObserver` feeding the layout is the line-box metric
 * loop this codebase has already been bitten by, and a height that depends on
 * the height it produces does not settle.
 *
 * Cards write with {@link CardAppetiteStore.set} from a `useEffect` keyed on
 * the two numbers and {@link CardAppetiteStore.clear} on unmount. The deck
 * manager subscribes, waits a quiet period, and mirrors the snapshot into
 * `DeckState.appetites` — the settled fact the allocator reads ([P05]). The
 * store is the live edge; deck state is the settled one, so a card typing into
 * a list does not re-allocate a rail on every keystroke.
 *
 * **Laws:**
 * - [L02] subscribable store, consumed through the deck store's snapshot
 *   rather than copied through React state.
 * - [L24] structure-zone state crossing the card / layout boundary.
 *
 * @module lib/card-appetite-store
 */

import { useEffect } from "react";

/**
 * One card's vertical appetite, above its registered floor.
 *
 * `natural` is raised to `comfort` at the reader, so a publisher that gets the
 * two the wrong way round costs a taller box rather than an invalid
 * allocation.
 */
export interface CardAppetite {
  /** The height at which the card reads well. */
  readonly comfort: number;
  /** The height at which the card wants nothing more; `Infinity` for a stream. */
  readonly natural: number;
}

function sameAppetite(a: CardAppetite | undefined, b: CardAppetite): boolean {
  return a !== undefined && a.comfort === b.comfort && a.natural === b.natural;
}

/**
 * Two snapshots entry for entry.
 *
 * The store's snapshot is stable until it changes, so identity answers this
 * for every notify the store itself raised. This is for the settled copy in
 * deck state, which is a DIFFERENT object of the same shape and outlives any
 * number of snapshots — a card that publishes, is torn down, and republishes
 * the same numbers must not cost a re-allocation.
 */
export function sameAppetites(
  a: Readonly<Record<string, CardAppetite>>,
  b: Readonly<Record<string, CardAppetite>>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => {
    const entry = b[key];
    return entry !== undefined && sameAppetite(a[key], entry);
  });
}

class CardAppetiteStore {
  private readonly _appetites = new Map<string, CardAppetite>();
  private readonly _listeners = new Set<() => void>();
  private _version = 0;
  private _snapshot: Readonly<Record<string, CardAppetite>> = {};

  /**
   * Declare `componentId`'s appetite. Idempotent: the same two numbers notify
   * nobody, which is what lets a publisher run its effect on every render of
   * the snapshot it computes from.
   */
  set(componentId: string, appetite: CardAppetite): void {
    if (sameAppetite(this._appetites.get(componentId), appetite)) return;
    this._appetites.set(componentId, appetite);
    this._notify();
  }

  /** Withdraw `componentId`'s appetite — its card unmounted. */
  clear(componentId: string): void {
    if (!this._appetites.delete(componentId)) return;
    this._notify();
  }

  /** Read one card's appetite, or `undefined` when it never declared one. */
  get(componentId: string): CardAppetite | undefined {
    return this._appetites.get(componentId);
  }

  /**
   * Every declared appetite, keyed by componentId.
   *
   * The returned object is STABLE until the next change, so a consumer may
   * compare it by identity — a notify that carried nothing hands back the same
   * object, and the deck manager's settle can stop there.
   */
  snapshot(): Readonly<Record<string, CardAppetite>> {
    return this._snapshot;
  }

  /** Monotonic revision, bumped on every change. */
  version(): number {
    return this._version;
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  /** Empty the store. For tests; nothing in the app calls it. */
  reset(): void {
    this._appetites.clear();
    this._listeners.clear();
    this._version = 0;
    this._snapshot = {};
  }

  private _notify(): void {
    // Rebuild the snapshot and bump the revision BEFORE the listeners run: a
    // subscriber reads from inside its own notification, and a snapshot
    // replaced afterwards would hand it the object it already had.
    this._snapshot = Object.fromEntries(this._appetites);
    this._version += 1;
    for (const listener of this._listeners) listener();
  }
}

export const cardAppetiteStore = new CardAppetiteStore();

/**
 * Declare a card's appetite for as long as it is mounted.
 *
 * The publisher every sidebar card uses. The effect is keyed on the two
 * numbers, so a card may compute them on every render from the snapshot it
 * already holds and hand them straight in — an unchanged pair does not even
 * reach the store's own guard. Unmounting withdraws the declaration, so a rail
 * that loses a member stops allocating for it.
 */
export function useCardAppetite(
  componentId: string,
  comfort: number,
  natural: number,
): void {
  useEffect(() => {
    cardAppetiteStore.set(componentId, { comfort, natural });
    return () => {
      cardAppetiteStore.clear(componentId);
    };
  }, [componentId, comfort, natural]);
}
