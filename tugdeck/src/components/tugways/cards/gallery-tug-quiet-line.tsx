/**
 * gallery-tug-quiet-line.tsx — `TugQuietLine` demo tab for the Component
 * Gallery.
 *
 * Shows the three tones, and the label / subject / meta slots alone and
 * together.
 *
 * @module components/tugways/cards/gallery-tug-quiet-line
 */

import React from "react";
import { CircleCheck, CircleX, Terminal } from "lucide-react";

import { TugQuietLine, type TugQuietLineTone } from "@/components/tugways/tug-quiet-line";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const TONES: { tone: TugQuietLineTone; icon: React.ReactNode; label: string }[] = [
  { tone: "quiet", icon: <CircleCheck size={16} />, label: "Completed" },
  { tone: "primary", icon: <Terminal size={16} />, label: "Background command completed" },
  { tone: "danger", icon: <CircleX size={16} />, label: "Failed" },
];

export function GalleryTugQuietLine() {
  return (
    <div className="cg-content" data-testid="gallery-tug-quiet-line">
      <div className="cg-section">
        <TugLabel className="cg-section-title">Tones</TugLabel>
        {TONES.map(({ tone, icon, label }) => (
          <TugQuietLine key={tone} tone={tone} icon={icon} label={label} subject={`tone="${tone}"`} />
        ))}
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">Slots</TugLabel>
        <TugQuietLine icon={<CircleCheck size={16} />} label="Label only" />
        <TugQuietLine
          icon={<Terminal size={16} />}
          label="Completed"
          subject="bun test src/lib — a long subject wraps below the first row rather than pushing the label"
          meta="exit 0 · 4.2s"
        />
        <TugQuietLine
          tone="danger"
          icon={<CircleX size={16} />}
          subject="An error row carries its whole message in the subject slot"
        />
      </div>
    </div>
  );
}
