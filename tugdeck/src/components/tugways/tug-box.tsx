/**
 * TugBox — grouping container with optional visual chrome and disabled cascade.
 *
 * Renders a <fieldset> element for grouping variants (plain, bordered, filled)
 * and an <hr> for the separator variant. A disabled prop cascades to all
 * controls inside via TugBoxContext — the cascade is recursive: a disabled
 * outer box disables all inner boxes and their controls.
 *
 * Variants: plain (invisible grouping), bordered (border, no fill),
 * filled (border + sunken background), group (a bordered settings group,
 * its legend painted on the border, its body a left-packed column),
 * separator (horizontal rule).
 * Label position: legend (in border line) or above (heading above children).
 * Inset padding scales with size: sm/md/lg.
 *
 * **Layout contract.** Children render inside a `.tug-box-body` div, and
 * that div is the only layout surface — consumers style
 * `.their-class > .tug-box-body` for flex/grid/gap, never the fieldset
 * itself. WebKit's special-cased legend layout disagrees between layout
 * passes about whether the legend is a flex item, so a fieldset-level
 * `display: flex` makes the box's height change by one `gap` on any style
 * recalc (theme switch, HMR) — a visible hop. A DEV-only guard warns when a
 * fieldset computes to flex/grid.
 *
 * Laws: [L06] appearance via CSS, [L16] pairings declared,
 *       [L19] component authoring guide
 */

import "./tug-box.css";
import type { TugSize } from "./tug-vocabulary";

import React from "react";
import { cn } from "@/lib/utils";
import { TugBoxContext, useTugBoxDisabled } from "./internal/tug-box-context";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";

// ---- Types ----

/** TugBox size names — controls label font size and inset padding scale. */
export type TugBoxSize = Extract<TugSize, "sm" | "md" | "lg">;

/** TugBox border-radius options. */
export type TugBoxRounded = "none" | "sm" | "md" | "lg" | "full";

const ROUNDED_MAP: Record<TugBoxRounded, string> = {
  none: "0",
  sm: "0.25rem",   // 4px
  md: "0.375rem",  // 6px
  lg: "0.5rem",    // 8px
  full: "9999px",  // pill
};

/**
 * TugBox visual variant.
 * @selector .tug-box-plain | .tug-box-bordered | .tug-box-filled | .tug-box-group | .tug-box-separator
 */
export type TugBoxVariant = "plain" | "bordered" | "filled" | "group" | "separator";

/**
 * Where the label appears.
 * @selector .tug-box-label-legend | .tug-box-label-above
 */
export type TugBoxLabelPosition = "legend" | "above";

/** TugBox user-resizable direction. */
export type TugBoxResize = "horizontal" | "vertical" | "both";

/** TugBox props. */
export interface TugBoxProps
  extends Omit<React.FieldsetHTMLAttributes<HTMLFieldSetElement>, "disabled"> {
  /** Visible label text. Rendered as <legend> or <span> depending on labelPosition. */
  label?: string;
  /**
   * Where the label appears relative to the box.
   * - "legend": in the border line (standard fieldset/legend).
   * - "above": above the box content as a standalone heading.
   * @selector .tug-box-label-legend | .tug-box-label-above
   * @default "legend"
   */
  labelPosition?: TugBoxLabelPosition;
  /**
   * Visual variant controlling border and background.
   * - "plain": invisible — functional grouping only, no visual chrome.
   * - "bordered": visible border, no background fill.
   * - "filled": visible border + subtle background fill.
   * - "group": a bordered settings group — the legend is painted over the
   *   top border on `--tugx-box-legend-bg`, a generous inset clears it, and
   *   the body is a left-packed column. Always labels as a legend.
   * - "separator": renders as a horizontal rule (no children, no label).
   * @selector .tug-box-plain | .tug-box-bordered | .tug-box-filled | .tug-box-group | .tug-box-separator
   * @default "plain"
   */
  variant?: TugBoxVariant;
  /**
   * Internal padding between the border and children.
   * When true, applies size-appropriate padding. When false, no padding.
   * Defaults to true for bordered/filled, false for plain.
   * @selector .tug-box-inset
   */
  inset?: boolean;
  /**
   * Border radius for bordered/filled variants.
   * @default "lg"
   */
  rounded?: TugBoxRounded;
  /**
   * Disables all controls inside this box. Cascades recursively to nested TugBoxes.
   * @selector [disabled] | [data-disabled]
   * @default false
   */
  disabled?: boolean;
  /**
   * Visual size — controls label font size and inset padding scale.
   * @selector .tug-box-sm | .tug-box-md | .tug-box-lg
   * @default "md"
   */
  size?: TugBoxSize;
  /**
   * User-resizable direction. Requires bordered or filled variant.
   * Sets CSS resize and overflow: hidden on the fieldset.
   * When omitted, the box is not resizable.
   * @selector .tug-box-resize-horizontal | .tug-box-resize-vertical | .tug-box-resize-both
   */
  resize?: TugBoxResize;
  /** Box content. Not used when variant is "separator". */
  children?: React.ReactNode;
}

// ---- TugBox ----

/**
 * DEV-only guard: warn (once per class list) when a consumer makes the
 * fieldset itself a flex/grid container — the exact authoring mistake the
 * `.tug-box-body` wrapper exists to prevent (see the render comment). The
 * production build compiles this to a no-op.
 */
const warnedFieldsetLayouts = new Set<string>();
function useFieldsetLayoutGuard(
  ref: React.RefObject<HTMLFieldSetElement | null>,
): void {
  React.useLayoutEffect(() => {
    if (!import.meta.env.DEV) return;
    const el = ref.current;
    if (el === null) return;
    const display = getComputedStyle(el).display;
    if (!/flex|grid/.test(display)) return;
    const key = el.className;
    if (warnedFieldsetLayouts.has(key)) return;
    warnedFieldsetLayouts.add(key);
    tugDevLogStore.warn(
      "tug-box",
      `TugBox fieldset has display:${display} (class "${key}"). ` +
        "Never lay out the fieldset — WebKit's legend layout is " +
        "pass-dependent and the box height will hop on style recalc. " +
        "Style `> .tug-box-body` instead.",
    );
  });
}

export const TugBox = React.forwardRef<HTMLFieldSetElement, TugBoxProps>(
  function TugBox(
    {
      label,
      labelPosition = "legend",
      variant = "plain",
      inset,
      rounded = "lg",
      disabled = false,
      size = "md",
      resize,
      className,
      style,
      children,
      ...rest
    },
    ref,
  ) {
    // Merge with parent TugBox disabled via context cascade.
    const parentDisabled = useTugBoxDisabled();
    const effectiveDisabled = disabled || parentDisabled;

    // Provide merged context to children so nested controls see the cascade.
    const ctxValue = React.useMemo(
      () => ({ disabled: effectiveDisabled }),
      [effectiveDisabled],
    );

    // Internal fieldset ref for the DEV layout guard, merged with the
    // forwarded ref so consumers keep theirs.
    const fieldsetRef = React.useRef<HTMLFieldSetElement | null>(null);
    const mergedRef = React.useCallback(
      (el: HTMLFieldSetElement | null) => {
        fieldsetRef.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref !== null) ref.current = el;
      },
      [ref],
    );
    useFieldsetLayoutGuard(fieldsetRef);

    // Separator variant — renders <hr>, no children, no label, no context.
    if (variant === "separator") {
      return (
        <hr
          data-slot="tug-box"
          className={cn("tug-box", "tug-box-separator", className)}
          {...(rest as React.HTMLAttributes<HTMLHRElement>)}
        />
      );
    }

    // Border radius and inset — only meaningful for the variants that draw a
    // border. Inset defaults to true for them, false for plain.
    const hasBorder = variant === "bordered" || variant === "filled" || variant === "group";
    const resolvedInset = inset ?? hasBorder;
    // A group always labels on its border.
    const resolvedLabelPosition = variant === "group" ? "legend" : labelPosition;
    const resolvedRadius = hasBorder ? ROUNDED_MAP[rounded] : undefined;

    return (
      <TugBoxContext.Provider value={ctxValue}>
        <fieldset
          ref={mergedRef}
          data-slot="tug-box"
          disabled={effectiveDisabled}
          data-disabled={effectiveDisabled || undefined}
          className={cn(
            "tug-box",
            `tug-box-${variant}`,
            `tug-box-${size}`,
            resolvedInset && "tug-box-inset",
            resize && `tug-box-resize-${resize}`,
            className,
          )}
          style={{ borderRadius: resolvedRadius, ...style }}
          {...rest}
        >
          {label && resolvedLabelPosition === "legend" && (
            <legend className="tug-box-legend">{label}</legend>
          )}
          {label && resolvedLabelPosition === "above" && (
            <span className="tug-box-label-above">{label}</span>
          )}
          {/* The body div is the ONLY layout surface for box content. The
              fieldset itself must never be a flex/grid container: WebKit's
              special-cased legend layout disagrees between layout passes
              about whether the legend is a flex item, so a fieldset-level
              `display: flex` + `gap` makes every box's height change by one
              gap on any style recalc (theme switch, HMR) — the sections
              visibly hop. Consumers style `.their-class > .tug-box-body`. */}
          <div className="tug-box-body" data-slot="tug-box-body">
            {children}
          </div>
        </fieldset>
      </TugBoxContext.Provider>
    );
  },
);
