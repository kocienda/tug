"use client";

import { ArcGauge, type ArcGaugeProps } from "./ArcGauge";
import { retronow } from "./retronow-classes";

export type ArcGaugeCardProps = ArcGaugeProps & {
  title?: string;
  description?: string;
  cardClassName?: string;
  gaugeClassName?: string;
};

export function ArcGaugeCard({
  title = "Arc Gauge",
  description,
  cardClassName,
  gaugeClassName,
  ...gaugeProps
}: ArcGaugeCardProps) {
  return (
    <section className={[retronow.panel, "p-2", cardClassName || ""].join(" ")}>
      <header className="mb-2 border-b border-[var(--rn-border-soft)] pb-1">
        <h3 className="rn-panel-title">{title}</h3>
        {description ? <p className="rn-status-line mt-1">{description}</p> : null}
      </header>
      <ArcGauge {...gaugeProps} className={gaugeClassName} />
    </section>
  );
}

