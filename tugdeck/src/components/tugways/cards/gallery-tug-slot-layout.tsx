/**
 * gallery-tug-slot-layout.tsx — `TugSlotLayout` demo tab for the Component
 * Gallery.
 *
 * Shows the layout's forms with the exemplar look: a run of equal chips
 * with per-slot states, both sizes, a map drawn to scale with `spans`, and
 * a slice drawn through `window`.
 *
 * @module components/tugways/cards/gallery-tug-slot-layout
 */

import React from "react";

import { TugSlotLayout } from "@/components/tugways/tug-slot-layout";
import type { TugSlotState } from "@/components/tugways/tug-slot";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const STATES: TugSlotState[] = ["rest", "filled", "outlined", "rest"];
const SPANS = [
  { left: 0, width: 0.2 },
  { left: 0.2, width: 0.5 },
  { left: 0.7, width: 0.3 },
];

export function GalleryTugSlotLayout() {
  return (
    <div className="cg-content" data-testid="gallery-tug-slot-layout">
      <div className="cg-section">
        <TugLabel className="cg-section-title">Run — count and states</TugLabel>
        <TugSlotLayout count={4} states={STATES} size="md" />
        <TugSlotLayout count={4} states={STATES} size="sm" />
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">Map — spans drawn to scale</TugLabel>
        <div style={{ width: "320px" }}>
          <TugSlotLayout count={3} states={["rest", "filled", "rest"]} spans={SPANS} />
        </div>
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">Slice — window of 3 over 8</TugLabel>
        {[0, 4, 7].map((centre) => (
          <TugSlotLayout
            key={centre}
            count={8}
            states={Array.from({ length: 8 }, (_, i): TugSlotState => (i === centre ? "filled" : "rest"))}
            window={{ centre, size: 3 }}
          />
        ))}
      </div>
    </div>
  );
}
