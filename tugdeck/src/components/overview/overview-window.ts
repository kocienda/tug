/**
 * overview-window — the Overview column's window arithmetic. Pure, no DOM.
 *
 * The column is a flex column with a `gap` between its children, a top
 * margin on its first child and a bottom margin on its last. A spacer that
 * stands in for a run of posts is one more child, so the gap sits between it
 * and its neighbours exactly as it sat between the first and last post of
 * the run, and the first- and last-child margins land on whichever element
 * is first or last. That is what makes a spacer of `Σh + (n−1)·gap` leave the
 * column the height it had fully mounted.
 */

/** The height of a spacer standing in for posts of the given heights. */
export function overviewSpacerHeight(heights: readonly number[], gap: number): number {
  if (heights.length === 0) return 0;
  let sum = 0;
  for (const h of heights) sum += h;
  return sum + (heights.length - 1) * gap;
}

/**
 * Every post's top relative to the scrollport, from the measured heights:
 * `firstMargin + Σ_{j<i}(h_j + gap) − scrollTop`. Used where a post may not
 * be mounted, so its rect cannot be read.
 */
export function overviewCellTops(
  heights: readonly number[],
  gap: number,
  firstMargin: number,
  scrollTop: number,
): number[] {
  const tops: number[] = [];
  let offset = firstMargin;
  for (const h of heights) {
    tops.push(offset - scrollTop);
    offset += h + gap;
  }
  return tops;
}

/**
 * The inclusive range of posts that must stay mounted because they hold the
 * selection's endpoints or the focused element, or `null` when none does.
 * Each key may be `null` (that endpoint is not inside a post) or a key no
 * longer in `keys` (ignored).
 */
export function pinnedRangeFor(
  keys: readonly string[],
  anchorKey: string | null,
  focusKey: string | null,
  focusedKey: string | null,
): { first: number; last: number } | null {
  let first = Infinity;
  let last = -Infinity;
  for (const key of [anchorKey, focusKey, focusedKey]) {
    if (key === null) continue;
    const i = keys.indexOf(key);
    if (i === -1) continue;
    if (i < first) first = i;
    if (i > last) last = i;
  }
  return first <= last ? { first, last } : null;
}

/** The key of the in-flight answer's placeholder row, which has no post key. */
export const PENDING_TOP_POST = "pending";

/**
 * Which post sits at the top of the column, for the one pinned header that
 * draws its attribution: a post key, {@link PENDING_TOP_POST}, or `null` when
 * no post is under the scrollport top.
 */
export interface TopPostStore {
  get(): string | null;
  /** Set the key; listeners hear only a change. */
  set(key: string | null): void;
  subscribe(listener: () => void): () => void;
}

export function createTopPostStore(): TopPostStore {
  let key: string | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => key,
    set(next) {
      if (next === key) return;
      key = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
