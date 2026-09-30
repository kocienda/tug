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

import { createContext, useContext, useSyncExternalStore } from "react";

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
 * On the CANVAS CONTAINER for the length of one workspace switch ([B05]).
 *
 * The switch epoch. Between the swap commit and the instant the epoch closes,
 * every frame of the arriving workspace is already drawn exactly where the
 * commit puts it, and nothing on the canvas may animate. `"cut"` says that for
 * the swap commit itself — `arm` takes the new arrangement as its baseline and
 * launches nothing — but the swap commit is not the only one a switch produces.
 * `activateSpace` calls `activateCard` outside the swap batch, and every
 * geometry a hidden layer could not take lands on the shown transition: a
 * composer's line box, a pane's accessory height, a sheet's clamps. Each of
 * those is its own commit, spelled `"cross"`, and each one animated is motion
 * the reader did not ask for — they gestured at a workspace, not at a pane.
 *
 * **The mark outlives the cover that used to share its window ([P05]).** It was
 * introduced alongside the crossfade and it is easy to read as part of it, but
 * the two answered different questions: the cover hid late arrivals, and this
 * stands the imposer down over them. Retiring the cover leaves this doing the
 * whole job alone, and `space-settled.ts` is the rule for when it lifts.
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
 * **Owed back by `deck-canvas.tsx`**, which sweeps for it on the container by
 * looking rather than by remembering — the only reading still right after a
 * layer has been unmounted underneath it. It is a debt from the frame it is
 * written ([L32]), and the removal is unconditional, idempotent, and reached by
 * every path that ENDS an epoch: the settled gate closing, the bound, the
 * deadline, the next switch, and the effect's own cleanup.
 *
 * **And it is swept on those paths only, never on entry into the effect.** One
 * writer owns it now — `DeckManager`, inside the swap commit — so a sweep at the
 * top of the canvas's effect body would strip the mark in the very commit that
 * opened the epoch, and every late re-arm the mark exists to stand down would
 * animate. Under the cover an unconditional entry sweep was harmless because
 * the effect re-asserted the mark for the length of the hold; with no hold there
 * is nothing to re-assert it, and the epoch would end before it began.
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
 * subtree keeps its boxes ([B02]) — every hidden pane has the REAL rect it
 * would have on screen — so a sweep that caught one would find a place a card
 * could snap to, occlude, or settle against, on a workspace nobody is looking
 * at. Under the old `display: none` the same mistake read as a stack of zero
 * rects at the origin; now it reads as plausible geometry, which is worse,
 * and is why this clause is load-bearing rather than defensive.
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
 *
 * **It is no longer a measurement gate.** It was, for as long as the hidden
 * layer was `display: none`: a pane in one had no boxes, so every mount-time
 * measurement — a title bar's controls width, a tab bar's height, a
 * composer's line box, a sheet's clamps — read zero in the dark and was armed
 * on the shown transition instead ([L23]'s third class, as it was written).
 * A hidden layer keeps its layout now ([B02] of workspace-switch-cheap): a
 * parked pane's rects are real and equal to the ones it will have on screen —
 * every layer is arranged from its own deck, so a parked pane already stands
 * where the reveal will find it (`LayerArrangement` in `deck-canvas.tsx`) — and a
 * `ResizeObserver` under a hidden layer is silent until the layer is shown
 * and then delivers before the first shown frame paints. So a measurement
 * that is observer-backed needs no gate at all. The one gate that still reads
 * a pane's position — `tug-sheet.tsx`'s clamps — is a re-arm for the case a
 * window was resized while the workspace was parked: the swap commit
 * re-solves the arriving arrangement against the new canvas, a pane may move
 * in that commit, and a move is not a resize, so no observer catches it.
 * `at0642` is the pin on the facts.
 *
 * What still reads it, and why each is not a measurement: the Workspaces
 * card's broadcast guard above; the Session card's first-mount fade, which is
 * an entrance for a watcher and plays for nobody in the dark; and the sheet's
 * two clamps, for the resize-while-parked case above.
 */
export interface SpaceLayerShownSource {
  /**
   * The workspace this layer renders, or `null` in a host that renders no
   * layers. Fixed for the source's life — a pane that changes workspace
   * changes React parent, and so changes source.
   */
  spaceId: string | null;
  /** Whether the layer is the shown one, now. */
  get: () => boolean;
  subscribe: (callback: () => void) => () => void;
}

/** Every host that renders no layers: one workspace, and it is on screen. */
const ALWAYS_SHOWN: SpaceLayerShownSource = {
  spaceId: null,
  get: () => true,
  subscribe: () => () => {},
};

/**
 * The layer's shown-ness as a SOURCE, not a value.
 *
 * It was a boolean provided per layer, and a context value that changes
 * re-renders every consumer under it: a switch flipped it on both layers at
 * once, and every Session card body on the deck re-rendered inside the swap
 * commit — for a fact the body reads once, at mount, to decide whether an
 * entrance fade has a watcher. The source object is made once per layer and
 * never changes, so the context itself never propagates; a reader that must
 * follow the transition subscribes through {@link useSpaceLayerShown}, and a
 * reader that only asks at a moment reads `get()` there.
 */
export const SpaceLayerShownContext = createContext<SpaceLayerShownSource>(ALWAYS_SHOWN);

/**
 * Whether this card's workspace is the one being rendered, re-rendering the
 * caller when that turns ([L02]). For a reader that follows the transition —
 * a guard or a re-arm keyed on it.
 */
export function useSpaceLayerShown(): boolean {
  const source = useContext(SpaceLayerShownContext);
  return useSyncExternalStore(source.subscribe, source.get, source.get);
}

/**
 * The source itself, for a reader that asks at one moment — an effect at
 * mount — and must not re-render every time the answer turns.
 */
export function useSpaceLayerShownSource(): SpaceLayerShownSource {
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
 * hidden workspace layer is not being rendered (and its clamps are gated on
 * the shown transition regardless), a deck mid-mount has not been laid out
 * yet, and a canvas scrolled entirely off the window has a box with
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
