/**
 * gallery-tug-message-editor.tsx — `TugMessageEditor` demo tab for the
 * Component Gallery.
 *
 * Shows the editor empty with a placeholder, seeded and capped by
 * `maxRows`, with the markdown text styling, borderless, and disabled. Each
 * is live: type into it.
 *
 * @module components/tugways/cards/gallery-tug-message-editor
 */

import React from "react";

import { TugMessageEditor } from "@/components/tugways/tug-message-editor";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const SEED = [
  "A seeded message, long enough to need more than one row.",
  "Second line.",
  "Third line.",
  "Fourth line — past maxRows=3, so the editor scrolls.",
].join("\n");

const MARKDOWN = "Some **strong**, some *emphasis*, some `code`.\n\n- a list item";

const boxStyle: React.CSSProperties = { maxWidth: "480px" };

export function GalleryTugMessageEditor() {
  return (
    <div className="cg-content" data-testid="gallery-tug-message-editor">
      <div className="cg-section">
        <TugLabel className="cg-section-title">Empty, with a placeholder</TugLabel>
        <div style={boxStyle}>
          <TugMessageEditor placeholder="Write a message…" aria-label="Empty message editor" />
        </div>
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">Seeded, maxRows=3</TugLabel>
        <div style={boxStyle}>
          <TugMessageEditor value={SEED} maxRows={3} aria-label="Seeded message editor" />
        </div>
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">markdownTextStyling</TugLabel>
        <div style={boxStyle}>
          <TugMessageEditor value={MARKDOWN} markdownTextStyling aria-label="Markdown message editor" />
        </div>
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">borderless, and disabled</TugLabel>
        <div style={{ ...boxStyle, display: "flex", flexDirection: "column", gap: "8px" }}>
          <TugMessageEditor value="A borderless editor." borderless aria-label="Borderless message editor" />
          <TugMessageEditor value="A disabled editor." disabled aria-label="Disabled message editor" />
        </div>
      </div>
    </div>
  );
}
