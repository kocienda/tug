/**
 * TugProgressIndicator — Unified indicator for indeterminate progress, phase,
 * and determinate progress.
 *
 * Six visual variants live behind one prop surface:
 *
 *   ring          — stroked SVG arc (determinate or indeterminate rotating)
 *   bar           — horizontal track + fill (determinate or barber-pole)
 *   pie           — conic-gradient wedge (determinate or rotating)
 *   spinner       — single-arc rotor
 *   pulsing-dot   — a dot that breathes on a 2s cycle and sheds a ring at
 *                   the turn (replaces TugStateIndicator)
 *   wave          — three-bar staggered pulse (replaces TugThinkingIndicator)
 *
 * The component is a compound dispatch [L20]: it owns role-color injection,
 * effective-state resolution (explicit props × phaseVisual), label layout,
 * ARIA progressbar semantics, and the TugBox disabled cascade. The internal
 * variant component owns the glyph itself and its animation.
 *
 * Five states cover every variant's lifecycle:
 *
 *   running       — animated (the canonical indeterminate / in-flight pose)
 *   paused        — animation frozen mid-pose (animation-play-state: paused)
 *   stopped       — quiescent rest pose, no animation (outlined ring,
 *                   empty bar, dot without ring, static bars)
 *   completed     — finished pose, no animation (closed filled ring, full
 *                   bar, large solid dot, peak-pose bars)
 *   aborted       — canceled/halted pose, danger-tinted, no animation
 *                   (subsumes the old `errored` and `interruptInFlight`
 *                   treatments)
 *
 * `disabled` is a state per the seven-slot convention [T-classification]:
 *  it dims and freezes any variant, independent of `state`.
 *
 * **State implies role.** When no explicit `role` is passed (and no
 * `phaseVisual` returns one), the effective role defaults from the
 * effective state via {@link defaultRoleForState}:
 *
 *   running   → action   (Key — work in flight; the theme's key color)
 *   paused    → caution  (yellow — held)
 *   stopped   → inherit  (muted — quiescent)
 *   completed → success  (green — finished)
 *   aborted   → danger   (red — canceled / errored)
 *
 * This is a deliberate conflation: state IS visually paired with a
 * role in nearly every callsite, and the default removes a repetitive
 * `role={statusToRole(state)}` mapping that every consumer would
 * otherwise re-derive. The explicit `role` prop still wins for the
 * cases that need to override (e.g. `restoring → caution + running`).
 *
 * Phase API (replaces TugStateIndicator's CodeSession-aware reducer):
 *
 *   phase         — caller-defined identifier emitted as data-phase
 *   phaseLabels   — phase → human-readable label map; doubles as the
 *                   width-stabilize set for labelAlign="center"
 *   phaseVisual   — phase → partial { role, state, shape }; explicit
 *                   role/state/shape props win over phaseVisual returns
 *
 * Layout:
 *   glyphPosition — left | right | both (paired mirrored glyphs)
 *   labelAlign    — start (default) | center (reserves the widest
 *                   phaseLabels entry's width via CSS grid stack)
 *   labelPosition — inline | tooltip (suppress inline label; surface in
 *                   a hover tooltip)
 *
 * Laws: [L02] state arrives via props from the consumer's external store;
 *       [L06] appearance via CSS / DOM attributes, never React state;
 *       [L13] motion is per internal variant — every glyph here is now a
 *             continuous CSS keyframe loop;
 *       [L15] token-driven states;
 *       [L16] pairings declared in CSS;
 *       [L19] component authoring guide;
 *       [L20] token sovereignty — internal variants own their glyph; the
 *             public component owns role-color injection and layout.
 *
 * @module components/tugways/tug-progress-indicator
 */

import "./tug-progress-indicator.css";

import React from "react";

import { cn } from "@/lib/utils";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { TugLabel, type TugLabelEmphasis } from "@/components/tugways/tug-label";
import { useTugBoxDisabled } from "./internal/tug-box-context";
import { TugProgressRing } from "./internal/tug-progress-ring";
import { TugProgressBar } from "./internal/tug-progress-bar";
import { TugProgressPie } from "./internal/tug-progress-pie";
import { TugProgressSpinner } from "./internal/tug-progress-spinner";
import { TugProgressPulsingDot } from "./internal/tug-progress-pulsing-dot";
import { TugProgressWave } from "./internal/tug-progress-wave";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TugProgressIndicatorVariant =
  | "ring"
  | "bar"
  | "pie"
  | "spinner"
  | "pulsing-dot"
  | "wave";

/**
 * Semantic role. `inherit` resolves the indicator fill to `currentColor` so
 * the glyph picks up its host's text tone — useful in muted prose contexts
 * where the indicator should read as part of the surrounding copy rather
 * than as a separate accent.
 */
export type TugProgressIndicatorRole =
  | "inherit"
  | "action"
  | "agent"
  | "data"
  | "option"
  | "success"
  | "caution"
  | "danger";

export type TugProgressIndicatorState =
  | "running"
  | "paused"
  | "stopped"
  | "completed"
  | "aborted";

/**
 * The mark's shape — a third visual axis beside role and state, and the only
 * one a variant may decline to honor. `dot` is every glyph's own figure;
 * `bar` asks for a long mark instead, and today the pulsing dot is the
 * variant that draws one. It exists for the phase that has to share a tint
 * with another phase and still read apart from it.
 */
export type TugProgressIndicatorShape = "dot" | "bar";

export type TugProgressIndicatorGlyphPosition = "left" | "right" | "both";

export type TugProgressIndicatorLabelPosition = "inline" | "tooltip";

export type TugProgressIndicatorLabelAlign = "start" | "center";

/**
 * Partial visual returned by {@link TugProgressIndicatorProps.phaseVisual}.
 * Explicit `role` / `state` / `shape` props on the indicator always win over
 * fields returned here.
 */
export interface TugProgressIndicatorPhaseVisual {
  readonly role?: TugProgressIndicatorRole;
  readonly state?: TugProgressIndicatorState;
  readonly shape?: TugProgressIndicatorShape;
}

/**
 * Default {@link TugProgressIndicatorProps.formatValue} — a whole-number
 * percentage of `max`, e.g. `0.42 → "42%"`. Exported so consumers can reuse
 * the canonical format (and so it is unit-testable on its own).
 */
export function defaultProgressValueLabel(value: number, max: number): string {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return `${Math.round(pct)}%`;
}

// ---------------------------------------------------------------------------
// Role → token resolution
// ---------------------------------------------------------------------------

/**
 * Aliases the public role name to the suffix used in the seven-slot token
 * names. `action` resolves to `active` — matches the convention TugProgress
 * established and that `TugLabel` already mirrors so role names line up
 * across primitives.
 */
const ROLE_TO_TOKEN_SUFFIX: Record<Exclude<TugProgressIndicatorRole, "inherit">, string> = {
  action: "active",
  agent: "agent",
  data: "data",
  option: "option",
  success: "success",
  caution: "caution",
  danger: "danger",
};

/**
 * All variants resolve their fill from the same token family —
 * `--tug7-surface-toggle-primary-normal-{role}-rest` — so the role
 * tone reads identically across ring/bar/pie/spinner/pulsing-dot/wave.
 * This is the same family used for any control-surface tone
 * elsewhere in the system; switching to it makes the indicator's
 * "action" tone match every other active control — now the theme's Key.
 */
function buildFillStyle(
  _variant: TugProgressIndicatorVariant,
  role: TugProgressIndicatorRole,
): React.CSSProperties {
  const token = progressRoleFillToken(role);
  return {
    "--tugx-progress-indicator-fill": token === null ? "currentColor" : `var(${token})`,
  } as React.CSSProperties;
}

/**
 * The token name a role's fill resolves from, or `null` for `inherit` — which
 * paints in `currentColor` and so has no token to name.
 *
 * Exported for the one renderer that cannot cascade: the editor's atom chip is
 * a Canvas bake inside an `<img>`, so a session atom's dot has to resolve this
 * tone to pixels rather than inherit it.
 */
export function progressRoleFillToken(
  role: TugProgressIndicatorRole,
): string | null {
  if (role === "inherit") return null;
  return `--tug7-surface-toggle-primary-normal-${ROLE_TO_TOKEN_SUFFIX[role]}-rest`;
}

/**
 * Default role for a given effective state. The state×role pairing is
 * the design system's standard mapping; callsites that don't want to
 * override simply pass `state` and the role falls out automatically.
 *
 *   running   → action   (Key — work in flight; the theme's key color)
 *   paused    → caution  (yellow — held)
 *   stopped   → inherit  (muted — quiescent)
 *   completed → success  (green — finished)
 *   aborted   → danger   (red — canceled / errored)
 */
function defaultRoleForState(state: TugProgressIndicatorState): TugProgressIndicatorRole {
  switch (state) {
    case "running":
      return "action";
    case "paused":
      return "caution";
    case "completed":
      return "success";
    case "aborted":
      return "danger";
    case "stopped":
    default:
      return "inherit";
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TugProgressIndicatorProps
  extends Omit<React.ComponentPropsWithoutRef<"span">, "role" | "children"> {
  /**
   * Visual treatment.
   * @selector [data-variant="ring"] | [data-variant="bar"] | [data-variant="pie"] | [data-variant="spinner"] | [data-variant="pulsing-dot"] | [data-variant="wave"]
   * @default "ring"
   */
  variant?: TugProgressIndicatorVariant;

  /**
   * Semantic role tone. `inherit` resolves the fill to `currentColor`.
   * Omit for the theme's default accent tone (per-variant).
   * @selector [data-role="<role>"]
   */
  role?: TugProgressIndicatorRole;

  /**
   * Lifecycle state. `running` animates the variant's canonical
   * indeterminate motion; the other four states paint a static pose.
   * `aborted` always renders in the danger tone regardless of `role`.
   *
   * Defaults to `stopped` — motion is opt-in, because a running glyph
   * asserts that work is executing right now. Say `running` (or supply a
   * `phaseVisual` that resolves to it) when that is true.
   * @selector [data-state="running"] | [data-state="paused"] | [data-state="stopped"] | [data-state="completed"] | [data-state="aborted"]
   * @default "stopped"
   */
  state?: TugProgressIndicatorState;

  /**
   * The mark's shape. `bar` draws the glyph long where the variant has a
   * long form (today: `pulsing-dot`); every other variant ignores it.
   * @selector [data-shape="bar"]
   * @default "dot"
   */
  shape?: TugProgressIndicatorShape;

  /**
   * Disables the indicator (dims + freezes motion). Also driven by the
   * TugBox disabled cascade.
   * @selector [data-disabled]
   * @default false
   */
  disabled?: boolean;

  /**
   * Determinate progress value, 0 to `max`. Only honored by `ring`, `bar`,
   * and `pie` — other variants ignore. When undefined — OR not yet positive
   * (`value <= 0`) — the variant runs its indeterminate motion (driven by
   * `state`) rather than painting a stalled 0%, so a freshly-started bar
   * never sits at a literal 0. It becomes determinate the moment `value`
   * goes positive.
   */
  value?: number;

  /**
   * Maximum value for determinate progress.
   * @default 1
   */
  max?: number;

  /**
   * Show the determinate value as a text readout alongside the glyph. Only
   * meaningful when `value` is set (determinate); ignored otherwise. The
   * readout sits at the trailing end of the row — for the `bar` variant the
   * track flexes and the readout sits to its right (the canonical labeled-
   * bar layout); for `ring` / `pie` it trails the glyph. Formatted by
   * {@link formatValue}.
   * @selector [data-slot="tug-progress-indicator"] .tug-progress-indicator-value
   * @default false
   */
  showValue?: boolean;

  /**
   * Formatter for the {@link showValue} readout. Receives the current
   * `value` and `max`; defaults to a whole-number percentage
   * ({@link defaultProgressValueLabel}, e.g. `42%`).
   */
  formatValue?: (value: number, max: number) => string;

  /**
   * Geometric size in CSS px. Applied as `--tugx-progress-indicator-size`.
   * @default 16
   */
  size?: number;

  /**
   * Caller-defined phase identifier. Emitted as `data-phase` on the root
   * and used by `phaseVisual` / `phaseLabels` to look up presentation.
   * @selector [data-phase="<phase>"]
   */
  phase?: string;

  /**
   * Phase → human-readable label map. The active phase's entry is used
   * for the visible label / tooltip when `label` is omitted; the entire
   * map drives the width-stabilize behavior for `labelAlign="center"`.
   */
  phaseLabels?: Record<string, string>;

  /**
   * Phase → partial visual ({@link TugProgressIndicatorPhaseVisual}).
   * Returned `role` / `state` fields are defaults — explicit `role` /
   * `state` props on the indicator override them.
   */
  phaseVisual?: (phase: string) => TugProgressIndicatorPhaseVisual;

  /**
   * Visible label text. Overrides `phaseLabels[phase]`. When omitted and
   * a phase is set, the label resolves to `phaseLabels[phase]`.
   */
  label?: string;

  /**
   * Optional `TugLabel` emphasis for the visible label. When omitted the
   * label renders as a bare span (the historical default — inherits the
   * host's type). When set, the active label is wrapped in a `TugLabel` at
   * that emphasis (e.g. `proposal` for a muted small-caps caption). Opt-in,
   * so existing callers are unaffected.
   */
  labelEmphasis?: TugLabelEmphasis;

  /**
   * Where to render the visible label.
   *   inline   — render alongside the glyph(s)
   *   tooltip  — suppress inline; surface in a hover tooltip
   * @selector [data-label-position="inline"] | [data-label-position="tooltip"]
   * @default "inline"
   */
  labelPosition?: TugProgressIndicatorLabelPosition;

  /**
   * Label alignment within its layout slot. `center` activates the
   * width-stabilize behavior — every `phaseLabels` entry is rendered as
   * a hidden ghost in the same grid cell as the live label, so the cell
   * sizes to the widest entry and the live label centers within it.
   * @selector [data-label-align="start"] | [data-label-align="center"]
   * @default "start"
   */
  labelAlign?: TugProgressIndicatorLabelAlign;

  /**
   * Glyph layout. `both` renders two synchronized glyphs bracketing the
   * label.
   * @selector [data-glyph-position="left"] | [data-glyph-position="right"] | [data-glyph-position="both"]
   * @default "left"
   */
  glyphPosition?: TugProgressIndicatorGlyphPosition;

  /** Accessible label when no visible label is set. */
  "aria-label"?: string;
}

// ---------------------------------------------------------------------------
// Glyph dispatch
// ---------------------------------------------------------------------------

interface GlyphProps {
  variant: TugProgressIndicatorVariant;
  state: TugProgressIndicatorState;
  shape: TugProgressIndicatorShape;
  disabled: boolean;
  value?: number;
  max: number;
  size: number;
}

// Shape reaches the pulsing dot only. The other variants have no long form —
// a bar-shaped pie is not a thing — and they ignore the axis rather than
// approximate it.
function renderGlyph({ variant, state, shape, disabled, value, max, size }: GlyphProps): React.ReactElement {
  switch (variant) {
    case "ring":
      return <TugProgressRing value={value} max={max} size={size} state={state} disabled={disabled} />;
    case "bar":
      return <TugProgressBar value={value} max={max} size={size} state={state} disabled={disabled} />;
    case "pie":
      return <TugProgressPie value={value} max={max} size={size} state={state} disabled={disabled} />;
    case "spinner":
      return <TugProgressSpinner size={size} state={state} disabled={disabled} />;
    case "pulsing-dot":
      return (
        <TugProgressPulsingDot
          size={size}
          state={state}
          shape={shape}
          disabled={disabled}
        />
      );
    case "wave":
      return <TugProgressWave size={size} state={state} disabled={disabled} />;
  }
}

// ---------------------------------------------------------------------------
// TugProgressIndicator
// ---------------------------------------------------------------------------

export const TugProgressIndicator = React.forwardRef<HTMLSpanElement, TugProgressIndicatorProps>(
  function TugProgressIndicator(
    {
      variant = "ring",
      role,
      state,
      shape,
      disabled = false,
      value,
      max = 1,
      showValue = false,
      formatValue = defaultProgressValueLabel,
      size = 16,
      phase,
      phaseLabels,
      phaseVisual,
      label,
      labelEmphasis,
      labelPosition = "inline",
      labelAlign = "start",
      glyphPosition = "left",
      className,
      style,
      "aria-label": ariaLabel,
      ...rest
    },
    ref,
  ) {
    const boxDisabled = useTugBoxDisabled();
    const effectiveDisabled = disabled || boxDisabled;

    // Resolve state first (explicit > phaseVisual > default), then role
    // (explicit > phaseVisual > default-from-state). State implies role
    // by default — see `defaultRoleForState`.
    //
    // The default is `stopped`: motion is opt-in. A breathing glyph is a
    // claim that work is executing this instant, and nothing that declines
    // to say so is entitled to make it — so a caller that supplies neither
    // `state` nor a `phaseVisual` mapping gets stillness, and a phase a
    // `phaseVisual` forgot to handle settles rather than breathing forever.
    const phaseDerived =
      phase !== undefined && phaseVisual !== undefined ? phaseVisual(phase) : undefined;
    const effectiveState: TugProgressIndicatorState =
      state ?? phaseDerived?.state ?? "stopped";
    const effectiveRole: TugProgressIndicatorRole =
      role ?? phaseDerived?.role ?? defaultRoleForState(effectiveState);
    // Shape resolves on the same ladder and defaults to the circle, so every
    // caller that has never heard of the axis keeps the glyph it had.
    const effectiveShape: TugProgressIndicatorShape =
      shape ?? phaseDerived?.shape ?? "dot";

    // Visible label text: explicit label wins; otherwise the phase's entry.
    const visibleLabel =
      label !== undefined
        ? label
        : phase !== undefined && phaseLabels !== undefined
          ? phaseLabels[phase]
          : undefined;

    // A determinate variant (ring/bar/pie) with no positive progress yet
    // renders its INDETERMINATE motion (barber pole / rotation) rather than
    // a stalled 0% — a freshly-started bar should never sit at a literal 0.
    // It becomes determinate the moment `value` is positive. Indeterminate
    // variants (spinner/dot/wave) ignore `value` regardless.
    const effectiveValue =
      value !== undefined && value > 0 ? value : undefined;
    const isDeterminate = effectiveValue !== undefined;

    const ariaProps: Record<string, string | number | undefined> = {
      "aria-valuenow": isDeterminate
        ? Math.round((effectiveValue / max) * 100)
        : undefined,
      "aria-valuemin": isDeterminate ? 0 : undefined,
      "aria-valuemax": isDeterminate ? 100 : undefined,
    };

    const fillStyle = buildFillStyle(variant, effectiveRole);

    // No period jitter is applied here. The pulsing dot runs the nominal
    // period unless a caller pins one — see `dotDriftFor`, which only the
    // Lens's session rows use. An indicator cannot draw its own: the Z2 STATE
    // cell renders two of them flanking one label, and any per-indicator draw
    // has that pair breathing against each other.
    const rootStyle: React.CSSProperties = {
      ...fillStyle,
      ["--tugx-progress-indicator-size" as string]: `${size}px`,
      ...style,
    };

    const glyphProps: GlyphProps = {
      variant,
      state: effectiveState,
      shape: effectiveShape,
      disabled: effectiveDisabled,
      value: effectiveValue,
      max,
      size,
    };

    const leftGlyph = glyphPosition !== "right" ? renderGlyph(glyphProps) : null;
    const rightGlyph = glyphPosition !== "left" ? renderGlyph(glyphProps) : null;

    const showInlineLabel = labelPosition === "inline" && visibleLabel !== undefined;
    const isCenterAligned = labelAlign === "center";

    // Center-with-longest-phase: render every phaseLabels entry as a hidden
    // ghost in the same grid cell as the live label. The cell sizes to the
    // widest entry; the live label centers within it. CSS-only — no
    // measure-and-set effect [L06].
    const labelSlot = showInlineLabel ? (
      <span
        className={cn(
          "tug-progress-indicator-label",
          isCenterAligned && "tug-progress-indicator-label-center",
        )}
      >
        {isCenterAligned && phaseLabels !== undefined && (
          <>
            {Object.entries(phaseLabels).map(([key, text]) => (
              <span
                key={key}
                className="tug-progress-indicator-label-ghost"
                aria-hidden="true"
              >
                {text}
              </span>
            ))}
          </>
        )}
        {labelEmphasis !== undefined ? (
          <TugLabel
            emphasis={labelEmphasis}
            className="tug-progress-indicator-label-active"
          >
            {visibleLabel}
          </TugLabel>
        ) : (
          <span className="tug-progress-indicator-label-active">
            {visibleLabel}
          </span>
        )}
      </span>
    ) : null;

    // Determinate value readout. The `progressbar` role already exposes the
    // value via `aria-valuenow`, so the visible text is decorative
    // (`aria-hidden`) to avoid a double announcement. For the `bar` variant
    // the track flexes and this trails it on the same row [L06].
    //
    // Width-stabilized: a hidden ghost of the full-scale value (`max`, e.g.
    // "100%") reserves the slot's width so the readout — and therefore the
    // flexing bar — never re-layouts as the live value's digit count grows
    // (CSS-only, same grid-stack trick as the centered label) [L06].
    const valueText =
      showValue && effectiveValue !== undefined
        ? formatValue(effectiveValue, max)
        : undefined;
    // Readout slot. The ghost is ALWAYS present when `showValue` is set, so it
    // reserves a constant line-height — the row height (and thus a bar's
    // vertical position) never changes when the value appears. While
    // indeterminate (`data-empty`) the slot collapses to ZERO width (CSS), so
    // the bar still spans the full width with no trailing gap; once
    // determinate it takes the ghost's full-scale width, so the bar shrinks
    // from the right (left edge fixed) and digit growth (9% → 100%) never
    // re-sizes it.
    const valueSlot = showValue ? (
      <span
        className="tug-progress-indicator-value"
        aria-hidden="true"
        data-empty={valueText === undefined ? "true" : undefined}
      >
        <TugLabel
          size="sm"
          emphasis="calm"
          className="tug-progress-indicator-value-ghost"
        >
          {formatValue(max, max)}
        </TugLabel>
        {valueText !== undefined ? (
          <TugLabel
            size="sm"
            emphasis="calm"
            className="tug-progress-indicator-value-active"
          >
            {valueText}
          </TugLabel>
        ) : null}
      </span>
    ) : null;

    const root = (
      <span
        ref={ref}
        data-slot="tug-progress-indicator"
        data-variant={variant}
        data-role={effectiveRole}
        data-state={effectiveState}
        data-shape={effectiveShape === "dot" ? undefined : effectiveShape}
        data-disabled={effectiveDisabled || undefined}
        data-phase={phase}
        data-label-position={labelPosition}
        data-label-align={labelAlign}
        data-glyph-position={glyphPosition}
        role="progressbar"
        aria-label={ariaLabel ?? visibleLabel ?? phase}
        className={cn("tug-progress-indicator", className)}
        style={rootStyle}
        {...ariaProps}
        {...rest}
      >
        {leftGlyph && <span className="tug-progress-indicator-glyph">{leftGlyph}</span>}
        {labelSlot}
        {rightGlyph && <span className="tug-progress-indicator-glyph">{rightGlyph}</span>}
        {valueSlot}
      </span>
    );

    // Tooltip mode: wrap the bare root in a TugTooltip carrying the label
    // text. Suppressed when no label text is available.
    if (labelPosition === "tooltip" && visibleLabel !== undefined) {
      return (
        <TugTooltip content={visibleLabel} side="top">
          {root}
        </TugTooltip>
      );
    }
    return root;
  },
);
