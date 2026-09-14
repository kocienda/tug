/**
 * layout-card-registration.tsx — registers the Layout card ([L25]).
 *
 * Layout is an ordinary registered card hosted by the normal `CardHost` inside
 * a sidebar pane, on the same template Tripwires and Arcs took: the
 * pane/card machinery (FocusContext, responder scope, title-bar chrome) is
 * what makes focus restore and the pane's own affordances nearly free.
 *
 * INVARIANT: `registerLayoutCard()` MUST run at boot unconditionally and
 * before the deck restores its layout — `filterRegisteredCards` drops panes
 * whose only card's componentId is unregistered at load, so a gated card would
 * evaporate its rail on every reload.
 *
 * `family: "layout"` (a family no free pane's `acceptsFamilies` lists) plus
 * `acceptsFamilies: []` makes the card un-mergeable in both directions.
 *
 * The card is also its own subject: it lists one `Off · Left · Right` row per
 * registered sidebar card, and it is one of those, so the row that moves the
 * Layout card stands in the Layout card. That is not a special case — the rows
 * are registry-driven, and the registry has always been allowed to contain the
 * card doing the reading.
 *
 * @module components/layout/layout-card-registration
 */

import React from "react";
import { registerCard } from "@/card-registry";
import { LAYOUT_CARD_ID } from "@/lib/layout-card-id";
import { LayoutContent } from "./layout-card";

export { LAYOUT_CARD_ID };

/** The width the Layout rail opens at before the user has sized it. The four
 *  cards the rail broke into stand in one rail by default, so they open at one
 *  width — a card that opened wider than its neighbour would just be resized
 *  back. */
export const DEFAULT_LAYOUT_WIDTH_PX = 420;

/** The narrowest the picture and its segmented rows still read at. It is the
 *  drawing that sets this floor: `--tugx-layouts-plan-mini-width-full` is
 *  300px and
 *  the card's own padding takes the rest. */
export const MIN_LAYOUT_WIDTH_PX = 320;

/** Register the Layout card. `hidden` keeps it out of the type-picker `[+]`
 *  menu — it is reachable through its own menu row and the rail ladder. */
export function registerLayoutCard(): void {
  registerCard({
    componentId: LAYOUT_CARD_ID,
    family: "layout",
    acceptsFamilies: [],
    contentFactory: (cardId: string) => <LayoutContent cardId={cardId} />,
    defaultMeta: { title: "Layout", icon: "Columns3", closable: true },
    // Last of the six, rank 6: the only card whose content is fixed. Its
    // drawing and its control rows are the same size tomorrow, so space handed
    // to it is space nothing will ever grow into.
    greedRank: 6,
    hidden: true,
    // Every row here is an engine focus stop and the arrows are how the card
    // is read, so it engages KBF mode the moment it is the key card ([P10]).
    kbfAtRest: true,
    // Out of the Cards list, as every rail card is: those rows are the deck's
    // content cards, and each carries a slot picker for an arrangement a rail
    // can never stand in.
    cardsGroup: "none",
    // Pins to a deck edge and insets the imposition band rather than taking a
    // slot inside it.
    layoutRole: "sidebar",
    sizePolicy: {
      min: { width: MIN_LAYOUT_WIDTH_PX, height: 240 },
      preferred: { width: DEFAULT_LAYOUT_WIDTH_PX, height: 900 },
    },
  });
}
