/**
 * sparkline-geometry — the paint the cascade cannot reach.
 *
 * The canvas has no cascade, so the colours and the three numbers the
 * instrument strokes with have to be resolved from computed style on the main
 * thread and carried to whichever thread draws. They live here, apart from
 * both hosts, because the stylesheet's rest baseline asserts the same
 * constants — `__tests__/sparkline-rest-baseline-alpha.test.ts` is what keeps
 * the two homes of each number equal.
 *
 * The staircase itself is arithmetic inside the instrument's own draw
 * (`sparkline-instrument.ts`), computed fresh from the activity store's bins
 * and the clock. Nothing here holds a point array, an origin, or a picture.
 *
 * @module lib/sparkline-geometry
 */

/** Resolved paint. The SVG carried these as `currentColor` plus opacity. */
export interface SparklineColors {
  line: string;
  area: string;
  lineAlpha: number;
  areaAlpha: number;
  lineWidth: number;
}

export const SPARKLINE_LINE_ALPHA = 0.85;
export const SPARKLINE_AREA_ALPHA = 0.16;
export const SPARKLINE_LINE_WIDTH = 1;
