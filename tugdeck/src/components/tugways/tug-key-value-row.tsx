/**
 * TugKeyValueRow — one label and its value, laid on the parent's grid.
 *
 * The usage sheet's session stats, the masthead's telemetry panel and the
 * three telemetry popover legends each wrote the same row by hand: a label
 * cell, sometimes a middle cell (a dotted leader, a percent, or an empty
 * spacer that keeps the columns), the value cell, and in one case a trailing
 * action cell. The columns belong to the PARENT — a legend's three tracks, a
 * usage column's leader track — so the row draws no box of its own: its root
 * is `display: contents` and its cells fall straight onto the parent's grid.
 * A caller that wants the row to be its own grid (the telemetry panel) puts a
 * class on the root that says so; the primitive's rule is zero-specificity so
 * that class wins without a fight.
 *
 * The cells are rendered when their prop is given — `detail={null}` and
 * `trailing={null}` draw an empty cell, which is how a row keeps its place in
 * a grid whose other rows fill that track. An empty middle cell is decoration
 * and is hidden from assistive tech.
 *
 * Laws: [L06] appearance in CSS; [L19] `.tsx`/`.css` pair, `data-slot`,
 * `forwardRef`, `cn()`, `...rest`; [L20] no tokens of its own — each caller's
 * classes on the cells carry the ink.
 *
 * @module components/tugways/tug-key-value-row
 */

import "./tug-key-value-row.css";

import React from "react";

import { cn } from "@/lib/utils";

/** Props for {@link TugKeyValueRow}. */
export interface TugKeyValueRowProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  /** The key. */
  label: React.ReactNode;
  /** The value. */
  children: React.ReactNode;
  /** A middle cell; `null` draws an empty one that holds its track. */
  detail?: React.ReactNode;
  /** A trailing cell; `null` draws an empty one that holds its track. */
  trailing?: React.ReactNode;
  /** Classes for the label cell. */
  labelClassName?: string;
  /** Classes for the middle cell. */
  detailClassName?: string;
  /** Classes for the value cell. */
  valueClassName?: string;
  /** Classes for the trailing cell. */
  trailingClassName?: string;
}

/** A label/value row whose cells sit on the parent's grid. */
export const TugKeyValueRow = React.forwardRef<HTMLDivElement, TugKeyValueRowProps>(
  function TugKeyValueRow(
    {
      label,
      children,
      detail,
      trailing,
      labelClassName,
      detailClassName,
      valueClassName,
      trailingClassName,
      className,
      ...rest
    },
    ref,
  ) {
    return (
      <div
        ref={ref}
        data-slot="tug-key-value-row"
        className={cn("tug-key-value-row", className)}
        {...rest}
      >
        <span className={cn("tug-key-value-row-label", labelClassName)}>{label}</span>
        {detail !== undefined ? (
          <span
            className={cn("tug-key-value-row-detail", detailClassName)}
            aria-hidden={detail === null ? true : undefined}
          >
            {detail}
          </span>
        ) : null}
        <span className={cn("tug-key-value-row-value", valueClassName)}>{children}</span>
        {trailing !== undefined ? (
          <span className={cn("tug-key-value-row-trailing", trailingClassName)}>
            {trailing}
          </span>
        ) : null}
      </div>
    );
  },
);
