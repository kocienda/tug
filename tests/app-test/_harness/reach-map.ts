/**
 * reach-map.ts — combine the reach maps one test file's apps dumped.
 *
 * An instrumented deck (`TUG_APPTEST_REACH=1`) answers `window.__tugReach.dump()` with,
 * per module, its distinct named-function count `n` and the names that ran, `hit`. A test
 * file may launch, reload, or quit several apps, and each dump covers only that page's
 * life, so `App.dumpReach()` folds every dump into the file's one map with
 * `unionReachMaps`: a name that ran in any of them ran in the file.
 *
 * Pure, so it runs under `just test-ts` with no app.
 */

/** Per repo-relative module path: its distinct-name count and the names that ran. */
export type ReachMap = Record<string, { n: number; hit: string[] }>;

/** The union of two maps: per module, `n` is the larger and `hit` the set union, sorted. */
export function unionReachMaps(a: ReachMap, b: ReachMap): ReachMap {
  const out: ReachMap = {};
  for (const path of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[path];
    const y = b[path];
    out[path] = {
      n: Math.max(x?.n ?? 0, y?.n ?? 0),
      hit: [...new Set([...(x?.hit ?? []), ...(y?.hit ?? [])])].sort(),
    };
  }
  return out;
}
