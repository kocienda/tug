/**
 * open-help-in-card.ts — the one implementation behind "show this help
 * document in its card".
 *
 * A help card is keyed by its document ([B04]): there is at most one Tug Help
 * card and one Glossary card, and opening one that is already on the deck
 * brings it forward rather than adding a second. The shape is the Commit
 * card's ({@link openCommitInCard}): the existing card is found by the seed
 * its bag holds — the shell's record of a card whether or not it is mounted in
 * this page — activated through `transferFocusForActivation` and flashed;
 * otherwise a fresh card is created with the seed through `addCard`'s
 * initial-content channel.
 *
 * An anchor rides along. A fresh card scrolls to it once its document has
 * rendered; a card already mounted in this page is told through the open
 * registry below, and one mounted in its own page — every card is a body —
 * through the `help.scrollTo` verb, which that page answers against the same
 * registry (`body/body-verbs.ts`).
 *
 * Callers: the `open-help` registry handler and `show-card` with a `help`
 * component, both in `action-dispatch.ts`.
 *
 * @module lib/open-help-in-card
 */

import { mayDeferCommitInView, transferFocusForActivation } from "@/focus-transfer";
import type { CardDeck } from "@/card-deck";
import { dispatchCommand } from "@/command-dispatch";
import { TUG_ACTIONS } from "@/lib/action-vocabulary";
import { isHelpDocName, type HelpDocName } from "./help-docs";
import { flashCardPane } from "./flash-pane-border";
import { helpScrollTo } from "../bus/declarations/verbs";
import { page } from "../bus/page";

/** The help card's initial-content seed (its restore bag content). */
export interface HelpCardSeed {
  doc: HelpDocName;
  /** Where to scroll once the document renders; absent for the top. */
  anchor?: string;
}

/** Narrow an unknown bag into a help card seed. */
export function coerceHelpSeed(value: unknown): HelpCardSeed | null {
  if (typeof value !== "object" || value === null) return null;
  const { doc, anchor } = value as { doc?: unknown; anchor?: unknown };
  if (!isHelpDocName(doc)) return null;
  return typeof anchor === "string" && anchor.length > 0 ? { doc, anchor } : { doc };
}

/** What a mounted help card answers to. */
interface OpenHelpCard {
  scrollToAnchor: (anchor: string) => void;
}

const openHelpCards = new Map<string, OpenHelpCard>();

/** Register a mounted help card so a re-open can scroll it. */
export function registerOpenHelpCard(cardId: string, entry: OpenHelpCard): void {
  openHelpCards.set(cardId, entry);
}

/**
 * Scroll a help card mounted in this page to `anchor`; false when this page
 * holds no such card.
 */
export function scrollOpenHelpCard(cardId: string, anchor: string): boolean {
  const entry = openHelpCards.get(cardId);
  if (entry === undefined) return false;
  entry.scrollToAnchor(anchor);
  return true;
}

/** Drop a help card's registration when it unmounts. */
export function unregisterOpenHelpCard(cardId: string): void {
  openHelpCards.delete(cardId);
}

/** The deck's help card already showing `doc`, by the seed its bag holds. */
export function findHelpCardInDeck(
  store: Pick<CardDeck, "getSnapshot" | "getCardState">,
  doc: HelpDocName,
): string | null {
  for (const card of store.getSnapshot().cards) {
    if (card.componentId !== "help") continue;
    const seed = coerceHelpSeed(store.getCardState(card.id)?.content);
    if (seed?.doc === doc) return card.id;
  }
  return null;
}

export function openHelpInCard(
  store: CardDeck,
  seed: HelpCardSeed,
  originCardId: string | null = null,
): void {
  const existingId = findHelpCardInDeck(store, seed.doc);
  if (existingId !== null) {
    transferFocusForActivation({
      outgoingCardId: store.getFirstResponderCardId(),
      incomingCardId: existingId,
      store,
      commitMutation: () => store.activateCard(existingId),
      deferCommit: mayDeferCommitInView(existingId),
    });
    if (seed.anchor !== undefined && !scrollOpenHelpCard(existingId, seed.anchor) && page.isShell) {
      // The card's document is in its own page, which scrolls it. The bus
      // holds the verb until that page has said hello.
      helpScrollTo.dispatch({ anchor: seed.anchor }, { card: existingId });
    }
    flashCardPane(store, existingId);
    return;
  }
  // Save-before-activation ([L23]): `addCard` activates the fresh card
  // directly, so the card the gesture was made in banks its focus bag first.
  const outgoing = store.getFirstResponderCardId();
  if (outgoing !== null) store.invokeSaveCallback(outgoing);
  const cardId = store.addCard("help", seed, { origin: originCardId ?? outgoing });
  if (cardId !== null) flashCardPane(store, cardId);
}

/**
 * Ask for a help card from a surface with no deck store in hand — a link in a
 * help card, a help ref in the Overview. The dispatch rather than the opener,
 * because raising a card is the app's act.
 */
export function requestHelpCard(seed: HelpCardSeed, originCardId?: string | null): void {
  dispatchCommand(TUG_ACTIONS.OPEN_HELP, {
    doc: seed.doc,
    ...(seed.anchor === undefined ? {} : { anchor: seed.anchor }),
    ...(typeof originCardId === "string" ? { originCardId } : {}),
  });
}
