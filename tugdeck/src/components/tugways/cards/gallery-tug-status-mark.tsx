/**
 * gallery-tug-status-mark.tsx — `TugStatusMark` demo tab for the Component
 * Gallery.
 *
 * Shows the mark for each vocabulary it accepts: status words, porcelain
 * codes and bare letters.
 *
 * @module components/tugways/cards/gallery-tug-status-mark
 */

import React from "react";

import { TugStatusMark } from "@/components/tugways/tug-status-mark";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const WORDS = ["added", "modified", "deleted", "renamed", "untracked"];
const PORCELAIN = ["??", " M", "M ", "A ", " D", "R "];
const LETTERS = ["A", "M", "D", "R", "U"];

const rowStyle: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: "16px", alignItems: "center" };
const cellStyle: React.CSSProperties = { display: "inline-flex", gap: "6px", alignItems: "center" };

function Row({ statuses }: { statuses: string[] }) {
  return (
    <div style={rowStyle}>
      {statuses.map((status) => (
        <span key={status} style={cellStyle}>
          <TugStatusMark status={status} />
          <TugLabel size="2xs" emphasis="calm">{JSON.stringify(status)}</TugLabel>
        </span>
      ))}
    </div>
  );
}

export function GalleryTugStatusMark() {
  return (
    <div className="cg-content" data-testid="gallery-tug-status-mark">
      <div className="cg-section">
        <TugLabel className="cg-section-title">Words</TugLabel>
        <Row statuses={WORDS} />
      </div>
      <TugSeparator />
      <div className="cg-section">
        <TugLabel className="cg-section-title">Porcelain codes</TugLabel>
        <Row statuses={PORCELAIN} />
      </div>
      <TugSeparator />
      <div className="cg-section">
        <TugLabel className="cg-section-title">Letters</TugLabel>
        <Row statuses={LETTERS} />
      </div>
    </div>
  );
}
