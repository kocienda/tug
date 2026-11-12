/**
 * gallery-box.tsx -- TugBox demo tab for the Component Gallery.
 *
 * Shows TugBox in all variants, both label positions, nested boxes, the
 * disabled cascade with an interactive toggle, and border radius options.
 *
 * Rules of Tugways compliance:
 *   - No root.render() after initial mount [D40, D42]
 *
 * @module components/tugways/cards/gallery-box
 */

import React, { useId, useState } from "react";
import { TugBox } from "@/components/tugways/tug-box";
import { TugSettingsGroup } from "@/components/tugways/tug-settings-group";
import { TugCheckbox } from "@/components/tugways/tug-checkbox";
import { TugSwitch } from "@/components/tugways/tug-switch";
import { TugRadioGroup, TugRadioItem } from "@/components/tugways/tug-radio-group";
import { TugChoiceGroup } from "@/components/tugways/tug-choice-group";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

// ---------------------------------------------------------------------------
// GalleryBox
// ---------------------------------------------------------------------------

export function GalleryBox() {
  // Variants section
  const [plainCb1, setPlainCb1] = useState(false);
  const [plainCb2, setPlainCb2] = useState(true);
  const [borderedSw1, setBorderedSw1] = useState(false);
  const [borderedSw2, setBorderedSw2] = useState(true);
  const [filledCb1, setFilledCb1] = useState(true);
  const [filledSw1, setFilledSw1] = useState(false);

  // Label positions section
  const [legendCb, setLegendCb] = useState(false);
  const [legendSw, setLegendSw] = useState(true);
  const [aboveCb, setAboveCb] = useState(false);
  const [aboveSw, setAboveSw] = useState(true);

  // Nested boxes section
  const [nestedCb, setNestedCb] = useState(true);
  const [nestedSw, setNestedSw] = useState(false);
  const [nestedRadio, setNestedRadio] = useState("https");

  // Interactive toggle section
  const [boxEnabled, setBoxEnabled] = useState(true);
  const [toggleCb, setToggleCb] = useState(true);
  const [toggleSw, setToggleSw] = useState(false);
  const [toggleRadio, setToggleRadio] = useState("https");
  const [toggleSeg, setToggleSeg] = useState("grid");

  // Rounded section
  const [roundedCb, setRoundedCb] = useState(true);

  // L11 migration via useResponderForm — see gallery-checkbox.tsx for the
  // annotated reference. Gensym'd sender ids for every control.
  const plainCb1Id = useId();
  const plainCb2Id = useId();
  const borderedSw1Id = useId();
  const borderedSw2Id = useId();
  const filledCb1Id = useId();
  const filledSw1Id = useId();
  const legendCbId = useId();
  const legendSwId = useId();
  const aboveCbId = useId();
  const aboveSwId = useId();
  const nestedCbId = useId();
  const nestedSwId = useId();
  const boxEnabledId = useId();
  const toggleCbId = useId();
  const toggleSwId = useId();
  const roundedCbId = useId();
  const nestedRadioId = useId();
  const toggleRadioId = useId();
  const toggleSegId = useId();

  const { ResponderScope, responderRef } = useResponderForm({
    toggle: {
      [plainCb1Id]: setPlainCb1,
      [plainCb2Id]: setPlainCb2,
      [borderedSw1Id]: setBorderedSw1,
      [borderedSw2Id]: setBorderedSw2,
      [filledCb1Id]: setFilledCb1,
      [filledSw1Id]: setFilledSw1,
      [legendCbId]: setLegendCb,
      [legendSwId]: setLegendSw,
      [aboveCbId]: setAboveCb,
      [aboveSwId]: setAboveSw,
      [nestedCbId]: setNestedCb,
      [nestedSwId]: setNestedSw,
      [boxEnabledId]: setBoxEnabled,
      [toggleCbId]: setToggleCb,
      [toggleSwId]: setToggleSw,
      [roundedCbId]: setRoundedCb,
    },
    selectValue: {
      [nestedRadioId]: setNestedRadio,
      [toggleRadioId]: setToggleRadio,
      [toggleSegId]: setToggleSeg,
    },
  });

  return (
    <ResponderScope>
    <div
      className="cg-content"
      data-testid="gallery-box"
      ref={responderRef as (el: HTMLDivElement | null) => void}
    >

      {/* ---- Variants ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Variants</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

          {/* plain */}
          <div>
            <div style={{ fontSize: "0.75rem", color: "var(--tug7-element-field-text-normal-label-rest)", marginBottom: "6px" }}>plain</div>
            <TugBox variant="plain" label="Preferences" labelPosition="above">
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <TugCheckbox label="Enable notifications" checked={plainCb1} senderId={plainCb1Id} />
                <TugCheckbox label="Auto-save changes" checked={plainCb2} senderId={plainCb2Id} />
              </div>
            </TugBox>
          </div>

          {/* bordered */}
          <div>
            <div style={{ fontSize: "0.75rem", color: "var(--tug7-element-field-text-normal-label-rest)", marginBottom: "6px" }}>bordered</div>
            <TugBox variant="bordered" label="Display">
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <TugSwitch label="Dark mode" checked={borderedSw1} senderId={borderedSw1Id} />
                <TugSwitch label="Reduce motion" checked={borderedSw2} senderId={borderedSw2Id} />
              </div>
            </TugBox>
          </div>

          {/* filled */}
          <div>
            <div style={{ fontSize: "0.75rem", color: "var(--tug7-element-field-text-normal-label-rest)", marginBottom: "6px" }}>filled</div>
            <TugBox variant="filled" label="Access">
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <TugCheckbox label="Remember me" checked={filledCb1} senderId={filledCb1Id} />
                <TugSwitch label="Two-factor auth" checked={filledSw1} senderId={filledSw1Id} />
              </div>
            </TugBox>
          </div>

          {/* separator */}
          <div>
            <div style={{ fontSize: "0.75rem", color: "var(--tug7-element-field-text-normal-label-rest)", marginBottom: "6px" }}>separator</div>
            <TugBox variant="separator" />
          </div>

        </div>
      </div>

      <TugSeparator />

      {/* ---- Label Positions ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Label Positions</TugLabel>
        <div style={{ display: "flex", flexDirection: "row", gap: "24px", alignItems: "flex-start" }}>

          {/* legend (in border line) */}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "0.75rem", color: "var(--tug7-element-field-text-normal-label-rest)", marginBottom: "6px" }}>labelPosition="legend"</div>
            <TugBox variant="bordered" label="Notifications" labelPosition="legend">
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <TugCheckbox label="Email alerts" checked={legendCb} senderId={legendCbId} />
                <TugSwitch label="Push notifications" checked={legendSw} senderId={legendSwId} />
              </div>
            </TugBox>
          </div>

          {/* above */}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "0.75rem", color: "var(--tug7-element-field-text-normal-label-rest)", marginBottom: "6px" }}>labelPosition="above"</div>
            <TugBox variant="bordered" label="Notifications" labelPosition="above">
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <TugCheckbox label="Email alerts" checked={aboveCb} senderId={aboveCbId} />
                <TugSwitch label="Push notifications" checked={aboveSw} senderId={aboveSwId} />
              </div>
            </TugBox>
          </div>

        </div>
      </div>

      <TugSeparator />

      {/* ---- Nested Boxes ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Nested Boxes</TugLabel>
        <TugBox variant="bordered" label="Account Settings">
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <TugCheckbox label="Enable notifications" checked={nestedCb} senderId={nestedCbId} />
            <TugSwitch label="Dark mode" checked={nestedSw} senderId={nestedSwId} />

            <TugBox variant="filled" label="Advanced">
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <TugRadioGroup
                  label="Protocol"
                  value={nestedRadio}
                  senderId={nestedRadioId}
                  orientation="horizontal"
                >
                  <TugRadioItem value="http">HTTP</TugRadioItem>
                  <TugRadioItem value="https">HTTPS</TugRadioItem>
                  <TugRadioItem value="ws">WebSocket</TugRadioItem>
                </TugRadioGroup>
              </div>
            </TugBox>
          </div>
        </TugBox>
      </div>

      <TugSeparator />

      {/* ---- Interactive Disable Toggle ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Disabled Cascade</TugLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <TugSwitch
            label="Enable settings"
            checked={boxEnabled}
            senderId={boxEnabledId}
          />
          <TugBox variant="bordered" label="Settings" disabled={!boxEnabled}>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <TugCheckbox label="Notifications" checked={toggleCb} senderId={toggleCbId} />
              <TugSwitch label="Dark mode" checked={toggleSw} senderId={toggleSwId} />
              <TugRadioGroup
                aria-label="Protocol"
                value={toggleRadio}
                senderId={toggleRadioId}
                orientation="horizontal"
              >
                <TugRadioItem value="http">HTTP</TugRadioItem>
                <TugRadioItem value="https">HTTPS</TugRadioItem>
                <TugRadioItem value="ws">WebSocket</TugRadioItem>
              </TugRadioGroup>
              <TugChoiceGroup
                value={toggleSeg}
                senderId={toggleSegId}
                aria-label="View mode"
                items={[
                  { value: "grid",  label: "Grid"  },
                  { value: "list",  label: "List"  },
                  { value: "table", label: "Table" },
                ]}
              />
              <TugBox variant="filled" label="Nested (also cascades)">
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  <TugCheckbox label="Auto-save" checked={true} />
                  <TugSwitch label="Sync changes" checked={false} />
                </div>
              </TugBox>
            </div>
          </TugBox>
        </div>
      </div>

      <TugSeparator />

      {/* ---- Rounded ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">Border Radius</TugLabel>
        <div style={{ display: "flex", flexDirection: "row", gap: "16px", flexWrap: "wrap", alignItems: "flex-start" }}>
          {(["none", "sm", "md", "lg", "full"] as const).map((r) => (
            <div key={r} style={{ width: "180px" }}>
              <div style={{ fontSize: "0.75rem", color: "var(--tug7-element-field-text-normal-label-rest)", marginBottom: "6px" }}>rounded="{r}"</div>
              <TugBox variant="bordered" label={r} rounded={r}>
                <TugCheckbox label="Option" checked={roundedCb} senderId={roundedCbId} />
              </TugBox>
            </div>
          ))}
        </div>
      </div>

      <TugSeparator />

      {/* ---- Settings group ---- */}
      <div className="cg-section">
        <TugLabel className="cg-section-title">TugSettingsGroup</TugLabel>
        <div style={{ width: "420px", paddingTop: "8px" }}>
          <TugSettingsGroup label="Editing">
            <TugCheckbox label="Auto-save" checked={true} />
            <TugSwitch label="Sync changes" checked={false} />
          </TugSettingsGroup>
        </div>
      </div>

    </div>
    </ResponderScope>
  );
}
