/**
 * TugPath — a file path that truncates in the MIDDLE.
 *
 * A path's two informative ends are its root and its filename, and end
 * truncation destroys the more informative one: `/Users/kocienda/Mounts/u/src/
 * tugtool/tests/app-test/at0391-open-diff-neighbor-slot.te…` names a directory
 * chain the reader already knows and withholds the one word they were looking
 * for. This renders the path as two runs — a head that shrinks and ellipsizes
 * from its trailing edge, and a tail that stays — so the same path collapses as
 * `/Users/kocienda/Moun…/at0391-open-diff-neighbor-slot.test.ts`.
 *
 * Pure CSS, no measurement: two flex children, the head absorbing the shrink.
 * The tail shrinks only once the head has nothing left to give, so a filename
 * wider than its box still clips rather than overflowing.
 *
 * It carries **no type of its own** — no family, size, weight, or color. A path
 * is rendered by chrome at chrome's size and by a transcript block in the
 * block's mono face, and a primitive that decided that would be wrong at one of
 * them. The mechanism is what is shared; the voice belongs to the mount.
 *
 * Laws: [L06] appearance via CSS/DOM, never React state, [L16] pairings
 *       declared (none — this component sets no color), [L19] component
 *       authoring guide, [L20] token sovereignty
 *
 * @module components/tugways/tug-path
 */

import React from "react";

import { cn } from "@/lib/utils";

import "./tug-path.css";

/**
 * Where a path splits into the run that shrinks and the run that stays.
 *
 * With no `tailLength`, the split is at the last separator, so the WHOLE
 * filename is pinned — the right rule for a surface whose reader is looking for
 * a name. A `tailLength` pins a fixed number of trailing characters instead,
 * which keeps the filename plus a little of its directory and gives a column of
 * paths a stable tail width.
 */
export function splitPath(
  path: string,
  tailLength?: number,
): { head: string; tail: string } {
  if (tailLength !== undefined) {
    return path.length > tailLength
      ? { head: path.slice(0, -tailLength), tail: path.slice(-tailLength) }
      : { head: "", tail: path };
  }
  const slash = path.lastIndexOf("/");
  return slash <= 0
    ? { head: "", tail: path }
    : { head: path.slice(0, slash), tail: path.slice(slash) };
}

/**
 * Whether the head run inside `trigger` is actually clipped — the predicate a
 * tooltip gates on, so a path showing whole never explains itself. The head is
 * what absorbs the truncation, so the path is truncated exactly when the head's
 * scroll width beats its client width. Measured fresh at each hover, because it
 * is a function of the box and the box moves.
 */
export function pathHeadClipped(trigger: Element): boolean {
  const head = trigger.querySelector(`.${TUG_PATH_HEAD_CLASS}`);
  if (head === null) return false;
  return head.scrollWidth > head.clientWidth;
}

/** The head run's class — exported so a mount can measure or tune it. */
export const TUG_PATH_HEAD_CLASS = "tug-path-head";

export interface TugPathProps
  extends Omit<React.ComponentPropsWithoutRef<"span">, "children"> {
  /** The path to render. */
  path: string;
  /**
   * Pin a fixed number of trailing characters instead of the filename. See
   * {@link splitPath}.
   */
  tailLength?: number;
}

/**
 * Render `path` with a middle ellipsis (see the module docstring).
 */
export const TugPath = React.forwardRef<HTMLSpanElement, TugPathProps>(
  function TugPath({ path, tailLength, className, ...rest }, ref) {
    const { head, tail } = splitPath(path, tailLength);
    return (
      <span
        ref={ref}
        data-slot="tug-path"
        className={cn("tug-path", className)}
        {...rest}
      >
        {/* Rendered even when empty: it is the flex child that absorbs the
            shrink, and a path shorter than its box has an empty head by
            definition rather than a missing one. */}
        <span className={TUG_PATH_HEAD_CLASS}>{head}</span>
        <span className="tug-path-tail">{tail}</span>
      </span>
    );
  },
);
