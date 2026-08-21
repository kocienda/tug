/**
 * FlowRail — where the deck stands in its own strip, drawn in the bottom band.
 *
 * In flow the chain is longer than the band it is seen through, and until now
 * nothing on the canvas said so: the cards simply ran off the right edge and
 * the only way back was to activate something. The rail is the position
 * readout that was missing, and (with Step 14) the place the strip is moved
 * from.
 *
 * **It always stands while the layout is flow, and overflow changes its
 * register rather than its existence** ([P10]). A strip that fits the band is
 * drawn quiet — ticks and digits, no thumb. A strip that overflows raises the
 * emphasis and reveals the thumb, through a `data-overflow` attribute and CSS
 * alone. The element never mounts or unmounts on that boundary, so widening a
 * card past the band changes how the rail reads, never whether it is there.
 *
 * Two halves, two zones:
 *
 * - **Structure** — which slots are occupied, how wide each stands, and
 *   whether the strip overflows — renders from the deck snapshot the canvas
 *   already subscribes to ([L02]). It changes on a commit, which is exactly
 *   when a render is owed.
 * - **Position** — where the band sits in the strip right now — rides the
 *   gauge channel ([P08]): the root registers for `flow-offset` and the thumb
 *   reads the published property through inheritance. A scroll gesture moves
 *   the thumb with no render at all, and with the committed offset written as
 *   the `var()` fallback the rail is right at rest without a publisher.
 *
 * The registration also buys the drag gate for free: the channel stamps
 * `data-gauge-drag` on every registered element, so the rail drops its pointer
 * events while a zone drag is live (Risk R04) without hearing about the drag
 * in React.
 */

import React, { useLayoutEffect, useRef } from "react";
import { registerGauge, gaugeProperties } from "@/lib/imposer-gauges";
import {
  clampFlowOffset,
  flowRevealOffset,
  IMPOSITION_GAP_PX,
  type FlowStrip,
} from "@/lib/layout-imposer";
import "./flow-rail.css";

/**
 * How far the rail's baseline stands above the canvas bottom, and how tall it
 * is — the host's dev-info strip's own inset and height (`MainWindow.swift`'s
 * `setDevInfo` overlay, 8px up and about 19px tall). The rail shares the band
 * with those stamps, so it shares their line rather than inventing a second
 * one a few pixels off.
 */
const RAIL_INSET_BOTTOM_PX = 8;
const RAIL_HEIGHT_PX = 19;

/**
 * The corner the stamps are reserved, in px. They are drawn by the host, in a
 * font the deck cannot measure, and they run as long as their branch name — so
 * the clearance is stated rather than measured: a monospaced 10px line of
 * about sixty characters, plus the overlay's own padding and inset.
 *
 * It is a hard floor, not a preference: the rail is anchored to the band's
 * right end and takes a share of it, and this is the width that share may
 * never grow into.
 */
const STAMP_CLEARANCE_PX = 420;

/** The share of the band the rail spans, and the ceiling on it. Anchored right
 *  (Spec S03), so a wider canvas gives the rail more of its own end of the
 *  band rather than pushing it toward the stamps. */
const RAIL_BAND_SHARE = 0.45;
const RAIL_MAX_WIDTH_PX = 420;

export interface FlowRailProps {
  /** The deck's one strip ([P09]) — `deckFlowStrip(state)`. */
  strip: FlowStrip;
  /** The band the strip is seen through, in px — `store.getFlowBandWidth()`. */
  band: number;
  /** Where the band stands in the strip, in px — the COMMITTED offset. Live
   *  motion arrives on the gauge channel instead; this is the fallback the
   *  channel composes against. */
  offset: number;
  /** Draw the strip at `offset` without committing it — the per-frame half of
   *  a thumb drag ([P11]). */
  onPreview: (offset: number) => void;
  /** Where the gesture left the strip. One store write, at the end. */
  onCommit: (offset: number) => void;
}

export function FlowRail({
  strip,
  band,
  offset,
  onPreview,
  onCommit,
}: FlowRailProps): React.JSX.Element {
  const root = useRef<HTMLDivElement | null>(null);
  /** The thumb drag, while one is happening: where the strip stood when the
   *  hand went down, where the hand went down, and where the strip is now. Refs
   *  rather than state — a drag is appearance until it commits ([L06]). */
  const drag = useRef<{ pointer: number; origin: number; offset: number } | null>(
    null,
  );

  // [L03] — the registration is a subscription, so it is made in a layout
  // effect and torn down with it. Registered once for the component's life:
  // the element is stable, and the signal it listens to does not depend on
  // anything that renders.
  useLayoutEffect(() => {
    const el = root.current;
    if (el === null) return;
    return registerGauge("flow-offset", el);
  }, []);

  const slots = [...strip.extents.keys()].sort((a, b) => a - b);
  const overflow = strip.width > band;

  // How much of the strip the band shows — the thumb's width as a fraction of
  // the rail, and the factor that turns a gauge reading into a rail position.
  // The channel publishes the offset as a fraction of the BAND ([P08]); the
  // rail draws the STRIP, so the conversion between them is this one number.
  // Clamped at 1 so a strip inside the band draws a thumb that fills the rail
  // rather than one wider than the thing it is inside.
  const bandShare = strip.width > 0 ? Math.min(1, band / strip.width) : 1;
  const committedFraction = band > 0 ? offset / band : 0;
  const offsetProperty = gaugeProperties("flow-offset")[0];

  /** A hand's travel along the rail, in strip pixels: the rail draws the whole
   *  strip, so a pixel of rail is `strip / rail` pixels of deck. Measured off
   *  the rail at gesture time rather than remembered, because the band it is
   *  sized from is a window measurement. */
  const stripPxPerRailPx = (): number => {
    const width = root.current?.clientWidth ?? 0;
    return width > 0 ? strip.width / width : 0;
  };

  const onThumbPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!overflow || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointer: event.pointerId,
      origin: event.clientX,
      offset,
    };
  };

  const onThumbPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const live = drag.current;
    if (live === null || live.pointer !== event.pointerId) return;
    // Clamped every frame with the store's own arithmetic, so the frame never
    // shows an overshoot the commit would refuse ([P11]).
    live.offset = clampFlowOffset(
      live.offset + (event.clientX - live.origin) * stripPxPerRailPx(),
      strip.width,
      band,
    );
    live.origin = event.clientX;
    onPreview(live.offset);
  };

  const endThumbDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const live = drag.current;
    if (live === null || live.pointer !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // The one write of the gesture. Real state, not a preview: the hand let go
    // of the strip somewhere, and that is where the deck stands now.
    onCommit(live.offset);
  };

  /** Clicking a numbered segment reveals that slot — the least the strip can
   *  move to put the whole of it on screen, which is the same arithmetic an
   *  activation reveals with (`_flowRevealOffsetFor`). A slot already fully in
   *  the band computes its own offset back and moves nothing. */
  const onSegmentClick = (slot: number): void => {
    if (!overflow) return;
    onCommit(
      flowRevealOffset({
        stripLeft: strip.positions.get(slot) ?? 0,
        extent: strip.extents.get(slot) ?? 0,
        stripWidth: strip.width,
        band,
        offset,
      }),
    );
  };

  return (
    <div
      ref={root}
      className="flow-rail"
      data-testid="flow-rail"
      data-overflow={overflow ? "true" : "false"}
      style={
        {
          "--flow-rail-inset-bottom": `${RAIL_INSET_BOTTOM_PX}px`,
          "--flow-rail-height": `${RAIL_HEIGHT_PX}px`,
          "--flow-rail-inset-end": `${IMPOSITION_GAP_PX}px`,
          "--flow-rail-stamp-clearance": `${STAMP_CLEARANCE_PX}px`,
          "--flow-rail-band-share-of-canvas": String(RAIL_BAND_SHARE),
          "--flow-rail-max-width": `${RAIL_MAX_WIDTH_PX}px`,
          "--flow-rail-band-share": String(bandShare),
          "--flow-rail-offset": `calc(var(${offsetProperty}, ${committedFraction}) * var(--flow-rail-band-share))`,
        } as React.CSSProperties
      }
    >
      {slots.map((slot) => {
        const left = strip.positions.get(slot) ?? 0;
        const extent = strip.extents.get(slot) ?? 0;
        // Fractions of the strip, which is what a percentage of this element
        // means — the rail is the strip at another scale, so the drawing needs
        // no measurement of itself and stays true through a resize.
        return (
          <button
            key={slot}
            type="button"
            className="flow-rail-segment"
            data-slot={slot}
            // Not a focus stop: the rail is an instrument for the hand, and
            // the keyboard path to a slot is the Lens's Cards control, which
            // is a focus stop and says the same thing in words.
            tabIndex={-1}
            aria-label={`Reveal slot ${slot + 1}`}
            onClick={() => onSegmentClick(slot)}
            style={{
              left: `${(left / strip.width) * 100}%`,
              width: `${(extent / strip.width) * 100}%`,
            }}
          >
            <span className="flow-rail-digit">{slot + 1}</span>
          </button>
        );
      })}
      {/* The band, drawn over the strip: present in the DOM at every register
          so the overflow boundary is a change of appearance rather than of
          structure ([P10]), and hidden by CSS while the strip fits. */}
      <div
        className="flow-rail-thumb"
        data-testid="flow-rail-thumb"
        onPointerDown={onThumbPointerDown}
        onPointerMove={onThumbPointerMove}
        onPointerUp={endThumbDrag}
        onPointerCancel={endThumbDrag}
      />
    </div>
  );
}
