/**
 * gallery-tug-step-fraction.tsx — `TugStepFraction` demo tab for the
 * Component Gallery.
 *
 * Shows the fraction from not started through finished.
 *
 * @module components/tugways/cards/gallery-tug-step-fraction
 */

import React from "react";

import { TugStepFraction } from "@/components/tugways/tug-step-fraction";
import { TugLabel } from "@/components/tugways/tug-label";

const FRACTIONS: [number, number][] = [
  [0, 5],
  [2, 5],
  [5, 5],
  [12, 22],
];

export function GalleryTugStepFraction() {
  return (
    <div className="cg-content" data-testid="gallery-tug-step-fraction">
      <div className="cg-section">
        <TugLabel className="cg-section-title">Progress</TugLabel>
        <div style={{ display: "flex", gap: "24px", alignItems: "center" }}>
          {FRACTIONS.map(([current, total]) => (
            <TugStepFraction key={`${current}/${total}`} current={current} total={total} />
          ))}
        </div>
      </div>
    </div>
  );
}
