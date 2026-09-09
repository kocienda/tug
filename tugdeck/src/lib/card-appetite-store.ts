/**
 * CardAppetiteStore — what each card would LIKE of the vertical run it shares.
 *
 * A card's registration declares its floor (`min.height`): the shortest box at
 * which its title bar and one row still paint. That number is a fact about the
 * card's chrome and never moves. What a card wants *beyond* its floor is a fact
 * about its CONTENT — six jots want less room than sixty — and content changes
 * while the app runs, so it cannot live in the registry.
 *
 * This store is the channel for the ONE tier above the floor ([B03]):
 * **natural** — the height at which the card wants nothing more. A list is its
 * rows; a stream that never ends is never measured at all and declares nothing
 * here, its natural being read as endless from the registry ([B05]).
 *
 * There was a second tier — comfort, the height at which a card read well —
 * and it existed so a fitting rail's ladder could hold every card at a
 * readable height before dividing the rest. That ladder is gone: the seed
 * reads floors and naturals, flow reads naturals, and nothing read comfort.
 * A tier every card had to compute and nothing consumed is a number that can
 * only be wrong.
 *
 * The number is MEASURED, never summed ([B01]). Every content card hands
 * {@link useMeasuredCardAppetite} a ref for its one content element — the
 * in-flow column of everything it draws, inside its scroller and stretched by
 * nothing — and a `ResizeObserver` publishes that element's border-box height.
 * A card that summed pixel constants was declaring what it believed it drew;
 * the two drifted every time a row's padding moved, and only the card's own
 * scrollbar ever said so.
 *
 * Measuring is safe here because the content element cannot see the height it
 * feeds ([B02]): the pane's run reaches the scroller and stops, so a taller
 * pane leaves the column exactly as tall as it was. That is one leg of the
 * feedback loop the no-measurement rule was written against, and one leg
 * cannot oscillate.
 *
 * The deck manager subscribes, waits a quiet period, and mirrors the snapshot
 * into `DeckState.appetites` — the settled fact the allocator reads ([P05]).
 * The store is the live edge; deck state is the settled one, so a card typing
 * into a list does not re-allocate a rail on every keystroke.
 *
 * **Laws:**
 * - [L02] subscribable store, consumed through the deck store's snapshot
 *   rather than copied through React state.
 * - [L24] structure-zone state crossing the card / layout boundary.
 *
 * @module lib/card-appetite-store
 */

import { useCallback, useEffect, useRef } from "react";

/**
 * One card's vertical appetite, above its registered floor. One number: the
 * height at which the card wants nothing more.
 */
export interface CardAppetite {
  /** The height at which the card wants nothing more. */
  readonly natural: number;
}

function sameAppetite(a: CardAppetite | undefined, b: CardAppetite): boolean {
  return a !== undefined && a.natural === b.natural;
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
   * Declare `componentId`'s appetite. Idempotent: the same number notifies
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
 * Measure a card's appetite for as long as it is mounted, and publish it.
 *
 * The publisher every CONTENT sidebar card uses; a stream never calls it
 * ([B05]). Returns a ref callback for the card's **content element** — the one
 * in-flow column holding everything the card draws, from its toolbar to its
 * last row, inside the card's scroller with nothing stretched between them. A
 * `ResizeObserver` on that element publishes its border-box height, and the
 * card's `natural` is that height plus `chromePx`: the pane chrome standing
 * ABOVE the scroller, which the content element cannot see and which the
 * member's own box nonetheless carries ([B01]).
 *
 * Nothing here is timed. A `ResizeObserver` fires per layout and the store's
 * settle already waits out the quiet period before deck state moves ([B04]),
 * so a card whose content is still arriving publishes once, when it stops.
 *
 * A ref CALLBACK rather than a ref object, because the element is not one
 * element for the card's life: an empty card and a populated one draw
 * different columns, and Tripwires swaps its whole level. React runs the
 * callback in the commit phase — at layout time, before paint ([L03]) — so the
 * observer is attached to whichever column is standing, and the first height
 * is published from the node itself rather than waited for.
 *
 * The value crosses into React through the store alone ([L02]); this hook
 * holds no state and renders nothing.
 */
export function useMeasuredCardAppetite(
  componentId: string,
  chromePx: number,
): (node: HTMLElement | null) => void {
  const observed = useRef<{ node: HTMLElement; observer: ResizeObserver } | null>(
    null,
  );

  // Unmount withdraws the declaration, so a rail that loses a member stops
  // allocating for it. The ref callback's own `null` call does the same for a
  // column that merely went away, and this is the balance for the card itself.
  useEffect(() => {
    return () => {
      observed.current?.observer.disconnect();
      observed.current = null;
      cardAppetiteStore.clear(componentId);
    };
  }, [componentId]);

  return useCallback(
    (node: HTMLElement | null) => {
      if (observed.current?.node === node) return;
      observed.current?.observer.disconnect();
      observed.current = null;
      if (node === null) return;
      const publish = (blockSize: number): void => {
        cardAppetiteStore.set(componentId, {
          natural: Math.round(chromePx + blockSize),
        });
      };
      const observer = new ResizeObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (entry === undefined) return;
        // The border box, which is what the member's own box is: a content
        // element with padding or a border still stands at the height it
        // paints. `contentRect` is the fallback for a browser that reports no
        // `borderBoxSize`, where the two agree for a box with neither.
        const box = entry.borderBoxSize?.[0];
        publish(box === undefined ? entry.contentRect.height : box.blockSize);
      });
      observer.observe(node);
      observed.current = { node, observer };
      publish(node.getBoundingClientRect().height);
    },
    [componentId, chromePx],
  );
}
