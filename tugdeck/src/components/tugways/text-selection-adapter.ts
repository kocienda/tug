/**
 * text-selection-adapter.ts — Unified selection adapter interface + helpers.
 *
 * Provides a `TextSelectionAdapter` interface that abstracts over the selection
 * models used by tugways text components (native input offsets, CM6 ranges, DOM
 * Selection) so the right-click context menu can query selection state without
 * per-model branching. The interface is query-only — `hasRangedSelection`,
 * `getSelectedText`, `selectAll`. Selection *preservation* on a secondary-click
 * is handled at the source by each surface's `mousedown` preventDefault, not by
 * an adapter capture/restore pipeline.
 *
 * Concrete adapter factories:
 *   - `createNativeInputAdapter` — in `use-text-input-responder.tsx`
 *   - `HighlightSelectionAdapter` — class in this file (DOM Selection over boundary element)
 *
 * Design decisions:
 *   [D01] Adapter is a plain object interface, not a class hierarchy
 */

// ---------------------------------------------------------------------------
// TextSelectionAdapter
// ---------------------------------------------------------------------------

/**
 * Uniform selection-query and selection-mutation API for tugways text components.
 *
 * Each concrete adapter closes over the underlying element or engine instance
 * so callers never deal with model-specific types. All adapters are plain
 * objects returned by factory functions per [D01].
 */
export interface TextSelectionAdapter {
  /** True when there is a non-collapsed (ranged) selection. */
  hasRangedSelection(): boolean;

  /** The currently selected text, or empty string if no ranged selection. */
  getSelectedText(): string;

  /** Select all content in the component. */
  selectAll(): void;
}

// ---------------------------------------------------------------------------
// findWordBoundaries
// ---------------------------------------------------------------------------

/**
 * Find the word boundaries around a given offset in a string.
 *
 * Scans backward from `offset` for the first whitespace or punctuation
 * character (exclusive) to find the word start, and forward for the first
 * whitespace or punctuation character (exclusive) to find the word end.
 *
 * If `offset` is on a whitespace or punctuation character, the returned range
 * collapses to `{ start: offset, end: offset }`.
 *
 * Used by `NativeInputSelectionAdapter`'s `expandToWord` and `selectWordAtPoint`
 * to extend the browser-placed caret to word boundaries via
 * `el.setSelectionRange(start, end)`.
 *
 * @param text   The full string value of the input / textarea.
 * @param offset The character offset to expand (typically `el.selectionStart`).
 * @returns      `{ start, end }` inclusive start / exclusive end indices.
 */
export function findWordBoundaries(
  text: string,
  offset: number,
): { start: number; end: number } {
  // Word boundary: whitespace or ASCII punctuation.
  const isBoundary = (ch: string): boolean => /[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(ch);

  // If the character at `offset` is itself a boundary, collapse the range.
  if (offset < text.length && isBoundary(text[offset]!)) {
    return { start: offset, end: offset };
  }

  // Scan backward to find word start.
  let start = offset;
  while (start > 0 && !isBoundary(text[start - 1]!)) {
    start--;
  }

  // Scan forward to find word end.
  let end = offset;
  while (end < text.length && !isBoundary(text[end]!)) {
    end++;
  }

  return { start, end };
}

// ---------------------------------------------------------------------------
// HighlightSelectionAdapter
// ---------------------------------------------------------------------------

/**
 * Adapter for a read-only DOM Selection scoped to one boundary element.
 *
 * Wraps `window.getSelection()` scoped to a boundary element. Used by items
 * 1-2 for context menu copy enablement, right-click classification, and
 * word-at-point expansion.
 *
 * All query methods check that the DOM Selection is within the boundary
 * element before returning results. Mutation methods operate on the standard
 * DOM Selection API — `Selection.modify` for word expansion,
 * `caretPositionFromPointCompat` for coordinate-to-offset conversion.
 *
 * @param boundaryEl The boundary `HTMLElement` for the markdown-view content.
 */
export class HighlightSelectionAdapter implements TextSelectionAdapter {
  private readonly _boundaryEl: HTMLElement;

  constructor(boundaryEl: HTMLElement) {
    this._boundaryEl = boundaryEl;
  }

  /** True when there is a non-collapsed DOM selection within the boundary. */
  hasRangedSelection(): boolean {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
    return this._isSelectionInBoundary(sel);
  }

  /** Selected text from the DOM selection, or empty string. */
  getSelectedText(): string {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return "";
    if (!this._isSelectionInBoundary(sel)) return "";
    return sel.toString();
  }

  /**
   * Select all content within the boundary element via DOM Selection.
   *
   * Only meaningful when every node of the content is in the DOM; a
   * virtualized surface, whose DOM holds a window of its rows, cannot select
   * all through it.
   */
  selectAll(): void {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(this._boundaryEl);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** Check if the DOM selection's anchor or focus is within the boundary. */
  private _isSelectionInBoundary(sel: Selection): boolean {
    return (
      (sel.anchorNode !== null && this._boundaryEl.contains(sel.anchorNode)) ||
      (sel.focusNode !== null && this._boundaryEl.contains(sel.focusNode))
    );
  }
}
