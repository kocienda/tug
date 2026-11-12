/**
 * gallery-tug-link.tsx — `TugLink` demo tab for the Component Gallery.
 *
 * Shows an internal link, an external link with and without its icon, and a
 * link inside running prose.
 *
 * @module components/tugways/cards/gallery-tug-link
 */

import React from "react";

import { TugLink } from "@/components/tugways/tug-link";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

export function GalleryTugLink() {
  return (
    <div className="cg-content" data-testid="gallery-tug-link">
      <div className="cg-section">
        <TugLabel className="cg-section-title">Kinds</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <TugLink href="#gallery">Internal link</TugLink>
          <TugLink href="https://example.com" external>External link</TugLink>
          <TugLink href="https://example.com" external hideExternalIcon>External, icon hidden</TugLink>
        </div>
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">In prose</TugLabel>
        <TugLabel>
          A link sits in a sentence and takes the sentence&apos;s size: read the{" "}
          <TugLink href="https://example.com" external>release notes</TugLink> before updating.
        </TugLabel>
      </div>
    </div>
  );
}
