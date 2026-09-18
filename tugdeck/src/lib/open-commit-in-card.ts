/**
 * open-commit-in-card.ts — the one implementation behind "show this commit in
 * its own card".
 *
 * The mirror of `open-diff-in-card.ts`, and deliberately so: a commit atom is
 * a commit entity the way a changeset row's pop-out is a diff entity, and the
 * two should behave alike. Sha-keyed reuse — raising a commit a card already
 * shows activates that card (raised + focus-claimed via
 * `transferFocusForActivation`, so the activation taxonomy matches every other
 * route) and re-points it; otherwise a fresh Commit card is created seeded
 * with the target through `addCard`'s initial-content channel. Two cards
 * showing one commit would be pure duplication.
 *
 * The key is a PREFIX match in either direction, which is the one thing this
 * path does that the diff path does not have to: prose writes eight characters
 * and a History row holds forty, and both name the same commit. See
 * {@link sameCommitTarget}.
 *
 * Placement and the flash are the diff opener's, for the same reason: a commit
 * raised from a card belongs beside it ({@link neighborSlot}), and the card
 * that answers announces itself ({@link flashCardPane}) — including when it is
 * a card that already existed and merely raised, which otherwise gives no sign
 * the gesture did anything.
 *
 * Callers: the `open-commit` registry handler (`dispatchCommand` from a commit
 * atom's primary click and from its menu).
 *
 * @module lib/open-commit-in-card
 */

import { transferFocusForActivation } from "@/focus-transfer";
import type { IDeckManagerStore } from "@/deck-manager-store";
import { dispatchCommand } from "@/command-dispatch";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import {
  findCommitCardByTarget,
  type CommitCardTarget,
} from "./commit-card-open-registry";
import { neighborSlot } from "./neighbor-slot";
import { flashCardPane } from "./flash-pane-border";

/**
 * The Commit card's initial-content seed (its restore bag content).
 *
 * The header hint covers the FIRST PAINT and nothing more ([B08]): a card
 * raised from a History row already holds the row's header, so its masthead
 * can paint at once instead of showing a bare pill for a round trip. A card
 * raised from prose knows only a sha and sends no hint. Either way the card
 * fetches, and what the fetch returns is the authority.
 */
export interface CommitCardSeed {
  target: CommitCardTarget;
  hint?: {
    subject?: string;
    author?: string;
    dateIso?: string;
  };
}

export function openCommitInCard(
  store: IDeckManagerStore,
  target: CommitCardTarget,
  hint?: CommitCardSeed["hint"],
): void {
  const existing = findCommitCardByTarget(target);
  if (existing) {
    transferFocusForActivation({
      outgoingCardId: store.getFirstResponderCardId(),
      incomingCardId: existing.cardId,
      store,
      commitMutation: () => store.activateCard(existing.cardId),
    });
    // Re-point defensively — a same-commit open is a no-op re-request, which
    // is harmless and refreshes the record.
    existing.entry.setTarget(target);
    flashCardPane(store, existing.cardId);
    return;
  }
  const seed: CommitCardSeed = hint === undefined ? { target } : { target, hint };
  // Save-before-activation ([L23]): `addCard` activates the fresh card
  // directly, so the card the gesture was made in banks its focus bag first.
  const outgoing = store.getFirstResponderCardId();
  const slot = neighborSlot(store, outgoing);
  if (outgoing !== null) store.invokeSaveCallback(outgoing);
  const cardId = store.addCard("commit", seed, { slot });
  if (cardId !== null) flashCardPane(store, cardId);
}

/**
 * Ask for a commit's card from a surface that holds a pill — a History row, a
 * receipt header. The dispatch rather than the opener directly, because
 * raising a card is the app's act and these surfaces have no deck store in
 * hand; one function so the payload has one spelling.
 */
export function requestCommitCard(
  target: CommitCardTarget,
  hint?: CommitCardSeed["hint"],
): void {
  dispatchCommand(TUG_ACTIONS.OPEN_COMMIT, {
    root: target.root,
    sha: target.sha,
    ...(hint === undefined ? {} : { hint }),
  });
}
