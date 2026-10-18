/**
 * Whether a menu command belongs to the key body rather than the shell.
 *
 * Every menu item reaches the shell as a tell. A command whose registry
 * routing aims it at the key card (`first-responder`, `key-card`) means the
 * card the user is in — and when that card is a body, its responders live in
 * the body's document, not here. So the shell forwards it, unless a surface
 * of its own (a deck popover, the Overview, a shell sheet) holds the chain
 * ahead of the card: then the command is that surface's, as it always was.
 * `registry`, `target` and `native` commands never move.
 *
 * Pure: the shell's dispatcher supplies the facts and acts on the answer.
 *
 * @module lib/body-command-route
 */

import type { CommandEntry } from "@/components/tugways/command-registry";

export interface BodyCommandFacts {
  /** The command's registry routing. */
  routing: CommandEntry["routing"];
  /** The deck's first-responder card, or null. */
  firstResponderCardId: string | null;
  /** Whether a card is a body card whose body can take a command now. */
  isBodyCard: (cardId: string) => boolean;
  /** Whether a shell-owned responder holds the chain ahead of the card. */
  shellResponderAhead: boolean;
}

/** The body card to forward the command to, or null to dispatch it in the shell. */
export function bodyCommandRoute(facts: BodyCommandFacts): string | null {
  if (facts.routing !== "first-responder" && facts.routing !== "key-card") return null;
  const cardId = facts.firstResponderCardId;
  if (cardId === null || !facts.isBodyCard(cardId)) return null;
  if (facts.shellResponderAhead) return null;
  return cardId;
}

/**
 * Whether the shell's first responder is a surface of the shell's own,
 * ahead of the card in the chain. The card is its pane, the card's own node
 * (the one the shell makes first responder when it focuses the card), and
 * anything above the pane (the deck); any other responder — a popover, a
 * shell sheet, the Overview — is ahead. No responder, or no pane, is nothing
 * ahead.
 */
export function shellSurfaceAhead(facts: {
  responder: string | null;
  paneId: string | null;
  cardId: string | null;
  /** Whether `id`'s chain ancestry passes through `ancestorId`. */
  isWithin: (id: string, ancestorId: string) => boolean;
}): boolean {
  const { responder, paneId, cardId } = facts;
  if (responder === null || paneId === null) return false;
  if (responder === paneId || responder === cardId) return false;
  return !facts.isWithin(paneId, responder);
}
