/**
 * layout-miniature.tsx — a scale picture of the deck under one layout.
 *
 * The Layouts plan offers a picture rather than words: it draws the deck as it
 * would actually stand — the sidebars holding the sides the deck holds them
 * on, and the cards packed between them under the chosen N-up rule. Reading
 * the picture is recognizing the arrangement rather than decoding a label for
 * it, the idiom Windows 11's Snap Layouts established.
 *
 * Both edges can carry a rail and either can carry more than one card, because
 * the deck's own default stacks the Lens and Jots on the right. A stacked
 * rail's cards stand front-to-back, so the picture draws them as a stack of
 * paper — the ones behind peeking out at the top. A side the user has SPLIT is
 * a divided strip instead, because that is then the arrangement the deck
 * paints; the picture shows which of the two a side is standing under.
 *
 * The geometry is the allocator's settled state (see at0303): the cards tile
 * the band edge to edge with only the seam between them, and the rail absorbs
 * what the cards do not take. So the picture is drawn from the parts' own
 * widths — each card at its content-width preset, each occupied side at the
 * rail's nominal width — normalized to fill the frame. A wider preset thereby
 * reads as the cards claiming more of the deck from the rail, which is what
 * choosing it does; it never reads as gaps opening between cards, which is an
 * arrangement the settled deck does not hold.
 *
 * Purely presentational: props in, CSS out, no store reads and no state ([L06]).
 * The live rails are passed down by the section so every drawing flips
 * together when a side changes.
 *
 * @module components/lens/layout-miniature
 */

import "./layout-miniature.css";

import React from "react";

import {
  columnStanding,
  COLUMN_OVERFLOW_VISIBLE_MEMBERS,
  CONTENT_WIDTH_PX,
  CONTENT_WIDTH_WIDE_PX,
  CONTENT_WIDTH_COMFY_PX,
  slotCount,
  type ContentWidth,
  type FlowSlotExtent,
  type ImpositionKind,
  type ImpositionLayout,
  type RailMode,
  type SidebarSide,
} from "@/lib/layout-imposer";

/** The width a rail contributes to the drawing, in the same nominal pixels the
 *  content-width presets are stated in — the Lens's customary standing width.
 *  The proportion between this and the preset is what makes "Slim" and "Wide"
 *  two different pictures of the same deck. */
const RAIL_NOMINAL_PX = 420;

/** How many sidebar cards stand on each side. Absent or 0 draws no rail. */
export type MiniatureRails = Partial<Record<SidebarSide, number>>;

/** How far a card behind the front one peeks out of the rail, in percent of
 *  the miniature's height. Small: the picture has to say "there is another card
 *  back there" without implying the rail is divided. */
const RAIL_DEPTH_PCT = 3;

/** A lone free card's width, in percent of the field it stands in — the
 *  picture for a deck with no imposition at all (`kind: null`). */
const FREE_CARD_PCT = 46;

/**
 * The band the FLOW drawing measures against, in the same nominal pixels the
 * presets are stated in — a comfortable three cards' worth.
 *
 * Flow needs a reference the fit drawing does not, and the difference is the
 * whole distinction between the modes. Fit's cards are normalized to fill the
 * band, so N of them tile it at any preset and any count — which is the
 * settled arrangement fit actually holds. Flow's cards keep their own width
 * and the band keeps its own, so how much of the deck you can see is exactly
 * the question, and a drawing that normalized it away would answer nothing.
 *
 * Stating the band as a fixed width is what makes both controls mean something
 * in flow: at a narrow preset more cards fit before the strip runs off the
 * edge, at a wide one fewer — the real trade, drawn.
 */
const FLOW_BAND_NOMINAL_PX = CONTENT_WIDTH_COMFY_PX * 3;

/** The space between two cards, in percent of the field. Wider than a real
 *  seam drawn to scale, which would be a fraction of a pixel at this size.
 *
 *  It is a ceiling rather than a constant — see {@link cardGapFor}. */
const CARD_GAP_PCT = 3.5;

/**
 * The seam between two blocks, given how many share the field.
 *
 * The seam is exaggerated because a real one drawn to scale is a fraction of a
 * pixel. The exaggeration is affordable while the cards are wide; at six-up,
 * five seams at the full width would spend a fifth of the field on air and
 * leave blocks too thin to read as cards. So the seam is capped at a share of
 * each block: it may never grow past a fifth of the space one card gets, which
 * holds it visible in the sparse arrangements and lets it give way in the
 * dense ones.
 */
function cardGapFor(count: number): number {
  return Math.min(CARD_GAP_PCT, 100 / (count * 5));
}

export interface LayoutMiniatureProps {
  /** The N-up rule to draw, or `null` for no imposition (one free card). */
  kind: ImpositionKind | null;
  /** How many sidebar cards stand on each side. */
  rails?: MiniatureRails;
  /** How each side's rail is arranged. Absent — for a side or entirely — draws
   *  a stack, which is what a rail is until the user says otherwise. */
  railModes?: Partial<Record<SidebarSide, RailMode>>;
  /**
   * Which slots are drawn divided, and into how many members — the content-side
   * twin of `railModes`, keyed by slot index. A slot absent here is drawn whole,
   * which is what every column is until the user splits it.
   *
   * Member counts rather than a mode word, because a column's membership is
   * what makes it divisible at all: two cards in a slot can be split, one
   * cannot, and the drawing should show how many shares the run is in.
   */
  columnSplits?: Readonly<Record<number, number>>;
  /**
   * How far each overflowing column has slid its strip up behind the run, as a
   * FRACTION of the run — keyed by slot, absent reading as at rest.
   *
   * A fraction rather than pixels because the field IS the run: the drawing's
   * whole height is the height the deck's members stand in, so one number
   * carries across the scale change without the picture needing to know either
   * side's size. Only the committed drawing is given these, for the reason it
   * alone is given the flow offset ([P06]).
   */
  columnOffsets?: Readonly<Record<number, number>>;
  /** Draw the cards. `false` draws the deck's frame and rails alone — the
   *  picture for a question that is only about which edge a sidebar holds. */
  cards?: boolean;
  /**
   * Draw the cards at a named content width. The preset does not narrow the
   * blocks within the band — the settled deck holds no such gaps — it sets
   * how much of the drawing the cards' side of the seam takes against the
   * rail's. Omitted, the cards are drawn at the widest preset.
   */
  width?: ContentWidth;
  /**
   * Which geometry to draw. `"fit"` (the default, and what every caller meant
   * before the mode existed) tiles the band; `"flow"` draws the cards at their
   * own widths in a strip, with a viewport window over it when the strip is
   * longer than the band.
   */
  layout?: ImpositionLayout;
  /**
   * Draw the arrangement as the one the deck is standing under — solid blocks.
   * Omitted, the drawing is a proposal and its blocks are hollow: the plan
   * layer a hovered or cursored segment shows is an arrangement being
   * auditioned, not one in force.
   */
  committed?: boolean;
  /**
   * The deck's live flow truth, for the committed drawing alone: how far the
   * strip has slid under the band, what the band measures, and what each
   * occupied slot's extent is.
   *
   * All three or none. They are one fact in three numbers — a strip's
   * proportions mean nothing without the band they are seen through, and an
   * offset into a strip nobody has measured places the window nowhere — so a
   * partial set draws at rest rather than drawing a mixture of two truths.
   *
   * Only a FLOW drawing reads them. Fit's slots are anchors at fractions of the
   * band and its cards tile it edge to edge whatever they are wide, so real
   * extents would draw a deck fit does not hold.
   */
  flowOffsetPx?: number;
  /** @see {@link LayoutMiniatureProps.flowOffsetPx} */
  flowBandPx?: number;
  /** @see {@link LayoutMiniatureProps.flowOffsetPx} */
  slotExtents?: readonly FlowSlotExtent[];
}

/** The air between two members of a divided rail, in percent of the drawing's
 *  height — the seam's share, exaggerated for the same reason the card gap is. */
const RAIL_SEAM_PCT = 2.5;

/**
 * One side's rail, holding `count` cards at `widthPct` of the drawing, drawn
 * the way that side is actually arranged.
 *
 * **Stacked**, the members are the same size and stand in one place — that IS
 * the geometry — so it is drawn the way a stack of paper is: the ones behind
 * peek out by a few percent at the top. **Split**, the strip is divided into
 * equal segments with a seam between them, because the whole point of that
 * arrangement is that every member has its own share of the run.
 *
 * The split drawing is the equal division rather than the side's actual
 * heights. The picture answers "how is this side arranged", and a miniature
 * faithful to a hand-dragged ratio would make the two answers to that question
 * look like three.
 */
function Rail({
  count,
  widthPct,
  mode = "stack",
}: {
  count: number;
  widthPct: number;
  mode?: RailMode;
}): React.ReactElement {
  const depth = Math.min(count - 1, 2);
  const members = mode === "split" ? Math.min(count, 3) : depth + 1;
  return (
    <span
      className="layout-mini-rail"
      data-rail-mode={mode}
      style={{ flexBasis: `${widthPct}%` }}
    >
      {Array.from({ length: members }, (_, i) => {
        if (mode === "split") {
          // Equal segments, seams between them: the first is flush with the
          // top of the strip and the last with its bottom, exactly as the real
          // rail's endpoints are the pins an unsplit rail has.
          const span = (100 - RAIL_SEAM_PCT * (members - 1)) / members;
          const top = i * (span + RAIL_SEAM_PCT);
          return (
            <span
              key={i}
              className="layout-mini-rail-member"
              style={{ top: `${top}%`, bottom: `${100 - top - span}%` }}
            />
          );
        }
        // Drawn back to front: the last one is the card you are looking at.
        const behind = depth - i;
        return (
          <span
            key={i}
            className="layout-mini-rail-member"
            style={{
              top: `${behind * RAIL_DEPTH_PCT}%`,
              bottom: `${(depth - behind) * RAIL_DEPTH_PCT}%`,
            }}
          />
        );
      })}
    </span>
  );
}

/**
 * LayoutMiniature — the deck, drawn small.
 *
 * Each occupied side is a strip of that side's cards, and the content cards
 * tile what is left of the frame edge to edge, numbered left to right as the
 * real deck numbers them.
 */
export function LayoutMiniature({
  kind,
  rails = {},
  railModes,
  columnSplits,
  columnOffsets,
  cards = true,
  width,
  layout = "fit",
  committed = false,
  flowOffsetPx,
  flowBandPx,
  slotExtents,
}: LayoutMiniatureProps): React.ReactElement {
  const left = rails.left ?? 0;
  const right = rails.right ?? 0;
  const count = !cards ? 0 : kind === null ? 1 : slotCount(kind);
  // The drawing's parts at their own nominal widths, normalized to the frame:
  // N cards at the preset, one rail width per occupied side. The rail's
  // percentage falls as the cards' claim grows — the allocator's trade.
  const cardUnits =
    width !== undefined ? CONTENT_WIDTH_PX[width] : CONTENT_WIDTH_WIDE_PX;
  const railSides = (left > 0 ? 1 : 0) + (right > 0 ? 1 : 0);
  const totalUnits = Math.max(
    1,
    count * cardUnits + railSides * RAIL_NOMINAL_PX,
  );
  const railPct = (RAIL_NOMINAL_PX / totalUnits) * 100;
  // Within the field the cards tile edge to edge: equal shares separated by
  // the seam, the first flush left and the last flush right. A free card
  // (no imposition) keeps its own width and the middle of the field instead.
  const cardGap = cardGapFor(count);
  const fitShare =
    kind === null
      ? FREE_CARD_PCT
      : count > 0
        ? (100 - cardGap * (count - 1)) / count
        : 0;

  // FLOW: the cards keep their own width against a band that keeps its own, so
  // the strip can be shorter than the band (air at the right, which is what a
  // half-full flow deck really looks like) or longer than it (the strip runs
  // off the edge and the deck scrolls). When it is longer the WHOLE strip is
  // scaled into the frame and a window marks the part that is on screen — the
  // picture states the arrangement AND how much of it you see.
  //
  // The COMMITTED drawing is an instrument: given the deck's live flow truth it
  // draws the real strip — each occupied slot at its own extent — and puts the
  // window where the offset actually stands, so activating an off-band card
  // moves the window here too. That costs a Lens row's repaint per activation,
  // which is the price of the drawing answering "how much of this can I see"
  // for the deck in front of you rather than for a deck of identical cards.
  //
  // PREVIEW layers keep drawing at rest, and that half is not a compromise: an
  // arrangement nobody has committed has no offset to track and no extents to
  // measure, because the deck has never stood under it. They get the synthetic
  // strip — every card one preset wide against a nominal band — which is
  // exactly the picture a plan can honestly make.
  //
  // All three live props or none. They are one fact in three numbers: a strip's
  // proportions mean nothing without the band they are seen through, and an
  // offset into a strip nobody has measured places the window nowhere.
  const flowLive =
    layout === "flow" &&
    kind !== null &&
    flowOffsetPx !== undefined &&
    flowBandPx !== undefined &&
    flowBandPx > 0 &&
    slotExtents !== undefined &&
    slotExtents.length > 0
      ? { offsetPx: flowOffsetPx, bandPx: flowBandPx, extents: slotExtents }
      : null;
  // Each block the flow drawing lays along the strip: the slot it stands for
  // and its width as a percentage of the BAND — the unit both the live and the
  // synthetic strip are stated in before the scale that fits them in the frame.
  //
  // Live, the blocks are the OCCUPIED slots, in strip order. An empty slot
  // contributes nothing to a real strip — not even a gap — so drawing one would
  // be drawing a place the deck does not hold.
  const flowBlocks: readonly { slot: number; widthPct: number }[] =
    flowLive !== null
      ? flowLive.extents.map((extent) => ({
          slot: extent.slot,
          widthPct: (extent.width / flowLive.bandPx) * 100,
        }))
      : Array.from({ length: count }, (_, i) => ({
          slot: i,
          widthPct: (cardUnits / FLOW_BAND_NOMINAL_PX) * 100,
        }));
  const flowGap = cardGapFor(flowBlocks.length);
  const flowStrip = flowBlocks.reduce(
    (sum, block, i) => sum + block.widthPct + (i > 0 ? flowGap : 0),
    0,
  );
  const flowOverflows = layout === "flow" && flowStrip > 100;
  const flowScale = flowOverflows ? 100 / flowStrip : 1;

  // Where every block stands, in percent of the field: fit tiles the band in
  // equal shares; flow lays the strip out at each block's own width and scales
  // the whole of it in when it is longer than the band. A free card (no
  // imposition) keeps its own width and the middle of the field under either.
  const blocks: readonly { slot: number; left: number; width: number }[] =
    layout === "flow" && kind !== null
      ? flowBlocks.map((block, i) => ({
          slot: block.slot,
          left:
            flowBlocks
              .slice(0, i)
              .reduce((sum, prior) => sum + prior.widthPct + flowGap, 0) *
            flowScale,
          width: block.widthPct * flowScale,
        }))
      : Array.from({ length: count }, (_, i) => ({
          slot: i,
          left: kind === null ? (100 - fitShare) / 2 : i * (fitShare + cardGap),
          width: fitShare,
        }));
  // The window marks the band over the strip: as wide a share of the drawing as
  // the band is of the strip, standing where the offset has slid the strip
  // under it. At rest — or with no live truth to read — that is flush left.
  const windowLeft =
    flowLive === null
      ? 0
      : (flowLive.offsetPx / flowLive.bandPx) * 100 * flowScale;
  return (
    <span
      className="layout-mini"
      data-committed={committed ? "true" : undefined}
      data-layout={layout}
      aria-hidden="true"
    >
      {left > 0 ? (
        <Rail count={left} widthPct={railPct} mode={railModes?.left} />
      ) : null}
      <span className="layout-mini-field">
        {blocks.map((block) => {
          // A split column divides its RUN, not the band: the members keep the
          // slot's left edge and its width and stack down it, flush top and
          // bottom, with a seam between — the same equal division the rail's
          // split draws, and for the same reason. A hand-dragged ratio is not
          // what the picture is answering.
          const members = columnSplits?.[block.slot] ?? 1;
          if (members < 2) {
            return (
              <span
                key={block.slot}
                className="layout-mini-block"
                style={{ left: `${block.left}%`, width: `${block.width}%` }}
              />
            );
          }
          // Past two members the column stops dividing and starts scrolling
          // ([P08]), and the drawing says so rather than capping at three: EVERY
          // member is drawn, each the same height, stacked down a strip that
          // runs off the bottom of the field. The span is solved so the third
          // member is cut exactly in half — `(100 - 2 * gap) / 2.5` puts two
          // whole members and half of a third inside the run for any gap — which
          // is the geometry the deck itself resolves, and the half-visible card
          // IS the affordance saying there is more below.
          const overflow = columnStanding(members) === "overflow";
          const span = overflow
            ? (100 - RAIL_SEAM_PCT * 2) / COLUMN_OVERFLOW_VISIBLE_MEMBERS
            : (100 - RAIL_SEAM_PCT * (members - 1)) / members;
          const slide = overflow ? (columnOffsets?.[block.slot] ?? 0) * 100 : 0;
          return Array.from({ length: members }, (_, m) => {
            const top = m * (span + RAIL_SEAM_PCT) - slide;
            return (
              <span
                key={`${block.slot}:${m}`}
                className="layout-mini-block"
                data-column-member=""
                data-column-overflow={overflow ? "" : undefined}
                style={{
                  left: `${block.left}%`,
                  width: `${block.width}%`,
                  top: `${top}%`,
                  bottom: `${100 - top - span}%`,
                }}
              />
            );
          });
        })}
        {flowOverflows ? (
          <span
            className="layout-mini-window"
            style={{ left: `${windowLeft}%`, width: `${100 * flowScale}%` }}
          />
        ) : null}
      </span>
      {right > 0 ? (
        <Rail count={right} widthPct={railPct} mode={railModes?.right} />
      ) : null}
    </span>
  );
}
