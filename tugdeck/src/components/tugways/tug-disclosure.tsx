/**
 * TugDisclosure — the chevron that says which way a fold stands.
 *
 * A collapsed thing points right and an open one points down. Every fold in
 * the deck that draws its own twist — a JSON tree node, a search result's
 * file, a diff hunk's cue, a session picker group — drew the same pair of
 * glyphs from the same test, so this is that mark once. It is **controlled
 * and inert**: `expanded` says which glyph shows, and the press that moves
 * the fold belongs to the row, cue or line the mark sits in, because that is
 * the target the reader aims at and the element that already carries
 * `aria-expanded`. The mark is `aria-hidden` for the same reason — the state
 * is announced by its owner, not by a picture of it.
 *
 * Its colour is its owner's: the root takes `currentColor`, so a caller's
 * class on it (or on the owner) tints it the way the hand-drawn twists were.
 *
 * Laws: [L06] the glyph follows a prop and `data-expanded`, never state;
 * [L19] `.tsx`/`.css` pair, `data-slot`, `forwardRef`, `cn()`, `...rest`.
 *
 * @module components/tugways/tug-disclosure
 */

import "./tug-disclosure.css";

import React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/** Props for {@link TugDisclosure}. */
export interface TugDisclosureProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  /** Whether the fold this mark belongs to is open. */
  expanded: boolean;
  /** The glyph's size in px. Omitted, the icon's own default. */
  size?: number;
}

/** A right-or-down chevron for a fold whose press lives on its owner. */
export const TugDisclosure = React.forwardRef<HTMLSpanElement, TugDisclosureProps>(
  function TugDisclosure({ expanded, size, className, ...rest }, ref) {
    const Glyph = expanded ? ChevronDown : ChevronRight;
    return (
      <span
        ref={ref}
        data-slot="tug-disclosure"
        data-expanded={expanded ? "true" : "false"}
        aria-hidden="true"
        className={cn("tug-disclosure", className)}
        {...rest}
      >
        <Glyph size={size} aria-hidden />
      </span>
    );
  },
);
