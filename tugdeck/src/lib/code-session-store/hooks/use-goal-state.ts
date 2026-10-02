/**
 * `useGoalState` — read the session's `/goal` from a `CodeSessionStore`
 * snapshot.
 *
 * The goal lives ON the snapshot (`CodeSessionSnapshot.goal`,
 * reference-stable across quiescent rebuilds), so the hook is a thin
 * `useSyncExternalStore` selector — no derivation, no memo. Like jobs
 * (and unlike the turn-scoped task list) goal state is session-lifetime:
 * a goal run spans evaluator rounds inside one long cycle, and a set
 * goal survives between turns until achieved or cleared.
 *
 * Laws: [L02] external state through `useSyncExternalStore`.
 *
 * @module lib/code-session-store/hooks/use-goal-state
 */

import { useCallback } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import type { CodeSessionStore } from "@/lib/code-session-store";
import type { GoalState } from "@/lib/code-session-store/select-goal";

/** Subscribe to the store and return the current goal (null when none). */
export function useGoalState(store: CodeSessionStore): GoalState | null {
  const getGoal = useCallback(() => store.getSnapshot().goal, [store]);
  return useSyncExternalStore(store.subscribe, getGoal, getGoal);
}
