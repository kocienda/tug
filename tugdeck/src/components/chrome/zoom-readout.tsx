/**
 * ZoomReadout — the number a View › Zoom step is going to, shown the moment
 * the chord lands.
 *
 * A zoom step is a discrete operation whose result is known at dispatch, so
 * the honest feedback is the destination — "90%" — the way Safari's page-zoom
 * pill and the macOS zoom HUDs say it ([B05] of
 * view-zoom-performance-and-feedback). It is raised on the host's "before"
 * notice, which reaches the page ahead of the `pageZoom` write, so the
 * readout is in the very frame that paints the new zoom; and it begins to go
 * on the "after" notice, once the page has painted at the new factor and the
 * work that answers the zoom has landed.
 *
 * # Going, not gone
 *
 * The "after" notice lands two frames past the relayout — a few dozen
 * milliseconds after "before". A readout removed then would be a flicker
 * nobody could read, which is not feedback. So "after" starts the leave and
 * CSS carries it: the readout holds, then fades (`zoom-readout.css`). A
 * second step inside the hold raises it again with the new number, so a
 * double-tap reads as one readout counting.
 *
 * # Appearance through the DOM
 *
 * The element is rendered once; the store's snapshot is written onto it as
 * text and a `data-state` attribute by a subscription, never as React state
 * ([L06]). A zoom therefore commits nothing — which matters here more than
 * anywhere, because the frame the readout must be in is the frame the whole
 * deck relays out in.
 *
 * Laws: [L02] the overlay root enters through `useSyncExternalStore`; [L03]
 * the subscription is a layout effect, live before the first notice can
 * land; [L06]; [L19] `.tsx`/`.css` pair, `data-slot`.
 *
 * @module components/chrome/zoom-readout
 */

import "./zoom-readout.css";

import { type ReactElement, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { useCanvasOverlay } from "@/lib/use-canvas-overlay";
import {
  pageZoomStore,
  type PageZoomSnapshot,
} from "@/lib/page-zoom-store";

/** The readout's three states, as written to `data-state`. */
export type ZoomReadoutState = "hidden" | "shown" | "leaving";

/** "90%" for 0.9. */
export function zoomReadoutText(factor: number): string {
  return `${Math.round(factor * 100)}%`;
}

/**
 * The state the readout moves to on `snapshot`, from `current`. A zoom shows
 * it; settling makes a shown readout leave; a standing factor reported at
 * boot, with no zoom in flight, shows nothing.
 */
export function nextZoomReadoutState(
  current: ZoomReadoutState,
  snapshot: PageZoomSnapshot,
): ZoomReadoutState {
  if (snapshot.phase === "zooming" && snapshot.factor !== null) return "shown";
  return current === "hidden" ? "hidden" : "leaving";
}

export function ZoomReadout(): ReactElement {
  const overlayRoot = useCanvasOverlay();
  const readoutRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = readoutRef.current;
    if (el === null) return;
    const write = (): void => {
      const snapshot = pageZoomStore.getSnapshot();
      const current = (el.dataset.state ?? "hidden") as ZoomReadoutState;
      const next = nextZoomReadoutState(current, snapshot);
      if (next === "shown" && snapshot.factor !== null) {
        el.textContent = zoomReadoutText(snapshot.factor);
      }
      if (next !== current) el.dataset.state = next;
    };
    write();
    return pageZoomStore.subscribe(write);
  }, [overlayRoot]);

  return createPortal(
    <div className="tugx-zoom-readout-anchor" data-slot="zoom-readout-anchor">
      <div
        ref={readoutRef}
        className="tugx-zoom-readout"
        data-slot="zoom-readout"
        data-testid="zoom-readout"
        data-state="hidden"
        role="status"
        aria-live="polite"
      />
    </div>,
    overlayRoot,
  );
}
