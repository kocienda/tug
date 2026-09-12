/**
 * filter-mark-painter — the list filter's mark, painted over rendered DOM.
 *
 * `renderFilterHighlight` composes `<mark>` elements while a row renders, and
 * that is the right shape for a row whose ink is a string the row itself cut
 * up. It cannot serve a run a markdown pipeline built: the description line
 * renders through `TugMarkdownBlock`, whose DOM is written imperatively by the
 * parse and the annotator, and there is no render-time seam to nest a `<mark>`
 * into ([B08] of the narration-one brief).
 *
 * So the mark for that run is painted the way transcript Find paints its own —
 * DOM Ranges in a registered CSS Custom Highlight, over the live text. The
 * walk is literally Find's (`collectFindableUnits` and friends), so the two
 * marks agree about what "searchable" means, and the matcher is literally the
 * other filter marks' (`filterHighlightRanges`), so a term that marks a row's
 * title marks its description on the same rule.
 *
 * **One highlight name, one registry.** `CSS.highlights` is document-global, so
 * every painted container feeds ONE `Highlight` object here rather than each
 * claiming the name in turn — several rail rows are marked at once and the
 * last one to paint must not erase the rest. A container that has left the
 * document drops out on the next paint, which is what makes a remounted
 * markdown block (a new post, a new key) cost nothing to clean up.
 *
 * The name is its own — `tug-filter-mark`, coloured in `tug-filter-field.css`
 * from `--tugx-filter-mark-bg`, the same token `.tug-filter-mark` reads. It is
 * deliberately NOT one of transcript Find's two names: those are claimed by
 * whichever card is searching, and a rail filter that seized them would erase
 * the Find route's paint in the card beside it.
 *
 * Laws: [L06] appearance is DOM and CSS, never React state.
 *
 * @module components/tugways/filter-mark-painter
 */

import {
  collectFindableUnits,
  collectSearchableTextNodes,
  rangeFromNodes,
} from "@/components/tugways/transcript-find-highlighter";
import { filterHighlightRanges } from "@/lib/text-match";

/** The registered highlight name; `tug-filter-field.css` colours it. */
export const FILTER_MARK_HIGHLIGHT = "tug-filter-mark";

/** Every container currently asking for a mark, and the query it asked with. */
const painted = new Map<HTMLElement, string>();

let highlight: Highlight | null = null;

/** The one `Highlight`, created on first use — absent where the API is not. */
function ensureHighlight(): Highlight | null {
  if (highlight !== null) return highlight;
  if (typeof CSS === "undefined" || CSS.highlights === undefined) return null;
  highlight = new Highlight();
  return highlight;
}

/**
 * Rebuild the single highlight from every registered container.
 *
 * Recomputed rather than patched: the ranges belong to DOM that the markdown
 * pipeline and the annotator both rewrite, so a range held from an earlier
 * paint is a range into nodes that may no longer be in the tree.
 */
function repaint(): void {
  const hl = ensureHighlight();
  if (hl === null) return;
  hl.clear();
  let any = false;
  for (const [container, query] of [...painted]) {
    if (!container.isConnected) {
      painted.delete(container);
      continue;
    }
    if (query === "") continue;
    for (const unit of collectFindableUnits(container)) {
      const nodes = collectSearchableTextNodes(unit);
      const text = nodes.map((n) => n.data).join("");
      for (const [start, end] of filterHighlightRanges(query, text)) {
        const range = rangeFromNodes(nodes, start, end);
        if (range === null) continue;
        hl.add(range);
        any = true;
      }
    }
  }
  if (any) {
    CSS.highlights.set(FILTER_MARK_HIGHLIGHT, hl);
  } else {
    CSS.highlights.delete(FILTER_MARK_HIGHLIGHT);
  }
}

/**
 * Mark `query`'s matches inside `container`, replacing whatever it asked for
 * before. An empty query registers the container with nothing to paint, which
 * is how a cleared filter unmarks it.
 *
 * Call it whenever either side moves: the query, or the DOM the container
 * holds (a markdown block's `onAnnotated` is exactly that signal).
 */
export function setFilterMarks(container: HTMLElement, query: string): void {
  painted.set(container, query);
  repaint();
}

/** Forget `container` — on unmount, or when a row stops being marked. */
export function clearFilterMarks(container: HTMLElement): void {
  if (!painted.delete(container)) return;
  repaint();
}

/** Test seam: the containers currently registered, oldest first. */
export function _paintedContainersForTest(): HTMLElement[] {
  return [...painted.keys()];
}
