/**
 * gallery-tug-column-badge.tsx — `TugColumnBadge` demo tab for the Component
 * Gallery.
 *
 * Shows both kinds at each member position, both tones, and the glyph with
 * and without its level mark.
 *
 * @module components/tugways/cards/gallery-tug-column-badge
 */

import React from "react";

import {
  TugColumnBadge,
  type TugColumnBadgeKind,
  type TugColumnBadgeTone,
} from "@/components/tugways/tug-column-badge";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const KINDS: TugColumnBadgeKind[] = ["stack", "split"];
const TONES: TugColumnBadgeTone[] = ["default", "action"];
const COUNT = 3;
const INDICES = [0, 1, 2];

const rowStyle: React.CSSProperties = { display: "flex", gap: "16px", alignItems: "center" };

export function GalleryTugColumnBadge() {
  return (
    <div className="cg-content" data-testid="gallery-tug-column-badge">
      {TONES.map((tone) => (
        <React.Fragment key={tone}>
          <div className="cg-section">
            <TugLabel className="cg-section-title">{`tone="${tone}"`}</TugLabel>
            {KINDS.map((kind) => (
              <div key={kind} style={rowStyle}>
                <TugLabel size="2xs" emphasis="calm">{kind}</TugLabel>
                {INDICES.map((index) => (
                  <TugColumnBadge key={index} kind={kind} count={COUNT} index={index} tone={tone} />
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
            <TugColumnBadge key={kind} kind={kind} count={COUNT} index={1} showLevel={false} />
          ))}
        </div>
      </div>
    </div>
  );
}
