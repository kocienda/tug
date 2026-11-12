/**
 * pdf-card-controls.tsx — the shared PDF preference controls, rendered
 * identically in the Settings card's "Viewer Cards" section (deck-wide
 * defaults) and a viewer card's own gear sheet (that card's settings).
 *
 * The two "Opens with" groups are deliberately not the live mode and zoom:
 * the surface already remembers those in the card's bag, and a control here
 * that set them would be a second opinion that drifts the first time a reader
 * pressed ⌘+. They say what a document starts at; the reader's own gestures
 * say where it is now (see `pdf-card-settings.ts`).
 *
 * Laws: controls emit actions to this panel's responder ([L11]); layout is
 * the shared `card-view-controls.css` [L06]; composes real Tug components
 * [use-tug-components].
 *
 * @module components/tugways/cards/pdf-card-controls
 */

import { useId } from "react";

import { TugSettingsGroup } from "../tug-settings-group";
import { TugChoiceGroup } from "../tug-choice-group";
import { TugLabel } from "../tug-label";
import { TugSwitch } from "../tug-switch";
import { TugValueInput } from "../tug-value-input";
import { useResponderForm } from "../use-responder-form";
import {
  PDF_PAGE_GAP_MAX,
  PDF_PAGE_GAP_MIN,
  clampPageGap,
  parsePdfOpeningZoom,
  parsePdfPageMode,
  type PdfCardSettings,
} from "@/lib/pdf-card-settings";
import "./card-view-controls.css";

export interface PdfCardControlsProps {
  settings: PdfCardSettings;
  onChange: (partial: Partial<PdfCardSettings>) => void;
}

export function PdfCardControls({ settings, onChange }: PdfCardControlsProps) {
  const pageModeId = useId();
  const openingZoomId = useId();
  const pageGapId = useId();
  const invertId = useId();

  const { ResponderScope, responderRef } = useResponderForm({
    selectValue: {
      [pageModeId]: (value: string) => {
        const pageMode = parsePdfPageMode(value);
        if (pageMode !== null) onChange({ pageMode });
      },
      [openingZoomId]: (value: string) => {
        const openingZoom = parsePdfOpeningZoom(value);
        if (openingZoom !== null) onChange({ openingZoom });
      },
    },
    setValueNumber: {
      [pageGapId]: (value: number) => onChange({ pageGap: clampPageGap(value) }),
    },
    toggle: {
      [invertId]: (value: boolean) => onChange({ invertInDark: value }),
    },
  });

  return (
    <ResponderScope>
      <div
        className="card-view-controls"
        data-slot="pdf-card-controls"
        data-testid="pdf-card-controls"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        <TugSettingsGroup
          label="Opens With"
          className="card-view-controls-group"
        >
          <div className="card-view-controls-row">
            <TugChoiceGroup
              value={settings.pageMode}
              senderId={pageModeId}
              size="sm"
              data-testid="pdf-option-page-mode"
              items={[
                { value: "continuous", label: "Continuous" },
                { value: "single", label: "Single Page" },
                { value: "two", label: "Two Pages" },
              ]}
            />
          </div>
          <div className="card-view-controls-row">
            <TugChoiceGroup
              value={settings.openingZoom}
              senderId={openingZoomId}
              size="sm"
              data-testid="pdf-option-opening-zoom"
              items={[
                { value: "fit-width", label: "Fit Width" },
                { value: "fit-page", label: "Fit Page" },
                { value: "actual", label: "Actual Size" },
              ]}
            />
          </div>
          <TugLabel size="sm" className="card-view-controls-note">
            How a document opens. Zoom and mode you set while reading stay with
            the document.
          </TugLabel>
        </TugSettingsGroup>

        <TugSettingsGroup
          label="Pages"
          className="card-view-controls-group"
        >
          <div className="card-view-controls-row">
            <TugLabel size="sm">Page gap</TugLabel>
            <TugValueInput
              value={settings.pageGap}
              senderId={pageGapId}
              min={PDF_PAGE_GAP_MIN}
              max={PDF_PAGE_GAP_MAX}
              step={2}
              size="sm"
            />
          </div>
          <div className="card-view-controls-switches">
            <TugSwitch
              label="Invert in dark themes"
              checked={settings.invertInDark}
              senderId={invertId}
              size="md"
              data-testid="pdf-option-invert"
            />
          </div>
        </TugSettingsGroup>
      </div>
    </ResponderScope>
  );
}
