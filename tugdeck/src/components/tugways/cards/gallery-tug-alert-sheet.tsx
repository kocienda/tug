/**
 * gallery-tug-alert-sheet.tsx — `TugAlertSheetView` demo tab for the
 * Component Gallery.
 *
 * Draws the alert sheet's face in place, with no sheet around it: the
 * default single-button alert, a confirm/cancel pair with a danger confirm,
 * and a custom icon. In the app the face is presented with
 * `presentAlertSheet`, which drives the sheet and resolves the buttons.
 *
 * @module components/tugways/cards/gallery-tug-alert-sheet
 */

import React from "react";
import { TriangleAlert } from "lucide-react";

import { TugAlertSheetView } from "@/components/tugways/tug-alert-sheet";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const ignore = (): void => {};

const frameStyle: React.CSSProperties = {
  maxWidth: "420px",
  border: "1px solid var(--tug7-element-global-border-normal-default-rest)",
  borderRadius: "8px",
};

export function GalleryTugAlertSheet() {
  return (
    <div className="cg-content" data-testid="gallery-tug-alert-sheet">
      <div className="cg-section">
        <TugLabel className="cg-section-title">One button</TugLabel>
        <div style={frameStyle}>
          <TugAlertSheetView
            title="Export finished"
            message="The archive was written to your Downloads folder."
            onConfirm={ignore}
            onCancel={ignore}
          />
        </div>
      </div>

      <TugSeparator />

      <div className="cg-section">
        <TugLabel className="cg-section-title">Confirm and cancel, danger role</TugLabel>
        <div style={frameStyle}>
          <TugAlertSheetView
            title="Discard this arc?"
            message="Its worktree and branch are removed. This cannot be undone."
            icon={<TriangleAlert aria-hidden="true" />}
            confirmLabel="Discard"
            confirm={{ role: "danger" }}
            cancelLabel="Cancel"
            onConfirm={ignore}
            onCancel={ignore}
          />
        </div>
      </div>
    </div>
  );
}
