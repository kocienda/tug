/**
 * image-card-controls.tsx — the shared image view-setting controls,
 * rendered identically in two places: the Settings card's "Viewer Cards"
 * section (bound to the deck-wide defaults) and a viewer card's own gear
 * sheet (bound to that card's local settings). One component so the two
 * always look the same — the `TextCardControls` arrangement, and for the
 * same reason.
 *
 * Presentational + chain-wired: the caller passes the current `settings` and
 * an `onChange` that persists a partial; the controls dispatch through this
 * component's own `useResponderForm` responder ([L11]).
 *
 * Laws: controls emit actions to this panel's responder ([L11]); layout is
 * the shared `card-view-controls.css` [L06]; composes real Tug components
 * [use-tug-components].
 *
 * @module components/tugways/cards/image-card-controls
 */

import { useId } from "react";

import { TugSettingsGroup } from "../tug-settings-group";
import { TugChoiceGroup } from "../tug-choice-group";
import { TugLabel } from "../tug-label";
import { TugSwitch } from "../tug-switch";
import { useResponderForm } from "../use-responder-form";
import {
  parseImageBackground,
  parseImageScaling,
  type ImageCardSettings,
} from "@/lib/image-card-settings";
import "./card-view-controls.css";

export interface ImageCardControlsProps {
  settings: ImageCardSettings;
  onChange: (partial: Partial<ImageCardSettings>) => void;
}

export function ImageCardControls({ settings, onChange }: ImageCardControlsProps) {
  const scalingId = useId();
  const backgroundId = useId();
  const smoothingId = useId();
  const showInfoId = useId();

  const { ResponderScope, responderRef } = useResponderForm({
    selectValue: {
      // The parse guards are not ceremony: `selectValue` carries a string, and
      // the only string this group can send is one of its own segments — but
      // the settings type says which three, and a value that is not one of
      // them must not be written into the store.
      [scalingId]: (value: string) => {
        const scaling = parseImageScaling(value);
        if (scaling !== null) onChange({ scaling });
      },
      [backgroundId]: (value: string) => {
        const background = parseImageBackground(value);
        if (background !== null) onChange({ background });
      },
    },
    toggle: {
      [smoothingId]: (value: boolean) => onChange({ smoothing: value }),
      [showInfoId]: (value: boolean) => onChange({ showInfo: value }),
    },
  });

  return (
    <ResponderScope>
      <div
        className="card-view-controls"
        data-slot="image-card-controls"
        data-testid="image-card-controls"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        <TugSettingsGroup
          label="Scaling"
          className="card-view-controls-group"
        >
          <div className="card-view-controls-row">
            <TugChoiceGroup
              value={settings.scaling}
              senderId={scalingId}
              size="sm"
              data-testid="image-option-scaling"
              items={[
                { value: "fit", label: "Fit" },
                { value: "fill", label: "Fill" },
                { value: "actual", label: "Actual Size" },
              ]}
            />
          </div>
        </TugSettingsGroup>

        <TugSettingsGroup
          label="Background"
          className="card-view-controls-group"
        >
          <div className="card-view-controls-row">
            <TugChoiceGroup
              value={settings.background}
              senderId={backgroundId}
              size="sm"
              data-testid="image-option-background"
              items={[
                { value: "checker", label: "Checkerboard" },
                { value: "surface", label: "Surface" },
                { value: "black", label: "Black" },
                { value: "white", label: "White" },
              ]}
            />
          </div>
          <TugLabel size="sm" className="card-view-controls-note">
            What shows through a transparent image.
          </TugLabel>
        </TugSettingsGroup>

        <TugSettingsGroup
          label="Display"
          className="card-view-controls-group"
        >
          <div className="card-view-controls-switches">
            <TugSwitch
              label="Smoothing"
              checked={settings.smoothing}
              senderId={smoothingId}
              size="md"
              data-testid="image-option-smoothing"
            />
            <TugSwitch
              label="Show image info"
              checked={settings.showInfo}
              senderId={showInfoId}
              size="md"
              data-testid="image-option-show-info"
            />
          </div>
        </TugSettingsGroup>
      </div>
    </ResponderScope>
  );
}
