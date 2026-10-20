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
 * A body page cannot walk the deck: its deck holds its own card and its
 * binding store that card's binding alone. The shell sends its answer in its
 * deck facts, and a body answers with that ({@link relayFrontmostProjectBinding}).
 *
 * @module lib/frontmost-project
 */

import { useCallback } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import { createSubscribable } from "@/lib/subscribable";

import { getCardDeck } from "./deck-store-registry";
import {
  cardSessionBindingStore,
  type CardSessionBinding,
} from "./card-session-binding-store";

/**
 * The shell's answer, on a body page that has heard it; `undefined` on the
 * shell's page, which walks its own deck.
 */
let relayed: CardSessionBinding | null | undefined;
const relayedChanged = createSubscribable();

/**
 * Take the shell's frontmost binding on a body page. An equal one keeps the
 * held reference, so a reader's snapshot does not churn.
 */
export function relayFrontmostProjectBinding(binding: CardSessionBinding | null): void {
  if (relayed !== undefined && JSON.stringify(relayed) === JSON.stringify(binding)) return;
  relayed = binding;
  relayedChanged.notify();
}

/** For tests: back to a page that has heard nothing. */
export function _resetRelayedFrontmostProjectForTest(): void {
  relayed = undefined;
}

/**
 * The binding of the most-frontmost bound card, or `null` when no card is
 * bound to a project. Panes are back-to-front, so the last is topmost;
 * within a pane the active (visible) card is checked before its background
 * tabs.
 */
export function frontmostProjectBinding(): CardSessionBinding | null {
  if (relayed !== undefined) return relayed;
  const store = getCardDeck();
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
    const deck = getCardDeck();
    const unDeck = deck ? deck.subscribe(onChange) : () => {};
    const unBind = cardSessionBindingStore.subscribe(onChange);
    const unRelay = relayedChanged.subscribe(onChange);
    return () => {
      unDeck();
      unBind();
      unRelay();
    };
  }, []);
  return useSyncExternalStore(
    subscribe,
    frontmostProjectBinding,
    frontmostProjectBinding,
  );
}
