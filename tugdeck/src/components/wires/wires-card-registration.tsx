/**
 * wires-card-registration.tsx — registers the Wires card ([L25]).
 *
 * An ordinary registered card in a sidebar pane, exactly as Jots and the Lens
 * are: the pane machinery (FocusContext, responder scope, title-bar chrome) is
 * what makes focus restore and the pane's affordances nearly free.
 *
 * INVARIANT: `registerWiresCard()` MUST run at boot unconditionally and before
 * the deck restores its layout — `filterRegisteredCards` drops panes whose only
 * card's componentId is unregistered at load, so a gated Wires card would
 * evaporate its rail on every reload.
 *
 * @module components/wires/wires-card-registration
 */

import React from "react";
import { registerCard } from "@/card-registry";
import { WIRES_CARD_ID } from "@/lib/wires-card-id";
import { WiresContent } from "./wires-card";

export { WIRES_CARD_ID };

/** The width the Wires rail opens at before the user has sized it. Modelled
 *  on Jots: the rails stand together and one that opened wider would just be
 *  resized back. */
export const DEFAULT_WIRES_WIDTH_PX = 420;

/** The narrowest a wire's name, its glyph and its badge still read at. */
export const MIN_WIRES_WIDTH_PX = 320;

/** Register the Wires card. `hidden` keeps it out of the type-picker `[+]`
 *  menu — it is reachable through its own toggle, like the Lens and Jots. */
export function registerWiresCard(): void {
  registerCard({
    componentId: WIRES_CARD_ID,
    family: "wires",
    acceptsFamilies: [],
    contentFactory: (cardId: string) => <WiresContent cardId={cardId} />,
    defaultMeta: { title: "Wires", icon: "Zap", closable: true },
    // As undemanding as Jots: a wire's name is a word and a trip's headline is
    // a sentence, both of which survive the narrowest rail the deck can stand.
    greedRank: 3,
    hidden: true,
    // The wire LIST is the card's resting surface — rows, arrows, rings.
    kbfAtRest: true,
    layoutRole: "sidebar",
    lensGroup: "none",
    sizePolicy: {
      min: { width: MIN_WIRES_WIDTH_PX, height: 240 },
      preferred: { width: DEFAULT_WIRES_WIDTH_PX, height: 900 },
    },
  });
}
