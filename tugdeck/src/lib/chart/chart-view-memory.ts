/**
 * Which view a chart was last shown in, by source hash.
 *
 * A reader who flips a chart to its table wants it back as a table when
 * the row is rebuilt — a stream rewrite, a transcript remount, a card that
 * moved workspaces. The choice is appearance: a `data-tugx-chart-view`
 * attribute the renderer stamps and CSS reads ([L06]), so it is kept here
 * in a module map rather than in React state, and `renderChartInto`
 * consults it when it builds a figure, which is how an implementation
 * remount never loses what the reader set ([L23]).
 *
 * The memory holds only the non-default: a chart is a chart unless it was
 * put in table view. It is bounded, and past the bound the oldest entry
 * goes first.
 *
 * @module lib/chart/chart-view-memory
 */

export type ChartView = "chart" | "table";

/** How many table-view choices the page remembers. */
export const VIEW_MEMORY_LIMIT = 512;

/** Insertion-ordered, so the oldest choice is the first key. */
export type ChartViewMemory = Map<string, "table">;

const memory: ChartViewMemory = new Map();

/** A fresh, empty memory — for tests that want one of their own. */
export function newChartViewMemory(): ChartViewMemory {
  return new Map();
}

/**
 * Record the view a chart with source hash `hash` was put in. Setting
 * `chart` forgets the hash; setting `table` remembers it as the newest
 * entry and drops the oldest past the limit.
 */
export function rememberChartView(
  hash: string,
  view: ChartView,
  store: ChartViewMemory = memory,
  limit: number = VIEW_MEMORY_LIMIT,
): void {
  store.delete(hash);
  if (view === "chart") return;
  store.set(hash, "table");
  while (store.size > limit) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** The view a chart with source hash `hash` should be built in. */
export function recallChartView(hash: string, store: ChartViewMemory = memory): ChartView {
  return store.has(hash) ? "table" : "chart";
}
