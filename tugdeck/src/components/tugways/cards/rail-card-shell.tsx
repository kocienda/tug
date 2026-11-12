/**
 * rail-card-shell — the shell the Cards, Jots and Arcs cards stand in.
 *
 * Every rail card is one scroller at its root holding one in-flow content
 * column, a positioned wrap for its reorder caret, a toolbar for its filter
 * field, and a `None` line one row high. The rules live once, in
 * `rail-card-shell.css`; the `None` line is the library's `TugEmptyLine`.
 *
 * The toolbar is a component, because a card builds it from nothing. The
 * root, the content column and the list wrap are classes —
 * {@link RAIL_CARD_CLASS}, {@link RAIL_CARD_CONTENT_CLASS},
 * {@link RAIL_CARD_LIST_WRAP_CLASS} — that a card puts beside its own on
 * elements already carrying its refs, focus handling and test ids, so the
 * card keeps every attribute it had and only the restated rules go.
 *
 * Laws: [L06] appearance through CSS; [L19] the file pair.
 *
 * @module components/tugways/cards/rail-card-shell
 */

import "./rail-card-shell.css";

import React from "react";

import { cn } from "@/lib/utils";

/** The card root: the card's one scroller. */
export const RAIL_CARD_CLASS = "rail-card";
/** The content column inside the scroller. */
export const RAIL_CARD_CONTENT_CLASS = "rail-card-content";
/** The reorder caret's positioning context around the list. */
export const RAIL_CARD_LIST_WRAP_CLASS = "rail-card-list-wrap";

/** Props for {@link RailCardToolbar}. */
export interface RailCardToolbarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The filter field first, then any controls at its trailing end. */
  children?: React.ReactNode;
}

/** The rail card's toolbar: the filter field takes the width. */
export const RailCardToolbar = React.forwardRef<HTMLDivElement, RailCardToolbarProps>(
  function RailCardToolbar({ className, children, ...rest }, ref) {
    return (
      <div ref={ref} className={cn("rail-card-toolbar", className)} {...rest}>
        {children}
      </div>
    );
  },
);
