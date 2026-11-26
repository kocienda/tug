/**
 * cycle-store — every cycle, one cycle by id, and the cycles a session is in.
 *
 * A cycle is a set of briefs the user means to land together, each tied to
 * the arc that carries it. The server composes them onto the account-global
 * `CHANGESET_ALL` aggregate, beside the arc rows whose arc log they are read
 * from, so an entry reading `running` and its arc's row arrive in one frame
 * and cannot disagree. This module holds no feed of its own: it projects that
 * snapshot on read and memoizes the projection on snapshot identity, the
 * shape `arc-session-index.ts` takes ([D138]). Every reader goes through
 * `useSyncExternalStore` ([L02]).
 *
 * **The cycles a session belongs to** are those it wrote (`created_by`), and
 * those with an entry it is bound to or ran a stage of. Like the arc index,
 * each session is filed under both the segment the frame names and that
 * segment's line, because a caller holds a segment and a rotated card's
 * history names earlier ones.
 *
 * With no aggregate store attached (the gallery, a fixture) every answer is a
 * frozen empty, so a reader never sees a fresh `[]` on each render.
 */

import { useMemo } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import { useChangesetAll } from "./changeset-all-store";
import type { CycleWire, WorkspacesChangesetSnapshot } from "./changeset-types";
import { sessionLineStore } from "./session-line-store";

/** The projection of one snapshot. */
export interface CycleIndex {
  /** Every cycle, across projects, in the order the frame sends them. */
  readonly all: readonly CycleWire[];
  /** Each cycle by its id. */
  readonly byId: ReadonlyMap<string, CycleWire>;
  /** Each session's cycles, keyed by segment and by line, in frame order. */
  readonly bySession: ReadonlyMap<string, readonly CycleWire[]>;
}

const NO_CYCLES: readonly CycleWire[] = Object.freeze([]);

/** The ids of the sessions a cycle names, its writer first. */
function sessionsOf(cycle: CycleWire): string[] {
  const ids: string[] = [];
  if (cycle.created_by !== undefined) ids.push(cycle.created_by);
  for (const entry of cycle.entries) {
    if (entry.bound_session !== undefined) ids.push(entry.bound_session);
    for (const stage of entry.stages ?? []) ids.push(stage.session_id);
  }
  return ids;
}

/**
 * Build the projection from a snapshot. Pure; exported for tests.
 *
 * A cycle is filed under a session once, however many times the cycle names
 * it, and a session's list keeps the frame's order. The line comes from
 * `lineOf`, the deck's durable segment-to-line map, defaulted to the store
 * every caller but a test passes.
 */
export function buildCycleIndex(
  snapshot: WorkspacesChangesetSnapshot,
  lineOf: (sessionId: string) => string | null = sessionLineStore.lineOf,
): CycleIndex {
  const all: CycleWire[] = [];
  const byId = new Map<string, CycleWire>();
  const bySession = new Map<string, CycleWire[]>();
  const file = (key: string, cycle: CycleWire): void => {
    const list = bySession.get(key);
    if (list === undefined) bySession.set(key, [cycle]);
    else if (list[list.length - 1] !== cycle) list.push(cycle);
  };
  for (const project of snapshot.projects) {
    for (const cycle of project.cycles ?? []) {
      all.push(cycle);
      if (!byId.has(cycle.id)) byId.set(cycle.id, cycle);
      for (const session of sessionsOf(cycle)) {
        file(session, cycle);
        const line = lineOf(session);
        if (line !== null && line !== session) file(line, cycle);
      }
    }
  }
  for (const list of bySession.values()) Object.freeze(list);
  return {
    all: all.length === 0 ? NO_CYCLES : Object.freeze(all),
    byId,
    bySession,
  };
}

/**
 * The memoized projection for a snapshot: one build per aggregate beat,
 * reference-stable for every reader. The line store's version rides beside
 * the snapshot, because the line keys are built from it and it moves on its
 * own beat.
 */
const _cache = new WeakMap<
  WorkspacesChangesetSnapshot,
  { readonly version: number; readonly index: CycleIndex }
>();

export function cycleIndex(snapshot: WorkspacesChangesetSnapshot): CycleIndex {
  const version = sessionLineStore.getVersion();
  const hit = _cache.get(snapshot);
  if (hit !== undefined && hit.version === version) return hit.index;
  const index = buildCycleIndex(snapshot);
  _cache.set(snapshot, { version, index });
  return index;
}

/** One cycle by id, or null. */
export function cycleById(
  snapshot: WorkspacesChangesetSnapshot,
  id: string | null,
): CycleWire | null {
  if (id === null) return null;
  return cycleIndex(snapshot).byId.get(id) ?? null;
}

/**
 * The cycles a session belongs to, asked of the segment and answered for the
 * line: the segment's own list when the frame names it, else its line's.
 */
export function cyclesForSession(
  snapshot: WorkspacesChangesetSnapshot,
  sessionId: string | null,
): readonly CycleWire[] {
  if (sessionId === null || sessionId.length === 0) return NO_CYCLES;
  const { bySession } = cycleIndex(snapshot);
  const direct = bySession.get(sessionId);
  if (direct !== undefined) return direct;
  const line = sessionLineStore.lineOf(sessionId);
  if (line !== null && line !== sessionId) {
    return bySession.get(line) ?? NO_CYCLES;
  }
  return NO_CYCLES;
}

/** The line store's version, as a change token for the hooks below. */
function useLineVersion(): number {
  return useSyncExternalStore(
    sessionLineStore.subscribe,
    sessionLineStore.getVersion,
  );
}

/** React hook: every cycle, across projects, in frame order. */
export function useCycles(): readonly CycleWire[] {
  const data = useChangesetAll();
  const lines = useLineVersion();
  // `lines` is an invalidation key: the memo inside `cycleIndex` reads the
  // line store's version itself.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `lines` is the invalidation key named above
  return useMemo(() => cycleIndex(data).all, [data, lines]);
}

/** React hook: one cycle by id, or null. */
export function useCycle(id: string | null): CycleWire | null {
  const data = useChangesetAll();
  return useMemo(() => cycleById(data, id), [data, id]);
}

/** React hook: the cycles a session belongs to. */
export function useCyclesForSession(
  sessionId: string | null,
): readonly CycleWire[] {
  const data = useChangesetAll();
  const lines = useLineVersion();
  return useMemo(
    () => cyclesForSession(data, sessionId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `lines` is the invalidation key: the line keys are built from the line store
    [data, sessionId, lines],
  );
}
