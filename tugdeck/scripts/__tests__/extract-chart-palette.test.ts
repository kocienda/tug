/**
 * extract-chart-palette.test.ts — the committed chart palette is a fresh
 * extraction, and the extraction has the shape tugtool embeds.
 *
 * `crates/tuggraphics/src/palette.json` is what `tugtool chart render`
 * resolves a standalone SVG's classes to, and the page resolves the same
 * classes through the live theme. The two agree only while the file is the
 * extraction of the current themes and aliases, so a theme edit that moves
 * a chart colour fails here until `bun run extract:chart-palette` is run
 * and its diff reviewed like any other change of rendering.
 *
 * Run: `cd tugdeck && bun test ./scripts/__tests__` — `bunfig.toml` pins
 * `[test] root = "src"`, so a bare `bun test` never discovers this file.
 */

import fs from "fs";

import { describe, expect, test } from "bun:test";

import { CHART_COLOUR_ROLES, PALETTE_PATH, extractPalette, hexFor, renderPalette } from "../extract-chart-palette";

const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/;

describe("extract-chart-palette", () => {
  test("palette.json equals a fresh extraction", () => {
    const committed = fs.readFileSync(PALETTE_PATH, "utf-8");
    expect(committed, "regenerate with `bun run extract:chart-palette`").toBe(renderPalette(extractPalette()));
  });

  test("every theme resolves every chart role to a hex colour", () => {
    const palette = extractPalette();
    const themes = Object.keys(palette);
    expect(themes.length).toBeGreaterThanOrEqual(10);
    expect(themes).toContain("ironclad");
    for (const theme of themes) {
      expect(Object.keys(palette[theme]), theme).toEqual([...CHART_COLOUR_ROLES]);
      for (const role of CHART_COLOUR_ROLES) {
        expect(palette[theme][role], `${theme}/${role}`).toMatch(HEX);
      }
    }
  });

  test("a translucent colour carries an alpha byte and an opaque one does not", () => {
    expect(hexFor({ L: 1, C: 0, h: 0 })).toBe("#ffffff");
    expect(hexFor({ L: 1, C: 0, h: 0, alpha: 1 })).toBe("#ffffff");
    expect(hexFor({ L: 0, C: 0, h: 0, alpha: 0.5 })).toBe("#00000080");
  });
});
