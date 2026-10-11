/**
 * The selector for every pane frame on screen, the two workspace-layer names
 * it is spelled from, and the canvas a pane frame stands in, alone in a leaf
 * module.
 *
 * `space-layer.ts` is the workspace layers' vocabulary and re-exports them;
 * lib sweeps that measure on-screen panes (the settle probe, the cut
 * detector, motion diagnostics, the pane border flash) import them from here,
 * so `lib` does not import the component layer for a string.
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

/**
 * Target-identity marker for the deck canvas's background surface. A
 * pointerdown whose target *is* a marked element is a deliberate deselect; a
 * pointerdown that merely misses every pane (a portal gap, an overlay seam,
 * below-the-fold geometry) is not.
 */
export const CANVAS_BACKGROUND_ATTRIBUTE = "data-deck-canvas-background";

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
