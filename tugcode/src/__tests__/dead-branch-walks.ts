// Test-side reference walks for chain-aware replay.
//
// `computeDeadEntryIndices` in `../replay.ts` is the shipped walk. These
// are the instruments the tests measure it with:
//
//   - `computeLiveEntryIndices` recomputes the live (bridge-walked)
//     ancestor closure independently, so a test can talk about live and
//     dead as two sets and assert the relations between them;
//   - `computeDeadEntryIndicesLastWins` is the pre-fix walk, kept so a
//     fixture can be shown to discriminate between forward and
//     occurrence-aware parent resolution;
//   - `validateDeadEntryInvariants` states what a correct dead set IS,
//     rather than how big it is — the only way to tell a rescue from an
//     over-correction, since both move the count the same direction.
//
// Test-only by design: the invariants are quadratic-ish to state and the
// replay path stays a single linear walk.

import type { JsonlEntry } from "../replay.ts";

export interface ChainIndex {
  /** Positions of uuid-bearing, non-sidechain entries, ascending. */
  readonly chainIndices: number[];
  /** Every position each uuid appears at, ascending. */
  readonly occurrencesByUuid: Map<string, number[]>;
  /** Positions parented to each uuid, ascending. */
  readonly childIndices: Map<string, number[]>;
}

export function indexChain(
  parsedEntries: ReadonlyArray<JsonlEntry | null>,
): ChainIndex {
  const occurrencesByUuid = new Map<string, number[]>();
  const childIndices = new Map<string, number[]>();
  const chainIndices: number[] = [];
  for (let i = 0; i < parsedEntries.length; i++) {
    const entry = parsedEntries[i];
    if (entry === null) continue;
    if (entry.isSidechain === true) continue;
    if (typeof entry.uuid !== "string" || entry.uuid.length === 0) continue;
    const at = occurrencesByUuid.get(entry.uuid);
    if (at === undefined) occurrencesByUuid.set(entry.uuid, [i]);
    else at.push(i);
    chainIndices.push(i);
    if (typeof entry.parentUuid === "string") {
      const siblings = childIndices.get(entry.parentUuid);
      if (siblings === undefined) childIndices.set(entry.parentUuid, [i]);
      else siblings.push(i);
    }
  }
  return { chainIndices, occurrencesByUuid, childIndices };
}

/** Newest occurrence of `parentUuid` strictly before `childIndex`. */
export function makeResolveParent(
  index: ChainIndex,
): (childIndex: number, parentUuid: string) => number | undefined {
  return (childIndex, parentUuid) => {
    const at = index.occurrencesByUuid.get(parentUuid);
    if (at === undefined) return undefined;
    let lo = 0;
    let hi = at.length - 1;
    let found: number | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (at[mid] < childIndex) {
        found = at[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };
}

export function isCompactionRecord(entry: JsonlEntry): boolean {
  return (
    (entry.type === "system" && entry.subtype === "compact_boundary") ||
    (entry.type === "user" && entry.isCompactSummary === true)
  );
}

/**
 * A genuine user submission: string content, or blocks with at least one
 * non-`tool_result` block. A tool_result echo never roots a branch.
 */
export function isUserSubmission(entry: JsonlEntry): boolean {
  if (entry.type !== "user") return false;
  const content = entry.message?.content;
  if (typeof content === "string") return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b?.type !== "tool_result");
}

/**
 * The live set: the ancestor closure of the newest leaf, bridged
 * backwards across `/compact` chain breaks.
 */
export function computeLiveEntryIndices(
  parsedEntries: ReadonlyArray<JsonlEntry | null>,
): Set<number> {
  const index = indexChain(parsedEntries);
  const resolveParent = makeResolveParent(index);
  const { chainIndices } = index;
  const live = new Set<number>();
  if (chainIndices.length === 0) return live;

  let cursor: number | undefined = chainIndices[chainIndices.length - 1];
  while (cursor !== undefined) {
    let rootIndex: number = cursor;
    let walk: number | undefined = cursor;
    while (walk !== undefined && !live.has(walk)) {
      live.add(walk);
      rootIndex = walk;
      const parent: string | null | undefined =
        parsedEntries[walk]?.parentUuid;
      walk =
        typeof parent === "string" ? resolveParent(walk, parent) : undefined;
    }
    const rootEntry = parsedEntries[rootIndex];
    cursor = undefined;
    if (
      rootEntry !== null &&
      rootEntry !== undefined &&
      isCompactionRecord(rootEntry)
    ) {
      for (let j = chainIndices.length - 1; j >= 0; j--) {
        const candidate = chainIndices[j];
        if (candidate < rootIndex && !live.has(candidate)) {
          cursor = candidate;
          break;
        }
      }
    }
  }
  return live;
}

/**
 * The pre-fix walk, verbatim: `indexByUuid` keeps the LAST position a
 * uuid was seen at, so a `parentUuid` duplicated by a compaction
 * re-append resolves FORWARD into the re-appended copy. Kept as a
 * measuring instrument, never as behavior.
 */
export function computeDeadEntryIndicesLastWins(
  parsedEntries: ReadonlyArray<JsonlEntry | null>,
): Set<number> {
  const indexByUuid = new Map<string, number>();
  const childIndices = new Map<string, number[]>();
  const chain: number[] = [];
  for (let i = 0; i < parsedEntries.length; i++) {
    const entry = parsedEntries[i];
    if (entry === null) continue;
    if (entry.isSidechain === true) continue;
    if (typeof entry.uuid !== "string" || entry.uuid.length === 0) continue;
    indexByUuid.set(entry.uuid, i);
    chain.push(i);
    if (typeof entry.parentUuid === "string") {
      const siblings = childIndices.get(entry.parentUuid);
      if (siblings === undefined) childIndices.set(entry.parentUuid, [i]);
      else siblings.push(i);
    }
  }
  if (chain.length === 0) return new Set();

  const live = new Set<number>();
  let cursor: number | undefined = chain[chain.length - 1];
  while (cursor !== undefined) {
    let rootIndex: number = cursor;
    let walk: number | undefined = cursor;
    while (walk !== undefined && !live.has(walk)) {
      live.add(walk);
      rootIndex = walk;
      const parent: string | null | undefined =
        parsedEntries[walk]?.parentUuid;
      walk = typeof parent === "string" ? indexByUuid.get(parent) : undefined;
    }
    const rootEntry = parsedEntries[rootIndex];
    cursor = undefined;
    if (
      rootEntry !== null &&
      rootEntry !== undefined &&
      isCompactionRecord(rootEntry)
    ) {
      for (let j = chain.length - 1; j >= 0; j--) {
        const candidate = chain[j];
        if (candidate < rootIndex && !live.has(candidate)) {
          cursor = candidate;
          break;
        }
      }
    }
  }

  const dead = new Set<number>();
  const queue: number[] = [];
  for (const i of chain) {
    if (live.has(i)) continue;
    const entry = parsedEntries[i];
    if (entry === null || !isUserSubmission(entry)) continue;
    const parentIndex =
      typeof entry.parentUuid === "string"
        ? indexByUuid.get(entry.parentUuid)
        : undefined;
    if (parentIndex !== undefined && live.has(parentIndex)) queue.push(i);
  }
  while (queue.length > 0) {
    const i = queue.pop()!;
    if (dead.has(i)) continue;
    dead.add(i);
    const uuid = parsedEntries[i]?.uuid;
    if (typeof uuid !== "string") continue;
    for (const child of childIndices.get(uuid) ?? []) {
      if (!dead.has(child)) queue.push(child);
    }
  }
  return dead;
}

export interface DeadInvariantReport {
  /** Human-readable violations; empty means the dead set is valid. */
  readonly violations: string[];
  readonly liveCount: number;
  readonly deadCount: number;
  readonly chainCount: number;
  /** Indices that root the dead set — off-chain, live-parented submissions. */
  readonly deadRoots: number[];
}

/**
 * Assert what a dead set IS, not how big it is.
 *
 * 1. Every dead index roots at an off-chain user submission whose
 *    resolved parent is live — the rewind shape, and nothing else.
 * 2. No dead index is reachable from the newest leaf through the bridged
 *    ancestor walk (dead and live are disjoint).
 * 3. The dead set is complete: no chain entry outside it is a dead root
 *    or parents to a dead entry. This is the half that catches
 *    over-correction, where entries quietly leave the dead set.
 */
export function validateDeadEntryInvariants(
  parsedEntries: ReadonlyArray<JsonlEntry | null>,
  dead: ReadonlySet<number>,
): DeadInvariantReport {
  const violations: string[] = [];
  const index = indexChain(parsedEntries);
  const resolveParent = makeResolveParent(index);
  const live = computeLiveEntryIndices(parsedEntries);

  const deadRootAt = (i: number): boolean => {
    if (live.has(i)) return false;
    const entry = parsedEntries[i];
    if (entry === null || entry === undefined) return false;
    if (!isUserSubmission(entry)) return false;
    const parentIndex =
      typeof entry.parentUuid === "string"
        ? resolveParent(i, entry.parentUuid)
        : undefined;
    return parentIndex !== undefined && live.has(parentIndex);
  };

  const deadRoots = index.chainIndices.filter(deadRootAt);

  // (2) Disjointness.
  for (const i of dead) {
    if (live.has(i)) violations.push(`index ${i} is both live and dead`);
  }

  // (1) Every dead index roots at a dead root, following the same
  // occurrence-aware parent edges the walk descends.
  for (const i of dead) {
    let cursor: number | undefined = i;
    let rooted = false;
    const seen = new Set<number>();
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      if (deadRootAt(cursor)) {
        rooted = true;
        break;
      }
      const at: number = cursor;
      const parentUuid: string | null | undefined = parsedEntries[at]?.parentUuid;
      cursor =
        typeof parentUuid === "string"
          ? resolveParent(at, parentUuid)
          : undefined;
    }
    if (!rooted) {
      violations.push(
        `dead index ${i} does not descend from a live-parented off-chain user submission`,
      );
    }
  }

  // (3) Completeness, in both directions.
  for (const i of deadRoots) {
    if (!dead.has(i)) {
      violations.push(`dead root ${i} is missing from the dead set`);
    }
  }
  for (const i of index.chainIndices) {
    if (dead.has(i)) continue;
    const entry = parsedEntries[i];
    const parentUuid = entry?.parentUuid;
    if (typeof parentUuid !== "string") continue;
    const parentIndex = resolveParent(i, parentUuid);
    if (parentIndex !== undefined && dead.has(parentIndex)) {
      violations.push(
        `index ${i} is live but parents to dead index ${parentIndex}`,
      );
    }
  }

  return {
    violations,
    liveCount: live.size,
    deadCount: dead.size,
    chainCount: index.chainIndices.length,
    deadRoots,
  };
}
