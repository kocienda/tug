/**
 * TugDashAtom — work on a worktree, named in the one skin every surface wears.
 *
 * The atom is `DashSigil atom`: the proportional session-atom pill, in the
 * rail (`2xs`) and reading (`sm`) sizes and no other. There is no mono
 * register and no title-size run — who is working the dash is the worker atom
 * standing beside this one, which every surface already shows, so the
 * typeface carries nothing.
 *
 * A cut is a dash to this atom. Both are work that left the base on a
 * worktree and come back through a join, and that is what the pill names; the
 * track beside it says how much of a life the work has.
 *
 * Laws: [L19] `.tsx`/`.css` pair, `data-slot`; [L20] composes `DashSigil`.
 *
 * @module components/tugways/tug-dash-atom
 */

import "./tug-dash-atom.css";

import React from "react";

import { DashSigil } from "./dash-sigil";

export interface TugDashAtomProps {
  name: string;
  size?: "2xs" | "sm";
  /** The `data-slot` the surface names its copy by. */
  slot?: string;
  title?: string;
}

export function TugDashAtom({
  name,
  size = "2xs",
  slot = "tug-dash-atom",
  title,
}: TugDashAtomProps): React.ReactElement {
  return (
    <span className="tug-dash-atom" data-slot="tug-dash-atom" data-size={size}>
      <DashSigil name={name} slot={slot} atom atomSize={size} title={title} />
    </span>
  );
}
