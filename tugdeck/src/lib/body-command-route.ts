/**
 * Whether a menu command belongs to the key body rather than the shell.
 *
 * Every menu item reaches the shell as a tell. A command whose registry
 * routing aims it at the key card (`first-responder`, `key-card`), or whose
 * row names the key card its owner, means the card the user is in — and when
 * that card is a body, its responders live in the body's document, not here.
 * So the shell forwards it, unless a surface of its own (a deck popover, the
 * Overview, a shell sheet) holds the chain ahead of the card: then the
 * command is that surface's, as it always was.
 * `target` and `native` commands never move, and nor does a `registry` one
 * whose row names no owner.
 *
 * A `first-responder` command walks from the shell's first responder, so one
 * the shell's chain holds above the card — the deck itself, with no caret in
 * any card — never reaches the card and stays here, as it did in one
 * document. A `key-card` command starts at the key card whatever the chain
 * holds, and goes.
 *
 * The keyboard walk's own two steps stay in the shell while the shell holds a
 * stop of the card's — its chrome's: the shell steps through those, and runs
 * off their end into the body.
 *
 * Pure: the shell's dispatcher supplies the facts and acts on the answer.
 *
 * @module lib/body-command-route
 */

import type { CommandEntry } from "@/components/tugways/command-registry";
import { TUG_ACTIONS } from "./action-vocabulary";

/**
 * The deck's own verbs: routed `first-responder` so the menu can fire them
 * from any card, and answered at the shell's chain root and by no card
 * (`deck-canvas.tsx`). Sent to the key body first, each one made the trip
 * there only to come back unanswered — a beat late, so a workspace switch
 * missed the frame its theme was due on (`at0663`). They are dispatched in
 * the shell, where they are answered, whatever card is key.
 */
const DECK_VERBS: ReadonlySet<string> = new Set([
  TUG_ACTIONS.FOCUS_PANE,
  TUG_ACTIONS.ACTIVATE_SPACE,
  TUG_ACTIONS.NEW_SPACE,
  TUG_ACTIONS.RENAME_SPACE,
  TUG_ACTIONS.DUPLICATE_SPACE,
  TUG_ACTIONS.DELETE_SPACE,
]);

/** The walk's steps, which are the shell's while it holds a stop of the card's. */
const WALK_VERBS: ReadonlySet<string> = new Set([TUG_ACTIONS.NEXT_KEYBOARD_FOCUS, TUG_ACTIONS.PREVIOUS_KEYBOARD_FOCUS]);

export interface BodyCommandFacts {
  /** The command's id. */
  id?: string;
  /** The command's registry routing. */
  routing: CommandEntry["routing"];
  /** The row's explicit owner, if it names one. */
  owner?: CommandEntry["owner"];
  /** The deck's first-responder card, or null. */
  firstResponderCardId: string | null;
  /** Whether a card is a body card whose body can take a command now. */
  isBodyCard: (cardId: string) => boolean;
  /** Whether a shell-owned responder holds the chain ahead of the card. */
  shellResponderAhead: boolean;
  /** Whether the shell's first responder stands above the card's pane (`shellResponderAboveCard`). */
  shellResponderAbove?: boolean;
  /** Whether the shell holds a stop of the card's own walk (its chrome's). */
  shellHoldsStop?: (cardId: string) => boolean;
}

/** The body card to forward the command to, or null to dispatch it in the shell. */
export function bodyCommandRoute(facts: BodyCommandFacts): string | null {
  const keyCards = facts.owner === "key-card" || facts.routing === "first-responder" || facts.routing === "key-card";
  if (!keyCards) return null;
  if (facts.id !== undefined && DECK_VERBS.has(facts.id)) return null;
  const cardId = facts.firstResponderCardId;
  if (cardId === null || !facts.isBodyCard(cardId)) return null;
  if (facts.shellResponderAhead) return null;
  if (facts.routing === "first-responder" && facts.owner === undefined && facts.shellResponderAbove === true) return null;
  if (facts.id !== undefined && WALK_VERBS.has(facts.id) && facts.shellHoldsStop?.(cardId) === true) return null;
  return cardId;
}

/**
 * What a body does with a command its own chain left unanswered.
 *
 * - `forward`: hand it to the shell and claim it — the shell's chain holds
 *   the pane and the deck, which answer it.
 * - `forward-unclaimed`: hand it to the shell and let the key go on in the
 *   page. Cancel: what this page's chain did not want may still be a native
 *   control's or an editor keymap's, and the shell's root may want it too —
 *   Escape's last rung while a layout selection stands.
 * - `decline`: keep it. Undo and Redo are the focused surface's edit
 *   history; unanswered here, they are a native control's, reached when the
 *   funnel lets the key go on.
 */
export function bodyUnhandledRoute(id: string): "forward" | "forward-unclaimed" | "decline" {
  if (id === TUG_ACTIONS.UNDO || id === TUG_ACTIONS.REDO) return "decline";
  if (id === TUG_ACTIONS.CANCEL_DIALOG) return "forward-unclaimed";
  return "forward";
}

/**
 * The body card that should hold the keyboard now, or null for the shell.
 *
 * The deck's first-responder card, when it is a body card — unless the
 * keyboard is the shell's for the moment: a stop of its chrome is in the
 * card's walk, or the shell has something up that takes keys of its own. A
 * menu or popover the shell raised over the card (its trap is the top focus
 * mode), and a gesture the shell is running on the card's chrome (a rail
 * width drag), each answer Escape on the shell's `window`, and a key sent to
 * the body's page never reaches them.
 */
export function keyboardBodyFor(facts: {
  firstResponderCardId: string | null;
  isBodyCard: (cardId: string) => boolean;
  shellHoldsStop: (cardId: string) => boolean;
  /** A shell surface's trap is up, or a shell gesture holds the keyboard. */
  shellTakesKeys: boolean;
}): string | null {
  const fr = facts.firstResponderCardId;
  if (fr === null || !facts.isBodyCard(fr) || facts.shellHoldsStop(fr)) return null;
  return facts.shellTakesKeys ? null : fr;
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

/**
 * Whether the shell's first responder stands above the card's pane — the
 * deck, with nothing in the card holding the chain — so a walk from it never
 * passes through the card. The card's own node, its pane and anything within
 * the pane are the card's; no responder, or no pane, is not above.
 */
export function shellResponderAboveCard(facts: {
  responder: string | null;
  paneId: string | null;
  cardId: string | null;
  /** Whether `id`'s chain ancestry passes through `ancestorId`. */
  isWithin: (id: string, ancestorId: string) => boolean;
}): boolean {
  const { responder, paneId, cardId } = facts;
  if (responder === null || paneId === null) return false;
  if (responder === paneId || responder === cardId) return false;
  return facts.isWithin(paneId, responder);
}
