/**
 * gallery-tug-atom-ref.tsx — `TugAtomRef` demo tab for the Component
 * Gallery.
 *
 * Shows each entity kind — a file (bare, at a line, over a range), an arc
 * and a help topic — plus a custom label.
 *
 * @module components/tugways/cards/gallery-tug-atom-ref
 */

import React from "react";

import { TugAtomRef, type TugAtomRefEntity } from "@/components/tugways/tug-atom-ref";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const ENTITIES: { caption: string; entity: TugAtomRefEntity }[] = [
  { caption: "file", entity: { kind: "file", path: "tugdeck/src/components/tugways/tug-badge.tsx" } },
  { caption: "file at a line", entity: { kind: "file", path: "tugdeck/src/main.tsx", line: 42 } },
  {
    caption: "file over a range",
    entity: { kind: "file", path: "tugdeck/src/card-registry.ts", range: { startLine: 140, endLine: 190 } },
  },
  { caption: "arc", entity: { kind: "arc", name: "component-library-consolidation" } },
  { caption: "help", entity: { kind: "help", label: "Keyboard shortcuts" } },
];

const rowStyle: React.CSSProperties = { display: "flex", gap: "12px", alignItems: "center" };

export function GalleryTugAtomRef() {
  return (
    <div className="cg-content" data-testid="gallery-tug-atom-ref">
      <div className="cg-section">
        <TugLabel className="cg-section-title">Entity kinds</TugLabel>
        {ENTITIES.map(({ caption, entity }) => (
          <div key={caption} style={rowStyle}>
            <TugLabel size="2xs" emphasis="calm">{caption}</TugLabel>
            <TugAtomRef entity={entity} />
          </div>
        ))}
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">Custom label</TugLabel>
        <TugAtomRef entity={{ kind: "file", path: "tugdeck/src/main.tsx" }} label="the entry point" />
      </div>
    </div>
  );
}
