/**
 * `useChartReportPortals` — mount a chart report into every report host a
 * surface holds.
 *
 * A press on a chart's set opens a panel inside the figure, and the figure's
 * own module stamps one empty host in it carrying the report's id
 * (`data-tugx-chart-report`). That module is plain DOM, reached by both the
 * fence door and the Bash door, and has no React parent; this hook is the
 * bridge. It is driven by the same `onAnnotated` call the span portals take,
 * which a figure raises again whenever a panel opens or closes, so the host
 * list is rebuilt from the live DOM on each pass and never accumulated.
 *
 * Unlike a span host, a report host is born empty: there are no words to
 * save and nothing to clear. Everything under it belongs to the component
 * mounted here, and the figure's annotation pass and the span collectors
 * leave it alone (`insideReport`).
 *
 * Laws:
 *  - [L03] collection runs in the block's layout effect, before paint.
 *  - [L06] nothing here is appearance state: the hosts are identity (which
 *    element, which report).
 *  - [L24] the mount list is structure, replaced only when the hosts change.
 *  - [L26] a portal is keyed by its report's id, so a re-collection that
 *    finds the same host keeps the mounted report and every fold in it.
 *
 * @module components/tugways/chart-report-portals
 */

import React from "react";
import { createPortal } from "react-dom";

import { ChartRefReport } from "@/components/tugways/chart-ref-report";
import { sameMounts, type SpanMount } from "@/components/tugways/use-span-portals";
import { REPORT_HOST_ATTR } from "@/lib/annotator/chart-refs";

/** A report host and the report it holds. */
interface ReportMount extends SpanMount {
  id: string;
}

/**
 * Collect the report hosts in a container and portal a report into each.
 *
 * Returns the callback to hand a markdown block as `onAnnotated`, and the
 * portals to render.
 */
export function useChartReportPortals(): {
  onAnnotated: (container: HTMLElement) => void;
  portals: React.ReactNode;
} {
  const [mounts, setMounts] = React.useState<readonly ReportMount[]>([]);

  const onAnnotated = React.useCallback((container: HTMLElement): void => {
    const next: ReportMount[] = [];
    for (const host of Array.from(container.querySelectorAll<HTMLElement>(`[${REPORT_HOST_ATTR}]`))) {
      const id = host.getAttribute(REPORT_HOST_ATTR);
      if (id === null || id === "") continue;
      next.push({ host, id });
    }
    setMounts((prev) => (sameMounts(prev, next) ? prev : next));
  }, []);

  const portals = mounts.map((mount) => createPortal(<ChartRefReport id={mount.id} />, mount.host, mount.id));

  return { onAnnotated, portals };
}
