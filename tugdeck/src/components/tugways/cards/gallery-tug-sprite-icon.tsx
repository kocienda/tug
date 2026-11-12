/**
 * gallery-tug-sprite-icon.tsx — `TugSpriteIcon` demo tab for the Component
 * Gallery.
 *
 * Shows sprite-backed lucide glyphs at several sizes, and many instances of
 * one glyph sharing a single `<symbol>`.
 *
 * @module components/tugways/cards/gallery-tug-sprite-icon
 */

import React from "react";
import {
  Check as checkIconNode,
  CircleStop as circleStopIconNode,
  CloudUpload as cloudUploadIconNode,
} from "lucide";

import { TugSpriteIcon, type LucideIconNode } from "@/components/tugways/tug-sprite-icon";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const GLYPHS: { name: string; node: LucideIconNode }[] = [
  { name: "check", node: checkIconNode as LucideIconNode },
  { name: "circle-stop", node: circleStopIconNode as LucideIconNode },
  { name: "cloud-upload", node: cloudUploadIconNode as LucideIconNode },
];
const SIZES = [12, 16, 24, 32];
const MANY = Array.from({ length: 40 }, (_, i) => i);

const rowStyle: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "center" };

export function GalleryTugSpriteIcon() {
  return (
    <div className="cg-content" data-testid="gallery-tug-sprite-icon">
      <div className="cg-section">
        <TugLabel className="cg-section-title">Sizes</TugLabel>
        {GLYPHS.map(({ name, node }) => (
          <div key={name} style={rowStyle}>
            <TugLabel size="2xs" emphasis="calm">{name}</TugLabel>
            {SIZES.map((size) => (
              <TugSpriteIcon key={size} name={name} node={node} size={size} />
            ))}
          </div>
        ))}
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">Forty instances, one symbol</TugLabel>
        <div style={rowStyle}>
          {MANY.map((i) => (
            <TugSpriteIcon key={i} name="check" node={checkIconNode as LucideIconNode} size={16} />
          ))}
        </div>
      </div>
    </div>
  );
}
