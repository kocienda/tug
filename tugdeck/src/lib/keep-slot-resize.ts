/**
 * keep-slot-resize.ts — the geometry of an edge resize that keeps a card in
 * its slot: its width on a fit deck and on a flow one, and its height where it
 * stands alone or stacked in its slot.
 *
 * Pure functions. The fit half is the numeric twin of `imposeStyle`'s fit
 * `left` (`layout-imposer.ts`); the flow half asks the deck's one strip. The
 * resize machine in `tug-pane.tsx` solves the dragged edge against these so
 * the frames it draws while the hand holds it are the frames the imposer draws
 * once the width is committed.
 */

import { deckFlowStrip } from "@/deck-store-selectors";
import type { DeckState } from "@/layout-tree";
import { resolvePlacement } from "@/lib/layout-imposer";

/**
 * Where a fit card's left edge lands at `width`: the numeric twin of
 * `imposeStyle`'s fit `left` for a card that is its own slot, measured
 * in canvas px against the band's left edge.
 *
 * A fit slot is the card's own width, so a width change moves the slot too:
 * the travel the slot's fraction takes a share of is `band − width`. That is
 * why a slot-keeping resize cannot simply centre the card — the left edge
 * moves at `−fraction` of the change and the right edge at `1 − fraction`,
 * and the two are equal only where the fraction is a half.
 */
export function fitImposedLeft(
  fraction: number,
  bandStart: number,
  bandWidth: number,
  width: number,
): number {
  return bandStart + fraction * Math.max(0, bandWidth - width);
}

/**
 * How far one horizontal edge of a fit card moves per pixel of width change,
 * at `width`. A rate of zero is an edge pinned to the arrangement — slot 0's
 * left edge, the last slot's right edge, or the left edge of a card wider than
 * the band — and a slot-keeping resize offers no handle there: an edge that
 * cannot follow the hand is not a handle.
 */
export function fitEdgeRate(
  edge: "left" | "right",
  fraction: number,
  bandWidth: number,
  width: number,
): number {
  const travelling = width < bandWidth;
  if (edge === "left") return travelling ? fraction : 0;
  return travelling ? 1 - fraction : 1;
}

/**
 * The width that puts a fit card's dragged edge at `edgeX`, keeping the card
 * in its slot: the inverse of {@link fitImposedLeft} for the edge in hand, so
 * the edge stays under the pointer and the frame the gesture draws is the one
 * the imposer will draw at commit. Clamped to `[min, max]`; a target the edge
 * cannot reach (a left edge asked to pass the band's start) answers the
 * nearest width that reaches as far as the edge can go.
 */
export function fitWidthForEdge(
  edge: "left" | "right",
  edgeX: number,
  fraction: number,
  bandStart: number,
  bandWidth: number,
  min: number,
  max: number,
): number {
  const clamp = (w: number) => Math.min(max, Math.max(min, w));
  if (edge === "right") {
    // right(W) = bandStart + fraction·(band − W) + W while W < band, and
    // bandStart + W past it — both rising in W, so one of the two solves.
    if (fraction < 1) {
      const travelling = (edgeX - bandStart - fraction * bandWidth) / (1 - fraction);
      if (travelling < bandWidth) return clamp(travelling);
    }
    return clamp(Math.max(bandWidth, edgeX - bandStart));
  }
  // left(W) = bandStart + fraction·(band − W) while W < band; past the band
  // the edge stands at the band's start, which is as far left as it goes.
  if (fraction <= 0) return clamp(bandWidth);
  return clamp(Math.min(bandWidth, bandWidth - (edgeX - bandStart) / fraction));
}

/** What a flow width drag moves, at one width: how far each slotted pane's
 *  strip place has travelled from where it stood, and the strip's length. */
export interface FlowResizeShift {
  /** Pane id → px its frame's `left` moves by. Zero for every pane at or
   *  before the dragged one's slot, unless a held-open vacancy before it
   *  reserves the deck's widest card and the dragged card is that card. */
  shifts: Map<string, number>;
  /** The strip's length at this width — what the canvas publishes as
   *  `FLOW_STRIP_PROPERTY` once the width is committed. */
  stripWidth: number;
}

/**
 * Where every slot of a flow deck stands once `paneId` is `width` wide, as
 * travel from where it stands in `state`.
 *
 * In flow a slot's place is the running sum of the extents before it, so a
 * width change moves every later slot by the change in its own slot's extent
 * and leaves the card's left edge where it is. This asks the deck's one strip
 * ({@link deckFlowStrip}) twice — once as the deck stands, once with the width
 * the commit will write — rather than restating the running sum, so the frames
 * the gesture draws are the frames the canvas places once the width is in the
 * store: a stack mate wider than the card, or a vacancy reserving the widest
 * card, comes out the same way in both. `null` when the deck is not in flow.
 */
export function flowResizeShift(
  state: DeckState,
  paneId: string,
  width: number,
): FlowResizeShift | null {
  const kind = state.imposition.kind;
  const before = deckFlowStrip(state);
  const after = deckFlowStrip({
    ...state,
    panes: state.panes.map((pane) =>
      pane.id === paneId ? { ...pane, size: { ...pane.size, width } } : pane,
    ),
  });
  if (kind === undefined || before === null || after === null) return null;
  const shifts = new Map<string, number>();
  for (const pane of state.panes) {
    if (pane.slot === undefined) continue;
    const slot = resolvePlacement(kind, pane.slot).slot;
    const from = before.positions.get(slot);
    const to = after.positions.get(slot);
    if (from === undefined || to === undefined) continue;
    shifts.set(pane.id, to - from);
  }
  return { shifts, stripWidth: after.width };
}

/**
 * What a bottom-edge drag in a slot writes: the height the hand left, or
 * `null` — delete the field — when it reached the run's end. A card dragged
 * back to full height is a card with no height of its own, so it follows the
 * run when the window changes instead of holding the run's old height. The
 * half pixel absorbs the rounding of a pointer that came to rest on the end.
 */
export function slotHeightAfterDrag(
  height: number,
  runHeight: number,
): number | null {
  return height >= runHeight - 0.5 ? null : height;
}
