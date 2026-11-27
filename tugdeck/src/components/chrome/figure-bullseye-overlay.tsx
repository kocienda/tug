/**
 * figure-bullseye-overlay.tsx — a diagram bullseyed from a card, drawn alone
 * over the whole deck.
 *
 * The target in a diagram's header (`render-chart.ts`) asks the shell to show
 * the figure (`figure-bullseye-store.ts`); this is where it is shown. It is
 * mounted once in the overlay page, above every card, and in the shell's page
 * only where the host keeps no overlay — the same pair Open Quickly mounts in.
 *
 * The figure is drawn again from its spec by the one renderer every door
 * shares, as a **presented** diagram: at its natural width, with its keyed
 * table, scaled down only when the window itself is narrower, and never
 * scrolled sideways. A tall one scrolls down inside the panel. The deck
 * beneath is dimmed by the scrim, and the figure is left by Escape (the
 * focus trap's dismiss), a click on the scrim, or the pressed target in its
 * own header. The panel is a `role="dialog"`, which is what claims the whole
 * window for the overlay and makes its view the key one, so the Escape
 * reaches this page (`overlay-claim.ts`).
 *
 * The figure is annotated with nothing: the overlay has no surface to resolve
 * a location against, so the keyed table shows each location as written.
 *
 * @module components/chrome/figure-bullseye-overlay
 */

import "@/components/tugways/body-kinds/chart-block.css";
import "./figure-bullseye-overlay.css";

import React, { useCallback, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "@/components/tugways/use-focus-trap";
import { renderChartInto } from "@/lib/chart/render-chart";
import {
  closeFigureBullseye,
  getFigureBullseye,
  subscribeFigureBullseye,
  type BullseyeFigure,
} from "@/lib/figure-bullseye-store";
import { useSyncExternalStore } from "@/lib/gesture-scope";

function FigureBullseyePanel({ figure, seq }: { figure: BullseyeFigure; seq: number }): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => closeFigureBullseye(seq), [seq]);
  const { FocusModeScope } = useFocusTrap({ active: true, onEscapeDismiss: close, kbf: false });

  // The figure is DOM the renderer writes, once per show ([L06]); a layout
  // effect, so it is under way before the first paint of the panel.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    void renderChartInto(host, figure.source, { layers: figure.layers, presented: true });
  }, [figure]);

  return (
    <div
      className="tug-figure-bullseye-scrim"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="tug-figure-bullseye-panel" role="dialog" aria-modal="true" aria-label="Diagram at full size">
        <FocusModeScope>
          <div ref={hostRef} className="tugx-chart" />
        </FocusModeScope>
      </div>
    </div>
  );
}

/** Deck-global mount: renders the figure only while one is bullseyed. */
export function FigureBullseyeOverlay(): React.ReactElement | null {
  const { figure, seq } = useSyncExternalStore(subscribeFigureBullseye, getFigureBullseye);
  if (figure === null) return null;
  return createPortal(<FigureBullseyePanel key={seq} figure={figure} seq={seq} />, document.body);
}
