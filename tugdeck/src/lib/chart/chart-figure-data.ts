/**
 * `chart-figure-data` — what a rendered figure was drawn from, kept beside
 * the element for the surfaces that act on its refs after the render: the
 * set list reads a pressed set's members from the table, and annotates its
 * rows with the context the figure was annotated with.
 *
 * A module of its own so that the renderer, which writes it, and the set
 * list, which the renderer attaches, do not import each other.
 *
 * Laws: [L24] the record is keyed weakly by the element and goes with it.
 *
 * @module lib/chart/chart-figure-data
 */

import type { AnnotationContext } from "@/lib/annotator/types";
import type { ChartSource, ChartTable } from "@/lib/lazy/load-tuggraphics";

/**
 * Dispatched on a figure, bubbling, whenever its annotated hosts changed:
 * after a render annotated it, and when a set list opens or closes. The
 * surface it stands in re-announces its whole container to its portals,
 * because a portal hook replaces its mount list with what it finds there.
 * Declared here, beside the record both writers share, so neither imports
 * the other for the name.
 */
export const CHART_ANNOTATED_EVENT = "tugx-chart-annotated";

/** What a rendered figure was drawn from. */
export interface ChartFigureData {
  table: ChartTable;
  context: AnnotationContext | undefined;
  /** The recipe the chart was drawn from, when its spec named one. */
  source: ChartSource | undefined;
  /** Whether that recipe can be asked for a mark's members from here. */
  canReport: boolean;
  /** The hash of the source the figure was drawn from: what a reader's choices about this chart are kept by. */
  hash: string;
}

const figureData = new WeakMap<HTMLElement, ChartFigureData>();

/** Record what `figure` was just drawn from. */
export function setChartFigureData(figure: HTMLElement, data: ChartFigureData): void {
  figureData.set(figure, data);
}

/** The table and context `figure` was last rendered with, or `undefined` before it has drawn. */
export function chartFigureData(figure: HTMLElement): ChartFigureData | undefined {
  return figureData.get(figure);
}
