/**
 * document-find-engine — Find over a read-only document that is wholly in
 * the DOM, behind the shared {@link FindEngineDelegate} protocol.
 *
 * The Text card searches its CodeMirror document and the Session card its
 * whole-transcript index. A help document is neither: every block of it is
 * rendered in flow (`TugMarkdownBlock`), so the DOM is the document, and the
 * engine searches the DOM's own text. That is the whole difference, and it
 * removes the step the transcript painter needs — there is no projection to
 * disagree with the page, so a match's offsets are offsets into the same
 * text nodes the paint walks.
 *
 * The match set is computed by the transcript's own matcher
 * (`transcript-search.ts`), so Case, Word and Grep mean here what they mean
 * everywhere. The text is gathered with the transcript painter's walk
 * (`collectSearchableTextNodes`), which skips math source and chip labels.
 * Paint is two Custom Highlights of this engine's own, coloured by the one
 * find token family (`transcript-find.css`), registered only while they hold
 * ranges. The active match is revealed in the scroller when it is off
 * screen and ringed with the shared landing flash.
 *
 * The document is static while a search runs — a help card renders its text
 * once — so the match set is computed on each query change and kept.
 *
 * Laws: [L06] appearance through the Highlight registry and CSS, never React
 * state; [L07] the root and scroller are read through getters at the moment
 * each operation runs.
 *
 * @module components/tugways/document-find-engine
 */

import "./transcript-find.css";
import "./document-find.css";

import type { FindEngineDelegate, FindMatchInfo } from "@/lib/find-session";
import { search, DEFAULT_MATCH_LIMIT } from "@/lib/transcript-search";
import { placeFindFlash, type FindFlashHandle } from "@/components/tugways/find-flash";
import {
  collectSearchableTextNodes,
  rangeFromNodes,
} from "@/components/tugways/transcript-find-highlighter";

/** This engine's two highlight names (`document-find.css`). */
export const DOCUMENT_FIND_MATCH = "document-find-match";
export const DOCUMENT_FIND_ACTIVE = "document-find-active";

/** Space kept above a revealed match, so it does not sit on the edge. */
const REVEAL_MARGIN_PX = 48;

export interface DocumentFindTargets {
  /** The document whose text is searched. */
  root(): HTMLElement | null;
  /** The element that scrolls it — the reveal and the flash's host. */
  scroller(): HTMLElement | null;
}

function highlights(): { match: Highlight; active: Highlight } | null {
  if (typeof CSS === "undefined" || CSS.highlights === undefined) return null;
  return { match: new Highlight(), active: new Highlight() };
}

function register(name: string, highlight: Highlight): void {
  if (highlight.size > 0) CSS.highlights.set(name, highlight);
  else CSS.highlights.delete(name);
}

/**
 * The first match at or below the scroller's top edge — where a reader who
 * opens Find is looking — or the first match when every one is above it.
 */
function landingIndex(ranges: readonly Range[], scroller: HTMLElement | null): number {
  if (ranges.length === 0 || scroller === null) return 0;
  const top = scroller.getBoundingClientRect().top;
  const index = ranges.findIndex((r) => r.getBoundingClientRect().top >= top);
  return index === -1 ? 0 : index;
}

/** Bring `range` into the scroller's view when it is not already there. */
function reveal(range: Range, scroller: HTMLElement): void {
  const rect = range.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  if (rect.top >= view.top && rect.bottom <= view.bottom) return;
  scroller.scrollTop += rect.top - view.top - REVEAL_MARGIN_PX;
}

export function documentFindEngine(targets: DocumentFindTargets): FindEngineDelegate {
  const paint = highlights();
  let ranges: Range[] = [];
  let active: number | null = null;
  let capped = false;
  let flash: FindFlashHandle | null = null;

  const repaint = (): void => {
    if (paint === null) return;
    paint.match.clear();
    paint.active.clear();
    ranges.forEach((range, index) => {
      (index === active ? paint.active : paint.match).add(range);
    });
    register(DOCUMENT_FIND_MATCH, paint.match);
    register(DOCUMENT_FIND_ACTIVE, paint.active);
  };

  const land = (): void => {
    repaint();
    const scroller = targets.scroller();
    if (active === null || scroller === null) return;
    const range = ranges[active];
    reveal(range, scroller);
    flash?.remove();
    flash = placeFindFlash(scroller, range.getBoundingClientRect());
  };

  const step = (delta: 1 | -1): void => {
    if (ranges.length === 0) return;
    const from = active ?? (delta === 1 ? -1 : 0);
    active = (from + delta + ranges.length) % ranges.length;
    land();
  };

  return {
    searchDidChange: (query, options) => {
      const root = targets.root();
      const nodes = root === null ? [] : collectSearchableTextNodes(root);
      const text = nodes.map((n) => n.data).join("");
      const matches = search([text], query, options);
      capped = matches.length >= DEFAULT_MATCH_LIMIT;
      ranges = matches
        .map((m) => rangeFromNodes(nodes, m.start, m.end))
        .filter((r): r is Range => r !== null);
      active = ranges.length === 0 ? null : landingIndex(ranges, targets.scroller());
      land();
    },
    findNext: () => step(1),
    findPrevious: () => step(-1),
    matchInfo: (): FindMatchInfo => ({ count: ranges.length, activeOrdinal: active, capped }),
    clear: () => {
      ranges = [];
      active = null;
      capped = false;
      flash?.remove();
      flash = null;
      repaint();
    },
  };
}
