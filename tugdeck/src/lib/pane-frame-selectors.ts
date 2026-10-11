/**
 * The selector for every pane frame on screen, and the two workspace-layer
 * names it is spelled from, alone in a leaf module.
 *
 * `space-layer.ts` is the workspace layers' vocabulary and re-exports all
 * three; lib sweeps that measure on-screen panes (the settle probe, the cut
 * detector, motion diagnostics) import them from here, so `lib` does not
 * import the component layer for a string.
 *
 * @module lib/pane-frame-selectors
 */

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
 * subtree keeps its boxes ([B02]) — every hidden pane has the REAL rect it
 * would have on screen — so a sweep that caught one would find a place a card
 * could snap to, occlude, or settle against, on a workspace nobody is looking
 * at. Under the old `display: none` the same mistake read as a stack of zero
 * rects at the origin; now it reads as plausible geometry, which is worse,
 * and is why this clause is load-bearing rather than defensive.
 *
 * A PARKED rail member (`data-rail-parked`) keeps its box for the same reason
 * and is left out for the same reason: its rail was hidden whole, and it
 * stands nowhere a reader can see.
 *
 * A DEPARTING frame (`data-departing`) is left out too. It is a closed pane
 * kept mounted, inert, for the one settle that carries it out, and it stands
 * in no place a card could snap to, occlude, or settle against.
 */
export const SHOWN_PANE_FRAMES =
  `.tug-pane[data-pane-id]:not([data-rail-parked]):not([data-departing]):not(.${SPACE_LAYER_CLASS}:not([${SPACE_SHOWN_ATTRIBUTE}]) *)`;
