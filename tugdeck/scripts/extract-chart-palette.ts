#!/usr/bin/env bun
/**
 * extract-chart-palette.ts — the standalone chart palette, one resolved
 * colour per chart role per theme.
 *
 * On the page a chart's colour is a class over a `--tugx-chart-<role>`
 * token, which `chart-block.css` aliases to a theme token, so a theme
 * switch restyles the figure in place. A standalone SVG has no page and no
 * theme, so `tugtool chart render` writes one `<style>` resolving the same
 * classes to concrete colours — and those colours have to be the ones the
 * page would show. This script follows each role from its alias to the
 * theme token it names and resolves that token's `--tug-color(...)` recipe
 * with the same path the contrast audit uses (`buildDefs` / `resolveToken`
 * over `resolveTugColorToOklch`), so the palette and the page cannot
 * disagree about a colour.
 *
 * The result is written as `crates/tuggraphics/src/palette.json`,
 * `{theme: {role: "#rrggbb" | "#rrggbbaa"}}`, which tugtool embeds.
 * `scripts/__tests__/extract-chart-palette.test.ts` holds the file equal to
 * a fresh extraction, so a theme or alias edit that moves a chart colour
 * fails until the palette is regenerated:
 *
 *   bun run extract:chart-palette
 */

import fs from "fs";
import path from "path";

import { oklchToHex } from "../src/components/tugways/tugcolor";
import type { ResolvedColor } from "../src/components/tugways/theme-accessibility";
import { buildDefs, resolveToken } from "./audit-theme-contrast";

const TUGDECK = path.resolve(import.meta.dir, "..");
const THEMES_DIR = path.join(TUGDECK, "styles/themes");

/** Where the palette lives: beside the engine, which tugtool reaches as a path dependency. */
export const PALETTE_PATH = path.join(TUGDECK, "crates/tuggraphics/src/palette.json");

/**
 * The chart's colour roles — the engine's `ColourRole::all()`, as the
 * `tgf-<role>` / `tgs-<role>` classes and the `--tugx-chart-<role>` aliases
 * spell them.
 */
export const CHART_COLOUR_ROLES: readonly string[] = [
  "ink",
  "ink-muted",
  "grid",
  "surface",
  "accent",
  "good",
  "bad",
  "series-1",
  "series-2",
  "series-3",
  "series-4",
  "series-5",
  "series-6",
  "series-7",
  "series-8",
];

/** `{theme: {role: hex}}`, both levels in sorted order. */
export type ChartPalette = Record<string, Record<string, string>>;

/** `#rrggbb`, with an `aa` byte only when the colour is translucent. */
export function hexFor(color: ResolvedColor): string {
  const hex = oklchToHex(color.L, color.C, color.h);
  const alpha = color.alpha ?? 1;
  if (alpha >= 1) return hex;
  const byte = Math.round(Math.max(0, alpha) * 255);
  return `${hex}${byte.toString(16).padStart(2, "0")}`;
}

/** Every shipped theme file, by name. */
export function themeFiles(): { theme: string; file: string }[] {
  return fs
    .readdirSync(THEMES_DIR)
    .filter((name) => name.endsWith(".css"))
    .sort()
    .map((name) => ({ theme: path.basename(name, ".css"), file: path.join(THEMES_DIR, name) }));
}

/**
 * Resolve every chart role in every theme. A role whose alias does not
 * reach a `--tug-color(...)` recipe is an error rather than a gap: a
 * standalone chart with an unresolved class would draw that role black.
 */
export function extractPalette(): ChartPalette {
  const palette: ChartPalette = {};
  for (const { theme, file } of themeFiles()) {
    const defs = buildDefs(file);
    const colours: Record<string, string> = {};
    for (const role of CHART_COLOUR_ROLES) {
      const token = `--tugx-chart-${role}`;
      const color = resolveToken(token, defs);
      if (color === null) {
        throw new Error(`${theme}: ${token} does not resolve to a --tug-color() recipe`);
      }
      colours[role] = hexFor(color);
    }
    palette[theme] = colours;
  }
  return palette;
}

/** The file's bytes for a palette: two-space JSON and a trailing newline. */
export function renderPalette(palette: ChartPalette): string {
  return `${JSON.stringify(palette, null, 2)}\n`;
}

if (import.meta.main) {
  const palette = extractPalette();
  fs.writeFileSync(PALETTE_PATH, renderPalette(palette), "utf-8");
  const themes = Object.keys(palette).length;
  console.log(
    `extract-chart-palette: ${themes} theme(s) × ${CHART_COLOUR_ROLES.length} role(s) -> ${path.relative(TUGDECK, PALETTE_PATH)}`,
  );
}
