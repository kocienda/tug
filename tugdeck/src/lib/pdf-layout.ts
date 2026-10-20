/**
 * pdf-layout.ts — where the pages of a PDF go, as pure arithmetic.
 *
 * A page's size is stated by the document, so every box here is computed from
 * real dimensions rather than estimated. Exact geometry is also what makes
 * windowing safe: the scroll extent is right before a single page has
 * rendered, so nothing shifts underneath the reader as canvases fill in.
 *
 * The three page modes differ only in how pages are grouped and along which
 * axis a group is laid out. Continuous scroll is one group holding every
 * page, stacked vertically; Single Page is one group per page; Two Pages is
 * one group per pair, laid out horizontally. `spreadsFor` does the grouping
 * and `layoutSpread` does the placement, so the modes share one code path.
 *
 * Sizes arrive unscaled, as pdf.js reports them at scale 1. Gaps and padding
 * are screen pixels and do not scale — a gutter is chrome, not content — so
 * they are added after the scale multiply, and `fitScale` subtracts them
 * before dividing.
 *
 * @module lib/pdf-layout
 */

/** How pages are grouped and laid out. */
export type PdfPageMode = "continuous" | "single" | "two";

/** A page's unscaled size, as pdf.js reports it at scale 1. */
export interface PdfPageSize {
  width: number;
  height: number;
}

/** A placed page: its box within the laid-out content, in screen pixels. */
export interface PdfPageBox {
  /** 1-based page number, matching pdf.js's own numbering. */
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A laid-out group of pages and the content box that holds them. */
export interface PdfLayout {
  boxes: PdfPageBox[];
  width: number;
  height: number;
}

/** The space a layout is being fitted into, in screen pixels. */
export interface PdfViewport {
  width: number;
  height: number;
}

/** Spacing knobs, in screen pixels. Defaults mirror `pdf-view.css`. */
export interface PdfSpacing {
  /** Between adjacent pages in a spread. */
  gap: number;
  /** Around the whole content box. */
  padding: number;
}

export const PDF_SPACING: PdfSpacing = { gap: 12, padding: 12 };

/** Scale bounds. Below the floor a page is unreadable; above the ceiling the
 *  canvas allocation gets large enough to matter. */
export const PDF_MIN_SCALE = 0.1;
export const PDF_MAX_SCALE = 8;

/**
 * The zoom ladder ⌘+ and ⌘- step through, matching the stops a reader expects
 * from a document viewer. Stepping a ladder rather than multiplying keeps the
 * stops predictable and always lands back on 1 exactly.
 */
export const PDF_ZOOM_STEPS: readonly number[] = [
  0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8,
];

/** How close, as a ratio, a ladder stop may sit to a scale and still be it. */
const STEP_SAME = 1.02;

/** Clamp a scale into the supported range. */
export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(PDF_MAX_SCALE, Math.max(PDF_MIN_SCALE, scale));
}

/**
 * The next stop up or down the zoom ladder. A scale that sits between stops —
 * a fit scale, typically — moves to the neighbouring stop in that direction
 * rather than snapping to the nearest.
 *
 * A stop within {@link STEP_SAME} of the scale counts as the scale itself, so
 * a fit scale that happens to sit a hair below a stop steps past it: a Zoom
 * In that grows the page by a fraction of a pixel is a press that did nothing.
 */
export function steppedScale(scale: number, direction: 1 | -1): number {
  if (direction === 1) {
    const up = PDF_ZOOM_STEPS.find((step) => step > scale * STEP_SAME);
    return up ?? PDF_MAX_SCALE;
  }
  const down = [...PDF_ZOOM_STEPS]
    .reverse()
    .find((step) => step < scale / STEP_SAME);
  return down ?? PDF_MIN_SCALE;
}

/**
 * Group a document's pages into the spreads a mode displays, as 1-based page
 * numbers. Continuous scroll is a single spread holding the whole document;
 * the paged modes yield one spread per screenful.
 */
export function spreadsFor(pageCount: number, mode: PdfPageMode): number[][] {
  if (pageCount <= 0) return [];
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
  if (mode === "continuous") return [pages];
  if (mode === "single") return pages.map((page) => [page]);
  const spreads: number[][] = [];
  for (let i = 0; i < pages.length; i += 2) spreads.push(pages.slice(i, i + 2));
  return spreads;
}

/** Which spread holds a given page. Returns 0 for a page outside the document. */
export function spreadIndexOfPage(
  page: number,
  pageCount: number,
  mode: PdfPageMode,
): number {
  const spreads = spreadsFor(pageCount, mode);
  const index = spreads.findIndex((spread) => spread.includes(page));
  return index === -1 ? 0 : index;
}

/** Two Pages lays a spread out across the page; the others stack down it. */
function isHorizontal(mode: PdfPageMode): boolean {
  return mode === "two";
}

/** The unscaled extent of a spread, before gaps and padding. */
function spreadExtent(
  sizes: readonly PdfPageSize[],
  spread: readonly number[],
  mode: PdfPageMode,
): PdfPageSize {
  const pages = spread
    .map((page) => sizes[page - 1])
    .filter((size): size is PdfPageSize => size !== undefined);
  if (pages.length === 0) return { width: 0, height: 0 };
  const widths = pages.map((size) => size.width);
  const heights = pages.map((size) => size.height);
  const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);
  return isHorizontal(mode)
    ? { width: sum(widths), height: Math.max(...heights) }
    : { width: Math.max(...widths), height: sum(heights) };
}

/**
 * Place a spread's pages at a given scale. Pages are centred on the layout's
 * cross axis, so a landscape page in a portrait document sits centred rather
 * than flush left.
 */
export function layoutSpread(
  sizes: readonly PdfPageSize[],
  spread: readonly number[],
  mode: PdfPageMode,
  scale: number,
  spacing: PdfSpacing = PDF_SPACING,
): PdfLayout {
  const pages = spread.filter((page) => sizes[page - 1] !== undefined);
  if (pages.length === 0) return { boxes: [], width: 0, height: 0 };

  const horizontal = isHorizontal(mode);
  const extent = spreadExtent(sizes, pages, mode);
  const gaps = spacing.gap * (pages.length - 1);
  const contentWidth =
    extent.width * scale + (horizontal ? gaps : 0) + spacing.padding * 2;
  const contentHeight =
    extent.height * scale + (horizontal ? 0 : gaps) + spacing.padding * 2;

  const boxes: PdfPageBox[] = [];
  let cursor = spacing.padding;
  for (const page of pages) {
    const size = sizes[page - 1];
    const width = size.width * scale;
    const height = size.height * scale;
    if (horizontal) {
      boxes.push({
        page,
        x: cursor,
        y: (contentHeight - height) / 2,
        width,
        height,
      });
      cursor += width + spacing.gap;
    } else {
      boxes.push({
        page,
        x: (contentWidth - width) / 2,
        y: cursor,
        width,
        height,
      });
      cursor += height + spacing.gap;
    }
  }
  return { boxes, width: contentWidth, height: contentHeight };
}

/**
 * The scale at which a spread fits its viewport — by width, or whole so the
 * full spread is visible at once. Gaps and padding come off the viewport
 * first, since they are fixed pixels that do not shrink with the content.
 */
export function fitScale(
  sizes: readonly PdfPageSize[],
  spread: readonly number[],
  mode: PdfPageMode,
  viewport: PdfViewport,
  fit: "width" | "page",
  spacing: PdfSpacing = PDF_SPACING,
): number {
  const pages = spread.filter((page) => sizes[page - 1] !== undefined);
  if (pages.length === 0) return 1;

  const horizontal = isHorizontal(mode);
  const extent = spreadExtent(sizes, pages, mode);
  const gaps = spacing.gap * (pages.length - 1);
  const availableWidth =
    viewport.width - spacing.padding * 2 - (horizontal ? gaps : 0);
  const availableHeight =
    viewport.height - spacing.padding * 2 - (horizontal ? 0 : gaps);

  if (extent.width <= 0 || extent.height <= 0) return 1;
  const byWidth = availableWidth / extent.width;
  if (fit === "width") return clampScale(byWidth);
  return clampScale(Math.min(byWidth, availableHeight / extent.height));
}

/**
 * The pages intersecting the scrolled viewport, plus `margin` pixels of
 * lookahead on each side. This is what keeps a long document from rendering
 * every page: only these need canvases.
 */
export function visiblePages(
  layout: PdfLayout,
  scrollTop: number,
  viewportHeight: number,
  margin = 0,
): number[] {
  const top = scrollTop - margin;
  const bottom = scrollTop + viewportHeight + margin;
  return layout.boxes
    .filter((box) => box.y < bottom && box.y + box.height > top)
    .map((box) => box.page);
}

// ---------------------------------------------------------------------------
// Holding the reader's place
// ---------------------------------------------------------------------------

/**
 * Where a reader is in a PDF, in coordinates that survive a re-layout.
 *
 * A page and a fraction of the way down it, rather than a pixel. Every
 * dimension of this layout is derived from a scale, and the scale changes
 * whenever the card does: under `fit-width` a narrower card renders every page
 * smaller, so the same pixel offset lands on a different part of a different
 * page. The page number and the fraction are the two quantities that do not
 * move when the scale does.
 */
export interface PdfPageAnchor {
  /** 1-based page number. */
  page: number;
  /** How far down that page the viewport top falls, 0…1. */
  fraction: number;
}

/** The page under `scrollTop`, and how far into it, or `null` for an empty layout. */
export function pageAnchorAt(
  layout: PdfLayout,
  scrollTop: number,
): PdfPageAnchor | null {
  if (layout.boxes.length === 0) return null;
  // The first page whose bottom is still below the viewport top. Falling off
  // the end means the reader is past the last page's bottom — the gap after
  // it — which the last page's end represents faithfully enough.
  const box =
    layout.boxes.find((b) => b.y + b.height > scrollTop) ??
    layout.boxes[layout.boxes.length - 1];
  if (box.height <= 0) return { page: box.page, fraction: 0 };
  const fraction = (scrollTop - box.y) / box.height;
  return { page: box.page, fraction: Math.max(0, Math.min(1, fraction)) };
}

/** The `scrollTop` that puts `anchor` back, or `null` when its page is not in this layout. */
export function scrollTopForPageAnchor(
  layout: PdfLayout,
  anchor: PdfPageAnchor,
): number | null {
  const box = layout.boxes.find((b) => b.page === anchor.page);
  if (box === undefined) return null;
  const max = Math.max(0, layout.height);
  return Math.max(0, Math.min(max, box.y + anchor.fraction * box.height));
}
