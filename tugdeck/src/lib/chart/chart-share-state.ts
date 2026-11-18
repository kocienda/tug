/**
 * `chart-share-state` — what the reader did to the page's charts, as a share
 * carries it.
 *
 * A chart in a card is more than its spec: the reader may have turned it to
 * its Table view, and may have pressed a mark and be reading its report. Both
 * are kept by the chart's source hash in module memory (`chart-view-memory`,
 * `chart-open-memory`), and the report's rows are in `chart-report-store`. A
 * share is a picture of the card as it stands, so the render document carries
 * all three, and the share page seeds its own memories with them before it
 * mounts. The same renderer then builds each figure in the view it was left
 * in, with the pressed mark ringed and its report beneath, from the rows the
 * card had read: the share page has nobody to ask, so a seeded report is
 * sealed and reads nothing.
 *
 * The state is the whole page's, not the shared turns': a chart's hash does
 * not say which turn drew it. A state whose chart is not in the document is
 * never drawn. A chart's hash is of its source as the page receives it, so a
 * chart whose source the secret scrub rewrote is drawn closed.
 *
 * The words a report's rows show are scrubbed with the turns' own
 * ({@link collectChartShareStrings}, {@link applyChartShareStrings}). Only
 * the fields that are prose or paths are sent: a sha, a ref and an id are
 * what the rows are keyed and drawn by, and are not text a secret hides in.
 *
 * This module is the state's shape and its pure walks, which the share
 * document's own module reads; taking the state off the page and putting it
 * on one is `chart-share-capture`, which reaches the memories and the store.
 *
 * @module lib/chart/chart-share-state
 */

import type { ReportSnapshot } from "@/lib/chart/chart-report-store";

/** One chart's open mark, and the report it held. */
export interface ChartShareOpen {
  /** The chart's source hash. */
  hash: string;
  /** The pressed anchor, as `anchorKey` writes it. */
  anchor: string;
  /** The report as it stood, or null for a plain member list. */
  report: ReportSnapshot | null;
}

/** The reader's choices on the page's charts. */
export interface ChartShareState {
  /** The source hash of every chart in its Table view. */
  tables: string[];
  opens: ChartShareOpen[];
}

/** A state that says nothing. */
export const EMPTY_CHART_SHARE_STATE: ChartShareState = Object.freeze({ tables: [], opens: [] }) as ChartShareState;


/** The row fields whose text a reader sees and a secret could be in. */
const SCRUBBED_KEYS: ReadonlySet<string> = new Set([
  "subject",
  "body",
  "title",
  "author",
  "committer",
  "committer_email",
  "files",
  "path",
  "head",
  "label",
  "group",
  "projectLeaf",
]);

/**
 * Walk `value` in a fixed order and hand each scrubbed-key string to `visit`,
 * building the same shape from what `visit` returns. `scrubbed` says the
 * value sits under a scrubbed key: a string there is visited, and so is each
 * string of an array there. An object's fields are judged by their own keys.
 */
function walk(value: unknown, scrubbed: boolean, visit: (text: string) => string): unknown {
  if (typeof value === "string") return scrubbed ? visit(value) : value;
  if (Array.isArray(value)) return value.map((item) => walk(item, scrubbed, visit));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = walk(child, SCRUBBED_KEYS.has(key), visit);
  }
  return out;
}

/** A snapshot's rows, and its nested reports' rows, through `visit`. */
function walkReport(report: ReportSnapshot, visit: (text: string) => string): ReportSnapshot {
  return {
    ...report,
    rows: walk(report.rows, false, visit) as ReportSnapshot["rows"],
    nested: report.nested.map((under) => ({ ref: under.ref, report: walkReport(under.report, visit) })),
  };
}

function walkState(state: ChartShareState, visit: (text: string) => string): ChartShareState {
  return {
    tables: state.tables,
    opens: state.opens.map((open) => ({
      ...open,
      report: open.report === null ? null : walkReport(open.report, visit),
    })),
  };
}

/** The strings of `state` a share shows, in the order {@link applyChartShareStrings} takes them back. */
export function collectChartShareStrings(state: ChartShareState): string[] {
  const texts: string[] = [];
  walkState(state, (text) => {
    texts.push(text);
    return text;
  });
  return texts;
}

/**
 * `state` with its strings replaced by `texts`, the scrub's answer to
 * {@link collectChartShareStrings}; `null` when the answer is the wrong length.
 */
export function applyChartShareStrings(state: ChartShareState, texts: ReadonlyArray<string>): ChartShareState | null {
  let next = 0;
  const applied = walkState(state, () => texts[next++] ?? "");
  return next === texts.length ? applied : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isReportSnapshot(value: unknown): value is ReportSnapshot {
  if (!isRecord(value) || !isRecord(value.descriptor) || !Array.isArray(value.rows)) return false;
  if (typeof value.fetched !== "number" || !Array.isArray(value.nested)) return false;
  if (!value.rows.every((row) => isRecord(row) && typeof row.kind === "string")) return false;
  return value.nested.every(
    (under) => isRecord(under) && typeof under.ref === "string" && isReportSnapshot(under.report),
  );
}

/**
 * A chart share state read from a decoded document's field. An absent field
 * is the empty state; a field of the wrong shape is `null`.
 */
export function readChartShareState(value: unknown): ChartShareState | null {
  if (value === undefined) return EMPTY_CHART_SHARE_STATE;
  if (!isRecord(value) || !Array.isArray(value.tables) || !Array.isArray(value.opens)) return null;
  if (!value.tables.every((hash) => typeof hash === "string")) return null;
  for (const open of value.opens) {
    if (!isRecord(open) || typeof open.hash !== "string" || typeof open.anchor !== "string") return null;
    if (open.report !== null && !isReportSnapshot(open.report)) return null;
  }
  return value as unknown as ChartShareState;
}
