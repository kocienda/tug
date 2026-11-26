/**
 * useSessionCycle — the cycle a session's card shows, or null.
 *
 * One hook for the shade's frame, its body and the status cell, so the three
 * cannot disagree about which cycle the card is showing. The rule is
 * `chooseCycle`'s: the cycle holding the arc the session is bound to, none
 * when no cycle holds that arc, and otherwise the most recently changed cycle
 * the session belongs to.
 *
 * Laws: [L02] the cycles enter through the cycle store's
 *       `useSyncExternalStore` hooks
 */

import { useMemo } from "react";

import type { CycleWire } from "@/lib/changeset-types";
import { useCycles, useCyclesForSession } from "@/lib/cycle-store";

import { chooseCycle } from "./session-cycle-shade-model";

export function useSessionCycle(sessionId: string | null, boundOwnerId: string | null): CycleWire | null {
  const all = useCycles();
  const mine = useCyclesForSession(sessionId);
  return useMemo(() => chooseCycle(all, mine, boundOwnerId), [all, mine, boundOwnerId]);
}
