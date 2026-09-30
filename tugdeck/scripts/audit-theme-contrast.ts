#!/usr/bin/env bun
/**
 * audit-theme-contrast.ts — per-theme WCAG / perceptual contrast audit.
 *
 * For each theme in styles/themes/*.css, resolve every token referenced by the
 * authoritative pairing map (ELEMENT_SURFACE_PAIRING_MAP) to a concrete OKLCH
 * color, then run the same contrast + CVD checks the in-app Theme Accessibility
 * card runs at runtime — but headlessly, in Bun, with no browser.
 *
 * Resolution reuses the build pipeline's exact math: the theme CSS is parsed for
 * token definitions, --tugx-* aliases are pulled from the component CSS, var()
 * chains are followed to a terminal --tug-color(...) recipe, and that recipe is
 * expanded via resolveTugColorToOklch() — the single source of truth shared with
 * postcss-tug-color. Build output and audit can therefore never drift.
 *
 * Usage:
 *   bun run scripts/audit-theme-contrast.ts            # audit every theme
 *   bun run scripts/audit-theme-contrast.ts ironclad   # audit one theme
 *   bun run scripts/audit-theme-contrast.ts --quiet    # failures only
 *
 * Exit code: 0 if every theme's non-decorative pairings pass; 1 otherwise.
 */

import fs from "fs";
import path from "path";
import {
  HUE_FAMILIES,
  NAMED_GRAYS,
  ADJACENCY_RING,
  resolveTugColorToOklch,
} from "../src/components/tugways/tugcolor";
import {
  parseTugColor,
  findTugColorCalls,
} from "../src/components/tugways/tugcolor";
import {
  validateThemeContrast,
  checkCVDDistinguishability,
  CVD_SEMANTIC_PAIRS,
  WCAG_CONTRAST_THRESHOLDS,
  type ResolvedColor,
} from "../src/components/tugways/theme-accessibility";
import { ELEMENT_SURFACE_PAIRING_MAP } from "../src/components/tugways/theme-pairings";
import { BASE_THEME_NAME } from "../src/theme-constants";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const TUGDECK = path.resolve(import.meta.dir, "..");
const THEMES_DIR = path.join(TUGDECK, "styles/themes");
const STYLES_DIR = path.join(TUGDECK, "styles");
const TUGWAYS_DIR = path.join(TUGDECK, "src/components/tugways");

// ---------------------------------------------------------------------------
// --tug-color() parse context (mirrors postcss-tug-color's KNOWN_HUES)
// ---------------------------------------------------------------------------

export const KNOWN_HUES: ReadonlySet<string> = new Set([
  ...Object.keys(HUE_FAMILIES),
  "black",
  "white",
  "gray",
  ...NAMED_GRAYS,
  "transparent",
]);

// ---------------------------------------------------------------------------
// CSS token-definition extraction
// ---------------------------------------------------------------------------

/** Recursively collect .css files under a directory. */
function collectCss(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collectCss(full));
    else if (e.isFile() && e.name.endsWith(".css")) out.push(full);
  }
  return out;
}

/**
 * Extract custom-property definitions (`--name: value;`) from a CSS file.
 * Later definitions win, so callers should layer theme tokens over alias files.
 */
function extractDefs(css: string, into: Map<string, string>): void {
  // Strip comments so commented-out declarations are ignored.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /(--(?:tug7|tugc|tugx|tug)-[\w-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    into.set(m[1], m[2].trim());
  }
}

/**
 * Build the combined token-definition map for one theme: component-CSS aliases
 * (theme-independent --tugx-* and other defs) layered under the theme's own
 * token definitions.
 */
export function buildDefs(themeFile: string): Map<string, string> {
  const defs = new Map<string, string>();
  // Component + chrome CSS first (provides --tugx-* aliases and shared utilities).
  const componentCss = [
    ...collectCss(TUGWAYS_DIR),
    ...collectCss(STYLES_DIR).filter((f) => !f.startsWith(THEMES_DIR)),
  ];
  for (const f of componentCss) extractDefs(fs.readFileSync(f, "utf-8"), defs);
  // Theme tokens last so they take precedence for --tug7/--tugc tokens.
  extractDefs(fs.readFileSync(themeFile, "utf-8"), defs);
  return defs;
}

// ---------------------------------------------------------------------------
// Token → ResolvedColor resolution
// ---------------------------------------------------------------------------

/** Resolve a single --tug-color(...) recipe string to a ResolvedColor, or null. */
export function resolveRecipe(value: string): ResolvedColor | null {
  const calls = findTugColorCalls(value);
  if (calls.length === 0) return null;
  const parsed = parseTugColor(calls[0].inner, KNOWN_HUES, ADJACENCY_RING);
  if (!parsed.ok) return null;
  const { color, lightness, chroma, alpha } = parsed.value;
  const { L, C, h, alpha: a } = resolveTugColorToOklch(
    color.name,
    color.adjacentName,
    lightness,
    chroma,
    alpha,
  );
  return { L, C, h, alpha: a };
}

/**
 * Resolve a token name to a ResolvedColor by following var() chains through the
 * definition map until reaching a --tug-color(...) recipe. Returns null for
 * transparent tokens, undefined tokens, or unresolvable literals — matching the
 * runtime policy where such tokens are absent from the resolved map (and thus
 * skipped by validateThemeContrast).
 */
export function resolveToken(
  name: string,
  defs: Map<string, string>,
  seen: Set<string> = new Set(),
): ResolvedColor | null {
  if (seen.has(name)) return null;
  seen.add(name);

  const value = defs.get(name);
  if (value === undefined) return null;

  if (value === "transparent") return null;

  if (value.includes("--tug-color(")) return resolveRecipe(value);

  const varMatch = value.match(/var\(\s*(--(?:tug7|tugc|tugx|tug)-[\w-]+)/);
  if (varMatch) return resolveToken(varMatch[1], defs, seen);

  // Literal oklch()/hex/keyword we don't need for pairing contrast.
  return null;
}

// ---------------------------------------------------------------------------
// Audit one theme
// ---------------------------------------------------------------------------

export interface ThemeReport {
  theme: string;
  evaluated: number;
  /** Normative WCAG failures (gate). */
  failures: { fg: string; bg: string; role: string; wcag: number; contrast: number }[];
  /** Informational perceptual-only shortfalls (pass WCAG, miss perceptual target). */
  perceptualOnly: number;
  cvdWarnings: number;
}

export function auditTheme(themeFile: string): ThemeReport {
  const theme = path.basename(themeFile, ".css");
  const defs = buildDefs(themeFile);

  // Resolve every token referenced by the pairing map (+ CVD pairs).
  const needed = new Set<string>();
  for (const p of ELEMENT_SURFACE_PAIRING_MAP) {
    needed.add(p.element);
    needed.add(p.surface);
    if (p.parentSurface) needed.add(p.parentSurface);
  }
  for (const [a, b] of CVD_SEMANTIC_PAIRS) {
    needed.add(a);
    needed.add(b);
  }

  const resolved: Record<string, ResolvedColor> = {};
  for (const name of needed) {
    const color = resolveToken(name, defs);
    if (color) resolved[name] = color;
  }

  const results = validateThemeContrast(resolved, ELEMENT_SURFACE_PAIRING_MAP);

  // Normative gate: WCAG 2.x per role [D07]. Perceptual contrast is informational.
  const wcagFail = (r: (typeof results)[number]) =>
    r.wcagRatio < (WCAG_CONTRAST_THRESHOLDS[r.role] ?? 1.0);

  const failures = results
    .filter(wcagFail)
    .map((r) => ({
      fg: r.fg,
      bg: r.bg,
      role: r.role,
      wcag: r.wcagRatio,
      contrast: r.contrast,
    }));

  // Informational: passes WCAG but misses the (stricter) perceptual target.
  const perceptualOnly = results.filter(
    (r) => !wcagFail(r) && !r.contrastPass && r.role !== "decorative",
  ).length;

  const cvd = checkCVDDistinguishability(resolved, CVD_SEMANTIC_PAIRS);

  return { theme, evaluated: results.length, failures, perceptualOnly, cvdWarnings: cvd.length };
}

// ---------------------------------------------------------------------------
// Main — CLI only. Guarded so the audit engine above (auditTheme, buildDefs,
// resolveToken, …) can be imported by the deriver's correction pass without
// running the CLI or calling process.exit.
// ---------------------------------------------------------------------------

if (import.meta.main) {
const args = process.argv.slice(2);
const showList = args.includes("--list");
const themeArg = args.find((a) => !a.startsWith("--"));

const allFiles = collectCss(THEMES_DIR)
  .filter((f) => f.endsWith(".css"))
  .sort();

const referenceFile = allFiles.find((f) => path.basename(f, ".css") === BASE_THEME_NAME);
if (!referenceFile) {
  console.error(`Reference theme "${BASE_THEME_NAME}" not found in ${THEMES_DIR}`);
  process.exit(1);
}

// The reference theme (ironclad) sets the accessibility bar: its WCAG-failure count is
// the status-quo budget. No other theme may ship with MORE failures than the
// reference. The reference is graded against itself (always passes its own gate);
// the in-app Theme Accessibility card surfaces its individual findings for tuning.
const referenceReport = auditTheme(referenceFile);
const budget = referenceReport.failures.length;

let targets = allFiles;
if (themeArg) {
  targets = allFiles.filter((f) => path.basename(f, ".css") === themeArg);
  if (targets.length === 0) {
    console.error(`No theme named "${themeArg}" in ${THEMES_DIR}`);
    process.exit(1);
  }
}

// A single explicit theme arg implies the detailed failure list.
const listFailures = showList || Boolean(themeArg);

console.log(
  `Reference: ${BASE_THEME_NAME} — ${budget} WCAG failure(s) (the budget no theme may exceed).`,
);

let regressed = false;

for (const file of targets) {
  const report =
    file === referenceFile ? referenceReport : auditTheme(file);
  const isReference = report.theme === BASE_THEME_NAME;
  const delta = report.failures.length - budget;
  const exceeds = !isReference && report.failures.length > budget;
  if (exceeds) regressed = true;

  const status = isReference ? "•" : exceeds ? "✗" : "✓";
  const deltaStr = isReference
    ? "reference"
    : `${delta >= 0 ? "+" : ""}${delta} vs reference`;
  console.log(
    `\n${status} ${report.theme} — ${report.evaluated} pairings, ` +
      `${report.failures.length} WCAG failure(s) (${deltaStr}), ` +
      `${report.perceptualOnly} perceptual-only, ${report.cvdWarnings} CVD warning(s)`,
  );

  if (listFailures && report.failures.length > 0) {
    for (const f of report.failures) {
      console.log(
        `    ${f.role.padEnd(13)} WCAG ${f.wcag.toFixed(2).padStart(5)}  ` +
          `perceptual ${f.contrast.toFixed(0).padStart(4)}`,
      );
      console.log(`      fg ${f.fg}`);
      console.log(`      bg ${f.bg}`);
    }
  }
}

if (regressed) {
  console.log(
    `\n✗ Contrast audit failed — a theme exceeds the ${BASE_THEME_NAME} accessibility budget (${budget}).`,
  );
  process.exit(1);
}
console.log(`\n✓ No theme exceeds the ${BASE_THEME_NAME} accessibility budget.`);
}
