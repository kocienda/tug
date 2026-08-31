/**
 * lens-register-card.tsx — registers the Lens card ([L25]).
 *
 * The Lens is an ordinary registered card hosted by the normal
 * `CardHost` inside an anchored pane (the right-edge rail). There is no
 * bespoke shell and no `CardHost`/`TugPane` bypass — the pane/card
 * machinery (FocusContext, responder scope, title-bar chrome) is exactly
 * what makes Cmd-L, focus restore, and the `…` menu nearly free.
 *
 * INVARIANT: `registerLensCard()` MUST run at boot unconditionally
 * (never behind a maker/feature gate) and before the deck restores its
 * layout — `filterRegisteredCards` drops panes whose only card's
 * componentId is unregistered at load, so a gated Lens card would
 * evaporate the anchored rail on every reload.
 *
 * `family: "lens"` (a family no free pane's `acceptsFamilies` lists)
 * plus `acceptsFamilies: []` on the anchored pane makes the Lens card
 * un-mergeable in both directions — belt-and-suspenders on top of the
 * anchored pane already being non-draggable and single-card.
 *
 * @module components/lens/lens-register-card
 */

import React from "react";
import { registerCard } from "@/card-registry";
import {
  DEFAULT_LENS_WIDTH_PX,
  MIN_LENS_WIDTH_PX,
} from "@/lib/lens-store/types";
import { LENS_CARD_ID } from "@/lib/lens-card-id";
import { LensContent } from "./lens-content";

/** The Lens card's componentId — the registered singleton id. Declared in
 *  `lib/lens-card-id.ts` so non-component code can name it; re-exported here
 *  because this is where callers expect to find it. */
export { LENS_CARD_ID };

/** Register the Lens card. `hidden` keeps it out of the type-picker
 *  `[+]` menu: it is reachable only through Cmd-L / Opt-Cmd-L. */
export function registerLensCard(): void {
  registerCard({
    componentId: LENS_CARD_ID,
    family: "lens",
    acceptsFamilies: [],
    contentFactory: (cardId: string) => <LensContent cardId={cardId} />,
    defaultMeta: { title: "Lens", icon: "Microscope", closable: true },
    // Greedier than Jots, less greedy than the Overview: rows elide where prose
    // cannot, so the Lens gives width back before a reading surface does.
    greedRank: 2,
    hidden: true,
    // Every row here is an engine focus stop and the arrows are how the Lens
    // is read, so it engages KBF mode the moment it is the key card ([P10]).
    kbfAtRest: true,
    // Pins to a deck edge and insets the imposition band rather than taking a
    // slot inside it — the machinery the anchored rail has always used, now
    // declared rather than matched on `componentId`.
    layoutRole: "sidebar",
    // The mirror does not reflect itself.
    cardsGroup: "none",
    sizePolicy: {
      min: { width: MIN_LENS_WIDTH_PX, height: 240 },
      preferred: { width: DEFAULT_LENS_WIDTH_PX, height: 900 },
    },
  });
}
