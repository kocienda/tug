/**
 * TugStableOverlay — width/height-stabilizing overlay primitive.
 *
 * Stacks an `active` variant and one or more hidden `alternates` in a single
 * CSS-grid cell. The cell sizes to the max-content of every variant, so the
 * visible `active` paints while the alternates stay `visibility: hidden` but
 * still hold their footprint. The result: the box's intrinsic size is stable
 * across a swap between any of the variants — the smallest CSS primitive that
 * means "stack these and size to the widest/tallest."
 *
 * Shared by the controls that swap their face in place:
 *   - `TugButton` — label / icon-text-cluster swap (`widthStabilize`).
 *   - `TugBadge`  — two-line route-face swap (`widthStabilize`).
 *
 * Why grid, not absolute positioning: an absolutely-positioned alternate
 * leaves layout flow, so the cell would size to `active` only — defeating the
 * mechanism. Grid keeps every variant in flow at the same `grid-area`.
 *
 * ## High-water mark — re-stabilize larger, never shrink
 *
 * The declared variants set the *baseline* reservation. But a live `active`
 * value can exceed every alternate (an unanticipated label longer than the
 * sizers). When that happens the cell must **grow to fit and stay grown** — a
 * subsequent narrower value must not let it shrink back, or the box reflows on
 * the way down. So the overlay tracks the widest content it has ever held and
 * pins a `min-width` to it (monotonic). The reservation only ever increases:
 * stabilization that re-stabilizes larger ex-post-facto. Pure DOM — a
 * `ResizeObserver` measures and a `min-width` is written directly, no React
 * state ([L06] appearance via DOM, [L22] observe/mutate without a render).
 *
 * Laws: [L06] appearance via CSS/DOM, [L19] file pair, [L20] owns only its own
 * layout box — the variants it wraps keep their own tokens.
 *
 * @module components/tugways/internal/tug-stable-overlay
 */

import "./tug-stable-overlay.css";

import React from "react";
import { cn } from "@/lib/utils";

export interface TugStableOverlayProps extends Omit<React.ComponentPropsWithoutRef<"span">, "children"> {
  /** The visible variant — the one that paints and receives interaction. */
  active: React.ReactNode;
  /**
   * Hidden variants that hold layout footprint so the cell reserves the
   * widest/tallest of all variants. Rendered `visibility: hidden` +
   * `aria-hidden` + `pointer-events: none`.
   */
  alternates: React.ReactNode[];
  /** The overlay root's `data-slot`. @default "tug-stable-overlay" */
  "data-slot"?: string;
}

/**
 * Overlays `active` over `alternates` in one grid cell, sizing to the widest.
 * See the module docstring for the mechanism and the contract.
 */
export const TugStableOverlay = React.forwardRef<HTMLSpanElement, TugStableOverlayProps>(function TugStableOverlay(
  { active, alternates, className, "data-slot": dataSlot = "tug-stable-overlay", ...rest },
  ref,
) {
  // Width/height stabilization is pure CSS: the active variant and the
  // hidden alternates share one grid cell (`grid-area: stable`), so the
  // box intrinsically sizes to the widest/tallest variant before paint —
  // no JS measurement needed. The previous `offsetWidth`-reading
  // `measure()` + `min-width` pin only added a monotonic never-shrink for
  // variants whose own content changes width at runtime; every consumer
  // keeps both fixed-content faces in the cell, so the grid alone is
  // exact. Reading `offsetWidth` per instance forced a synchronous reflow
  // and, interleaved across hundreds of overlays in a growing transcript
  // DOM, dominated load time (O(N²) layout thrash) — hence its removal.

  return (
    <span {...rest} ref={ref} className={cn("tug-stable-overlay", className)} data-slot={dataSlot}>
      <span className="tug-stable-overlay-variant" data-tug-stable="active">
        {active}
      </span>
      {alternates.map((alt, i) => (
        <span
          // Alternates are positional + hidden sizers; index keys are stable
          // for this fixed-order list.
          key={i}
          className="tug-stable-overlay-variant"
          data-tug-stable="alternate"
          aria-hidden="true"
        >
          {alt}
        </span>
      ))}
    </span>
  );
});
