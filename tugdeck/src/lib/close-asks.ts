/**
 * close-asks — whether a close asks first, and what it asks, for each of a
 * pane's three close gestures.
 *
 * The pane's × (and Close Pane) discards the whole pane, ⌘W the active
 * card, Close All Card Tabs every tab. Each asks on its own rule, and this
 * module is the one place the rules are written: the shell's pane calls
 * {@link closeAsksOf} at the gesture with each card's live waive, and the
 * shell's `pane.chrome` projection calls it with the waives the bodies
 * published, so a card's page reads its asks and decides nothing. It is the
 * only reader of a registration's `confirmClose`.
 *
 * - A card **confirms** when its kind opts in (`defaultMeta.confirmClose`).
 * - A card **waives** when it says it holds nothing a close would lose (an
 *   empty Session card); a waive answers its own confirm, never a pane's
 *   confirm about discarding several tabs at once.
 * - A rail card's pane confirms whatever its kind says: a rail card is a
 *   singleton the deck keeps one of, and its × sits beside the rail's
 *   resize edge. A lone card's waive answers that confirm too, as the title
 *   bar's `confirmClose && advice.waive !== true` always has.
 *
 * @module lib/close-asks
 */

import { cardKindName, getRegistration } from "../card-registry";

/** Whether a close asks first, and the confirm's question and button. */
export interface CloseAsk {
  confirm: boolean;
  message: string;
  label: string;
}

/** The pane's three close gestures' asks. */
export interface CloseAsks {
  /** The × and Close Pane: the whole pane. */
  pane: CloseAsk;
  /** ⌘W: the active card. */
  card: CloseAsk;
  /** Close All Card Tabs: every tab. */
  all: CloseAsk;
}

/** A pane's card, as the rule reads it. */
export interface CloseAskCard {
  cardId: string;
  componentId: string;
  /** Whether the card says it holds nothing a close would lose. */
  waives: boolean;
}

function confirms(card: CloseAskCard | undefined): boolean {
  return card !== undefined && getRegistration(card.componentId)?.defaultMeta.confirmClose === true;
}

function kindOf(card: CloseAskCard | undefined): string {
  return cardKindName(card === undefined ? undefined : getRegistration(card.componentId)?.defaultMeta);
}

/** The asks of a pane holding `cards`, with `activeCardId` in front; `isRail` when its active card is a rail card. */
export function closeAsksOf(args: {
  cards: ReadonlyArray<CloseAskCard>;
  activeCardId: string | null;
  isRail: boolean;
}): CloseAsks {
  const { cards, isRail } = args;
  const several = cards.length > 1;
  const active = cards.find((c) => c.cardId === args.activeCardId) ?? cards[0];
  const soleWaives = !several && active?.waives === true;
  const activeConfirms = confirms(active);

  const whole = (confirm: boolean): CloseAsk => ({
    confirm,
    message: several ? `Close ${cards.length} Tabs?` : `Close ${kindOf(active)}?`,
    label: several ? "Close All" : "Close",
  });

  const pane = whole(several || ((isRail || activeConfirms) && !soleWaives));
  const card: CloseAsk = several
    ? { confirm: activeConfirms && active?.waives !== true, message: `Close ${kindOf(active)}?`, label: "Close" }
    : pane;
  const all = whole(cards.some((c) => confirms(c) && !c.waives));
  return { pane, card, all };
}
