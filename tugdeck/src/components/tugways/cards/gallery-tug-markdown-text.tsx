/**
 * gallery-tug-markdown-text.tsx — `TugMarkdownText` demo tab for the
 * Component Gallery.
 *
 * Shows markdown styled verbatim — syntax kept, runs styled — and the same
 * text with a filter query marked inside it.
 *
 * @module components/tugways/cards/gallery-tug-markdown-text
 */

import React from "react";

import { TugMarkdownText } from "@/components/tugways/tug-markdown-text";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const TEXT = [
  "# A heading",
  "",
  "A paragraph with **strong**, *emphasis* and `code` in it.",
  "",
  "- a list item",
  "- another, long enough to wrap so its continuation hangs under the content rather than under the bullet",
  "",
  "> a quotation",
].join("\n");

export function GalleryTugMarkdownText() {
  return (
    <div className="cg-content" data-testid="gallery-tug-markdown-text">
      <div className="cg-section">
        <TugLabel className="cg-section-title">Styled, nothing hidden</TugLabel>
        <TugMarkdownText text={TEXT} />
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">highlightQuery="item"</TugLabel>
        <TugMarkdownText text={TEXT} highlightQuery="item" />
      </div>
    </div>
  );
}
