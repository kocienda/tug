/**
 * gallery-tug-code-view.tsx — `TugCodeView` demo tab for the Component
 * Gallery.
 *
 * Shows a highlighted snippet, the gutter offset by `startLine`, no gutter
 * with no wrap, and the markdown text styling.
 *
 * @module components/tugways/cards/gallery-tug-code-view
 */

import React from "react";

import { TugCodeView } from "@/components/tugways/tug-code-view";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const TS = [
  "export function clamp(value: number, min: number, max: number): number {",
  "  // A long comment line that runs past the edge of the view so the wrap setting has something to do.",
  "  return Math.min(max, Math.max(min, value));",
  "}",
].join("\n");

const MD = [
  "## Notes",
  "",
  "- a list item whose text is long enough to wrap, so its continuation hangs under the content",
  "- **strong** and `code`",
].join("\n");

const boxStyle: React.CSSProperties = { maxWidth: "520px" };

export function GalleryTugCodeView() {
  return (
    <div className="cg-content" data-testid="gallery-tug-code-view">
      <div className="cg-section">
        <TugLabel className="cg-section-title">language="typescript"</TugLabel>
        <div style={boxStyle}>
          <TugCodeView value={TS} language="typescript" />
        </div>
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">startLine=120</TugLabel>
        <div style={boxStyle}>
          <TugCodeView value={TS} language="typescript" startLine={120} />
        </div>
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">lineNumbers=false, wrap=false</TugLabel>
        <div style={boxStyle}>
          <TugCodeView value={TS} language="typescript" lineNumbers={false} wrap={false} />
        </div>
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">markdownTextStyling</TugLabel>
        <div style={boxStyle}>
          <TugCodeView value={MD} markdownTextStyling lineNumbers={false} />
        </div>
      </div>
    </div>
  );
}
