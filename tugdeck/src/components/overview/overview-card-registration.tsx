/**
 * overview-card-registration.tsx — registers the Overview card ([L25]).
 *
 * The Overview is an ordinary registered card hosted by the normal `CardHost`
 * inside a sidebar pane, exactly as Jots and the rail are: the pane/card
 * machinery (FocusContext, responder scope, title-bar chrome, the [L12]
 * selection boundary `CardHost` registers per card) is what makes focus restore
 * and the rail's own affordances nearly free.
 *
 * INVARIANT: `registerOverviewCard()` MUST run at boot unconditionally and
 * before the deck restores its layout — `filterRegisteredCards` drops panes
 * whose only card's componentId is unregistered at load, so a gated Overview
 * card would evaporate its rail on every reload.
 *
 * `family: "overview"` (a family no free pane's `acceptsFamilies` lists) plus
 * `acceptsFamilies: []` makes the card un-mergeable in both directions.
 *
 * @module components/overview/overview-card-registration
 */

import React from "react";
import { registerCard } from "@/card-registry";
import { OVERVIEW_CARD_ID } from "@/lib/overview-card-id";
import {
  COMFORT_OVERVIEW_WIDTH_PX,
  DEFAULT_OVERVIEW_WIDTH_PX,
  MIN_OVERVIEW_WIDTH_PX,
} from "@/lib/overview-measure";
import { OverviewContent } from "./overview-card";

export { OVERVIEW_CARD_ID };
// The rail's widths are derived from the body type — see `lib/overview-measure`
// for the derivation and why its inputs are authored rather than measured at
// boot. Re-exported here because the registration is where a reader looks for
// what the card opens at.
export {
  COMFORT_OVERVIEW_WIDTH_PX,
  DEFAULT_OVERVIEW_WIDTH_PX,
  MIN_OVERVIEW_WIDTH_PX,
};

/** Register the Overview card. `hidden` keeps it out of the type-picker `[+]`
 *  menu — it is reachable through its own toggle, like Jots and the rail. */
export function registerOverviewCard(): void {
  registerCard({
    componentId: OVERVIEW_CARD_ID,
    family: "overview",
    acceptsFamilies: [],
    contentFactory: (cardId: string) => <OverviewContent cardId={cardId} />,
    defaultMeta: { title: "Overview", icon: "Newspaper", closable: true },
    // The greediest rail on the deck: a post is prose, and prose is what a
    // narrow rail costs the most. Fed first in surplus, drained last in
    // deficit. Rank 1 of the six sidebar cards. The rank is read by the WIDTH
    // allocator alone; a rail's vertical division is the hand's.
    greedRank: 1,
    // The 56-character measure: the narrowest a post still reads as prose. The
    // allocator holds the rail here and gives it up only to remove overlap;
    // `sizePolicy.min.width` below is the different, harder question of where
    // the card stops painting.
    comfortWidth: COMFORT_OVERVIEW_WIDTH_PX,
    hidden: true,
    // A rail of buttons, walked by keyboard — engine stops all the way down
    // ([P10]).
    kbfAtRest: true,
    // Pins to a deck edge and insets the imposition band rather than taking a
    // slot inside it.
    layoutRole: "sidebar",
    // Out of the Cards card's list, as Jots and that card itself are: those rows
    // are the deck's content cards, each carrying a slot picker for an
    // arrangement a rail can never stand in.
    cardsGroup: "none",
    sizePolicy: {
      min: { width: MIN_OVERVIEW_WIDTH_PX, height: 240 },
      preferred: { width: DEFAULT_OVERVIEW_WIDTH_PX, height: 900 },
    },
  });
}
