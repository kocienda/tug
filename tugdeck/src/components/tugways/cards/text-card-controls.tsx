/**
 * text-card-controls.tsx — the shared Typography + Editing + Display controls for
 * the Text Card's view settings, rendered identically in two places:
 * the Settings card's "Text Files" tab (bound to the deck-wide
 * defaults) and each Text card's gear popover (bound to that card's
 * local settings). One component so the two always look the same.
 *
 * Presentational + chain-wired: the caller passes the current
 * `settings` and an `onChange` that persists a partial; the controls
 * dispatch through this component's own `useResponderForm` responder.
 *
 * Laws: controls emit actions to this panel's responder ([L11]);
 * layout lives in text-card-controls.css [L06]; composes real Tug
 * components [use-tug-components].
 *
 * @module components/tugways/cards/text-card-controls
 */

import React, { useId } from "react";
import { TugBox } from "../tug-box";
import { TugLabel } from "../tug-label";
import { TugPopupButton } from "../tug-popup-button";
import { TugSwitch } from "../tug-switch";
import { TugValueInput } from "../tug-value-input";
import { useResponderForm } from "../use-responder-form";
import { EDITOR_FONT_OPTIONS, FONT_SIZE_OPTIONS } from "./editor-font-options";
import { FONT_DEFAULT_SIZES } from "@/lib/editor-settings-store";
import { clampTabSize, type TextCardSettings } from "@/lib/text-card-settings";
import "./text-card-controls.css";

export interface TextCardControlsProps {
  settings: TextCardSettings;
  onChange: (partial: Partial<TextCardSettings>) => void;
}

export function TextCardControls({ settings, onChange }: TextCardControlsProps) {
  const fontPopupId = useId();
  const fontSizePopupId = useId();
  const softTabsId = useId();
  const lineWrapId = useId();
  const tabSizeId = useId();
  const lineNumbersId = useId();
  const foldGutterId = useId();
  const activeLineId = useId();
  const showSpacesId = useId();
  const showTabsId = useId();

  const { ResponderScope, responderRef } = useResponderForm({
    toggle: {
      [softTabsId]: (v: boolean) => onChange({ softTabs: v }),
      [lineWrapId]: (v: boolean) => onChange({ lineWrap: v }),
      [lineNumbersId]: (v: boolean) => onChange({ lineNumbers: v }),
      [foldGutterId]: (v: boolean) => onChange({ foldGutter: v }),
      [activeLineId]: (v: boolean) => onChange({ highlightActiveLine: v }),
      [showSpacesId]: (v: boolean) => onChange({ showSpaces: v }),
      [showTabsId]: (v: boolean) => onChange({ showTabs: v }),
    },
    setValueNumber: {
      [tabSizeId]: (v: number) => onChange({ tabSize: clampTabSize(v) }),
      [fontSizePopupId]: (v: number) => onChange({ fontSize: v }),
    },
    setValueString: {
      // Picking a face carries its own default size, exactly as the prompt
      // editor's store does — a mono face reads larger than a proportional
      // one at the same point size.
      [fontPopupId]: (v: string) =>
        onChange({ fontId: v, fontSize: FONT_DEFAULT_SIZES[v] ?? settings.fontSize }),
    },
  });

  return (
    <ResponderScope>
      <div
        className="text-card-controls"
        data-slot="text-card-controls"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        <TugBox
          label="Typography"
          labelPosition="legend"
          variant="bordered"
          className="text-card-controls-group"
        >
          <div className="text-card-controls-row">
            <TugPopupButton
              className="text-card-controls-popup text-card-controls-popup-font"
              topLabel="Font"
              label={
                EDITOR_FONT_OPTIONS.find(f => f.value === settings.fontId)?.label ??
                "Font"
              }
              items={EDITOR_FONT_OPTIONS}
              senderId={fontPopupId}
              size="sm"
            />
            <TugPopupButton
              className="text-card-controls-popup text-card-controls-popup-size"
              topLabel="Size"
              label={`${settings.fontSize}px`}
              items={FONT_SIZE_OPTIONS}
              senderId={fontSizePopupId}
              size="sm"
            />
          </div>
        </TugBox>

        <TugBox
          label="Tabs & Spaces"
          labelPosition="legend"
          variant="bordered"
          className="text-card-controls-group text-card-controls-group-inline"
        >
          <div className="text-card-controls-switches">
            <TugSwitch
              label="Auto-expand tabs"
              checked={settings.softTabs}
              senderId={softTabsId}
              size="md"
              data-testid="text-card-option-soft-tabs"
            />
            <TugSwitch
              label="Soft wrap text"
              checked={settings.lineWrap}
              senderId={lineWrapId}
              size="md"
              data-testid="text-card-option-line-wrap"
            />
          </div>
          <div className="text-card-controls-row">
            <TugLabel size="sm">Spaces per tab</TugLabel>
            <TugValueInput
              value={settings.tabSize}
              senderId={tabSizeId}
              min={1}
              max={16}
              step={1}
              size="sm"
            />
          </div>
        </TugBox>

        <TugBox
          label="Display"
          labelPosition="legend"
          variant="bordered"
          className="text-card-controls-group"
        >
          <div className="text-card-controls-switches">
            <TugSwitch
              label="Line numbers"
              checked={settings.lineNumbers}
              senderId={lineNumbersId}
              size="md"
              data-testid="text-card-option-line-numbers"
            />
            <TugSwitch
              label="Fold gutter"
              checked={settings.foldGutter}
              senderId={foldGutterId}
              size="md"
              data-testid="text-card-option-fold-gutter"
            />
            <TugSwitch
              label="Active line"
              checked={settings.highlightActiveLine}
              senderId={activeLineId}
              size="md"
              data-testid="text-card-option-active-line"
            />
            <TugSwitch
              label="Show spaces"
              checked={settings.showSpaces}
              senderId={showSpacesId}
              size="md"
              data-testid="text-card-option-show-spaces"
            />
            <TugSwitch
              label="Show tabs"
              checked={settings.showTabs}
              senderId={showTabsId}
              size="md"
              data-testid="text-card-option-show-tabs"
            />
          </div>
        </TugBox>
      </div>
    </ResponderScope>
  );
}
