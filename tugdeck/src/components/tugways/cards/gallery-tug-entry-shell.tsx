/**
 * gallery-tug-entry-shell.tsx — `TugEntryShell` demo tab for the Component
 * Gallery.
 *
 * Shows the shell's frame around a stand-in input: the status and accessory
 * rows, and the toolbar's leading, centre and trailing regions — all filled,
 * and the input alone.
 *
 * @module components/tugways/cards/gallery-tug-entry-shell
 */

import React from "react";
import { Paperclip, Send } from "lucide-react";

import { TugEntryShell } from "@/components/tugways/tug-entry-shell";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const boxStyle: React.CSSProperties = { maxWidth: "520px" };
const inputStandIn: React.CSSProperties = { padding: "8px", minHeight: "48px" };

export function GalleryTugEntryShell() {
  return (
    <div className="cg-content" data-testid="gallery-tug-entry-shell">
      <div className="cg-section">
        <TugLabel className="cg-section-title">Every region</TugLabel>
        <div style={boxStyle}>
          <TugEntryShell
            statusRow={<TugLabel size="2xs" emphasis="calm">status row</TugLabel>}
            accessoryRow={<TugLabel size="2xs" emphasis="calm">accessory row</TugLabel>}
            toolbarLeading={<TugPushButton subtype="icon" size="sm" icon={<Paperclip />} aria-label="Attach" />}
            toolbarCenter={<TugLabel size="2xs" emphasis="calm">toolbar centre</TugLabel>}
            toolbarTrailing={<TugPushButton subtype="icon" size="sm" icon={<Send />} aria-label="Send" />}
          >
            <div style={inputStandIn}>
              <TugLabel size="2xs">The input area — an editor sits here.</TugLabel>
            </div>
          </TugEntryShell>
        </div>
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">Input only</TugLabel>
        <div style={boxStyle}>
          <TugEntryShell>
            <div style={inputStandIn}>
              <TugLabel size="2xs">No rows, no toolbar content.</TugLabel>
            </div>
          </TugEntryShell>
        </div>
      </div>
    </div>
  );
}
