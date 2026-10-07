/**
 * tug-text-editor/selection-layer.ts — custom CodeMirror 6 layer that paints
 * `.cm-selectionBackground` divs behind every non-empty selection
 * range.
 *
 * This file deliberately does NOT use `drawSelection` from
 * `@codemirror/view`. `drawSelection` is a bundle of three concerns
 * (selection overlay, styled cursor, native-caret/native-selection
 * suppression at `Prec.highest` with `!important`) and only the first
 * is desirable here. The native caret is what we use for the visible
 * cursor — sized by line-box, uniform across text and atom positions
 * thanks to the `.cm-line::before` ghost element in `theme.ts`. Native
 * `::selection` is suppressed by a single rule in `theme.ts` so it
 * doesn't double-paint with this overlay.
 *
 * The overlay is a real DOM layer rendered behind the editable
 * surface. It survives editor blur (the layer keeps its DOM up
 * between updates) and covers atom widgets cleanly because it's
 * geometric — `RectangleMarker.forRange` walks the selected range
 * and emits one or more rect markers regardless of what content
 * the range covers.
 *
 * Gutter clip: `RectangleMarker.forRange` extends every fully-covered
 * visual row to the content's right edge — the BBEdit/native convention
 * for "the line break is part of the selection" — which is exactly what
 * we want. What we don't want is the left-gutter sliver it also emits:
 * because the themes use a hanging indent, `leftSide` sits left of the
 * first glyph, so a row whose selection ends at column 0 paints a small
 * orphan box in that gutter. `clipMarkerToText` slices each emitted rect
 * into one strip per visual row, clamps each strip's LEFT edge in to that
 * row's first glyph, and drops strips that collapse to nothing — leaving
 * the full-width right edge intact. Geometry is still all CM6's; we only
 * pull the left in and drop empties.
 *
 * Laws: [L02] selection range data is owned by CM6's `EditorState`,
 *        not React state, [L06] overlay is appearance painted via
 *        DOM layer, [L19] file structure, [L22] direct DOM-update
 *        observer (CM6 layer's `markers()` is called on each update
 *        without any React round-trip).
 */

import { EditorView, layer, RectangleMarker } from "@codemirror/view";
import type { LayerMarker } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/**
 * Document-relative origin used to translate between CM6 marker
 * coordinates (document-relative, as `RectangleMarker.forRange`
 * produces them) and viewport/client coordinates (what `posAtCoords` /
 * `coordsAtPos` speak). Mirrors CM6's internal `getBase`. The editor is
 * LTR, so we don't carry the RTL branch.
 */
function baseOffset(view: EditorView): { left: number; top: number } {
  const rect = view.scrollDOM.getBoundingClientRect();
  return {
    left: rect.left - view.scrollDOM.scrollLeft * view.scaleX,
    top: rect.top - view.scrollDOM.scrollTop * view.scaleY,
  };
}

/**
 * Slice one `forRange` rectangle into per-visual-row strips and pull each
 * strip's left edge in to that row's first glyph, leaving the right edge as
 * `forRange` drew it (full width when the row's newline is selected, hugged
 * on the final row). A strip that collapses to nothing — a row whose
 * selection is only the trailing newline sitting in the hanging-indent
 * gutter — is dropped rather than painting an orphan sliver.
 *
 * In wrap mode the right edge is also clamped to the viewport: a selection
 * over a hung trailing space (white-space: pre-wrap) must not paint past
 * the line edge, both visually and — since the strip is a scroller child —
 * to keep it from inflating `scrollWidth` and re-enabling horizontal
 * scroll. See the inline note at `markerRight`.
 */
function clipMarkerToText(
  view: EditorView,
  marker: RectangleMarker,
): RectangleMarker[] {
  const width = marker.width;
  if (width === null) return [marker];

  const rowHeight = view.defaultLineHeight;
  if (!(rowHeight > 0)) return [marker];

  const base = baseOffset(view);
  const contentLeft = view.contentDOM.getBoundingClientRect().left;
  const rows = Math.max(1, Math.round(marker.height / rowHeight));
  // Clamp the right edge to the viewport in wrap mode. A selection that
  // covers a hung trailing space (white-space: pre-wrap) would otherwise
  // paint a rect out past the line edge — and, being a child of the
  // scroller, would inflate `scrollWidth` and let CM6 scroll the view
  // sideways to follow it. Bounding it (together with the content clip and
  // the caret clamp) keeps `scrollLeft` structurally pinned at 0. No-op
  // for in-bounds rects and for non-wrapping editors that legitimately
  // scroll horizontally.
  // The marker is viewport px (the layer counter-scales); the scroller's
  // extent is layout px, so it is multiplied up by `scaleX` to meet it.
  const rawRight = marker.left + width;
  const markerRight = view.contentDOM.classList.contains("cm-lineWrapping")
    ? Math.min(
        rawRight,
        (view.scrollDOM.scrollLeft + view.scrollDOM.clientWidth) * view.scaleX,
      )
    : rawRight;

  const out: RectangleMarker[] = [];
  for (let i = 0; i < rows; i++) {
    const top = marker.top + (i * marker.height) / rows;
    const height = marker.height / rows;
    const midClientY = top + base.top + height / 2;

    // First glyph on this visual row: probe the far left of the content at
    // this y, then read the left edge of that position.
    const startPos = view.posAtCoords({ x: contentLeft, y: midClientY }, false);
    const startCoords = view.coordsAtPos(startPos, 1);
    if (!startCoords) continue;

    const left = Math.max(marker.left, startCoords.left - base.left);
    if (markerRight - left <= 1) continue;

    out.push(
      new RectangleMarker("cm-selectionBackground", left, top, markerRight - left, height),
    );
  }
  return out;
}

/**
 * Selection-overlay layer. Paints `.cm-selectionBackground` divs for
 * every non-empty range in the editor's current selection. Empty
 * ranges (carets) produce no markers — the visible caret is the
 * browser's native caret driven by `caret-color`.
 */
export const tugSelectionLayer: Extension = layer({
  above: false,
  class: "cm-selectionLayer",
  update(update) {
    return update.docChanged || update.selectionSet || update.viewportChanged;
  },
  markers(view: EditorView): readonly LayerMarker[] {
    const markers: RectangleMarker[] = [];
    for (const range of view.state.selection.ranges) {
      if (range.empty) continue;
      for (const piece of RectangleMarker.forRange(view, "cm-selectionBackground", range)) {
        for (const clipped of clipMarkerToText(view, piece)) {
          markers.push(clipped);
        }
      }
    }
    return markers;
  },
});
