/**
 * gallery-tooltip.tsx -- TugTooltip demo tab for the Component Gallery.
 *
 * Shows TugTooltip in all configurations: basic usage, positioning (four sides),
 * keyboard shortcuts, arrow toggle, icon button use case, alignment variants,
 * truncation-aware mode, disabled trigger, and rich ReactNode content.
 *
 * The chord strings below are authored, and are the one place that is right:
 * these buttons are stand-ins — a Bold that bolds nothing, a Publish that
 * publishes nothing — so there is no command whose binding could be read.
 * Real surfaces render every chord from the keymap ([P11]).
 *
 * @module components/tugways/cards/gallery-tooltip
 */

import React from "react";
import { Save, Copy, Trash2, Settings } from "lucide-react";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

// Shared label style for section annotations
const labelStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--tug7-element-field-text-normal-label-rest)",
  marginBottom: "4px",
};

// Shared note style for explanatory text
const noteStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--tug7-element-field-text-normal-label-rest)",
  fontStyle: "italic",
  marginTop: "8px",
};

// Shared row style for buttons with tooltip spacing
const rowStyle: React.CSSProperties = {
  display: "flex",
  gap: "16px",
  alignItems: "center",
  flexWrap: "wrap",
};

// ---------------------------------------------------------------------------
// GalleryTooltip
// ---------------------------------------------------------------------------

export function GalleryTooltip() {
  return (
    <div className="cg-content" data-testid="gallery-tooltip">

      {/* ---- 1. Basic ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Basic</TugLabel>
        <div style={rowStyle}>
          <TugTooltip content="Save document">
            <TugPushButton>Save</TugPushButton>
          </TugTooltip>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 2. Positioning ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Positioning</TugLabel>
        <div style={labelStyle}>side prop — top / bottom / left / right</div>
        <div style={rowStyle}>
          <TugTooltip content="Tooltip on top" side="top">
            <TugPushButton>top</TugPushButton>
          </TugTooltip>
          <TugTooltip content="Tooltip on bottom" side="bottom">
            <TugPushButton>bottom</TugPushButton>
          </TugTooltip>
          <TugTooltip content="Tooltip on left" side="left">
            <TugPushButton>left</TugPushButton>
          </TugTooltip>
          <TugTooltip content="Tooltip on right" side="right">
            <TugPushButton>right</TugPushButton>
          </TugTooltip>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 3. With Shortcut ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">With Shortcut</TugLabel>
        <div style={labelStyle}>shortcut prop renders a styled kbd badge alongside content</div>
        <div style={rowStyle}>
          <TugTooltip content="Bold" shortcut="⌘B">
            <TugPushButton>Bold</TugPushButton>
          </TugTooltip>
          <TugTooltip content="Copy" shortcut="⌘C">
            <TugPushButton>Copy</TugPushButton>
          </TugTooltip>
          <TugTooltip content="Paste" shortcut="⌘V">
            <TugPushButton>Paste</TugPushButton>
          </TugTooltip>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 4. Without Arrow ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Without Arrow</TugLabel>
        <div style={rowStyle}>
          <div>
            <div style={labelStyle}>arrow={"{true}"} (default)</div>
            <TugTooltip content="With arrow" arrow={true}>
              <TugPushButton>With Arrow</TugPushButton>
            </TugTooltip>
          </div>
          <div>
            <div style={labelStyle}>arrow={"{false}"}</div>
            <TugTooltip content="Without arrow" arrow={false}>
              <TugPushButton>No Arrow</TugPushButton>
            </TugTooltip>
          </div>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 5. On Icon Buttons ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">On Icon Buttons</TugLabel>
        <div style={labelStyle}>primary use case — icon-only buttons with descriptive tooltips and shortcuts</div>
        <div style={rowStyle}>
          <TugTooltip content="Save" shortcut="⌘S">
            <TugPushButton size="sm" aria-label="Save">
              <Save size={14} aria-hidden="true" />
            </TugPushButton>
          </TugTooltip>
          <TugTooltip content="Copy" shortcut="⌘C">
            <TugPushButton size="sm" aria-label="Copy">
              <Copy size={14} aria-hidden="true" />
            </TugPushButton>
          </TugTooltip>
          <TugTooltip content="Delete">
            <TugPushButton size="sm" aria-label="Delete">
              <Trash2 size={14} aria-hidden="true" />
            </TugPushButton>
          </TugTooltip>
          <TugTooltip content="Settings" shortcut="⌘,">
            <TugPushButton size="sm" aria-label="Settings">
              <Settings size={14} aria-hidden="true" />
            </TugPushButton>
          </TugTooltip>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 6. Alignment ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Alignment</TugLabel>
        <div style={labelStyle}>align prop — start / center / end — shown on a wide trigger (~200px)</div>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div>
            <div style={labelStyle}>align="start"</div>
            <TugTooltip content="Aligned to start" align="start" side="bottom">
              <div
                style={{
                  width: "200px",
                  padding: "6px 12px",
                  border: "1px solid var(--tug7-element-field-border-normal-plain-rest)",
                  borderRadius: "4px",
                  cursor: "default",
                  fontSize: "0.875rem",
                  color: "var(--tug7-element-field-text-normal-plain-rest)",
                  userSelect: "none",
                }}
              >
                Wide trigger element
              </div>
            </TugTooltip>
          </div>
          <div>
            <div style={labelStyle}>align="center" (default)</div>
            <TugTooltip content="Aligned to center" align="center" side="bottom">
              <div
                style={{
                  width: "200px",
                  padding: "6px 12px",
                  border: "1px solid var(--tug7-element-field-border-normal-plain-rest)",
                  borderRadius: "4px",
                  cursor: "default",
                  fontSize: "0.875rem",
                  color: "var(--tug7-element-field-text-normal-plain-rest)",
                  userSelect: "none",
                }}
              >
                Wide trigger element
              </div>
            </TugTooltip>
          </div>
          <div>
            <div style={labelStyle}>align="end"</div>
            <TugTooltip content="Aligned to end" align="end" side="bottom">
              <div
                style={{
                  width: "200px",
                  padding: "6px 12px",
                  border: "1px solid var(--tug7-element-field-border-normal-plain-rest)",
                  borderRadius: "4px",
                  cursor: "default",
                  fontSize: "0.875rem",
                  color: "var(--tug7-element-field-text-normal-plain-rest)",
                  userSelect: "none",
                }}
              >
                Wide trigger element
              </div>
            </TugTooltip>
          </div>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 7. Truncation-Aware ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Truncation-Aware</TugLabel>
        <div style={labelStyle}>truncated={"{true}"} — tooltip appears only when content is visually clipped</div>
        <div style={rowStyle}>
          <div>
            <div style={labelStyle}>Truncated — tooltip shows</div>
            <TugTooltip
              content="This is the full untruncated label text that was too long to display"
              truncated={true}
            >
              <div style={{ width: "120px", overflow: "hidden" }}>
                <TugLabel maxLines={1}>
                  This is the full untruncated label text that was too long to display
                </TugLabel>
              </div>
            </TugTooltip>
          </div>
          <div>
            <div style={labelStyle}>Not truncated — no tooltip</div>
            <TugTooltip
              content="Short text"
              truncated={true}
            >
              <div style={{ width: "300px", overflow: "hidden" }}>
                <TugLabel maxLines={1}>Short text</TugLabel>
              </div>
            </TugTooltip>
          </div>
        </div>
      </div>

      <TugSeparator />

      {/* ---- 8. Disabled Trigger ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Disabled Trigger</TugLabel>
        <div style={labelStyle}>disabled button wrapped in a span to preserve pointer events</div>
        <div style={rowStyle}>
          <TugTooltip content="This action is currently unavailable">
            <span style={{ display: "inline-block", cursor: "not-allowed" }}>
              <TugPushButton disabled style={{ pointerEvents: "none" }}>
                Disabled Button
              </TugPushButton>
            </span>
          </TugTooltip>
        </div>
        <p style={noteStyle}>
          Native disabled buttons swallow pointer events. Wrap in a span with
          pointer-events: none on the button to let the tooltip trigger receive hover.
        </p>
      </div>

      <TugSeparator />

      {/* ---- 9. Rich Content ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Rich Content</TugLabel>
        <div style={labelStyle}>content accepts ReactNode — multi-line with title and description</div>
        <div style={rowStyle}>
          <TugTooltip
            content={
              <div>
                <div style={{ fontWeight: 600, marginBottom: "4px" }}>Publish to production</div>
                <div style={{ fontWeight: 400, opacity: 0.85 }}>
                  Deploys the current build to the live environment. This action cannot be undone.
                </div>
              </div>
            }
            shortcut="⌥⌘P"
            sideOffset={8}
          >
            <TugPushButton>Publish</TugPushButton>
          </TugTooltip>
        </div>
      </div>

    </div>
  );
}
