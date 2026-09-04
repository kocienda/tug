/**
 * TugCommitAtom — a commit, wearing the one pill every surface names it in.
 *
 * A commit used to wear the generic read-only skin ({@link TugAtomRef}: glyph,
 * label, resting underline) that a `file_path` in a tool header wears, so a
 * transcript paragraph naming one arc, one file and four commits read as six
 * undifferentiated blue runs. The spike drew four looks against five surfaces
 * and the **Node pill** settled it: a commit is a named object like the arc and
 * the session standing beside it, and it wears their box. Rail, Slab and Ink
 * are retired — the design-decision entry records them so they are not
 * re-proposed.
 *
 * **The enclosure is borrowed, not authored.** This component sets no box, no
 * corner, no border, no padding and no state colour of its own: it wears
 * `tug-session-identity` at `data-tier="chip"`, exactly as `ArcSigil atom`
 * does, so the pill's numbers arrive from `tug-session-identity.css`'s settled
 * skin through the same selectors a session citation is reached by. That is
 * what makes the three pills siblings by construction rather than by three sets
 * of numbers kept equal by hand — `data-interactive`'s hover and
 * `data-missing`'s dashed shape come along for free, and retuning the skin
 * retunes all three. [L20]
 *
 * **The mark is a static ring.** A session's dot carries a phase and pulses; a
 * commit has no phase and never will, so its node is a plain ring at the
 * register's own dot diameter (`--tugx-atom-dot-size`), drawn in the ink the
 * pill already sets. It publishes no `atomPillMarkVars` for the same reason:
 * that cap bounds a pulse's reach inside the enclosure, and there is no pulse
 * here to bound.
 *
 * **The face is the SURFACE's, not the atom's.** The identity pill pins sans
 * because a *name* has a face; a hash has none. So this mount reverses that one
 * declaration and inherits instead — proportional in a transcript paragraph, an
 * Overview post and a receipt header, monospace in the History shade's mono
 * rows, reading as the ink around it does. `tabular-nums` on the hash is what
 * survives the change and matters more in proportional type: it keeps eight hex
 * characters from being eight different widths, so a column of shas still lines
 * up.
 *
 * **The baseline is the label's**, by the strut the borrowed skin already
 * carries — a zero-width `::before` in the pill's own face, centred with the
 * label, so the container offers the line the baseline a reader is actually
 * looking at. No `vertical-align` goes with it, here or on any host: a length
 * would be a correction on top of a lie.
 *
 * **The pill claims no gesture.** It renders presentationally and owns no
 * pointer handler, no `href` and no `title` — the host owns those, because a
 * commit is a copy target rather than a link and its hover is the entity tip in
 * a `TugTooltip`. `CommitShaText` and the Overview's wrapper span are where
 * those live.
 *
 * Laws: [L06] appearance is CSS and inherited custom properties, never React
 *       state; [L15] no hex — the pill authors no rest colour and the label's
 *       quieted word takes a theme token; [L19] `.tsx`/`.css` pair with a
 *       `data-slot`; [L20] compose — the enclosure is `ArcSigil`'s borrowing
 *       rather than a third pill.
 *
 * @module components/tugways/tug-commit-atom
 */

import "./tug-commit-atom.css";

import React from "react";

import {
  DEFAULT_ATOM_REGISTER,
  atomRegisterVars,
  type AtomRegister,
} from "@/lib/atom-register";
import { COMMIT_LABEL_LENGTH } from "@/lib/commit-format";

/** The `data-slot` every surface's copy answers to. One selector, everywhere. */
export const COMMIT_ATOM_SLOT = "tug-commit-atom";

/** The word the label leads with — scaffolding for the hash, not part of it. */
const COMMIT_LABEL_WORD = "commit:";

export interface TugCommitAtomProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  /** The commit's sha. Abbreviated to {@link COMMIT_LABEL_LENGTH} for display. */
  sha: string;
  /**
   * The hash run's content, when the surface paints those characters itself
   * rather than merely printing them — a History filter's `<mark>`s over the
   * ones it matched.
   *
   * It replaces the HASH and nothing else. The word and the enclosure are the
   * mark's own and a filter has no business decorating either: a match is
   * against the address, and eight characters is what the reader searched for.
   */
  labelContent?: React.ReactNode;
  /** Which surface the atom stands on. @default "prose" */
  register?: AtomRegister;
  /**
   * The host does something when this is clicked, so the pill takes the skin's
   * pointer cursor.
   *
   * The cursor and nothing else. The hover border move is every commit pill's,
   * authored on the atom rather than gated on this flag, because a mark that
   * did not answer the pointer at all would be the one entity in a History row
   * that went on looking the same as the pointer crossed it. What this flag
   * decides is the PROMISE: a sha in a transcript sentence or a receipt header
   * is a copy target with no navigation to offer, while the Overview's ref
   * opens a diff.
   */
  interactive?: boolean;
  /**
   * The sha resolved to nothing. The pill keeps its SHAPE — a reader still
   * needs to know what kind of thing failed — dashes its border and mutes its
   * ink, through the borrowed skin's own `data-missing` rules.
   */
  missing?: boolean;
  /**
   * Print the leading `commit:` word. @default true
   *
   * **This is not the spike's retired word-off axis**, which asked whether the
   * mark should carry the word at all and was settled: it does. This is the
   * narrower, older rule about PROSE — a mention whose sentence already said
   * the word right before it (`Commit ` `86af912c`) yields, because two of the
   * same word in a row is a stutter the reader pays for. Only
   * `useCommitTipPortals` passes it, and only after reading the run's own
   * neighbours; every placed mount carries the word, because a placed atom has
   * no sentence around it to supply one.
   */
  word?: boolean;
}

/**
 * A commit's placed skin.
 *
 * `aria-hidden` on the node because it is a drawing: the label already says
 * `commit:` in words, and a mark announced twice is worse than one not
 * announced at all.
 *
 * A `forwardRef` that spreads what it was not given, because the mark's hover
 * is a `TugTooltip` and Radix's `asChild` trigger reaches its child by cloning
 * a ref and its own pointer handlers onto it. A component that swallowed those
 * would render a pill nothing could hover — which is exactly what happened the
 * first time this was written, on the one surface (a transcript mention) whose
 * whole point is the bubble.
 */
export const TugCommitAtom = React.forwardRef<
  HTMLSpanElement,
  TugCommitAtomProps
>(function TugCommitAtom(
  {
    sha,
    labelContent,
    register = DEFAULT_ATOM_REGISTER,
    interactive = false,
    missing = false,
    word = true,
    className,
    style,
    ...rest
  },
  ref,
) {
  return (
    <span
      {...rest}
      ref={ref}
      className={
        className === undefined
          ? "tug-session-identity tug-commit-atom"
          : `tug-session-identity tug-commit-atom ${className}`
      }
      data-slot={COMMIT_ATOM_SLOT}
      data-tier="chip"
      data-register={register}
      data-interactive={interactive ? "true" : undefined}
      data-missing={missing ? "true" : undefined}
      style={{ ...(atomRegisterVars(register) as React.CSSProperties), ...style }}
    >
      <span className="tug-commit-atom-node" aria-hidden="true" />
      <span className="tug-commit-atom-label">
        {word ? (
          <span className="tug-commit-atom-word">{COMMIT_LABEL_WORD}</span>
        ) : null}
        <span className="tug-commit-atom-hash">
          {labelContent ?? sha.slice(0, COMMIT_LABEL_LENGTH)}
        </span>
      </span>
    </span>
  );
});
