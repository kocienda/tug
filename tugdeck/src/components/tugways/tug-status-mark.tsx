/**
 * `TugStatusMark` — the letter that says what happened to a file.
 *
 * Green **N** (new), yellow **M** (changed), red **D** (deleted) — a colored
 * single letter rather than a glyph, because at row size a letter reads and a
 * lucide file-icon does not ([D118]). Three letters cover every state any
 * surface here surfaces; the mapping from whatever vocabulary arrived at the
 * door lives in {@link statusMark} and nowhere else.
 *
 * **One element, every surface.** The Changes shade's file rows, the `/commit`
 * receipt, and a commit's hover roster all render this, so a mark cannot be
 * one width here and another tone there. Before this component the hover
 * painted its own `A`/`M`/`D`/`R` in its own four tones beside a file row
 * spelling the same commit `N`/`M`/`D` in three — the same file, two
 * alphabets, two inches apart.
 *
 * **Decorative by construction.** The letter is `aria-hidden`: it is a second
 * reading of a status the row already states in its provenance text and its
 * title, and a screen reader hearing "M" learns nothing it was not told.
 *
 * Laws: [L19] component authoring guide
 *
 * @module components/tugways/tug-status-mark
 */

import "./tug-status-mark.css";

import React from "react";

import { statusMark } from "@/lib/commit-format";
import { cn } from "@/lib/utils";

export interface TugStatusMarkProps extends Omit<React.ComponentPropsWithoutRef<"span">, "children"> {
  /**
   * The file's status in any vocabulary — a word (`modified`), a porcelain
   * code (`??`, ` M`), or a bare letter. Resolved by {@link statusMark}.
   */
  status: string;
}

export const TugStatusMark = React.forwardRef<HTMLSpanElement, TugStatusMarkProps>(
  function TugStatusMark({ status, className, ...rest }, ref) {
    const mark = statusMark(status);
    return (
      <span
        ref={ref}
        className={cn("tug-status-mark", className)}
        data-slot="tug-status-mark"
        {...rest}
        data-mark={mark}
        aria-hidden="true"
      >
        {mark}
      </span>
    );
  },
);
