/**
 * TugEmptyLine — the one line a list shows when it has nothing to show.
 *
 * A list with no rows, or a filter that hid every row, says so in one quiet
 * line at the height of the row it stands in for — `None`, `No matches` — so
 * an empty list reads as one row's worth of nothing rather than a taller box,
 * and every list that says it reads the same. The Cards, Jots, Arcs and
 * Overview cards all draw this line.
 *
 * The words are the caller's, and so is any `role="status"`: a line that
 * replaces results a reader asked for is news, and one a card shows at rest
 * is not.
 *
 * Laws: [L06] appearance in CSS; [L19] `.tsx`/`.css` pair, `data-slot`,
 * `forwardRef`, `cn()`, `...rest`.
 *
 * @module components/tugways/tug-empty-line
 */

import "./tug-empty-line.css";

import React from "react";

import { cn } from "@/lib/utils";

/** Props for {@link TugEmptyLine}. */
export interface TugEmptyLineProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The words — `None`, or `No matches` when a filter hides everything. */
  children?: React.ReactNode;
}

/** A list's empty line, one row high. */
export const TugEmptyLine = React.forwardRef<HTMLDivElement, TugEmptyLineProps>(
  function TugEmptyLine({ className, children, ...rest }, ref) {
    return (
      <div
        ref={ref}
        data-slot="tug-empty-line"
        className={cn("tug-empty-line", className)}
        {...rest}
      >
        {children}
      </div>
    );
  },
);
