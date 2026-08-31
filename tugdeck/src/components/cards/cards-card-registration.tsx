/**
 * cards-card-registration.tsx — registers the Cards card ([L25]).
 *
 * An ordinary registered card hosted by the normal `CardHost` inside a sidebar
 * pane, on the Jots template: the pane/card machinery (FocusContext, responder
 * scope, title-bar chrome) is what makes focus restore and the pane's own
 * affordances nearly free.
 *
 * INVARIANT: `registerCardsCard()` MUST run at boot unconditionally and before
 * the deck restores its layout — `filterRegisteredCards` drops panes whose only
 * card's componentId is unregistered at load, so a gated card would evaporate
 * its rail on every reload.
 *
 * `family: "cards"` (a family no free pane's `acceptsFamilies` lists) plus
 * `acceptsFamilies: []` makes the card un-mergeable in both directions.
 *
 * @module components/cards/cards-card-registration
 */

import React from "react";
import { registerCard } from "@/card-registry";
import { CARDS_CARD_ID } from "@/lib/cards-card-id";
import { CardsContent } from "./cards-card";

export { CARDS_CARD_ID };

/** The width the Cards rail opens at before the user has sized it — the one
 *  the four cards the Lens broke into share. */
export const DEFAULT_CARDS_WIDTH_PX = 420;

/** The narrowest a card row's name, its disambiguating run and its slot picker
 *  still read at. */
export const MIN_CARDS_WIDTH_PX = 320;

/** Register the Cards card. `hidden` keeps it out of the type-picker `[+]`
 *  menu — it is reachable through its own menu row and the rail ladder. */
export function registerCardsCard(): void {
  registerCard({
    componentId: CARDS_CARD_ID,
    family: "cards",
    acceptsFamilies: [],
    contentFactory: (cardId: string) => <CardsContent cardId={cardId} />,
    defaultMeta: { title: "Cards", icon: "LayoutGrid", closable: true },
    // Rows elide where prose cannot, so this gives width back before a reading
    // surface does — the rank the Lens held.
    greedRank: 2,
    hidden: true,
    // Every row here is an engine focus stop and the arrows are how the list is
    // read, so it engages KBF mode the moment it is the key card ([P10]).
    kbfAtRest: true,
    layoutRole: "sidebar",
    // The mirror does not reflect itself.
    cardsGroup: "none",
    sizePolicy: {
      min: { width: MIN_CARDS_WIDTH_PX, height: 240 },
      preferred: { width: DEFAULT_CARDS_WIDTH_PX, height: 900 },
    },
  });
}
