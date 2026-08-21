/**
 * FlowDots — which slots the deck exists in, and which of them the band shows.
 *
 * In flow the strip is longer than the band it is seen through, so a reader
 * needs two facts the cards themselves cannot state: how many places there are,
 * and which of them are on screen right now. That is the whole content of this
 * instrument, and it is drawn as the same numbered chip the Lens's Cards row
 * arranges slots with — `TugSlotLayout` in its control form, since a chip is
 * clickable.
 *
 * It draws every slot the kind defines, not only the occupied ones. An
 * unoccupied slot is never "in the band" in any useful sense, so it rests — and
 * a rested empty slot is indistinguishable from a rested occupied one that is
 * off screen. That cost is accepted: the Lens already numbers all `count` slots,
 * and a sparse numbering here would read as a second vocabulary for the same
 * places.
 *
 * Two resting looks and no accent. `outlined` is a slot the band is showing;
 * `rest` is everything else. The card on top is already obvious — it is the one
 * the eye is on — so a third register would spend an accent restating what the
 * deck is already saying.
 *
 * Centered in the canvas's bottom band. That is not a preference: the host
 * paints its maker-mode build stamps into the bottom-LEFT corner, and at most
 * six chips centered on the canvas cannot reach a corner. Centering deletes the
 * clearance problem rather than managing it with a number nobody measured.
 *
 * Two halves, two zones:
 *
 * - **Structure** — how many slots there are, which are occupied, and where the
 *   band stands at the last commit — renders from the deck snapshot the canvas
 *   already subscribes to ([L02]). It changes on a commit, which is exactly when
 *   a render is owed.
 * - **Position** — which slots the band is showing *between* commits — rides the
 *   gauge channel. The root registers as an element, which is what inherits the
 *   drag gate; the live looks take the same signal as a LISTENER, because "is
 *   this slot in the band" is a threshold over the published fraction and CSS
 *   has no comparison that yields one. The derived looks go onto the chips
 *   through `TugSlotLayout`'s own handle, so nothing outside the primitive
 *   writes a token it does not own ([L20]).
 *
 * Three gestures move the strip and there is one path for all of them. The
 * canvas wheel is the deck's, untouched here. Clicking a chip reveals its slot.
 * And a SCRUB — a pointer down on the row, dragged across it — previews each
 * chip it crosses and commits exactly once, at release. Each crossed chip is a
 * whole-slot move under the user's own finger, which is what a paging control
 * does; there is no animator in a preview path ([L13]) and none is wanted.
 *
 * Laws: [L02] structure through the deck snapshot; [L03] the gauge and listener
 *       registrations are layout effects with paired teardown; [L06]/[L22]
 *       per-frame appearance is a DOM projection, never React state; [L07] the
 *       scrub's live state is refs; [L20] the composed slots keep their own
 *       tokens.
 */

import React, { useCallback, useLayoutEffect, useMemo, useRef } from "react";

import {
  gaugeProperties,
  registerGauge,
  registerGaugeListener,
} from "@/lib/imposer-gauges";
import {
  clampFlowOffset,
  flowRevealOffset,
  slotsInBand,
  type FlowStrip,
} from "@/lib/layout-imposer";
import { TugSlotLayout } from "@/components/tugways/tug-slot-layout";
import type { TugSlotLayoutHandle } from "@/components/tugways/tug-slot-layout";
import type { TugSlotState } from "@/components/tugways/tug-slot";
import "./flow-dots.css";

/**
 * How far the dots' baseline stands above the canvas bottom — the host's
 * dev-info strip's own inset (`MainWindow.swift`'s `setDevInfo` overlay). The
 * dots share the band with those stamps, so they share their line rather than
 * inventing a second one a few pixels off.
 */
const DOTS_INSET_BOTTOM_PX = 8;

/** The property the flow offset crosses the channel on. */
const FLOW_OFFSET_PROPERTY = gaugeProperties("flow-offset")[0];

/** The looks for every slot the kind defines, in slot order. */
export function flowDotStates(
  count: number,
  showing: ReadonlySet<number>,
): TugSlotState[] {
  return Array.from({ length: count }, (_, slot) =>
    showing.has(slot) ? "outlined" : "rest",
  );
}

export interface FlowDotsProps {
  /** How many slots the imposition kind defines — `slotCount(kind)`. */
  count: number;
  /** The deck's one strip — `deckFlowStrip(state)`. */
  strip: FlowStrip;
  /** The band the strip is seen through, in px — `store.getFlowBandWidth()`. */
  band: number;
  /** Where the band stands in the strip, in px — the COMMITTED offset. Live
   *  motion arrives on the gauge channel instead. */
  offset: number;
  /** Draw the strip at `offset` without committing it — the per-frame half of
   *  a scrub. */
  onPreview: (offset: number) => void;
  /** Where the gesture left the strip. One store write, at the end. */
  onCommit: (offset: number) => void;
}

export function FlowDots({
  count,
  strip,
  band,
  offset,
  onPreview,
  onCommit,
}: FlowDotsProps): React.JSX.Element {
  const root = useRef<HTMLDivElement | null>(null);
  const layout = useRef<TugSlotLayoutHandle | null>(null);

  /**
   * The committed picture, as the gauge listener needs to read it — a listener
   * registered once for the component's life cannot close over props that
   * change every commit ([L07]).
   */
  const live = useRef({ count, strip, band, offset });

  /**
   * The scrub, while one is happening: the pointer, the chip the hand went down
   * on, the chip it is over now, and where the strip stands under it. Refs
   * rather than state — a gesture is appearance until it commits ([L06]).
   */
  const scrub = useRef<{
    pointer: number;
    from: number;
    slot: number;
    offset: number;
    moved: boolean;
    /** Each chip's horizontal span, measured when the hand went down. The row
     *  does not move during a scrub, so measuring once is measuring right. */
    spans: { slot: number; left: number; right: number }[];
  } | null>(null);

  /** Set when a scrub actually moved the strip, so the click that follows the
   *  release does not commit a second time on top of it. */
  const swallowClick = useRef(false);

  /** The least the strip can move to put the whole of `slot` on screen, clamped
   *  the way the store would clamp it — so a previewed frame never shows a
   *  position the commit would refuse. `null` for a slot with no card in it:
   *  there is nothing to reveal. */
  const revealOffsetFor = useCallback((slot: number): number | null => {
    const { strip: s, band: b, offset: o } = live.current;
    const stripLeft = s.positions.get(slot);
    if (stripLeft === undefined) return null;
    return clampFlowOffset(
      flowRevealOffset({
        stripLeft,
        extent: s.extents.get(slot) ?? 0,
        stripWidth: s.width,
        band: b,
        offset: o,
      }),
      s.width,
      b,
    );
  }, []);

  /**
   * The live projection. The channel publishes the offset as a fraction of the
   * BAND, so the band this component holds is what turns it back into pixels;
   * the in-band set then comes from `slotsInBand` — the same call the render
   * makes, so the committed picture and the live one cannot part company.
   *
   * A retirement (`null`) is not projected. The signal going away means the
   * gesture is over, and the commit that ends it re-renders the truth.
   */
  const project = useCallback(
    (values: ReadonlyMap<string, string> | null): void => {
      if (values === null) return;
      const raw = values.get(FLOW_OFFSET_PROPERTY);
      if (raw === undefined) return;
      const fraction = Number(raw);
      if (!Number.isFinite(fraction)) return;
      const { count: n, strip: s, band: b } = live.current;
      layout.current?.setStates(
        flowDotStates(n, slotsInBand({ strip: s, band: b, offset: fraction * b })),
      );
    },
    [],
  );

  // The committed truth, refreshed before paint on every commit — and before
  // the registration effect below, so a listener primed at mount reads the
  // picture this render just drew rather than the one before it.
  useLayoutEffect(() => {
    live.current = { count, strip, band, offset };
  });

  // [L03] — both registrations are subscriptions, so they are made in a layout
  // effect and torn down with it. Made once for the component's life: the
  // element is stable and the signal does not depend on anything that renders.
  //
  // The element registration draws no property here. It is for the drag gate
  // the channel stamps on every registered element, which takes the dots out of
  // the pointer's way while a card is being dragged over the band.
  useLayoutEffect(() => {
    const el = root.current;
    if (el === null) return;
    const releaseElement = registerGauge("flow-offset", el);
    const releaseListener = registerGaugeListener("flow-offset", project);
    return () => {
      releaseListener();
      releaseElement();
    };
  }, [project]);

  // The committed picture. The live one is written onto these same chips by the
  // listener above, and every commit re-renders over it with the newer reading.
  const states = useMemo(
    () => flowDotStates(count, slotsInBand({ strip, band, offset })),
    [count, strip, band, offset],
  );

  /** Which chip a client x is over, or the nearest one when the hand has run
   *  off either end of the row — a scrub that leaves the row keeps scrubbing,
   *  which is what every paging control does. */
  const slotAt = (spans: { slot: number; left: number; right: number }[], x: number):
    | number
    | undefined => {
    if (spans.length === 0) return undefined;
    for (const span of spans) {
      if (x >= span.left && x <= span.right) return span.slot;
    }
    const first = spans[0];
    const last = spans[spans.length - 1];
    return x < first.left ? first.slot : last.slot;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLSpanElement>): void => {
    // Whether the last release's click ever arrived is not something to depend
    // on: under pointer capture a scrub that ended over a different chip may
    // synthesize no click at all. Clearing here means a swallow can never
    // outlive the gesture that asked for it.
    swallowClick.current = false;
    if (event.button !== 0) return;
    const row = layout.current?.element;
    if (row === null || row === undefined) return;
    const chips = Array.from(
      row.querySelectorAll<HTMLElement>('[data-slot="tug-slot"]'),
    );
    const spans = chips.map((chip, slot) => {
      const box = chip.getBoundingClientRect();
      return { slot, left: box.left, right: box.right };
    });
    const slot = slotAt(spans, event.clientX);
    if (slot === undefined) return;
    row.setPointerCapture(event.pointerId);
    scrub.current = {
      pointer: event.pointerId,
      from: slot,
      slot,
      offset: live.current.offset,
      moved: false,
      spans,
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLSpanElement>): void => {
    const gesture = scrub.current;
    if (gesture === null || gesture.pointer !== event.pointerId) return;
    const slot = slotAt(gesture.spans, event.clientX);
    if (slot === undefined || slot === gesture.slot) return;
    gesture.slot = slot;
    const next = revealOffsetFor(slot);
    if (next === null) return;
    gesture.offset = next;
    gesture.moved = true;
    // A preview writes the offset the deck draws at and commits nothing. Each
    // crossed chip is a whole-slot move, arriving instantly: paging under the
    // user's own finger, not a stutter.
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
    onCommit(gesture.offset);
  };

  /** Clicking a chip reveals its slot — the same arithmetic an activation
   *  reveals with. A slot already wholly in the band computes its own offset
   *  back and moves nothing; an unoccupied slot has nothing to reveal. */
  const onSelectSlot = (slot: number): void => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    const next = revealOffsetFor(slot);
    if (next === null) return;
    onCommit(next);
  };

  return (
    <div
      ref={root}
      className="flow-dots"
      data-testid="flow-dots"
      style={
        {
          "--flow-dots-inset-bottom": `${DOTS_INSET_BOTTOM_PX}px`,
        } as React.CSSProperties
      }
    >
      <TugSlotLayout
        ref={layout}
        count={count}
        states={states}
        size="sm"
        onSelectSlot={onSelectSlot}
        slotLabel={(slot) => `Reveal slot ${slot + 1}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
      />
    </div>
  );
}
