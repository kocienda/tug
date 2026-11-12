/**
 * gallery-tug-action-tooltip.tsx — `TugActionTooltip` demo tab for the
 * Component Gallery.
 *
 * Shows a tooltip whose chord chip is read live from the keymap registry,
 * beside one for a command that holds no binding, which renders the phrase
 * alone. Rebind the command in Settings and the chip follows.
 *
 * @module components/tugways/cards/gallery-tug-action-tooltip
 */

import React from "react";

import { TugActionTooltip } from "@/components/tugways/tug-action-tooltip";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";

export function GalleryTugActionTooltip() {
  return (
    <div className="cg-content" data-testid="gallery-tug-action-tooltip">
      <div className="cg-section">
        <TugLabel className="cg-section-title">Bound and unbound commands</TugLabel>
        <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
          <TugActionTooltip action={TUG_ACTIONS.FIND_PREVIOUS} content="Find the previous match">
            <TugPushButton>Bound</TugPushButton>
          </TugActionTooltip>
          <TugActionTooltip action="gallery-unbound-command" content="This command has no chord">
            <TugPushButton>Unbound</TugPushButton>
          </TugActionTooltip>
        </div>
      </div>
    </div>
  );
}
