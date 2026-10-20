/**
 * GalleryTitleBar -- interactive demo of CardTitleBar controls.
 *
 * Shows a CardTitleBar in isolation (outside a real deck window frame) with
 * interactive controls for the width popup, the close button, and the icon.
 *
 * @module components/tugways/cards/gallery-title-bar
 */

import React, { useId, useState } from "react";
import { CardTitleBar } from "@/components/chrome/card-title-bar";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugPopupButton } from "@/components/tugways/tug-popup-button";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import { TUG_ACTIONS } from "../action-vocabulary";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { TugBox } from "@/components/tugways/tug-box";
import { TugCheckbox } from "@/components/tugways/tug-checkbox";
import type { ContentWidth } from "@/lib/layout-imposer";

// ---------------------------------------------------------------------------
// GalleryTitleBar
// ---------------------------------------------------------------------------

/**
 * GalleryTitleBar -- interactive demo of CardTitleBar controls.
 *
 * Shows a CardTitleBar in isolation (outside a real deck window frame) with
 * interactive controls for the width popup, the close button, and the icon.
 */
export function GalleryTitleBar() {
  const [widthPreset, setWidthPreset] = useState<ContentWidth | null>("comfy");
  const [iconName, setIconName] = useState<string>("Layout");
  const [closable, setClosable] = useState(true);
  const [lastEvent, setLastEvent] = useState<string | null>(null);

  // The real applier goes through the `set-card-width` command and a pane id;
  // outside a deck there is no pane, so the demo just holds the stamp — which
  // is the whole of what the control shows.
  const handleSetWidth = (preset: ContentWidth) => {
    setWidthPreset(preset);
    setLastEvent(`width → ${preset}`);
  };

  const handleClose = () => {
    setLastEvent("close clicked");
  };

  // L11 migration via useResponderForm — the icon picker dispatches
  // setValue with a string payload; its binding writes iconName state.
  const iconPopupId = useId();
  const closableId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    setValueString: {
      [iconPopupId]: setIconName,
    },
    toggle: {
      [closableId]: setClosable,
    },
  });

  return (
    <ResponderScope>
    <div
      className="cg-content"
      data-testid="gallery-title-bar"
      ref={responderRef as (el: HTMLDivElement | null) => void}
    >
      <div className="cg-section">
        <TugLabel className="cg-section-title">Title Bar Demo</TugLabel>
        <TugLabel size="2xs" emphasis="calm">CardTitleBar in isolation: the width popup and the close button.</TugLabel>
      </div>

      <TugSeparator />

      {/* ---- Interactive Controls ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Preview Controls</TugLabel>
        <TugBox variant="bordered" rounded="sm" style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
          <div className="cg-control-group">
            <TugLabel size="2xs" emphasis="calm">Icon</TugLabel>
            <TugPopupButton
              label={iconName || "None"}
              size="sm"
              senderId={iconPopupId}
              items={[
                { action: TUG_ACTIONS.SET_VALUE, value: "", label: "None" },
                { action: TUG_ACTIONS.SET_VALUE, value: "Layout", label: "Layout" },
                { action: TUG_ACTIONS.SET_VALUE, value: "Settings", label: "Settings" },
                { action: TUG_ACTIONS.SET_VALUE, value: "Terminal", label: "Terminal" },
                { action: TUG_ACTIONS.SET_VALUE, value: "Code", label: "Code" },
              ]}
            />
          </div>

          <div className="cg-control-group">
            <TugCheckbox checked={closable} senderId={closableId} label="Closable" size="sm" />
          </div>
        </TugBox>
      </div>

      <TugSeparator />

      {/* ---- Live CardTitleBar Demo ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">CardTitleBar — Live Demo</TugLabel>
        <div
          style={{
            border: "1px solid var(--tugx-pane-border)",
            borderRadius: "var(--tug-radius-md)",
            overflow: "hidden",
            background: "var(--tugx-pane-title-bar-bg-inactive)",
          }}
          data-testid="gallery-card-title-bar-demo"
        >
          <CardTitleBar
            title="Demo Card"
            icon={iconName || undefined}
            closable={closable}
            widthPreset={widthPreset}
            onSetWidth={handleSetWidth}
            onClose={handleClose}
          />
          <div
            style={{
              padding: "12px",
              background: "var(--tug7-surface-global-primary-normal-default-rest)",
              fontSize: "12px",
              color: "var(--tug7-element-global-text-normal-muted-rest)",
              minHeight: "48px",
            }}
          >
            Card content area
          </div>
        </div>

        {lastEvent !== null && (
          <TugLabel size="2xs" emphasis="calm" data-testid="gallery-title-bar-event-status">{`Last event: ${lastEvent}`}</TugLabel>
        )}

        <div style={{ marginTop: "8px" }}>
          {/* A hand resize clears the stamp, so the popup shows no check — the
              control's third state, and the one a demo has to be able to reach. */}
          <TugPushButton size="sm" onClick={() => {
            setWidthPreset(null);
            setLastEvent("resized by hand — no preset");
          }}>
            Clear preset
          </TugPushButton>
        </div>
      </div>

    </div>
    </ResponderScope>
  );
}
