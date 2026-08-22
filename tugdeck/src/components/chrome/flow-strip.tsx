/**
 * FlowStrip — the deck's own strip, drawn small in the canvas's bottom band.
 *
 * In flow the strip is longer than the band it is seen through, so a reader
 * needs two facts the cards themselves cannot state: what the arrangement IS,
 * and which part of it is on screen right now. This is that instrument, and it
 * draws the arrangement to scale — each slot at its own place in the strip and
 * at its own width, so a wide card reads wide and the run of them reads as the
 * deck, seen small.
 *
 * It is drawn in the slot vocabulary: the numbered chip the Lens's Cards row
 * arranges places with and the masthead badge names one with, elongated.
 * `TugSlotLayout`'s scaled form is exactly that — the same slots, laid out as a
 * map instead of a run — so the three surfaces that talk about places all talk
 * about them the same way.
 *
 * **What is on screen is said by the band, and said continuously** — as a
 * bracket over the strip, and as a pair of veils dimming everything the band
 * does not show. Two drawings of one quantity, from the same two numbers, so
 * they cannot disagree. The bracket alone was not enough: a hairline has to be
 * traced before it can be read, and the fact a reader wants at a glance is
 * simply *which part of this is the part I am looking at*. Brightness answers
 * that without being read at all.
 *
 * Both are continuous, and that is the point. The instrument this replaced said
 * it per-CARD instead, each chip `outlined` while the band showed its slot.
 * That was forced: those chips were a ROW, all the same width, and a row cannot
 * show a reader where a band edge falls. A map can, and a segment half inside
 * the band is half veiled — the truth a per-slot threshold could not tell.
 *
 * **Where the reader is LOOKING and which card the reader is IN are different
 * facts, and they are drawn differently.** The band is the first, and it is
 * neutral ink throughout — the accent would be a lie there, because a viewport
 * is not a selection. The reader's own card is the second, and it takes the
 * accent, because a live selection is exactly what the accent is for. Given no
 * `states` the strip has no selection to draw and is neutral end to end.
 *
 * **It always stands while the layout is flow, and overflow changes its
 * register rather than its existence** ([P10]). A strip that fits the band is
 * drawn quiet, with the bracket withheld because there is no position to state.
 * A strip that overflows raises every ink a step and reveals it. No element
 * appears or disappears across that boundary — a component that materialised
 * when the strip grew would read as a new thing arriving rather than as the
 * same instrument speaking up.
 *
 * Centered in the band. That is not a preference: the host paints its
 * maker-mode build stamps into the bottom-LEFT corner, and a strip centered on
 * the canvas with a ceiling on its width cannot reach a corner. Centering plus
 * the ceiling deletes the clearance problem rather than managing it.
 *
 * Two halves, two zones:
 *
 * - **Structure** — which slots are occupied, how wide each stands, and where
 *   the band was at the last commit — renders from the deck snapshot the canvas
 *   already subscribes to ([L02]). It changes on a commit, which is exactly
 *   when a render is owed.
 * - **Position** — where the band stands *between* commits — rides the gauge
 *   channel, and rides it with NO JS in the loop at all. The root registers as
 *   an element; the bracket and the two veils read the published fraction
 *   straight out of CSS by inheritance, and their own `left` and `width` are
 *   the whole projection. That is only possible because all three are
 *   continuous quantities — a per-slot look would be a THRESHOLD over the same
 *   fraction, and CSS has no comparison that yields one, which is exactly what
 *   made the row of chips this replaced need a listener and a handle to write
 *   looks through. The selection is not on this path at all: which card the
 *   reader is in changes on a commit, so it renders from the snapshot.
 *
 *   The element registration is also what inherits the drag gate the channel
 *   stamps on every registered element.
 *
 * Three gestures move the strip and there is one path for all of them. The
 * canvas wheel is the deck's, untouched here. Clicking a segment CENTERS its
 * slot in the band. And a SCRUB — a pointer down on the strip, dragged across
 * it — centers each segment it crosses as a preview and commits exactly once,
 * at release. Each crossed segment is a whole-slot move under the user's own
 * finger, which is what a paging control does; there is no animator in a
 * preview path ([L13]) and none is wanted.
 *
 * Both gestures CENTER rather than reveal, and they must agree: pointing at a
 * segment names a place, and a rule that moved the least would answer the same
 * click differently depending on where the band already stood — a slot merely
 * visible at the band's edge would stay at the edge. Naming a place should put
 * the reader at it. The clamp pins the strip's two ends flush, so the gesture
 * gives back less travel near an end and none at the very end, which is the
 * correct answer rather than an exception to it.
 *
 * The bracket and the veils take no pointer events: they are readouts drawn
 * over the segments, and a reader aiming at a card should not be caught by the
 * picture of where they already are.
 *
 * Laws: [L02] structure through the deck snapshot; [L03] the gauge and listener
 *       registrations are layout effects with paired teardown; [L06]/[L22]
 *       per-frame appearance is a DOM projection or a published custom
 *       property, never React state; [L07] the scrub's live state is refs;
 *       [L20] the composed slots keep their own tokens.
 */

import React, { useCallback, useLayoutEffect, useMemo, useRef } from "react";

import { gaugeProperties, registerGauge } from "@/lib/imposer-gauges";
import {
  flowCenterOffset,
  IMPOSITION_GAP_PX,
  type FlowStrip as FlowStripModel,
} from "@/lib/layout-imposer";
import { TugSlotLayout } from "@/components/tugways/tug-slot-layout";
import type { TugSlotLayoutHandle } from "@/components/tugways/tug-slot-layout";
import type { TugSlotState } from "@/components/tugways/tug-slot";
import "./flow-strip.css";

/**
 * How far the strip's baseline stands above the canvas bottom — the host's
 * dev-info strip's own inset (`MainWindow.swift`'s `setDevInfo` overlay). The
 * strip shares the band with those stamps, so it shares their line rather than
 * inventing a second one a few pixels off.
 */
const STRIP_INSET_BOTTOM_PX = 8;

/**
 * The corner the stamps are reserved, in px. They are drawn by the host, in a
 * font the deck cannot measure, and they run as long as their branch name — so
 * the clearance is stated rather than measured: a monospaced 10px line of about
 * sixty characters, plus the overlay's own padding and inset.
 *
 * It is a hard floor on the strip's width, not a preference. Centered, the
 * strip reaches half of what it gives up toward each corner, so the ceiling is
 * what keeps it out of both of them on a narrow canvas.
 */
const STAMP_CLEARANCE_PX = 420;

/** The share of the canvas the strip spans, and the ceiling on it. Wide enough
 *  to be read as a map rather than as a row of buttons, bounded so a large
 *  window does not turn the readout into a second deck. */
const STRIP_CANVAS_SHARE = 0.45;
const STRIP_MAX_WIDTH_PX = 460;

/** The property the flow offset crosses the channel on. */
const FLOW_OFFSET_PROPERTY = gaugeProperties("flow-offset")[0];

/**
 * Each slot's place in the strip, as fractions of it — which is what a
 * percentage of the drawn strip means, so the map needs no measurement of
 * itself and stays true through a resize. Every slot the kind defines has a
 * place, an empty one included — the strip holds its room — so the only slot
 * without an entry is one the strip has never heard of.
 */
export function flowSlotSpans(
  count: number,
  strip: FlowStripModel,
): ({ left: number; width: number } | undefined)[] {
  return Array.from({ length: count }, (_, slot) => {
    const left = strip.positions.get(slot);
    const extent = strip.extents.get(slot);
    if (left === undefined || extent === undefined || strip.width <= 0) {
      return undefined;
    }
    return { left: left / strip.width, width: extent / strip.width };
  });
}

export interface FlowStripProps {
  /** How many slots the imposition kind defines — `slotCount(kind)`. */
  count: number;
  /** The deck's one strip — `deckFlowStrip(state)`. */
  strip: FlowStripModel;
  /** The band the strip is seen through, in px — `store.getFlowBandWidth()`. */
  band: number;
  /**
   * Per-slot look, indexed by slot, in `TugSlotLayout`'s own vocabulary.
   *
   * This is where the reader's card is marked, and it is the one place on the
   * strip the accent is spent. That is not a contradiction of the rule above
   * it: the band is where the reader is LOOKING and the veils say that in
   * neutral ink, while this is which card the reader is IN — a live selection,
   * which is precisely what the accent is for.
   */
  states?: readonly TugSlotState[];
  /** Where the band stands in the strip, in px — the COMMITTED offset. Live
   *  motion arrives on the gauge channel instead; this is the fallback the
   *  channel composes against. */
  offset: number;
  /** Draw the strip at `offset` without committing it — the per-frame half of
   *  a scrub. */
  onPreview: (offset: number) => void;
  /** Where the gesture left the strip, and which slot it NAMED getting there.
   *  One store write, at the end. The slot is what the deck rings — a gesture
   *  that points at a place gets the same answer the chord gets. */
  onCommit: (offset: number, slot: number) => void;
}

export function FlowStrip({
  count,
  strip,
  band,
  states,
  offset,
  onPreview,
  onCommit,
}: FlowStripProps): React.JSX.Element {
  const root = useRef<HTMLDivElement | null>(null);
  const layout = useRef<TugSlotLayoutHandle | null>(null);

  /**
   * The committed picture, as the gauge listener needs to read it — a listener
   * registered once for the component's life cannot close over props that
   * change every commit ([L07]).
   */
  const live = useRef({ strip, band, offset });

  /**
   * The scrub, while one is happening: the pointer, the segment the hand went
   * down on, the segment it is over now, and where the strip stands under it.
   * Refs rather than state — a gesture is appearance until it commits ([L06]).
   */
  const scrub = useRef<{
    pointer: number;
    from: number;
    slot: number;
    offset: number;
    moved: boolean;
    /** Each segment's horizontal span, measured when the hand went down. The
     *  strip does not move during a scrub, so measuring once is measuring
     *  right. */
    spans: { slot: number; left: number; right: number }[];
  } | null>(null);

  /** Set when a scrub actually moved the strip, so the click that follows the
   *  release does not commit a second time on top of it. */
  const swallowClick = useRef(false);

  /** Where the strip stands with `slot` in the middle of the band, clamped the
   *  way the store would clamp it — so a previewed frame never shows a position
   *  the commit would refuse. `null` for a slot the strip has no place for at
   *  all, which is a slot outside the kind rather than an empty one: an empty
   *  slot holds its room, so it has a middle like any other.
   *
   *  Centering, not revealing. Pointing at a segment names a place, and the
   *  answer to a named place must not depend on where the band already stands —
   *  the minimal-move rule would leave a slot that is merely visible exactly
   *  where it is, so the same click would move the deck or not depending on
   *  history the reader cannot see. The clamp still pins the two ends flush. */
  const centerOffsetFor = useCallback((slot: number): number | null => {
    const { strip: s, band: b } = live.current;
    const stripLeft = s.positions.get(slot);
    if (stripLeft === undefined) return null;
    return flowCenterOffset({
      stripLeft,
      extent: s.extents.get(slot) ?? 0,
      stripWidth: s.width,
      band: b,
    });
  }, []);

  // The committed truth, refreshed before paint on every commit, for the
  // gesture handlers below — which are bound once and cannot close over props
  // that change every commit ([L07]).
  useLayoutEffect(() => {
    live.current = { strip, band, offset };
  });

  // [L03] — the registration is a subscription, so it is made in a layout
  // effect and torn down with it. Made once for the component's life: the
  // element is stable and the signal does not depend on anything that renders.
  //
  // It is what the BRACKET reads its live offset from, by inheritance, and it
  // also carries the drag gate the channel stamps on every registered element —
  // which takes the strip out of the pointer's way while a card is being
  // dragged over the band.
  useLayoutEffect(() => {
    const el = root.current;
    if (el === null) return;
    return registerGauge("flow-offset", el);
  }, []);

  const spans = useMemo(() => flowSlotSpans(count, strip), [count, strip]);

  const overflow = strip.width > band;
  /**
   * How much of the strip the band shows — the bracket's width as a fraction of
   * the drawn strip, and the factor that turns a gauge reading into a place on
   * it. The channel publishes the offset as a fraction of the BAND and this
   * draws the STRIP, so this one number is the conversion between them.
   * Clamped at 1 so a strip inside its band draws a bracket that fills the
   * drawing rather than one wider than the thing it is inside.
   */
  const bandShare = strip.width > 0 ? Math.min(1, band / strip.width) : 1;
  const committedFraction = band > 0 ? offset / band : 0;

  /** Which segment a client x is over, or the nearest one when the hand has run
   *  off either end — a scrub that leaves the strip keeps scrubbing, which is
   *  what every paging control does. */
  const slotAt = (spansPx: { slot: number; left: number; right: number }[], x: number):
    | number
    | undefined => {
    if (spansPx.length === 0) return undefined;
    for (const span of spansPx) {
      if (x >= span.left && x <= span.right) return span.slot;
    }
    const first = spansPx[0];
    const last = spansPx[spansPx.length - 1];
    return x < first.left ? first.slot : last.slot;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLSpanElement>): void => {
    // Whether the last release's click ever arrived is not something to depend
    // on: under pointer capture a scrub that ended over a different segment may
    // synthesize no click at all. Clearing here means a swallow can never
    // outlive the gesture that asked for it.
    swallowClick.current = false;
    if (event.button !== 0) return;
    const row = layout.current?.element;
    if (row === null || row === undefined) return;
    // Every drawn segment, in slot order. A segment the strip gives no span is
    // rendered undrawn, so its box is empty and it is not a place a hand can be
    // over; an EMPTY slot is not one of those — it holds its room and is
    // scrubbed across like any other place.
    const segments = Array.from(
      row.querySelectorAll<HTMLElement>('[data-slot="tug-slot"]'),
    );
    const spansPx = segments
      .map((segment, slot) => {
        const box = segment.getBoundingClientRect();
        return { slot, left: box.left, right: box.right };
      })
      .filter((span) => span.right > span.left);
    const slot = slotAt(spansPx, event.clientX);
    if (slot === undefined) return;
    row.setPointerCapture(event.pointerId);
    scrub.current = {
      pointer: event.pointerId,
      from: slot,
      slot,
      offset: live.current.offset,
      moved: false,
      spans: spansPx,
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLSpanElement>): void => {
    const gesture = scrub.current;
    if (gesture === null || gesture.pointer !== event.pointerId) return;
    const slot = slotAt(gesture.spans, event.clientX);
    if (slot === undefined || slot === gesture.slot) return;
    gesture.slot = slot;
    const next = centerOffsetFor(slot);
    if (next === null) return;
    gesture.offset = next;
    gesture.moved = true;
    // A preview writes the offset the deck draws at and commits nothing. Each
    // crossed segment is a whole-slot move, arriving instantly: paging under
    // the user's own finger, not a stutter.
    onPreview(next);
  };

  const endScrub = (event: React.PointerEvent<HTMLSpanElement>): void => {
    const gesture = scrub.current;
    if (gesture === null || gesture.pointer !== event.pointerId) return;
    scrub.current = null;
    const row = layout.current?.element;
    if (row != null && row.hasPointerCapture(event.pointerId)) {
      row.releasePointerCapture(event.pointerId);
    }
    if (!gesture.moved) return;
    // The one write of the gesture. The hand left the strip somewhere, and that
    // is where the deck stands now — and the click the release is about to fire
    // must not commit a second answer on top of it.
    swallowClick.current = true;
    onCommit(gesture.offset, gesture.slot);
  };

  /** Clicking a segment centers its slot in the band — the same arithmetic the
   *  Center Card chords commit, so the pointer and the keyboard cannot disagree
   *  about where a named place belongs. */
  const onSelectSlot = (slot: number): void => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    const next = centerOffsetFor(slot);
    if (next === null) return;
    onCommit(next, slot);
  };

  return (
    <div
      ref={root}
      className="flow-strip"
      data-testid="flow-strip"
      data-overflow={overflow ? "true" : "false"}
      style={
        {
          "--flow-strip-inset-bottom": `${STRIP_INSET_BOTTOM_PX}px`,
          "--flow-strip-stamp-clearance": `${STAMP_CLEARANCE_PX}px`,
          "--flow-strip-canvas-share": String(STRIP_CANVAS_SHARE),
          "--flow-strip-max-width": `${STRIP_MAX_WIDTH_PX}px`,
          "--flow-strip-edge-inset": `${IMPOSITION_GAP_PX}px`,
          "--flow-strip-band-share": String(bandShare),
          // Live while a gesture publishes, committed truth otherwise — one
          // expression, resolved by the channel's own `var()` fallback rather
          // than by anything here deciding which of the two is current ([P08]).
          "--flow-strip-offset": `calc(var(${FLOW_OFFSET_PROPERTY}, ${committedFraction}) * var(--flow-strip-band-share))`,
        } as React.CSSProperties
      }
    >
      <div className="flow-strip-frame">
        <TugSlotLayout
          ref={layout}
          className="flow-strip-map"
          data-testid="flow-strip-map"
          count={count}
          spans={spans}
          states={states}
          size="sm"
          onSelectSlot={onSelectSlot}
          slotLabel={(slot) => `Go to slot ${slot + 1}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
        />
        {/* The veils: what the band does not show, dimmed toward the canvas.
            The bracket below says the same fact as a line; this says it as a
            difference in brightness, which is what a glance can read. Both
            rectangles are driven by the bracket's own two numbers, so a strip
            inside its band computes them to zero width and the veil is absent
            without anything deciding it should be ([P10]). */}
        <div className="flow-strip-veil flow-strip-veil-leading" aria-hidden="true" />
        <div className="flow-strip-veil flow-strip-veil-trailing" aria-hidden="true" />
        {/* The band, drawn over the strip. In the DOM at every register so the
            overflow boundary is a change of appearance rather than of
            structure ([P10]), and withheld by CSS while the strip fits — a
            strip wholly on screen has no position to state. */}
        <div
          className="flow-strip-band"
          data-testid="flow-strip-band"
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
