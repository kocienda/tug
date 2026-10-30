/**
 * `ChartBlock` — body kind for a Tug chart.
 *
 * A thin React surface over `renderChartInto`, the one renderer the
 * markdown fence enhancer also calls, so a ` ```tugchart ` fence in prose
 * and a `<ChartBlock>` mounted by the Bash block or an instrument produce
 * the same figure: token-styled SVG, a table alternative, the block chrome.
 *
 * Conformance ([#bk-conformance]): scope note — this is a display-only
 * block whose header is the shared imperative block chrome (title, Copy,
 * the Table toggle), with no fold affordance. Items 1–2 and 6–7 apply:
 *  - **Item 1** (text engine): N/A — the spec is a prop, never an in-block
 *    text-entry.
 *  - **Item 2** (single text-entry surface): satisfied by construction —
 *    the block carries no input UI of its own.
 *  - **Item 6** (tokens): owns `--tugx-chart-*` (declared in
 *    `chart-block.css`); composes `--tugx-block-*` for the frame.
 *  - **Item 7** (state preservation): the figure is a function of
 *    `(source, layers)`; the one reader choice, chart or table, is kept in
 *    the chart view memory by source hash and restored on every mount.
 *
 * Failure modes are the renderer's terminal states — `invalid` lists the
 * errors beneath the source, `unavailable` says the engine did not load —
 * each a `data-tugx-chart-state` the CSS paints. The parent keeps
 * rendering.
 *
 * Theme awareness needs nothing here: the SVG carries role classes and the
 * CSS maps them to tokens, so a theme switch restyles the figure in place.
 *
 * Laws:
 *  - [L03] the render runs in `useLayoutEffect`, before paint.
 *  - [L06] no React state for visual state — the renderer writes DOM; React
 *    owns only the mount.
 *  - [L19] file pair (`.tsx` + `.css`), module docstring, exported props
 *    interface, `data-slot="chart-body"` on the root.
 *  - [L20] owns `--tugx-chart-*`; consumes `--tugx-block-*` for the frame.
 *
 * @module components/tugways/body-kinds/chart-block
 */

import "./chart-block.css";

import React from "react";

import { renderChartInto } from "@/lib/chart/render-chart";
import type { ChartLayers } from "@/lib/lazy/load-tuggraphics";

export interface ChartBlockProps {
  /** The chart spec, or a drawing where `layers` allows one. Re-renders when it changes. */
  source: string;
  /**
   * Which layers this door accepts. A fence takes charts only (`"chart"`,
   * the default); a tool's stdout takes a drawing too (`"any"`).
   */
  layers?: ChartLayers;
  /**
   * Forwarded class name. Cascade-scoped customization happens here —
   * consumers tune `--tugx-chart-*` for their instance via a wrapping
   * selector, not by reaching into the primitive's CSS ([L20]).
   */
  className?: string;
  /**
   * Opt the figure into transcript Find: the root carries
   * `data-tugx-findable`, so the painter walks its table text (the figure
   * and the notes are excluded) and the index projects the same string.
   * A fence's chart needs none of this — its message body is the unit.
   */
  findable?: boolean;
}

export const ChartBlock: React.FC<ChartBlockProps> = ({ source, layers, className, findable = false }) => {
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    void renderChartInto(el, source, { layers });
  }, [source, layers]);

  const baseClass = "tugx-chart";
  const composed = className === undefined ? baseClass : `${baseClass} ${className}`;

  return <div ref={ref} data-slot="chart-body" className={composed} data-tugx-findable={findable ? "" : undefined} />;
};
