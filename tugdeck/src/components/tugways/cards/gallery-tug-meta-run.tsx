/**
 * gallery-tug-meta-run.tsx — `TugMetaRun` demo tab for the Component
 * Gallery.
 *
 * Shows both separators and both fits.
 *
 * @module components/tugways/cards/gallery-tug-meta-run
 */

import React from "react";

import { TugMetaRun } from "@/components/tugways/tug-meta-run";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const PARTS: React.ReactNode[] = ["main", "4 files", "+120 −8", "2 minutes ago"];
const LONG_PARTS: React.ReactNode[] = [
  "component-library-consolidation",
  "22 steps",
  "a long run of metadata that will not fit its box",
  "yesterday",
];

export function GalleryTugMetaRun() {
  return (
    <div className="cg-content" data-testid="gallery-tug-meta-run">
      <div className="cg-section">
        <TugLabel className="cg-section-title">Separators</TugLabel>
        <TugMetaRun parts={PARTS} separator="gap" />
        <TugMetaRun parts={PARTS} separator="bullet" />
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">Fit, in a narrow box</TugLabel>
        <div style={{ width: "220px", display: "flex", flexDirection: "column", gap: "6px" }}>
          <TugMetaRun parts={LONG_PARTS} separator="bullet" fit="natural" />
          <TugMetaRun parts={LONG_PARTS} separator="bullet" fit="clip" />
        </div>
      </div>
    </div>
  );
}
