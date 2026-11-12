/**
 * gauge-math.ts — shared pure helpers for the gauge primitive family.
 *
 * Both `TugLinearGauge` (rectangular fill) and `TugArcGauge` (radial
 * fill) consume the same domain-mapping and role-derivation contract:
 *
 *   - Clamp the consumer's `value` into `[min, max]` (out-of-range
 *     values saturate at the bounds rather than overflowing the
 *     visual).
 *   - Map the clamped value into a fractional position in `[0, 1]`.
 *   - Pick the effective fill role given the fraction, a base role,
 *     and optional caution / danger thresholds.
 *
 * Extracting the math into a single module ensures both gauges share
 * one canonical implementation — there is no second copy that can
 * drift, and a fix to the rounding or threshold semantics lands in
 * both consumers automatically.
 *
 * Pure-functional: no DOM, no React, no module-mutable state. Tested
 * directly with bun:test (see `__tests__/tug-linear-gauge.test.ts`
 * and `__tests__/tug-arc-gauge.test.ts`).
 *
 * @module components/tugways/gauge-math
 */

import type { TugTone } from "./tug-vocabulary";

// ---------------------------------------------------------------------------
// Role + threshold types
// ---------------------------------------------------------------------------

/**
 * Fill role drives which `--tugx-gauge-fill-{role}-color` token paints
 * the gauge surface. `caution` and `danger` are reserved for
 * threshold-derived states; consumers do not set them directly via
 * the base-role prop. The derivation lives in `effectiveFillRole`.
 */
export type GaugeFillRole = Extract<TugTone, "default" | "info" | "success" | "caution" | "danger">;

/**
 * Threshold fractions (0..1, relative to the `[min, max]` domain).
 * When `value`'s fractional position crosses a threshold, the fill
 * role is promoted to `caution` (then `danger`) regardless of the
 * base role. `danger` is a strict superset of `caution` — when both
 * thresholds are configured and the value exceeds both, only the
 * `danger` color renders.
 */
export interface GaugeThresholds {
  /** Fraction (0..1) above which the fill switches to `caution`. */
  caution?: number;
  /** Fraction (0..1) above which the fill switches to `danger`. */
  danger?: number;
}

// ---------------------------------------------------------------------------
// Domain math
// ---------------------------------------------------------------------------

/**
 * Validate the domain configuration. `max` must be strictly greater
 * than `min` — equal-or-inverted bounds produce a degenerate gauge
 * (division by zero in the fill ratio) and surface as a silent NaN
 * unless caught here.
 */
function assertValidDomain(min: number, max: number): void {
  if (!(max > min)) {
    throw new Error(
      `gauge-math: max (${max}) must be strictly greater than min (${min})`,
    );
  }
}

/**
 * Clamp `value` into `[min, max]`. Values outside the domain produce
 * a saturated fill at the corresponding edge rather than overflow.
 */
export function clampToDomain(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Compute the fractional fill (0..1) for `value` in `[min, max]`.
 * Out-of-range values clamp. Throws on `max <= min` (configuration
 * error — see {@link assertValidDomain}).
 */
export function computeFillRatio(value: number, min: number, max: number): number {
  assertValidDomain(min, max);
  return (clampToDomain(value, min, max) - min) / (max - min);
}

// ---------------------------------------------------------------------------
// Role derivation
// ---------------------------------------------------------------------------

/**
 * Derive the effective fill role from a fractional position and the
 * caller-supplied base role + thresholds. `danger` strictly supersedes
 * `caution` (both checks evaluate, the higher one wins). Thresholds
 * not in `(0, 1]` are honored as-is — callers can pass `0` to mean
 * "always promote" or `1` to mean "only at saturation."
 */
export function effectiveFillRole(
  ratio: number,
  baseRole: "default" | "info" | "success",
  thresholds?: GaugeThresholds,
): GaugeFillRole {
  if (thresholds?.danger !== undefined && ratio >= thresholds.danger) {
    return "danger";
  }
  if (thresholds?.caution !== undefined && ratio >= thresholds.caution) {
    return "caution";
  }
  return baseRole;
}
