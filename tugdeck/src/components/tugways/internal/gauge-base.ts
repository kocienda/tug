/**
 * gauge-base — what `TugArcGauge` and `TugLinearGauge` share.
 *
 * The two gauges differ in shape — an SVG sweep and a horizontal bar — and
 * share everything a gauge says: a value in `[min, max]`, its threshold zones,
 * its label and formatter, its density, its base fill tone, and the reading
 * derived from those (the fill ratio, the effective tone, the formatted value,
 * the percent and the meter's accessible value text). The props are one type
 * and the reading is one function, so the two faces cannot drift on what a
 * given value means.
 *
 * Laws: [L06] the reading is pure — the gauges push it onto the DOM as
 * attributes and inline geometry; [L19] internal module, no `data-slot`.
 *
 * @module components/tugways/internal/gauge-base
 */

import type React from "react";

import type { TugDensity } from "../tug-vocabulary";
import {
  computeFillRatio,
  effectiveFillRole,
  type GaugeFillRole,
  type GaugeThresholds,
} from "../gauge-math";

/** The props both gauges are described by. */
export interface TugGaugeBaseProps
  extends Omit<
    React.ComponentPropsWithoutRef<"div">,
    "role" | "aria-valuemin" | "aria-valuemax" | "aria-valuenow" | "aria-valuetext"
  > {
  /** Current value, in domain units. Out-of-range values clamp into `[min, max]`. */
  value: number;
  /** Domain minimum. */
  min: number;
  /** Domain maximum. Must satisfy `max > min`; otherwise the geometry helpers throw. */
  max: number;
  /**
   * Optional warning-zone fractions (0..1 relative to `[min, max]`). See
   * {@link GaugeThresholds} for the promotion rules. Omitted thresholds
   * disable that band.
   */
  thresholds?: GaugeThresholds;
  /** Optional label beside (or beneath) the readout. */
  label?: string;
  /**
   * Optional formatter for the displayed value and, in `regular` density, the
   * hi / lo labels. Defaults to `String(value)`; a tokens display might pass
   * `(v) => `${(v / 1000).toFixed(1)}k``.
   */
  formatValue?: (value: number) => string;
  /** Density mode — `compact` for chrome strips, `regular` for full faces. @default "compact" */
  density?: TugDensity;
  /**
   * Base fill tone when no threshold is exceeded. `caution` and `danger` are
   * derived from `thresholds`, never passed here.
   * @default "default"
   */
  fillTone?: "default" | "info" | "success";
}

/** What a gauge reads off its props. */
export interface GaugeReading {
  /** The clamped fill fraction, 0..1. */
  ratio: number;
  /** The fill tone after thresholds: the root's `data-tone`. */
  role: GaugeFillRole;
  /** The formatter, defaulted. */
  display: (value: number) => string;
  /** `value`, formatted. */
  valueText: string;
  /** The meter's `aria-valuetext`: the value, then the label when there is one. */
  ariaValueText: string;
  /** The fill as a percent, one decimal. */
  percentText: string;
}

/** Derives a gauge's reading from its props. */
export function gaugeReading(
  props: Pick<TugGaugeBaseProps, "value" | "min" | "max" | "thresholds" | "label" | "formatValue"> & {
    fillTone: NonNullable<TugGaugeBaseProps["fillTone"]>;
  },
): GaugeReading {
  const { value, min, max, thresholds, label, formatValue, fillTone } = props;
  const ratio = computeFillRatio(value, min, max);
  const role = effectiveFillRole(ratio, fillTone, thresholds);
  const display = formatValue ?? ((v: number) => String(v));
  const valueText = display(value);
  return {
    ratio,
    role,
    display,
    valueText,
    ariaValueText: label !== undefined ? `${valueText} ${label}` : valueText,
    percentText: `${(ratio * 100).toFixed(1)}%`,
  };
}
