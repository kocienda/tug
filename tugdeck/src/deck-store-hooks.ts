/**
 * deck-store-hooks.ts — React hooks over the deck-store selectors.
 *
 * Each hook here is the `useSyncExternalStore` counterpart of a pure
 * selector in `deck-store-selectors.ts`. They exist so React consumers
 * can subscribe without hand-rolling `subscribe` / `getSnapshot`
 * wrappers, and so the choice of "what to subscribe to" lives in one
 * file adjacent to the selector it wraps.
 *
 * Hooks here uphold [L02] (external state enters React through
 * `useSyncExternalStore` only). They read the store from
 * `DeckManagerContext` so rendering is decoupled from any global
 * registry — tests can render with a mock store the same way the
 * canvas does.
 */

import { useSyncExternalStore } from "@/lib/gesture-scope";


import { useDeckManager } from "./deck-manager-context";
import { isFocusDestination } from "./deck-store-selectors";

/**
 * Subscribe to the `isFocusDestination(cardId)` predicate ([A1]).
 *
 * Returns `true` when `cardId` is the card that currently deserves
 * the OS keyboard caret — active pane's active card, and the app is
 * foreground. Re-renders the calling component on every transition
 * of that predicate, driven by deck-store notifications (active-pane
 * flips, active-card-in-pane flips, `hasFocus` flips from window
 * focus / blur).
 *
 * Usage — gating a `useLayoutEffect`:
 * ```tsx
 * const isDestination = useFocusDestination(cardId);
 * useLayoutEffect(() => {
 *   if (!isDestination) return;
 *   // re-apply focus / selection into the card's DOM
 * }, [isDestination]);
 * ```
 *
 * Non-React consumers should call {@link isFocusDestination} inside a
 * `deckStore.subscribe(...)` callback instead — see the header on
 * `deck-store-selectors.ts`.
 */
export function useFocusDestination(cardId: string): boolean {
  const store = useDeckManager();
  return useSyncExternalStore(store.subscribe, () =>
    isFocusDestination(cardId, store.getSnapshot()),
  );
}
