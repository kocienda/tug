/**
 * The arc fold's one row.
 *
 * Every line the Changes shade's arc fold draws — a document, a conflict path,
 * a rung, a changed file's directory, a round's subject — is this row. It was
 * three sections' worth of lookalikes before, each with its own type scale and
 * its own spacing, which is how a directory row came to set its subordinate
 * fact larger than the path it qualified. One row means one height and one
 * size, and neither can drift back ([B01]).
 *
 * The composition is the commit receipt's own: `TugListRow` in
 * `variant="flush" density="compact" mono`, which the primitive resolves to a
 * 1px block padding over the monospace content column. A 2ch leading cell
 * holds a glyph or an ordinal, so the content column starts where a
 * `TugStatusMark` would put it.
 *
 * The row is **presentational**, exactly as `TugListRow` is: a row that is a
 * gesture's target carries `role` / `tabIndex` / `onClick` / `onKeyDown` on
 * its own wrapper, and says `hit` here only to earn the pointer and the
 * hover wash.
 *
 * Laws: [L02] every value arrives as a prop from the caller's store read, and
 * nothing here subscribes; [L06] tone and hover paint through `data-*` and
 * CSS, never React state; [L19] the row pairs with
 * `session-changes-arc-fold.css`, which it imports; [L20] the one token it
 * sets — `--tugx-list-row-flush-hover-bg` — is one `TugListRow` declares for
 * its consumers, not a reach into a composed component's private family.
 *
 * @module components/tugways/cards/session-changes/session-changes-arc-fold-row
 */

import "./session-changes-arc-fold.css";

import React from "react";

import { TugListRow } from "@/components/tugways/tug-list-row";

/** The tone arms `ArcFoldCell` paints, matching the fold's two readings. */
export type ArcFoldCellTone = "muted" | "danger";

export interface ArcFoldCellProps {
  /** A glyph or an ordinal. Empty is a legitimate cell — it holds the column. */
  children?: React.ReactNode;
  /** Muted for a structural glyph, danger for a conflict. */
  tone?: ArcFoldCellTone | undefined;
}

/**
 * The 2ch leading cell — `TugStatusMark`'s own box, holding a glyph or an
 * ordinal so the content column starts where a status mark would start it.
 */
export function ArcFoldCell({ children, tone }: ArcFoldCellProps): React.ReactElement {
  return (
    <span className="arc-fold-cell" data-slot="arc-fold-cell" data-tone={tone}>
      {children}
    </span>
  );
}

/**
 * The row wrapper's own props. `data-*` attributes are spelled out because a
 * plain `ComponentPropsWithoutRef<"div">` accepts none in an object literal,
 * and every fold row carries at least a `data-slot`.
 */
export type ArcFoldRowWrapperProps = React.ComponentPropsWithoutRef<"div"> & {
  [key: `data-${string}`]: string | undefined;
};

export interface ArcFoldRowProps {
  /** The leading cell — an {@link ArcFoldCell}, or nothing. */
  leading?: React.ReactNode;
  /** The trailing cluster — facts, a pop-out, a fold cue. */
  trailing?: React.ReactNode;
  /** The content column: a path, prose, a run of both. */
  children: React.ReactNode;
  /**
   * True when the whole row is a gesture's target — an open, a fold. It earns
   * the pointer and the hover wash; the gesture itself is the caller's, and
   * rides `wrapperProps`.
   */
  hit?: boolean | undefined;
  /**
   * Props for the row's own wrapper — `role`, `tabIndex`, `onClick`,
   * `onKeyDown`, `data-slot`, `aria-label`. `TugListRow` is presentational and
   * owns no activation, so a pressable row carries its own here.
   */
  wrapperProps?: ArcFoldRowWrapperProps | undefined;
}

/**
 * One row of the arc fold. See the module docblock for why there is only one.
 */
export function ArcFoldRow({
  leading,
  trailing,
  children,
  hit = false,
  wrapperProps,
}: ArcFoldRowProps): React.ReactElement {
  const { className: wrapperClassName, ...rest } = wrapperProps ?? {};
  const classes = ["arc-fold-row"];
  if (hit) classes.push("arc-fold-row-hit");
  if (wrapperClassName !== undefined) classes.push(wrapperClassName);
  return (
    <div className={classes.join(" ")} {...rest}>
      <TugListRow
        variant="flush"
        density="compact"
        mono
        leading={leading}
        trailing={
          trailing !== undefined ? (
            <span className="arc-fold-trailing">{trailing}</span>
          ) : undefined
        }
      >
        <span className="arc-fold-line">{children}</span>
      </TugListRow>
    </div>
  );
}
