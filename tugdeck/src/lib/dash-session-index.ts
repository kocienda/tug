/**
 * dash-session-index — "what dash is this session on?", keyed by session.
 *
 * Two reads answered a dash question before this one and neither fits an
 * identity surface. `cardSessionBindingStore.getBinding(cardId)?.dash` is
 * keyed by *card*; `DashChangesetEntry.bound_sessions` is keyed by *dash*. A
 * session atom, a Overview citation, or a Lens row holds a session id and
 * nothing else, so it needs the inverse: session → dash.
 *
 * The inverse is derived, never stored ([D138]). The account-global
 * `CHANGESET_ALL` aggregate already carries every dash and its bound
 * sessions, so this module projects that snapshot into a map on read and
 * memoizes the result on snapshot identity — one build per snapshot, shared
 * by every reader. A bind or unbind moves the aggregate, the map rebuilds,
 * and every surface repaints at once.
 */

import { useMemo } from "react";

import { useChangesetAll } from "./changeset-all-store";
import type {
  DashChangesetEntry,
  WorkspacesChangesetSnapshot,
} from "./changeset-types";

/** What one session's dash binding looks like to an identity surface. */
export interface DashSessionFact {
  /** The dash's owner key — unique per incarnation of a reused name. */
  readonly ownerId: string;
  /** The dash's display name. */
  readonly name: string;
  /** Derived lifecycle stage, or null from a sender that sends none. */
  readonly stage: string | null;
  /** `reviewed` | `stale` | `never-reviewed`, or null when unknown / no plan. */
  readonly review: string | null;
  /** The owning project's directory (`project_dir` from the snapshot). */
  readonly projectDir: string;
  /** The step being worked, or null when the sender declared no counters.
   *  Plan-absolute — what the ring draws its segments from. */
  readonly stepCurrent: number | null;
  /** How many steps the plan holds, or null when none was declared. */
  readonly stepTotal: number | null;
  /** Position within the *declared run* — the selection somebody asked for,
   *  which is what the numerals count. Null when no run was declared. */
  readonly runPosition: number | null;
  /** That selection's length, or null when no run was declared. */
  readonly runLength: number | null;
  /** What the current step *is* — the latest declaration's title, or null. */
  readonly stepTitle: string | null;
  /** Whether the dash drives a plan at all — what makes a missing step loud. */
  readonly hasPlan: boolean;
  /**
   * The whole wire entry this fact was projected from.
   *
   * Carried so a surface wanting the *detail* — the divergence facts, the
   * base, the join arc — reads the same object the row surfaces read rather
   * than a second projection that could disagree with this one. Reference
   * identity comes from the snapshot, so exposing it costs no stability: a
   * beat that does not move this dash hands back the same entry.
   */
  readonly entry: DashChangesetEntry;
}

/**
 * Build the session → dash map from a snapshot. Pure; exported for tests.
 *
 * A session is bound to at most one dash, so the first dash claiming a session
 * wins. "First" is snapshot order — projects in the order the aggregate lists
 * them, entries in the order the project lists them — which makes the tie
 * deterministic rather than merely arbitrary.
 */
export function buildDashSessionIndex(
  snapshot: WorkspacesChangesetSnapshot,
): ReadonlyMap<string, DashSessionFact> {
  const index = new Map<string, DashSessionFact>();
  for (const project of snapshot.projects) {
    for (const entry of project.changesets) {
      if (entry.kind !== "dash") continue;
      const sessions = entry.bound_sessions ?? [];
      if (sessions.length === 0) continue;
      const fact: DashSessionFact = {
        ownerId: entry.owner_id,
        name: entry.display_name,
        stage: entry.stage ?? null,
        review: entry.review ?? null,
        projectDir: project.project_dir,
        stepCurrent: entry.step_current ?? null,
        stepTotal: entry.step_total ?? null,
        runPosition: entry.run_position ?? null,
        runLength: entry.run_length ?? null,
        stepTitle: entry.step_title ?? null,
        hasPlan: entry.plan_path !== undefined,
        entry,
      };
      for (const sessionId of sessions) {
        if (index.has(sessionId)) continue;
        index.set(sessionId, fact);
      }
    }
  }
  return index;
}

/**
 * The memoized map for a snapshot. Snapshot identity is the cache key, so the
 * projection runs once per aggregate beat no matter how many atoms read it,
 * and the returned map is reference-stable for the snapshot's whole life.
 */
const _cache = new WeakMap<
  WorkspacesChangesetSnapshot,
  ReadonlyMap<string, DashSessionFact>
>();

export function dashSessionIndex(
  snapshot: WorkspacesChangesetSnapshot,
): ReadonlyMap<string, DashSessionFact> {
  const hit = _cache.get(snapshot);
  if (hit !== undefined) return hit;
  const built = buildDashSessionIndex(snapshot);
  _cache.set(snapshot, built);
  return built;
}

/** The dash a session is working on, or null. Pure lookup over a snapshot. */
export function dashForSession(
  snapshot: WorkspacesChangesetSnapshot,
  sessionId: string | null,
): DashSessionFact | null {
  if (sessionId === null || sessionId.length === 0) return null;
  return dashSessionIndex(snapshot).get(sessionId) ?? null;
}

/**
 * React hook: the dash a session is working on, read from the account-global
 * aggregate ([L02]). The fact is reference-stable across beats that do not
 * touch this session's dash, so a subscriber repaints only when its own
 * binding moves.
 */
export function useDashForSession(
  sessionId: string | null,
): DashSessionFact | null {
  const data = useChangesetAll();
  return useMemo(() => dashForSession(data, sessionId), [data, sessionId]);
}
