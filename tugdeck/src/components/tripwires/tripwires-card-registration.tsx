/**
 * tripwires-card-registration.tsx — registers the Tripwires card ([L25]).
 *
 * Tripwires is an ordinary registered card hosted by the normal `CardHost`
 * inside a sidebar pane, on the Jots template: the pane/card machinery
 * (FocusContext, responder scope, title-bar chrome) is what makes focus restore
 * and the pane's own affordances nearly free.
 *
 * INVARIANT: `registerTripwiresCard()` MUST run at boot unconditionally and
 * before the deck restores its layout — `filterRegisteredCards` drops panes
 * whose only card's componentId is unregistered at load, so a gated card would
 * evaporate its rail on every reload.
 *
 * `family: "tripwires"` (a family no free pane's `acceptsFamilies` lists) plus
 * `acceptsFamilies: []` makes the card un-mergeable in both directions.
 *
 * @module components/tripwires/tripwires-card-registration
 */

import React from "react";
import { Zap } from "lucide-react";
import { registerCard } from "@/card-registry";
import { TRIPWIRES_CARD_ID } from "@/lib/tripwires-card-id";
import { TripwiresContent } from "./tripwires-card";

export { TRIPWIRES_CARD_ID };

/** The width the Tripwires rail opens at before the user has sized it. The
 *  four cards the rail broke into stand in one rail by default, so they open at
 *  one width — a card that opened wider than its neighbour would just be
 *  resized back. */
export const DEFAULT_TRIPWIRES_WIDTH_PX = 420;

/** The narrowest a tripwire's name over its trigger line still reads at. */
export const MIN_TRIPWIRES_WIDTH_PX = 320;

/** Register the Tripwires card. `hidden` keeps it out of the type-picker `[+]`
 *  menu — it is reachable through its own menu row and the rail ladder. */
export function registerTripwiresCard(): void {
  registerCard({
    componentId: TRIPWIRES_CARD_ID,
    family: "tripwires",
    acceptsFamilies: [],
    contentFactory: (cardId: string) => <TripwiresContent cardId={cardId} />,
    defaultMeta: { title: "Tripwires", icon: "Zap", closable: true },
    // Rows elide where prose cannot, so this gives width back before a reading
    // surface does. Rank 5: the slowest-growing of the four lists — a tripwire
    // is written once and mostly sits there.
    greedRank: 5,
    hidden: true,
    // Every row here is an engine focus stop and the arrows are how the roster
    // is read, so it engages KBF mode the moment it is the key card ([P10]).
    kbfAtRest: true,
    // Pins to a deck edge and insets the imposition band rather than taking a
    // slot inside it.
    layoutRole: "sidebar",
    // Out of the Cards list, as every rail card is: those rows are the deck's
    // content cards, and each carries a slot picker for an arrangement a rail
    // can never stand in.
    cardsGroup: "none",
    sizePolicy: {
      min: { width: MIN_TRIPWIRES_WIDTH_PX, height: 240 },
      preferred: { width: DEFAULT_TRIPWIRES_WIDTH_PX, height: 900 },
    },
  });
}
