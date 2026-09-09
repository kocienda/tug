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
 * the deck's own default stacks the rail cards on the right. A stacked
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
 * @module components/layout/layout-miniature
 */

import "./layout-miniature.css";

import React, { useLayoutEffect, useRef } from "react";

import {
  columnOffsetSignal,
  gaugeProperties,
  registerGauge,
  type GaugeSignal,
} from "@/lib/imposer-gauges";

import {
  nominalPlaceAllocation,
  type PlaceAllocation,
  CONTENT_WIDTH_PX,
  CONTENT_WIDTH_WIDE_PX,
  CONTENT_WIDTH_COMFY_PX,
  slotCount,
  stripPositions,
  type ContentWidth,
  type ImpositionKind,
  type ImpositionLayout,
  type RailMode,
  type SidebarSide,
} from "@/lib/layout-imposer";

/** The width a rail contributes to the drawing, in the same nominal pixels the
 *  content-width presets are stated in — a rail's customary standing width.
 *  The proportion between this and the preset is what makes "Slim" and "Wide"
 *  two different pictures of the same deck. */
const RAIL_NOMINAL_PX = 420;

/** How many sidebar cards stand on each side. Absent or 0 draws no rail. */
export type MiniatureRails = Partial<Record<SidebarSide, number>>;

/**
 * One slot as the LIVE strip stands it — where it begins and how wide it is,
 * both in the strip's own pixels from the strip's origin.
 *
 * The left edge is carried rather than accumulated for the reason
 * {@link FlowStrip.extents} is carried rather than re-derived: laying the
 * slots out by summing widths and adding a gap makes the drawing responsible
 * for a number it does not own, and it will get that number wrong the moment
 * it differs from whatever the strip actually used.
 */
export interface MiniatureFlowSlot {
  slot: number;
  leftPx: number;
  widthPx: number;
}

/** The live strip as the drawing needs it: the band it is seen through, its own
 *  full length, and where each standing slot sits along it. */
export interface MiniatureFlowStrip {
  bandPx: number;
  stripPx: number;
  slots: readonly MiniatureFlowSlot[];
}

/** How far a card behind the front one peeks out of the rail, in percent of
 *  the miniature's height. Small: the picture has to say "there is another card
 *  back there" without implying the rail is divided. */
const RAIL_DEPTH_PCT = 3;

/** A lone free card's width, in percent of the field it stands in — the
 *  picture for a deck with no imposition at all (`kind: null`). */
const FREE_CARD_PCT = 46;

/**
 * The band to draw against when there is no measured one — a comfortable three
 * cards' worth, in the same nominal pixels the presets are stated in.
 *
 * A LAST RESORT, not the normal case. The drawing measures against the deck's
 * real band whenever the caller has it, because how much of the arrangement
 * the band can hold is exactly the question both layouts are answering: at a
 * narrow preset more cards fit before fit starts lapping them and before flow
 * starts running off the edge, at a wide one fewer. That trade is only drawn
 * truthfully against the band it is really being made against.
 */
const BAND_NOMINAL_PX = CONTENT_WIDTH_COMFY_PX * 3;

/**
 * The places a drawing gets when nobody has measured the deck it is of: every
 * slot at the preset's width, laid out by the same rule the real one uses.
 *
 * A preview is a drawing of a deck that does not exist yet — not a drawing of
 * a different kind of thing — so it goes through {@link stripPositions} exactly
 * as the committed drawing's places do. Only the widths are supposed rather
 * than measured, and an empty `occupied` with a vacancy at the preset is how
 * that is said: every slot is a held-open place of a card's width, which is
 * precisely what a proposal claims.
 */
function syntheticPlaces(
  layout: ImpositionLayout,
  count: number,
  cardPx: number,
  bandPx: number,
): MiniatureFlowStrip {
  const strip = stripPositions(layout, [], {
    band: bandPx,
    vacancy: { count, extent: cardPx },
  });
  return {
    bandPx,
    stripPx: strip.width,
    slots: [...strip.extents]
      .sort(([a], [b]) => a - b)
      .map(([slot, widthPx]) => ({
        slot,
        leftPx: strip.positions.get(slot) ?? 0,
        widthPx,
      })),
  };
}

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
  /**
   * How each side's rail actually divides its run, when this drawing is the
   * committed one ([P09]). Absent — on every proposal layer — the side is
   * drawn from the anonymous allocation a place of that many members gets,
   * which is the equal division these drew before heights were a fact about
   * an arrangement.
   */
  railAllocations?: Partial<Record<SidebarSide, PlaceAllocation | null>>;
  /** {@link LayoutMiniatureProps.railAllocations}' slot-keyed twin. */
  columnAllocations?: Readonly<Record<number, PlaceAllocation | null>>;
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
   * strip has slid under the band, what the band measures, how long the strip
   * is, and where every standing slot begins and ends along it.
   *
   * All four or none. They are one fact in four numbers — a strip's
   * proportions mean nothing without the band they are seen through, and an
   * offset into a strip nobody has measured places the window nowhere — so a
   * partial set draws at rest rather than drawing a mixture of two truths.
   *
   * The strip's LENGTH and its slots' POSITIONS are given rather than derived,
   * and that is the difference between a drawing and a claim. Derived, the
   * drawing had to assume the gap between two slots, and it assumed the
   * decorative one it uses for the synthetic strip — several times the real
   * one. Every assumed gap inflated the strip the window is measured against,
   * so the window came out narrower than the band really is and the picture
   * showed a slot being cut off that was fully on screen. `deckFlowStrip`
   * already resolves both numbers ([P09]); reading them is the only way the
   * two can agree.
   *
   * Only a FLOW drawing reads them. Fit's slots are anchors at fractions of the
   * band and its cards tile it edge to edge whatever they are wide, so real
   * extents would draw a deck fit does not hold.
   */
  flowOffsetPx?: number;
  /** @see {@link LayoutMiniatureProps.flowOffsetPx} */
  flowBandPx?: number;
  /** @see {@link LayoutMiniatureProps.flowOffsetPx} */
  flowStripPx?: number;
  /** @see {@link LayoutMiniatureProps.flowOffsetPx} */
  flowSlots?: readonly MiniatureFlowSlot[];
}

/** The air between two members of a divided rail, in percent of the drawing's
 *  height — the seam's share, exaggerated for the same reason the card gap is. */
const RAIL_SEAM_PCT = 2.5;

/** The run an anonymous allocation is taken against. Any positive number does:
 *  the drawing reads the heights as proportions of it and never in pixels. */
const NOMINAL_RUN = 1000;

/**
 * Where each of a place's first `drawn` members stands in the drawing, in
 * percent of the field — the one span arithmetic both the rail and the column
 * blocks draw from.
 *
 * The members divide the field in proportion to the heights the allocator gave
 * them, with the seam air taken out first: a sharing place surrenders one
 * seam per interior edge it draws, and an overflowing one surrenders the two
 * that stand between the members inside the run, which is what leaves its last
 * drawn member cut by the field's bottom edge — the affordance saying there is
 * more below.
 *
 * The proportions are heights against the RUN in overflow and against the
 * members' own total when sharing, because those are the two things being
 * divided: an overflowing strip is longer than the run and a sharing place is
 * exactly it.
 */
function placeSpanPcts(
  place: PlaceAllocation,
  drawn: number,
): readonly { top: number; span: number }[] {
  const overflow = place.standing === "overflow";
  const field = 100 - RAIL_SEAM_PCT * (overflow ? 2 : Math.max(0, drawn - 1));
  const heights = place.heights.slice(0, drawn);
  const total = overflow
    ? place.run
    : heights.reduce((sum, height) => sum + height, 0);
  const spans: { top: number; span: number }[] = [];
  let top = 0;
  for (const height of heights) {
    const span = total > 0 ? (height / total) * field : field / heights.length;
    spans.push({ top, span });
    top += span + RAIL_SEAM_PCT;
  }
  return spans;
}

/**
 * The deviation from a committed offset, written as the drawing's own motion.
 *
 * Every gauge value is a fraction ([P08]), and the committed fraction the
 * drawing was rendered at is a number this component already holds — so the
 * live term is their DIFFERENCE, which is exactly the "between commits" motion
 * the channel exists to carry. Expressing it that way keeps the committed
 * geometry in the inline `left`/`top` where it has always been, so the drawing
 * at rest is unchanged and needs no publisher to look right, and the gauge only
 * ever adds a translation on top of it.
 *
 * `scale` converts a fraction of the deck's band or run into a percentage of
 * the element being moved, which is the unit a CSS translation is stated in.
 * The result is consumed as `calc(var(--mini-slide) * 1%)`.
 */
function slideExpression(
  signal: GaugeSignal,
  committed: number,
  scale: number,
): string {
  // The channel spells its own properties — the drawing never guesses one.
  const property = gaugeProperties(signal)[0];
  return `calc((var(${property}, ${committed}) - ${committed}) * ${scale})`;
}

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
 * The peek is a SOLID-paint idiom, so only the committed drawing draws it. A
 * proposal's members are hollow, and a hollow rect cannot occlude the one
 * behind it — both outlines paint whole, and the offsets that read as a paper
 * stack in solid ink read as spurious slivers at the strip's top and bottom.
 * A proposal therefore draws a stacked rail as ONE silhouette; the overlay's
 * mark is what states the stack there.
 *
 * The split drawing is the equal division rather than the side's actual
 * heights. The picture answers "how is this side arranged", and a miniature
 * faithful to a hand-dragged ratio would make the two answers to that question
 * look like three.
 *
 * **A FLOWING rail draws itself, and no code here says so.** The drawing reads
 * the side's own allocation, whose standing follows the layout ([B04]) — so a
 * flow rail arrives already standing as a strip and is drawn the way this
 * function has always drawn a strip: every member at the height its own
 * content asked for, a seam apart, running off the bottom of the run and
 * clipped by it ([B09]). Fit draws as the division with seams it is. That the
 * two pictures needed no new branch is the point: the layout is a fact about
 * the allocation rather than a second kind of drawing.
 */
function Rail({
  count,
  widthPct,
  mode = "stack",
  committed = false,
  allocation,
}: {
  count: number;
  widthPct: number;
  mode?: RailMode;
  committed?: boolean;
  allocation?: PlaceAllocation | null;
}): React.ReactElement {
  const depth = mode !== "split" && committed ? Math.min(count - 1, 2) : 0;
  // The side's own allocation when there is one; the anonymous one a proposal
  // gets otherwise ([P09]). Either way ONE arithmetic draws the spans, and the
  // drawing derives no member height of its own.
  const place =
    mode === "split"
      ? (allocation ?? nominalPlaceAllocation(count, NOMINAL_RUN, 0))
      : null;
  const overflow = place?.standing === "overflow";
  // Every split member is drawn, not the first three: an overflowing rail's
  // members no longer share one height, so which of them the cut falls on is a
  // fact about their comfort heights rather than a constant the drawing could
  // know in advance. The run clips whatever hangs below it, exactly as the
  // column blocks are clipped, and the half-visible member at the bottom edge
  // is the same affordance either way.
  const spans = place === null ? [] : placeSpanPcts(place, count);
  // …and exactly as many as the place HAS, which is not the same number as the
  // side's card count: a card dragged loose off the rail keeps its side — so it
  // is still counted here — and stops being a member of the rail, so the
  // allocation has no height for it. Drawing `count` members would index a span
  // nobody allocated.
  const members = mode === "split" ? spans.length : depth + 1;
  return (
    <span
      className="layout-mini-rail"
      data-rail-mode={mode}
      data-rail-overflow={overflow ? "true" : undefined}
      style={{ flexBasis: `${widthPct}%` }}
    >
      {Array.from({ length: members }, (_, i) => {
        if (mode === "split") {
          // Two members divide: equal segments with a seam between them, the
          // first flush with the top of the strip and the last with its bottom,
          // exactly as the real rail's endpoints are the pins an unsplit rail
          // has. When the floors stop fitting the side overflows and the
          // drawing follows: every member at its own comfort span, stacked a
          // seam apart down a strip that runs off the bottom of the run — the
          // same picture the column blocks below draw, and the same affordance.
          //
          // Drawn AT REST, unlike a column's, which slides by its live offset:
          // no rail offset rides the gauge channel, and a rail's question here
          // is how the side is arranged rather than where its viewport stands.
          const { top, span } = spans[i];
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

/** A block's place along the field, in percent of the field's own width. */
export interface MiniatureRect {
  leftPct: number;
  widthPct: number;
}

/**
 * Where every part of the drawing stands — the arithmetic, separated from the
 * drawing that performs it.
 *
 * The shape follows the drawing's BOX MODEL rather than reducing everything to
 * fractions of the frame, and that is the whole point of extracting it. The
 * frame is a flex row with real pixel padding and a real pixel gap: a rail is a
 * flex child at `basisPct` of the CONTENT box, the field takes what is left,
 * and a block stands at a percentage of the FIELD. A second consumer that
 * flattened all of that into "percent of the drawing" would be off by the
 * padding and the gaps at every size — which is exactly the drift this function
 * exists to make impossible. Anything positioning itself against the drawing
 * replicates the same flex row and feeds these numbers to the same properties.
 */
export interface MiniaturePlaceRects {
  /** Each occupied side's flex basis, in percent of the frame's content box. */
  rails: Partial<Record<SidebarSide, { basisPct: number }>>;
  /** One entry per drawn block, placed within the field. */
  blocks: readonly (MiniatureRect & { slot: number })[];
  /** Whether the flow strip is longer than the band, the scale that fits the
   *  whole of it into the field when it is, and the seam each live block gives
   *  up off its own right edge so the strip reads as separate cards without
   *  measuring longer than the deck's. Zero for every drawing whose blocks are
   *  already spaced apart. */
  flow: { overflows: boolean; scale: number; seamPct: number };
}

/**
 * The drawing's geometry, given the arrangement — one arithmetic for however
 * many consumers.
 *
 * Everything here is the SETTLED geometry: where the parts stand once the deck
 * has stopped moving. The two live terms the committed drawing also carries —
 * the flow offset that slides the window, and a column's own slide — are
 * deliberately not inputs, because neither moves a block along the band: the
 * offset moves the window element over a strip whose blocks stay put, and a
 * column's slide runs down the field. Both stay where they were, applied on top
 * of these rects by the drawing alone.
 *
 * The live flow strip IS an input, though, and has to be: it decides where the
 * blocks are, so a consumer handed the synthetic strip while the drawing drew
 * the real one would stand its parts over a picture that is not there. Absent,
 * the strip is the synthetic one every proposal draws.
 */
export function miniatureGeometry({
  kind,
  rails = {},
  cards = true,
  width,
  layout = "fit",
  band,
  flow,
}: {
  kind: ImpositionKind | null;
  rails?: MiniatureRails;
  cards?: boolean;
  width?: ContentWidth;
  layout?: ImpositionLayout;
  /**
   * The deck's real band, in px — what the drawing measures against. Absent
   * falls back to {@link BAND_NOMINAL_PX}, which is a drawing of no deck in
   * particular.
   */
  band?: number;
  /** The live places, when there are some. */
  flow?: MiniatureFlowStrip | null;
}): MiniaturePlaceRects {
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
  // The seam the blocks give up so a run of them reads as separate cards.
  const cardGap = cardGapFor(count);

  // The band the drawing measures against: the deck's own whenever the caller
  // has measured it, and a nominal one only when there is no deck to measure.
  //
  // ONE band for both layouts, and that is the whole of what this function used
  // to get wrong. Fit was drawn against an implicit band of exactly the cards'
  // own total — N equal blocks tiling the field, at any preset and any count —
  // on the belief that fit normalizes its cards to fill the band. It does not:
  // fit spreads cards of a FIXED width across whatever band there is, so a band
  // wider than the cards leaves air between them and a narrower one laps them
  // over each other. Neither could be drawn, both are real, and the picture
  // jumped whenever the layout toggled because the two modes were being
  // measured against two different bands.
  const bandPx = band !== undefined && band > 0 ? band : BAND_NOMINAL_PX;

  // The live places, when the caller has them. Not layout-gated: fit's places
  // are as real and as measurable as flow's, and the drawing wants the real
  // ones in both.
  //
  // Live, the blocks are the deck's own strip — one per slot standing in it,
  // each at the place and the width the strip put it, because every slot holds
  // its place (an empty one carries the placeholder width the real strip gives
  // it). The drawing does not decide any of this; `deckSlotStrip` is the one
  // resolution ([P09]) and what it says is what is drawn.
  //
  // Including the GAPS. The drawing used to lay the live blocks out itself, by
  // summing widths and inserting its own decorative seam between them, and that
  // seam is several times the deck's real one — so the strip it measured came
  // out longer than the strip on screen, the window (the band, as a share of
  // that strip) came out narrower than the band really is, and the picture
  // showed a slot half out of view that was fully on screen.
  const live =
    kind !== null &&
    flow !== undefined &&
    flow !== null &&
    flow.bandPx > 0 &&
    flow.stripPx > 0 &&
    flow.slots.length > 0
      ? flow
      : null;

  // And without them — a proposal nobody has stood under — the same two rules
  // over the same band, with every slot at the preset's width. A preview is a
  // drawing of a deck that does not exist yet, not a drawing of a different
  // kind of thing, so it is laid out by the imposer exactly as the committed
  // one is; only the widths are supposed rather than measured.
  const places = live ?? syntheticPlaces(layout, count, cardUnits, bandPx);

  // The places as percentages of the band, which is what the field draws.
  const bandBlocks: readonly (MiniatureRect & { slot: number })[] =
    places.bandPx <= 0
      ? []
      : places.slots.map((entry) => ({
          slot: entry.slot,
          leftPct: (entry.leftPx / places.bandPx) * 100,
          widthPct: (entry.widthPx / places.bandPx) * 100,
        }));
  // How long the run is, in the same percent-of-band its blocks are stated in.
  const stripPct =
    places.bandPx <= 0 ? 0 : (places.stripPx / places.bandPx) * 100;
  // Only flow can outrun the band. A fit run IS the band — the first slot rests
  // on one edge and the last on the other — so this is false there by
  // arithmetic and not by a branch.
  const flowOverflows = layout === "flow" && stripPct > 100;
  const flowScale = flowOverflows ? 100 / stripPct : 1;
  // The seam, taken OUT of each block rather than added between them — and that
  // distinction is the whole of it.
  //
  // The deck's own gap is a fraction of a pixel at this scale (see
  // `cardGapFor`), so a run drawn at the deck's real positions and nothing else
  // has no visible seam at all: the cards butt together and four columns read
  // as one grey slab. Adding air BETWEEN them instead is what made the strip
  // longer than the deck's and the window narrower than the band.
  //
  // Subtracting the seam from each block's own width costs nothing the window
  // is measured against: every left edge stays exactly where the deck put it,
  // the run keeps its whole length, and the blocks still read as separate
  // cards. A drawn card is a card's width less the air it is seen against.
  const flowSeam = cardGap;

  // Where every block stands, in percent of the field. A free card (no
  // imposition) keeps its own width and the middle of the field, which is the
  // one drawing with no arrangement to place.
  const blocks: readonly (MiniatureRect & { slot: number })[] =
    kind === null
      ? Array.from({ length: count }, (_, i) => ({
          slot: i,
          leftPct: (100 - FREE_CARD_PCT) / 2,
          widthPct: FREE_CARD_PCT,
        }))
      : bandBlocks.map((block) => ({
          slot: block.slot,
          leftPct: block.leftPct * flowScale,
          widthPct: Math.max(block.widthPct * flowScale - flowSeam, 0),
        }));

  const railRects: Partial<Record<SidebarSide, { basisPct: number }>> = {};
  if (left > 0) railRects.left = { basisPct: railPct };
  if (right > 0) railRects.right = { basisPct: railPct };

  return {
    rails: railRects,
    blocks,
    flow: { overflows: flowOverflows, scale: flowScale, seamPct: flowSeam },
  };
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
  railAllocations,
  columnAllocations,
  cards = true,
  width,
  layout = "fit",
  committed = false,
  flowOffsetPx,
  flowBandPx,
  flowStripPx,
  flowSlots,
}: LayoutMiniatureProps): React.ReactElement {
  const left = rails.left ?? 0;
  const right = rails.right ?? 0;

  // The deck's live places, as one fact or none. A run's proportions mean
  // nothing without the band they are laid across, and an offset into a strip
  // nobody has measured places the window nowhere — so a partial set draws at
  // rest rather than drawing a mixture of two truths.
  //
  // Not layout-gated. The COMMITTED drawing is an instrument in both modes:
  // given this it draws the real places — each slot at its own extent, where
  // its own layout put it — and in flow it puts the window where the offset
  // actually stands, so activating an off-band card moves the window here too.
  // PREVIEW layers pass no places and are laid out from the preset instead, but
  // they still get the band below, so a proposal is measured against the same
  // deck the committed drawing is.
  const flowLive =
    flowOffsetPx !== undefined &&
    flowBandPx !== undefined &&
    flowBandPx > 0 &&
    flowStripPx !== undefined &&
    flowStripPx > 0 &&
    flowSlots !== undefined &&
    flowSlots.length > 0
      ? {
          offsetPx: flowOffsetPx,
          bandPx: flowBandPx,
          stripPx: flowStripPx,
          slots: flowSlots,
        }
      : null;

  // Where everything stands — the shared arithmetic, not a second copy of it.
  const geometry = miniatureGeometry({
    kind,
    rails,
    cards,
    width,
    layout,
    band: flowBandPx,
    flow: flowLive,
  });
  const railPct =
    geometry.rails.left?.basisPct ?? geometry.rails.right?.basisPct ?? 0;
  const blocks = geometry.blocks;
  const flowOverflows = geometry.flow.overflows;
  const flowScale = geometry.flow.scale;

  // The window marks the band over the strip: as wide a share of the drawing as
  // the band is of the strip, standing where the offset has slid the strip
  // under it. At rest — or with no live truth to read — that is flush left.
  //
  // Read from the same guard the geometry used, so the window and the blocks it
  // stands over cannot disagree about whether the strip is the real one.
  const flowFraction =
    flowLive === null || layout !== "flow" || kind === null
      ? 0
      : flowLive.offsetPx / flowLive.bandPx;
  const windowLeft = flowFraction * 100 * flowScale;

  // Which columns are drawn as sliding strips — the signals this drawing has
  // anything to do with. A column that divides rather than overflows has no
  // offset, and a drawing that is not the committed one is a proposal nobody
  // has stood under, so neither listens ([P06]).
  const overflowSlots = !committed
    ? []
    : blocks
        .filter(
          (block) =>
            (
              columnAllocations?.[block.slot] ??
              nominalPlaceAllocation(
                columnSplits?.[block.slot] ?? 1,
                NOMINAL_RUN,
                0,
              )
            ).standing === "overflow",
        )
        .map((block) => block.slot);
  const root = useRef<HTMLSpanElement | null>(null);
  const signature = `${committed ? "live" : "still"}|${layout}|${overflowSlots.join(",")}`;
  // [L03] — the channel is a registration events depend on, so it is claimed in
  // a layout effect and released with it. The registry writes the deck's live
  // numbers straight onto this element and every child inherits them, which is
  // how the drawing moves per frame without React hearing about it ([L06]).
  useLayoutEffect(() => {
    const el = root.current;
    if (el === null || !committed) return;
    const signals: GaugeSignal[] = [
      "flow-offset",
      "drag-frame",
      "drag-zone",
      ...overflowSlots.map(columnOffsetSignal),
    ];
    const releases = signals.map((signal) => registerGauge(signal, el));
    return () => {
      for (const release of releases) release();
    };
    // The signal list is what the effect subscribes to, and `signature` is that
    // list — the slots, the geometry, and whether this drawing is the live one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return (
    <span
      ref={root}
      className="layout-mini"
      data-committed={committed ? "true" : undefined}
      data-layout={layout}
      aria-hidden="true"
    >
      {left > 0 ? (
        <Rail
          count={left}
          widthPct={railPct}
          mode={railModes?.left}
          committed={committed}
          allocation={railAllocations?.left}
        />
      ) : null}
      <span className="layout-mini-field">
        {/* The run: the field's box, and the only thing in the drawing that
            clips. The clip is the affordance an overflowing column depends on —
            its third member is cut in half by running off the bottom — so it
            has to be here, and it must not reach the window. The window stands
            two pixels proud of the cards on purpose, as a bracket around them
            rather than a rect behind them, and inside the clip those two pixels
            were simply cut off: the accent read as a pair of vertical lines
            with their ends sheared. So the clip is the run's and the field is
            the window's, which is also the honest division — a card is in the
            deck, and the window is the frame the deck is seen through. */}
        <span className="layout-mini-run">
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
                  data-band={block.slot % 2 === 0 ? "even" : "odd"}
                  style={{ left: `${block.leftPct}%`, width: `${block.widthPct}%` }}
                />
              );
            }
            // Past two members the column stops dividing and starts scrolling
            // ([P08]), and the drawing says so rather than capping at three: EVERY
            // member is drawn, each at its own comfort span, stacked down a strip
            // that runs off the bottom of the field. The spans are the deck's own
            // heights against the run — the geometry the deck itself resolves —
            // and the card the run's bottom edge cuts IS the affordance saying
            // there is more below.
            const place =
              columnAllocations?.[block.slot] ??
              nominalPlaceAllocation(members, NOMINAL_RUN, 0);
            const overflow = place.standing === "overflow";
            const spans = placeSpanPcts(place, members);
            const fraction = overflow ? (columnOffsets?.[block.slot] ?? 0) : 0;
            const slide = fraction * 100;
            return Array.from({ length: members }, (_, m) => {
              const { top: memberTop, span } = spans[m];
              const top = memberTop - slide;
              // A fraction of the RUN is the whole field's height; the member is
              // `span` percent of it, and a translation is stated in percent of
              // the element being translated. Negative because sliding the strip
              // UP is what a positive offset means. ([P08])
              //
              // THIS member's span, not the strip's first: an overflowing place
              // sizes its members from their own appetites, so they no longer
              // share one height, and one scale over all of them would slide a
              // taller member by less than the strip it belongs to.
              const slideExpr = overflow
                ? slideExpression(
                    columnOffsetSignal(block.slot),
                    fraction,
                    -10000 / span,
                  )
                : null;
              return (
                <span
                  key={`${block.slot}:${m}`}
                  className="layout-mini-block"
                  data-band={block.slot % 2 === 0 ? "even" : "odd"}
                  data-column-member=""
                  data-column-overflow={overflow ? "" : undefined}
                  style={
                    {
                      left: `${block.leftPct}%`,
                      width: `${block.widthPct}%`,
                      top: `${top}%`,
                      bottom: `${100 - top - span}%`,
                      "--mini-slide-y":
                        committed && slideExpr !== null ? slideExpr : undefined,
                    } as React.CSSProperties
                  }
                />
              );
            });
          })}
        </span>
        {flowOverflows ? (
          <span
            className="layout-mini-window"
            style={
              {
                left: `${windowLeft}%`,
                width: `${100 * flowScale}%`,
                // The window IS the band, so a slide of one band moves it by
                // its own width — which makes the scale from "fractions of the
                // band" to "percent of this element" exactly 100, whatever the
                // drawing's size or the strip's scale. The reason the gauge is
                // a fraction, in one number.
                "--mini-slide-x": committed
                  ? slideExpression("flow-offset", flowFraction, 100)
                  : undefined,
              } as React.CSSProperties
            }
          />
        ) : null}
      </span>
      {right > 0 ? (
        <Rail
          count={right}
          widthPct={railPct}
          mode={railModes?.right}
          committed={committed}
          allocation={railAllocations?.right}
        />
      ) : null}
      {/*
        * The drag, drawn. Both stand over the WHOLE drawing rather than inside
        * the field, because a drag crosses rails and gaps as freely as it
        * crosses slots — the gauges state a rect as a fraction of the canvas,
        * and this element is the canvas at another scale. They are rendered
        * once and moved by CSS forever after: their visibility is the
        * channel's attributes and their position is its properties, so a whole
        * drag costs no render at all ([P09]).
        */}
      {committed ? (
        <>
          <span className="layout-mini-ghost" />
          <span className="layout-mini-zone" />
        </>
      ) : null}
    </span>
  );
}
