/**
 * `chart-share-capture` — take the page's chart choices for a share, and put
 * a share's choices on a page.
 *
 * The shape and what it means are `chart-share-state`'s. This module is the
 * two acts that reach the page's memories and its report store: the card's
 * page captures when a share is made, and the share page seeds before it
 * mounts. They are apart from the shape so the share document's module can
 * read the shape without reaching the store.
 *
 * @module lib/chart/chart-share-capture
 */

import { openMarkEntries, rememberOpenMark } from "@/lib/chart/chart-open-memory";
import { seedReport, snapshotReport } from "@/lib/chart/chart-report-store";
import type { ChartShareState } from "@/lib/chart/chart-share-state";
import { rememberChartView, tableViewHashes } from "@/lib/chart/chart-view-memory";

/** The page's chart choices as they stand. */
export function captureChartShareState(): ChartShareState {
  return {
    tables: tableViewHashes(),
    opens: openMarkEntries().map(([hash, mark]) => ({
      hash,
      anchor: mark.anchor,
      report: mark.reportId === null ? null : snapshotReport(mark.reportId),
    })),
  };
}

/** Put `state` into this page's memories, each report seeded sealed. */
export function seedChartShareState(state: ChartShareState): void {
  for (const hash of state.tables) rememberChartView(hash, "table");
  for (const open of state.opens) {
    rememberOpenMark(open.hash, {
      anchor: open.anchor,
      reportId: open.report === null ? null : seedReport(open.report),
    });
  }
}
