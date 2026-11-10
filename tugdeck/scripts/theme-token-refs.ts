/**
 * theme-token-refs — every `--tug7-*` name the deck writes must be a token a
 * theme defines.
 *
 * A theme token is defined in `styles/themes/*.css` and nowhere else, so a
 * name no theme defines is a spelling of nothing. CSS does not complain about
 * one: `var(--tug7-nothing)` with no fallback makes the property invalid at
 * computed-value time, so a `color` quietly inherits, a `background` goes
 * transparent and a `border` disappears, and with a fallback the fallback
 * paints instead of the theme. The contrast audit is no help either — a
 * pairing that names a surface no theme resolves is skipped without a word.
 * Every one of those has shipped: an in-flight dot that never painted, a whole
 * family of popup pairings the audit never checked, a picker match highlight
 * and a question panel with no tint at all.
 *
 * Two rules:
 *
 *  1. **Defined somewhere.** A full name is checked wherever it appears — a
 *     `var()`, a `@tug-renders-on` annotation, a `@tug-pairings` row, a string
 *     in TypeScript, a doc comment. A name ending in `-` is a family prefix
 *     (`--tug7-field-*`, a template string's head) and is not a token.
 *  2. **Defined everywhere, or read with a fallback.** A token only some
 *     themes define is legitimate (a light boat can carry a slot the dark
 *     ships do not need), but then every `var()` of it must carry a fallback,
 *     or the themes without it paint nothing.
 *
 * The checker is pure ({@link findThemeTokenProblems}) so its test drives it
 * over fixtures; the CLI below walks the tree and prints `file:line`.
 *
 * Usage: bun run scripts/theme-token-refs.ts
 */

import fs from "fs";
import path from "path";

export interface ThemeTokenProblem {
  file: string;
  line: number;
  token: string;
  kind: "undefined" | "partial-without-fallback";
  /** For a partial token: the themes that lack it. */
  missingFrom?: string[];
}

const NAME_RE = /--tug7-[A-Za-z0-9_-]+/g;
const DEF_RE = /(--tug7-[A-Za-z0-9_-]+)\s*:/g;

/** The `--tug7-*` names a theme file defines. */
export function themeDefinitions(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of css.matchAll(DEF_RE)) out.add(m[1]);
  return out;
}

/**
 * Check `files` against `themes` (theme name → the names it defines).
 * Problems come back in file order, then line order.
 */
export function findThemeTokenProblems(
  themes: ReadonlyMap<string, ReadonlySet<string>>,
  files: ReadonlyArray<{ path: string; text: string }>,
): ThemeTokenProblem[] {
  const everywhere = new Set<string>();
  const anywhere = new Set<string>();
  let first = true;
  for (const defs of themes.values()) {
    for (const name of defs) anywhere.add(name);
    if (first) {
      for (const name of defs) everywhere.add(name);
      first = false;
    } else {
      for (const name of [...everywhere]) if (!defs.has(name)) everywhere.delete(name);
    }
  }

  const problems: ThemeTokenProblem[] = [];
  for (const file of files) {
    const lines = file.text.split("\n");
    lines.forEach((lineText, index) => {
      for (const m of lineText.matchAll(NAME_RE)) {
        const token = m[0];
        if (token.endsWith("-")) continue; // a family prefix, not a token
        const start = m.index ?? 0;
        const before = lineText.slice(Math.max(0, start - 4), start);
        const after = lineText.slice(start + token.length);
        if (!anywhere.has(token)) {
          problems.push({ file: file.path, line: index + 1, token, kind: "undefined" });
          continue;
        }
        if (everywhere.has(token)) continue;
        const isVarRead = before.endsWith("var(");
        if (isVarRead && !/^\s*,/.test(after)) {
          const missingFrom = [...themes.entries()]
            .filter(([, defs]) => !defs.has(token))
            .map(([name]) => name);
          problems.push({
            file: file.path,
            line: index + 1,
            token,
            kind: "partial-without-fallback",
            missingFrom,
          });
        }
      }
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const TUGDECK = path.resolve(import.meta.dir, "..");
const THEMES_DIR = path.join(TUGDECK, "styles/themes");
const SCAN_ROOTS = [path.join(TUGDECK, "src"), path.join(TUGDECK, "styles")];
const SCAN_EXT = new Set([".css", ".ts", ".tsx"]);
/** Generated inventories and tests are not authored references. */
const SKIP_DIRS = new Set(["node_modules", "generated", "__tests__", "themes"]);

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (SCAN_EXT.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
}

function main(): void {
  const themes = new Map<string, Set<string>>();
  for (const name of fs.readdirSync(THEMES_DIR).sort()) {
    if (!name.endsWith(".css")) continue;
    const css = fs.readFileSync(path.join(THEMES_DIR, name), "utf-8");
    themes.set(path.basename(name, ".css"), themeDefinitions(css));
  }
  const paths: string[] = [];
  for (const root of SCAN_ROOTS) walk(root, paths);
  paths.sort();
  const files = paths.map((p) => ({
    path: path.relative(TUGDECK, p),
    text: fs.readFileSync(p, "utf-8"),
  }));

  const problems = findThemeTokenProblems(themes, files);
  if (problems.length === 0) {
    console.log(
      `✓ theme-token-refs: every --tug7-* name in ${files.length} files is defined by the ${themes.size} themes.`,
    );
    return;
  }
  for (const p of problems) {
    if (p.kind === "undefined") {
      console.log(`${p.file}:${p.line}: ${p.token} — no theme defines it`);
    } else {
      console.log(
        `${p.file}:${p.line}: ${p.token} — read with no fallback, but ${p.missingFrom?.join(", ")} do not define it`,
      );
    }
  }
  console.log(`\n✗ theme-token-refs: ${problems.length} reference(s) to tokens the themes do not define.`);
  process.exit(1);
}

if (import.meta.main) main();
