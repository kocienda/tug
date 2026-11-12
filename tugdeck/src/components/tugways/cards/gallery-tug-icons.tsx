/**
 * gallery-tug-icons.tsx — Tug's own glyph set, as a Component Gallery tab.
 *
 * Shows every glyph in `TUG_ICON_NODES` at several sizes, and the drop-in
 * glyph components called like a lucide icon.
 *
 * @module components/tugways/cards/gallery-tug-icons
 */

import React from "react";

import { Operator, TUG_ICON_NODES } from "@/components/tugways/tug-icons";
import { TugSpriteIcon } from "@/components/tugways/tug-sprite-icon";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const SIZES = [12, 16, 24, 32];
const ENTRIES = Object.entries(TUG_ICON_NODES);

const rowStyle: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "center" };

export function GalleryTugIcons() {
  return (
    <div className="cg-content" data-testid="gallery-tug-icons">
      <div className="cg-section">
        <TugLabel className="cg-section-title">The glyph registry</TugLabel>
        {ENTRIES.map(([name, node]) => (
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
        <TugLabel className="cg-section-title">Drop-in components</TugLabel>
        <div style={rowStyle}>
          <Operator size={16} />
          <Operator size={24} />
          <TugLabel size="2xs" emphasis="calm">{"<Operator size={…} />"}</TugLabel>
        </div>
      </div>
    </div>
  );
}
