/**
 * frontmost-project.ts — the project Open Quickly should search.
 *
 * A "project" is a bound session-card session, whose binding carries the
 * `projectDir` (the absolute workspace root — FILETREE indexes paths
 * relative to it) and the `workspaceKey` (which scopes the FILETREE feed).
 * Open Quickly picks the **most-frontmost** such project: walking the deck
 * front-to-back (topmost pane's active card first), it returns the first
 * card that has a binding — so as long as any session card has a project open,
 * that's very likely the one the user means, and Open Quickly stays live.
 * When no card is bound, the result is `null` and Open Quickly is disabled.
 *
 * @module lib/frontmost-project
 */

import { useCallback } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import { getDeckStore } from "./deck-store-registry";
import {
  cardSessionBindingStore,
  type CardSessionBinding,
} from "./card-session-binding-store";

/**
 * The binding of the most-frontmost bound card, or `null` when no card is
 * bound to a project. Panes are back-to-front, so the last is topmost;
 * within a pane the active (visible) card is checked before its background
 * tabs.
 */
export function frontmostProjectBinding(): CardSessionBinding | null {
  const store = getDeckStore();
  if (store === null) return null;
  const { panes } = store.getSnapshot();
  for (let i = panes.length - 1; i >= 0; i--) {
    const pane = panes[i];
    const active = cardSessionBindingStore.getBinding(pane.activeCardId);
    if (active !== undefined) return active;
    for (const cardId of pane.cardIds) {
      const binding = cardSessionBindingStore.getBinding(cardId);
      if (binding !== undefined) return binding;
    }
  }
  return null;
}

/**
 * Reactive {@link frontmostProjectBinding}: re-reads whenever the deck reorders
 * or a binding lands/clears, so a consumer tracks the topmost bound project
 * live. Returns the same binding reference while unchanged, so it does not churn
 * `useSyncExternalStore`. `null` when no card is bound.
 */
export function useFrontmostProjectBinding(): CardSessionBinding | null {
  const subscribe = useCallback((onChange: () => void): (() => void) => {
    const deck = getDeckStore();
    const unDeck = deck ? deck.subscribe(onChange) : () => {};
    const unBind = cardSessionBindingStore.subscribe(onChange);
    return () => {
      unDeck();
      unBind();
    };
  }, []);
  return useSyncExternalStore(
    subscribe,
    frontmostProjectBinding,
    frontmostProjectBinding,
  );
}
