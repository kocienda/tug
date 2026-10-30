/**
 * The series half of the CVD check: an adjacent pair of chart series is judged
 * by its OKLab distance under each deficiency and under normal vision, a status
 * pair by its luminance delta, and every shipped theme clears the series floors.
 */

import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import {
  checkCVDDistinguishability,
  CVD_SEMANTIC_PAIRS,
  oklabDistance,
  type ResolvedColor,
} from "@/components/tugways/theme-accessibility";
import { buildDefs, resolveToken } from "../../scripts/audit-theme-contrast";

const SERIES_A = "--tug7-element-chart-fill-normal-series1-rest";
const SERIES_B = "--tug7-element-chart-fill-normal-series2-rest";
const STATUS_A = "--tug7-element-tone-fill-normal-success-rest";
const STATUS_B = "--tug7-element-tone-fill-normal-danger-rest";

function warningsFor(tokenA: string, tokenB: string, a: ResolvedColor, b: ResolvedColor) {
  return checkCVDDistinguishability({ [tokenA]: a, [tokenB]: b }, [[tokenA, tokenB]]);
}

describe("oklabDistance", () => {
  test("is 100 from white to black and 0 for one colour", () => {
    const white = { r: 1, g: 1, b: 1 };
    const black = { r: 0, g: 0, b: 0 };
    expect(oklabDistance(white, black)).toBeCloseTo(100, 1);
    expect(oklabDistance(white, white)).toBe(0);
  });
});

describe("checkCVDDistinguishability on chart series", () => {
  test("one colour twice warns under every deficiency and normal vision", () => {
    const color = { L: 0.7, C: 0.15, h: 250 };
    const types = warningsFor(SERIES_A, SERIES_B, color, color).map((w) => w.type);
    expect(types).toEqual(["protanopia", "deuteranopia", "tritanopia", "achromatopsia", "normal"]);
  });

  test("a red and a green at one lightness pass normal vision and fail a red-green deficiency", () => {
    const types = warningsFor(
      SERIES_A,
      SERIES_B,
      { L: 0.65, C: 0.12, h: 40 },
      { L: 0.65, C: 0.12, h: 130 },
    ).map((w) => w.type);
    expect(types).not.toContain("normal");
    expect(types).toContain("deuteranopia");
  });

  test("a blue and an orange at one lightness are apart, whatever their luminance", () => {
    const a = { L: 0.7, C: 0.17, h: 250 };
    const b = { L: 0.7, C: 0.17, h: 60 };
    expect(warningsFor(SERIES_A, SERIES_B, a, b).filter((w) => w.type !== "achromatopsia")).toEqual([]);
  });

  test("a pair with a token absent is skipped", () => {
    const resolved = { [SERIES_A]: { L: 0.7, C: 0.15, h: 250 } };
    expect(checkCVDDistinguishability(resolved, [[SERIES_A, SERIES_B]])).toEqual([]);
  });
});

describe("checkCVDDistinguishability on status pairs", () => {
  test("a small OKLab distance with a large luminance delta does not warn", () => {
    const warnings = warningsFor(
      STATUS_A,
      STATUS_B,
      { L: 0.3, C: 0, h: 0 },
      { L: 0.95, C: 0, h: 0 },
    );
    expect(warnings).toEqual([]);
  });

  test("one lightness warns on the luminance delta, and nothing is said of normal vision", () => {
    const types = warningsFor(
      STATUS_A,
      STATUS_B,
      { L: 0.7, C: 0, h: 0 },
      { L: 0.7, C: 0, h: 0 },
    ).map((w) => w.type);
    expect(types).toEqual(["protanopia", "deuteranopia", "tritanopia", "achromatopsia"]);
  });
});

describe("every shipped theme", () => {
  const themesDir = path.resolve(import.meta.dir, "../../styles/themes");
  const themes = fs.readdirSync(themesDir).filter((f) => f.endsWith(".css"));

  test("is found", () => {
    expect(themes.length).toBeGreaterThan(0);
  });

  for (const file of themes) {
    test(`${file} keeps its adjacent series apart`, () => {
      const defs = buildDefs(path.join(themesDir, file));
      const resolved: Record<string, ResolvedColor> = {};
      for (const token of CVD_SEMANTIC_PAIRS.flat()) {
        const color = resolveToken(token, defs);
        if (color) resolved[token] = color;
      }
      const series = checkCVDDistinguishability(resolved, CVD_SEMANTIC_PAIRS).filter((w) =>
        w.tokenPair[0].includes("-chart-"),
      );
      expect(series).toEqual([]);
    });
  }
});
