/**
 * `enhance-chart.ts` — post-`innerHTML` chart renderer for markdown
 * blocks. Sibling of {@link enhanceMath}, called from the same places
 * once a block element's content has been written
 * and the element is in the document — the renderer measures against the
 * subtree's computed type, which a detached node does not have.
 *
 * One pass per block: find every placeholder the `tugchart` transformer
 * emitted — on the page, or in tugcast's render of the same text — read the
 * spec source out of its `textContent`, and hand each to `renderChartInto`,
 * which is the one renderer every door shares.
 *
 * **Idempotency.** A placeholder carries `data-tugx-chart-pending="true"`
 * until a render takes it; `renderChartInto` removes the flag as its first
 * act, so a second enhance pass over the same DOM finds nothing to do. A
 * streaming update rewrites the parent's `innerHTML`, which removes every
 * placeholder; the next pass starts fresh, and a render still in flight
 * for a detached placeholder writes into a node nobody shows.
 *
 * @module lib/markdown/enhance-chart
 */

import type { AnnotationContext } from "@/lib/annotator/types";
import {
  CHART_CLASS,
  CHART_PENDING_ATTR,
  renderChartInto,
} from "@/lib/chart/render-chart";
import type { ChartLayers } from "@/lib/lazy/load-tuggraphics";
import { trackEnhancement } from "./pending-enhancements";

/** Selector for pending chart placeholders. */
const PENDING_SELECTOR = `.${CHART_CLASS}[${CHART_PENDING_ATTR}="true"]`;

/** The attribute a `tugdiagram` fence's placeholder names its door with. */
export const CHART_LAYERS_ATTR = "data-tugx-chart-layers";

/**
 * The door a placeholder came through: `"diagram"` for a `tugdiagram`
 * fence, otherwise `"chart"`. Neither fence takes a drawing.
 */
export function placeholderLayers(el: Element): ChartLayers {
  return el.getAttribute(CHART_LAYERS_ATTR) === "diagram" ? "diagram" : "chart";
}

/**
 * Walk `container` for pending chart placeholders and render every one,
 * each through the door its fence names. Resolves once every placeholder
 * found has reached a terminal state; callers that do not care can
 * fire-and-forget.
 *
 * The block's `annotation` context goes to the renderer, which annotates
 * the figure once it has landed: a chart's table is written after the
 * block's own annotation pass ran over the placeholder, and so is a
 * diagram's keyed table, so each is annotated again on its own. A chart's
 * refs resolve to the same links prose gets; a diagram's locations do too,
 * and its table says a resolver was asked (`DIAGRAM_CHECKED_ATTR`), which is
 * what lets a location nobody confirmed wear its "unresolved" mark only where
 * one could answer — never on the share page, whose context is
 * `unanswerable`. The pass files what it consulted, so a verdict that lands
 * later re-marks the block it sits in.
 *
 * The pass is registered with `pending-enhancements`: the engine loads
 * lazily, so a page about to be photographed waits for its figures as it
 * waits for coloured code and math.
 */
export function enhanceChart(container: HTMLElement, annotation?: AnnotationContext): Promise<void> {
  const pending = Array.from(container.querySelectorAll<HTMLElement>(PENDING_SELECTOR));
  if (pending.length === 0) return Promise.resolve();
  return trackEnhancement(Promise.all(
    pending.map((el) => renderChartInto(el, el.textContent ?? "", { layers: placeholderLayers(el), annotation })),
  ).then(() => undefined));
}
