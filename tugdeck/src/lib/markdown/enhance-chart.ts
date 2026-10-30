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

import { CHART_CLASS, CHART_PENDING_ATTR, renderChartInto } from "@/lib/chart/render-chart";

/** Selector for pending chart placeholders. */
const PENDING_SELECTOR = `.${CHART_CLASS}[${CHART_PENDING_ATTR}="true"]`;

/**
 * Walk `container` for pending chart placeholders and render every one. A
 * fence takes charts only, so the door passes `layers: "chart"`. Resolves
 * once every placeholder found has reached a terminal state; callers that
 * do not care can fire-and-forget.
 */
export function enhanceChart(container: HTMLElement): Promise<void> {
  const pending = Array.from(container.querySelectorAll<HTMLElement>(PENDING_SELECTOR));
  if (pending.length === 0) return Promise.resolve();
  return Promise.all(pending.map((el) => renderChartInto(el, el.textContent ?? "", { layers: "chart" }))).then(
    () => undefined,
  );
}
