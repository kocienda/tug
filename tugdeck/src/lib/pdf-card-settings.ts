/**
 * pdf-card-settings.ts — pure helpers for the viewer card's PDF settings.
 *
 * The split this file exists to keep straight: the surface already remembers
 * the mode and zoom the reader chose, in the card's bag ([L23]), so a document
 * comes back exactly as it was left. Those are STATE. What lives here are the
 * PREFERENCES — what a document opens at before anyone has chosen anything,
 * and the two rendering knobs that are not a reading position at all. A
 * setting that duplicated the live zoom would be a second opinion about a
 * question the bag already answers, and the two would drift the first time a
 * reader touched ⌘+.
 *
 * No React, no DOM, no I/O; persistence lives in the hook and the defaults
 * store that consume these. Two tugbank surfaces, the Text card's split:
 * deck-wide defaults at `dev.tugapp.pdf-card/settings`, per-card values at
 * `dev.pdf-card/<cardId>`.
 *
 * @module lib/pdf-card-settings
 */

import type { TaggedValue } from "@/lib/tugbank-client";
import type { PdfPageMode } from "@/lib/pdf-layout";
import type { PdfZoom } from "@/components/tugways/cards/pdf-view";

/**
 * The zoom a document OPENS at. A subset of {@link PdfZoom}: the two fits and
 * actual size, and no arbitrary scale. A preference is a standing answer for
 * every document a card will ever open, and "1.37×" is not an answer anyone
 * means to give every PDF — the reader's own ⌘+ is where a specific scale
 * belongs, and the bag is where it is remembered.
 */
export type PdfOpeningZoom = "fit-width" | "fit-page" | "actual";

/** The per-card preferences for one PDF in a viewer card. */
export interface PdfCardSettings {
  /** The page mode a freshly opened document takes. */
  pageMode: PdfPageMode;
  /** The zoom a freshly opened document takes. */
  openingZoom: PdfOpeningZoom;
  /** Pixels between adjacent pages (and around the content box). */
  pageGap: number;
  /**
   * In a dark theme, render pages inverted — dark paper, light ink — instead
   * of a white rectangle in a dark room. Applies only under a dark theme: a
   * light theme inverting its pages would be the same complaint in reverse.
   */
  invertInDark: boolean;
}

/** tugbank domain for per-card PDF settings (keyed by cardId). */
export const PDF_CARD_DOMAIN = "dev.pdf-card";

/** tugbank domain/key for the deck-wide PDF defaults. */
export const PDF_CARD_DEFAULTS_DOMAIN = "dev.tugapp.pdf-card";
export const PDF_CARD_DEFAULTS_KEY = "settings";

/** Bounds for the page gap, in pixels. */
export const PDF_PAGE_GAP_MIN = 0;
export const PDF_PAGE_GAP_MAX = 64;

/** The preferences a PDF uses when nothing else is configured. */
export const DEFAULT_PDF_CARD_SETTINGS: PdfCardSettings = {
  pageMode: "continuous",
  openingZoom: "fit-width",
  // Matches `PDF_SPACING.gap`, which is what the surface used before this
  // setting existed — the default has to be the old constant or every open
  // document would shift the first time this shipped.
  pageGap: 12,
  invertInDark: false,
};

const PAGE_MODES: readonly PdfPageMode[] = ["continuous", "single", "two"];
const OPENING_ZOOMS: readonly PdfOpeningZoom[] = [
  "fit-width",
  "fit-page",
  "actual",
];

/** Coerce an untrusted value to a {@link PdfPageMode}, else `null`. */
export function parsePdfPageMode(value: unknown): PdfPageMode | null {
  return PAGE_MODES.includes(value as PdfPageMode) ? (value as PdfPageMode) : null;
}

/** Coerce an untrusted value to a {@link PdfOpeningZoom}, else `null`. */
export function parsePdfOpeningZoom(value: unknown): PdfOpeningZoom | null {
  return OPENING_ZOOMS.includes(value as PdfOpeningZoom)
    ? (value as PdfOpeningZoom)
    : null;
}

/** Clamp an arbitrary number to a sane page gap. */
export function clampPageGap(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PDF_CARD_SETTINGS.pageGap;
  return Math.max(PDF_PAGE_GAP_MIN, Math.min(PDF_PAGE_GAP_MAX, Math.round(value)));
}

/**
 * Parse per-card PDF settings out of a tugbank tagged value. Missing or
 * malformed fields fall back to {@link DEFAULT_PDF_CARD_SETTINGS}; a wholly
 * absent / non-json entry yields `null`.
 */
export function parsePdfCardSettings(
  entry: TaggedValue | undefined,
): PdfCardSettings | null {
  if (entry?.kind !== "json" || entry.value === undefined || entry.value === null) {
    return null;
  }
  const obj = entry.value as Record<string, unknown>;
  const d = DEFAULT_PDF_CARD_SETTINGS;
  return {
    pageMode: parsePdfPageMode(obj.pageMode) ?? d.pageMode,
    openingZoom: parsePdfOpeningZoom(obj.openingZoom) ?? d.openingZoom,
    pageGap: typeof obj.pageGap === "number" ? clampPageGap(obj.pageGap) : d.pageGap,
    invertInDark:
      typeof obj.invertInDark === "boolean" ? obj.invertInDark : d.invertInDark,
  };
}

/** Per-card values win, then deck-wide defaults, then the built-ins. */
export function resolvePdfCardSettings(
  persisted: PdfCardSettings | null,
  defaults: PdfCardSettings | null,
): PdfCardSettings {
  if (persisted !== null) return persisted;
  if (defaults !== null) return defaults;
  return { ...DEFAULT_PDF_CARD_SETTINGS };
}

/** The surface's zoom value an opening preference means. */
export function openingZoomToPdfZoom(zoom: PdfOpeningZoom): PdfZoom {
  return zoom === "actual" ? 1 : zoom;
}
