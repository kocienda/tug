/**
 * space-switch-signal — a workspace switch is about to swap the deck.
 *
 * Said synchronously in the task that swaps it, before React has rendered
 * anything of the switch, so a word the listener posts to the host reaches
 * it ahead of the layer-tree commit that carries the shell's switched frame:
 * both travel from this page to the host's main thread in the order they
 * were sent. One listener, the body shell's.
 *
 * @module lib/space-switch-signal
 */

import type { DeckState } from "../layout-tree";

/** Told the workspace being shown and its deck, before the swap. */
export type SpaceWillSwitch = (spaceId: string, deck: DeckState) => void;

let listener: SpaceWillSwitch | null = null;

/** Listen for switches from here on. Returns the uninstall. */
export function onSpaceWillSwitch(next: SpaceWillSwitch): () => void {
  listener = next;
  return () => {
    if (listener === next) listener = null;
  };
}

/** A switch onto `spaceId`, whose deck is `deck`, is about to swap the deck. */
export function spaceWillSwitch(spaceId: string, deck: DeckState): void {
  listener?.(spaceId, deck);
}
