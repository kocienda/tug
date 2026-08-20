/**
 * TugSessionRow — one session, as a row.
 *
 * **One shape, three mounts.** The masthead, the Lens rows, and the
 * new-session picker rows all show the same thing, so the shape is authored
 * once, here, and each of them composes it. Nothing is hand-rolled at a mount
 * site: the component library is the consistency mechanism rather than a
 * convention three surfaces are asked to remember.
 *
 * Three levels, and the order is the reading:
 *
 *   [dot] <name> : <callsign>        ← what it IS, and whether it is working
 *   <description>                    ← what it is FOR
 *   <activity>                  ~~~  ← what it is doing, with its tape
 *
 * There used to be a fourth level between the title and the activity — a
 * standing goal — and a fifth metadata line under it. The description already
 * says what the session is for, so a standing goal beside it read as an echo;
 * and the metadata line's facts (turns, size, stamp) are the activity line's
 * rest form now (`sessionActivityRestLine`). Both are retired rather than
 * merely unused.
 *
 * There is no reorder handle among the furniture. A Lens row is carried by its
 * own surface (`block-reorder`), so every part of the row sits at the row's own
 * edge.
 *
 * The component is PRESENTATIONAL. Every part arrives as a node: the indicator
 * is the caller's phase dot, the slots are the caller's picker, the sparkline is
 * the caller's tape, and the three text levels are `React.ReactNode` so a mount
 * site can hand in filter-highlighted runs. So the Lens mounts it over live
 * stores and the gallery mounts it over fixtures, and the two cannot drift.
 *
 * ── The fit ──────────────────────────────────────────────────────────────
 * A {@link TugSessionRowFit} is a complete proposal for how the row packs, and
 * `inset` is the one that ships: the indicator rides the title line, so both
 * lines beneath it start at the row's own inset and gain the whole leading
 * column. Four other fits were auditioned in the gallery (`gutter`, `reveal`,
 * `wash`, `duplex`) and retired with the audition — the attribute stays because
 * it is what the packing rules select on, not because there is a choice to make.
 *
 * Laws: [L06] appearance is CSS on data attributes, never React state;
 *       [L19] `.tsx`/`.css` pair, `data-slot="tug-session-row"`;
 *       [L20] token sovereignty — owns `--tugx-session-row-*` and composes
 *       `TugListRow` / `TugPulse` without reaching into their tokens or
 *       their internals.
 *
 * @module components/tugways/tug-session-row
 */

import "./tug-session-row.css";

import React from "react";

import { cn } from "@/lib/utils";
import { sizeGeometry } from "./internal/tug-progress-pulsing-dot";
import { sparklineCurves } from "./tug-sparkline";
import { TugLabel } from "./tug-label";
import { TugListRow, type TugListRowProps } from "./tug-list-row";
import { TugPulse, type TugPulsePreset } from "./tug-pulse";
import { TugTooltip } from "./tug-tooltip";

/**
 * How a session row packs its furniture — the one fit that ships.
 *
 * `inset` moves the indicator onto the title line and hands the whole leading
 * column back to the two lines below it: measured at the Lens rail, a 34px wider
 * activity run for the cost of a 20px advance on the one line that had width to
 * spare. It reads as one row rather than a glyph beside a paragraph, and unlike
 * the fits that also reclaimed the furniture's column it takes no affordance
 * away from the pointer.
 */
export type TugSessionRowFit = "inset";

/** The fit every session row wears. */
export const TUG_SESSION_ROW_DEFAULT_FIT: TugSessionRowFit = "inset";

/**
 * Where the two sub-lines start — the row's second published knob, and one of
 * the three things that genuinely differ between the surfaces showing a session.
 *
 * `title` hangs the description and the activity off the TITLE's own ink, so
 * the three lines share one vertical and the title reads as the heading of the
 * pair beneath it. `edge` starts them nearer the row's own leading edge
 * instead — outdented from the title — which is what a narrow rail wearing the
 * large indicator needs: a title inset measured off a 28px glyph is a wide
 * indent to spend on a column that has no width to spare.
 *
 * It is an ATTRIBUTE on the row, not a custom property a mount site declares.
 * It was the latter, and the cost was exactly what a knob nobody published
 * costs: the same seven-word declaration appeared in `session-masthead.css` and
 * in `session-card.css`, each with its own paragraph explaining it, and the
 * third surface got the other value by *omitting* a line — so the one real
 * choice among the three was invisible at all three mount sites.
 *
 * @selector [data-sub-align="title"] | [data-sub-align="edge"]
 */
export type TugSessionRowSubAlign = "title" | "edge";

/**
 * Glyph box for the row's phase indicator — the knob for its SIZE, declared
 * here rather than at a mount site so every surface showing a session shows
 * the same dot at the same size.
 *
 * This is the BOX, not the dot: a `pulsing-dot` sheds a ring that travels out
 * to the box edge, and the dot itself paints at 60% of the box at the top of
 * its breath (35% at the bottom). So a running row reads as a `0.6 × size` dot
 * throwing a ring the full width of the box — at 28, a 17px dot inside a 28px
 * ring.
 *
 * A settled row is deliberately smaller, and by the variant's own doing: the
 * component's presence ladder draws stopped / completed in to half the box and
 * paused / aborted to 0.7 of it. Which is the whole reason this size is
 * legible from across the room without every idle session shouting along with
 * it.
 *
 * In the `gutter` fit the indicator holds a column of its own and the size is
 * what the row's leading column costs every line. In the inline-indicator fits
 * it costs only `--tugx-session-row-dot-advance` on the name line, and the
 * rest of the ring overhangs into the row's block padding.
 */
export const TUG_SESSION_ROW_INDICATOR_SIZE = 28;

/**
 * Glyph box for the phase indicator on the denser mounts — the masthead and the
 * picker row.
 *
 * Smaller than {@link TUG_SESSION_ROW_INDICATOR_SIZE} because those are denser
 * than the Lens's monitor row: the dot leads a title that has two lines under it
 * on a tighter measure, and at 28 it would out-shout the name it is marking. The
 * 28 stays where it is — the Lens keeps its indicator, and the size is a caller
 * choice rather than a component change.
 *
 * Still the BOX, not the dot: the ring travels to the box edge and the dot
 * paints at 60% of it, so this reads as a ~10px dot in a 16px ring, overhanging
 * into the row's block padding rather than setting its line height.
 */
export const TUG_SESSION_ROW_STACK_DOT_SIZE = 16;

/**
 * The activity tape's size on a session row, before scale. Declared here for
 * the same reason as the indicator's: the tape is a fixed-width accessory
 * whose width comes straight off the activity run's, so the number belongs to
 * the row's packing rather than to whichever surface mounts it.
 *
 * The masthead's own tape (`SPARKLINE_WIDTH` in `session-masthead.tsx`) is a
 * deliberately larger cut of the same instrument — wider, on a shorter bar.
 * Both draw the same `VISIBLE_SECONDS` span, so the two tapes always show the
 * same window of work, each at its own resolution.
 */
const SPARK_BASE_WIDTH = 64;
const SPARK_BASE_HEIGHT = 22;

/**
 * Symmetric scale on the tape. **TUNE HERE** — this is the one knob for how
 * big the row's sparkline is, and both axes move together so the graph never
 * distorts.
 *
 * It is a number rather than a CSS custom property because the tape is a
 * canvas drawn at device resolution for the size it is given: a CSS transform
 * would scale the pixels it already painted (a soft, resampled line) instead
 * of painting fewer, and it would leave the flex item occupying the width it
 * gave up. Scaling the size itself does both.
 *
 * At 1 — the size of record. The tape is a graph read at a glance from a
 * rail, and it is already small; scaling it down to buy the text width
 * costs more legibility than the text gains, and the width the runs need
 * comes from {@link TUG_SESSION_ROW_SPARK_RESERVE} keeping them off the tape
 * rather than from shrinking it.
 *
 * The scroll speed is derived from the width (`VISIBLE_SECONDS` in
 * `tug-sparkline`), so a narrower tape shows the same span more tightly; it
 * does not change what is on screen.
 */
export const TUG_SESSION_ROW_SPARK_SCALE = 1;

export const TUG_SESSION_ROW_SPARK_WIDTH = Math.round(
  SPARK_BASE_WIDTH * TUG_SESSION_ROW_SPARK_SCALE,
);
export const TUG_SESSION_ROW_SPARK_HEIGHT = Math.round(
  SPARK_BASE_HEIGHT * TUG_SESSION_ROW_SPARK_SCALE,
);

/**
 * The tape's SHAPE — full-scale in characters, and the perceptual curve.
 * Declared once, here, for every surface that draws a session's activity
 * (the Lens row and the card's masthead): two tapes showing the same session
 * must agree on what "full" means and how loud a burst reads, or the same
 * work would draw two different graphs.
 */
export const TUG_SESSION_SPARK_FULL_SCALE_CHARS = 1200;
export const TUG_SESSION_SPARK_CURVE = sparklineCurves.gamma(0.6);

/**
 * What every line ABOVE the tape must stop short of, published to this
 * component's own stylesheet — the tape's own width plus the air it keeps.
 *
 * The tape rides the LAST line, so that line reserves its width by flex layout
 * and stops short of it on its own. No line above it does: each runs the whole
 * row and truncates at the row's edge, which puts them straight under a graph
 * that is taller than its own line box and lifted above it besides. That is
 * every line in the identity stack — the description as much as the activity's
 * headline, and the description is the one the reader is most likely to have
 * written something long into.
 *
 * A composition, not a raw width: the tape's size is declared in TS, the air
 * beside it is a CSS token, and what the lines need is the sum. Publishing the
 * sum is what lets one declaration serve both readers.
 *
 * `0px` when the mount passes no tape (the picker's rows) — a row reserving
 * room for a graph it does not draw is width taken from the text for nothing.
 *
 * The tape's bare width goes out beside the sum, because a mount that places
 * the tape against furniture of its own (the masthead centers it under the
 * pane's control cluster) needs the graph's own advance rather than the air.
 */
const SPARK_RESERVE_STYLE = {
  "--tugx-session-row-spark-width": `${TUG_SESSION_ROW_SPARK_WIDTH}px`,
  "--tugx-session-row-spark-reserve": `calc(${TUG_SESSION_ROW_SPARK_WIDTH}px + var(--tugx-pulse-trailing-gap))`,
} as React.CSSProperties;

const NO_SPARK_RESERVE_STYLE = {
  "--tugx-session-row-spark-width": "0px",
  "--tugx-session-row-spark-reserve": "0px",
} as React.CSSProperties;

/**
 * The empty room between the dot's INK and the trailing edge of the advance
 * it is centered in — what the title is charged for and the dot does not use.
 *
 * The stylesheet's 20px advance was measured against the Lens's 28px dot,
 * whose ink very nearly fills it. The denser mounts pass 16 — and the glyph's
 * own geometry drops the dot's share of its box from 0.6 to 0.5 down there —
 * so 16px of box is 8px of ink centered in a 20px column with six pixels of
 * nothing on each side. On top of the row's 8px of deliberate air the title
 * then stood 14px off a mark that is meant to be leading it, and it did so on
 * two of the three mounts.
 *
 * Only what FOLLOWS the dot closes up, and only by the trailing half of that
 * slack ({@link TugSessionRowProps.indicatorSize}) — the ring reaches well past
 * the ink it is measured from, so a title pulled all the way to the ink's edge
 * is periodically pressed by the ring rather than led by it. The leading side is
 * {@link dotInkLead}, and it is a different question with a different answer.
 *
 * The ratio is read from {@link sizeGeometry} — the glyph's own function, not a
 * second copy of its numbers — so a change to the dot's proportions moves this
 * with it.
 */
function dotInkSlack(size: number, advance: number): number {
  return dotInkRoom(size, advance) * DOT_SLACK_RECLAIMED;
}

/**
 * The same empty room on the LEADING side — between the start of the advance
 * and the start of the dot's ink — taken back in full.
 *
 * Its trailing twin above is a gap between two marks, and closing all of one is
 * too tight. This one is not a gap: it is the difference between where the row
 * says its reading begins and where the reader sees the first ink. Nothing sits
 * in it, and every line of the row is pushed right by it — so the whole entry
 * hangs inside the margin its own surface set, while the mark that leads it
 * lands somewhere no other element in the rail agrees with.
 *
 * Taken back as a NEGATIVE leading margin on the dot's box, so the ink comes to
 * rest on the lines column's content edge and the title, the description and
 * the activity all come with it. The glyph is free to overhang that edge; it is
 * mostly the ring's breath out there, which is transparent and has always
 * overhung something.
 *
 * A mount that wants air before its dot now states it as air —
 * `--tugx-session-row-leading-inset` — which is a number that means what it
 * says. Before, that inset was air PLUS however much of the advance the glyph
 * happened not to fill, and the second term changed with the dot's size.
 */
function dotInkLead(size: number, advance: number): number {
  return dotInkRoom(size, advance);
}

/** The unused room on ONE side of the ink, inside the advance. */
function dotInkRoom(size: number, advance: number): number {
  return Math.max(0, (advance - size * sizeGeometry(size).ratio) / 2);
}

/**
 * How much of that slack the title actually takes back.
 *
 * Not all of it, by eye. Closing the whole gap seats the name flush against a
 * mark that is still breathing — the ring reaches well past the ink it is
 * measured from, so a title pulled to the ink's edge is periodically pressed
 * by the ring rather than led by it. Half puts the title where the reader
 * reads it as belonging to the dot, with room left for the breath.
 */
const DOT_SLACK_RECLAIMED = 0.5;

/**
 * The advance the slack is measured against — the stylesheet's own default,
 * mirrored here because only script can do the arithmetic. A mount that
 * overrides `--tugx-session-row-dot-advance` also owns the gap that follows
 * it, so it should not pass `indicatorSize`.
 */
const DOT_ADVANCE = 20;

export interface TugSessionRowProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children" | "title"> {
  /**
   * How the row packs.
   * @selector [data-fit="<fit>"]
   * @default TUG_SESSION_ROW_DEFAULT_FIT
   */
  fit?: TugSessionRowFit;

  /**
   * Where the description and the activity start.
   * @selector [data-sub-align="<align>"]
   * @default "title"
   */
  subAlign?: TugSessionRowSubAlign;

  /** The PULSE's typographic preset, forwarded whole to {@link TugPulse}. */
  preset?: TugPulsePreset;

  /** Phase indicator — the caller's progress dot. */
  indicator?: React.ReactNode;

  /**
   * The glyph box `indicator` was built at — the same number the mount site
   * hands `SessionPhaseDot`.
   *
   * Given, the row closes the title up against the ink that box actually
   * paints ({@link dotInkSlack}) instead of against the stylesheet's one-size
   * advance, which is how the title comes to sit the same distance off its
   * mark on every mount rather than only on the one the advance was measured
   * against. The dot itself does not move. Omitted, the line packs exactly as
   * it did.
   */
  indicatorSize?: number;

  /**
   * The session's title — the two runs of {@link sessionTitleParts}, usually
   * wrapped in a filter highlight by the mount site. Takes the slack on its
   * line and truncates.
   */
  name?: React.ReactNode;

  /** The layout-imposer slots — the arrangement affordance. */
  slots?: React.ReactNode;

  /**
   * The session's description — the AGENT's rolling synopsis, or the stand-in
   * that fills its place when there is none yet (the session's own first prompt,
   * else its creation stamp). **Not** the user's `/rename` name: that leads the
   * title line above.
   *
   * Rendered whenever the prop is present, EVEN WHEN EMPTY, so a description
   * arriving does not move the line below. A row that does not want the line at
   * all omits the prop entirely.
   */
  description?: React.ReactNode;

  /**
   * The description's COMPLETE text, for the hover that shows what the line
   * could not fit. Given, hovering the description opens a tooltip carrying
   * this; a line that is already showing its description whole opens nothing.
   *
   * Separate from {@link description} because that one is rendered ink — the
   * mount site's filter highlight wraps it in elements, and a tooltip cannot
   * read a string back out of a ReactNode. Only the mount site holds the
   * source text, so only the mount site can hand it over.
   */
  descriptionFull?: string;

  /**
   * Whether {@link description} is a SHORTENED form of {@link descriptionFull}
   * — a mount that caps the text by character count before it ever reaches the
   * DOM ([TugSessionRowProps.description] is then already ellipsized).
   *
   * It exists because the two ways a description goes short are not both
   * visible to a measurement. CSS elision leaves the whole string in the DOM
   * and shows the overflow in `scrollWidth`, which the tooltip detects on its
   * own; a character cap hands the DOM a string that already fits, so nothing
   * about the element says the reader is missing anything. Set, the hover is
   * unconditional; unset, it opens only when the line is actually clipped.
   * @default false
   */
  descriptionElided?: boolean;

  /**
   * Whether {@link description} is a fact STANDING IN for a description nobody
   * has written yet — the session's own first prompt, or its creation stamp.
   * Painted a step quieter, so the reader can tell a described session from one
   * that is merely being placed. Only the mount site knows which rung it
   * resolved, so only the mount site can say.
   * @selector [data-stamp="true"]
   * @default false
   */
  descriptionStandIn?: boolean;

  /**
   * The activity line — the live beat during a turn, and
   * `sessionActivityRestLine`'s sentence otherwise.
   */
  activity?: React.ReactNode;

  /** The activity sparkline. */
  sparkline?: React.ReactNode;

  /**
   * Props for the element wrapping the activity run, forwarded whole to
   * {@link TugPulse}. The gesture surface for anything acting on the activity
   * as a whole — the masthead hangs its right-click copy and its
   * recent-pulses toggle here, so the target is the reading and not the tape
   * beside it.
   */
  stageProps?: React.ComponentProps<"span">;

  /** Selected state, forwarded to the underlying `TugListRow`. */
  selected?: boolean;

  /** Trailing accessory — a status badge, a trash action. Forwarded whole. */
  trailing?: React.ReactNode;

  /** When the trailing accessory shows. Forwarded whole. */
  trailingReveal?: TugListRowProps["trailingReveal"];

  /** Disabled appearance and interaction. Forwarded whole. */
  disabled?: boolean;
}

/**
 * Give the description line its hover, or hand it back untouched.
 *
 * Untouched is the common case and deliberately costs nothing: a mount that
 * passes no complete text (or whose description is empty) renders exactly the
 * span it did before, with no tooltip machinery around it — these rows are
 * drawn by the dozen in the Lens and the picker.
 *
 * `truncated` is inverted from `elided` because the two say the same thing
 * from opposite ends: a line the mount already shortened needs no measurement
 * to know something is missing, while an unshortened line has to be measured
 * against its own box. Either way the tooltip never opens over a line that is
 * showing its description whole.
 */
function withDescriptionHover(
  line: React.ReactElement,
  full: string | undefined,
  elided: boolean,
): React.ReactElement {
  if (full === undefined || full.length === 0) return line;
  return (
    <TugTooltip
      content={full}
      truncated={!elided}
      side="bottom"
      align="start"
      arrow={false}
    >
      {line}
    </TugTooltip>
  );
}

export const TugSessionRow = React.forwardRef<
  HTMLDivElement,
  TugSessionRowProps
>(function TugSessionRow(
  {
    fit = TUG_SESSION_ROW_DEFAULT_FIT,
    subAlign = "title",
    preset,
    indicator,
    indicatorSize,
    name,
    slots,
    description,
    descriptionFull,
    descriptionElided = false,
    descriptionStandIn = false,
    activity,
    sparkline,
    stageProps,
    selected,
    trailing,
    trailingReveal,
    disabled,
    className,
    style,
    ...rest
  },
  ref,
) {
  return (
    <TugListRow
      ref={ref}
      className={cn("tug-session-row", className)}
      style={{
        ...(sparkline !== undefined && sparkline !== null
          ? SPARK_RESERVE_STYLE
          : NO_SPARK_RESERVE_STYLE),
        ...(indicatorSize !== undefined
          ? {
              ["--tugx-session-row-dot-slack" as string]: `${dotInkSlack(
                indicatorSize,
                DOT_ADVANCE,
              ).toFixed(2)}px`,
              ["--tugx-session-row-dot-lead" as string]: `${dotInkLead(
                indicatorSize,
                DOT_ADVANCE,
              ).toFixed(2)}px`,
            }
          : null),
        ...style,
      }}
      data-slot="tug-session-row"
      data-fit={fit}
      data-sub-align={subAlign}
      selected={selected}
      trailing={trailing}
      trailingReveal={trailingReveal}
      disabled={disabled}
      {...rest}
    >
      <span className="tug-session-row-lines">
        <span className="tug-session-row-name-line">
          {indicator !== undefined && indicator !== null ? (
            <span className="tug-session-row-dot">{indicator}</span>
          ) : null}
          <TugLabel className="tug-list-row-title" size="sm" maxLines={1}>
            {name}
          </TugLabel>
          {slots !== undefined && slots !== null ? (
            <span className="tug-session-row-slots">{slots}</span>
          ) : null}
        </span>
        {/* The description. Present whenever the prop is — an empty one keeps
            its line rather than collapsing it, so a description arriving does
            not move the line beneath. A row that wants two lines omits it.

            Hovering it shows the whole text when the line could not fit it.
            The description is the row's longest run and the one a reader is
            most likely to have written something long into, and it is the one
            line here with no other surface that shows it in full — the title
            is a name, the activity is a live beat, but a synopsis that runs
            past the row's edge was simply unreadable. `truncated` mode does
            the measuring, so nothing opens over a line that is already whole
            ([L06]: measured off the live element, no state, no re-render). */}
        {description !== undefined
          ? withDescriptionHover(
              <span
                className="tug-session-row-description"
                data-empty={
                  description === null || description === "" ? "true" : undefined
                }
                data-stamp={descriptionStandIn ? "true" : undefined}
              >
                {description}
              </span>,
              descriptionFull,
              descriptionElided,
            )
          : null}
        {/* The activity, and the tape that rides it. Nothing about how the line
            reads is decided here: `TugPulse` owns the face, the leading, where
            the baseline falls, and what a line with nothing to say says. Its
            `headline` level is deliberately not passed — the description above
            already says what the session is for ([D132]). */}
        <TugPulse
          layout="stacked"
          preset={preset}
          activity={activity}
          trailing={sparkline}
          stageProps={stageProps}
        />
      </span>
    </TugListRow>
  );
});
