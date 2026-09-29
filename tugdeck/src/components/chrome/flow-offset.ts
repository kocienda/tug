/**
 * flow-offset — the one door that writes the flow strip's offset onto the
 * elements that read it.
 *
 * `--tug-imposer-flow-offset` is registered NON-inherited (`styles/chrome.css`).
 * It used to be written once, on the canvas and on each space layer, and
 * inherited down to every imposed frame's `left` — and a write of an inherited
 * custom property invalidates the computed style of every descendant of the
 * element it is written on. Measured on a four-card flow deck that was ~3 ms of
 * style recalc per slide, most of it the rail's Layout card, which never reads
 * the offset; on a deck of real transcripts it scales with the whole tree. The
 * layout half was nil — a moved `left` on an absolutely positioned frame is a
 * positioned-movement-only layout — so nothing but the invalidation was ever
 * being paid, and a value that reaches only its readers pays none of it.
 *
 * Three kinds of element read the offset, through `imposeStyle`'s flow `left`:
 * the imposed frames, the held-open vacancies, and the column seams. The
 * frames stand under a space layer and every layer carries its own deck's
 * offset, shown or not ([B02]); the vacancies and seams are the shown deck's
 * and stand directly under the canvas. So there are two writers: one for a
 * layer's frames, and one for the canvas — its own readers and the SHOWN
 * layer's frames — which is what every per-frame writer (the settle's
 * pre-launch, the drag's autoscroll, the Layout card's scrub) calls.
 *
 * `setProperty` with the value already standing is a no-op for invalidation,
 * so the layer effect re-writing after React's commit the same number the arm
 * wrote before it costs nothing.
 *
 * @module components/chrome/flow-offset
 */

import { FLOW_OFFSET_PROPERTY } from "@/lib/layout-imposer";

import { SPACE_LAYER_CLASS, SPACE_SHOWN_ATTRIBUTE } from "./space-layer";

/** A layer's readers: every imposed frame under it. */
export const FLOW_OFFSET_FRAME_READERS = ".tug-pane[data-imposed]";

/** The canvas's own readers: the vacancies and the seams, which stand directly
 *  under it and belong to the shown deck. */
export const FLOW_OFFSET_CANVAS_READERS =
  ":scope > .tug-slot-vacancy[data-vacant-slot], :scope > .tug-place-seam";

function writeOn(el: HTMLElement, px: number | null): void {
  if (px === null) el.style.removeProperty(FLOW_OFFSET_PROPERTY);
  else el.style.setProperty(FLOW_OFFSET_PROPERTY, `${px}px`);
}

/** Write `px` (or clear, on `null`) onto every imposed frame under `layer`. */
export function writeLayerFlowOffset(
  layer: Element,
  px: number | null,
): void {
  for (const el of layer.querySelectorAll<HTMLElement>(
    FLOW_OFFSET_FRAME_READERS,
  )) {
    writeOn(el, px);
  }
}

/**
 * Write `px` (or clear, on `null`) onto the canvas's own readers and onto the
 * shown layer's frames — everything the eye can see reading the offset.
 */
export function writeCanvasFlowOffset(
  container: Element,
  px: number | null,
): void {
  for (const el of container.querySelectorAll<HTMLElement>(
    FLOW_OFFSET_CANVAS_READERS,
  )) {
    writeOn(el, px);
  }
  const shown = container.querySelector(
    `.${SPACE_LAYER_CLASS}[${SPACE_SHOWN_ATTRIBUTE}]`,
  );
  if (shown !== null) writeLayerFlowOffset(shown, px);
}
