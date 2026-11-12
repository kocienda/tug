/**
 * gallery-tug-sparkline.tsx — `TugSparkline` demo tab for the Component
 * Gallery.
 *
 * Shows each curve over a fixed series, held so it does not scroll. The
 * series and the activity source are static: a live sparkline reads its
 * series from a feed and wakes on its activity.
 *
 * @module components/tugways/cards/gallery-tug-sparkline
 */

import React from "react";

import { TugSparkline, sparklineCurves, type SparklineCurve } from "@/components/tugways/tug-sparkline";
import { TugLabel } from "@/components/tugways/tug-label";

const SERIES = [0, 1, 3, 2, 5, 8, 6, 4, 7, 9, 12, 10, 6, 3, 2, 4, 6, 5, 3, 1];
const getSeries = (): number[] => SERIES;
const subscribeActivity = (): (() => void) => () => {};
const CURVES: { name: string; curve: SparklineCurve }[] = [
  { name: "linear", curve: sparklineCurves.linear },
  { name: "gamma(0.5)", curve: sparklineCurves.gamma(0.5) },
  { name: "log(8)", curve: sparklineCurves.log(8) },
  { name: "soft(3)", curve: sparklineCurves.soft(3) },
];

export function GalleryTugSparkline() {
  return (
    <div className="cg-content" data-testid="gallery-tug-sparkline">
      <div className="cg-section">
        <TugLabel className="cg-section-title">Curves</TugLabel>
        {CURVES.map(({ name, curve }) => (
          <div key={name} style={{ display: "flex", gap: "12px", alignItems: "center" }}>
            <TugLabel size="2xs" emphasis="calm">{name}</TugLabel>
            <TugSparkline
              getSeries={getSeries}
              subscribeActivity={subscribeActivity}
              binMs={1000}
              fullScale={12}
              hold
              curve={curve}
              width={160}
              height={28}
              title={name}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
