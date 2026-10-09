/**
 * `useFilteredDataSource` — data-source decorator hook for `TugListView`.
 *
 * Wraps a base `TugListViewDataSource` and exposes a derived data
 * source whose enumeration is `base` filtered by a consumer-supplied
 * predicate. The wrapper implements the `TugListViewDataSource`
 * contract end-to-end so a `<TugListView dataSource={wrapper} />`
 * mount Just Works — the primitive doesn't know it's filtered, and
 * the consumer doesn't have to teach it.
 *
 * ## UISearchController split, not a `TugListView` prop
 *
 * UIKit's `UITableView` doesn't filter — `UISearchController` projects
 * a filtered data source into the table. We follow the same shape:
 *
 *  - The primitive (`TugListView`) stays a single-source-of-truth
 *    consumer of `numberOfItems` / `idForIndex` / `kindForIndex` /
 *    `roleForIndex` / `subscribe` / `getVersion`.
 *  - The host owns the search input (a `TugInput` or any other text
 *    surface) and the predicate-token state.
 *  - This hook composes the two: it returns a `TugListViewDataSource`
 *    the primitive can subscribe to.
 *
 * Why a wrapper rather than a `filterPredicate` prop on `TugListView`:
 *
 *  - The primitive's data-source contract stays the single source of
 *    truth. A `filterPredicate` prop would split that truth into two
 *    places (the data source AND the prop) and force the windowing
 *    math to consult both.
 *  - Wrappers compose. A future `useSortedDataSource` /
 *    `useGroupedDataSource` can stack on top of this one without
 *    growing `TugListView`'s prop surface for each composition.
 *  - Server-side filtering is a drop-in replacement at the base layer
 *    — a consumer who wants the server to filter just builds a
 *    different base data source. No primitive change.
 *
 * ## Contract
 *
 * The hook signature is:
 *
 * ```ts
 * useFilteredDataSource(
 *   base: TugListViewDataSource,
 *   predicate: (baseIndex: number, base: TugListViewDataSource) => boolean,
 *   filterToken: unknown,
 * ): FilteredTugListViewDataSource;
 * ```
 *
 * The returned wrapper:
 *
 *  - Subscribes to `base` (lazily — only while it has its own
 *    listeners). On every base tick it recomputes the projection and
 *    fires its own listeners.
 *  - Recomputes the projection whenever `filterToken` changes
 *    identity (`Object.is`). The token is the contract for "predicate
 *    semantics changed" — the predicate closure itself can change
 *    every render (typical React arrow-in-render), and that ALONE
 *    does not trigger a recompute.
 *  - Always uses the LATEST predicate closure for any recompute
 *    (whether triggered by a base tick or a token change), so the
 *    closure's lexical captures (e.g. a `query` `useState` value) are
 *    fresh.
 *  - Returns a `getVersion()` whose identity changes on every
 *    recompute (`Object.is`-stable when nothing recomputed). The
 *    version is the [L02] update signal for `useSyncExternalStore`;
 *    no recompute → no version churn → no spurious React re-renders.
 *  - Returns a `numberOfItems()` count of base indices passing the
 *    predicate; `idForIndex`, `kindForIndex`, and `roleForIndex` all
 *    route through `baseIndexFor(filteredIndex)` so the same item's
 *    id / kind / role appears at its filtered position with no copy.
 *  - Adds `baseIndexFor(filteredIndex): number` for typed cell
 *    renderers that need to query the base data source's extension
 *    methods (e.g. `SessionTranscriptDataSource.rowAt(baseIndex)`).
 *
 * ## `filterToken` discipline
 *
 * The token's purpose is to declare "predicate semantics changed."
 * Pass a value whose identity changes whenever the predicate's
 * closure starts producing different results. The most common shape
 * is the same value the predicate's closure captures:
 *
 * ```ts
 * const [query, setQuery] = useState("");
 * const filtered = useFilteredDataSource(
 *   base,
 *   (i, ds) => predicateBody(query, i, ds),
 *   query,  // ← token
 * );
 * ```
 *
 * Returning `getVersion()` to stable identity (and skipping
 * recomputes when the token is unchanged) is the [L02] / `Object.is`
 * contract — `useSyncExternalStore` compares snapshots with
 * `Object.is`, and a wrapper that bumps its version every render
 * would force re-renders whenever its host re-rendered.
 *
 * The token can be any value whose identity is meaningful:
 *
 *  - A primitive (string, number, boolean) for one-axis filters.
 *  - A small tuple-like object built with `useMemo` for multi-axis
 *    filters: `useMemo(() => ({ q, mode }), [q, mode])`.
 *  - The base's own version token, if the predicate is a function of
 *    the base data only and changes whenever the base does.
 *
 * Don't construct the token freshly inside the hook call (e.g.
 * `useFilteredDataSource(base, predicate, { q: query })`) — every
 * render creates a new object identity, and the wrapper recomputes on
 * every render. Either lift the token into a primitive (`query`) or
 * memoize the tuple (`useMemo(() => ({ q: query }), [query])`).
 *
 * ## Why class + hook
 *
 * The implementation is a class plus a thin hook. The class owns the
 * state (`baseIndices`, version, listeners, base subscription); the
 * hook is glue that:
 *
 *  - Allocates the class once per hook lifetime (`useRef`).
 *  - Routes `base` identity changes through `setBase` (rare — base is
 *    typically stable for the consumer's lifetime).
 *  - Routes `filterToken` identity changes through `recompute`.
 *  - Notifies subscribers in `useLayoutEffect` so the listener fires
 *    OUTSIDE the current render (safe for React's "no setState
 *    during render" rule).
 *
 * The class is exported `@internal` for direct unit testing — pure
 * projection logic shouldn't require a React render to verify.
 *
 * Laws:
 *  - [L02] external state via `useSyncExternalStore` — the wrapper IS
 *    such a store; subscribe + getVersion is the contract.
 *  - [L03] event-dependent registrations in `useLayoutEffect` — the
 *    notify-after-render effect is here for that reason.
 *  - [L19] component authoring guide — file pair (this file plus its
 *    test file), module docstring, exported types.
 *
 * Decisions:
 *  - tugplan-session-picker-redesign [D01] uitableview-search-split.
 */

import React from "react";

import type {
  TugListViewCellRole,
  TugListViewDataSource,
} from "./tug-list-view";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Predicate signature. Receives the BASE index (not the filtered one)
 * and the base data source itself, so consumers can read the base's
 * typed extension methods inside the predicate body.
 */
export type FilterPredicate = (
  baseIndex: number,
  base: TugListViewDataSource,
) => boolean;

/**
 * The wrapper data source returned by `useFilteredDataSource`.
 *
 * Extends `TugListViewDataSource` with `baseIndexFor` for typed cell
 * renderers that need to query the base's extension methods at the
 * underlying base index.
 */
export interface FilteredTugListViewDataSource extends TugListViewDataSource {
  /**
   * Returns the base index for the item currently at `filteredIndex`.
   *
   * @example
   * ```tsx
   * const Cell: TugListViewCellRenderer<MyDS> = ({ index, dataSource }) => {
   *   // `dataSource` is the wrapper; `index` is the filtered index.
   *   const base = (dataSource as FilteredTugListViewDataSource).baseIndexFor(index);
   *   const row = baseDS.rowAt(base);
   *   ...
   * };
   * ```
   */
  baseIndexFor(filteredIndex: number): number;
}

// ---------------------------------------------------------------------------
// Implementation class (exported @internal for direct testing)
// ---------------------------------------------------------------------------

/**
 * @internal
 *
 * The implementation behind `useFilteredDataSource`. Application
 * code should use the hook; this class is exported for unit tests
 * that exercise the projection logic without spinning up a React
 * render.
 *
 * Lifecycle invariants:
 *  - `version` is a monotonically-increasing number. Each recompute
 *    increments it once, regardless of whether the projection
 *    actually changed (consumers who care can compare snapshots
 *    themselves).
 *  - The base subscription is lazy — attached on first
 *    `subscribe(listener)` call, detached when the last listener
 *    leaves. Recomputes on attach so the projection reflects any
 *    base mutation that happened while detached.
 *  - The constructor performs an initial recompute against the
 *    base's current state. Subscribers attaching later see that
 *    initial projection until the next trigger.
 */
export class FilteredDataSource implements FilteredTugListViewDataSource {
  private base: TugListViewDataSource;
  private predicate: FilterPredicate;
  private baseIndices: number[] = [];
  private listeners = new Set<() => void>();
  private version = 0;
  private baseUnsubscribe: (() => void) | null = null;

  constructor(base: TugListViewDataSource, predicate: FilterPredicate) {
    this.base = base;
    this.predicate = predicate;
    this.recompute();
  }

  // ---- TugListViewDataSource contract ----

  numberOfItems(): number {
    return this.baseIndices.length;
  }

  idForIndex(index: number): string {
    return this.base.idForIndex(this.baseIndices[index]);
  }

  kindForIndex(index: number): string {
    return this.base.kindForIndex(this.baseIndices[index]);
  }

  /**
   * Routes role queries through the base, defaulting to `"cell"`
   * when the base omits `roleForIndex` (matching `TugListView`'s own
   * default per `tug-list-view.tsx` `DEFAULT_CELL_ROLE`).
   */
  roleForIndex(index: number): TugListViewCellRole {
    const base = this.base;
    return base.roleForIndex?.(this.baseIndices[index]) ?? "cell";
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1 && this.baseUnsubscribe === null) {
      this.attachToBase();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.baseUnsubscribe !== null) {
        this.baseUnsubscribe();
        this.baseUnsubscribe = null;
      }
    };
  }

  getVersion(): unknown {
    return this.version;
  }

  // ---- FilteredTugListViewDataSource ----

  baseIndexFor(filteredIndex: number): number {
    return this.baseIndices[filteredIndex];
  }

  // ---- Hook-driven update API ----

  /**
   * Replace the base data source. Detaches from the old base if
   * attached, recomputes against the new base, and re-attaches if a
   * subscription was active. The hook calls this when the `base`
   * argument's identity changes between renders.
   */
  setBase(next: TugListViewDataSource): void {
    if (this.base === next) return;
    const wasAttached = this.baseUnsubscribe !== null;
    if (this.baseUnsubscribe !== null) {
      this.baseUnsubscribe();
      this.baseUnsubscribe = null;
    }
    this.base = next;
    this.recompute();
    if (wasAttached) {
      this.attachToBase();
    }
  }

  /**
   * Replace the stored predicate closure WITHOUT triggering a
   * recompute. The hook calls this on every render so the latest
   * lexical captures are available when the next recompute fires
   * (whether driven by a base tick or a `filterToken` change).
   */
  setLatestPredicate(predicate: FilterPredicate): void {
    this.predicate = predicate;
  }

  /**
   * Recompute the projection against the current predicate. Always
   * bumps `version`; subscribers are NOT notified — that's the
   * caller's job (the hook's layout effect, or the base-subscription
   * listener inside `attachToBase`).
   */
  recompute(): void {
    const total = this.base.numberOfItems();
    const next: number[] = [];
    for (let i = 0; i < total; i += 1) {
      if (this.predicate(i, this.base)) next.push(i);
    }
    this.baseIndices = next;
    this.version += 1;
  }

  /** Fire all subscriber listeners exactly once each. */
  notifyAll(): void {
    for (const listener of this.listeners) listener();
  }

  // ---- Internal ----

  private attachToBase(): void {
    this.baseUnsubscribe = this.base.subscribe(() => {
      // A base tick may or may not change the projection; recompute
      // against the latest state and notify either way (consumers
      // can compare snapshots if they care to elide).
      this.recompute();
      this.notifyAll();
    });
    // Recompute on attach in case the base mutated since we last
    // detached. (Lazy attach + base mutation while detached is the
    // only path to a stale projection at attach time.)
    this.recompute();
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * React hook returning a `FilteredTugListViewDataSource` projection
 * of `base` filtered by `predicate`. See the module docstring for the
 * contract and `filterToken` discipline.
 *
 * @param base         The data source to filter. Identity changes are
 *                     handled (the wrapper detaches and re-attaches),
 *                     but the typical case is a stable base for the
 *                     consumer's lifetime.
 * @param predicate    Per-item filter. Fresh closure per render is
 *                     fine; it is read at recompute time, not stored
 *                     across renders. Receives the BASE index, not
 *                     the filtered one.
 * @param filterToken  Identity sentinel for "predicate semantics
 *                     changed." A `filterToken` whose identity
 *                     differs from the previous render via
 *                     `Object.is` triggers a recompute. Stable
 *                     identity → no recompute.
 *
 * @returns a stable `FilteredTugListViewDataSource` instance suitable
 *          for `<TugListView dataSource={…} />`.
 */
export function useFilteredDataSource(
  base: TugListViewDataSource,
  predicate: FilterPredicate,
  filterToken: unknown,
): FilteredTugListViewDataSource {
  // Single wrapper instance for this hook's lifetime. base/predicate
  // changes are absorbed by the methods below; we don't mint a new
  // wrapper on every base swap so consumers holding the wrapper
  // reference (or passing it to memoized children) don't see
  // spurious identity churn that would cause re-subscribes downstream.
  const wrapperRef = React.useRef<FilteredDataSource | null>(null);
  if (wrapperRef.current === null) {
    wrapperRef.current = new FilteredDataSource(base, predicate);
  }
  const wrapper = wrapperRef.current;

  // Sync the latest predicate closure to the wrapper. The closure
  // captures the latest render's lexical scope, so subsequent base-
  // tick or token-change recomputes use the freshly-bound captures.
  // This is a write per render; no recompute is triggered here.
  wrapper.setLatestPredicate(predicate);

  // Track which triggers fired this render so the layout effect
  // notifies exactly once (or not at all).
  let didChange = false;

  // Base identity change — rare but supported.
  const prevBaseRef = React.useRef<TugListViewDataSource>(base);
  if (prevBaseRef.current !== base) {
    prevBaseRef.current = base;
    wrapper.setBase(base);
    didChange = true;
  }

  // Filter-token change — the common driver. `Object.is` per the
  // contract; a stable token means "predicate semantics unchanged"
  // and we skip the recompute entirely.
  const prevTokenRef = React.useRef<unknown>(filterToken);
  if (!Object.is(prevTokenRef.current, filterToken)) {
    prevTokenRef.current = filterToken;
    wrapper.recompute();
    didChange = true;
  }

  // Notify subscribers in a layout effect so the listener callbacks
  // (which schedule re-renders for subscribed components) fire
  // OUTSIDE the current render. Firing during render is the React
  // anti-pattern that produces "Cannot update a component while
  // rendering a different component" warnings.
  //
  // The effect runs after every commit (no deps array) and notifies
  // only when this render set `didChange`. Renders that don't change
  // the projection (steady state) run a no-op effect.
  React.useLayoutEffect(() => {
    if (didChange) wrapper.notifyAll();
    // didChange is captured from this render's closure; intentional.
  });

  return wrapper;
}
