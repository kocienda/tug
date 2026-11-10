/**
 * TugArcGauge — radial-fill quantity gauge primitive.
 *
 * The radial counterpart to {@link TugLinearGauge}. Maps `value` from
 * `[min, max]` into a proportional sweep along a circular arc, with
 * the same threshold-based color zones as the linear gauge and the
 * same `compact` / `detailed` density modes. Stateless presentation;
 * the consumer owns `value`.
 *
 * The arc's shape is configurable via `geometry.startAngleDeg` and
 * `geometry.sweepAngleDeg`. Defaults to a "C" sweep that leaves the
 * bottom 90° of the circle open — a familiar dashboard-dial
 * silhouette. Other useful shapes:
 *
 *  - Full circle:   `{ startAngleDeg: 0,   sweepAngleDeg: 360 }`
 *  - Half-circle:   `{ startAngleDeg: 180, sweepAngleDeg: 180 }` (top half)
 *  - Quarter-arc:   `{ startAngleDeg: 180, sweepAngleDeg: 90 }`  (top-left)
 *
 * Angle convention follows SVG: 0° points right (positive x-axis),
 * 90° points down, 180° points left, 270° points up. `sweepAngleDeg`
 * is always positive — the arc sweeps clockwise from
 * `startAngleDeg` for `sweepAngleDeg` degrees of arc. Negative sweeps
 * are rejected (a configuration error — see {@link arcPath}).
 *
 * Color slots are shared with `TugLinearGauge` via the
 * `--tugx-gauge-fill-{role}-color` family declared in
 * `tug-linear-gauge.css` body{}. Arc-specific geometry slots live in
 * `tug-arc-gauge.css` body{} under the `--tugx-gauge-arc-*`
 * namespace; the two gauges' geometry slots never collide.
 *
 * Laws:
 *  - [L06] appearance via SVG path mutation, not React state. The
 *    `value` drives one inline `d` attribute on the fill path; role
 *    color comes from `[data-role]` on the wrapper.
 *  - [L17] every `--tugx-gauge-arc-*` slot resolves to a `--tug7-*`
 *    or `--tug-*` base token in one hop. Shared color slots
 *    (`--tugx-gauge-fill-*`) are declared in `tug-linear-gauge.css`
 *    body{} per the same rule.
 *  - [L19] component authoring — file pair, module docstring,
 *    `data-slot="tug-arc-gauge"`.
 *  - [L20] component-token sovereignty — owns `--tugx-gauge-arc-*`
 *    exclusively; reads the shared `--tugx-gauge-fill-{role}-color`
 *    family. No primitive overrides another's slots.
 *  - [L24] structure zone for the React tree; arc path geometry is
 *    pushed to the SVG via inline `d` attribute — appearance, not
 *    React state.
 *
 * Accessibility: `role="meter"` on the wrapper with `aria-valuemin`
 * / `aria-valuemax` / `aria-valuenow`. When `label` is provided,
 * `aria-valuetext` reads `"{formattedValue} {label}"`. The SVG
 * itself has `aria-hidden="true"` because all semantics live on the
 * wrapper.
 *
 * @module components/tugways/tug-arc-gauge
 */

// The shared gauge colour slots (value/percent/label text, track, fills)
// live in tug-linear-gauge.css's body{}; this primitive reads them, so it
// imports them — a surface that loads only the arc gauge (the overlay's
// Z2 placard) otherwise draws its readout in the SVG default black.
import "./tug-linear-gauge.css";
import "./tug-arc-gauge.css";

import React from "react";
import { cn } from "@/lib/utils";
import {
  computeFillRatio,
  effectiveFillRole,
  type GaugeFillRole,
  type GaugeThresholds,
} from "./gauge-math";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Re-exports for source compat with consumers that import from here. */
export type TugArcGaugeFillRole = GaugeFillRole;
export type TugArcGaugeThresholds = GaugeThresholds;

/**
 * Semantic tones for `TugArcGauge`'s segmented mode.
 *
 * Two parallel tone vocabularies coexist:
 *
 * - **Wire-level cost tones** (`input` / `cache-read` / `cache-creation`
 *   / `output` / `remainder`): the original five tones, surfacing the
 *   per-turn `cost_update.usage.*` token breakdown. Consumed by the
 *   Context popover's fallback view (`#step-20-4-7-c`) and any future
 *   raw-cost categorical surface.
 *
 * - **`/context`-style category tones** (`system_prompt` / `system_tools`
 *   / `custom_agents` / `memory_files` / `skills` / `messages` /
 *   `autocompact_buffer`): the seven categories the rich Context
 *   popover surfaces from the persisted `context_breakdown` wire frame.
 *   `mcp_tools` is intentionally absent — Tug treats MCP as out of
 *   scope; no MCP slice ever paints.
 *
 * The vocabularies don't overlap and both stay in the union; each
 * call site picks the relevant subset. `remainder` straddles both
 * uses since the synthesized fill-the-gap segment is shape-uniform
 * across either categorical mapping.
 *
 * Each tone resolves to a `--tugx-arc-gauge-segment-<tone>-color`
 * alias in CSS, one-hop to a `--tug7-*` base token per [L17].
 */
export type TugArcGaugeSegmentTone =
  // Wire-level cost tones — see `#step-20-4-7-c`.
  | "input"
  | "cache-read"
  | "cache-creation"
  | "output"
  | "remainder"
  // `/context`-style category tones — see `#step-20-4-7-d`. No
  // `mcp_tools` per "Out of scope: MCP".
  | "system_prompt"
  | "system_tools"
  | "custom_agents"
  | "memory_files"
  | "skills"
  | "messages"
  | "autocompact_buffer";

/**
 * One categorical segment painted along the arc in segmented mode.
 * Segments paint in array order around the arc, beginning at the
 * gauge's `startAngleDeg` and cumulatively advancing by each
 * segment's `(value / max) * sweepAngleDeg` arc length. When the
 * caller's segment values sum to less than `max`, the gauge synthesizes
 * a "remainder" segment that fills the gap; when they sum to `max`
 * (or more — overflow is clamped at the arc end), no remainder is
 * appended.
 */
export interface TugArcGaugeSegment {
  /**
   * Stable identity for this segment across renders. Used as the
   * SVG path's React key so the path's `d`-attribute transitions
   * animate against the same node instead of remounting on every
   * value change. [L26]
   */
  id: string;
  /**
   * Numeric magnitude in the same domain as `max`. Negative values
   * clamp to `0`; segments with `value === 0` produce a zero-sweep
   * layout entry but render no path geometry.
   */
  value: number;
  /** Semantic tone — selects the `--tugx-arc-gauge-segment-<tone>-color` slot. */
  tone: TugArcGaugeSegmentTone;
  /**
   * Optional human-readable label for the segment. The primitive does
   * not render the label itself (the segment surface is geometry +
   * stroke only); consumers compose their own legend alongside the
   * gauge if they need one.
   */
  label?: string;
}

/**
 * Single laid-out segment ready for rendering: tone + path geometry
 * (start angle + sweep length in degrees) + the source segment's
 * input fields preserved for legend composition.
 *
 * The synthesized remainder segment carries `id === "__remainder__"`
 * and `tone === "remainder"` so consumers can detect it without
 * pattern-matching string fields.
 */
export interface TugArcGaugeSegmentLayout {
  id: string;
  tone: TugArcGaugeSegmentTone;
  startAngleDeg: number;
  sweepAngleDeg: number;
  /** The clamped (≥ 0) value used for the layout's sweep ratio. */
  value: number;
  label?: string;
}

/** Sentinel id used for the auto-appended remainder segment. */
export const ARC_GAUGE_SEGMENT_REMAINDER_ID = "__remainder__";

/** Density mode — `compact` for chrome / dashboard, `detailed` for
 *  the full mockup-style face with ticks. */
export type TugArcGaugeDensity = "compact" | "detailed";

/**
 * Arc-shape overrides. Both angles are in degrees, following the SVG
 * convention (0° right, 90° down, 180° left, 270° up). The arc sweeps
 * clockwise from `startAngleDeg` for `sweepAngleDeg` degrees. Defaults
 * to a "C" sweep: `startAngleDeg: 135`, `sweepAngleDeg: 270`.
 */
export interface TugArcGaugeGeometry {
  startAngleDeg: number;
  sweepAngleDeg: number;
}

export interface TugArcGaugeProps
  extends Omit<
    React.ComponentPropsWithoutRef<"div">,
    "role" | "aria-valuemin" | "aria-valuemax" | "aria-valuenow" | "aria-valuetext"
  > {
  /** Current value, in domain units. Out-of-range values clamp into `[min, max]`. */
  value: number;
  /** Domain minimum. */
  min: number;
  /** Domain maximum. Must satisfy `max > min`. */
  max: number;
  /**
   * Optional warning-zone fractions (0..1 relative to `[min, max]`).
   * See {@link GaugeThresholds} for the promotion rules.
   */
  thresholds?: TugArcGaugeThresholds;
  /**
   * Optional label rendered below the readout (compact) or inside the
   * arc beneath the percent text (detailed).
   */
  label?: string;
  /**
   * Optional formatter for the displayed value (and the hi / lo labels
   * in `detailed` density). Defaults to `String(value)`.
   */
  formatValue?: (value: number) => string;
  /** Density mode. Defaults to `compact`. */
  density?: TugArcGaugeDensity;
  /** Base fill role when no threshold is exceeded. Defaults to `default`. */
  fillRole?: "default" | "info" | "success";
  /**
   * Override the default "C" sweep. See {@link TugArcGaugeGeometry}.
   * The default is intentionally an unusual angle (135° / 270°) so an
   * accidentally-omitted geometry prop still produces a sensibly-
   * shaped gauge.
   */
  geometry?: TugArcGaugeGeometry;
  /**
   * Categorical breakdown along the arc. When provided, the gauge
   * switches to segmented mode (`data-mode="segments"`): the arc is
   * painted as a sequence of per-tone segments instead of a single
   * value-vs-max sweep. Segments paint left-to-right in array order,
   * sized to `(segment.value / max) * sweepAngleDeg`. When the segment
   * values sum to less than `max`, a remainder segment is synthesized
   * to fill the gap.
   *
   * In segmented mode the following props are documented as ignored:
   * `value`, `formatValue`, `thresholds`, `fillRole`. The track and
   * single-fill paths are also hidden — the segments (including the
   * synthesized remainder) cover the arc entirely. The `label` prop
   * still renders in segmented mode for both density modes; the
   * value/percent readouts do not (their per-value meaning doesn't
   * apply to a categorical breakdown). Consumers compose any legend
   * separately, alongside the gauge.
   *
   * @selector .tug-arc-gauge[data-mode="segments"]
   */
  segments?: ReadonlyArray<TugArcGaugeSegment>;
}

// ---------------------------------------------------------------------------
// Default geometry — the "C" sweep
// ---------------------------------------------------------------------------

/**
 * Default arc shape: starts at the bottom-left (135°) and sweeps 270°
 * clockwise around to the bottom-right (45°), leaving the bottom 90°
 * of the circle open. The familiar dashboard-dial silhouette.
 */
export const DEFAULT_ARC_GEOMETRY: TugArcGaugeGeometry = {
  startAngleDeg: 135,
  sweepAngleDeg: 270,
};

// ---------------------------------------------------------------------------
// Arc geometry helpers (exported for testing — no DOM, no React)
// ---------------------------------------------------------------------------

/** Polar → cartesian for a unit-circle point at angle `angleDeg`. The
 *  caller scales by radius and translates to the center. */
function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angleDeg: number,
): { x: number; y: number } {
  const angleRad = (angleDeg * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(angleRad),
    y: cy + radius * Math.sin(angleRad),
  };
}

/**
 * Build the SVG `d` attribute for an arc segment.
 *
 *  - `cx`, `cy`: circle center.
 *  - `radius`: arc radius.
 *  - `startAngleDeg`: where the arc begins (SVG angle convention).
 *  - `sweepAngleDeg`: how many degrees the arc spans (always positive).
 *  - `fillRatio`: 0..1 — how much of the sweep is "filled" (the rest
 *    is empty / belongs to the track path, not this arc).
 *
 * Behavior at the edges:
 *
 *  - `fillRatio === 0` or `sweepAngleDeg === 0` → empty string (no
 *    path geometry; the consumer's `<path d="">` renders nothing).
 *  - Effective sweep (`sweepAngleDeg * fillRatio`) ≥ 360° → a full-
 *    circle path made of two semicircle arcs (a single SVG arc
 *    command cannot draw 360° because start === end and the path
 *    collapses).
 *  - Effective sweep > 180° → `large-arc-flag` = 1; otherwise 0.
 *
 * Throws on negative `sweepAngleDeg` (configuration error).
 */
export function arcPath(
  cx: number,
  cy: number,
  radius: number,
  startAngleDeg: number,
  sweepAngleDeg: number,
  fillRatio: number,
): string {
  if (sweepAngleDeg < 0) {
    throw new Error(
      `tug-arc-gauge: sweepAngleDeg (${sweepAngleDeg}) must be >= 0; negative sweeps are not supported`,
    );
  }
  if (sweepAngleDeg === 0 || fillRatio === 0) {
    return "";
  }
  const effectiveSweep = sweepAngleDeg * fillRatio;
  if (effectiveSweep >= 360) {
    // Full-circle path — split into two semicircles because a single
    // SVG arc command with start === end collapses to nothing.
    const left = polarToCartesian(cx, cy, radius, startAngleDeg);
    const right = polarToCartesian(cx, cy, radius, startAngleDeg + 180);
    return [
      `M${left.x},${left.y}`,
      `A${radius},${radius} 0 1 1 ${right.x},${right.y}`,
      `A${radius},${radius} 0 1 1 ${left.x},${left.y}`,
    ].join(" ");
  }
  const start = polarToCartesian(cx, cy, radius, startAngleDeg);
  const end = polarToCartesian(cx, cy, radius, startAngleDeg + effectiveSweep);
  const largeArcFlag = effectiveSweep > 180 ? 1 : 0;
  return `M${start.x},${start.y} A${radius},${radius} 0 ${largeArcFlag} 1 ${end.x},${end.y}`;
}

// ---------------------------------------------------------------------------
// Segment layout — categorical-breakdown geometry (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Lay out per-segment start angles + sweep lengths from a categorical
 * breakdown. Each input segment maps to a contiguous arc span;
 * spans paint in array order beginning at `gaugeStartAngleDeg`, each
 * sized to `(value / max) * gaugeSweepAngleDeg`. Cumulative sweep is
 * clamped at `gaugeSweepAngleDeg` so a segment whose `value` would
 * overshoot the arc end gets truncated; any further segments after
 * the overflow are emitted with `sweepAngleDeg === 0`.
 *
 * Behavior:
 *
 *  - `max <= 0` → empty array (degenerate domain; no meaningful layout).
 *  - `gaugeSweepAngleDeg <= 0` → empty array (no arc to lay out).
 *  - `segments.length === 0` → returns a single remainder segment
 *    covering the full arc when `max > 0`.
 *  - Sum of segment values < `max` → appends a synthesized remainder
 *    segment with id `ARC_GAUGE_SEGMENT_REMAINDER_ID` and tone
 *    `"remainder"`, filling the gap.
 *  - Sum equals or exceeds `max` → no remainder appended; segments
 *    occupying overflow space get truncated by the cumulative clamp.
 *  - Negative segment values clamp to `0` (no inverse sweep).
 *
 * Pure: no DOM, no React, no time source.
 */
export function layoutArcSegments(
  segments: ReadonlyArray<TugArcGaugeSegment>,
  max: number,
  gaugeStartAngleDeg: number,
  gaugeSweepAngleDeg: number,
): ReadonlyArray<TugArcGaugeSegmentLayout> {
  if (max <= 0 || gaugeSweepAngleDeg <= 0) {
    return [];
  }
  const arcEnd = gaugeStartAngleDeg + gaugeSweepAngleDeg;
  const out: TugArcGaugeSegmentLayout[] = [];
  let cumStart = gaugeStartAngleDeg;
  for (const seg of segments) {
    const value = Math.max(0, seg.value);
    const remaining = Math.max(0, arcEnd - cumStart);
    const desiredSweep = (value / max) * gaugeSweepAngleDeg;
    const sweep = Math.min(desiredSweep, remaining);
    out.push({
      id: seg.id,
      tone: seg.tone,
      startAngleDeg: cumStart,
      sweepAngleDeg: sweep,
      value,
      label: seg.label,
    });
    cumStart += sweep;
  }
  const remaining = arcEnd - cumStart;
  if (remaining > 0) {
    const remainderValue =
      max * (remaining / gaugeSweepAngleDeg);
    out.push({
      id: ARC_GAUGE_SEGMENT_REMAINDER_ID,
      tone: "remainder",
      startAngleDeg: cumStart,
      sweepAngleDeg: remaining,
      value: remainderValue,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tick generation for the detailed density
// ---------------------------------------------------------------------------

/**
 * Default tick configuration for the `detailed` density. Held as a
 * module constant rather than props — we deliberately collapsed the
 * mockup's per-instance tick knobs into sensible density-driven
 * defaults (mirrors {@link TugLinearGauge}'s approach).
 */
const DETAILED_TICK_CONFIG = {
  /** Major ticks across the full sweep, inclusive of both endpoints. */
  majorCount: 11,
  /** Minor ticks between each pair of major ticks. */
  minorBetween: 4,
} as const;

/** Major-tick angle positions across the sweep (inclusive endpoints). */
function detailedMajorAngles(
  startAngleDeg: number,
  sweepAngleDeg: number,
): ReadonlyArray<number> {
  const angles: number[] = [];
  for (let i = 0; i < DETAILED_TICK_CONFIG.majorCount; i++) {
    angles.push(
      startAngleDeg + (sweepAngleDeg * i) / (DETAILED_TICK_CONFIG.majorCount - 1),
    );
  }
  return angles;
}

/** Minor-tick angle positions, evenly spaced between major ticks. */
function detailedMinorAngles(
  startAngleDeg: number,
  sweepAngleDeg: number,
): ReadonlyArray<number> {
  const angles: number[] = [];
  const segments = DETAILED_TICK_CONFIG.majorCount - 1;
  const stepsPerSegment = DETAILED_TICK_CONFIG.minorBetween + 1;
  for (let segment = 0; segment < segments; segment++) {
    for (let step = 1; step <= DETAILED_TICK_CONFIG.minorBetween; step++) {
      const t = (segment + step / stepsPerSegment) / segments;
      angles.push(startAngleDeg + sweepAngleDeg * t);
    }
  }
  return angles;
}

// ---------------------------------------------------------------------------
// SVG viewBox sizing
// ---------------------------------------------------------------------------

/**
 * Viewbox metrics shared between the SVG and the tick / text
 * positioning. The radius is whatever fills the [0..VIEWBOX_SIZE]
 * box minus stroke + tick-outroom padding.
 */
const VIEWBOX_SIZE = 100;
const VIEWBOX_CENTER = VIEWBOX_SIZE / 2;
/** Inner radius (the arc's centerline). Reserves room for the stroke
 *  (which extends ±strokeWidth/2 from the centerline) and for the
 *  outer ticks rendered in the detailed density. */
const ARC_RADIUS_COMPACT = 42;
const ARC_RADIUS_DETAILED = 38;
const TICK_MAJOR_LENGTH = 6;
const TICK_MINOR_LENGTH = 3;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const TugArcGauge = React.forwardRef<HTMLDivElement, TugArcGaugeProps>(
  function TugArcGauge(
    {
      value,
      min,
      max,
      thresholds,
      label,
      formatValue,
      density = "compact",
      fillRole = "default",
      geometry,
      segments,
      className,
      ...rest
    }: TugArcGaugeProps,
    ref,
  ) {
    const { startAngleDeg, sweepAngleDeg } = geometry ?? DEFAULT_ARC_GEOMETRY;
    const isSegmented = segments !== undefined;
    const ratio = computeFillRatio(value, min, max);
    const role = effectiveFillRole(ratio, fillRole, thresholds);
    const display = formatValue ?? ((v: number) => String(v));
    const valueText = display(value);
    const ariaValueText =
      label !== undefined ? `${valueText} ${label}` : valueText;
    const percentText = `${(ratio * 100).toFixed(1)}%`;

    const radius =
      density === "detailed" ? ARC_RADIUS_DETAILED : ARC_RADIUS_COMPACT;

    const trackD = arcPath(
      VIEWBOX_CENTER,
      VIEWBOX_CENTER,
      radius,
      startAngleDeg,
      sweepAngleDeg,
      1,
    );
    const fillD = arcPath(
      VIEWBOX_CENTER,
      VIEWBOX_CENTER,
      radius,
      startAngleDeg,
      sweepAngleDeg,
      ratio,
    );

    // Segmented mode: lay out per-tone segments and pre-compute each
    // segment's SVG `d` attribute. The single-value `trackD` / `fillD`
    // paths are hidden in this mode via CSS — the segments (including
    // the synthesized remainder) cover the arc end-to-end.
    const segmentLayouts = isSegmented
      ? layoutArcSegments(segments, max, startAngleDeg, sweepAngleDeg)
      : null;

    // Segmented mode "used" total — the sum of every resident
    // segment's value. Drives `aria-valuenow` and the detailed-density
    // center readout so a user opening the gauge with screen-reader
    // or keyboard inspection hears the same "how full" reading the
    // text overlay shows. Excludes the `remainder` (unused) and
    // `autocompact_buffer` (reserved, not yet used) tones so this
    // matches the consumer-side "used" figure — e.g. the context
    // popover's "used" row and the status bar's CONTEXT cell.
    const segmentedUsedTotal =
      segmentLayouts === null
        ? 0
        : segmentLayouts.reduce(
            (sum, s) =>
              s.tone === "remainder" || s.tone === "autocompact_buffer"
                ? sum
                : sum + s.value,
            0,
          );
    const segmentedValueText = isSegmented ? display(segmentedUsedTotal) : "";
    const segmentedPercentText =
      isSegmented && max > 0
        ? `${((segmentedUsedTotal / max) * 100).toFixed(1)}%`
        : "0.0%";

    return (
      <div
        ref={ref}
        data-slot="tug-arc-gauge"
        data-density={density}
        data-mode={isSegmented ? "segments" : "value"}
        data-role={role}
        className={cn("tug-arc-gauge", className)}
        role="meter"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={isSegmented ? segmentedUsedTotal : value}
        aria-valuetext={
          isSegmented
            ? `${segmentedValueText} ${label ?? "used"} (${segmentedPercentText})`
            : ariaValueText
        }
        {...rest}
      >
        <svg
          className="tug-arc-gauge-svg"
          viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}
          aria-hidden="true"
        >
          {!isSegmented && trackD !== "" ? (
            <path className="tug-arc-gauge-track" d={trackD} />
          ) : null}
          {!isSegmented && fillD !== "" ? (
            <path className="tug-arc-gauge-fill" d={fillD} />
          ) : null}
          {segmentLayouts !== null
            ? segmentLayouts.map((s) => {
                if (s.sweepAngleDeg <= 0) {
                  return null;
                }
                const d = arcPath(
                  VIEWBOX_CENTER,
                  VIEWBOX_CENTER,
                  radius,
                  s.startAngleDeg,
                  s.sweepAngleDeg,
                  1,
                );
                return d === "" ? null : (
                  <path
                    key={s.id}
                    className="tug-arc-gauge-segment"
                    data-tone={s.tone}
                    d={d}
                  />
                );
              })
            : null}
          {density === "detailed" ? (
            <DetailedTicks
              startAngleDeg={startAngleDeg}
              sweepAngleDeg={sweepAngleDeg}
              radius={radius}
            />
          ) : null}
          {density === "detailed" ? (
            <>
              <text
                className="tug-arc-gauge-value-svg"
                x={VIEWBOX_CENTER}
                y={VIEWBOX_CENTER - 2}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {isSegmented ? segmentedValueText : valueText}
              </text>
              <text
                className="tug-arc-gauge-percent-svg"
                x={VIEWBOX_CENTER}
                y={VIEWBOX_CENTER + 10}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {isSegmented ? segmentedPercentText : percentText}
              </text>
            </>
          ) : null}
        </svg>
        {density === "compact" && !isSegmented ? (
          <div className="tug-arc-gauge-readout">
            <span className="tug-arc-gauge-value">{valueText}</span>
            {label !== undefined ? (
              <span className="tug-arc-gauge-label">{label}</span>
            ) : null}
          </div>
        ) : null}
        {density === "compact" && isSegmented && label !== undefined ? (
          <div className="tug-arc-gauge-readout">
            <span className="tug-arc-gauge-label">{label}</span>
          </div>
        ) : null}
        {density === "detailed" && label !== undefined ? (
          <span className="tug-arc-gauge-label tug-arc-gauge-label-detailed">
            {label}
          </span>
        ) : null}
      </div>
    );
  },
);

// ---------------------------------------------------------------------------
// Detailed-density tick rail (rendered inside the SVG)
// ---------------------------------------------------------------------------

interface DetailedTicksProps {
  startAngleDeg: number;
  sweepAngleDeg: number;
  radius: number;
}

const DetailedTicks: React.FC<DetailedTicksProps> = ({
  startAngleDeg,
  sweepAngleDeg,
  radius,
}) => {
  const majors = detailedMajorAngles(startAngleDeg, sweepAngleDeg);
  const minors = detailedMinorAngles(startAngleDeg, sweepAngleDeg);
  return (
    <g className="tug-arc-gauge-ticks">
      {minors.map((angleDeg, i) => {
        const inner = polarToCartesian(
          VIEWBOX_CENTER,
          VIEWBOX_CENTER,
          radius + 2,
          angleDeg,
        );
        const outer = polarToCartesian(
          VIEWBOX_CENTER,
          VIEWBOX_CENTER,
          radius + 2 + TICK_MINOR_LENGTH,
          angleDeg,
        );
        return (
          <line
            key={`minor-${i}`}
            className="tug-arc-gauge-tick-minor"
            x1={inner.x}
            y1={inner.y}
            x2={outer.x}
            y2={outer.y}
          />
        );
      })}
      {majors.map((angleDeg, i) => {
        const inner = polarToCartesian(
          VIEWBOX_CENTER,
          VIEWBOX_CENTER,
          radius + 2,
          angleDeg,
        );
        const outer = polarToCartesian(
          VIEWBOX_CENTER,
          VIEWBOX_CENTER,
          radius + 2 + TICK_MAJOR_LENGTH,
          angleDeg,
        );
        return (
          <line
            key={`major-${i}`}
            className="tug-arc-gauge-tick-major"
            x1={inner.x}
            y1={inner.y}
            x2={outer.x}
            y2={outer.y}
          />
        );
      })}
    </g>
  );
};
