/**
 * session-dot-overlay — the contract between the chip's bake and the layer
 * that puts a live dot in the hole the bake left.
 *
 * The composer's session chip is a Canvas bake inside an `<img>`, and it is an
 * `<img>` on purpose: `HTMLImageElement` overrides `canContainRangeEndPoint()`
 * to false, which is the one switch WebKit's editing engine reads to treat a
 * node as an atom. Everything that could carry live DOM instead — a
 * `contenteditable="false"` span, a `role="img"` element, an inline `<svg>` —
 * loses that contract at the keyboard. So the element stays baked pixels.
 *
 * But a bake is a snapshot, and the session's phase dot is the one part of the
 * chip that has to move every frame. The split this module serves: the bake
 * paints everything EXCEPT the dot, and a CodeMirror layer above the content
 * places the real `SessionPhaseDot` over the gap. The pill's surface is already
 * transparent, so the gap is an ABSENCE of paint rather than a punched hole —
 * nothing to composite through, and no halo where the two meet.
 *
 * For that to register, the layer has to know where in the bitmap the dot would
 * have gone. It could recompute the chip's layout, but a second copy of
 * `iconX + fontSize / 2` is a second thing to keep in step with the first. So
 * the bake — which already knows — writes the centre onto the `<img>` as two
 * data attributes, and the layer reads them back. The attribute names are here
 * rather than spelled at each end, because a writer and a reader that disagree
 * about a string fail silently: the layer simply finds no chips.
 *
 * There is no on/off constant. The overlay was proven as a gated spike and the
 * gate was the spike's, not the feature's — a switch nobody flips is a branch
 * nobody tests, and the unflipped side rots.
 *
 * @module lib/session-dot-overlay
 */

/** The `<img>` attribute carrying the well centre's x, in CSS px. */
export const ATOM_WELL_X_ATTR = "data-atom-well-x";

/** The `<img>` attribute carrying the well centre's y, in CSS px. */
export const ATOM_WELL_Y_ATTR = "data-atom-well-y";

/**
 * The selector the layer sweeps `view.contentDOM` with.
 *
 * `[data-atom-type]` is the atom contract every baked chip carries; the well
 * attribute is what narrows it to the chips that left their dot for us. A chip
 * baked without a well — every non-session atom — is not matched at all, so the
 * layer never has to decide whether a chip wants a dot after finding it.
 */
export const ATOM_WELL_SELECTOR = `img[data-atom-type][${ATOM_WELL_X_ATTR}]`;

/**
 * Where the dot's centre sits inside the chip's own box, in CSS px.
 *
 * Relative to the `<img>`'s top-left, which is the only origin both ends share:
 * the bake knows it before the element exists, and the layer gets it from a
 * measured client rect.
 */
export interface DotWell {
  x: number;
  y: number;
}

/**
 * Record the well on the `<img>` the bake just built.
 *
 * Numbers go through `String` rather than `toFixed`: the geometry is computed
 * in CSS px and may be fractional, and rounding here would move the dot by up
 * to half a pixel against the pixels it sits in.
 */
export function applyDotWellAttrs(el: Element, well: DotWell): void {
  el.setAttribute(ATOM_WELL_X_ATTR, String(well.x));
  el.setAttribute(ATOM_WELL_Y_ATTR, String(well.y));
}

/**
 * Read the well back, or `null` where the chip has none.
 *
 * Both halves or neither. A chip carrying one attribute is a chip whose writer
 * was interrupted, and placing a dot at a half-known centre would seat it
 * somewhere on the pill that looks deliberate. `null` means the layer skips it,
 * which shows the chip with no dot — visibly incomplete rather than quietly
 * wrong.
 */
export function readDotWell(el: Element): DotWell | null {
  const rawX = el.getAttribute(ATOM_WELL_X_ATTR);
  const rawY = el.getAttribute(ATOM_WELL_Y_ATTR);
  // `Number("")` is 0, not NaN, so an empty attribute would place the dot at
  // the chip's top-left corner and read as a deliberate position.
  if (rawX === null || rawY === null || rawX === "" || rawY === "") return null;
  const x = Number(rawX);
  const y = Number(rawY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/**
 * The attribute a host wears while the editor's selection covers its chip.
 *
 * The host stands OUTSIDE the chip — it is a child of the editor's layer, not
 * of the `<img>` — so it cannot take the selected ink by cascade. The selection
 * pass writes this, and the layer's own theme rule reads it.
 */
export const HOST_SELECTED_ATTR = "data-selected";

/**
 * The host drawn over a chip's well.
 *
 * The layer writes this as it draws, and the editor's selection pass reads it:
 * that pass walks the `<img>`s in the content and has no other way to reach the
 * element beside one. It lives here rather than in either file because it is
 * exactly what the rest of this module is — the contract two ends keep without
 * importing each other.
 */
const _hostForChip = new WeakMap<Element, HTMLElement>();

/** Record the host the layer just drew for a chip. */
export function rememberDotHost(img: Element, host: HTMLElement): void {
  _hostForChip.set(img, host);
}

/**
 * The host drawn for a chip, or `null`.
 *
 * `null` for a chip the layer has not drawn yet — a frame is all it takes — and
 * for one whose host has since left the document. The marker seeds the selected
 * flag itself when it draws, so that frame is covered rather than lost.
 */
export function dotHostForChip(img: Element): HTMLElement | null {
  const host = _hostForChip.get(img);
  return host !== undefined && host.isConnected ? host : null;
}
