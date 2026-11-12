/**
 * gallery-tug-path.tsx — `TugPath` demo tab for the Component Gallery.
 *
 * Shows the middle ellipsis at several widths, and a pinned tail length in
 * place of the filename.
 *
 * @module components/tugways/cards/gallery-tug-path
 */

import React from "react";

import { TugPath } from "@/components/tugways/tug-path";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const PATH = "tugdeck/src/components/tugways/cards/gallery-registrations.tsx";
const WIDTHS = [480, 300, 200, 120];

export function GalleryTugPath() {
  return (
    <div className="cg-content" data-testid="gallery-tug-path">
      <div className="cg-section">
        <TugLabel className="cg-section-title">Widths</TugLabel>
        {WIDTHS.map((width) => (
          <div key={width} style={{ display: "flex", gap: "12px", alignItems: "center" }}>
            <TugLabel size="2xs" emphasis="calm">{`${width}px`}</TugLabel>
            <div style={{ width: `${width}px`, minWidth: 0, display: "flex" }}>
              <TugPath path={PATH} />
            </div>
          </div>
        ))}
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">tailLength</TugLabel>
        {[8, 16].map((tailLength) => (
          <div key={tailLength} style={{ width: "200px", minWidth: 0, display: "flex" }}>
            <TugPath path={PATH} tailLength={tailLength} />
          </div>
        ))}
      </div>
    </div>
  );
}
