/**
 * image-card-settings.ts — pure helpers for the viewer card's IMAGE
 * settings: the deck-wide defaults a newly opened image adopts, and the
 * per-card values that override them thereafter.
 *
 * No React, no DOM, no I/O — every export is a pure function or a constant,
 * so the parse/resolve logic is unit-testable without a store or a rendered
 * component. Persistence lives in the hook and the defaults store that
 * consume these (`use-image-card-settings.ts`, `default-card-settings-store`).
 * Mirrors `text-card-settings.ts` exactly; a reader who knows one knows both.
 *
 * Two tugbank surfaces, the same default/per-card split the Text card uses:
 *
 *   - Deck-wide defaults at `dev.tugapp.image-card/settings` — edited in the
 *     Settings card's "Viewer Cards" section.
 *   - Per-card values at `dev.image-card/<cardId>` — what the card's own gear
 *     writes. Resolved live from the defaults until the first change, then
 *     card-local.
 *
 * Every field is something the image surface can honor with CSS alone, which
 * is the same discipline the Text card's list follows against CM6: there is
 * no setting here that needs a re-decode or a second copy of the bytes.
 *
 * @module lib/image-card-settings
 */

import type { TaggedValue } from "@/lib/tugbank-client";

/**
 * How an image is sized inside the card.
 *
 *  - `"fit"` — scaled down to fit the card whole, never scaled up. The
 *    reading default: an oversized screenshot becomes legible and a small
 *    icon is not blown into mush.
 *  - `"fill"` — scaled to cover the card, cropping the overflow. What a
 *    wallpaper or a texture wants.
 *  - `"actual"` — one image pixel per CSS pixel, scrolled if it overflows.
 *    The only honest choice when the question is "how big is this really".
 */
export type ImageScaling = "fit" | "fill" | "actual";

/**
 * What is painted behind (and around) the image.
 *
 * This matters exactly as much as the image does when the image has an alpha
 * channel: a logo with a transparent ground is invisible on a light surface
 * and perfect on a dark one, and neither answer is right for every file. The
 * checkerboard is the one ground that says "this part is transparent" rather
 * than quietly picking a colour.
 */
export type ImageBackground = "checker" | "surface" | "black" | "white";

/** The per-card view settings for one image in a viewer card. */
export interface ImageCardSettings {
  /** How the image is sized in the card. */
  scaling: ImageScaling;
  /** What is painted behind it. */
  background: ImageBackground;
  /**
   * Smooth interpolation when the image is drawn at other than its natural
   * size. Off means nearest-neighbour: what icon, sprite, and pixel-art work
   * needs, where a smoothed pixel is a lie about the file.
   */
  smoothing: boolean;
  /** Show the strip naming the image's dimensions, kind, and size on disk. */
  showInfo: boolean;
}

/** tugbank domain for per-card image settings (keyed by cardId). */
export const IMAGE_CARD_DOMAIN = "dev.image-card";

/** tugbank domain/key for the deck-wide image defaults. */
export const IMAGE_CARD_DEFAULTS_DOMAIN = "dev.tugapp.image-card";
export const IMAGE_CARD_DEFAULTS_KEY = "settings";

/** The view settings an image uses when nothing else is configured. */
export const DEFAULT_IMAGE_CARD_SETTINGS: ImageCardSettings = {
  scaling: "fit",
  // The checkerboard rather than the card surface, because the surface is a
  // resting lie for any image with alpha: it renders transparency as whatever
  // the theme happens to be, and the reader cannot tell the two apart.
  background: "checker",
  smoothing: true,
  showInfo: false,
};

const SCALINGS: readonly ImageScaling[] = ["fit", "fill", "actual"];
const BACKGROUNDS: readonly ImageBackground[] = [
  "checker",
  "surface",
  "black",
  "white",
];

/** Coerce an untrusted value to an {@link ImageScaling}, else `null`. */
export function parseImageScaling(value: unknown): ImageScaling | null {
  return SCALINGS.includes(value as ImageScaling) ? (value as ImageScaling) : null;
}

/** Coerce an untrusted value to an {@link ImageBackground}, else `null`. */
export function parseImageBackground(value: unknown): ImageBackground | null {
  return BACKGROUNDS.includes(value as ImageBackground)
    ? (value as ImageBackground)
    : null;
}

/**
 * Parse per-card image settings out of a tugbank tagged value. Missing or
 * malformed fields fall back to {@link DEFAULT_IMAGE_CARD_SETTINGS}; a wholly
 * absent / non-json entry yields `null` (no per-card value).
 */
export function parseImageCardSettings(
  entry: TaggedValue | undefined,
): ImageCardSettings | null {
  if (entry?.kind !== "json" || entry.value === undefined || entry.value === null) {
    return null;
  }
  const obj = entry.value as Record<string, unknown>;
  const d = DEFAULT_IMAGE_CARD_SETTINGS;
  return {
    scaling: parseImageScaling(obj.scaling) ?? d.scaling,
    background: parseImageBackground(obj.background) ?? d.background,
    smoothing: typeof obj.smoothing === "boolean" ? obj.smoothing : d.smoothing,
    showInfo: typeof obj.showInfo === "boolean" ? obj.showInfo : d.showInfo,
  };
}

/**
 * The settings a freshly-bound image should use: its card's own persisted
 * values when present, otherwise the deck-wide defaults, otherwise the
 * built-in ones. Mirrors `resolveTextCardSettings`.
 */
export function resolveImageCardSettings(
  persisted: ImageCardSettings | null,
  defaults: ImageCardSettings | null,
): ImageCardSettings {
  if (persisted !== null) return persisted;
  if (defaults !== null) return defaults;
  return { ...DEFAULT_IMAGE_CARD_SETTINGS };
}

/**
 * A byte count in the words a reader uses. Decimal units, matching the
 * Finder — a file the Finder calls 1.2 MB must not read as 1.1 MB here.
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1000) return `${Math.round(bytes)} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  // One decimal below 10, none above: "9.4 MB", "24 MB" — the precision the
  // Finder shows, and the precision that carries information.
  const rounded = value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${rounded} ${units[unit]}`;
}
