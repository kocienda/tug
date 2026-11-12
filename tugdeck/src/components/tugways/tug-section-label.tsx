/**
 * `TugSectionLabel` — the eyebrow that names a bucket of rows.
 *
 * A small tracked-out label at the left, a hairline running through the rest of
 * the line, the bucket's name ahead of a dimmer qualifier. It is deliberately
 * quiet: no bucket carries hue. Colour here would have to mean something, and
 * the four things it could have meant — ownership, urgency, species, staleness
 * — are all said in words a line below. The headers are spacing with words in
 * it; the rows carry the surface.
 *
 * **A label is a name and an optional qualifier**, not one string with an em
 * arc in it. The two paint differently, so "unattributed" reads before "no
 * session claims these", and a renderer cannot do that to a flat string without
 * splitting on punctuation — a parser standing where a data shape belongs. The
 * em arc between them is authored here and nowhere else: it is a separator
 * this component draws between two facts, not a character in either.
 *
 * **Why it is a component and not two stylesheets.** The Changes shade's file
 * buckets and its arc lane are separate components that must produce the same
 * header — a reader scanning the shade should not be able to tell that two
 * things drew them. They used to do it by each spelling the same five
 * declarations, with a comment conceding the duplication was cheaper than a
 * cross-import. That holds at two users and stops holding at the third, which
 * is where the rail and the arc picker were about to arrive.
 *
 * Laws: [L19] file pair, docblock, `data-slot`; [L20] owns `--tugx-section-label-*`
 * and composes no other component's tokens.
 *
 * @module components/tugways/tug-section-label
 */

import "./tug-section-label.css";

import React from "react";

import { cn } from "@/lib/utils";

/**
 * A section header: the bucket's name, and an optional qualifier that says
 * something about it.
 */
export interface SectionLabel {
  name: string;
  qualifier?: string;
}

export interface TugSectionLabelProps extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /** The section's name and qualifier. */
  label: SectionLabel;
  /**
   * The `data-slot` this header answers to. Defaulted rather than fixed
   * because a host's buckets are addressable individually — a test reaching
   * for the arc lane's fronted header wants that one, not "a section label".
   */
  "data-slot"?: string;
}

export const TugSectionLabel = React.forwardRef<HTMLDivElement, TugSectionLabelProps>(
  function TugSectionLabel(
    { label, "data-slot": dataSlot = "tug-section-label", className, ...rest },
    ref,
  ) {
    return (
      <div {...rest} ref={ref} className={cn("tug-section-label", className)} data-slot={dataSlot}>
        <span className="tug-section-label-text">
          <span className="tug-section-label-name">{label.name}</span>
          {label.qualifier !== undefined ? (
            <>
              <span className="tug-section-label-arc" aria-hidden="true">
                {" — "}
              </span>
              <span className="tug-section-label-qualifier">{label.qualifier}</span>
            </>
          ) : null}
        </span>
      </div>
    );
  },
);
