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
 * duplication. The card is found in this page's open registry, else — a
 * card mounted in its own page, which is every Diff card under per-card web
 * views — among the deck's cards by the descriptor its bag holds; until
 * 2026-11-10 only the first was asked, and a second `/diff` stacked a
 * duplicate (at0360).
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

import { mayDeferCommitInView, transferFocusForActivation } from "@/focus-transfer";
import type { CardDeck } from "@/card-deck";
import { diffDescriptorKey, type DiffDescriptor } from "./git-diff-store";
import { findDiffCardByKey } from "./diff-card-open-registry";
import { flashCardPane } from "./flash-pane-border";

/** The Diff card's initial-content seed (its restore bag content). */
export interface DiffCardSeed {
  descriptor: DiffDescriptor;
}

/** Narrow an unknown restore bag into a `DiffDescriptor`. */
export function coerceDescriptor(value: unknown): DiffDescriptor | null {
  if (typeof value !== "object" || value === null) return null;
  const descriptor = (value as { descriptor?: unknown }).descriptor;
  if (typeof descriptor !== "object" || descriptor === null) return null;
  const kind = (descriptor as { kind?: unknown }).kind;
  if (kind === "head" || kind === "range" || kind === "commit") {
    return descriptor as DiffDescriptor;
  }
  return null;
}

/**
 * A Diff card showing `key` whose content is mounted in another page — a body
 * card — found among the deck's cards by the descriptor in the bag this deck
 * holds for it. The open registry is per page, so the shell's holds none of
 * these, and a card's published identity names a diff only as a reader
 * would ("Project Diff"), which is not a key. The bag is the descriptor the
 * card was seeded with, and a body's Diff card is never re-pointed after
 * that: the re-point below reaches only a card mounted in this page.
 */
function bodyDiffCardByKey(store: CardDeck, key: string): string | null {
  for (const card of store.getSnapshot().cards) {
    if (card.componentId !== "diff") continue;
    const descriptor = coerceDescriptor(store.getCardState(card.id)?.content);
    if (descriptor !== null && diffDescriptorKey(descriptor) === key) return card.id;
  }
  return null;
}

export function openDiffInCard(
  store: CardDeck,
  descriptor: DiffDescriptor,
  originCardId: string | null = null,
): void {
  const key = diffDescriptorKey(descriptor);
  const local = findDiffCardByKey(key);
  const existingId = local?.cardId ?? bodyDiffCardByKey(store, key);
  if (existingId !== null) {
    transferFocusForActivation({
      outgoingCardId: store.getFirstResponderCardId(),
      incomingCardId: existingId,
      store,
      commitMutation: () => store.activateCard(existingId),
      deferCommit: mayDeferCommitInView(existingId),
    });
    // Re-point defensively (a same-key open is a no-op re-request, which is
    // harmless and refreshes the diff).
    local?.entry.setDescriptor(descriptor);
    flashCardPane(store, existingId);
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
