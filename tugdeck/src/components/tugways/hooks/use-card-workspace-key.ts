/**
 * useCardWorkspaceKey — subscribe to a card's workspace_key binding.
 *
 * Returns the canonical `workspace_key` string for the given `cardId` if
 * the card has an active session binding (set by `spawn_session_ok`), or
 * `undefined` when the card is unbound.
 *
 * **Laws:** [L02] External state enters React only through
 * `useSyncExternalStore`.
 *
 * @module components/tugways/hooks/use-card-workspace-key
 */

import { useSyncExternalStore } from "@/lib/gesture-scope";

import { cardSessionBindingStore } from "@/lib/card-session-binding-store";

export function useCardWorkspaceKey(cardId: string): string | undefined {
  return useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    () => cardSessionBindingStore.getBinding(cardId)?.workspaceKey,
  );
}
