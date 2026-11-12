/**
 * TugSheetScaffold — fixed-header / scrolling-body / fixed-footer layout for a
 * sheet's content.
 *
 * A common sheet shape is a document panel with a pinned header, a scrolling
 * middle, and a pinned footer of actions (e.g. `/diff`: title row → file list
 * → Done). Getting that to behave inside a {@link TugSheet} — where the panel
 * is JS-clamped to the canvas height — needs a specific flex chain so the body
 * (not the whole panel) scrolls and the footer never slides off. Rather than
 * reproduce that chain per sheet, render a `TugSheetScaffold` as the sheet
 * content and you get it for free.
 *
 * How it works: the scaffold's CSS marks its host (`tug-sheet-content:has(
 * .tug-sheet-scaffold)`) as a clipping flex column and makes `.tug-sheet-body`
 * fill it, so the scaffold can be `flex: 1` with a `flex: 1; overflow-y: auto`
 * body between two `flex: 0` regions. The {@link TugSheet} canvas clamp (always
 * on) bounds the panel height; the scaffold turns that bound into "body
 * scrolls, header + footer pinned." No per-sheet layout CSS, no `height: 100%`.
 *
 * Pair with `displayWidth` (`xl` for a document column) and, if desired,
 * `resizable` on the `showSheet` call — all orthogonal `TugSheet` capabilities.
 *
 * Laws: [L06] appearance via CSS, [L19] authoring guide, [L20] composed
 *       children keep their own tokens.
 *
 * @module components/tugways/tug-sheet-scaffold
 */

import "./tug-sheet-scaffold.css";

import React from "react";

import { cn } from "@/lib/utils";

export interface TugSheetScaffoldProps extends React.ComponentPropsWithoutRef<"div"> {
  /** Pinned region above the scrolling body (e.g. a title + actions row). */
  header?: React.ReactNode;
  /** Pinned region below the scrolling body (e.g. a Done / Cancel row). */
  footer?: React.ReactNode;
  /** The scrolling body content. */
  children: React.ReactNode;
  /** Class on the scrollable body region. */
  bodyClassName?: string;
}

/**
 * Lay out a sheet's content as header / scrolling-body / footer. Render this
 * as the `content` of a {@link TugSheet}; the body scrolls and the header +
 * footer stay pinned within the canvas-clamped panel.
 */
export const TugSheetScaffold = React.forwardRef<HTMLDivElement, TugSheetScaffoldProps>(function TugSheetScaffold(
  { header, footer, children, className, bodyClassName, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={cn("tug-sheet-scaffold", className)} data-slot="tug-sheet-scaffold" {...rest}>
      {header !== undefined ? (
        <div className="tug-sheet-scaffold-header" data-slot="tug-sheet-scaffold-header">
          {header}
        </div>
      ) : null}
      <div
        className={cn("tug-sheet-scaffold-body", bodyClassName)}
        data-slot="tug-sheet-scaffold-body"
      >
        {children}
      </div>
      {footer !== undefined ? (
        <div className="tug-sheet-scaffold-footer" data-slot="tug-sheet-scaffold-footer">
          {footer}
        </div>
      ) : null}
    </div>
  );
});
