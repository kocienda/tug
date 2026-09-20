/**
 * open-diff-in-card.ts — the one implementation behind "pop this diff out
 * into its own card" ([P20]).
 *
 * Descriptor-keyed reuse (the mirror of `open-file-in-card.ts`'s path-keyed
 * reuse): opening a descriptor already shown by a Diff card activates that
 * card (raised + focus-claimed via `transferFocusForActivation`, so the
 * activation taxonomy matches every other route) and re-points it; otherwise
 * a fresh Diff card is created seeded with the descriptor through `addCard`'s
 * initial-content channel. Two cards showing the same diff would be pure
 * duplication.
 *
 * Placement and the flash are the file opener's, for the same reason: a diff
 * popped out of a changeset row belongs beside the card the row is in
 * (`addCard`'s `origin`), and the card that answers announces itself
 * ({@link flashCardPane}) — including when it is a card that already existed
 * and merely raised, which otherwise gives no sign the pop-out did anything.
 *
 * Callers: the `open-diff` registry handler (`dispatchCommand` from the
 * changeset card's pop-out affordances).
 *
 * @module lib/open-diff-in-card
 */

import { transferFocusForActivation } from "@/focus-transfer";
import type { IDeckManagerStore } from "@/deck-manager-store";
import { diffDescriptorKey, type DiffDescriptor } from "./git-diff-store";
import { findDiffCardByKey } from "./diff-card-open-registry";
import { flashCardPane } from "./flash-pane-border";

/** The Diff card's initial-content seed (its restore bag content). */
export interface DiffCardSeed {
  descriptor: DiffDescriptor;
}

export function openDiffInCard(
  store: IDeckManagerStore,
  descriptor: DiffDescriptor,
  originCardId: string | null = null,
): void {
  const key = diffDescriptorKey(descriptor);
  const existing = findDiffCardByKey(key);
  if (existing) {
    transferFocusForActivation({
      outgoingCardId: store.getFirstResponderCardId(),
      incomingCardId: existing.cardId,
      store,
      commitMutation: () => store.activateCard(existing.cardId),
    });
    // Re-point defensively (a same-key open is a no-op re-request, which is
    // harmless and refreshes the diff).
    existing.entry.setDescriptor(descriptor);
    flashCardPane(store, existing.cardId);
    return;
  }
  const seed: DiffCardSeed = { descriptor };
  // Save-before-activation ([L23]): `addCard` activates the fresh card
  // directly, so the card the pop-out was pressed in banks its focus bag
  // first.
  const outgoing = store.getFirstResponderCardId();
  if (outgoing !== null) store.invokeSaveCallback(outgoing);
  const cardId = store.addCard("diff", seed, {
    origin: originCardId ?? outgoing,
  });
  if (cardId !== null) flashCardPane(store, cardId);
}
