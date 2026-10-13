/**
 * tug-text-editor/line-box-metric.ts — the height of one line, published for
 * CSS to count in.
 *
 * A surface that wants to be "ten lines tall" cannot say so in tokens. The
 * height a line actually occupies is a rasterized fact: it is the font's own
 * box as the platform drew it, which is not `line-height` — a line of the
 * commit composer computes a 23px line-height and occupies 30px — and it moves
 * with the face, the size, the zoom and the theme. Multiply the token and the
 * answer is wrong by the difference, which is one line in every three.
 *
 * CodeMirror already measures it, because its own scrolling depends on it.
 * This publishes that measurement as `--tugx-editor-line-box` on the editor's
 * element, so a rule anywhere inside can multiply it by a count of lines and
 * mean lines.
 *
 * Appearance through the DOM, no React state ([L06]); the write is a property
 * set on an element the plugin already owns, and only when the number changes.
 *
 * @module components/tugways/tug-text-editor/line-box-metric
 */

import { ViewPlugin } from "@codemirror/view";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/** The published name — read it as `var(--tugx-editor-line-box, <fallback>)`. */
export const LINE_BOX_PROPERTY = "--tugx-editor-line-box";

export const lineBoxMetric: Extension = ViewPlugin.fromClass(
  class {
    private published = 0;
    /** Whether `published` came off a real row, or is the estimate an empty
     *  document had to settle for. Only a real row is allowed to refuse a
     *  later, taller reading — an estimate is replaced by the first row seen. */
    private measured = false;
    /** Whether the last measure found rows with no box at all: a composer in
     *  a parked workspace, whose pane content is `display: none`. The box
     *  coming back is a geometry change, and it is the one geometry change
     *  this metric re-asks on, and only while the last measure found none. */
    private boxless = false;

    constructor(view: EditorView) {
      this.publish(view);
    }

    update(update: ViewUpdate): void {
      // NEVER on `geometryChanged` or `viewportChanged`. The publish below IS a
      // geometry change (the composer's max-height multiplies by it), and the
      // set of lines CodeMirror has rendered depends on that height — so a
      // metric that re-measured on geometry read a different shortest line at
      // each height and drove the field between two sizes on alternating
      // frames. What a plain row measures depends on the face, the size, the
      // zoom and the theme; none of those is a geometry change, and every one
      // of them arrives here as a reconfigure (the substrate's typography
      // revision) — so that, and a document edit that may have introduced the
      // first plain row, are the only two things worth measuring for.
      //
      // And a third, narrower than the geometry rule it is an exception to:
      // the editor getting its box back. A parked workspace's pane content is
      // `display: none` (`space-layer.css`), so a composer that mounts in one
      // finds rows with no box, falls back to the estimate, and would never
      // re-ask. While — and only while — the last measure found no box, a
      // geometry change is re-measured: the first one after the reveal reads
      // a real row, `boxless` goes false, and the rule above holds again. It
      // cannot cycle: a boxless editor has no layout to change, and a boxed
      // one never takes this branch.
      const retyped = update.transactions.some((tr) => tr.reconfigured);
      const regained = this.boxless && update.geometryChanged;
      if (!retyped && !update.docChanged && !regained) return;
      if (retyped) {
        this.published = 0;
        this.measured = false;
      }
      this.publish(update.view);
    }

    private publish(view: EditorView): void {
      // In the measure cycle, because this is a measurement: reading a rect
      // during an update would force a layout mid-write.
      view.requestMeasure({
        read: (measured) => measuredLineBox(measured),
        write: ({ row, boxless }, view) => {
          this.boxless = boxless;
          const fromRow = row > 0;
          // CSS px for the property: `defaultLineHeight` is viewport px
          // under a zoom, like the rect `measuredLineBox` reads.
          const height = fromRow ? row : view.defaultLineHeight / view.scaleY;
          if (height <= 0) return;
          // A row only ever gets SHORTER as more of the document comes into
          // view (a wrapped line is taller than a plain one, never the reverse),
          // so a taller reading is a worse sample, not a change. A genuine
          // change — a bigger face — comes through the reconfigure reset above.
          if (this.measured && (!fromRow || height >= this.published)) return;
          if (height === this.published) {
            this.measured = this.measured || fromRow;
            return;
          }
          this.published = height;
          this.measured = fromRow;
          view.dom.style.setProperty(LINE_BOX_PROPERTY, `${height}px`);
        },
      });
    }
  },
);

/**
 * One visual row, measured off the rows on screen.
 *
 * The shortest line block that is a line at all: a block taller than that is a
 * line that wrapped into several rows, or a line wearing furniture of its own
 * (the landing message's subject, which carries a rule), and a block of no
 * height is a line the surface has collapsed. The shortest is the plain one.
 * An EMPTY line is not a candidate: it holds no glyph, so it measures the
 * bare line-height rather than the row a glyph occupies, and whether one is
 * on screen at all is a matter of where the viewport happens to fall.
 *
 * Measured off the DOM, and not off `view.defaultLineHeight` or the height map
 * behind `viewportLineBlocks`: both are CodeMirror's own accounting, and both
 * read 25px in this composer where a line occupies 30. Close enough for its
 * scrolling arithmetic; one line wrong in ten for a cap that means to count
 * them. `row` is `0` when there is no row to measure (an empty document, or
 * rows with no box); the caller falls back to the estimate, and remembers
 * that it did. `boxless` says which: a line with a glyph whose block measures
 * no height at all is a line in a subtree that is not rendered.
 *
 * In layout px: the rect is divided by CodeMirror's own `scaleY`, so the
 * ratchet above compares the same row at every View › Zoom factor.
 */
function measuredLineBox(view: EditorView): { row: number; boxless: boolean } {
  let shortest = Infinity;
  let candidates = 0;
  let unboxed = 0;
  for (const line of view.contentDOM.children) {
    if (!(line instanceof HTMLElement) || !line.classList.contains("cm-line")) continue;
    if (line.textContent === null || line.textContent.length === 0) continue;
    const height = line.getBoundingClientRect().height / view.scaleY;
    candidates += 1;
    if (height === 0) unboxed += 1;
    if (height > 1 && height < shortest) shortest = height;
  }
  return {
    row: Number.isFinite(shortest) ? shortest : 0,
    boxless: candidates > 0 && unboxed === candidates,
  };
}
