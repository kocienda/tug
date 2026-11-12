/**
 * gallery-tug-section-label.tsx — `TugSectionLabel` demo tab for the
 * Component Gallery.
 *
 * Shows the label with a name alone and with a qualifier.
 *
 * @module components/tugways/cards/gallery-tug-section-label
 */

import React from "react";

import { TugSectionLabel, type SectionLabel } from "@/components/tugways/tug-section-label";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const NAME_ONLY: SectionLabel = { name: "Recent" };
const QUALIFIED: SectionLabel = { name: "Sessions", qualifier: "this project" };
const LONG: SectionLabel = { name: "Uncommitted changes", qualifier: "attributed to this session" };

export function GalleryTugSectionLabel() {
  return (
    <div className="cg-content" data-testid="gallery-tug-section-label">
      <div className="cg-section">
        <TugLabel className="cg-section-title">Name only</TugLabel>
        <TugSectionLabel label={NAME_ONLY} />
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">Name and qualifier</TugLabel>
        <TugSectionLabel label={QUALIFIED} />
        <TugSectionLabel label={LONG} />
      </div>
    </div>
  );
}
