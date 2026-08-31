/**
 * FlowStrip — the deck's arrangement drawn to scale, as the plan's legend.
 *
 * The plan above draws the deck small: a block per place, at the width that
 * place actually stands at. This is the row of numbers under it. Every segment
 * lands directly beneath the block that is the same card, because both
 * drawings take their geometry from the same `miniatureGeometry` call — the
 * strip does not derive a second set of rects, it consumes the drawing's own
 * `blocks`. The reader's eye runs down from a block to its number.
 *
 * **It stands whenever the plan does — under fit as much as under flow.** A
 * control that looks identical in two arrangements and takes a press in only
 * one of them is a broken control, so the strip is one instrument with one
 * gesture in both, and what the gesture DOES is what the arrangement makes of
 * it:
 *
 * - **Under fit** every place is on screen already. There is nowhere to
 *   travel, so going to a place means raising the card standing there — the
 *   same act as clicking the card itself.
 * - **Under flow** the deck runs past the band, so going to a place means
 *   bringing the band to it: the segment's slot is centred, and a scrub across
 *   the segments pages the deck under the hand.
 *
 * The strip does not decide between those. It reports the slot the gesture
 * named and, when there is somewhere to travel, where the band would have to
 * stand to be at it; `null` for that second number is the strip saying "there
 * is no travel here", which is the whole of the difference and is a fact about
 * the layout rather than a mode the strip is in.
 *
 * So the strip carries what the picture cannot, and nothing else:
 *
 * - **The NUMBERS.** The plan draws blocks; only the strip says which place is
 *   which, in the same numbered chip the Lens's Cards row arranges places with
 *   and the masthead badge names one with.
 * - **The PRESS.**
 * - **Which card the reader is IN**, in the accent — a live selection, which is
 *   what the accent is for.
 *
 * And the plan carries the rest: the window over the strip is drawn once, up
 * there, as the miniature's own bracket. Drawing it a second time here would be
 * two brackets an inch apart saying the same number.
 *
 * **What is on screen is still said here, and said continuously** — as a pair
 * of veils dimming everything the band does not show. A bracket is a hairline
 * and has to be traced before it can be read; the fact a reader wants at a
 * glance is simply *which of these numbers am I looking at*, and brightness
 * answers that without being read at all. Continuous, so a segment half inside
 * the band is half veiled — the truth a per-slot threshold could not tell.
 *
 * **Overflow changes the strip's register rather than its existence** ([P10]),
 * and so does the layout. A fit strip, and a flow strip that fits its band, are
 * drawn quiet: every place is on screen, so there is no position to state and
 * the veils compute to nothing without anything deciding they should. A strip
 * that overflows raises its ink a step. No element appears or disappears across
 * either boundary — a component that materialised when the deck went to flow
 * would read as a new thing arriving rather than as the same instrument
 * speaking up, and it would reflow the panel under the very control that was
 * just pressed to get there.
 *
 * Two halves, two zones:
 *
 * - **Structure** — which slots are occupied, how wide each stands, and where
 *   the band was at the last commit — renders from the deck snapshot the
 *   section already subscribes to ([L02]). It changes on a commit, which is
 *   exactly when a render is owed.
 * - **Position** — where the band stands *between* commits — rides the gauge
 *   channel, and rides it with NO JS in the loop at all. The root registers as
 *   an element; the two veils read the published fraction straight out of CSS
 *   by inheritance, and their own `left` and `width` are the whole projection.
 *   That is only possible because they are continuous quantities — a per-slot
 *   look would be a THRESHOLD over the same fraction, and CSS has no comparison
 *   that yields one, which is exactly what made the row of chips this replaced
 *   need a listener and a handle to write looks through. The selection is not
 *   on this path at all: which card the reader is in changes on a commit, so it
 *   renders from the snapshot.
 *
 *   The element registration is also what inherits the drag gate the channel
 *   stamps on every registered element.
 *
 * Under flow two gestures move the strip and there is one path for both.
 * Clicking a segment CENTERS its slot in the band. And a SCRUB — a pointer
 * down on the strip, dragged across it — centers each segment it crosses as a
 * preview and commits exactly once, at release. Each crossed segment is a
 * whole-slot move under the user's own finger, which is what a paging control
 * does; there is no animator in a preview path ([L13]) and none is wanted. The
 * canvas wheel is the deck's third gesture and is untouched here. Under fit
 * there is no scrub, because there is nothing for a drag to page: the strip is
 * already showing the whole deck.
 *
 * Both gestures CENTER rather than reveal, and they must agree: pointing at a
 * segment names a place, and a rule that moved the least would answer the same
 * click differently depending on where the band already stood — a slot merely
 * visible at the band's edge would stay at the edge. Naming a place should put
 * the reader at it. The clamp pins the strip's two ends flush, so the gesture
 * gives back less travel near an end and none at the very end, which is the
 * correct answer rather than an exception to it.
 *
 * The veils take no pointer events: they are a readout drawn over the segments,
 * and a reader aiming at a card should not be caught by the picture of where
 * they already are.
 *
 * Laws: [L02] structure through the deck snapshot; [L03] the gauge and listener
 *       registrations are layout effects with paired teardown; [L06]/[L22]
 *       per-frame appearance is a DOM projection or a published custom
 *       property, never React state; [L07] the scrub's live state is refs;
 *       [L20] the composed slots keep their own tokens.
 *
 * @module components/layout/flow-strip
 */

import React, { useCallback, useLayoutEffect, useRef } from "react";

import { gaugeProperties, registerGauge } from "@/lib/imposer-gauges";
import {
  flowCenterOffset,
  type FlowStrip as FlowStripModel,
  type SidebarSide,
} from "@/lib/layout-imposer";
import { TugSlotLayout } from "@/components/tugways/tug-slot-layout";
import type { TugSlotLayoutHandle } from "@/components/tugways/tug-slot-layout";
import type { TugSlotState } from "@/components/tugways/tug-slot";
import "./flow-strip.css";

/** The property the flow offset crosses the channel on. */
const FLOW_OFFSET_PROPERTY = gaugeProperties("flow-offset")[0];

/**
 * The live half of a flow deck: the strip the band slides over, how wide the
 * band is, and where it stood at the last commit. `null` under fit, where the
 * band is the whole deck and there is no window to place.
 */
export interface FlowStripTravel {
  /** The deck's one strip — `deckFlowStrip(state)`. */
  strip: FlowStripModel;
  /** The band the strip is seen through, in px — `store.getBandWidth()`. */
  band: number;
  /** Where the band stands in the strip, in px — the COMMITTED offset. Live
   *  motion arrives on the gauge channel instead; this is the fallback the
   *  channel composes against. */
  offset: number;
}

export interface FlowStripProps {
  /** How many slots the imposition kind defines — `slotCount(kind)`. */
  count: number;
  /**
   * Each segment's place in the field, as fractions of it — the plan's own
   * `blocks`, straight out of `miniatureGeometry`.
   *
   * They are not re-derived here and must not be. The drawing above scales its
   * flow blocks to fit the field and gives each one a seam off its right edge
   * so a run of them reads as separate cards rather than one bar; a segment
   * computed honestly from the strip would be wider than the block above it at
   * every right edge, which is the one thing standing the two drawings on top
   * of each other was for.
   */
  spans: readonly ({ left: number; width: number } | undefined)[];
  /**
   * What each side's rail takes of the plan's width, in percent — the same
   * `flex-basis` the drawing's own rail takes, from `miniatureGeometry`. The
   * strip replicates the drawing's flex row so its field is the drawing's
   * field, which is what puts a segment under its block. A side with no rail
   * has no entry and takes no room.
   */
  rails?: Partial<Record<SidebarSide, number>>;
  /**
   * Per-slot look, indexed by slot, in `TugSlotLayout`'s own vocabulary.
   *
   * This is where the reader's card is marked, and it is the one place on the
   * strip the accent is spent. The veils say where the reader is LOOKING and
   * say it in neutral ink; this says which card the reader is IN — a live
   * selection, which is precisely what the accent is for.
   */
  states?: readonly TugSlotState[];
  /** Flow's live half, or `null` under fit. */
  travel: FlowStripTravel | null;
  /** Draw the strip at `offset` without committing it — the per-frame half of
   *  a scrub. Only ever called while `travel` is non-null. */
  onPreview: (offset: number) => void;
  /**
   * Go to the slot the gesture named.
   *
   * `center` is where the band would have to stand to be at it, or `null` when
   * there is nowhere to travel — which is fit, and is the caller's cue that
   * going there means raising the card rather than moving the deck. The strip
   * states both facts and decides neither.
   */
  onGoTo: (slot: number, center: number | null) => void;
}

export function FlowStrip({
  count,
  spans,
  rails,
  states,
  travel,
  onPreview,
  onGoTo,
}: FlowStripProps): React.JSX.Element {
  const root = useRef<HTMLDivElement | null>(null);
  const layout = useRef<TugSlotLayoutHandle | null>(null);

  /**
   * The committed picture, as the gauge listener needs to read it — a listener
   * registered once for the component's life cannot close over props that
   * change every commit ([L07]).
   */
  const live = useRef(travel);

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
   *  the commit would refuse. `null` when there is no travel to be had at all
   *  (fit), and for a slot the strip has no place for, which is a slot outside
   *  the kind rather than an empty one: an empty slot holds its room, so it has
   *  a middle like any other.
   *
   *  Centering, not revealing. Pointing at a segment names a place, and the
   *  answer to a named place must not depend on where the band already stands —
   *  the minimal-move rule would leave a slot that is merely visible exactly
   *  where it is, so the same click would move the deck or not depending on
   *  history the reader cannot see. The clamp still pins the two ends flush. */
  const centerOffsetFor = useCallback((slot: number): number | null => {
    const now = live.current;
    if (now === null) return null;
    const stripLeft = now.strip.positions.get(slot);
    if (stripLeft === undefined) return null;
    return flowCenterOffset({
      stripLeft,
      extent: now.strip.extents.get(slot) ?? 0,
      stripWidth: now.strip.width,
      band: now.band,
    });
  }, []);

  // The committed truth, refreshed before paint on every commit, for the
  // gesture handlers below — which are bound once and cannot close over props
  // that change every commit ([L07]).
  useLayoutEffect(() => {
    live.current = travel;
  });

  // [L03] — the registration is a subscription, so it is made in a layout
  // effect and torn down with it. Made once for the component's life: the
  // element is stable and the signal does not depend on anything that renders.
  //
  // It is what the VEILS read their live offset from, by inheritance, and it
  // also carries the drag gate the channel stamps on every registered element.
  useLayoutEffect(() => {
    const el = root.current;
    if (el === null) return;
    return registerGauge("flow-offset", el);
  }, []);

  const overflow = travel !== null && travel.strip.width > travel.band;
  /**
   * How much of the strip the band shows — as a fraction of the drawn strip,
   * and the factor that turns a gauge reading into a place on it. The channel
   * publishes the offset as a fraction of the BAND and this draws the STRIP, so
   * this one number is the conversion between them. Clamped at 1 so a strip
   * inside its band — and a fit strip, which is its band — veils nothing rather
   * than veiling a negative width.
   */
  const bandShare =
    travel !== null && travel.strip.width > 0
      ? Math.min(1, travel.band / travel.strip.width)
      : 1;
  const committedFraction =
    travel !== null && travel.band > 0 ? travel.offset / travel.band : 0;

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
    // No scrub under fit: a drag pages the deck, and a fit deck has no pages.
    // The click still lands, so a press is a press in both arrangements.
    if (live.current === null) return;
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
    onGoTo(gesture.slot, gesture.offset);
  };

  /** Pressing a segment goes to its slot. Where that is depends on the layout
   *  and the strip does not decide it — the center is passed when there is one,
   *  which is the same arithmetic the Center Card chords commit, so the
   *  pointer and the keyboard cannot disagree about where a named place is. */
  const onSelectSlot = (slot: number): void => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    onGoTo(slot, centerOffsetFor(slot));
  };

  return (
    <div
      ref={root}
      className="flow-strip"
      data-testid="flow-strip"
      data-travel={travel === null ? "false" : "true"}
      data-overflow={overflow ? "true" : "false"}
      style={
        {
          "--flow-strip-band-share": String(bandShare),
          // Live while a gesture publishes, committed truth otherwise — one
          // expression, resolved by the channel's own `var()` fallback rather
          // than by anything here deciding which of the two is current ([P08]).
          "--flow-strip-offset": `calc(var(${FLOW_OFFSET_PROPERTY}, ${committedFraction}) * var(--flow-strip-band-share))`,
        } as React.CSSProperties
      }
    >
      {/* The rails' room, as the drawing gives it — empty spans that take the
          same flex basis the plan's rails take, so what is left over is the
          plan's field and the map lands on it. */}
      {rails?.left !== undefined ? (
        <span
          className="flow-strip-rail"
          style={{ flexBasis: `${rails.left}%` }}
          aria-hidden="true"
        />
      ) : null}
      <div className="flow-strip-field">
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
        {/* The veils: what the band does not show, dimmed toward the panel. The
            plan's own window says the same fact one row up as a bracket; this
            says it as a difference in brightness, which is what a glance can
            read. Both rectangles are driven by the same two numbers, so a strip
            inside its band — and a fit strip, which is its band — computes them
            to zero width and the veil is absent without anything deciding it
            should be ([P10]). */}
        <div className="flow-strip-veil flow-strip-veil-leading" aria-hidden="true" />
        <div className="flow-strip-veil flow-strip-veil-trailing" aria-hidden="true" />
      </div>
      {rails?.right !== undefined ? (
        <span
          className="flow-strip-rail"
          style={{ flexBasis: `${rails.right}%` }}
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}
