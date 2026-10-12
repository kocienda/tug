/**
 * parse-counters — module-level counters for the transcript's
 * per-row markdown-parse economy.
 *
 * Three counters, matching the `perf.row_parse` instrumentation
 * shape:
 *
 *   - `parses` — full markdown parse passes
 *     (`parseMarkdownToSanitizedBlocks` via `renderIncremental`),
 *     attributed to a row identity (the streaming path
 *     `turn.${turnKey}.message.${messageKey}.text`, or `"static"`
 *     for mount-once `initialText` renders).
 *   - `cacheHits` — renders served from the render-once parse cache.
 *     Always 0 until the cache exists; wired now so the counter
 *     shape (and its consumers) don't change when it lands.
 *   - `memoHits` — finalized-row re-renders skipped by component
 *     memoization. Always 0 until rows are memoized.
 *
 * The per-identity map is what makes the parse-once invariant
 * falsifiable: after it holds, no identity's count exceeds 1 across
 * a replay → live turn → scroll → tab-switch round trip.
 *
 * Plain module state, not a store: the counters are diagnostics read
 * imperatively (perf summaries, tests, the dev panel's log entries),
 * never rendered reactively — no subscription surface needed.
 */

export interface RowParseCountersSnapshot {
  /** Total full parse passes since the last reset. */
  parses: number;
  /** Renders served from the render-once cache (0 pre-cache). */
  cacheHits: number;
  /** Finalized-row re-renders skipped by memoization (0 pre-memo). */
  memoHits: number;
  /** Distinct row identities that parsed at least once. */
  identities: number;
  /** Highest per-identity parse count — 1 when parse-once holds. */
  maxParsesPerIdentity: number;
}

let parses = 0;
let cacheHits = 0;
let memoHits = 0;
const parsesByIdentity = new Map<string, number>();

/** Record one full markdown parse attributed to `identity`. */
export function recordRowParse(identity: string): void {
  parses += 1;
  parsesByIdentity.set(identity, (parsesByIdentity.get(identity) ?? 0) + 1);
}

/** Record one render served from the render-once parse cache. */
export function recordRowCacheHit(): void {
  cacheHits += 1;
}

/** Record one finalized-row re-render skipped by memoization. */
export function recordRowMemoHit(): void {
  memoHits += 1;
}

/** Parse count for one identity (0 when it never parsed). */
export function parsesForIdentity(identity: string): number {
  return parsesByIdentity.get(identity) ?? 0;
}

/**
 * Every identity's parse count since the last reset, as a plain record —
 * what a reading diffs across a window to split the parses by whose row
 * they were (a live turn's `turn.${turnKey}.…` path, or anything else).
 */
export function snapshotParsesByIdentity(): Record<string, number> {
  return Object.fromEntries(parsesByIdentity);
}

/** Point-in-time snapshot of all counters. */
export function snapshotRowParseCounters(): RowParseCountersSnapshot {
  let max = 0;
  for (const n of parsesByIdentity.values()) {
    if (n > max) max = n;
  }
  return {
    parses,
    cacheHits,
    memoHits,
    identities: parsesByIdentity.size,
    maxParsesPerIdentity: max,
  };
}

/** Zero every counter and forget all identities. */
export function resetRowParseCounters(): void {
  parses = 0;
  cacheHits = 0;
  memoHits = 0;
  parsesByIdentity.clear();
}
