/**
 * ControlBar — a modal-capable control band for zone `Z0` ([D97]).
 *
 * The bar sits above a card's scrollable content region and carries
 * card-supplied content (a prompt, a progress indicator, an action set).
 * It can put the card into a **modal** state — `inert` + a scrim over the
 * content region below it — while the bar itself stays above the scrim and
 * fully interactive. This is the *top-anchored* counterpart to `TugSheet`'s
 * centered modal ([recency P09]/[P10], [Q05]).
 *
 * Generic shell ([P10]): the card supplies the content and the `modal`
 * flag; `ControlBar` owns the band layout, the `Z2`-borrowed visual
 * treatment, and the modality mechanism. The region it inerts+scrims is
 * passed as `regionEl` (a sibling element *below* the bar — never the bar
 * itself).
 *
 * Modality = two DOM pieces, both via the shared primitive seam ([Q05]):
 *   - `usePaneInert(regionEl, modal)` — the region becomes a focus/tab
 *     dead zone (shared with `TugSheet`).
 *   - a `data-tug-control-bar-modal` attribute on the region, which this
 *     module's CSS turns into a pointer-blocking scrim overlay.
 *
 * Visibility is the consumer's job, driven through the bar's DOM (the
 * forwarded ref → `data-visible`), never React state ([L06]) — the host
 * toggles it off scroll-edge + store signals, and owns any timing (the
 * progress dwell, the persisting load prompt). The band itself shows/hides
 * instantly. Tuglaws: [L06] (modality + visibility are DOM, not React
 * appearance state), [L03] (applied in layout effects so the dead zone is
 * live before paint), [L20] (the band keeps its own tokens), [L26] (one
 * stable bar node across content swaps).
 *
 * @module components/tugways/cards/control-bar
 */

import "./control-bar.css";

import React from "react";

import { usePaneInert } from "@/components/tugways/use-pane-inert";

export interface ControlBarProps {
  /** When true, the content region (`regionEl`) is inert + scrimmed; the
   *  bar stays above and interactive. */
  modal: boolean;
  /** The scrollable content region the bar sits above — the inert + scrim
   *  target when `modal`. `null` until the host's region mounts. */
  regionEl: HTMLElement | null;
  /** Card-supplied band content (prompt / progress / actions). */
  children: React.ReactNode;
}

/**
 * The `Z0` control band. Forward the ref to drive `data-visible`
 * imperatively from the host's scroll/store signals ([L06]); the band shows
 * (`display:flex`) only while `data-visible="true"`.
 */
export const ControlBar = React.forwardRef<HTMLDivElement, ControlBarProps>(
  function ControlBar({ modal, regionEl, children }, ref) {
    // Focus/tab dead zone over the region while modal (shared primitive).
    usePaneInert(modal ? regionEl : null, modal);

    // Pointer dead zone: the scrim overlay, driven by a DOM attribute on
    // the region ([L06]); CSS in control-bar.css renders the overlay.
    React.useLayoutEffect(() => {
      if (regionEl === null) return;
      if (modal) {
        regionEl.setAttribute("data-tug-control-bar-modal", "");
        return () => regionEl.removeAttribute("data-tug-control-bar-modal");
      }
      regionEl.removeAttribute("data-tug-control-bar-modal");
      return undefined;
    }, [modal, regionEl]);

    return (
      <div
        ref={ref}
        className="tug-control-bar"
        data-slot="tug-control-bar"
        // Default hidden; the host flips `data-visible` per its state
        // machine. Kept as a DOM attribute (not React state) per [L06].
        data-visible="false"
      >
        {children}
      </div>
    );
  },
);
