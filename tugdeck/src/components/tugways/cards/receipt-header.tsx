/**
 * receipt-header — the identity line of a landing receipt.
 *
 * The commit, push, join and discard receipts each put one line of identity
 * in their `BlockChrome` header's detail column: a sha pill, a route or an
 * arc name, and the receipt's own sentence. {@link ReceiptHeader} is the
 * line, in the receipt's prose face; {@link ReceiptHeaderText} is the
 * `<code>` run carrying the sentence, in that same face and the block's text
 * colour rather than the muted command tone a header's code would take.
 *
 * Both take a `className`, so a receipt keeps its own class beside the shared
 * one, and the text forwards its ref (the commit receipt measures its subject).
 *
 * Laws: [L06] appearance through CSS; [L19] the file pair.
 *
 * @module components/tugways/cards/receipt-header
 */

import "./receipt-header.css";

import React from "react";

import { cn } from "@/lib/utils";

/** Props for {@link ReceiptHeader}. */
export interface ReceiptHeaderProps extends React.HTMLAttributes<HTMLSpanElement> {
  children?: React.ReactNode;
}

/** A landing receipt's identity line. */
export const ReceiptHeader = React.forwardRef<HTMLSpanElement, ReceiptHeaderProps>(
  function ReceiptHeader({ className, children, ...rest }, ref) {
    return (
      <span ref={ref} className={cn("receipt-header", className)} {...rest}>
        {children}
      </span>
    );
  },
);

/** Props for {@link ReceiptHeaderText}. */
export interface ReceiptHeaderTextProps extends React.HTMLAttributes<HTMLElement> {
  children?: React.ReactNode;
}

/**
 * The receipt's sentence inside the identity line — a `<code>` that the
 * transcript's Find reads (`data-tugx-findable`).
 */
export const ReceiptHeaderText = React.forwardRef<HTMLElement, ReceiptHeaderTextProps>(
  function ReceiptHeaderText({ className, children, ...rest }, ref) {
    return (
      <code
        ref={ref}
        className={cn("receipt-header-text", className)}
        data-tugx-findable=""
        {...rest}
      >
        {children}
      </code>
    );
  },
);
