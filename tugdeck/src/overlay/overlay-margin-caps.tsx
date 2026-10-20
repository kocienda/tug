/**
 * The margin caps, drawn in the overlay above every card.
 *
 * A cap is the strip at the window's edge a rail leaves bare, painted as the
 * deck's own ground, so a flow card's ink stops there by occlusion rather
 * than by a cut (`margin-cap.css`). The cards stand over the shell's page, so
 * the shell's caps are beneath them and cover nothing; these, from the widths
 * the shell relays (`overlay.marginCaps`), are the ones that are seen. They
 * stand in this page's own `#deck-container`, which View › Zoom scales as the
 * shell's is, so the same classes and the same width draw the same ground in
 * phase with the shell's grid. They take no press: the overlay passes every
 * point outside its claim to the card or the canvas beneath.
 *
 * @module overlay/overlay-margin-caps
 */

import React from "react";
import { useSyncExternalStore } from "../lib/gesture-scope";
import { overlayMarginCaps } from "../bus/declarations/overlay";
import "../components/tugways/tug-pane.css";
import "../components/chrome/margin-cap.css";

export function OverlayMarginCaps(): React.ReactElement {
  const caps = useSyncExternalStore(overlayMarginCaps.subscribe, overlayMarginCaps.getSnapshot);
  return (
    <div className="overlay-margin-caps" aria-hidden="true">
      {(["left", "right"] as const).map((side) => {
        const width = caps[side];
        if (width <= 0) return null;
        return (
          <div
            key={side}
            className={`tug-margin-cap tug-margin-cap--${side}`}
            data-margin-cap={side}
            style={{ width: `${width}px`, "--tugx-margin-cap-width": `${width}px` } as React.CSSProperties}
          />
        );
      })}
    </div>
  );
}
