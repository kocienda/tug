/**
 * Which mark of a chart has its report open, by source hash.
 *
 * A reader who opens a mark's report wants it to stay until they close it.
 * The figure is rebuilt under them all the same: a transcript cell remounts
 * as it scrolls back into view, a stream rewrite re-renders the row. The
 * panel is DOM the figure builds ([L06]), so what is open is kept here in a
 * module map, as the Table view's choice is (`chart-view-memory`), and
 * `renderChartInto` consults it when it has built a figure ([L23]).
 *
 * An entry names the pressed anchor and the report registered for it, so the
 * pages already read come back with the panel. The memory is bounded: past
 * the bound the oldest entry goes first, and the caller is handed what went
 * so it can drop that report ([L27]).
 *
 * @module lib/chart/chart-open-memory
 */

/** One open mark: the anchor pressed, and the report it opened. */
export interface OpenMark {
  /** The pressed anchor, as `anchorKey` writes it. */
  anchor: string;
  /** The report registered for the panel, or null for a plain member list. */
  reportId: string | null;
}

/** How many open marks the page remembers. */
export const OPEN_MEMORY_LIMIT = 64;

/** Insertion-ordered, so the oldest entry is the first key. */
export type ChartOpenMemory = Map<string, OpenMark>;

const memory: ChartOpenMemory = new Map();

/** A fresh, empty memory, for tests that want one of their own. */
export function newChartOpenMemory(): ChartOpenMemory {
  return new Map();
}

/**
 * Record `mark` as the open one of the chart with source hash `hash`, as the
 * newest entry. Returns the entries that fell past the limit.
 */
export function rememberOpenMark(
  hash: string,
  mark: OpenMark,
  store: ChartOpenMemory = memory,
  limit: number = OPEN_MEMORY_LIMIT,
): OpenMark[] {
  store.delete(hash);
  store.set(hash, mark);
  const evicted: OpenMark[] = [];
  while (store.size > limit) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    const gone = store.get(oldest);
    store.delete(oldest);
    if (gone !== undefined) evicted.push(gone);
  }
  return evicted;
}

/** Forget the open mark of the chart with source hash `hash`, and return it. */
export function forgetOpenMark(hash: string, store: ChartOpenMemory = memory): OpenMark | null {
  const mark = store.get(hash) ?? null;
  store.delete(hash);
  return mark;
}

/** The open mark of the chart with source hash `hash`, or null. */
export function recallOpenMark(hash: string, store: ChartOpenMemory = memory): OpenMark | null {
  return store.get(hash) ?? null;
}
