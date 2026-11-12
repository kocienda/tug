/**
 * gallery-label.tsx -- TugLabel gallery card.
 *
 * Shows TugLabel in all sizes, ellipsis modes, with icons, and paired
 * with TugInput.
 */

import React from "react";
import { Tag, Info, AlertTriangle, Star, Folder } from "lucide-react";
import { TugLabel } from "@/components/tugways/tug-label";
import type { TugLabelEmphasis, TugLabelSize } from "@/components/tugways/tug-label";
import { TugInput } from "@/components/tugways/tug-input";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { TugKeyValueRow } from "@/components/tugways/tug-key-value-row";
import { TugNamedIcon } from "@/components/tugways/tug-named-icon";
import { TugEmptyLine } from "@/components/tugways/tug-empty-line";
import { TugChip } from "@/components/tugways/tug-chip";
import { TugDisclosure } from "@/components/tugways/tug-disclosure";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_SIZES: TugLabelSize[] = ["sm", "md", "lg"];

const ALL_EMPHASES: TugLabelEmphasis[] = ["shout", "strong", "normal", "proposal", "calm", "whisper"];

const LONG_TEXT =
  "This is a long label that demonstrates multiline text wrapping behavior when the content exceeds the available width of the container element";

const PATH_TEXT =
  "/Users/kocienda/Documents/Projects/tugways/src/components/tugways/cards/gallery-label.tsx";

// ---------------------------------------------------------------------------
// GalleryLabel
// ---------------------------------------------------------------------------

export function GalleryLabel() {
  return (
    <div className="cg-content" data-testid="gallery-label">

      {/* ---- Size Variants ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">TugLabel — Size Variants</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", maxWidth: "360px" }}>
          {ALL_SIZES.map((size) => (
            <TugLabel key={size} size={size}>
              {`Label size: ${size}`}
            </TugLabel>
          ))}
        </div>
      </div>

      <TugSeparator />

      {/* ---- Emphasis Variants ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">TugLabel — Emphasis Variants</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", maxWidth: "360px" }}>
          {ALL_EMPHASES.map((emphasis) => (
            <TugLabel key={emphasis} emphasis={emphasis}>
              {`Emphasis: ${emphasis}`}
            </TugLabel>
          ))}
        </div>
      </div>

      <TugSeparator />

      {/* ---- Required Indicator ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">TugLabel — Required Indicator</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", maxWidth: "360px" }}>
          <TugLabel>Optional field</TugLabel>
          <TugLabel required>Required field</TugLabel>
        </div>
      </div>

      <TugSeparator />

      {/* ---- With Icons ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">TugLabel — With Icons</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", maxWidth: "360px" }}>
          <TugLabel icon={<Tag />}>Default icon color</TugLabel>
          <TugLabel icon={<Info />} iconTone="accent">
            Accent-colored icon
          </TugLabel>
          <TugLabel icon={<AlertTriangle />} iconTone="caution">
            Warning-colored icon
          </TugLabel>
          <TugLabel icon={<Star />} iconTone="danger">
            Error-colored icon
          </TugLabel>
          <TugLabel icon={<Folder />} iconTone="success">
            Success-colored icon
          </TugLabel>
        </div>
      </div>

      <TugSeparator />

      {/* ---- Icons at All Sizes ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">TugLabel — Icons at All Sizes</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", maxWidth: "360px" }}>
          {ALL_SIZES.map((size) => (
            <TugLabel key={size} size={size} icon={<Tag />} required>
              {`Size ${size} with icon`}
            </TugLabel>
          ))}
        </div>
      </div>

      <TugSeparator />

      {/* ---- Multiline Wrapping ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">TugLabel — Multiline Wrapping</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: "280px" }}>
          <div>
            <TugLabel size="2xs" emphasis="calm">No maxLines — wraps freely:</TugLabel>
            <TugLabel>{LONG_TEXT}</TugLabel>
          </div>
          <div>
            <TugLabel size="2xs" emphasis="calm">maxLines=2, no ellipsis:</TugLabel>
            <TugLabel maxLines={2} ellipsis="none">{LONG_TEXT}</TugLabel>
          </div>
        </div>
      </div>

      <TugSeparator />

      {/* ---- Ellipsis: End ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">TugLabel — Ellipsis: End (CSS line-clamp)</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: "280px" }}>
          <div>
            <TugLabel size="2xs" emphasis="calm">maxLines=1:</TugLabel>
            <TugLabel maxLines={1} ellipsis="end">{LONG_TEXT}</TugLabel>
          </div>
          <div>
            <TugLabel size="2xs" emphasis="calm">maxLines=2:</TugLabel>
            <TugLabel maxLines={2} ellipsis="end">{LONG_TEXT}</TugLabel>
          </div>
          <div>
            <TugLabel size="2xs" emphasis="calm">maxLines=3:</TugLabel>
            <TugLabel maxLines={3} ellipsis="end">{LONG_TEXT}</TugLabel>
          </div>
        </div>
      </div>

      <TugSeparator />

      {/* ---- Ellipsis: Start ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">TugLabel — Ellipsis: Start</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: "280px" }}>
          <div>
            <TugLabel size="2xs" emphasis="calm">File path, maxLines=1:</TugLabel>
            <TugLabel maxLines={1} ellipsis="start" icon={<Folder />}>{PATH_TEXT}</TugLabel>
          </div>
          <div>
            <TugLabel size="2xs" emphasis="calm">Long text, maxLines=2:</TugLabel>
            <TugLabel maxLines={2} ellipsis="start">{LONG_TEXT}</TugLabel>
          </div>
        </div>
      </div>

      <TugSeparator />

      {/* ---- Ellipsis: Middle ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">TugLabel — Ellipsis: Middle</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: "280px" }}>
          <div>
            <TugLabel size="2xs" emphasis="calm">File path, maxLines=1:</TugLabel>
            <TugLabel maxLines={1} ellipsis="middle" icon={<Folder />}>{PATH_TEXT}</TugLabel>
          </div>
          <div>
            <TugLabel size="2xs" emphasis="calm">Long text, maxLines=2:</TugLabel>
            <TugLabel maxLines={2} ellipsis="middle">{LONG_TEXT}</TugLabel>
          </div>
        </div>
      </div>

      <TugSeparator />

      {/* ---- Paired with TugInput ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">TugLabel — Paired with TugInput</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: "360px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <TugLabel htmlFor="demo-name" required>Name</TugLabel>
            <TugInput id="demo-name" placeholder="Enter your name" />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <TugLabel htmlFor="demo-email" icon={<Info />} iconTone="accent">
              Email address
            </TugLabel>
            <TugInput id="demo-email" type="email" placeholder="you@example.com" />
          </div>
        </div>
      </div>

      <TugSeparator />

      {/* ---- Disabled ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">TugLabel — Disabled</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: "360px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <TugLabel htmlFor="demo-disabled" disabled>Disabled label</TugLabel>
            <TugInput id="demo-disabled" disabled placeholder="Disabled input" />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <TugLabel htmlFor="demo-disabled-icon" disabled icon={<Info />} required>Disabled with icon + required</TugLabel>
            <TugInput id="demo-disabled-icon" disabled defaultValue="Can't edit this" />
          </div>
        </div>
      </div>

      {/* ---- Small display primitives ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">TugKeyValueRow</TugLabel>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "max-content 1fr max-content",
            columnGap: "8px",
            maxWidth: "260px",
          }}
        >
          <TugKeyValueRow label="Cost" detail="62%">$1.24</TugKeyValueRow>
          <TugKeyValueRow label="Turns" detail={null}>18</TugKeyValueRow>
        </div>
      </div>

      <div className="cg-section">
        <TugLabel className="cg-section-title">TugNamedIcon</TugLabel>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <TugNamedIcon name="FileText" size={16} aria-hidden="true" />
          <TugNamedIcon name="GitBranch" size={16} aria-hidden="true" />
          <TugNamedIcon name="NotAnIcon" size={16} aria-hidden="true" />
        </div>
      </div>

      <div className="cg-section">
        <TugLabel className="cg-section-title">TugEmptyLine</TugLabel>
        <div style={{ maxWidth: "260px" }}>
          <TugEmptyLine>None</TugEmptyLine>
          <TugEmptyLine>No matches</TugEmptyLine>
        </div>
      </div>

      <div className="cg-section">
        <TugLabel className="cg-section-title">TugChip</TugLabel>
        <div style={{ display: "flex", gap: "6px" }}>
          <TugChip>notes.md</TugChip>
          <TugChip
            removeAction={TUG_ACTIONS.UNSTAGE_CONTEXT}
            value="demo"
            removeLabel="Remove the demo chip"
          >
            staged shell output
          </TugChip>
        </div>
      </div>

      <div className="cg-section">
        <TugLabel className="cg-section-title">TugDisclosure</TugLabel>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <TugDisclosure expanded={false} size={12} />
          <TugDisclosure expanded size={12} />
        </div>
      </div>

    </div>
  );
}
