/**
 * gallery-tug-jump-to-bottom-button.tsx — `TugJumpToBottomButton` demo tab
 * for the Component Gallery.
 *
 * The button is absolutely positioned and its host owns its visibility
 * through `data-visible`, so the demo gives it a positioned box and shows it
 * shown and hidden. Its press dispatches `last-turn` to the parent responder;
 * this card registers none, so the press is inert here.
 *
 * @module components/tugways/cards/gallery-tug-jump-to-bottom-button
 */

import React from "react";

import { TugJumpToBottomButton } from "@/components/tugways/tug-jump-to-bottom-button";
import { TugLabel } from "@/components/tugways/tug-label";

const boxStyle: React.CSSProperties = {
  position: "relative",
  width: "240px",
  height: "96px",
  border: "1px dashed var(--tug7-element-global-border-normal-default-rest)",
  borderRadius: "6px",
};

export function GalleryTugJumpToBottomButton() {
  return (
    <div className="cg-content" data-testid="gallery-tug-jump-to-bottom-button">
      <div className="cg-section">
        <TugLabel className="cg-section-title">data-visible</TugLabel>
        <div style={{ display: "flex", gap: "16px" }}>
          {(["true", "false"] as const).map((visible) => (
            <div key={visible} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <TugLabel size="2xs" emphasis="calm">{`data-visible="${visible}"`}</TugLabel>
              <div style={boxStyle}>
                <TugJumpToBottomButton data-visible={visible} aria-label="Jump to latest" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
