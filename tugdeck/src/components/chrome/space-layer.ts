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
 * The workspace a wrapper holds. Written on every layer, shown or not.
 *
 * `DeckCanvas` has always written it; nothing named it until the crossfade
 * needed to find a layer BY workspace rather than by which one is on screen —
 * the outgoing layer, the one thing `SPACE_SHOWN_ATTRIBUTE` cannot point at.
 */
export const SPACE_LAYER_ATTRIBUTE = "data-space-layer";

/**
 * Present on the OUTGOING wrapper for the length of one crossfade beat ([B09]).
 *
 * The third state of a layer, and the only one that is neither of the other
 * two: shown enough to paint, inert to the pointer, and owed back. Written and
 * removed by `deck-canvas.tsx` alone, never present on the shown layer, and
 * never on any layer once the beat lands — see `space-layer.css` for the rule
 * and `[L32]` for why the beat carries a deadline.
 */
export const SPACE_CROSSING_ATTRIBUTE = "data-space-crossing";

/**
 * On the CANVAS CONTAINER for the length of one workspace switch ([B03]).
 *
 * The switch epoch. Between the swap commit and the instant the dissolve is
 * armed, every frame of the arriving workspace is already drawn exactly where
 * the commit puts it, and nothing on the canvas may animate. `"cut"` says that
 * for the swap commit itself — `arm` takes the new arrangement as its baseline
 * and launches nothing — but the swap commit is not the only one a switch
 * produces. `activateSpace` calls `activateCard` outside the swap batch, and
 * every geometry a hidden layer could not take lands on the shown transition:
 * a composer's line box, a pane's accessory height, a sheet's clamps. Each of
 * those is its own commit, spelled `"cross"`, and each one arriving under a
 * dissolve is motion the reader did not ask for.
 *
 * So the epoch is a mark rather than a word on one commit, and `arm` treats it
 * as REDUCED MOTION for the length of one switch — not as a cut. The
 * difference is what the two say: a cut says the frames have not moved, and
 * this says they have moved and must not be seen to. A cut may therefore skip
 * the resize episodes that preserve a scrolled transcript's place, and this
 * may not.
 *
 * **Written by `DeckManager`, inside the swap commit, before its `notify`** —
 * and that is the load-bearing part. React runs layout effects CHILD-FIRST, so
 * a mark written in `DeckCanvas`'s own effect is already too late for every
 * re-arm inside the arriving layer: those effects have run by the time the
 * canvas's does. The manager writes it at the one moment that precedes all of
 * them.
 *
 * **Owed back by `deck-canvas.tsx`**, which sweeps for it on the container the
 * way it sweeps for {@link SPACE_CROSSING_ATTRIBUTE} — by looking rather than
 * by remembering, the only reading still right after a layer has been
 * unmounted underneath it. It is a debt from the frame it is written ([L32]),
 * and the removal is unconditional, idempotent, and reached by every exit the
 * crossfade effect has.
 */
export const SPACE_SWITCHING_ATTRIBUTE = "data-space-switching";

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

/**
 * The canvas, found by looking DOWN rather than up.
 *
 * {@link paneCanvasOf} answers for a caller that holds a frame and wants the
 * canvas above it. This is for the one caller that holds the React mount root
 * and wants the canvas below it — `DeckManager`, whose `container` is
 * `#deck-container` and not the element `DeckCanvas` renders the marker on.
 *
 * A selector rather than a helper taking the root, because the margin caps
 * carry the same marker and are children of the container: a `querySelector`
 * from the root returns the outer element first, in document order, which is
 * the one every other reader means.
 */
export const CANVAS_BACKGROUND_ATTRIBUTE_SELECTOR =
  `[${CANVAS_BACKGROUND_ATTRIBUTE}]`;

/** The part of a box a clamp may measure against: a top and a bottom, in viewport coordinates. */
export interface VisibleCanvasBand {
  readonly top: number;
  readonly bottom: number;
}

/**
 * The stretch of the canvas a sheet clamp may size itself against — or `null`,
 * which means REFUSE ([B03]).
 *
 * `paneCanvasOf` above answers which element the canvas is; this answers
 * whether its box is worth reading. The two questions are separate because the
 * element can be right and the reading still worthless: a canvas inside a
 * hidden workspace layer has no boxes at all, a deck mid-mount has not been
 * laid out yet, and a canvas scrolled entirely off the window has a box with
 * nothing of it on screen. Every one of those reads as a rect at or near the
 * viewport origin, and a clamp that believed it would compute a floor from
 * that origin and write a cap with no relation to where the panel stands.
 *
 * So a box of no area, and a box with no part of it inside the window, both
 * answer `null`. A caller that gets one writes nothing at all and leaves
 * whatever cap it wrote last standing — or, having written none yet, leaves
 * the CSS fallback. That is the whole of the rule: the next occurrence of this
 * class is a no-op rather than a silent mis-placement, because a measurement
 * taken in the dark reads zero and sticks.
 *
 * The band is the box clipped to the window, because the canvas can be taller
 * than the window and scrolled, and what caps a panel is the part a person can
 * actually see.
 */
export function visibleCanvasBand(
  box: { top: number; bottom: number; width: number; height: number } | null,
  windowHeight: number,
): VisibleCanvasBand | null {
  if (box === null || box.width <= 0 || box.height <= 0) return null;
  const top = Math.max(box.top, 0);
  const bottom = Math.min(box.bottom, windowHeight);
  if (bottom <= top) return null;
  return { top, bottom };
}
