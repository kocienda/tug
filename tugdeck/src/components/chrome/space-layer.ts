/**
 * The workspace layers' one vocabulary ([B06]).
 *
 * `DeckCanvas` renders one wrapper per MOUNTED workspace and shows exactly
 * one of them, so from Step 8 on the document holds pane frames that belong
 * to a workspace nobody is looking at. Every sweep that meant "the panes on
 * screen" has to say so, and this module is where that phrase is written down
 * once rather than re-spelled at each of the nine call sites that take one.
 *
 * The rules that draw the layers are in `space-layer.css`; this module is the
 * names those rules and the sweeps below agree on ([L06]).
 */

import { createContext, useContext } from "react";

import { CANVAS_BACKGROUND_ATTRIBUTE } from "@/gesture-interpreter";

/** The class every workspace wrapper carries. */
export const SPACE_LAYER_CLASS = "tug-space-layer";

/** Present on exactly one wrapper: the workspace being rendered. */
export const SPACE_SHOWN_ATTRIBUTE = "data-space-shown";

/**
 * Every pane frame ON SCREEN — the shown workspace's, never a mounted-but-
 * hidden one's.
 *
 * The `:not(...)` clause is an ancestor test and so is scope-independent: it
 * gives the same answer whether the sweep runs from the document, the deck
 * root, or an element inside the shown layer, which is what lets one constant
 * replace the bare `.tug-pane[data-pane-id]` everywhere. A hidden layer's
 * subtree has no boxes at all, so a sweep that caught one would be measuring
 * a stack of zero rects at the origin and treating them as places a card
 * could snap to, occlude, or settle against.
 */
export const SHOWN_PANE_FRAMES =
  `.tug-pane[data-pane-id]:not(.${SPACE_LAYER_CLASS}:not([${SPACE_SHOWN_ATTRIBUTE}]) *)`;

/**
 * Whether the workspace a card is mounted in is the one on screen.
 *
 * A card in a hidden workspace is fully alive — that is the point of [B06] —
 * and that is exactly what makes this necessary. The responder chain already
 * routes keyboard work to one first responder, so a hidden card never sees a
 * key. A BROADCAST store does not: every mounted subscriber answers, and after
 * Step 8 several mounted Workspaces cards answered one Delete Workspace
 * request, each raising its own confirm, all but one of them anchored to a row
 * nobody can see.
 *
 * So a card that acts on a broadcast reads this first. The default is `true`
 * for every host that renders no layers at all — a unit harness, a card
 * rendered on its own — which is the honest answer there: if there is one
 * workspace, it is on screen.
 */
export const SpaceLayerShownContext = createContext(true);

/** Whether this card's workspace is the one being rendered. */
export function useSpaceLayerShown(): boolean {
  return useContext(SpaceLayerShownContext);
}

/**
 * The canvas container a pane frame stands in.
 *
 * A pane's `parentElement` used to BE the canvas container, and five call
 * sites read the containing block's box that way — the drag clamp, the resize
 * clamp, both snap-guide hosts, and `DeckManager`'s canvas-relative pane rect.
 * A workspace wrapper now stands between them ([B06]), and a shown wrapper is
 * `display: contents`, which means it has no box at all: `parentElement`
 * still answers, and it answers with a rect of zeros. Every one of those
 * readings would have gone quietly wrong rather than loudly.
 *
 * So the containing block is resolved by what it IS rather than by where it
 * happens to sit. The wrapper generates no box, so this element is still the
 * one every pane's absolute position resolves against.
 */
export function paneCanvasOf(el: Element): HTMLElement | null {
  return el.closest<HTMLElement>(`[${CANVAS_BACKGROUND_ATTRIBUTE}]`);
}
