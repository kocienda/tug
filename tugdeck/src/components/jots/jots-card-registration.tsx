/**
 * jots-card-registration.tsx — registers the Jots card ([L25]).
 *
 * Jots is an ordinary registered card hosted by the normal `CardHost` inside a
 * sidebar pane, exactly as the other rail cards are: the pane/card machinery (FocusContext,
 * responder scope, title-bar chrome) is what makes focus restore and the pane's
 * own affordances nearly free.
 *
 * INVARIANT: `registerJotsCard()` MUST run at boot unconditionally and before
 * the deck restores its layout — `filterRegisteredCards` drops panes whose only
 * card's componentId is unregistered at load, so a gated Jots card would
 * evaporate its rail on every reload.
 *
 * `family: "jots"` (a family no free pane's `acceptsFamilies` lists) plus
 * `acceptsFamilies: []` makes the card un-mergeable in both directions.
 *
 * @module components/jots/jots-card-registration
 */

import React from "react";
import { registerCard } from "@/card-registry";
import { JOTS_CARD_ID } from "@/lib/jots-card-id";
import { JotsContent } from "./jots-card";

export { JOTS_CARD_ID };

/** The width the Jots rail opens at before the user has sized it. Modelled on
 *  the Cards card: the two stand in one rail by default, and a card that opened
 *  wider than its neighbour would just be resized back. */
export const DEFAULT_JOTS_WIDTH_PX = 420;

/** The narrowest a jot's incipit and its row accessories still read at. */
export const MIN_JOTS_WIDTH_PX = 320;

/** Register the Jots card. `hidden` keeps it out of the type-picker `[+]`
 *  menu — it is reachable through its own toggle, like every rail card. */
export function registerJotsCard(): void {
  registerCard({
    componentId: JOTS_CARD_ID,
    family: "jots",
    acceptsFamilies: [],
    contentFactory: (cardId: string) => <JotsContent cardId={cardId} />,
    defaultMeta: { title: "Jots", icon: "NotebookPen", closable: true },
    // Rank 3, behind the Cards card ([B05]): jots arrive faster than arcs or
    // tripwires do, but the card the user is working in outranks the one they
    // are writing beside it. Read at seed time only.
    greedRank: 3,
    hidden: true,
    // The jot LIST is the card's resting surface — rows, arrows, rings ([P10]).
    // An open jot is a typing descend inside that list, not a different mode:
    // the editor lives in a non-trapped descend scope, so it keeps its caret
    // and Escape ascends back to the jot's row.
    kbfAtRest: true,
    // Pins to a deck edge and insets the imposition band rather than taking a
    // slot inside it.
    layoutRole: "sidebar",
    // Out of the Cards card's list, as that card itself is: those rows are the
    // deck's content cards, and each carries a slot picker for an arrangement
    // a rail can never stand in.
    cardsGroup: "none",
    sizePolicy: {
      min: { width: MIN_JOTS_WIDTH_PX, height: 240 },
      preferred: { width: DEFAULT_JOTS_WIDTH_PX, height: 900 },
    },
  });
}
