#!/usr/bin/env bun
/**
 * audit-tokens.ts — Mechanical token audit tooling for the tugways design system.
 *
 * Subcommands:
 *   tokens      Extract all --tug-* tokens from styles/themes/ironclad.css and
 *               classify each as element / surface / non-color.
 *   pairings    Parse all component CSS files and extract every
 *               foreground-on-background pairing (color/fill on background-color).
 *   rename      Bulk-rename tokens across all auto-discovered files (dry-run by default).
 *               Flags: --apply, --map <path>, --verify, --stats
 *   rename-map  Generate the complete old->new rename map for all 373 tokens.
 *               Flags: --json (machine-readable JSON vs. human-readable report)
 *   inject      Generate and insert @tug-pairings comment blocks into CSS files.
 *   verify      Cross-check @tug-pairings blocks against theme-pairings.ts.
 *   lint        Hard-fail on annotation completeness, alias chain depth,
 *               missing @tug-pairings blocks, and unresolved pairings.
 *
 * Usage:
 *   bun run scripts/audit-tokens.ts tokens
 *   bun run scripts/audit-tokens.ts pairings
 *   bun run scripts/audit-tokens.ts rename [--apply] [--map <path>] [--verify] [--stats]
 *   bun run scripts/audit-tokens.ts rename-map [--json]
 *   bun run scripts/audit-tokens.ts inject [--apply]
 *   bun run scripts/audit-tokens.ts verify
 *   bun run scripts/audit-tokens.ts lint
 */

import fs from "fs";
import path from "path";
import { SEED_RENAME_MAP } from "./seed-rename-map";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const TUGDECK = path.resolve(import.meta.dir, "..");
const GENERATED_CSS = path.join(TUGDECK, "styles/themes/ironclad.css");
const TUGWAYS = path.join(TUGDECK, "src/components/tugways");
const PAIRING_MAP_PATH = path.join(TUGWAYS, "theme-pairings.ts");

/** Component CSS files in scope for the contrast audit. */
const COMPONENT_CSS_FILES = [
  "internal/tug-button.css",
  "tug-pane.css",
  "tug-tab-bar.css",
  "tug-menu.css",
  "tug-dialog.css",
  "tug-badge.css",
  "tug-switch.css",
  "tug-checkbox.css",
  "tug-text-editor.css",
  "tug-input.css",
  "tug-label.css",
  "tug-marquee.css",
  "tug-data.css",
  "tug-code.css",
  "tug-dock.css",
  "tug-skeleton.css",
  "tug-sheet.css",
  "cards/gallery-popup-button.css",
  "cards/gallery-theme-accessibility.css",
].map((f) => path.join(TUGWAYS, f));

// ---------------------------------------------------------------------------
// Token classification (from the plan)
// ---------------------------------------------------------------------------

type TokenClass = "element" | "surface" | "non-color";

/** Non-color pattern segments — tokens containing these are excluded from color classification. */
const NON_COLOR_PATTERNS = [
  "size-",
  "radius-",
  "space-",
  "font-",
  "motion-",
  "chrome-height",
  "opacity",
  "easing",
  "duration",
  "line-height",
];

function classifyToken(shortName: string): TokenClass {
  // Phase 1: exclude non-color tokens
  for (const pattern of NON_COLOR_PATTERNS) {
    if (shortName.includes(pattern)) return "non-color";
  }

  // Phase 2: classify color tokens by seven-slot naming convention prefix.
  // All color tokens now follow <plane>-<component>-<constituent>-<emphasis>-<role>-<state>
  // where plane is always "element" or "surface".

  if (shortName.startsWith("element-")) return "element";
  if (shortName.startsWith("surface-")) return "surface";

  return "unclassified" as TokenClass;
}

// ---------------------------------------------------------------------------
// Subcommand: tokens
// ---------------------------------------------------------------------------

interface TokenEntry {
  /** Full CSS custom property name, e.g., --tug-fg-default */
  fullName: string;
  /** Short name after --tug- prefix, e.g., fg-default */
  shortName: string;
  /** The raw CSS value */
  value: string;
  /** Classification */
  classification: TokenClass;
}

function extractTokens(): TokenEntry[] {
  const css = fs.readFileSync(GENERATED_CSS, "utf-8");
  const tokens: TokenEntry[] = [];
  const re = /^\s*(--(?:tug7|tugc|tugx|tug)-[\w-]+)\s*:\s*(.+?)\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const fullName = m[1];
    const shortName = stripTugPrefix(fullName);
    tokens.push({
      fullName,
      shortName,
      value: m[2],
      classification: classifyToken(shortName),
    });
  }
  return tokens;
}

function cmdTokens(): void {
  const tokens = extractTokens();
  const byClass = new Map<string, TokenEntry[]>();
  for (const t of tokens) {
    const list = byClass.get(t.classification) ?? [];
    list.push(t);
    byClass.set(t.classification, list);
  }

  console.log(`\n=== Token Inventory ===`);
  console.log(`Total tokens: ${tokens.length}\n`);

  for (const cls of ["surface", "element", "non-color", "unclassified"]) {
    const list = byClass.get(cls) ?? [];
    if (list.length === 0) continue;
    console.log(`--- ${cls.toUpperCase()} (${list.length}) ---`);
    for (const t of list) {
      console.log(`  ${t.shortName}`);
    }
    console.log();
  }

  const unclassified = byClass.get("unclassified" as string) ?? [];
  if (unclassified.length > 0) {
    console.log(`\n⚠ ${unclassified.length} UNCLASSIFIED color tokens:`);
    for (const t of unclassified) {
      console.log(`  ${t.fullName}: ${t.value}`);
    }
  } else {
    console.log(`✓ All color tokens classified (zero unclassified)`);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: pairings
// ---------------------------------------------------------------------------

interface AliasMap {
  /** Maps component alias (e.g., --tugx-pane-bg) → resolved --tug7|tugc|tug name */
  [alias: string]: string;
}

interface CssPairing {
  /** Source CSS file (basename) */
  file: string;
  /** CSS selector where this pairing occurs */
  selector: string;
  /** The element (foreground) token as used in the CSS */
  elementRaw: string;
  /** The surface (background) token as used in the CSS */
  surfaceRaw: string;
  /** Resolved element --tug-* token (or raw if not resolvable) */
  elementResolved: string;
  /** Resolved surface --tug-* token (or raw if not resolvable) */
  surfaceResolved: string;
  /** CSS property for the element (color, fill, border-color) */
  elementProperty: string;
}

/**
 * Parse body {} blocks in a CSS file to extract component alias → token mappings.
 * Handles both direct base refs and alias-to-alias chains:
 *   --tugx-pane-bg: var(--tug7-surface-global-primary-normal-overlay-rest);  (direct)
 *   --tugx-pane-title-bar-bg-inactive: var(--tug7-surface-card-primary-normal-titlebar-inactive);  (alias chain)
 */
function extractAliases(css: string): AliasMap {
  const aliases: AliasMap = {};
  const bodyBlocks = extractBodyBlocks(css);
  for (const block of bodyBlocks) {
    // Match any var() reference, not just --tug-*
    const re = /^\s*(--(?:tug7|tugc|tugx|tug)-[\w-]+)\s*:\s*var\((--(?:tug7|tugc|tugx|tug)-[\w-]+)\)\s*;/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      aliases[m[1]] = m[2];
    }
  }
  return aliases;
}

/** Extract the content of all body {} blocks from CSS text. */
function extractBodyBlocks(css: string): string[] {
  const blocks: string[] = [];
  // Match only standalone body {} selectors — not class names ending in "body"
  // (e.g., .gta-preview-body). The body selector must be preceded by whitespace or
  // start-of-string, not by a word character or hyphen.
  const bodyRe = /(?:^|\s)body\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = bodyRe.exec(css)) !== null) {
    let depth = 1;
    // m[0] ends with `{` — start the block content just after that brace
    const bracePos = m.index + m[0].lastIndexOf("{");
    let i = bracePos + 1;
    const start = i;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    blocks.push(css.slice(start, i - 1));
  }
  return blocks;
}

/**
 * Returns true if a token name is a "base" token (tug7, tugc, or plain tug scale)
 * that should NOT be followed further through alias chains.
 * --tugx- extension aliases are NOT base tokens and should be followed.
 */
function isBaseTugToken(name: string): boolean {
  return (
    name.startsWith("--tug7-") ||
    name.startsWith("--tugc-") ||
    (name.startsWith("--tug-") && !name.startsWith("--tugx-"))
  );
}

/** Resolve a token reference through the alias map, following multi-hop chains. */
function resolveToken(token: string, aliases: AliasMap): string {
  const visited = new Set<string>();
  let current = token;
  while (!isBaseTugToken(current) && !visited.has(current)) {
    visited.add(current);
    const next = aliases[current];
    if (!next) break;
    current = next;
  }
  return current;
}

/**
 * Extract var(--tug-*) references from a CSS value string.
 * Returns the first --tug-* token found.
 */
function extractVarRef(value: string): string | null {
  const m = value.match(/var\((--(?:tug7|tugc|tugx|tug)-[\w-]+)/);
  return m ? m[1] : null;
}

/** Properties that carry foreground (element) color. */
const ELEMENT_PROPERTIES = new Set([
  "color",
  "fill",
  "border-color",
  "-webkit-text-fill-color",
  // Border shorthand (border: 1px solid var(--tug-*))
  "border",
  // Directional border shorthands
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  // Directional border-color longhands
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
]);

/** Properties that carry background (surface) color. */
const SURFACE_PROPERTIES = new Set(["background-color", "background"]);


interface CssRule {
  selector: string;
  properties: Map<string, string>; // property → raw value
}

/**
 * Lightweight CSS rule parser.
 * Extracts selector + properties for every rule block (excluding body {} alias blocks
 * and @keyframes). Does NOT handle nested selectors or @media — these component files
 * are flat.
 */
function parseRules(css: string): CssRule[] {
  const rules: CssRule[] = [];

  // Remove comments
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

  // Remove body {} blocks (alias declarations).
  // Use (?<![.#\w-]) to avoid matching class names that end in "body" (e.g., .gta-preview-body).
  // The body selector must be at the start of a line or preceded only by whitespace.
  const noBody = stripped.replace(/(?:^|\n)\s*body\s*\{[^}]*\}/gm, "");

  // Remove @keyframes blocks
  const noKeyframes = noBody.replace(/@keyframes\s+[\w-]+\s*\{[^}]*(?:\{[^}]*\}[^}]*)*\}/g, "");

  // Parse remaining rules
  const ruleRe = /([^{}]+?)\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(noKeyframes)) !== null) {
    // Normalize selector: trim and collapse internal whitespace (newlines, tabs,
    // multiple spaces) to single spaces so selectors match annotation-parsed keys.
    const selector = m[1].trim().replace(/\s+/g, " ");
    // Skip @-rules
    if (selector.startsWith("@")) continue;

    const propBlock = m[2];
    const properties = new Map<string, string>();
    const propRe = /([\w-]+)\s*:\s*([^;]+);/g;
    let pm: RegExpExecArray | null;
    while ((pm = propRe.exec(propBlock)) !== null) {
      properties.set(pm[1], pm[2].trim());
    }
    rules.push({ selector, properties });
  }
  return rules;
}

/**
 * Parse @tug-renders-on annotations from raw CSS text (before comment stripping).
 *
 * Annotation format ():
 *   /* @tug-renders-on: --tug-surface-default *\/
 *   .selector { ... }
 *
 * Multi-surface variant:
 *   /* @tug-renders-on: --tug-tab-bg-active, --tug-tab-bg-inactive *\/
 *
 * Rules:
 * - The annotation comment must be immediately followed by whitespace-only lines
 *   and then the CSS rule selector (no intervening comments allowed).
 * - Selectors are normalized (trimmed, internal whitespace collapsed to single space)
 *   to match the output of parseRules.
 *
 * Returns a Map<normalizedSelector, string[]> of surface token arrays.
 */
function parseRendersOnAnnotations(css: string): Map<string, string[]> {
  const result = new Map<string, string[]>();

  // Match each @tug-renders-on comment and capture the surface list
  const annotationRe = /\/\*\s*@tug-renders-on:\s*([^*]+?)\s*\*\//g;
  let m: RegExpExecArray | null;

  while ((m = annotationRe.exec(css)) !== null) {
    const annotationEnd = m.index + m[0].length;
    // Parse comma-separated surface tokens from the annotation value
    const surfaces = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("--tug7-") || s.startsWith("--tugc-") || s.startsWith("--tugx-") || s.startsWith("--tug-"));

    if (surfaces.length === 0) continue;

    // Scan forward past whitespace-only content to find the next selector + {
    // If we encounter another comment (/*) before a selector, skip this annotation.
    const remaining = css.slice(annotationEnd);

    // Find the next { to identify the rule's selector
    const braceIdx = remaining.indexOf("{");
    if (braceIdx === -1) continue;

    const between = remaining.slice(0, braceIdx);

    // If there's another comment between the annotation and the brace, skip
    if (between.includes("/*")) {
      console.warn(`@tug-renders-on at offset ${m.index}: intervening comment before selector — skipping`);
      continue;
    }

    // Extract the selector: trim the text before the brace, normalize whitespace
    const rawSelector = between.trim().replace(/\s+/g, " ");
    if (!rawSelector) continue;

    result.set(rawSelector, surfaces);
  }

  return result;
}

/**
 * Determine the "rendering context" surface for a given selector.
 *
 * Two-strategy approach (heuristics 2-4 replaced by @tug-renders-on annotations):
 * 1. Same-rule match: if the rule itself sets background-color, use that.
 * 2. Annotation lookup: check the @tug-renders-on annotation map for this selector.
 *    Returns the first listed surface (primary surface). Multi-surface annotations
 *    produce multiple pairings at the call sites.
 *
 * Returns null if neither strategy resolves the surface.
 */
function findSurfaceForSelector(
  selector: string,
  rules: CssRule[],
  annotationMap: Map<string, string[]>,
): { surfaceToken: string; surfaceSelector: string } | null {
  // Strategy 1: Same rule sets background-color
  for (const rule of rules) {
    if (rule.selector === selector) {
      for (const prop of SURFACE_PROPERTIES) {
        const val = rule.properties.get(prop);
        if (val) {
          const token = extractVarRef(val);
          if (token) return { surfaceToken: token, surfaceSelector: selector };
        }
      }
    }
  }

  // Strategy 2: @tug-renders-on annotation lookup
  const annotatedSurfaces = annotationMap.get(selector);
  if (annotatedSurfaces && annotatedSurfaces.length > 0) {
    return { surfaceToken: annotatedSurfaces[0], surfaceSelector: selector };
  }

  return null;
}

/**
 * Like findSurfaceForSelector but returns ALL surfaces (for multi-surface annotations).
 * Strategy 1 (same-rule bg) returns a single-element array.
 * Strategy 2 (annotation) returns all listed surfaces.
 */
function findAllSurfacesForSelector(
  selector: string,
  rules: CssRule[],
  annotationMap: Map<string, string[]>,
): { surfaceToken: string; surfaceSelector: string }[] {
  // Strategy 1: Same rule sets background-color
  for (const rule of rules) {
    if (rule.selector === selector) {
      for (const prop of SURFACE_PROPERTIES) {
        const val = rule.properties.get(prop);
        if (val) {
          const token = extractVarRef(val);
          if (token) return [{ surfaceToken: token, surfaceSelector: selector }];
        }
      }
    }
  }

  // Strategy 2: @tug-renders-on annotation lookup (all surfaces)
  const annotatedSurfaces = annotationMap.get(selector);
  if (annotatedSurfaces && annotatedSurfaces.length > 0) {
    return annotatedSurfaces.map((s) => ({ surfaceToken: s, surfaceSelector: selector }));
  }

  return [];
}

/** Build a global alias map from all component CSS files. */
function buildGlobalAliases(): AliasMap {
  const aliases: AliasMap = {};
  for (const file of COMPONENT_CSS_FILES) {
    if (!fs.existsSync(file)) continue;
    const css = fs.readFileSync(file, "utf-8");
    Object.assign(aliases, extractAliases(css));
  }
  return aliases;
}

function cmdPairings(): void {
  const allPairings: CssPairing[] = [];
  // Build a global alias map from ALL files first (handles cross-file alias chains)
  const globalAliases = buildGlobalAliases();

  for (const file of COMPONENT_CSS_FILES) {
    if (!fs.existsSync(file)) {
      console.warn(`⚠ File not found: ${file}`);
      continue;
    }
    const css = fs.readFileSync(file, "utf-8");
    const basename = path.relative(TUGWAYS, file);

    // Parse rules and annotations
    const rules = parseRules(css);
    const annotationMap = parseRendersOnAnnotations(css);

    // For each rule, find element properties and pair with surface
    for (const rule of rules) {
      for (const [prop, val] of rule.properties) {
        if (!ELEMENT_PROPERTIES.has(prop)) continue;
        const elementToken = extractVarRef(val);
        if (!elementToken) continue;

        // Find all surfaces this element renders on (handles multi-surface annotations)
        const surfaces = findAllSurfacesForSelector(rule.selector, rules, annotationMap);
        if (surfaces.length === 0) {
          allPairings.push({
            file: basename,
            selector: rule.selector,
            elementRaw: elementToken,
            surfaceRaw: "(inherited — needs manual check)",
            elementResolved: resolveToken(elementToken, globalAliases),
            surfaceResolved: "(unknown)",
            elementProperty: prop,
          });
          continue;
        }

        for (const surface of surfaces) {
          allPairings.push({
            file: basename,
            selector: rule.selector,
            elementRaw: elementToken,
            surfaceRaw: surface.surfaceToken,
            elementResolved: resolveToken(elementToken, globalAliases),
            surfaceResolved: resolveToken(surface.surfaceToken, globalAliases),
            elementProperty: prop,
          });
        }
      }
    }
  }

  // Deduplicate by resolved element + surface pair
  const seen = new Set<string>();
  const deduped: CssPairing[] = [];
  for (const p of allPairings) {
    const key = `${p.elementResolved}||${p.surfaceResolved}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(p);
    }
  }

  // Output
  console.log(`\n=== Pairing Audit ===`);
  console.log(`Total raw pairings found: ${allPairings.length}`);
  console.log(`Unique resolved pairings: ${deduped.length}\n`);

  // Group by file
  const byFile = new Map<string, CssPairing[]>();
  for (const p of allPairings) {
    const list = byFile.get(p.file) ?? [];
    list.push(p);
    byFile.set(p.file, list);
  }

  for (const [file, pairings] of byFile) {
    console.log(`--- ${file} (${pairings.length} pairings) ---`);
    for (const p of pairings) {
      const resolvedEl = stripTugPrefix(p.elementResolved);
      const resolvedSf = stripTugPrefix(p.surfaceResolved);
      console.log(
        `  ${p.elementProperty.padEnd(16)} ${resolvedEl.padEnd(45)} on  ${resolvedSf}`,
      );
      if (p.selector) {
        console.log(`    ${"".padEnd(16)} selector: ${p.selector}`);
      }
    }
    console.log();
  }

  // Compare against existing pairing map
  const mapPairings = loadPairingMap();
  if (mapPairings) {
    const mapKeys = new Set(
      mapPairings.map((p) => `${p.element}||${p.surface}`),
    );
    const cssKeys = new Set(
      deduped
        .filter((p) => !p.surfaceResolved.startsWith("("))
        .map((p) => `${p.elementResolved}||${p.surfaceResolved}`),
    );

    const gaps: CssPairing[] = [];
    for (const p of deduped) {
      if (p.surfaceResolved.startsWith("(")) continue;
      // Self-referential pairings (element === surface) are border-matches-background
      // decorative pairings. Dynamic CSS custom properties injected at runtime
      // (e.g. --tug-toggle-on-color) fall into this category — they cannot be
      // represented in the pairing map (which only tracks --tug-* tokens).
      if (p.elementResolved === p.surfaceResolved) continue;
      const key = `${p.elementResolved}||${p.surfaceResolved}`;
      if (!mapKeys.has(key)) gaps.push(p);
    }

    const orphans: { element: string; surface: string }[] = [];
    for (const mp of mapPairings) {
      const key = `${mp.element}||${mp.surface}`;
      if (!cssKeys.has(key)) orphans.push(mp);
    }

    console.log(`\n=== Gap Analysis ===`);
    console.log(`Pairings in CSS but NOT in pairing map (gaps): ${gaps.length}`);
    for (const g of gaps) {
      console.log(
        `  ${stripTugPrefix(g.elementResolved).padEnd(45)} on  ${stripTugPrefix(g.surfaceResolved)}  [${g.file}]`,
      );
    }

    console.log(
      `\nPairings in map but NOT found in CSS (orphans): ${orphans.length}`,
    );
    if (orphans.length > 0 && orphans.length <= 20) {
      for (const o of orphans) {
        console.log(
          `  ${stripTugPrefix(o.element).padEnd(45)} on  ${stripTugPrefix(o.surface)}`,
        );
      }
    } else if (orphans.length > 20) {
      console.log(`  (showing first 20)`);
      for (const o of orphans.slice(0, 20)) {
        console.log(
          `  ${stripTugPrefix(o.element).padEnd(45)} on  ${stripTugPrefix(o.surface)}`,
        );
      }
    }

    // Flag the known critical gap (updated for four-prefix rename)
    const criticalGap = gaps.find(
      (g) =>
        g.elementResolved === "--tug7-element-global-text-normal-default-rest" &&
        g.surfaceResolved === "--tugx-tab-bg-active",
    );
    if (criticalGap) {
      console.log(
        `\n⚠ CRITICAL GAP CONFIRMED: element-global-text-normal-default-rest on tab-bg-active (pane tab bar)`,
      );
    }
  }

  // Report unresolved pairings
  const unresolved = allPairings.filter((p) =>
    p.surfaceResolved.startsWith("("),
  );
  if (unresolved.length > 0) {
    console.log(`\n=== Unresolved Pairings (need manual check) ===`);
    console.log(`Count: ${unresolved.length}`);
    for (const p of unresolved) {
      console.log(
        `  ${p.file}: ${p.elementRaw} (${p.elementProperty}) — no background-color found in context`,
      );
      console.log(`    selector: ${p.selector}`);
    }
  }
}

/** Load the existing pairing map entries from theme-pairings.ts. */
function loadPairingMap(): { element: string; surface: string }[] | null {
  if (!fs.existsSync(PAIRING_MAP_PATH)) return null;
  const src = fs.readFileSync(PAIRING_MAP_PATH, "utf-8");
  const entries: { element: string; surface: string }[] = [];
  const re = /element:\s*"(--(?:tug7|tugc|tugx|tug)-[\w-]+)"[\s\S]*?surface:\s*"(--(?:tug7|tugc|tugx|tug)-[\w-]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    entries.push({ element: m[1], surface: m[2] });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Subcommand: rename
// ---------------------------------------------------------------------------

/**
 * Recursively discover all .ts, .tsx, .css files under tugdeck/ that contain
 * --tug- references. Excludes node_modules/, dist/, .git/, scripts/audit-tokens.ts,
 * and scripts/seed-rename-map.ts (these contain token names as map keys/constants,
 * not as references to rename). Generated CSS files and scripts/generate-tug-tokens.ts
 * are included so dry-run/stats output reflects the full blast radius.
 *
 * Results are sorted alphabetically by relative path for deterministic output.
 */
function discoverTokenFiles(): string[] {
  // Match any of the four prefix variants so files are discovered after renames.
  const TOKEN_PREFIXES = ["--tug7-", "--tugc-", "--tugx-", "--tug-"];
  const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".git"]);
  const EXCLUDED_FILES = new Set([
    path.join(TUGDECK, "scripts/audit-tokens.ts"),
    path.join(TUGDECK, "scripts/seed-rename-map.ts"),
  ]);

  const results: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry)) {
          walk(full);
        }
      } else if (stat.isFile()) {
        if (!(entry.endsWith(".ts") || entry.endsWith(".tsx") || entry.endsWith(".css"))) {
          continue;
        }
        if (EXCLUDED_FILES.has(full)) continue;
        let content: string;
        try {
          content = fs.readFileSync(full, "utf-8");
        } catch {
          continue;
        }
        if (TOKEN_PREFIXES.some((prefix) => content.includes(prefix))) {
          results.push(full);
        }
      }
    }
  }

  walk(TUGDECK);

  // Sort alphabetically by relative path for deterministic output
  results.sort((a, b) => {
    const ra = path.relative(TUGDECK, a);
    const rb = path.relative(TUGDECK, b);
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });

  return results;
}

interface RenameOptions {
  apply: boolean;
  mapPath?: string;
  verify: boolean;
  stats: boolean;
}

/**
 * Load and parse an external JSON rename map file.
 *
 * Two formats are supported, auto-detected by key shape:
 *
 * 1. **Short-name format** (legacy): keys and values are short names (the part
 *    after `--tug-`), e.g. `"element-global-text-normal-plain-rest"`.
 *    The `--tug-` prefix is prepended/appended by cmdRename.
 *
 * 2. **Full-name format** (new): keys and values are full CSS property names
 *    starting with `--`, e.g. `"--tug-red-h": "--tugc-red-h"`.
 *    cmdRename uses these values directly without prepending any prefix.
 *
 * Detection: if the first key starts with `--`, the map is treated as
 * full-name format.
 *
 * Throws on parse errors or invalid format; exits with code 1 on error.
 */
function loadExternalMap(mapPath: string): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(mapPath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: Could not read map file "${mapPath}": ${msg}`);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: Could not parse JSON from "${mapPath}": ${msg}`);
    process.exit(1);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error(`ERROR: Map file "${mapPath}" must contain a JSON object, not an array or primitive.`);
    process.exit(1);
  }

  const map: Record<string, string> = {};
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof val !== "string") {
      console.error(`ERROR: Map file "${mapPath}": value for key "${key}" must be a string, got ${typeof val}.`);
      process.exit(1);
    }
    map[key] = val;
  }

  return map;
}

/**
 * Detect whether a rename map uses full-name format (keys start with `--`).
 * Returns true if the map is non-empty and the first key starts with `--`.
 */
function isFullNameMap(map: Record<string, string>): boolean {
  const firstKey = Object.keys(map)[0];
  return firstKey !== undefined && firstKey.startsWith("--");
}

/**
 * Strip any `--tug-`, `--tug7-`, `--tugc-`, `--tugx-` prefix from a full
 * CSS property name to obtain the bare short name for TS map-key matching.
 *
 * Examples:
 *   "--tug-element-foo"   → "element-foo"
 *   "--tug7-element-foo"  → "element-foo"
 *   "--tugc-red-h"        → "red-h"
 *   "--tugx-pane-border"  → "pane-border"
 */
function stripTugPrefix(fullName: string): string {
  if (fullName.startsWith("--tug7-")) return fullName.slice("--tug7-".length);
  if (fullName.startsWith("--tugc-")) return fullName.slice("--tugc-".length);
  if (fullName.startsWith("--tugx-")) return fullName.slice("--tugx-".length);
  if (fullName.startsWith("--tug-")) return fullName.slice("--tug-".length);
  return fullName;
}

function cmdRename(opts: RenameOptions): void {
  const { apply, mapPath, verify, stats } = opts;

  // Load the rename map: --map <path> is required.
  if (!mapPath) {
    console.error("ERROR: --map <path> is required. The hardcoded fallback rename map has been removed.");
    console.error("  Generate a map with: bun run audit:tokens rename-map --json > token-rename-map.json");
    console.error("  Then run: bun run audit:tokens rename --map token-rename-map.json [--apply]");
    process.exit(1);
  }
  const activeMap: Record<string, string> = loadExternalMap(mapPath);

  const fullNameMode = isFullNameMap(activeMap);

  if (verify) {
    // --verify mode: scan for stale references using the same patterns as rename
    console.log(`\n=== Token Rename --verify (checking for stale references) ===\n`);

    const files = discoverTokenFiles();
    let staleCount = 0;

    for (const filePath of files) {
      if (!fs.existsSync(filePath)) continue;
      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      const relativePath = path.relative(TUGDECK, filePath);

      for (const [oldKey, newKey] of Object.entries(activeMap)) {
        // Skip identity mappings
        if (oldKey === newKey) continue;

        const oldFull = fullNameMode ? oldKey : `--tug-${oldKey}`;
        const oldShort = fullNameMode ? stripTugPrefix(oldKey) : oldKey;

        const escapedOld = oldFull.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const cssRegex = new RegExp(`${escapedOld}(?=[^\\w-]|$)`, "g");

        const escapedOldShort = oldShort.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const bareRegex = new RegExp(`"${escapedOldShort}"(?=\\s*:)`, "g");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (cssRegex.test(line)) {
            console.log(`  ${relativePath}:${i + 1}: stale CSS reference "${oldFull}"`);
            staleCount++;
          }
          cssRegex.lastIndex = 0;
          if (bareRegex.test(line)) {
            console.log(`  ${relativePath}:${i + 1}: stale bare reference "${oldShort}"`);
            staleCount++;
          }
          bareRegex.lastIndex = 0;
        }
      }
    }

    if (staleCount === 0) {
      console.log(`✓ Zero stale references found.`);
    } else {
      console.log(`\nTotal stale references: ${staleCount}`);
      process.exit(1);
    }
    return;
  }

  if (stats) {
    // --stats mode: count tokens to rename, files to modify, replacements per file
    console.log(`\n=== Token Rename --stats (blast radius preview) ===\n`);

    // Count non-identity entries
    const renameEntries = Object.entries(activeMap).filter(([old, newName]) => old !== newName);
    console.log(`Non-identity rename entries: ${renameEntries.length}`);

    const files = discoverTokenFiles();
    const fileStats: { file: string; count: number }[] = [];

    for (const filePath of files) {
      if (!fs.existsSync(filePath)) continue;
      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      let count = 0;

      for (const [oldKey] of renameEntries) {
        const oldFull = fullNameMode ? oldKey : `--tug-${oldKey}`;
        const oldShort = fullNameMode ? stripTugPrefix(oldKey) : oldKey;

        const escapedOld = oldFull.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const cssRegex = new RegExp(`${escapedOld}(?=[^\\w-]|$)`, "g");
        const cssMatches = content.match(cssRegex);
        if (cssMatches) count += cssMatches.length;

        const escapedOldShort = oldShort.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const bareRegex = new RegExp(`"${escapedOldShort}"(?=\\s*:)`, "g");
        const bareMatches = content.match(bareRegex);
        if (bareMatches) count += bareMatches.length;
      }

      if (count > 0) {
        fileStats.push({ file: path.relative(TUGDECK, filePath), count });
      }
    }

    // Sort by count descending
    fileStats.sort((a, b) => b.count - a.count);

    const totalFiles = fileStats.length;
    const totalReplacements = fileStats.reduce((sum, f) => sum + f.count, 0);

    console.log(`Files to modify: ${totalFiles}`);
    console.log(`Total replacements: ${totalReplacements}\n`);

    if (fileStats.length > 0) {
      console.log(`Per-file replacement counts (sorted by count):`);
      for (const { file, count } of fileStats) {
        console.log(`  ${count.toString().padStart(4)}  ${file}`);
      }
    }
    return;
  }

  console.log(`\n=== Token Rename ${apply ? "(APPLYING)" : "(DRY RUN)"} ===\n`);

  const files = discoverTokenFiles();
  const changes: { file: string; count: number; replacements: string[] }[] = [];

  for (const filePath of files) {
    if (!fs.existsSync(filePath)) continue;
    let content = fs.readFileSync(filePath, "utf-8");
    let modified = false;
    const replacements: string[] = [];
    let count = 0;

    for (const [oldKey, newKey] of Object.entries(activeMap)) {
      // In full-name mode, keys and values are already full CSS property names.
      // In short-name mode, prepend --tug- to get the full names.
      const oldFull = fullNameMode ? oldKey : `--tug-${oldKey}`;
      const newFull = fullNameMode ? newKey : `--tug-${newKey}`;

      // For bare-string TS map-key replacement, derive short names by stripping
      // any tug prefix variant from both sides.
      const oldShort = fullNameMode ? stripTugPrefix(oldKey) : oldKey;
      const newShort = fullNameMode ? stripTugPrefix(newKey) : newKey;

      // Use word-boundary-aware replacement to avoid partial matches.
      // In CSS/TS, token names are delimited by: `, ;, ), :, whitespace, or end-of-string
      // We need to be careful: "checkmark" should not match "checkmark-mixed"
      // So we match the full token name followed by a non-alphanumeric-non-hyphen char.
      const escapedOld = oldFull.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`${escapedOld}(?=[^\\w-]|$)`, "g");
      const newContent = content.replace(regex, newFull);
      const matchCount = (content.match(regex) || []).length;

      if (matchCount > 0) {
        replacements.push(`  ${oldFull} → ${newFull} (${matchCount} occurrences)`);
        count += matchCount;
        content = newContent;
        modified = true;
      }

      // Also replace in TS map keys where the token name appears as a bare string
      // e.g., in theme-rules.ts: "field-fg": { ... }
      // or in the pairing map: element: "--tug-field-fg"
      const escapedOldShort = oldShort.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const bareRegex = new RegExp(
        `"${escapedOldShort}"(?=\\s*:)`,
        "g",
      );
      const bareContent = content.replace(bareRegex, `"${newShort}"`);
      const bareCount = (content.match(bareRegex) || []).length;
      if (bareCount > 0) {
        replacements.push(`  "${oldShort}" → "${newShort}" as map key (${bareCount} occurrences)`);
        count += bareCount;
        content = bareContent;
        modified = true;
      }
    }

    if (modified) {
      changes.push({
        file: path.relative(TUGDECK, filePath),
        count,
        replacements,
      });
      if (apply) {
        fs.writeFileSync(filePath, content, "utf-8");
      }
    }
  }

  if (changes.length === 0) {
    console.log("No renames needed — all tokens already use the new names.");
    return;
  }

  for (const ch of changes) {
    console.log(`${ch.file} (${ch.count} replacements):`);
    for (const r of ch.replacements) console.log(r);
    console.log();
  }

  const totalReplacements = changes.reduce((sum, ch) => sum + ch.count, 0);
  console.log(
    `Total: ${totalReplacements} replacements across ${changes.length} files`,
  );

  if (!apply) {
    console.log(`\nThis was a DRY RUN. Use --apply to write changes.`);
  } else {
    console.log(`\n✓ All changes written.`);
    console.log(`Next: verify the renamed tokens in the theme CSS files (styles/themes/).`);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: inject
// ---------------------------------------------------------------------------

function cmdInject(apply: boolean): void {
  console.log(
    `\n=== Inject @tug-pairings Blocks ${apply ? "(APPLYING)" : "(DRY RUN)"} ===\n`,
  );

  // First, run the pairing extraction to get data
  const globalAliases = buildGlobalAliases();
  const fileData: Map<string, CssPairing[]> = new Map();

  for (const file of COMPONENT_CSS_FILES) {
    if (!fs.existsSync(file)) continue;
    const css = fs.readFileSync(file, "utf-8");
    const basename = path.relative(TUGWAYS, file);
    const rules = parseRules(css);
    const annotationMap = parseRendersOnAnnotations(css);
    const pairings: CssPairing[] = [];

    for (const rule of rules) {
      for (const [prop, val] of rule.properties) {
        if (!ELEMENT_PROPERTIES.has(prop)) continue;
        const elementToken = extractVarRef(val);
        if (!elementToken) continue;

        const surfaces = findAllSurfacesForSelector(rule.selector, rules, annotationMap);
        if (surfaces.length === 0) continue; // skip unresolvable

        for (const surface of surfaces) {
          pairings.push({
            file: basename,
            selector: rule.selector,
            elementRaw: elementToken,
            surfaceRaw: surface.surfaceToken,
            elementResolved: resolveToken(elementToken, globalAliases),
            surfaceResolved: resolveToken(surface.surfaceToken, globalAliases),
            elementProperty: prop,
          });
        }
      }
    }

    // Deduplicate within file
    const seen = new Set<string>();
    const deduped: CssPairing[] = [];
    for (const p of pairings) {
      const key = `${p.elementResolved}||${p.surfaceResolved}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(p);
      }
    }

    fileData.set(file, deduped);
  }

  // Generate and inject comment blocks
  let injectedCount = 0;
  for (const [file, pairings] of fileData) {
    if (pairings.length === 0) {
      console.log(`${path.relative(TUGWAYS, file)}: no pairings found, skipping`);
      continue;
    }

    // Build the @tug-pairings comment block
    const lines: string[] = [];
    lines.push("/**");
    lines.push(" * @tug-pairings");
    lines.push(
      " * | Element                                          | Surface                                          | Role         | Context                              |",
    );
    lines.push(
      " * |--------------------------------------------------|--------------------------------------------------|--------------|--------------------------------------|",
    );
    for (const p of pairings) {
      const elAlias = p.elementRaw;
      const elBase = stripTugPrefix(p.elementResolved);
      const sfAlias = p.surfaceRaw;
      const sfBase = stripTugPrefix(p.surfaceResolved);
      const role = guessRole(elBase, p.elementProperty);
      const context = `${p.selector} (${p.elementProperty})`;

      const elCol = `${elAlias} (${elBase})`.padEnd(48);
      const sfCol = `${sfAlias} (${sfBase})`.padEnd(48);
      const roleCol = role.padEnd(12);
      lines.push(` * | ${elCol} | ${sfCol} | ${roleCol} | ${context.padEnd(36)} |`);
    }
    lines.push(" */");
    const block = lines.join("\n");

    if (!apply) {
      console.log(`${path.relative(TUGWAYS, file)}: would inject ${pairings.length} pairings`);
    } else {
      let css = fs.readFileSync(file, "utf-8");

      // Remove existing @tug-pairings block if present
      css = css.replace(/\/\*\*[\s\S]*?@tug-pairings[\s\S]*?\*\/\n*/, "");

      // Insert after the file-level docblock comment (first */ found)
      const docblockEnd = css.indexOf("*/");
      if (docblockEnd !== -1) {
        const insertPos = docblockEnd + 2;
        css =
          css.slice(0, insertPos) +
          "\n\n" +
          block +
          "\n" +
          css.slice(insertPos);
      } else {
        // No docblock — insert at top
        css = block + "\n\n" + css;
      }

      fs.writeFileSync(file, css, "utf-8");
      console.log(
        `✓ ${path.relative(TUGWAYS, file)}: injected ${pairings.length} pairings`,
      );
    }
    injectedCount++;
  }

  console.log(`\n${injectedCount} files processed.`);
  if (!apply) {
    console.log(`This was a DRY RUN. Use --apply to write changes.`);
  }
}

/** Heuristic role assignment based on token name and property. */
function guessRole(
  elementShortName: string,
  property: string,
): string {
  // Decorative: dividers, shadows, separators
  if (
    elementShortName.includes("divider-") ||
    elementShortName.includes("shadow-") ||
    elementShortName === "separator" ||
    elementShortName === "divider-separator"
  )
    return "decorative";

  // Control element tokens (interactive labels, icons, borders on controls)
  if (elementShortName.startsWith("element-control-")) return "control";

  // Title typography (tug7 `element-card-title-*` slot — not pane-chrome `--tugx-pane-*`)
  if (elementShortName.startsWith("element-card-title-")) return "display";

  // Badge and tone tokens are informational
  if (
    elementShortName.startsWith("element-badge-") ||
    elementShortName.startsWith("element-tone-")
  )
    return "informational";

  // Global icons are interactive context → control
  if (
    elementShortName.includes("icon-") ||
    elementShortName.startsWith("icon-") ||
    elementShortName.includes("-icon-")
  )
    return "control";

  // Global structural borders are informational
  if (
    (property === "border" || property === "border-color") &&
    !elementShortName.startsWith("element-control-")
  )
    return "informational";

  // Muted/subtle/placeholder/disabled text is informational
  if (
    elementShortName.includes("muted") ||
    elementShortName.includes("subtle") ||
    elementShortName.includes("placeholder") ||
    elementShortName.includes("disabled") ||
    elementShortName.includes("readonly")
  )
    return "informational";

  // Legacy fg- tokens
  if (elementShortName.includes("fg-")) return "content";

  return "content";
}

// ---------------------------------------------------------------------------
// Subcommand: verify
// ---------------------------------------------------------------------------

function cmdVerify(): void {
  console.log(`\n=== Verify Pairings Cross-Check ===\n`);

  // Load pairing map
  const mapPairings = loadPairingMap();
  if (!mapPairings) {
    console.error("ERROR: Could not load theme-pairings.ts");
    process.exit(1);
  }

  // Parse @tug-pairings blocks from all CSS files
  const cssPairings: { element: string; surface: string; file: string }[] = [];

  for (const file of COMPONENT_CSS_FILES) {
    if (!fs.existsSync(file)) continue;
    const css = fs.readFileSync(file, "utf-8");
    const basename = path.relative(TUGWAYS, file);

    // Find @tug-pairings block
    const blockMatch = css.match(/\/\*\*[\s\S]*?@tug-pairings([\s\S]*?)\*\//);
    if (!blockMatch) {
      console.warn(`⚠ No @tug-pairings block in ${basename}`);
      continue;
    }

    // Parse table rows
    // Row format: | --tugx-foo (foo-short) | --tug7-bar (bar-short) | role | context |
    // Capture the full --tug*- token name from the start of each element/surface cell.
    const tableContent = blockMatch[1];
    const rowRe =
      /\|\s*(--(?:tug7|tugc|tugx|tug)-[\w-]+)[^|]*\|\s*(--(?:tug7|tugc|tugx|tug)-[\w-]+)[^|]*\|/g;
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(tableContent)) !== null) {
      const elFull = m[1].trim();
      const sfFull = m[2].trim();
      cssPairings.push({
        element: elFull,
        surface: sfFull,
        file: basename,
      });
    }
  }

  console.log(`Pairing map entries: ${mapPairings.length}`);
  console.log(`CSS @tug-pairings entries: ${cssPairings.length}`);

  // Cross-check
  const mapKeys = new Set(mapPairings.map((p) => `${p.element}||${p.surface}`));
  const cssKeys = new Set(cssPairings.map((p) => `${p.element}||${p.surface}`));

  const gaps = cssPairings.filter(
    (p) => !mapKeys.has(`${p.element}||${p.surface}`),
  );
  const orphans = mapPairings.filter(
    (p) => !cssKeys.has(`${p.element}||${p.surface}`),
  );

  if (gaps.length > 0) {
    console.log(`\n⚠ GAPS: ${gaps.length} pairings in CSS but NOT in pairing map:`);
    for (const g of gaps) {
      console.log(
        `  ${stripTugPrefix(g.element).padEnd(45)} on  ${stripTugPrefix(g.surface)}  [${g.file}]`,
      );
    }
  }

  if (orphans.length > 0) {
    console.log(
      `\nℹ ORPHANS: ${orphans.length} pairings in map but NOT in any @tug-pairings block`,
    );
    // This is informational — map entries may include computed/inherited pairings
    // that don't appear in static CSS
  }

  if (gaps.length === 0) {
    console.log(`\n✓ All CSS @tug-pairings entries have corresponding map entries.`);
  }

  // Check all files have blocks
  let filesWithBlock = 0;
  let filesWithout = 0;
  for (const file of COMPONENT_CSS_FILES) {
    if (!fs.existsSync(file)) continue;
    const css = fs.readFileSync(file, "utf-8");
    if (css.includes("@tug-pairings")) {
      filesWithBlock++;
    } else {
      filesWithout++;
      console.log(`  Missing @tug-pairings: ${path.relative(TUGWAYS, file)}`);
    }
  }
  console.log(`\nFiles with @tug-pairings: ${filesWithBlock}/${COMPONENT_CSS_FILES.length}`);

  // Exit code
  if (gaps.length > 0 || filesWithout > 0) {
    process.exit(1);
  }
  console.log(`\n✓ Verification passed.`);
}

// ---------------------------------------------------------------------------
// Subcommand: lint
// ---------------------------------------------------------------------------

/** Violation record for a single lint failure. */
interface LintViolation {
  type: "MISSING_ANNOTATION" | "MULTI_HOP_ALIAS" | "MISSING_PAIRINGS_BLOCK" | "UNRESOLVED_PAIRING";
  message: string;
}

/**
 * Lint check 1: annotation completeness.
 *
 * Every CSS rule that sets an element property (from ELEMENT_PROPERTIES) without
 * setting background-color in the same rule must have a @tug-renders-on annotation.
 * Violation: MISSING_ANNOTATION: {file}:{selector} sets {property} without background-color and has no @tug-renders-on
 */
function checkAnnotationCompleteness(
  file: string,
  css: string,
  rules: CssRule[],
  annotationMap: Map<string, string[]>,
): LintViolation[] {
  const violations: LintViolation[] = [];
  const basename = path.relative(TUGWAYS, file);

  for (const rule of rules) {
    // Check if the rule sets a background surface in the same rule
    let hasSameBg = false;
    for (const prop of SURFACE_PROPERTIES) {
      const val = rule.properties.get(prop);
      if (val) {
        const token = extractVarRef(val);
        if (token) {
          hasSameBg = true;
          break;
        }
      }
    }
    if (hasSameBg) continue;

    // Check for element properties without annotation
    for (const [prop] of rule.properties) {
      if (!ELEMENT_PROPERTIES.has(prop)) continue;
      const val = rule.properties.get(prop)!;
      const token = extractVarRef(val);
      if (!token) continue;

      // Rule has an element property referencing a tug token — needs annotation
      if (!annotationMap.has(rule.selector)) {
        violations.push({
          type: "MISSING_ANNOTATION",
          message: `MISSING_ANNOTATION: ${basename}:${rule.selector} sets ${prop} without background-color and has no @tug-renders-on`,
        });
        // Only report once per selector (not once per property)
        break;
      }
    }
  }

  return violations;
}

/**
 * Lint check 2: alias chain depth.
 *
 * Every alias in body {} blocks must resolve to --tug-* in exactly 1 hop.
 * Violation: MULTI_HOP_ALIAS: {file}: {alias} resolves through {count} hops (max 1)
 */
function checkAliasChainDepth(
  file: string,
  css: string,
): LintViolation[] {
  const violations: LintViolation[] = [];
  const basename = path.relative(TUGWAYS, file);

  // Extract local aliases from this file's body blocks
  const localAliases = extractAliases(css);

  for (const [alias, target] of Object.entries(localAliases)) {
    // Target must be a base tug token (1-hop rule): --tug7-, --tugc-, or --tug- (scale)
    if (!isBaseTugToken(target)) {
      // Count hops: follow the chain to find total depth
      const globalAliases = buildGlobalAliases();
      let hops = 0;
      let current = alias;
      const visited = new Set<string>();
      while (!isBaseTugToken(current) && !visited.has(current)) {
        visited.add(current);
        const next = globalAliases[current];
        if (!next) break;
        current = next;
        hops++;
      }
      violations.push({
        type: "MULTI_HOP_ALIAS",
        message: `MULTI_HOP_ALIAS: ${basename}: ${alias} resolves through ${hops} hops (max 1)`,
      });
    }
  }

  return violations;
}

/**
 * Lint check 3: @tug-pairings block presence.
 *
 * Every CSS file in COMPONENT_CSS_FILES must contain a @tug-pairings comment block.
 * Violation: MISSING_PAIRINGS_BLOCK: {file}
 */
function checkPairingsBlockPresence(
  file: string,
  css: string,
): LintViolation[] {
  const basename = path.relative(TUGWAYS, file);
  if (!css.includes("@tug-pairings")) {
    return [{
      type: "MISSING_PAIRINGS_BLOCK",
      message: `MISSING_PAIRINGS_BLOCK: ${basename}`,
    }];
  }
  return [];
}

/**
 * Lint check 4: zero unresolved pairings.
 *
 * After annotation parsing, no rule with an element property may lack a
 * deterministic surface.
 * Violation: UNRESOLVED_PAIRING: {file}:{selector} — {element_token} has no deterministic surface
 */
function checkZeroUnresolved(
  file: string,
  css: string,
  rules: CssRule[],
  annotationMap: Map<string, string[]>,
): LintViolation[] {
  const violations: LintViolation[] = [];
  const basename = path.relative(TUGWAYS, file);

  for (const rule of rules) {
    for (const [prop, val] of rule.properties) {
      if (!ELEMENT_PROPERTIES.has(prop)) continue;
      const elementToken = extractVarRef(val);
      if (!elementToken) continue;

      const surfaces = findAllSurfacesForSelector(rule.selector, rules, annotationMap);
      if (surfaces.length === 0) {
        violations.push({
          type: "UNRESOLVED_PAIRING",
          message: `UNRESOLVED_PAIRING: ${basename}:${rule.selector} — ${elementToken} has no deterministic surface`,
        });
        // Only report once per selector
        break;
      }
    }
  }

  return violations;
}

/**
 * Lint subcommand: hard-fail on annotation completeness, alias chain depth,
 * missing @tug-pairings blocks, and unresolved pairings.
 *
 * Exit code: 0 if zero violations; 1 if any violation found.
 * All violations are printed before exit. [D03] Lint hard gate,.
 */
function cmdLint(): void {
  console.log(`\n=== Lint Token Annotations ===\n`);

  const allViolations: LintViolation[] = [];

  for (const file of COMPONENT_CSS_FILES) {
    if (!fs.existsSync(file)) {
      console.warn(`⚠ File not found: ${path.relative(TUGWAYS, file)}`);
      continue;
    }
    const css = fs.readFileSync(file, "utf-8");
    const rules = parseRules(css);
    const annotationMap = parseRendersOnAnnotations(css);

    allViolations.push(...checkPairingsBlockPresence(file, css));
    allViolations.push(...checkAnnotationCompleteness(file, css, rules, annotationMap));
    allViolations.push(...checkAliasChainDepth(file, css));
    allViolations.push(...checkZeroUnresolved(file, css, rules, annotationMap));
  }

  if (allViolations.length === 0) {
    console.log(`✓ Zero violations. All annotation, alias, and pairing checks pass.`);
    return;
  }

  // Group violations by type for readability
  const byType = new Map<string, LintViolation[]>();
  for (const v of allViolations) {
    const list = byType.get(v.type) ?? [];
    list.push(v);
    byType.set(v.type, list);
  }

  for (const [type, violations] of byType) {
    console.log(`\n--- ${type} (${violations.length}) ---`);
    for (const v of violations) {
      console.log(`  ${v.message}`);
    }
  }

  console.log(`\nTotal violations: ${allViolations.length}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Subcommand: rename-map
// ---------------------------------------------------------------------------

interface RenameMapValidation {
  /** Tokens present in inventory but missing from the map */
  missing: string[];
  /** New names that appear more than once (collisions) */
  collisions: Array<{ newName: string; oldNames: string[] }>;
  /** Map entries where the new name is malformed */
  malformed: Array<{ oldName: string; newName: string; reason: string }>;
}

/**
 * Validate a rename map against the live token inventory.
 *
 * Checks:
 *   (a) Every token from extractTokens() is present in the map
 *   (b) No two old names map to the same new name (collision check)
 *   (c) All new names are well-formed: non-empty, no leading/trailing hyphens,
 *       kebab-case with only [a-z0-9-] characters (camelCase sub-segments within
 *       slots are permitted for role values, e.g., "element-global-text-normal-accentCool-rest")
 */
function validateRenameMap(
  map: Record<string, string>,
  tokens: TokenEntry[],
): RenameMapValidation {
  const missing: string[] = [];
  const malformed: Array<{ oldName: string; newName: string; reason: string }> = [];

  // (a) Check every token is present in the map
  for (const token of tokens) {
    if (!(token.shortName in map)) {
      missing.push(token.shortName);
    }
  }

  // (c) Check new names are well-formed
  for (const [oldName, newName] of Object.entries(map)) {
    if (!newName || newName.trim() === "") {
      malformed.push({ oldName, newName, reason: "empty new name" });
      continue;
    }
    if (newName.startsWith("-") || newName.endsWith("-")) {
      malformed.push({ oldName, newName, reason: "leading or trailing hyphen" });
      continue;
    }
    // Allow kebab-case with camelCase sub-segments (letters, digits, hyphens)
    if (!/^[a-zA-Z0-9-]+$/.test(newName)) {
      malformed.push({ oldName, newName, reason: `invalid characters in new name: "${newName}"` });
    }
  }

  // (b) Check for collisions (two old names mapping to same new name)
  const newToOlds = new Map<string, string[]>();
  for (const [oldName, newName] of Object.entries(map)) {
    const list = newToOlds.get(newName) ?? [];
    list.push(oldName);
    newToOlds.set(newName, list);
  }
  const collisions: Array<{ newName: string; oldNames: string[] }> = [];
  for (const [newName, oldNames] of newToOlds) {
    if (oldNames.length > 1) {
      collisions.push({ newName, oldNames });
    }
  }

  return { missing, collisions, malformed };
}

/**
 * Generate and output the complete rename map.
 *
 * Default mode: human-readable grouped report to stdout.
 * --json mode: flat {"old": "new"} JSON to stdout; validation errors to stderr.
 */
function cmdRenameMap(jsonMode: boolean): void {
  const tokens = extractTokens();
  const map = SEED_RENAME_MAP;

  const validation = validateRenameMap(map, tokens);
  const hasErrors =
    validation.missing.length > 0 ||
    validation.collisions.length > 0 ||
    validation.malformed.length > 0;

  if (jsonMode) {
    // Errors go to stderr in JSON mode
    if (hasErrors) {
      if (validation.missing.length > 0) {
        console.error(`ERROR: ${validation.missing.length} tokens missing from map:`);
        for (const m of validation.missing) {
          console.error(`  ${m}`);
        }
      }
      if (validation.collisions.length > 0) {
        console.error(`ERROR: ${validation.collisions.length} collision(s):`);
        for (const c of validation.collisions) {
          console.error(`  ${c.newName} <- [${c.oldNames.join(", ")}]`);
        }
      }
      if (validation.malformed.length > 0) {
        console.error(`ERROR: ${validation.malformed.length} malformed new name(s):`);
        for (const mf of validation.malformed) {
          console.error(`  ${mf.oldName} -> "${mf.newName}": ${mf.reason}`);
        }
      }
      process.exit(1);
    }

    // Only output non-identity entries in the JSON map
    const jsonMap: Record<string, string> = {};
    for (const [oldName, newName] of Object.entries(map)) {
      jsonMap[oldName] = newName;
    }
    console.log(JSON.stringify(jsonMap, null, 2));
    return;
  }

  // Human-readable grouped report
  console.log(`\n=== Rename Map Report ===`);
  console.log(`Total tokens in inventory: ${tokens.length}`);
  console.log(`Total entries in seed map: ${Object.keys(map).length}`);

  // Group by classification
  const byClass = new Map<string, Array<{ old: string; new: string }>>();
  for (const token of tokens) {
    const newName = map[token.shortName];
    if (newName === undefined) continue;
    const cls = token.classification;
    const list = byClass.get(cls) ?? [];
    list.push({ old: token.shortName, new: newName });
    byClass.set(cls, list);
  }

  for (const cls of ["surface", "element", "non-color"]) {
    const list = byClass.get(cls) ?? [];
    if (list.length === 0) continue;
    const identity = list.filter((e) => e.old === e.new).length;
    const renamed = list.filter((e) => e.old !== e.new).length;
    console.log(`\n--- ${cls.toUpperCase()} (${list.length} tokens: ${renamed} renamed, ${identity} identity) ---`);
    for (const entry of list) {
      if (entry.old === entry.new) {
        console.log(`  ${entry.old}  [identity]`);
      } else {
        console.log(`  ${entry.old}  ->  ${entry.new}`);
      }
    }
  }

  // Validation results
  console.log(`\n=== Validation ===`);
  if (hasErrors) {
    if (validation.missing.length > 0) {
      console.log(`\nERROR: ${validation.missing.length} token(s) missing from map:`);
      for (const m of validation.missing) {
        console.log(`  ${m}`);
      }
    }
    if (validation.collisions.length > 0) {
      console.log(`\nERROR: ${validation.collisions.length} collision(s):`);
      for (const c of validation.collisions) {
        console.log(`  "${c.newName}" <- [${c.oldNames.join(", ")}]`);
      }
    }
    if (validation.malformed.length > 0) {
      console.log(`\nERROR: ${validation.malformed.length} malformed new name(s):`);
      for (const mf of validation.malformed) {
        console.log(`  ${mf.oldName} -> "${mf.newName}": ${mf.reason}`);
      }
    }
    process.exit(1);
  } else {
    console.log(`\n✓ Validation passed: all ${tokens.length} tokens mapped, zero collisions, all new names well-formed.`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0];
const flags = new Set(args.slice(1));

// Index-based extraction of --map <path> flag value (Set-based parsing loses positional info)
function extractFlagValue(rawArgs: string[], flag: string): string | undefined {
  const idx = rawArgs.indexOf(flag);
  if (idx === -1) return undefined;
  const value = rawArgs[idx + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`ERROR: ${flag} requires a path argument.`);
    process.exit(1);
  }
  return value;
}

switch (command) {
  case "tokens":
    cmdTokens();
    break;
  case "pairings":
    cmdPairings();
    break;
  case "rename": {
    const subArgs = args.slice(1);
    const mapPath = extractFlagValue(subArgs, "--map");
    cmdRename({
      apply: flags.has("--apply"),
      mapPath,
      verify: flags.has("--verify"),
      stats: flags.has("--stats"),
    });
    break;
  }
  case "rename-map":
    cmdRenameMap(flags.has("--json"));
    break;
  case "inject":
    cmdInject(flags.has("--apply"));
    break;
  case "verify":
    cmdVerify();
    break;
  case "lint":
    cmdLint();
    break;
  default:
    console.log(`Usage: bun run audit:tokens <command> [flags]

Commands:
  tokens                              Extract and classify all --tug-* tokens
  pairings                            Audit component CSS files for foreground-on-background pairings
  rename [flags]                      Bulk-rename tokens across auto-discovered files (dry run by default)
    --apply                             Write changes to disk (default: dry run)
    --map <path>                        Load rename map from a JSON file (default: built-in 7-entry map)
    --verify                            Scan for stale old-name references after rename (requires --map)
    --stats                             Print blast radius summary: token count, file count, per-file replacements (requires --map)
  rename-map [--json]                 Generate the complete old->new rename map for all tokens
    --json                              Output flat JSON object suitable for --map flag (default: human-readable report)
  inject [--apply]                    Generate @tug-pairings comment blocks (dry run by default)
  verify                              Cross-check @tug-pairings blocks against pairing map
  lint                                Hard-fail on missing annotations, multi-hop aliases, missing
                                      @tug-pairings blocks, and unresolved pairings

Examples:
  bun run audit:tokens rename-map --json > token-rename-map.json
  bun run audit:tokens rename --map token-rename-map.json --stats
  bun run audit:tokens rename --map token-rename-map.json
  bun run audit:tokens rename --map token-rename-map.json --apply
  bun run audit:tokens rename --verify --map token-rename-map.json
`);
    break;
}
