/**
 * crossing-band.ts — the band a folding card's bottom edge carries.
 *
 * A whole card's fold is shown by the host as a snapshot of the open card,
 * clipped by the closing edge, over the page already laid out folded. Left at
 * that, the folded form's bottom band — the Session card's Z2 strip — only
 * appears when the snapshot comes off at the land, a snap. So the page names
 * the band and the host carries it: the band holds its open place in the
 * snapshot until the closing edge reaches it, then rides the edge as the live
 * page's own strip, and the land changes nothing.
 *
 * Two readings make that possible, both in CSS px:
 *
 *   - the band's distance from the viewport's bottom in the OPEN form, taken
 *     when the card goes into its fold and still lays out open
 *     ({@link noteCrossingBandRest}); a distance from the bottom, because the
 *     column above the band absorbs any change of the page's height;
 *   - the band's top and height in the FOLDED form, taken when the crossing
 *     is solved ({@link readCrossingBand}).
 *
 * Both are DOM, never React state ([L06]).
 *
 * A whole card whose box changes height outside a fold hangs its picture
 * from two edges instead ({@link readCrossingAnchor}): the head — the
 * masthead — from the top, and everything below the split from the bottom,
 * so the composer and band ride the moving edge from the first frame. Where
 * the split falls is the card's own fact: a transcript following its bottom
 * hangs from the scroller's top ([`data-still-anchor="bottom"`] on the card
 * root, the same mark the shell's own hold reads); any other — a scrolled-up
 * transcript, an editor — keeps its rows at the top and hangs from the
 * bottom everything below its scroller, which the live page bottom-hangs
 * too: the composer and band, or an editor's status bar.
 *
 * Content centered in its box — an image fitted to the card — has neither
 * edge to hang from: held at the top it stands where the old box centered
 * it while the page beyond the cover shows where the new one does, two
 * pictures meeting at the cover's edge. Its scroller says so
 * ([`data-crossing-scroller="center"`]), and the picture hangs from three
 * places: the head from the top, the bottom chrome from the moving edge,
 * and the live page's scroller centered between them, on its own ground.
 *
 * @module lib/crossing-band
 */

import { STILL_ANCHOR_ATTR } from "./fold-crossing";

/** Marks the element that rides a folding card's bottom edge. */
export const CROSSING_BAND_ATTR = "data-crossing-band";

/** Marks the element that absorbs a card's height: the scroller between its head and its bottom band. */
export const CROSSING_SCROLLER_ATTR = "data-crossing-scroller";

/** {@link CROSSING_SCROLLER_ATTR}'s value for a scroller whose content is centered in its box. */
export const CROSSING_SCROLLER_CENTER = "center";

/**
 * Marks chrome inside the scroller that pins to its top while its entry
 * scrolls past (`position: sticky`). A snapshot cannot carry a pin: its
 * pinned row is pixels that ride away with the rest, where the live page
 * keeps the pin at the scroller's top. So a pin that is stuck is counted as
 * part of the head, and the split falls below it.
 */
export const CROSSING_PIN_ATTR = "data-crossing-pin";

/** The band's distance from the viewport's bottom in the open form, CSS px. */
export const CROSSING_BAND_REST_ATTR = "data-crossing-band-rest";

/** The band as the host needs it to carry it, CSS px. */
export interface CrossingBand {
  /** Its top's distance from the viewport's bottom in the open form. */
  readonly restFromBottom: number;
  /** Its top in the folded form, from the viewport's top. */
  readonly top: number;
  /** Its height. */
  readonly height: number;
  /** The viewport's height in the folded form: the host's scale from CSS px. */
  readonly viewport: number;
}

/**
 * Note where `band` stands in the open form, as the card goes into its fold:
 * one read of the layout the fold's own commit lays out.
 */
export function noteCrossingBandRest(band: HTMLElement): void {
  const rest = window.innerHeight - band.getBoundingClientRect().top;
  band.setAttribute(CROSSING_BAND_REST_ATTR, String(Math.round(rest * 100) / 100));
}

/** Forget the open form's reading: the card is unfolding, or open. */
export function clearCrossingBandRest(band: HTMLElement): void {
  band.removeAttribute(CROSSING_BAND_REST_ATTR);
}

/**
 * The band under `root` in the folded form, or null when there is none, or
 * no open reading to carry it from.
 */
export function readCrossingBand(root: ParentNode): CrossingBand | null {
  const band = root.querySelector<HTMLElement>(`[${CROSSING_BAND_ATTR}]`);
  const rest = Number(band?.getAttribute(CROSSING_BAND_REST_ATTR) ?? Number.NaN);
  if (band == null || !Number.isFinite(rest)) return null;
  const rect = band.getBoundingClientRect();
  const viewport = window.innerHeight;
  if (!(viewport > 0)) return null;
  return { restFromBottom: rest, top: rect.top, height: rect.height, viewport };
}

/**
 * How a whole card's picture hangs while its box changes height outside a
 * fold, CSS px in the form the page is solved at.
 */
export interface CrossingAnchor {
  /**
   * The row the picture splits at: above it hangs from the top, below it from
   * the bottom. For content that follows, the scroller's top — or the bottom
   * of the pin stuck there, which hangs with the head.
   */
  readonly splitTop: number;
  /** The split is the scroller's top, the content following the bottom; else the scroller's bottom. */
  readonly follows: boolean;
  readonly viewport: number;
  /** Set when the scroller's content is centered in its box; else null. */
  readonly center: CrossingCenter | null;
}

/** A centered scroller, which rides the box's center between the head and the split. */
export interface CrossingCenter {
  /** The scroller's top: the head above it hangs from the top. */
  readonly top: number;
  /** The scroller's own background as sRGB bytes, shown where the page does not reach; null when it paints none. */
  readonly ground: number[] | null;
}

/**
 * Where the picture under `root` splits, or null when the card names no
 * scroller. `groundOf` reads a centered scroller's background as sRGB bytes.
 */
export function readCrossingAnchor(
  root: ParentNode,
  groundOf: (el: HTMLElement) => number[] | null = () => null,
): CrossingAnchor | null {
  const scroller = root.querySelector<HTMLElement>(`[${CROSSING_SCROLLER_ATTR}]`);
  const viewport = window.innerHeight;
  if (scroller == null || !(viewport > 0)) return null;
  if (scroller.getAttribute(CROSSING_SCROLLER_ATTR) === CROSSING_SCROLLER_CENTER) {
    const rect = scroller.getBoundingClientRect();
    return { splitTop: rect.bottom, follows: false, viewport, center: { top: rect.top, ground: groundOf(scroller) } };
  }
  const follows = scroller.closest(`[${STILL_ANCHOR_ATTR}="bottom"]`) !== null;
  if (!follows) return { splitTop: scroller.getBoundingClientRect().bottom, follows, viewport, center: null };
  const top = scroller.getBoundingClientRect().top;
  let splitTop = top;
  // A pin is stuck when it sits at the scroller's top rather than at its
  // entry's — or, telescoped, at the bottom of the pin above it: read from
  // where it stands, in document order, not from a flag a scroll event stamps.
  for (const pin of scroller.querySelectorAll<HTMLElement>(`[${CROSSING_PIN_ATTR}]`)) {
    const rect = pin.getBoundingClientRect();
    if (rect.top <= splitTop + 2 && rect.bottom > splitTop + 2) splitTop = rect.bottom;
  }
  return { splitTop, follows, viewport, center: null };
}
