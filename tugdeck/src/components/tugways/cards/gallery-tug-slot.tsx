/**
 * gallery-tug-slot.tsx — `TugSlot` demo tab for the Component Gallery.
 *
 * Shows the exemplar form in each state and size, and the disabled look.
 *
 * @module components/tugways/cards/gallery-tug-slot
 */

import React from "react";

import { TugSlot, type TugSlotSize, type TugSlotState } from "@/components/tugways/tug-slot";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const STATES: TugSlotState[] = ["rest", "outlined", "filled"];
const SIZES: TugSlotSize[] = ["sm", "md"];

const rowStyle: React.CSSProperties = { display: "flex", gap: "8px", alignItems: "center" };

export function GalleryTugSlot() {
  return (
    <div className="cg-content" data-testid="gallery-tug-slot">
      {SIZES.map((size) => (
        <React.Fragment key={size}>
          <div className="cg-section">
            <TugLabel className="cg-section-title">{`size="${size}"`}</TugLabel>
            <div style={rowStyle}>
              {STATES.map((state, i) => (
                <TugSlot key={state} number={i} state={state} size={size} aria-label={`Slot ${i + 1}, ${state}`} />
              ))}
            </div>
          </div>
          <TugSeparator />
        </React.Fragment>
      ))}

      <div className="cg-section">
        <TugLabel className="cg-section-title">Disabled</TugLabel>
        <div style={rowStyle}>
          {STATES.map((state, i) => (
            <TugSlot key={state} number={i} state={state} disabled aria-label={`Slot ${i + 1}, disabled`} />
          ))}
        </div>
      </div>
    </div>
  );
}
