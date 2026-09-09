/**
 * arcs-card-registration.tsx — registers the Arcs card ([L25]).
 *
 * An ordinary registered card hosted by the normal `CardHost` inside a sidebar
 * pane, on the Jots template: the pane/card machinery (FocusContext, responder
 * scope, title-bar chrome) is what makes focus restore and the pane's own
 * affordances nearly free.
 *
 * INVARIANT: `registerArcsCard()` MUST run at boot unconditionally and before
 * the deck restores its layout — `filterRegisteredCards` drops panes whose only
 * card's componentId is unregistered at load, so a gated card would evaporate
 * its rail on every reload.
 *
 * `family: "arcs"` (a family no free pane's `acceptsFamilies` lists) plus
 * `acceptsFamilies: []` makes the card un-mergeable in both directions.
 *
 * @module components/arcs/arcs-card-registration
 */

import React from "react";
import { registerCard } from "@/card-registry";
import { ARCS_CARD_ID } from "@/lib/arcs-card-id";
import { ArcsContent } from "./arcs-card";

export { ARCS_CARD_ID };

/** The width the Arcs rail opens at before the user has sized it — the one
 *  the four cards the rail broke into share, so a rail holding several of them
 *  does not open ragged. */
export const DEFAULT_ARCS_WIDTH_PX = 420;

/** The narrowest an arc's two-line lifecycle block still reads at. */
export const MIN_ARCS_WIDTH_PX = 320;

/** Register the Arcs card. `hidden` keeps it out of the type-picker `[+]`
 *  menu — it is reachable through its own menu row and the rail ladder. */
export function registerArcsCard(): void {
  registerCard({
    componentId: ARCS_CARD_ID,
    family: "arcs",
    acceptsFamilies: [],
    contentFactory: (cardId: string) => <ArcsContent cardId={cardId} />,
    // An arc IS a branch plus a worktree, and this is the glyph that says so.
    defaultMeta: { title: "Arcs", icon: "GitBranch", closable: true },
    // Rank 4: a list, so it grows, but an arc is a whole unit of work and they
    // arrive far slower than jots or cards do.
    greedRank: 4,
    hidden: true,
    // Every row is an engine focus stop and the arrows are how the list is
    // read, so it engages KBF mode the moment it is the key card ([P10]).
    kbfAtRest: true,
    layoutRole: "sidebar",
    // Out of the Cards list, as every rail card is.
    cardsGroup: "none",
    sizePolicy: {
      min: { width: MIN_ARCS_WIDTH_PX, height: 240 },
      preferred: { width: DEFAULT_ARCS_WIDTH_PX, height: 900 },
    },
  });
}
