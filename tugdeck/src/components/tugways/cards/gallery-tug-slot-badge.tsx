/**
 * gallery-tug-slot-badge.tsx — `TugSlotBadge` demo tab for the Component
 * Gallery.
 *
 * Shows both kinds at each member position, both tones, and the glyph with
 * and without its level mark.
 *
 * @module components/tugways/cards/gallery-tug-slot-badge
 */

import React from "react";

import {
  TugSlotBadge,
  type TugSlotBadgeKind,
  type TugSlotBadgeTone,
} from "@/components/tugways/tug-slot-badge";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const KINDS: TugSlotBadgeKind[] = ["stack", "split"];
const TONES: TugSlotBadgeTone[] = ["default", "action"];
const COUNT = 3;
const INDICES = [0, 1, 2];

const rowStyle: React.CSSProperties = { display: "flex", gap: "16px", alignItems: "center" };

export function GalleryTugSlotBadge() {
  return (
    <div className="cg-content" data-testid="gallery-tug-slot-badge">
      {TONES.map((tone) => (
        <React.Fragment key={tone}>
          <div className="cg-section">
            <TugLabel className="cg-section-title">{`tone="${tone}"`}</TugLabel>
            {KINDS.map((kind) => (
              <div key={kind} style={rowStyle}>
                <TugLabel size="2xs" emphasis="calm">{kind}</TugLabel>
                {INDICES.map((index) => (
                  <TugSlotBadge key={index} kind={kind} count={COUNT} index={index} tone={tone} />
                ))}
              </div>
            ))}
          </div>
          <TugSeparator />
        </React.Fragment>
      ))}

      <div className="cg-section">
        <TugLabel className="cg-section-title">showLevel=false</TugLabel>
        <div style={rowStyle}>
          {KINDS.map((kind) => (
            <TugSlotBadge key={kind} kind={kind} count={COUNT} index={1} showLevel={false} />
          ))}
        </div>
      </div>
    </div>
  );
}
