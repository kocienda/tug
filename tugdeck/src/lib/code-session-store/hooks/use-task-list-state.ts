/**
 * `useTaskListState` — derive the current task list ([D100]) from a
 * `CodeSessionStore` snapshot.
 *
 * Walks every committed turn's `messages` filtered to `tool_use`, then
 * the in-flight turn's `activeTurn.messages` (same filter), feeding the
 * concatenated stream into {@link reduceTaskListState}. The two are
 * disjoint by `tool_use_id` (each turn carries its own ids), so
 * concatenation is safe and order-preserving for the reducer's
 * `TaskCreate` → `TaskUpdate` pairing.
 *
 * **Persistence, not turn-scoping.** The wire never emits a "clear"
 * frame for the task list (verified against the v2.1.150 fixtures and
 * live session 45208c42 — each user prompt's `promptId` owns its own
 * Task* events, with no reset signal between prompts). The fold is
 * therefore unconditional: every Task* event across the whole
 * transcript folds into the current batch, and the list persists across
 * turn boundaries. It empties two ways, both driven by the events
 * themselves: the reducer's batch-boundary supersede (a fresh
 * `TaskCreate` arriving over a fully-completed list starts a new
 * batch, so accumulated history never piles up), and explicit
 * `TaskUpdate` deletion, which removes the named task outright.
 *
 * An earlier revision gated visibility on whether the *latest turn* had
 * a Task* event, returning the empty state otherwise. That collapsed
 * the whole checklist to zero the instant a new turn opened (before it
 * streamed its first Task* frame), then restored it — the observed
 * "6/7 → None → restored" flicker. The gate is gone; the WORK cell's
 * completion linger governs the graceful settle to "None" instead.
 *
 * Under [D07] the in-flight tool calls live on the snapshot directly
 * (`activeTurn.messages`) — the previous implementation subscribed to
 * a PropertyStore path that mirrored them as JSON. Reading from the
 * snapshot eliminates the parallel storage and keeps the substrate the
 * single source of truth.
 *
 * Returns a stable {@link TaskListState}. Re-derives only when one of
 * the inputs (`transcript` / `activeTurn.messages`) changes identity.
 *
 * Laws: [L02] external state through `useSyncExternalStore`.
 *
 * @module lib/code-session-store/hooks/use-task-list-state
 */

import { useMemo } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import type { CodeSessionStore } from "@/lib/code-session-store";
import {
  reduceTaskListState,
  type TaskListState,
} from "@/lib/code-session-store/select-task-list";
import type { Message, ToolUseMessage, TurnEntry } from "@/lib/code-session-store/types";

/**
 * Walk every committed turn's `tool_use` Messages in turn-order, then
 * the in-flight turn's `tool_use` Messages. The two are disjoint by
 * `tool_use_id`, so concatenation is safe and the order matches the
 * event stream — required for {@link reduceTaskListState}'s
 * order-sensitive fold (`TaskCreate` must land before any `TaskUpdate`
 * it pairs with).
 *
 * Exported so the persistence behavior (fold spans the whole transcript
 * regardless of turn boundaries) is pin-able without a React store.
 */
export function* iterateAllTaskCalls(
  transcript: ReadonlyArray<TurnEntry>,
  inflight: ReadonlyArray<Message>,
): IterableIterator<ToolUseMessage> {
  for (const turn of transcript) {
    for (const m of turn.messages) {
      if (m.kind === "tool_use") yield m;
    }
  }
  for (const m of inflight) {
    if (m.kind === "tool_use") yield m;
  }
}

/**
 * Subscribe to the session and return the current {@link TaskListState}
 * assembled from every committed Task* call plus the in-flight turn's
 * live ones. The fold is unconditional: the list is the current batch
 * (per the reducer's batch-boundary supersede) and persists across the
 * gap when a new turn opens before it has streamed a Task* frame — it
 * does not collapse to empty in that gap (see module docstring). The
 * WORK cell's completion linger governs the graceful settle instead.
 * Re-derives only when one of the inputs changes identity.
 */
export function useTaskListState(
  codeSessionStore: CodeSessionStore,
): TaskListState {
  const snapshot = useSyncExternalStore(
    codeSessionStore.subscribe,
    codeSessionStore.getSnapshot,
  );
  const inflightMessages = snapshot.activeTurn?.messages ?? null;

  return useMemo<TaskListState>(
    () =>
      reduceTaskListState(
        iterateAllTaskCalls(snapshot.transcript, inflightMessages ?? []),
      ),
    [snapshot.transcript, inflightMessages],
  );
}
