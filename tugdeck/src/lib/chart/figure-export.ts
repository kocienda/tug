/**
 * figure-export.ts — a drawn figure leaving the card as a picture.
 *
 * A figure's header has two ways out. **Copy** renders a PNG of the figure
 * and puts it on the pasteboard with the spec as its plain-text flavour, so
 * a paste into a mail or a slide gives the picture and a paste into an
 * editor still gives the source. **Share** opens the figure's share sheet
 * on the card it stands in (`figure-share-sheet.tsx`, one of the family the
 * Share Turns shade belongs to), which shows the picture, offers PDF or
 * Image, and copies, saves or shares the one chosen.
 *
 * Every render goes through the share renderer with a figure document
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
import { openFigureShare } from "@/lib/chart/figure-share-open";
import { shareCopyFile, sharePick, shareRender, shareSave, type ShareAnchor } from "@/lib/os-share";
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
/** The bulletin a figure no card could show the share sheet for reads. */
export const FIGURE_SHEET_FAILED_TEXT = "Couldn't show the share sheet";
/** The bulletin a rendered figure that could not be saved reads. */
export const FIGURE_SAVE_FAILED_TEXT = "Couldn't save the figure";
/** The bulletin a rendered figure the share picker could not show reads. */
export const FIGURE_PICK_FAILED_TEXT = "Couldn't show the share picker";

/** The formats a figure leaves in. */
export type FigureFormat = "png" | "pdf";

/** Say `text` in a deck bulletin. */
function caution(text: string): void {
  raiseDeckBulletin("caution", text);
}

/** What a figure's export is made from. */
export interface FigureSource {
  source: string;
  layers: ChartLayers;
}

/**
 * Render the figure in `format`; the file's path, or `null` when it failed,
 * which is said.
 */
export async function renderFigure(figure: FigureSource, format: FigureFormat): Promise<string | null> {
  const document = buildShareFigureDocument({
    theme: getOnScreenTheme(),
    source: figure.source,
    layers: figure.layers,
  });
  const outcome = await shareRender(format, JSON.stringify(document));
  if (outcome.result !== "ok") {
    caution(FIGURE_RENDER_FAILED_TEXT);
    return null;
  }
  return outcome.path;
}

/**
 * Put the render at `path` on the pasteboard, with `source` as its
 * plain-text flavour. Resolves whether it got there; a failure is said.
 */
export async function copyFigureFile(path: string, source: string): Promise<boolean> {
  if ((await shareCopyFile(path, source)) !== "done") {
    caution(FIGURE_COPY_FAILED_TEXT);
    return false;
  }
  return true;
}

/**
 * Save the render at `path` through the host's save panel, under
 * `baseName`. Resolves `true` once written; a dismissed panel says nothing.
 */
export async function saveFigureFile(path: string, format: FigureFormat, baseName: string): Promise<boolean> {
  const result = await shareSave({ format, text: "", path, baseName });
  if (result === "done") return true;
  if (result !== "canceled") caution(FIGURE_SAVE_FAILED_TEXT);
  return false;
}

/** Show the system share picker over the render at `path`, anchored at `anchor`. */
export async function pickFigureFile(path: string, format: FigureFormat, anchor: ShareAnchor): Promise<void> {
  const result = await sharePick({ format, text: "", path }, anchor);
  if (result !== "shown" && result !== "done") caution(FIGURE_PICK_FAILED_TEXT);
}

/**
 * Copy the figure as a PNG, with its spec as the plain-text flavour.
 * Resolves whether it reached the pasteboard; a failure is said.
 */
export async function copyFigurePicture(figure: FigureSource): Promise<boolean> {
  const path = await renderFigure(figure, "png");
  return path === null ? false : copyFigureFile(path, figure.source);
}

/**
 * Open the share sheet for the figure standing at `el`, on the card that
 * holds it. Nothing is rendered until the sheet's action is pressed, so the
 * sheet is up at once. A figure no card answers for says so.
 */
export function shareFigure(
  el: Element,
  figure: FigureSource,
  about: { diagram: boolean; baseName: string; naturalWidth: number },
): void {
  if (!openFigureShare(el, { ...figure, ...about })) caution(FIGURE_SHEET_FAILED_TEXT);
}
