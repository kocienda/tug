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
 * raised from a card belongs beside it (`addCard`'s `origin`), and the card
 * that answers announces itself ({@link flashCardPane}) — including when it is
 * a card that already existed and merely raised, which otherwise gives no sign
 * the gesture did anything.
 *
 * Callers: the `open-commit` registry handler (`dispatchCommand` from a commit
 * atom's primary click and from its menu).
 *
 * @module lib/open-commit-in-card
 */

import { mayDeferCommitInView, transferFocusForActivation } from "@/focus-transfer";
import type { CardDeck } from "@/card-deck";
import { dispatchCommand } from "@/command-dispatch";
import { TUG_ACTIONS } from "@/lib/action-vocabulary";
import {
  findCommitCardByTarget,
  sameCommitTarget,
  type CommitCardTarget,
} from "./commit-card-open-registry";
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

/**
 * The deck's Commit card already pointed at `target`, found by the target its
 * bag holds rather than by a mounted component. The open registry knows only
 * the cards mounted in this page, and a card that is its own page is mounted
 * there, not here; its bag — the seed `addCard` was handed, and what the card
 * writes back — is the shell's record of what it holds. Prefix-matched on the
 * sha either way, as the registry matches.
 */
export function findCommitCardInDeck(
  store: Pick<CardDeck, "getSnapshot" | "getCardState">,
  target: CommitCardTarget,
): string | null {
  for (const card of store.getSnapshot().cards) {
    if (card.componentId !== "commit") continue;
    const content = store.getCardState(card.id)?.content;
    if (typeof content !== "object" || content === null) continue;
    const held = (content as { target?: unknown }).target;
    if (typeof held !== "object" || held === null) continue;
    const { root, sha } = held as { root?: unknown; sha?: unknown };
    if (typeof root !== "string" || typeof sha !== "string") continue;
    if (sameCommitTarget({ root, sha }, target)) return card.id;
  }
  return null;
}

export function openCommitInCard(
  store: CardDeck,
  target: CommitCardTarget,
  hint?: CommitCardSeed["hint"],
  originCardId: string | null = null,
): void {
  const existing = findCommitCardByTarget(target);
  const existingId = existing?.cardId ?? findCommitCardInDeck(store, target);
  if (existingId !== null) {
    transferFocusForActivation({
      outgoingCardId: store.getFirstResponderCardId(),
      incomingCardId: existingId,
      store,
      commitMutation: () => store.activateCard(existingId),
      deferCommit: mayDeferCommitInView(existingId),
    });
    // Re-point defensively — a same-commit open is a no-op re-request, which
    // is harmless and refreshes the record. A card mounted in its own page
    // has no entry here; its record is its own.
    existing?.entry.setTarget(target);
    flashCardPane(store, existingId);
    return;
  }
  const seed: CommitCardSeed = hint === undefined ? { target } : { target, hint };
  // Save-before-activation ([L23]): `addCard` activates the fresh card
  // directly, so the card the gesture was made in banks its focus bag first.
  const outgoing = store.getFirstResponderCardId();
  if (outgoing !== null) store.invokeSaveCallback(outgoing);
  const cardId = store.addCard("commit", seed, {
    origin: originCardId ?? outgoing,
  });
  if (cardId !== null) flashCardPane(store, cardId);
}

/**
 * Ask for a commit's card from a surface that holds a pill — a History row, a
 * receipt header. The dispatch rather than the opener directly, because
 * raising a card is the app's act and these surfaces have no deck store in
 * hand; one function so the payload has one spelling. `originCardId` is the
 * card the pill stands in, which the new card opens beside.
 */
export function requestCommitCard(
  target: CommitCardTarget,
  hint?: CommitCardSeed["hint"],
  originCardId?: string | null,
): void {
  dispatchCommand(TUG_ACTIONS.OPEN_COMMIT, {
    root: target.root,
    sha: target.sha,
    ...(hint === undefined ? {} : { hint }),
    ...(typeof originCardId === "string" ? { originCardId } : {}),
  });
}
