/**
 * Opening a figure's share sheet from the figure's own header.
 *
 * A figure's header is plain DOM built by `renderChartInto`, under any
 * surface a figure can stand in: no hooks, no component identity. The share
 * sheet is a pane sheet reached through a React hook. This is the seam
 * between them, as `attachment-preview-open.ts` is for the lightbox: every
 * card's host registers an opener for its own card (`FigureShareHost`,
 * mounted by `card-host.tsx`), and the header asks with the figure's
 * element, which the card that holds it answers.
 *
 * @module lib/chart/figure-share-open
 */

import type { ChartLayers } from "@/lib/lazy/load-tuggraphics";

/** The figure a share sheet is opened over. */
export interface FigureShareRequest {
  /** The figure's spec, as written. */
  source: string;
  layers: ChartLayers;
  /** A diagram, not a chart: the sheet's title says which. */
  diagram: boolean;
  /** The save panel's default filename, without an extension. */
  baseName: string;
  /** The figure's own width as drawn, in px; 0 when unknown. */
  naturalWidth: number;
}

/** One card's offer to show the share sheet for the figures it holds. */
export interface FigureShareOpener {
  /** The card whose host registered this. */
  cardId: string;
  /** The pane frame the card stands in, for a figure outside the card's own root. */
  frame: () => Element | null;
  open: (request: FigureShareRequest) => void;
}

const openers = new Set<FigureShareOpener>();

/** What stands around the picture inside the sheet's panel, in px: the sheet's and the picture's own margins. */
const PICTURE_SURROUND_PX = 104;

/** A sheet's width tiers, narrowest first, with the panel width each gives (`tug-sheet.css`). */
const WIDTH_TIERS: ReadonlyArray<{ tier: "sm" | "md" | "lg" | "xl"; px: number }> = [
  { tier: "sm", px: 510 },
  { tier: "md", px: 580 },
  { tier: "lg", px: 680 },
  { tier: "xl", px: 1040 },
];

/**
 * The narrowest sheet tier that shows a figure `naturalWidth` px wide at its
 * own size. The widest for one no tier holds, which then scales down to fit,
 * and for a figure of unknown width.
 */
export function figureShareSheetWidth(naturalWidth: number): "sm" | "md" | "lg" | "xl" {
  if (!(naturalWidth > 0)) return "xl";
  return WIDTH_TIERS.find((entry) => entry.px >= naturalWidth + PICTURE_SURROUND_PX)?.tier ?? "xl";
}

/** Offer to open share sheets for one card's figures. Returns the unregister. */
export function registerFigureShareOpener(opener: FigureShareOpener): () => void {
  openers.add(opener);
  return () => {
    openers.delete(opener);
  };
}

/**
 * Open the share sheet for the figure at `el`, on the card that holds it:
 * the card whose root `el` is under, or failing that the one whose pane
 * frame contains it (a figure in a surface portaled out of the card's root).
 * Returns `false` when no card answers, and the caller says so.
 */
export function openFigureShare(el: Element, request: FigureShareRequest): boolean {
  const cardId = el.closest("[data-card-host][data-card-id]")?.getAttribute("data-card-id") ?? null;
  for (const opener of openers) {
    if (cardId !== null && opener.cardId === cardId) {
      opener.open(request);
      return true;
    }
  }
  for (const opener of openers) {
    if (opener.frame()?.contains(el) === true) {
      opener.open(request);
      return true;
    }
  }
  return false;
}
