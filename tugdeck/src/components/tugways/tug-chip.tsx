/**
 * TugChip — a small labelled token, optionally removable.
 *
 * A chip names one thing that has been gathered — a staged piece of context,
 * a picked filter — and, when the gathering can be undone, carries its own ✕.
 * It wears the atom-chip look (the atom surface under a light Key wash, a soft
 * inset hairline, a 3px radius) so a gathered thing reads as the same kind of
 * object the composer's atoms are, while hosting the ✕ an SVG atom cannot.
 *
 * **Removing is an action, not a callback ([L11]).** Given a `removeAction`,
 * the ✕ is a `TugIconButton` that dispatches that action with the chip's
 * `value` to the parent responder; the surface that owns the gathered set
 * handles it. The ✕ refuses focus, as every icon button does, so removing a
 * chip never takes the key view away from the editor beside it.
 *
 * Laws: [L06] appearance in CSS; [L11] the ✕ dispatches through the chain;
 * [L19] `.tsx`/`.css` pair, `data-slot`, `forwardRef`, `cn()`, `...rest`.
 *
 * @module components/tugways/tug-chip
 */

import "./tug-chip.css";

import React from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { TugAction } from "./responder-chain";
import { TugIconButton } from "./tug-icon-button";

/** Props for {@link TugChip}. */
export interface TugChipProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  /** The chip's words. Elided to the chip's width. */
  children: React.ReactNode;
  /**
   * The action the ✕ dispatches. Omitted, the chip has no ✕.
   */
  removeAction?: TugAction;
  /** The payload the ✕ ships as the event's `value` — what to remove. */
  value?: unknown;
  /** The ✕'s accessible name, e.g. `Remove notes.md from the next message`. */
  removeLabel?: string;
}

/** A labelled chip; with a `removeAction`, a removable one. */
export const TugChip = React.forwardRef<HTMLSpanElement, TugChipProps>(
  function TugChip(
    { children, removeAction, value, removeLabel, className, ...rest },
    ref,
  ) {
    return (
      <span
        ref={ref}
        data-slot="tug-chip"
        className={cn("tug-chip", className)}
        {...rest}
      >
        <span className="tug-chip-label">{children}</span>
        {removeAction !== undefined ? (
          <TugIconButton
            className="tug-chip-remove"
            size="2xs"
            aria-label={removeLabel ?? "Remove"}
            title="Remove"
            icon={<X size={11} strokeWidth={2} aria-hidden />}
            action={removeAction}
            value={value}
          />
        ) : null}
      </span>
    );
  },
);
