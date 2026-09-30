/**
 * Theme Accessibility Module — Tugways Theme Generator
 *
 * Provides WCAG 2.x contrast ratio calculation, perceptual contrast calculation,
 * theme contrast validation against the authoritative pairing map, and CVD
 * simulation using Machado et al. 2009 matrices.
 *
 * References:
 *   [D05] CVD simulation matrices (Machado et al. 2009),  *   [D07] Contrast thresholds follow WCAG 2.x as normative, perceptual contrast as informational
 *   [D03] Authoritative fg/bg pairing map
 *   [D09] Dual output: string tokens + resolved OKLCH map
 *   Contrast Threshold Matrix
 *  : ThemeOutput / ResolvedColor interfaces
 *
 * @module components/tugways/theme-accessibility
 */

import { oklchToHex, oklchToLinearSRGB } from "./tugcolor";
import type { ElementSurfacePairing } from "./theme-pairings";

export interface ResolvedColor {
  L: number;
  C: number;
  h: number;
  alpha?: number;
}

export interface ContrastResult {
  fg: string;
  bg: string;
  wcagRatio: number;
  contrast: number;
  contrastPass: boolean;
  role: string;
}

export interface CVDWarning {
  type: CVDType;
  tokenPair: [string, string];
  description: string;
  suggestion: string;
}

// ---------------------------------------------------------------------------
// Re-export PairingEntry alias for compatibility with plan spec.
// validateThemeContrast accepts PairingEntry[] (which is ElementSurfacePairing[]).
// ---------------------------------------------------------------------------
export type { ElementSurfacePairing as PairingEntry };

// ---------------------------------------------------------------------------
// WCAG 2.x — relative luminance contrast ratio
// ---------------------------------------------------------------------------

/**
 * Convert a single linearised sRGB channel value to WCAG 2.x relative luminance.
 *
 * The WCAG 2.x formula uses gamma-decoded (linear) sRGB:
 *   Y = R_lin * 0.2126 + G_lin * 0.7152 + B_lin * 0.0722
 *
 * Channel values are [0, 1] gamma-encoded sRGB.
 */
function srgbChannelToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Parse a 6-digit hex color string (#rrggbb) into linear sRGB {r, g, b}.
 */
function hexToLinearSRGB(hex: string): { r: number; g: number; b: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return {
    r: srgbChannelToLinear(r),
    g: srgbChannelToLinear(g),
    b: srgbChannelToLinear(b),
  };
}

/**
 * Compute WCAG 2.x relative luminance from a linear-sRGB triplet.
 *
 * Y = 0.2126R + 0.7152G + 0.0722B  (linear sRGB coefficients, IEC 61966-2-1)
 */
function relativeLuminance(linear: { r: number; g: number; b: number }): number {
  return 0.2126 * linear.r + 0.7152 * linear.g + 0.0722 * linear.b;
}

/**
 * Compute the WCAG 2.x contrast ratio between two hex colors.
 *
 * Returns the standard relative luminance ratio:
 *   (L1 + 0.05) / (L2 + 0.05)
 * where L1 >= L2 (lighter color is always in numerator).
 *
 * Range is [1, 21]. White-on-black returns exactly 21.0.
 *
 * @param fgHex - Foreground color as #rrggbb
 * @param bgHex - Background color as #rrggbb
 * @returns WCAG 2.x contrast ratio
 */
export function computeWcagContrast(fgHex: string, bgHex: string): number {
  const fgLinear = hexToLinearSRGB(fgHex);
  const bgLinear = hexToLinearSRGB(bgHex);
  const l1 = relativeLuminance(fgLinear);
  const l2 = relativeLuminance(bgLinear);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ---------------------------------------------------------------------------
// OKLab L conversion
// ---------------------------------------------------------------------------

/**
 * Convert a #rrggbb hex color to OKLab perceptual lightness (L).
 *
 * Follows the OKLab specification by Björn Ottosson (2020):
 *   https://bottosson.github.io/posts/oklab/
 *
 * Steps:
 *   1. Parse hex to sRGB [0,1] channels
 *   2. Linearise each channel via srgbChannelToLinear (IEC 61966-2-1)
 *   3. Apply the OKLab M1 matrix (linear sRGB → linear LMS):
 *        l = 0.4122214708·R + 0.5363325363·G + 0.0514459929·B
 *        m = 0.2119034982·R + 0.6806995451·G + 0.1073969566·B
 *        s = 0.0883024619·R + 0.2817188376·G + 0.6299787005·B
 *   4. Cube-root each: l_ = cbrt(l), m_ = cbrt(m), s_ = cbrt(s)
 *   5. Compute L = 0.2104542553·l_ + 0.7936177850·m_ - 0.0040720468·s_
 *
 * Returns the OKLab L component in the range [0, 1]:
 *   black (#000000) → ~0.0
 *   white (#ffffff) → ~1.0
 *   mid-gray (#777777) → ~0.57
 *
 * @param hex - Color as #rrggbb hex string
 * @returns OKLab perceptual lightness L ∈ [0, 1]
 */
export function hexToOkLabL(hex: string): number {
  const r = srgbChannelToLinear(parseInt(hex.slice(1, 3), 16) / 255);
  const g = srgbChannelToLinear(parseInt(hex.slice(3, 5), 16) / 255);
  const b = srgbChannelToLinear(parseInt(hex.slice(5, 7), 16) / 255);

  // OKLab M1 matrix: linear sRGB → linear LMS (Ottosson 2020)
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  // Cube-root each LMS channel
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  // OKLab M2 matrix: LMS^ → Lab (L component only)
  return 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
}

// ---------------------------------------------------------------------------
// Perceptual contrast calculation — OKLab L-based metric with polarity correction
// ---------------------------------------------------------------------------

/**
 * Scale factor converting OKLab ΔL to the contrast score range used by
 * CONTRAST_THRESHOLDS (content=75, control=60, display=60, informational=60, decorative=15).
 *
 * Calibrated against the Ironclad dark token set. The anchor pair fg-default/bg-app
 * has OKLab ΔL≈0.727 (fgL≈0.935, bgL≈0.208), yielding a score of ≈−92.7 with
 * POLARITY_FACTOR=0.85 — comfortably above the content threshold of 75.
 *
 * Reference: Ottosson 2020 OKLab perceptual lightness model.
 */
export const CONTRAST_SCALE = 150;

/**
 * Polarity correction factor applied to negative-polarity contrast (light
 * element on dark surface).
 *
 * Vision science literature (Piepenbrock 2013, Whittle 1986) documents that
 * light-on-dark text requires ~15% more physical contrast to reach the same
 * perceived readability as dark-on-light text. This factor applies a
 * corresponding reduction: negative-polarity scores are multiplied by 0.85.
 *
 * Starting value: 0.85 (matching the published ~15% disadvantage figure).
 * Calibrated against Ironclad dark token set to preserve pass/fail boundaries.
 *
 * References:
 *   Piepenbrock et al. (2013) — "Positive Display Polarity Is Particularly
 *     Advantageous for Small Character Sizes"
 *   Whittle (1986) — "Increments and decrements: luminance discrimination"
 */
export const POLARITY_FACTOR = 0.85;

/**
 * Minimum OKLab ΔL below which contrast is reported as zero.
 *
 * Pairs whose surface and element L values differ by less than this amount
 * are perceptually indistinguishable in lightness and produce a score of 0.
 * This is the OKLab-equivalent of the soft-clip behaviour in the previous
 * algorithm.
 */
export const CONTRAST_MIN_DELTA = 0.03;

/**
 * Compute the perceptual contrast for an element/surface pair.
 *
 * Implements the OKLab L-based metric ():
 *   1. Convert each hex color to OKLab L via hexToOkLabL ().
 *   2. Compute deltaL = surfaceL - elementL.
 *   3. If |deltaL| < CONTRAST_MIN_DELTA, return 0.
 *   4. Positive polarity (surface is lighter, dark element on light surface):
 *        return deltaL * CONTRAST_SCALE
 *   5. Negative polarity (surface is darker, light element on dark surface):
 *        return deltaL * CONTRAST_SCALE * POLARITY_FACTOR
 *
 * Returns the signed contrast score:
 *   - Positive: dark element on light surface (positive polarity)
 *   - Negative: light element on dark surface (negative polarity, after correction)
 *   - 0: insufficient lightness delta (perceptually indistinguishable)
 *
 * Magnitude is the normative contrast gate per CONTRAST_THRESHOLDS:
 *   >= 75 → content (primary prose text)
 *   >= 60 → control / display / informational (interactive labels, titles, metadata)
 *   >= 15 → decorative (non-text ornamental marks)
 *
 * @param elementHex - Element (foreground) color as #rrggbb
 * @param surfaceHex - Surface (background) color as #rrggbb
 * @returns Signed perceptual contrast score
 */
export function computePerceptualContrast(elementHex: string, surfaceHex: string): number {
  const elementL = hexToOkLabL(elementHex);
  const surfaceL = hexToOkLabL(surfaceHex);

  const deltaL = surfaceL - elementL;

  if (Math.abs(deltaL) < CONTRAST_MIN_DELTA) return 0;

  if (deltaL > 0) {
    // Positive polarity: dark element on light surface
    return deltaL * CONTRAST_SCALE;
  } else {
    // Negative polarity: light element on dark surface
    // Apply polarity correction — light-on-dark requires more contrast for same readability
    return deltaL * CONTRAST_SCALE * POLARITY_FACTOR;
  }
}

// ---------------------------------------------------------------------------
// Contrast thresholds per // ---------------------------------------------------------------------------

/**
 * Minimum WCAG 2.x contrast ratio per contrast role ().
 *
 *   content       → 4.5:1 (WCAG AA for 14px/400wt body text)
 *   control       → 3.0:1 (WCAG AA for 18px+ / 700wt interactive element labels)
 *   display       → 3.0:1 (WCAG AA for titles, headers, emphasis)
 *   informational → 3.0:1 (WCAG AA for muted/metadata text and informational elements)
 *   decorative    → 1.0   (no minimum — non-text ornamental marks)
 */
export const WCAG_CONTRAST_THRESHOLDS: Record<string, number> = {
  content: 4.5,
  control: 3.0,
  display: 3.0,
  informational: 3.0,
  decorative: 1.0,
};

// ---------------------------------------------------------------------------
// validateThemeContrast
// ---------------------------------------------------------------------------

/**
 * Validate all element/surface pairings for a derived theme.
 *
 * Converts each resolved OKLCH color to hex via `oklchToHex()`, then checks
 * WCAG 2.x contrast ratio (informational) and perceptual contrast
 * (normative) for each entry in the pairing map.
 *
 * Pairs where either the element or surface token is absent from `resolved` (e.g.,
 * non-chromatic tokens like shadows, disabled-opacity) are skipped [D09].
 *
 * @param resolved - OKLCH map from `deriveTheme()` output [D09]
 * @param pairingMap - Authoritative element/surface pairing list (typically ELEMENT_SURFACE_PAIRING_MAP)
 * @returns Array of ContrastResult entries for all evaluated pairs
 */
export function validateThemeContrast(
  resolved: Record<string, ResolvedColor>,
  pairingMap: ElementSurfacePairing[],
): ContrastResult[] {
  const results: ContrastResult[] = [];

  for (const pairing of pairingMap) {
    const fgColor = resolved[pairing.element];
    const bgColor = resolved[pairing.surface];

    // Skip pairs where either token is not in the resolved map
    if (!fgColor || !bgColor) continue;

    let fgHex: string;
    let bgHex: string;

    if (pairing.parentSurface) {
      // Alpha-composite resolution (): when parentSurface is specified,
      // composite any semi-transparent side over the parent before measuring contrast.
      const parentColor = resolved[pairing.parentSurface];
      if (!parentColor) {
        // parentSurface not in resolved map — skip (same policy as missing element/surface)
        continue;
      }

      fgHex =
        (fgColor.alpha ?? 1.0) < 1.0
          ? compositeOverSurface(fgColor, parentColor)
          : oklchToHex(fgColor.L, fgColor.C, fgColor.h);

      bgHex =
        (bgColor.alpha ?? 1.0) < 1.0
          ? compositeOverSurface(bgColor, parentColor)
          : oklchToHex(bgColor.L, bgColor.C, bgColor.h);
    } else {
      fgHex = oklchToHex(fgColor.L, fgColor.C, fgColor.h);
      bgHex = oklchToHex(bgColor.L, bgColor.C, bgColor.h);
    }

    const wcagRatio = computeWcagContrast(fgHex, bgHex);
    const contrast = computePerceptualContrast(fgHex, bgHex);

    const contrastThreshold = CONTRAST_THRESHOLDS[pairing.role] ?? 15;
    const contrastPass = Math.abs(contrast) >= contrastThreshold;

    results.push({
      fg: pairing.element,
      bg: pairing.surface,
      wcagRatio,
      contrast,
      contrastPass,
      role: pairing.role,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// CVD types
// ---------------------------------------------------------------------------

/** Color vision deficiency simulation type. */
export type CVDType = "protanopia" | "deuteranopia" | "tritanopia" | "achromatopsia";

// ---------------------------------------------------------------------------
// CVD simulation — Machado et al. 2009 matrices ()
// ---------------------------------------------------------------------------

/**
 * A 3×3 matrix stored in row-major order: [row0, row1, row2]
 * where each row is [col0, col1, col2].
 */
type Matrix3x3 = [
  [number, number, number],
  [number, number, number],
  [number, number, number],
];

/**
 * CVD simulation matrices at severity=1.0 from Machado et al. 2009.
 *
 * Applied in linear sRGB space. Each matrix maps [R, G, B] input to a
 * simulated [R', G', B'] that approximates how a person with the given
 * deficiency would perceive the colour.
 *
 * Source: in the plan / Machado, Oliveira & Fernandes (2009)
 * "A Physiologically-based Model for Simulation of Color Vision Deficiency".
 */
export const CVD_MATRICES: Record<CVDType, Matrix3x3> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.011820, 0.042940, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.303900],
  ],
  achromatopsia: [
    [0.2126, 0.7152, 0.0722],
    [0.2126, 0.7152, 0.0722],
    [0.2126, 0.7152, 0.0722],
  ],
};

/**
 * Apply a 3×3 matrix to a linear-sRGB triplet.
 */
function applyMatrix3x3(
  m: Matrix3x3,
  rgb: { r: number; g: number; b: number },
): { r: number; g: number; b: number } {
  return {
    r: m[0][0] * rgb.r + m[0][1] * rgb.g + m[0][2] * rgb.b,
    g: m[1][0] * rgb.r + m[1][1] * rgb.g + m[1][2] * rgb.b,
    b: m[2][0] * rgb.r + m[2][1] * rgb.g + m[2][2] * rgb.b,
  };
}

/**
 * Simulate colour vision deficiency by applying a Machado et al. 2009
 * matrix to a linear-sRGB triplet.
 *
 * The `severity` parameter (0.0–1.0, default 1.0) interpolates between the
 * identity (severity=0, input unchanged) and the full deficiency matrix
 * (severity=1). Values outside [0, 1] are clamped.
 *
 * Output channels are clamped to [0, 1] after the matrix multiplication.
 *
 * @param linearRGB - Input colour in linear sRGB {r, g, b} ∈ [0, 1]
 * @param type      - CVD type from CVDType
 * @param severity  - Simulation severity, 0.0–1.0 (default 1.0)
 * @returns Simulated linear sRGB {r, g, b}, clamped to [0, 1]
 */
export function simulateCVD(
  linearRGB: { r: number; g: number; b: number },
  type: CVDType,
  severity = 1.0,
): { r: number; g: number; b: number } {
  const s = Math.max(0, Math.min(1, severity));
  const matrix = CVD_MATRICES[type];
  const transformed = applyMatrix3x3(matrix, linearRGB);

  // Interpolate between input (s=0) and full simulation (s=1)
  const r = (1 - s) * linearRGB.r + s * transformed.r;
  const g = (1 - s) * linearRGB.g + s * transformed.g;
  const b = (1 - s) * linearRGB.b + s * transformed.b;

  return {
    r: Math.max(0, Math.min(1, r)),
    g: Math.max(0, Math.min(1, g)),
    b: Math.max(0, Math.min(1, b)),
  };
}

/**
 * Simulate colour vision deficiency for an OKLCH colour.
 *
 * Primary entry point for the theme pipeline per [D09]: accepts resolved
 * OKLCH values directly from `deriveTheme().resolved`, converts to linear
 * sRGB via `oklchToLinearSRGB()`, applies the CVD matrix, and returns
 * simulated linear sRGB clamped to [0, 1].
 *
 * @param L        - OKLCH lightness
 * @param C        - OKLCH chroma
 * @param h        - OKLCH hue angle (degrees)
 * @param type     - CVD type
 * @param severity - Simulation severity, 0.0–1.0 (default 1.0)
 * @returns Simulated linear sRGB {r, g, b}, clamped to [0, 1]
 */
export function simulateCVDFromOKLCH(
  L: number,
  C: number,
  h: number,
  type: CVDType,
  severity = 1.0,
): { r: number; g: number; b: number } {
  const linearRGB = oklchToLinearSRGB(L, C, h);
  return simulateCVD(linearRGB, type, severity);
}

/**
 * Apply sRGB gamma encoding (IEC 61966-2-1) to a single linear channel.
 */
function linearToSrgbGamma(c: number): number {
  return c >= 0.0031308 ? 1.055 * Math.pow(c, 1 / 2.4) - 0.055 : 12.92 * c;
}

// ---------------------------------------------------------------------------
// Alpha compositing —
// ---------------------------------------------------------------------------

/**
 * Alpha-composite a semi-transparent token over a fully-opaque parent surface.
 *
 * Both inputs are ResolvedColor values (OKLCH). The function converts each to
 * linear sRGB via `oklchToLinearSRGB`, applies the standard alpha-over formula
 * in linear sRGB, gamma-encodes the result, and returns a #rrggbb hex string.
 *
 * The parent surface MUST be fully opaque (alpha === 1.0 or undefined). Nested
 * compositing (semi-transparent parent) is not supported and throws.
 *
 * Formula (per channel, linear sRGB):
 *   C_out = token.C * alpha + parent.C * (1 - alpha)
 *
 * @param token  - Semi-transparent token to composite
 * @param parent - Opaque parent surface to composite over
 * @returns Composited color as #rrggbb hex string
 * @throws If parent.alpha is defined and < 1.0 (nested compositing not supported)
 */
export function compositeOverSurface(token: ResolvedColor, parent: ResolvedColor): string {
  const parentAlpha = parent.alpha ?? 1.0;
  if (parentAlpha < 1.0) {
    throw new Error(
      `compositeOverSurface: parentSurface must be fully opaque (alpha=1.0), ` +
      `got alpha=${parentAlpha}. Nested compositing is not supported.`,
    );
  }

  const tokenLinear = oklchToLinearSRGB(token.L, token.C, token.h);
  const parentLinear = oklchToLinearSRGB(parent.L, parent.C, parent.h);
  const alpha = token.alpha ?? 1.0;

  const r = tokenLinear.r * alpha + parentLinear.r * (1 - alpha);
  const g = tokenLinear.g * alpha + parentLinear.g * (1 - alpha);
  const b = tokenLinear.b * alpha + parentLinear.b * (1 - alpha);

  const rOut = Math.round(Math.max(0, Math.min(1, linearToSrgbGamma(r))) * 255);
  const gOut = Math.round(Math.max(0, Math.min(1, linearToSrgbGamma(g))) * 255);
  const bOut = Math.round(Math.max(0, Math.min(1, linearToSrgbGamma(b))) * 255);

  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${toHex(rOut)}${toHex(gOut)}${toHex(bOut)}`;
}

/**
 * Simulate colour vision deficiency for a hex colour and return the result
 * as a hex string.
 *
 * Convenience wrapper for standalone use outside the theme pipeline:
 *   hex → linearise sRGB → apply CVD matrix → gamma-encode → hex
 *
 * @param hex      - Input colour as #rrggbb
 * @param type     - CVD type
 * @param severity - Simulation severity, 0.0–1.0 (default 1.0)
 * @returns Simulated colour as #rrggbb
 */
export function simulateCVDForHex(
  hex: string,
  type: CVDType,
  severity = 1.0,
): string {
  // hex → gamma-decoded linear sRGB
  const rGamma = parseInt(hex.slice(1, 3), 16) / 255;
  const gGamma = parseInt(hex.slice(3, 5), 16) / 255;
  const bGamma = parseInt(hex.slice(5, 7), 16) / 255;
  const linearRGB = {
    r: srgbChannelToLinear(rGamma),
    g: srgbChannelToLinear(gGamma),
    b: srgbChannelToLinear(bGamma),
  };

  // Apply CVD matrix
  const simLinear = simulateCVD(linearRGB, type, severity);

  // Gamma-encode and convert to hex
  const rOut = Math.round(Math.max(0, Math.min(1, linearToSrgbGamma(simLinear.r))) * 255);
  const gOut = Math.round(Math.max(0, Math.min(1, linearToSrgbGamma(simLinear.g))) * 255);
  const bOut = Math.round(Math.max(0, Math.min(1, linearToSrgbGamma(simLinear.b))) * 255);

  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${toHex(rOut)}${toHex(gOut)}${toHex(bOut)}`;
}

// ---------------------------------------------------------------------------
// CVD distinguishability check
// ---------------------------------------------------------------------------

/**
 * Minimum lightness delta (in simulated linear sRGB space) below which a
 * semantic token pair is considered indistinguishable under a given CVD type.
 *
 * Computed as |Y1 - Y2| where Y = 0.2126R + 0.7152G + 0.0722B
 * on the simulated linear-sRGB outputs.
 *
 * A delta below this threshold means the two colours appear nearly the same
 * lightness to a person with that deficiency, making them hard to distinguish
 * even if their hues differ in normal vision.
 */
const CVD_LIGHTNESS_DELTA_THRESHOLD = 0.05;

/**
 * The four CVD types enumerated for iteration.
 */
const ALL_CVD_TYPES: CVDType[] = [
  "protanopia",
  "deuteranopia",
  "tritanopia",
  "achromatopsia",
];

/**
 * Authoritative semantic token pairs to check for CVD distinguishability.
 *
 * Each pair [tokenA, tokenB] represents two colours that convey different
 * semantic meaning and must remain visually distinguishable under CVD.
 *
 * Pairs are defined as [positive/warning, positive/destructive, primary/destructive,
 * accent/atmosphere] following the plan spec.
 */
export const CVD_SEMANTIC_PAIRS: [string, string][] = [
  // Status roles: success (green-family) vs caution (yellow-family)
  ["--tug7-element-tone-fill-normal-success-rest", "--tug7-element-tone-fill-normal-caution-rest"],
  // Status roles: success (green) vs danger/destructive (red-family)
  ["--tug7-element-tone-fill-normal-success-rest", "--tug7-element-tone-fill-normal-danger-rest"],
  // Primary action vs destructive action (button colours)
  ["--tug7-element-global-fill-normal-accent-rest", "--tug7-element-tone-fill-normal-danger-rest"],
  // Accent vs atmosphere (theme identity colours)
  ["--tug7-element-global-fill-normal-accent-rest", "--tug7-surface-global-primary-normal-canvas-rest"],
];

/**
 * Check whether semantic token pairs remain distinguishable under each CVD type.
 *
 * Consumes the resolved OKLCH map from `deriveTheme()` per [D09].
 * For each CVD type, simulates both tokens in a pair via `simulateCVDFromOKLCH`
 * and measures the luminance delta of the simulated outputs.
 *
 * A warning is emitted if the luminance delta drops below
 * `CVD_LIGHTNESS_DELTA_THRESHOLD` (0.05), indicating the pair becomes
 * difficult to distinguish.
 *
 * Pairs where either token is absent from the resolved map are silently skipped.
 *
 * @param resolved      - OKLCH map from `deriveTheme()` output [D09]
 * @param semanticPairs - Array of [tokenA, tokenB] pairs to evaluate
 * @returns Array of CVDWarning entries for indistinguishable pairs
 */
export function checkCVDDistinguishability(
  resolved: Record<string, ResolvedColor>,
  semanticPairs: [string, string][],
): CVDWarning[] {
  const warnings: CVDWarning[] = [];

  for (const cvdType of ALL_CVD_TYPES) {
    for (const [tokenA, tokenB] of semanticPairs) {
      const colorA = resolved[tokenA];
      const colorB = resolved[tokenB];

      // Skip pairs where either token is absent (non-chromatic / structural)
      if (!colorA || !colorB) continue;

      // Simulate both colours under the current CVD type
      const simA = simulateCVDFromOKLCH(colorA.L, colorA.C, colorA.h, cvdType);
      const simB = simulateCVDFromOKLCH(colorB.L, colorB.C, colorB.h, cvdType);

      // Compute luminance of each simulated colour (WCAG relative luminance formula)
      const lumA = 0.2126 * simA.r + 0.7152 * simA.g + 0.0722 * simA.b;
      const lumB = 0.2126 * simB.r + 0.7152 * simB.g + 0.0722 * simB.b;
      const delta = Math.abs(lumA - lumB);

      if (delta < CVD_LIGHTNESS_DELTA_THRESHOLD) {
        warnings.push({
          type: cvdType,
          tokenPair: [tokenA, tokenB],
          description:
            `Under ${cvdType}, "${tokenA}" and "${tokenB}" have a simulated ` +
            `luminance delta of ${delta.toFixed(4)}, below the threshold of ` +
            `${CVD_LIGHTNESS_DELTA_THRESHOLD}. They may appear indistinguishable.`,
          suggestion:
            `Increase lightness separation between the two tokens, or choose ` +
            `hues that remain distinguishable under ${cvdType} simulation.`,
        });
      }
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Utility: oklchToHex re-export for consumers of this module
// ---------------------------------------------------------------------------

export { oklchToHex } from "./tugcolor";

// ---------------------------------------------------------------------------
// Perceptual contrast thresholds (normative) and WCAG ratio thresholds (informational)
// ---------------------------------------------------------------------------

/**
 * Minimum perceptual contrast magnitude per role — normative gate [D06].
 *
 * Semantic text type thresholds ():
 *   content       → 75  (primary prose text — body, descriptions, paragraphs)
 *   control       → 60  (interactive element labels, icons, borders, focus indicators)
 *   display       → 60  (titles, headers, card titles, emphasis text)
 *   informational → 60  (muted/metadata/secondary text and informational elements)
 *   decorative    → 15  (non-text ornamental marks, structural dividers)
 */
export const CONTRAST_THRESHOLDS: Record<string, number> = {
  content: 75,
  control: 60,
  display: 60,
  informational: 60,
  decorative: 15,
};

/**
 * Near-pass band for marginal badge classification (fixed 5 units, per).
 * A result with magnitude >= (CONTRAST_THRESHOLDS[role] - CONTRAST_MARGINAL_DELTA) is classified as
 * "marginal" rather than "fail".
 */
export const CONTRAST_MARGINAL_DELTA = 5;
