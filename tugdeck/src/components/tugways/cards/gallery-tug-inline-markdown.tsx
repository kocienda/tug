/**
 * gallery-tug-inline-markdown.tsx — `TugInlineMarkdown` demo tab for the
 * Component Gallery.
 *
 * Shows each inline run the component renders — code, strong, emphasis and
 * their nesting — inside a line of text.
 *
 * @module components/tugways/cards/gallery-tug-inline-markdown
 */

import React from "react";

import { TugInlineMarkdown } from "@/components/tugways/tug-inline-markdown";
import { TugLabel } from "@/components/tugways/tug-label";

const SAMPLES = [
  "Plain text passes through unchanged.",
  "Run `just ci` before pushing.",
  "This is **strong** and this is *emphasis*.",
  "Nesting: **strong with `code` inside** and *emphasis with **strong***.",
  "Unclosed markers stay literal: **not closed and `not code",
];

export function GalleryTugInlineMarkdown() {
  return (
    <div className="cg-content" data-testid="gallery-tug-inline-markdown">
      <div className="cg-section">
        <TugLabel className="cg-section-title">Runs</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {SAMPLES.map((text) => (
            <div key={text}>
              <TugInlineMarkdown text={text} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
