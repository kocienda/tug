/**
 * TugColumnBadge — where a card stands within the place it shares, in the slot
 * badge's footprint.
 *
 * A card's position on the deck is three coordinates, and the slot badge says
 * only the first. This badge says the other two, and it says them in two
 * deliberately different vocabularies:
 *
 *  - **A stack shows a NUMBER** — how many cards share the slot — over three
 *    flattened slices, the one the card sits at marked. What the eye cannot
 *    get from a stack is how many are behind, which is why the character is a
 *    count rather than a position; the slices carry the position.
 *  - **A split shows a LETTER** — this member's band, A being the topmost —
 *    over three filled bands with the band's end of the run marked. Every band
 *    of a split is visible at once, so position is real information there and
 *    the badge's job is naming rather than revealing: a letter is an address to
 *    match against a Lens row.
 *
 * Number and letter therefore map categorically onto stack and split, which is
 * teachable in a sentence and can never be misread against a slot number.
 * **Letters are split-only vocabulary, on every surface.**
 *
 * **Both glyphs are filled, in one box.** They answer one question — how is
 * this place arranged — so they are one vocabulary drawn one way: a run of
 * three elements with area, the card's own marked. The split was line work
 * once, two rails and three rungs, and an outline standing beside filled
 * slices reads as a different KIND of thing rather than as the other answer,
 * at a fraction of the weight and with no body to read by on a close ground.
 *
 * The glyph names a REGION and the character names the position. Three elements
 * say top / middle / bottom however deep the run goes, so every interior member
 * of a deep column marks the same middle element while its letter stays exact.
 * That is the intended reading, and it is why neither glyph is drawn with one
 * element per member — at this size a subdivided badge stops being legible.
 *
 * **Whether the glyph marks the level at all is the surface's call**, through
 * `showLevel`. The character always says it; the mark is a second telling, and
 * it earns its keep only where something nearby teaches the reading — a Lens
 * row's slot picker, whose selection fill the badge borrows. In a pane's title
 * bar there is nothing to teach it and no room to say it, so the glyph draws
 * the run and stops.
 *
 * The badge is one character over quiet scenery, and **it is painted as the
 * slot chip beside it is painted**: the character is set exactly as `TugSlot`
 * sets its number, each element of the glyph takes a chip's fill and border,
 * and a stacked `text-shadow` in whatever the character stands on punches it
 * clear of the strokes. Every one of those colours is a knob, because the
 * whole rule is *wear what the chip wears* and only the surface knows what
 * that is — a resting chip's paint for an unlit element, a selected chip's for
 * the one the card occupies, and on a surface whose chip has no selection
 * state, no mark at all.
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
 * Which element of the glyph the card occupies: the end of the run its index
 * sits at, and the middle for everything between. One rule for both kinds —
 * a stack's slices and a split's bands are the same three-element run, and the
 * card is somewhere in it either way.
 *
 * A stack lit its top slice unconditionally once, on the argument that the
 * badge stands on the card you can see and a visible stacked card is the front
 * one. That is true of a badge on a pane's own title bar and false everywhere
 * else: a Lens row names a card that may be buried three deep, and lighting the
 * front slice there said *this card is on top* about a card that is not. The
 * pane cluster does not contradict this — it draws no lit element at all.
 *
 * The index is the same ordering `columnMoveOrder` walks, so the lit end and
 * the direction *Move Up in Column* travels cannot disagree.
 */
export function columnBadgeLit(count: number, index = 0): TugColumnBadgeLit {
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
   * This member's 0-based position, front of the run first: the topmost band
   * of a split, or the frontmost card of a stack. It picks the marked element
   * either way, and for a split it is also the letter.
   * @default 0
   */
  index?: number;
  /**
   * Whether the glyph marks WHICH element of its run the card occupies. The
   * character always says it; this is only about the drawing behind it.
   *
   * Off is for a surface where the drawing is too small to carry a second
   * fact. A marked element at title-bar scale is a fractional difference in a
   * three-element run that is itself the height of a lowercase letter — the
   * eye registers it as noise on the badge rather than as an answer, and it
   * competes with the character, which is stating the same thing exactly.
   * On a Lens row the run is drawn beside a slot picker whose own selection
   * fill teaches the reading, so there the mark lands.
   *
   * The root's `data-lit` is unaffected either way: that is the computed
   * region, a fact about the card, and it stays true whether or not the glyph
   * is drawing it.
   * @default true
   * @selector [data-lit="true"] on .tug-column-badge-slice
   */
  showLevel?: boolean;
}

/* ---------------------------------------------------------------------------
 * TugColumnBadge
 * ---------------------------------------------------------------------------*/

export const TugColumnBadge = React.forwardRef<HTMLSpanElement, TugColumnBadgeProps>(
  function TugColumnBadge(
    { kind, count, index = 0, showLevel = true, className, ...rest },
    ref,
  ) {
    const lit = columnBadgeLit(count, index);

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
        {/* Both glyphs are handed the same thing: which element of the run
            the card sits at, or `null` where the surface marks none. The stack
            once decided that for itself and always marked its top slice, which
            outlived the rule it came from — `columnBadgeLit` would answer
            `middle`, the root would carry it, and the drawing would light the
            front slice anyway. */}
        {kind === "stack" ? (
          <StackGlyph lit={showLevel ? lit : null} />
        ) : (
          <SplitGlyph lit={showLevel ? lit : null} />
        )}
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
 * occlusion where the surface hands in no fill of its own; where one does, a
 * slice is painted as the chip it stands beside.
 *
 * **The run is inset a unit from the box's top and bottom, where the split's
 * bands are not.** The two glyphs share a box and are meant to read at one
 * height, and drawn to the same extent they do not: a diamond comes to a point
 * at each end, so its outermost pixels are a vertex rather than an edge, and
 * the eye takes the tips as overshoot past the flat band the split ends on.
 * The inset is the correction — the stack measures shorter and reads level,
 * which is the only reading that matters, since nothing puts a ruler to a
 * badge.
 */
export function StackGlyph({
  lit,
}: {
  /** `null` marks no slice at all — the surface draws the run, not the depth. */
  lit: TugColumnBadgeLit | null;
}): React.ReactElement {
  const slices: ReadonlyArray<{ key: TugColumnBadgeLit; dy: number }> = [
    { key: "bottom", dy: 11 },
    { key: "middle", dy: 6 },
    { key: "top", dy: 1 },
  ];

  return (
    <svg
      className="tug-column-badge-glyph"
      viewBox="0 0 16 20"
      aria-hidden="true"
      focusable="false"
    >
      {slices.map(({ key, dy }) => (
        <polygon
          key={key}
          className="tug-column-badge-slice"
          data-region={key}
          data-lit={key === lit ? "true" : undefined}
          points={`8,${dy} 15.5,${dy + 4} 8,${dy + 8} 0.5,${dy + 4}`}
        />
      ))}
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * SplitGlyph
 * ---------------------------------------------------------------------------*/

/**
 * Three filled bands dividing the run, top to bottom — the same box, the same
 * ink and the same weight as {@link StackGlyph}'s slices, because the two
 * glyphs are one vocabulary answering one question and a reader should not
 * have to learn them separately.
 *
 * This was a LADDER once — two rails and three rungs, all of it line work —
 * and the mismatch was not a matter of taste. A stack drawn as filled slices
 * beside a split drawn as an outline reads as two different KINDS of thing
 * rather than as two answers to "how is this place arranged", and the outline
 * carries so much less weight that at badge scale the pair looked like a
 * rendering fault. It was also the more fragile drawing: line work has no body
 * to read by, so on any ground close to its own stroke it simply disappeared.
 * A split IS a run divided into bands, which is a thing with area — so it is
 * drawn with area.
 */
export function SplitGlyph({
  lit,
}: {
  /** `null` marks no band at all — the surface draws the run, not the band. */
  lit: TugColumnBadgeLit | null;
}): React.ReactElement {
  const bands: ReadonlyArray<{ key: TugColumnBadgeLit; y: number }> = [
    { key: "top", y: 0.5 },
    { key: "middle", y: 7.5 },
    { key: "bottom", y: 14.5 },
  ];

  return (
    <svg
      className="tug-column-badge-glyph"
      viewBox="0 0 16 20"
      aria-hidden="true"
      focusable="false"
    >
      {bands.map(({ key, y }) => (
        <rect
          key={key}
          className="tug-column-badge-slice"
          data-region={key}
          data-lit={key === lit ? "true" : undefined}
          x="0.5"
          y={y}
          width="15"
          height="5"
          rx="1"
        />
      ))}
    </svg>
  );
}
