/**
 * figure-export.ts — a drawn figure leaving the card as a picture.
 *
 * A figure's header has two ways out. **Copy** renders a PNG of the figure
 * and puts it on the pasteboard with the spec as its plain-text flavour, so
 * a paste into a mail or a slide gives the picture and a paste into an
 * editor still gives the source. **Share** renders the PNG and the PDF and
 * opens the host's preview sheet over the pair, with the sheet's own Copy,
 * Save… and Share….
 *
 * Both renders go through the share renderer with a figure document
 * (`buildShareFigureDocument`): the host's hidden share page draws the spec
 * with `renderChartInto` in picture mode, so the image has the card's faces,
 * theme and layout by construction.
 *
 * Which of the two a header offers is {@link figureHeaderActions}, a
 * function of three facts and nothing else. A failure is said in a deck
 * bulletin: the header is plain DOM under any surface a figure can stand in,
 * with no card's bulletin in reach, and the deck's is the one every one of
 * those surfaces has ([L31]).
 *
 * @module lib/chart/figure-export
 */

import { getOnScreenTheme } from "@/contexts/theme-provider";
import { raiseDeckBulletin } from "@/lib/bulletin-relay";
import type { ChartLayers } from "@/lib/lazy/load-tuggraphics";
import { shareCopyFile, shareFigurePreview, shareRender } from "@/lib/os-share";
import { buildShareFigureDocument } from "@/lib/share-turns";

/** What a figure's header knows when it chooses its actions. */
export interface FigureHeaderState {
  /** The figure drew; `false` for a pending, invalid or unavailable one. */
  drawn: boolean;
  /** The host's share surfaces are reachable (`isShareAvailable()`). */
  hostShares: boolean;
  /** The figure stands on the share page, inside a turn being rendered. */
  sharePage: boolean;
}

/** The actions a figure's header offers. */
export interface FigureHeaderActions {
  /** What Copy puts on the pasteboard. */
  copy: "picture" | "source";
  /** Whether the header has a Share button. */
  share: boolean;
}

/**
 * The actions for `state`. A picture needs a figure that drew and a host to
 * render it, and the share page offers none: a figure there is inside a
 * picture already being made. Everywhere else Copy copies the source, as it
 * did before a figure could be a picture, and there is no Share.
 */
export function figureHeaderActions(state: FigureHeaderState): FigureHeaderActions {
  const picture = state.drawn && state.hostShares && !state.sharePage;
  return { copy: picture ? "picture" : "source", share: picture };
}

/** The Copy button's accessible name for what it copies. */
export function figureCopyLabel(copy: FigureHeaderActions["copy"], diagram: boolean): string {
  const noun = diagram ? "diagram" : "chart";
  return copy === "picture" ? `Copy ${noun}` : `Copy ${noun} source`;
}

/** The Share button's accessible name. */
export function figureShareLabel(diagram: boolean): string {
  return diagram ? "Share diagram" : "Share chart";
}

/** The longest base name a caption makes, in characters. */
export const FIGURE_BASE_NAME_LIMIT = 60;

/**
 * The save panel's default filename for a figure, without an extension: its
 * caption as lowercase words joined by hyphens, or its kind when the caption
 * leaves nothing a filename can hold.
 */
export function figureBaseName(caption: string, diagram: boolean): string {
  const slug = caption
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .slice(0, FIGURE_BASE_NAME_LIMIT)
    .replace(/^-+|-+$/g, "");
  return slug === "" ? (diagram ? "diagram" : "chart") : slug;
}

/** The bulletin a figure whose render failed reads. */
export const FIGURE_RENDER_FAILED_TEXT = "Couldn't render the figure";
/** The bulletin a rendered figure that did not reach the pasteboard reads. */
export const FIGURE_COPY_FAILED_TEXT = "Couldn't copy the figure";
/** The bulletin a rendered figure the preview sheet could not show reads. */
export const FIGURE_PREVIEW_FAILED_TEXT = "Couldn't show the preview";

/** Say `text` in a deck bulletin. */
function caution(text: string): void {
  raiseDeckBulletin("caution", text);
}

/** What a figure's export is made from. */
export interface FigureSource {
  source: string;
  layers: ChartLayers;
}

/** Render the figure in `format`; the file's path, or `null` when it failed. */
async function renderFigure(figure: FigureSource, format: "png" | "pdf"): Promise<string | null> {
  const document = buildShareFigureDocument({
    theme: getOnScreenTheme(),
    source: figure.source,
    layers: figure.layers,
  });
  const outcome = await shareRender(format, JSON.stringify(document));
  return outcome.result === "ok" ? outcome.path : null;
}

/**
 * Copy the figure as a PNG, with its spec as the plain-text flavour.
 * Resolves whether it reached the pasteboard; a failure is said.
 */
export async function copyFigurePicture(figure: FigureSource): Promise<boolean> {
  const path = await renderFigure(figure, "png");
  if (path === null) {
    caution(FIGURE_RENDER_FAILED_TEXT);
    return false;
  }
  if ((await shareCopyFile(path, figure.source)) !== "done") {
    caution(FIGURE_COPY_FAILED_TEXT);
    return false;
  }
  return true;
}

/**
 * Open the preview sheet over the figure's PNG and PDF. Resolves when both
 * renders are in and the sheet has been asked for — not when it is
 * dismissed, so the button that called this is busy for the renders alone.
 * The two renders run one after the other: the host draws each in its own
 * hidden page, and a PDF is a third of a second.
 */
export async function shareFigure(figure: FigureSource, baseName: string): Promise<void> {
  const png = await renderFigure(figure, "png");
  const pdf = png === null ? null : await renderFigure(figure, "pdf");
  if (png === null || pdf === null) {
    caution(FIGURE_RENDER_FAILED_TEXT);
    return;
  }
  void shareFigurePreview({ baseName, png, pdf, text: figure.source }).then((result) => {
    if (result !== "done") caution(FIGURE_PREVIEW_FAILED_TEXT);
  });
}
