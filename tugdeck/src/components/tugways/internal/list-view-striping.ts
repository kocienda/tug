/**
 * list-view-striping.ts — pure resolution of `TugListView`'s `rowStriping`
 * prop into the CSS custom-property values the scroll container writes.
 *
 * Alternating row tint is the other way a dense list separates its rows: where
 * a divider draws a line BETWEEN rows, a stripe tints every other row, so the
 * list reads as banded without spending a pixel of height on rules. A row that
 * costs one line of text is easier to track across with a band than with a
 * hairline, which is the trade the BBEdit open-documents list makes.
 *
 * BOTH parities get a color. The obvious construction — leave one set of rows
 * on the host surface and wash the other — is wrong, and wrong in a way that
 * only shows up on short lists: it puts ONE step between adjacent rows, and a
 * step that small is legible only when it repeats. A ten-row list reads as
 * banded; a two-row list reads as two identical rows, because a single
 * transition gives the eye nothing to compare. Painting both parities puts a
 * step of twice the strength between any two neighbours and makes every row a
 * deliberate color, so two rows alternate as plainly as ten do.
 *
 * The two tints are the surface's own FOREGROUND and its own CONTENT SURFACE —
 * opposite directions by construction, whatever the theme. On the dark themes
 * the foreground is light and the content surface is dark; on the light themes
 * they swap. So one strength number moves the odd rows one way and the even
 * rows the other in all six themes, and no theme file declares a stripe color.
 *
 * A striped list stripes at ANY length. Two rows alternate, one row is the
 * first term of the alternation, and neither is special-cased away: a list's
 * row count changes constantly — files open and close, snippets come and go —
 * and a treatment that switches itself off below some threshold would mean the
 * list changes character under the user while they work.
 *
 * Kept out of the component so it is unit-testable with no DOM.
 */

/**
 * Named stripe strengths — how far the banded row's tint moves off the
 * surface. Authored as one scale rather than a free number so a consumer picks
 * a rung and every striped list in the app lands on the same few values.
 */
export type TugListViewStripeStrength =
  | "faint"
  | "subtle"
  | "medium"
  | "strong";

/**
 * Which band a row takes. `"even"` / `"odd"` are the two washes; `"none"`
 * takes neither and leaves the row on the host surface — a section heading
 * standing between two banded runs, not part of either.
 */
export type TugListViewStripeParity = "even" | "odd" | "none";

/** The object form of `rowStriping` — tune strength and/or color. */
export interface TugListViewRowStripingConfig {
  /**
   * Stripe strength — a named rung, or a NUMBER for the wash alpha as a
   * percent (`4` ⇒ 4%). The number is what a tuning session wants: the rungs
   * are four points on a continuum and the right value for a given list is
   * often between two of them. Default `"subtle"`.
   */
  strength?: TugListViewStripeStrength | number;
  /** The ODD rows' color — any CSS color or token reference. Overrides the
   *  strength-derived wash outright. */
  color?: string;
  /** The EVEN rows' color, same terms. Override both together, or neither:
   *  overriding one leaves the pair's step at whatever the mismatch happens to
   *  be. */
  baseColor?: string;
}

/**
 * `rowStriping` prop type. A strength name or config object turns striping on;
 * `"none"` — like omitting the prop — leaves every row on the host surface.
 */
export type TugListViewRowStriping =
  | TugListViewStripeStrength
  | TugListViewRowStripingConfig
  | "none";

/**
 * The alpha each named rung resolves to, as a percent. Exported because the
 * rung names are the vocabulary but the NUMBERS are what a consumer tuning a
 * list by eye actually reasons about — a tune point that names a rung without
 * showing its value is asking someone to go read another file.
 */
export const STRIPE_STRENGTH_PERCENT: Record<
  TugListViewStripeStrength,
  number
> = {
  faint: 2,
  subtle: 4,
  medium: 7,
  strong: 11,
};

/**
 * Resolved striping — the two colors the container writes, to
 * `--tugx-list-view-stripe-color` (odd rows) and
 * `--tugx-list-view-stripe-base-color` (even rows). `resolveRowStriping`
 * returns `null` when there is no striping at all.
 */
export interface ResolvedRowStriping {
  color: string;
  baseColor: string;
}

/** The odd rows' wash — the host surface's own text color. */
const STRIPE_TINT = "var(--tugx-list-view-stripe-tint)";
/** The even rows' wash — the host surface's own content surface, which is the
 *  opposite direction from the text color in every theme. */
const STRIPE_SHADE = "var(--tugx-list-view-stripe-shade)";

/**
 * Resolve `rowStriping` to the values the container writes, or `null` for
 * `"none"` / omitted. Pure; exported for the test suite.
 */
export function resolveRowStriping(
  prop: TugListViewRowStriping | undefined,
): ResolvedRowStriping | null {
  if (prop === undefined || prop === "none") return null;
  const strength = typeof prop === "string" ? prop : (prop.strength ?? "subtle");
  const config = typeof prop === "string" ? {} : prop;
  return {
    color: config.color ?? stripeWash(STRIPE_TINT, strength),
    baseColor: config.baseColor ?? stripeWash(STRIPE_SHADE, strength),
  };
}

/** One parity's wash at a strength — a named rung or a raw percent. */
function stripeWash(
  tint: string,
  strength: TugListViewStripeStrength | number,
): string {
  const percent =
    typeof strength === "number"
      ? strength
      : STRIPE_STRENGTH_PERCENT[strength];
  return `color-mix(in srgb, ${tint} calc(${percent}% * var(--tugx-list-view-stripe-gain, 1)), transparent)`;
}
