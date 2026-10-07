/**
 * cm6-scroll-anchor — a CodeMirror view keeps its place, by LINE.
 *
 * Two occasions want the same answer from a CM6 surface, and both want it in
 * the same unit:
 *
 *  - **Across a mount.** A card that comes back must come back to the line the
 *    reader left. `card-host.tsx` reads `data-tug-scroll-state` off the
 *    scroller at every save trigger, so the writer here publishes
 *    `{line: {number, offsetPx}, scrollHeight}` on every scroll — the wire
 *    format the saved-bag restore path already reads.
 *  - **Across a width change.** A resize episode offers the scroller a
 *    `tug-scroll-preserve-begin`; this plugin claims it, remembers the line at
 *    the viewport top, and re-lands that line on every geometry change until
 *    the episode ends.
 *
 * A line is the right unit for both. A pixel offset means nothing after a
 * re-wrap, and `lineBlockAt` is measured layout rather than an estimate — the
 * saved line comes back at the top whatever the wrap width or the font metric
 * resolved to.
 *
 * Under View › Zoom CodeMirror's height map is in viewport px — it measures
 * its lines with rects and reports the ratio as `view.scaleY` — while
 * `scrollTop` is layout px. A height goes into the map multiplied by
 * `scaleY` and comes out of it divided, so `offsetPx` is always layout px and
 * a saved anchor means the same thing at every factor.
 *
 * Install it where a CM6 view owns a scrollport of its own. The prompt entry
 * deliberately does not: it is a composer, not a document, and it scrolls in
 * a box the reader is typing into rather than reading through.
 *
 * The scroll position is written straight to the DOM and never through React
 * state ([L06]); every listener the plugin takes it releases in `destroy()`
 * ([L27]).
 */

import { ViewPlugin, type EditorView, type PluginValue, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

import {
  PRESERVE_SCROLLER_ATTR,
  RESIZE_PRESERVE_BEGIN,
  RESIZE_PRESERVE_END,
} from "./resize-episode";

/** Where a CM6 surface's viewport top falls, in the coordinates a re-wrap preserves. */
export interface Cm6LineAnchor {
  /** 1-based document line number. */
  readonly line: number;
  /** How far into that line's block the viewport top falls. */
  readonly offsetPx: number;
}

/** The attribute `card-host.tsx` reads at every save trigger. */
const SCROLL_STATE_ATTR = "data-tug-scroll-state";

/**
 * Read the line at the viewport top.
 *
 * `lineBlockAtHeight` reads CM6's measured layout and throws when the
 * measurement plugin has not run yet, which is a real state during mount and
 * in test environments. A missing anchor is not an error — the caller declines
 * to claim and the episode's generic fallback stands in.
 */
export function readCm6LineAnchor(view: EditorView): Cm6LineAnchor | null {
  try {
    const top = view.scrollDOM.scrollTop;
    const block = view.lineBlockAtHeight(top * view.scaleY);
    return {
      line: view.state.doc.lineAt(block.from).number,
      offsetPx: Math.max(0, top - block.top / view.scaleY),
    };
  } catch {
    return null;
  }
}

/** The `scrollTop` that puts `anchor` back at the viewport top, or `null` when its line is gone. */
export function resolveCm6LineAnchor(
  view: EditorView,
  anchor: Cm6LineAnchor,
): number | null {
  const doc = view.state.doc;
  if (anchor.line < 1 || anchor.line > doc.lines) return null;
  try {
    const block = view.lineBlockAt(doc.line(anchor.line).from);
    return Math.max(0, block.top / view.scaleY + anchor.offsetPx);
  } catch {
    return null;
  }
}

/**
 * Where the reader's place is, to the character.
 *
 * A line is the right unit for a reload, where the document comes back at the
 * same width and a line's block is the same height it was. It is too coarse
 * for a re-wrap: soft wrapping makes a long line's block taller, so restoring
 * "twenty pixels into line 117" lands twenty pixels into a *different* set of
 * wrapped rows and the text at the top edge slides by up to a row. The
 * position under the top edge has no such ambiguity.
 */
interface Cm6PosAnchor {
  /** Document offset of the character at the viewport's top-left. */
  readonly pos: number;
  /** Where that character's row sat, measured from the scrollport's top. */
  readonly delta: number;
}

/** How far in from the left edge to sample, past any gutter. */
const POS_PROBE_INSET_PX = 4;

function measurePosDelta(view: EditorView, pos: number): number | null {
  const coords = view.coordsAtPos(pos);
  if (coords === null) return null;
  // Both rects are viewport px; the delta is added to `scrollTop`.
  return (coords.top - view.scrollDOM.getBoundingClientRect().top) / view.scaleY;
}

function readCm6PosAnchor(view: EditorView): Cm6PosAnchor | null {
  try {
    const rect = view.contentDOM.getBoundingClientRect();
    const scrollTop = view.scrollDOM.getBoundingClientRect().top;
    const pos = view.posAtCoords(
      { x: rect.left + POS_PROBE_INSET_PX, y: scrollTop + 1 },
      false,
    );
    const delta = measurePosDelta(view, pos);
    return delta === null ? null : { pos, delta };
  } catch {
    return null;
  }
}

class Cm6ScrollAnchor implements PluginValue {
  private readonly scroller: HTMLElement;
  /** Non-null exactly while a resize episode is open on this scroller. */
  private held: Cm6PosAnchor | null = null;

  private readonly onScroll = (): void => {
    this.publish();
  };

  private readonly onPreserveBegin = (event: Event): void => {
    const anchor = readCm6PosAnchor(this.view);
    if (anchor === null) return;
    // Claim only once there is something to hold. Declining leaves the
    // episode's generic element anchor in charge, which is the better of the
    // two answers available when CM6 has not measured yet.
    event.preventDefault();
    this.held = anchor;
  };

  private readonly onPreserveEnd = (): void => {
    this.reland();
    this.held = null;
    this.publish();
  };

  constructor(private readonly view: EditorView) {
    this.scroller = view.scrollDOM;
    // Announce the scrollport to the resize episode. Not a region key: the
    // save bag's identity belongs to whoever mounted this view, and most of
    // them have none to give.
    this.scroller.setAttribute(PRESERVE_SCROLLER_ATTR, "");
    this.publish();
    this.scroller.addEventListener("scroll", this.onScroll, { passive: true });
    this.scroller.addEventListener(RESIZE_PRESERVE_BEGIN, this.onPreserveBegin);
    this.scroller.addEventListener(RESIZE_PRESERVE_END, this.onPreserveEnd);
  }

  update(update: ViewUpdate): void {
    if (!update.geometryChanged) return;
    // Mid-episode the geometry change IS the re-wrap, so re-land rather than
    // record: publishing here would save the position the reflow just broke.
    if (this.held !== null) this.reland();
    else this.publish();
  }

  destroy(): void {
    this.scroller.removeEventListener("scroll", this.onScroll);
    this.scroller.removeEventListener(RESIZE_PRESERVE_BEGIN, this.onPreserveBegin);
    this.scroller.removeEventListener(RESIZE_PRESERVE_END, this.onPreserveEnd);
    this.scroller.removeAttribute(SCROLL_STATE_ATTR);
    this.scroller.removeAttribute(PRESERVE_SCROLLER_ATTR);
  }

  /** Serialize the viewport-top line for the save path. */
  private publish(): void {
    const anchor = readCm6LineAnchor(this.view);
    if (anchor === null) return;
    this.scroller.setAttribute(
      SCROLL_STATE_ATTR,
      JSON.stringify({
        line: { number: anchor.line, offsetPx: anchor.offsetPx },
        // A validation ride-along, documented in `layout-tree.ts`'s schema
        // prose. Not consumed at restore.
        scrollHeight: this.scroller.scrollHeight,
      }),
    );
  }

  private reland(): void {
    if (this.held === null) return;
    const delta = measurePosDelta(this.view, this.held.pos);
    if (delta === null) return;
    const next = Math.max(0, this.scroller.scrollTop + delta - this.held.delta);
    if (Math.abs(this.scroller.scrollTop - next) > 0.5) {
      this.scroller.scrollTop = next;
    }
  }
}

/**
 * The line-anchor plugin: publishes `data-tug-scroll-state` for the save path
 * and holds the viewport-top line across a resize episode.
 */
export function cm6ScrollAnchor(): Extension {
  return ViewPlugin.define((view) => new Cm6ScrollAnchor(view));
}
