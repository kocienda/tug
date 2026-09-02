/**
 * TugArcAtom — work on a worktree, named in the one skin every surface wears.
 *
 * The atom is `ArcSigil atom`: the proportional session-atom pill, at the
 * register its surface is in and no other size. There is no mono register and
 * no title-size run — who is working the arc is the worker atom standing
 * beside this one, which every surface already shows, so the typeface carries
 * nothing.
 *
 * A cut is a dash to this atom. Both are work that left the base on a
 * worktree and come back through a join, and that is what the pill names; the
 * track beside it says how much of a life the work has.
 *
 * Laws: [L19] `.tsx`/`.css` pair, `data-slot`; [L20] composes `ArcSigil`.
 *
 * @module components/tugways/tug-arc-atom
 */

import "./tug-arc-atom.css";

import React from "react";

import { ArcSigil } from "./arc-sigil";
import { DEFAULT_ATOM_REGISTER, type AtomRegister } from "@/lib/atom-register";

export interface TugArcAtomProps {
  name: string;
  /** The name run's content, when the surface paints those characters itself. */
  nameContent?: React.ReactNode;
  /** Which surface the atom stands on. @default "prose" */
  register?: AtomRegister;
  /** The `data-slot` the surface names its copy by. */
  slot?: string;
  title?: string;
}

export function TugArcAtom({
  name,
  nameContent,
  register = DEFAULT_ATOM_REGISTER,
  slot = "tug-dash-atom",
  title,
}: TugArcAtomProps): React.ReactElement {
  return (
    <span className="tug-dash-atom" data-slot="tug-dash-atom" data-register={register}>
      <ArcSigil
        name={name}
        nameContent={nameContent}
        slot={slot}
        atom
        atomRegister={register}
        title={title}
      />
    </span>
  );
}
