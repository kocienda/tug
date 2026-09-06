/**
 * arc-session-index — "what arc is this session on?", keyed by session.
 *
 * Two reads answered an arc question before this one and neither fits an
 * identity surface. `cardSessionBindingStore.getBinding(cardId)?.arc` is
 * keyed by *card*; `ArcChangesetEntry.bound_session` is keyed by *arc*. A
 * session atom, a Overview citation, or a Cards card row holds a session id and
 * nothing else, so it needs the inverse: session → arc.
 *
 * The inverse is derived, never stored ([D138]). The account-global
 * `CHANGESET_ALL` aggregate already carries every arc and the session bound
 * to it, so this module projects that snapshot into a map on read and
 * memoizes the result on snapshot identity — one build per snapshot, shared
 * by every reader. A bind or unbind moves the aggregate, the map rebuilds,
 * and every surface repaints at once.
 *
 * Both of the aggregate's arc lists are projected. A card can be bound to a
 * arc before its branch exists — the brief/devise/review half of an arc's
 * life — and a session whose binding only appeared once a worktree did would
 * have no arc to show for the half it spent planning.
 */

import { useMemo, useSyncExternalStore } from "react";

import { getChangesetAllStore, useChangesetAll } from "./changeset-all-store";
import {
  cardSessionBindingStore,
  seatedSegmentForSession,
} from "./card-session-binding-store";
import type {
  ArcRunState,
  ArcChangesetEntry,
  WorkspacesChangesetSnapshot,
} from "./changeset-types";
import { documentArcAsEntry } from "./document-arc-entry";

/** What one session's arc binding looks like to an identity surface. */
export interface ArcSessionFact {
  /** The arc's owner key — unique per incarnation of a reused name. */
  readonly ownerId: string;
  /** The arc's display name. */
  readonly name: string;
  /** Derived lifecycle stage, or null from a sender that sends none. */
  readonly stage: string | null;
  /** The run driving this arc, or null when none is — which is every arc
   *  somebody started by hand. Beside {@link stage}, never folded into it. */
  readonly arc: ArcRunState | null;
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
  /** Whether the arc drives a plan at all — what makes a missing step loud. */
  readonly hasPlan: boolean;
  /**
   * The whole wire entry this fact was projected from.
   *
   * Carried so a surface wanting the *detail* — the divergence facts, the
   * base, the join — reads the same object the row surfaces read rather
   * than a second projection that could disagree with this one. Reference
   * identity comes from the snapshot, so exposing it costs no stability: a
   * beat that does not move this arc hands back the same entry.
   */
  readonly entry: ArcChangesetEntry;
}

/**
 * Build the session → arc map from a snapshot. Pure; exported for tests.
 *
 * A session is bound to at most one arc, so the first arc claiming a session
 * wins. "First" is snapshot order — projects in the order the aggregate lists
 * them, entries in the order the project lists them — which makes the tie
 * deterministic rather than merely arbitrary.
 */
export function buildArcSessionIndex(
  snapshot: WorkspacesChangesetSnapshot,
): ReadonlyMap<string, ArcSessionFact> {
  const index = new Map<string, ArcSessionFact>();
  for (const project of snapshot.projects) {
    for (const entry of project.changesets) {
      if (entry.kind !== "arc") continue;
      const boundSession = entry.bound_session;
      if (boundSession === undefined) continue;
      const fact: ArcSessionFact = {
        ownerId: entry.owner_id,
        name: entry.display_name,
        stage: entry.stage ?? null,
        arc: entry.arc ?? null,
        review: entry.review ?? null,
        projectDir: project.project_dir,
        stepCurrent: entry.step_current ?? null,
        stepTotal: entry.step_total ?? null,
        runPosition: entry.run_position ?? null,
        runLength: entry.run_length ?? null,
        stepTitle: entry.step_title ?? null,
        hasPlan: entry.documents?.plan !== undefined,
        entry,
      };
      if (!index.has(boundSession)) index.set(boundSession, fact);
    }
    // The documents-only arcs of the same project, after its live entries so
    // the first-claim rule keeps the live reading for a session that somehow
    // appears on both. `stepTotal` is the one counter a branchless arc really
    // has; the run counters are positions within a declared run, which it has
    // none of.
    for (const arc of project.document_arcs ?? []) {
      const boundSession = arc.bound_session;
      if (boundSession === undefined) continue;
      const fact: ArcSessionFact = {
        ownerId: arc.owner_id,
        name: arc.display_name,
        stage: null,
        arc: arc.arc ?? null,
        review: arc.review ?? null,
        projectDir: project.project_dir,
        stepCurrent: null,
        stepTotal: arc.step_total,
        runPosition: null,
        runLength: null,
        stepTitle: null,
        hasPlan: arc.documents.plan !== undefined,
        entry: documentArcAsEntry(arc),
      };
      if (!index.has(boundSession)) index.set(boundSession, fact);
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
  ReadonlyMap<string, ArcSessionFact>
>();

export function arcSessionIndex(
  snapshot: WorkspacesChangesetSnapshot,
): ReadonlyMap<string, ArcSessionFact> {
  const hit = _cache.get(snapshot);
  if (hit !== undefined) return hit;
  const built = buildArcSessionIndex(snapshot);
  _cache.set(snapshot, built);
  return built;
}

/**
 * The arc a session is working on, or null.
 *
 * **Asked of the segment, answered for the line** ([P01]/[P02]). The
 * aggregate's `bound_session` names whichever segment holds the binding right
 * now, and the Wheel moves that forward every time it rotates a stage
 * (`seat_line_binding`) — while the caller is holding whatever segment id it
 * was minted with: a card's spawn address, a citation's cited id, a telemetry
 * row's own. A direct lookup answers those two ids only while they happen to
 * be the same string, which is to say until the first rotation. So a miss
 * walks segment → card → the card's announced seat and asks again, which is
 * `cardIdForSession`'s walk followed by the seat that walk's card wears.
 *
 * That the incident blanked the masthead sigil and the Z2 ARC cell together
 * is this one lookup failing twice: both are `useArcForSession` over an id the
 * rotation had left behind ([D167]).
 */
export function arcForSession(
  snapshot: WorkspacesChangesetSnapshot,
  sessionId: string | null,
): ArcSessionFact | null {
  if (sessionId === null || sessionId.length === 0) return null;
  const index = arcSessionIndex(snapshot);
  const direct = index.get(sessionId);
  if (direct !== undefined) return direct;
  const seated = seatedSegmentForSession(sessionId);
  if (seated === sessionId) return null;
  return index.get(seated) ?? null;
}

/**
 * The same answer as a **snapshot, with no subscription** — for the callers
 * that have no render to subscribe from.
 *
 * There is one, and it is the composer's session chip: a Canvas bake inside an
 * `<img>`, which can neither subscribe nor cascade ([P14]), and which reaches
 * a fresh answer through the editor's widget regeneration exactly as a rename
 * does. Every React surface uses {@link useArcForSession} instead — this one
 * hands back a value that will not move on its own.
 *
 * Null before the aggregate store is attached, which is the honest answer: no
 * feed has said anything about any arc yet.
 */
export function arcForSessionNow(sessionId: string | null): ArcSessionFact | null {
  const store = getChangesetAllStore();
  if (store === null) return null;
  return arcForSession(store.getSnapshot(), sessionId);
}

/**
 * React hook: the arc a session is working on, read from the account-global
 * aggregate ([L02]). The fact is reference-stable across beats that do not
 * touch this session's arc, so a subscriber repaints only when its own
 * binding moves.
 */
export function useArcForSession(
  sessionId: string | null,
): ArcSessionFact | null {
  const data = useChangesetAll();
  // The seat walk above reads the binding store, so this subscribes to it as
  // well as to the aggregate ([L02]). The two usually move in one beat — a seat
  // bumps `CHANGESET_ALL` and announces itself in the same breath — but
  // "usually" is not an ordering, and a surface that repainted only on the
  // aggregate would hold the pre-rotation answer until something unrelated
  // moved it.
  const seats = useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    cardSessionBindingStore.getSnapshot,
  );
  return useMemo(
    () => arcForSession(data, sessionId),
    // `seats` is a change token, not a value this derivation reads — it is in
    // the dependency list precisely so a seat move re-runs the walk. The store
    // hands back a fresh Map on every write, so identity is the signal.
    [data, sessionId, seats],
  );
}
