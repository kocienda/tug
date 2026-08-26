/**
 * TugDashAtom — a dash's name in the one skin every surface wears.
 *
 * The atom is `DashSigil atom`: the proportional session-atom pill, in the
 * rail (`2xs`) and reading (`sm`) sizes and no other. There is no mono
 * register and no title-size run — who is working the dash is the worker atom
 * standing beside this one, which every surface already shows, so the
 * typeface carries nothing.
 *
 * A poke wears a quiet kind-word after its atom. It is the only place the
 * word appears: a poke is an ordinary dash to every verb, and the word is for
 * the reader who wants to know why the track beside it has two cells.
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
  /** `reviewed` | `stale` | `never-reviewed` | null; only the paint-worthy states tint. */
  review?: string | null;
  size?: "2xs" | "sm";
  /** A poke: no documents, no arc. */
  poke?: boolean;
  /** The `data-slot` the surface names its copy by. */
  slot?: string;
  title?: string;
}

export function TugDashAtom({
  name,
  review = null,
  size = "2xs",
  poke = false,
  slot = "tug-dash-atom",
  title,
}: TugDashAtomProps): React.ReactElement {
  return (
    <span className="tug-dash-atom" data-slot="tug-dash-atom" data-size={size} data-poke={poke ? "true" : undefined}>
      <DashSigil name={name} review={review} slot={slot} atom atomSize={size} title={title} />
      {poke ? (
        <span className="tug-dash-atom-kind" data-slot="tug-dash-atom-kind">
          poke
        </span>
      ) : null}
    </span>
  );
}
