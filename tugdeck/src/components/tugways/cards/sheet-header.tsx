/**
 * sheet-header — the read-only sheets' header strip and their notice.
 *
 * The hooks, skills and memory sheets head their body with one strip: a text
 * column (a summary line, a read-only note) and, at the trailing edge, the
 * sheet's actions. {@link SheetHeader} is the strip, {@link SheetHeaderText}
 * the column, {@link SheetHeaderSummary} its quiet summary line, and
 * {@link SheetHeaderActions} the trailing cluster. Passed as a
 * `TugSheet`'s `header`, the strip also carries the gap above the body.
 *
 * {@link SheetNotice} is the state a sheet shows in place of its content.
 * `layout="placeholder"` (the default) is a listing sheet's loading, empty
 * or error state, centred where the list would be; `layout="line"` is one
 * muted sentence in a sheet whose body is not a list (usage,
 * data visualization).
 *
 * Every part takes a `className`, so a sheet keeps its own class beside the
 * shared one for what is its own.
 *
 * Laws: [L06] appearance through CSS and `data-*` attributes; [L19] the file
 * pair.
 *
 * @module components/tugways/cards/sheet-header
 */

import "./sheet-header.css";

import React from "react";

import { cn } from "@/lib/utils";

/** Props for {@link SheetHeader}. */
export interface SheetHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * How the text lines up with the actions: `start` (default) tops them, for
   * a multi-line text column; `baseline` sits a one-line header on the
   * actions' baseline.
   */
  align?: "start" | "baseline";
  /**
   * The leading content — a {@link SheetHeaderText}, or a lone summary —
   * then any {@link SheetHeaderActions}.
   */
  children?: React.ReactNode;
}

/** A read-only sheet's header strip. */
export const SheetHeader = React.forwardRef<HTMLDivElement, SheetHeaderProps>(
  function SheetHeader({ align = "start", className, children, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={cn("sheet-header", className)}
        data-align={align === "start" ? undefined : align}
        {...rest}
      >
        {children}
      </div>
    );
  },
);

/** Props for {@link SheetHeaderText}. */
export interface SheetHeaderTextProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
}

/** The header's text column, its lines stacked. */
export const SheetHeaderText = React.forwardRef<HTMLDivElement, SheetHeaderTextProps>(
  function SheetHeaderText({ className, children, ...rest }, ref) {
    return (
      <div ref={ref} className={cn("sheet-header-text", className)} {...rest}>
        {children}
      </div>
    );
  },
);

/** Props for {@link SheetHeaderActions}. */
export interface SheetHeaderActionsProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
}

/** The header's trailing action cluster. */
export const SheetHeaderActions = React.forwardRef<HTMLDivElement, SheetHeaderActionsProps>(
  function SheetHeaderActions({ className, children, ...rest }, ref) {
    return (
      <div ref={ref} className={cn("sheet-header-actions", className)} {...rest}>
        {children}
      </div>
    );
  },
);

/** Props for {@link SheetHeaderSummary}. */
export interface SheetHeaderSummaryProps extends React.HTMLAttributes<HTMLSpanElement> {
  children?: React.ReactNode;
}

/** The header's quiet summary line. */
export const SheetHeaderSummary = React.forwardRef<HTMLSpanElement, SheetHeaderSummaryProps>(
  function SheetHeaderSummary({ className, children, ...rest }, ref) {
    return (
      <span ref={ref} className={cn("sheet-header-summary", className)} {...rest}>
        {children}
      </span>
    );
  },
);

/** Props for {@link SheetNotice}. */
export interface SheetNoticeProps extends React.HTMLAttributes<HTMLElement> {
  /** `placeholder` (default) stands in for a list; `line` is one sentence. */
  layout?: "placeholder" | "line";
  /** The element: a `p` (default) for a sentence, a `div` for composed content. */
  as?: "p" | "div";
  children?: React.ReactNode;
}

/** The state a sheet shows in place of its content. */
export const SheetNotice = React.forwardRef<HTMLElement, SheetNoticeProps>(
  function SheetNotice({ layout = "placeholder", as = "p", className, children, ...rest }, ref) {
    const Element = as;
    return (
      <Element
        ref={ref as React.Ref<HTMLParagraphElement & HTMLDivElement>}
        className={cn("sheet-notice", className)}
        data-layout={layout}
        {...rest}
      >
        {children}
      </Element>
    );
  },
);
