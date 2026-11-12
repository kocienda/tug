/**
 * gallery-tug-inline-alert.tsx — `TugInlineAlert` demo tab for the Component
 * Gallery.
 *
 * Shows every tone, the accent bar, a title-only alert, and an alert with
 * actions.
 *
 * @module components/tugways/cards/gallery-tug-inline-alert
 */

import React from "react";

import { TugInlineAlert, type TugInlineAlertTone } from "@/components/tugways/tug-inline-alert";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const TONES: TugInlineAlertTone[] = ["muted", "agent", "accent", "action", "caution", "danger"];

const stackStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "8px" };

export function GalleryTugInlineAlert() {
  return (
    <div className="cg-content" data-testid="gallery-tug-inline-alert">
      <div className="cg-section">
        <TugLabel className="cg-section-title">Tones</TugLabel>
        <div style={stackStyle}>
          {TONES.map((tone) => (
            <TugInlineAlert key={tone} tone={tone} title={`tone="${tone}"`} message="A sentence of detail under the title." />
          ))}
        </div>
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">Accent bar</TugLabel>
        <div style={stackStyle}>
          <TugInlineAlert tone="caution" accent title="With the accent bar" message="accent={true}" />
          <TugInlineAlert tone="caution" accent={false} title="Without it" message="accent={false}" />
        </div>
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">Title only, and actions</TugLabel>
        <div style={stackStyle}>
          <TugInlineAlert tone="muted" title="Nothing to show yet" />
          <TugInlineAlert
            tone="danger"
            live="alert"
            title="The push was rejected"
            message="The remote has commits this branch does not."
            actions={<TugPushButton size="sm" emphasis="outlined">Fetch</TugPushButton>}
          />
        </div>
      </div>
    </div>
  );
}
