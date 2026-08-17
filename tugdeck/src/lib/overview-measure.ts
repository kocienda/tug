/**
 * overview-measure.ts — the Overview rail's widths, derived from its type.
 *
 * The Overview's widths are DERIVED FROM ITS TYPE, not chosen as pixel counts.
 * A post is prose, and prose wants a measure: 64 characters by default,
 * fungible down to 52 before the column stops reading as prose. Those two
 * numbers are two of the widths the space allocator takes for a rail — its
 * preference and its comfort floor ({@link lib/layout-imposer!RailPolicy}) —
 * so the typography defines the policy directly, with no new mechanism
 * between them. The third, the hard floor, is not a typographic number at
 * all: it is the width below which the card stops painting, and it is what the
 * user's own resize drag may reach.
 *
 * {@link OVERVIEW_BODY_CH_PX} and {@link OVERVIEW_ROW_CHROME_PX} are AUTHORED
 * constants, measured once against the real render and pinned by at0365,
 * rather than measured here at boot. Registration runs before layout has
 * requested the face, so `document.fonts` would answer for the fallback with
 * complete confidence (the trap `lib/font-metrics.ts` documents), and a width
 * that upgraded itself asynchronously mid-session would be a re-tune trigger
 * the allocator's moments do not include. The pin closes the drift loop
 * instead: retune the CSS and the test hands back the numbers to author here.
 *
 * A leaf module for the reason `overview-card-id.ts` is one — the app-test that
 * pins these numbers must read them without dragging the card's whole React
 * graph (and its CSS import) into its module graph.
 *
 * @module lib/overview-measure
 */

/** Must equal `.overview-post-body`'s `font-size` — pinned by at0365. */
export const OVERVIEW_BODY_FONT_PX = 13;

/**
 * The advance of "0" in the real rendered body face at
 * {@link OVERVIEW_BODY_FONT_PX} — one `ch`, measured in-app and authored here.
 */
export const OVERVIEW_BODY_CH_PX = 7.8;

/** The narrowest measure a post still reads as prose at. */
export const OVERVIEW_MIN_MEASURE_CH = 52;

/** The measure a post is written for; `.overview-post-body` caps its column
 *  at the same number of characters, so a rail widened by hand keeps a
 *  comfortable line rather than stretching it to the ceiling. */
export const OVERVIEW_MEASURE_CH = 64;

/**
 * Everything standing between the pane's width and the body column's content
 * box, both sides summed — measured in-app and authored here.
 *
 * Its anatomy, for whoever retunes it: the transcript's inline insets
 * (`--tugx-overview-transcript-inset-start` + `-end` = 13), the transcript
 * entry's icon column (`--tugx-transcript-icon-column-width` = 2.2em ≈ 31
 * against the transcript's nominal 14px root — the rail's own gutter, a step
 * under the Session card's), the entry grid's gap
 * (`--tugx-transcript-icon-column-gap` = 3), plus whatever
 * pane and CardHost chrome — borders, host padding — stands outside those.
 * macOS overlay scrollbars contribute nothing. The authored number is the
 * MEASUREMENT, not the sum of this list.
 */
export const OVERVIEW_ROW_CHROME_PX = 46;

/** The width the Overview rail opens at before the user has sized it: the
 *  64-character measure, plus the chrome it is read through. */
export const DEFAULT_OVERVIEW_WIDTH_PX =
  Math.round(OVERVIEW_MEASURE_CH * OVERVIEW_BODY_CH_PX) + OVERVIEW_ROW_CHROME_PX;

/**
 * The narrowest the rail is COMFORTABLE at: the 52-character measure, plus
 * chrome. A preference about reading quality, not a fact about rendering — the
 * space allocator holds the rail here and gives it up only when doing so buys
 * the chain a better picture than it can have otherwise (occlusion cleared, or
 * seams brought back to the imposition gap), and the user's own drag may go
 * below it down to {@link MIN_OVERVIEW_WIDTH_PX}.
 */
export const COMFORT_OVERVIEW_WIDTH_PX =
  Math.round(OVERVIEW_MIN_MEASURE_CH * OVERVIEW_BODY_CH_PX) +
  OVERVIEW_ROW_CHROME_PX;

/**
 * The narrowest the rail may stand at all — the width below which a post stops
 * being paintable rather than merely uncomfortable, and the floor the user's
 * resize drag clamps to.
 *
 * At the authored {@link OVERVIEW_BODY_CH_PX} and {@link OVERVIEW_ROW_CHROME_PX}
 * this is a measure of roughly 46 characters: narrow, still readable, and
 * enough for a byline and a ref chip. It is a judgement, not a derivation —
 * raising it trades the deck's room to fix a crowded picture for a wider
 * guaranteed measure, and needs no other change.
 */
export const MIN_OVERVIEW_WIDTH_PX = 400;
