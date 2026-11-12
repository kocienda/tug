/**
 * gallery-tug-step-row.tsx — `TugStepRow` demo tab for the Component Gallery.
 *
 * Shows every status, both densities, both detail placements and the
 * optional body slot.
 *
 * @module components/tugways/cards/gallery-tug-step-row
 */

import React from "react";

import {
  TugStepRow,
  type TugStepRowDensity,
  type TugStepRowStatus,
} from "@/components/tugways/tug-step-row";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const STATUSES: TugStepRowStatus[] = ["pending", "active", "busy", "paused", "error", "done"];
const DENSITIES: TugStepRowDensity[] = ["regular", "compact"];

const listStyle: React.CSSProperties = { listStyle: "none", margin: 0, padding: 0 };

export function GalleryTugStepRow() {
  return (
    <div className="cg-content" data-testid="gallery-tug-step-row">
      {DENSITIES.map((density) => (
        <React.Fragment key={density}>
          <div className="cg-section">
            <TugLabel className="cg-section-title">{`Statuses — density="${density}"`}</TugLabel>
            <ul style={listStyle}>
              {STATUSES.map((status) => (
                <TugStepRow
                  key={status}
                  stepKey={status}
                  status={status}
                  density={density}
                  label={`Step in status "${status}"`}
                  detail={status === "error" ? "the checkpoint failed" : undefined}
                />
              ))}
            </ul>
          </div>
          <TugSeparator />
        </React.Fragment>
      ))}

      <div className="cg-section">
        <TugLabel className="cg-section-title">Detail placement and body</TugLabel>
        <ul style={listStyle}>
          <TugStepRow status="done" label="Detail below" detail="0c503efdb" detailPlacement="below" />
          <TugStepRow status="done" label="Detail trailing" detail="0c503efdb" detailPlacement="trailing" />
          <TugStepRow
            status="busy"
            label="With a body"
            body={<TugLabel size="2xs" emphasis="calm">Body content sits under the label.</TugLabel>}
          />
        </ul>
      </div>
    </div>
  );
}
