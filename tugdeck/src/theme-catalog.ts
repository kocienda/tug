/**
 * theme-catalog.ts — what can be said about a theme without applying it.
 *
 * Only one theme's tokens are in the document at a time, so anything that
 * shows a theme other than the one on screen — the swatch on a workspace row,
 * the menu it opens — cannot read a computed style for it. This table is that
 * reading, taken ahead of time: each shipped theme's mode, the canvas color
 * its stylesheet declares as `--tugx-host-canvas-color`, and its Key hue —
 * the color of selection, toggle-on and filled action buttons, declared as
 * `--tug7-surface-control-primary-filled-action-rest`.
 *
 * Hand-kept beside `tugdeck/styles/themes/*.css`, and held to them by
 * `theme-catalog.test.ts`, which reads every stylesheet and fails on a color,
 * a mode or a name that has drifted.
 */

import { BASE_THEME_NAME } from "./theme-constants";

export type ThemeMode = "dark" | "light";

export interface ThemeCatalogEntry {
  readonly name: string;
  /** The name as a menu shows it. */
  readonly label: string;
  readonly mode: ThemeMode;
  /** The stylesheet's `--tugx-host-canvas-color`. */
  readonly canvasColor: string;
  /**
   * The theme's Key hue: the stylesheet's
   * `--tug7-surface-control-primary-filled-action-rest`, resolved from its
   * `--tug-color(…)` to the concrete color the build emits. Every theme in a
   * mode has its own, so it is what a chip shows to tell themes apart.
   */
  readonly keyColor: string;
}

/** Every shipped theme: the dark ships, then the light boats. */
export const THEME_CATALOG: readonly ThemeCatalogEntry[] = [
  { name: BASE_THEME_NAME, label: "Ironclad", mode: "dark", canvasColor: "#16181d", keyColor: "oklch(0.65 0.2 250)" },
  { name: "caravel", label: "Caravel", mode: "dark", canvasColor: "#111816", keyColor: "oklch(0.65 0.1881 165)" },
  { name: "barque", label: "Barque", mode: "dark", canvasColor: "#18181d", keyColor: "oklch(0.65 0.2 285)" },
  { name: "galleon", label: "Galleon", mode: "dark", canvasColor: "#1b1813", keyColor: "oklch(0.65 0.1603 222.5)" },
  { name: "collier", label: "Collier", mode: "dark", canvasColor: "#131a1b", keyColor: "oklch(0.65 0.2 335)" },
  { name: "sloop", label: "Sloop", mode: "light", canvasColor: "#3d4446", keyColor: "oklch(0.65 0.16 230)" },
  { name: "ketch", label: "Ketch", mode: "light", canvasColor: "#404248", keyColor: "oklch(0.65 0.16 277.5)" },
  { name: "skiff", label: "Skiff", mode: "light", canvasColor: "#414743", keyColor: "oklch(0.65 0.16 165)" },
  { name: "kayak", label: "Kayak", mode: "light", canvasColor: "#3d4347", keyColor: "oklch(0.65 0.16 240)" },
  { name: "pinnace", label: "Pinnace", mode: "light", canvasColor: "#454145", keyColor: "oklch(0.65 0.16 335)" },
];

/** The catalog entry for `theme`, or the base theme's for a name not shipped. */
export function themeCatalogEntry(theme: string | undefined): ThemeCatalogEntry {
  return THEME_CATALOG.find((entry) => entry.name === theme) ?? THEME_CATALOG[0];
}
