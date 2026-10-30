/**
 * `chart-lines.ts` — the `TUG-CHART:` stdout door, read purely.
 *
 * A command may put a chart in its stdout the way `tugtool file edit` puts
 * a receipt there: one line whose trimmed start is `TUG-CHART: ` followed
 * by one JSON object on the same line, a layer 1 spec or a layer 0 program.
 * The deck holds the whole stdout, so the deck reads the line — the mirror
 * of `receiptPaths` in `written-paths.ts`, with the same posture: a line is
 * matched by its head alone, and a line whose JSON does not parse is still
 * a chart, one the renderer shows as invalid beside its text.
 *
 * What comes out: the stdout with every chart line removed (the terminal
 * never shows the JSON), the chart sources in order, and how many past the
 * limit were stripped without being kept. A marker in mid-line is prose.
 *
 * @module lib/chart/chart-lines
 */

/** The head of a chart line, after leading whitespace. */
export const CHART_LINE_PREFIX = "TUG-CHART: ";

/** How many charts one call may render; further lines are stripped and counted. */
export const CHART_LINE_LIMIT = 8;

export interface SplitChartLines {
  /** The stdout with every chart line removed. */
  text: string;
  /** The chart sources kept, in stdout order, at most `CHART_LINE_LIMIT`. */
  charts: string[];
  /** Chart lines past the limit: stripped from `text`, not in `charts`. */
  dropped: number;
}

/**
 * Split `stdout` into its terminal text and its chart lines.
 *
 * Pure. Lines are split on `\n` and rejoined with it, so a stdout with no
 * chart line comes back byte-identical, and one whose chart line was the
 * last line keeps its trailing newline shape.
 */
export function splitChartLines(stdout: string, limit: number = CHART_LINE_LIMIT): SplitChartLines {
  if (!stdout.includes(CHART_LINE_PREFIX)) return { text: stdout, charts: [], dropped: 0 };
  const kept: string[] = [];
  const charts: string[] = [];
  let dropped = 0;
  for (const line of stdout.split("\n")) {
    const head = line.trimStart();
    if (!head.startsWith(CHART_LINE_PREFIX)) {
      kept.push(line);
      continue;
    }
    if (charts.length < limit) charts.push(head.slice(CHART_LINE_PREFIX.length).trim());
    else dropped += 1;
  }
  return { text: kept.join("\n"), charts, dropped };
}
