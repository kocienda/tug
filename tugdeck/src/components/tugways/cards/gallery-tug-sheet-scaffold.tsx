/**
 * gallery-tug-sheet-scaffold.tsx — `TugSheetScaffold` demo tab for the
 * Component Gallery.
 *
 * Shows the scaffold's three regions in a bounded box: a pinned header, a
 * body that scrolls, and a pinned footer — and the body alone.
 *
 * @module components/tugways/cards/gallery-tug-sheet-scaffold
 */

import React from "react";

import { TugSheetScaffold } from "@/components/tugways/tug-sheet-scaffold";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const LINES = Array.from({ length: 16 }, (_, i) => `Body line ${i + 1}`);

const boxStyle: React.CSSProperties = {
  height: "220px",
  maxWidth: "420px",
  display: "flex",
  flexDirection: "column",
  border: "1px solid var(--tug7-element-global-border-normal-default-rest)",
  borderRadius: "8px",
};

export function GalleryTugSheetScaffold() {
  return (
    <div className="cg-content" data-testid="gallery-tug-sheet-scaffold">
      <div className="cg-section">
        <TugLabel className="cg-section-title">Header, scrolling body, footer</TugLabel>
        <div style={boxStyle}>
          <TugSheetScaffold
            header={<TugLabel>Pinned header</TugLabel>}
            footer={<TugPushButton size="sm">Done</TugPushButton>}
          >
            {LINES.map((line) => (
              <TugLabel key={line} size="2xs">{line}</TugLabel>
            ))}
          </TugSheetScaffold>
        </div>
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">Body only</TugLabel>
        <div style={{ ...boxStyle, height: "120px" }}>
          <TugSheetScaffold>
            <TugLabel size="2xs">A scaffold with neither header nor footer is a scrolling body.</TugLabel>
          </TugSheetScaffold>
        </div>
      </div>
    </div>
  );
}
