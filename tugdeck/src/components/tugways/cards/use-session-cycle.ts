/**
 * useSessionCycle — the cycle a session's card shows, or null.
 *
 * One hook for the shade's frame, its body and the status cell, so the three
 * cannot disagree about which cycle the card is showing. The rule is
 * `chooseCycle`'s: the cycle holding the arc the session is bound to, none
 * when no cycle holds that arc, and otherwise the most recently changed cycle
 * the session belongs to.
 *
 * `useShadeCycle` is what the shade draws: the same cycle, and for a bound
 * arc that no cycle holds yet, the cycle of one it is about to be, composed
 * by `standInCycle` from the arc's own facts. The cell reads only a cycle on
 * record, so an arc that never reaches one reads as its arc alone.
 *
 * Laws: [L02] the cycles enter through the cycle store's
 *       `useSyncExternalStore` hooks
 */

import { useMemo } from "react";

import type { ArcSessionFact } from "@/lib/arc-session-index";
import type { CycleWire } from "@/lib/changeset-types";
import { useCycles, useCyclesForSession } from "@/lib/cycle-store";

import { chooseCycle, standInCycle } from "./session-cycle-shade-model";

export function useSessionCycle(sessionId: string | null, boundOwnerId: string | null): CycleWire | null {
  const all = useCycles();
  const mine = useCyclesForSession(sessionId);
  return useMemo(() => chooseCycle(all, mine, boundOwnerId), [all, mine, boundOwnerId]);
}

/** The cycle the shade draws: the session's cycle, or its bound arc's stand-in. */
export function useShadeCycle(sessionId: string | null, arc: ArcSessionFact | null): CycleWire | null {
  const cycle = useSessionCycle(sessionId, arc?.ownerId ?? null);
  return useMemo(() => cycle ?? (arc === null ? null : standInCycle(arc)), [cycle, arc]);
}
