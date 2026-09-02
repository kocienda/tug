/**
 * Public types for `TugDevLogStore` — the in-app logging surface that
 * backs the `Log` section on the DevTools card.
 *
 * The store is append-only from the app's perspective: anywhere in
 * tugdeck can call `tugDevLogStore.{debug,info,warn,error}(...)` to
 * record an event. The inspector renders the buffered entries with
 * filter / clear / copy affordances.
 *
 * Conformance:
 *   - [L02] external store; React reads via `useSyncExternalStore`.
 *   - Filter state + cap persist via tugbank under
 *     `dev.tugtool.dev-panel/{logFilterLevels,logFilterSource,logMaxEntries}`.
 *     Free-text filter is in-memory only (not persisted) — see
 *     `TugDevLogFilters.text` below.
 *
 * @module lib/tug-dev-log-store/types
 */

/**
 * Severity level for a log entry. The four levels mirror the
 * browser console (`console.debug/info/warn/error`) which is what
 * the dev-build mirror writes to.
 */
export type TugDevLogLevel = "debug" | "info" | "warn" | "error";

/** All four levels, in display order (least to most severe). */
export const TUG_DEV_LOG_LEVELS: readonly TugDevLogLevel[] = [
  "debug",
  "info",
  "warn",
  "error",
];

/** Full set of levels — the default for `TugDevLogFilters.levels`. */
export const ALL_TUG_DEV_LOG_LEVELS: ReadonlySet<TugDevLogLevel> = new Set<TugDevLogLevel>(
  TUG_DEV_LOG_LEVELS,
);

/**
 * One log entry. Created by the store on `log()`; never mutated after
 * creation. Callers MUST NOT mutate the `data` field after passing it
 * to the store — the store does not deep-clone. Cheap appends matter
 * more than defending against caller-side aliasing.
 */
export interface TugDevLogEntry {
  /** Monotonically increasing id minted by the store. */
  id: number;
  /** `Date.now()` at append time. */
  timestamp: number;
  level: TugDevLogLevel;
  /** Short subsystem tag, e.g. "code-session-store", "tugdevpanel". */
  source: string;
  /** Human-readable one-line message. */
  message: string;
  /**
   * Optional structured payload; serialised to JSON in copy paths and
   * (lazily, WeakMap-cached) for free-text search.
   *
   * Mutation contract — see file-level note: callers must not mutate
   * this object after passing it in.
   */
  data?: unknown;
}

/**
 * Active filter view over the buffer. The reducer applies these as a
 * derived projection — clearing a filter never destroys entries.
 */
export interface TugDevLogFilters {
  /**
   * Levels currently shown. Empty set excludes everything. Default:
   * all four levels. Persisted to tugbank as `kind: "json"`.
   */
  levels: ReadonlySet<TugDevLogLevel>;
  /**
   * `null` means "all sources." Specific value shows only matching
   * `entry.source`. Persisted as `kind: "string"` or `kind: "null"`.
   * A specific source value may name a source not currently present
   * in the buffer — perfectly valid, the list just renders empty
   * until matching entries appear.
   */
  source: string | null;
  /**
   * Free-text query, matched case-insensitively against `entry.message`
   * AND `JSON.stringify(entry.data)`. Empty string = no text filter.
   *
   * NOT persisted — text filters are session-bound queries, not
   * preferences. Survives tab switch (store outlives inspector mount);
   * lost on page reload (intentional).
   */
  text: string;
}

/**
 * Public snapshot returned by `TugDevLogStore.getSnapshot()`. Stable
 * reference between dispatches that produce no observable change.
 */
export interface TugDevLogSnapshot {
  /** Buffer of entries, oldest first (newest is last). */
  entries: readonly TugDevLogEntry[];
  /** Active filter view. */
  filters: TugDevLogFilters;
  /** Current ring-buffer cap. */
  maxEntries: number;
  /**
   * Display direction for the inspector list.
   *
   *   - `false` (default): oldest at top, newest appended below
   *     (`tail -f` convention — auto-scroll-to-bottom pins on append).
   *   - `true`: newest at top, oldest pushed below
   *     (browser-devtools convention — auto-scroll-to-top pins on append).
   *
   * The buffer itself is always stored oldest-first; this flag only
   * controls the inspector's render order and auto-scroll pivot.
   * Persisted via tugbank as `kind: "bool"` under `logNewestFirst`.
   */
  newestFirst: boolean;
  /**
   * Monotonic version counter that increments on every state change.
   * Useful for memoization keys in consumers that don't want to deep
   * compare entries on every render.
   */
  version: number;
}

/**
 * Default ring-buffer cap. 1000 short rows fit a single DOM in
 * ~10-20ms without virtualisation.
 */
export const DEFAULT_DEV_LOG_MAX_ENTRIES = 1000;

/**
 * Default for `TugDevLogSnapshot.newestFirst`. `false` matches the
 * `tail -f` convention developers expect from a log viewer; the
 * inspector exposes a toggle for users who prefer the browser-devtools
 * newest-at-top layout.
 */
export const DEFAULT_DEV_LOG_NEWEST_FIRST = false;

/**
 * Hard floor for the cap. A buffer of 0 would render an unconditionally
 * empty list — useful for an "off" mode but reachable only via direct
 * tugbank writes. The default is well above the floor.
 */
export const MIN_DEV_LOG_MAX_ENTRIES = 0;

/**
 * Build the default filter set used at store initialization and after
 * a `_disposeForTest()`.
 */
export function createDefaultFilters(): TugDevLogFilters {
  return {
    levels: ALL_TUG_DEV_LOG_LEVELS,
    source: null,
    text: "",
  };
}
