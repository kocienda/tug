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
 * **A chart's refs are annotated here as prose is.** With an `annotation`
 * context the renderer resolves the refs the figure names and stamps the
 * confirmed ones; this block mounts the portals those stamps earn (a commit
 * pill, a session chip) beside its root, re-marks the figure when a verdict
 * it consulted lands, and re-announces the figure to its portals whenever
 * the figure says its annotated hosts changed (`CHART_ANNOTATED_EVENT`).
 *
 * Laws:
 *  - [L03] the render runs in `useLayoutEffect`, before paint.
 *  - [L03] the verdict subscription and the event listener are registered
 *    in a layout effect, so they stand before any gesture.
 *  - [L06] no React state for visual state — the renderer writes DOM; React
 *    owns only the mount and the portals.
 *  - [L19] file pair (`.tsx` + `.css`), module docstring, exported props
 *    interface, `data-slot="chart-body"` on the root.
 *  - [L20] owns `--tugx-chart-*`; consumes `--tugx-block-*` for the frame.
 *  - [L22] the verdicts are external state the annotator reads
 *    synchronously; nothing renders from them through React.
 *  - [L27] the subscription's release and the listener's removal are the
 *    effect's cleanup.
 *
 * @module components/tugways/body-kinds/chart-block
 */

import "./chart-block.css";

import React from "react";

import { useAnnotationPortals } from "@/components/tugways/annotation-portals";
import { annotateElement, containerDependsOnVerdicts } from "@/lib/annotator/annotate-content";
import type { AnnotationContext } from "@/lib/annotator/types";
import { CHART_ANNOTATED_EVENT, CHART_STATE_ATTR, renderChartInto } from "@/lib/chart/render-chart";
import { flushSync } from "@/lib/gesture-scope";
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
  /**
   * Draw the figure alone, scaled to fit this block, with no header, no table
   * and never an entrance. The consumer gives the block its size through a
   * wrapping element of definite height.
   */
  thumbnail?: boolean;
  /**
   * The surface's annotation context. Given, the refs the chart names are
   * resolved through it and a confirmed one becomes the same link, pill or
   * chip prose gets. Absent, every ref is shown as written.
   */
  annotation?: AnnotationContext;
}

export const ChartBlock: React.FC<ChartBlockProps> = ({
  source,
  layers,
  className,
  findable = false,
  thumbnail = false,
  annotation,
}) => {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const { onAnnotated, portals } = useAnnotationPortals(annotation);
  // Live-ref'd, so a fresh callback per render does not re-run the effects ([L07]).
  const onAnnotatedRef = React.useRef(onAnnotated);
  onAnnotatedRef.current = onAnnotated;

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    void renderChartInto(el, source, { layers, thumbnail, annotation });
  }, [source, layers, thumbnail, annotation]);

  // The figure's hosts reach the portals two ways. The renderer annotates a
  // figure that has landed and says so with `CHART_ANNOTATED_EVENT` (as does
  // a set list opening or closing); a verdict the figure consulted, landing
  // later on a timer, re-marks it here. Both arrive outside React's commit,
  // so each fills the hosts it emptied before the paint with `flushSync`.
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || annotation === undefined || thumbnail) return;
    const announce = (): void => {
      flushSync(() => onAnnotatedRef.current(el));
    };
    el.addEventListener(CHART_ANNOTATED_EVENT, announce);
    const release = annotation.subscribe?.((changed) => {
      if (el.getAttribute(CHART_STATE_ATTR) !== "rendered") return;
      if (!containerDependsOnVerdicts(el, changed)) return;
      annotateElement(el, annotation);
      announce();
    });
    return () => {
      el.removeEventListener(CHART_ANNOTATED_EVENT, announce);
      release?.();
    };
  }, [annotation, thumbnail]);

  const baseClass = "tugx-chart";
  const composed = className === undefined ? baseClass : `${baseClass} ${className}`;

  return (
    <>
      <div ref={ref} data-slot="chart-body" className={composed} data-tugx-findable={findable ? "" : undefined} />
      {portals}
    </>
  );
};
