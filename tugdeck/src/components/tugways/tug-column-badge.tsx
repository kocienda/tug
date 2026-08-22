/**
 * TugColumnBadge — where a card stands within the place it shares, in the slot
 * badge's footprint.
 *
 * A card's position on the deck is three coordinates, and the slot badge says
 * only the first. This badge says the other two, and it says them in two
 * deliberately different vocabularies:
 *
 *  - **A stack shows a NUMBER** — how many cards share the slot — over three
 *    flattened slices with the top one lit. The badge stands on a card you can
 *    see, and a visible card in a stack is by definition the top one, so a
 *    position there would always read the same and carry nothing. What the eye
 *    cannot get is how many are behind, so that is what the badge says.
 *  - **A split shows a LETTER** — this member's band, A being the topmost —
 *    over a three-rung ladder with the band's end of the run lit. Every band of
 *    a split is visible at once, so position is real information there and the
 *    badge's job is naming rather than revealing: a letter is an address to
 *    match against a Lens row.
 *
 * Number and letter therefore map categorically onto stack and split, which is
 * teachable in a sentence and can never be misread against a slot number.
 * **Letters are split-only vocabulary, on every surface.**
 *
 * The glyph names a REGION and the character names the position. Three rungs
 * say top / middle / bottom however deep the split runs, so every interior band
 * of a deep column lights the same middle rung while its letter stays exact.
 * That is the intended reading, and it is why the ladder is not drawn with one
 * rung per member — at this size a subdivided badge stops being legible at all.
 *
 * The badge is one character over quiet scenery: the character is set exactly
 * as `TugSlot` sets its number and the glyph sits behind it at reduced opacity,
 * with the lit element an accent **outline** rather than a fill and a stacked
 * canvas-colour `text-shadow` punching the character clear of the strokes. The
 * knockout colour is a knob, because it has to be whatever ground the badge
 * actually stands on.
 *
 * Presentational by construction: it renders a `<span>` and owns only the
 * drawing. The pane cluster's menu trigger and the Lens row compose it, and the
 * door behavior stays theirs.
 *
 * Laws: [L06] appearance via CSS and DOM attributes, never React state;
 *       [L15] token-driven ink; [L16] pairings declared; [L19] component
 *       authoring guide; [L20] token sovereignty — the ink is knobbed so a
 *       consumer re-pairs it to the surface it renders on rather than this
 *       file guessing.
 * Decisions: [D121] layout imposition.
 *
 * @module components/tugways/tug-column-badge
 */

import "./tug-column-badge.css";

import React from "react";

import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------------*/

/** Which kind of place the badge describes. */
export type TugColumnBadgeKind = "stack" | "split";

/** Which end of the glyph's run is lit — the region, not the ordinal. */
export type TugColumnBadgeLit = "top" | "middle" | "bottom";

/* ---------------------------------------------------------------------------
 * The two facts, as pure functions
 *
 * These ARE the rendered `data-` attributes, so they are the whole of the
 * badge's logic and the only part of it a unit test can reach.
 * ---------------------------------------------------------------------------*/

/**
 * The character the badge draws: a stack's member count, or a split band's
 * letter counting from A at the topmost band.
 */
export function columnBadgeCharacter(
  kind: TugColumnBadgeKind,
  count: number,
  index = 0,
): string {
  return kind === "stack" ? String(count) : String.fromCharCode(65 + index);
}

/**
 * Which element of the glyph is lit. A stack always lights its top slice — the
 * badge stands on the card that is the face of the stack. A split lights the
 * end of the ladder its band sits at, and the middle rung for everything
 * between.
 */
export function columnBadgeLit(
  kind: TugColumnBadgeKind,
  count: number,
  index = 0,
): TugColumnBadgeLit {
  if (kind === "stack") return "top";
  if (index <= 0) return "top";
  if (index >= count - 1) return "bottom";
  return "middle";
}

/* ---------------------------------------------------------------------------
 * TugColumnBadgeProps
 * ---------------------------------------------------------------------------*/

export interface TugColumnBadgeProps
  extends Omit<React.ComponentPropsWithoutRef<"span">, "children"> {
  /**
   * Which place this badge describes.
   * @selector [data-kind="stack"] | [data-kind="split"]
   */
  kind: TugColumnBadgeKind;
  /** How many panes share the place. Drawn as the character for a stack. */
  count: number;
  /**
   * This member's 0-based position, topmost first. Required for a split, where
   * it becomes the letter and the lit rung; ignored for a stack.
   * @default 0
   */
  index?: number;
}

/* ---------------------------------------------------------------------------
 * TugColumnBadge
 * ---------------------------------------------------------------------------*/

export const TugColumnBadge = React.forwardRef<HTMLSpanElement, TugColumnBadgeProps>(
  function TugColumnBadge({ kind, count, index = 0, className, ...rest }, ref) {
    const lit = columnBadgeLit(kind, count, index);

    return (
      <span
        ref={ref}
        data-slot="tug-column-badge"
        className={cn("tug-column-badge", className)}
        {...rest}
        /* AFTER the spread, for the reason `TugSlot` states: these two are the
           badge's own facts — what every test reads the arrangement from — and
           a wrapper composing behavior onto this element must not be able to
           overwrite them. */
        data-kind={kind}
        data-lit={lit}
      >
        {kind === "stack" ? <StackGlyph /> : <LadderGlyph lit={lit} />}
        <span className="tug-column-badge-character">
          {columnBadgeCharacter(kind, count, index)}
        </span>
      </span>
    );
  },
);

/* ---------------------------------------------------------------------------
 * StackGlyph
 * ---------------------------------------------------------------------------*/

/**
 * Three flattened diamond slices, deepest drawn first so the nearer ones
 * occlude. The fills are the badge's own ground colour and exist only for that
 * occlusion — selection is never a fill here.
 */
function StackGlyph(): React.ReactElement {
  const slices: ReadonlyArray<{ key: TugColumnBadgeLit; dy: number }> = [
    { key: "bottom", dy: 11 },
    { key: "middle", dy: 5.5 },
    { key: "top", dy: 0 },
  ];

  return (
    <svg
      className="tug-column-badge-glyph"
      viewBox="0 0 18 20"
      aria-hidden="true"
      focusable="false"
    >
      {slices.map(({ key, dy }) => (
        <polygon
          key={key}
          className="tug-column-badge-slice"
          data-lit={key === "top" ? "true" : undefined}
          points={`9,${dy} 17.5,${dy + 4.5} 9,${dy + 9} 0.5,${dy + 4.5}`}
        />
      ))}
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * LadderGlyph
 * ---------------------------------------------------------------------------*/

/**
 * Two rails and three rungs, drawn over the badge's full height so the top and
 * bottom rungs sit at the badge's own ends — which is what makes "this band is
 * at the top of the run" legible at this size.
 */
function LadderGlyph({ lit }: { lit: TugColumnBadgeLit }): React.ReactElement {
  const rungs: ReadonlyArray<{ key: TugColumnBadgeLit; y: number }> = [
    { key: "top", y: 2 },
    { key: "middle", y: 11 },
    { key: "bottom", y: 20 },
  ];

  return (
    <svg
      className="tug-column-badge-glyph tug-column-badge-glyph-ladder"
      viewBox="0 0 18 22"
      aria-hidden="true"
      focusable="false"
    >
      <line className="tug-column-badge-rail" x1="1.5" y1="1" x2="1.5" y2="21" />
      <line className="tug-column-badge-rail" x1="16.5" y1="1" x2="16.5" y2="21" />
      {rungs.map(({ key, y }) => (
        <line
          key={key}
          className="tug-column-badge-rung"
          data-lit={key === lit ? "true" : undefined}
          x1="1.5"
          y1={y}
          x2="16.5"
          y2={y}
        />
      ))}
    </svg>
  );
}
