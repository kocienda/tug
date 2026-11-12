/**
 * TugArcAtom — work on a worktree, named in the one skin every surface wears.
 *
 * The atom is `ArcSigil atom`: the proportional session-atom pill, at the
 * register its surface is in and no other size. There is no mono register and
 * no title-size run — who is working the arc is the worker atom standing
 * beside this one, which every surface already shows, so the typeface carries
 * nothing.
 *
 * A cut is an arc to this atom. Both are work that left the base on a
 * worktree and come back through a join, and that is what the pill names; the
 * track beside it says how much of a life the work has.
 *
 * Laws: [L19] `.tsx`/`.css` pair, `data-slot`; [L20] composes `ArcSigil`.
 *
 * @module components/tugways/tug-arc-atom
 */

import "./tug-arc-atom.css";

import React from "react";

import { cn } from "@/lib/utils";

import { ArcSigil } from "./arc-sigil";

export interface TugArcAtomProps extends Omit<React.ComponentPropsWithoutRef<"span">, "children"> {
  /** The arc's name. */
  name: string;
  /** The name run's content, when the surface paints those characters itself. */
  nameContent?: React.ReactNode;
  /** The `data-slot` the surface names its copy by, on the sigil inside. */
  "data-slot"?: string;
  /** The sigil's tooltip title. */
  title?: string;
}

export const TugArcAtom = React.forwardRef<HTMLSpanElement, TugArcAtomProps>(function TugArcAtom(
  { name, nameContent, "data-slot": dataSlot = "tug-arc-atom", title, className, ...rest },
  ref,
) {
  return (
    <span {...rest} ref={ref} className={cn("tug-arc-atom", className)} data-slot="tug-arc-atom">
      <ArcSigil name={name} nameContent={nameContent} slot={dataSlot} atom title={title} />
    </span>
  );
});
