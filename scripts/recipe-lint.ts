#!/usr/bin/env bun
/**
 * recipe-lint — a long `just` recipe reports its progress with a unit, or it
 * does not run under `just lint`.
 *
 * The Bash block's run panel draws for a command that reports with a unit
 * (`tugtool progress --unit …`, `tugtool progress phase`, `tugtool test run`)
 * and nothing draws for one that does not, so a long recipe that forgets to
 * report sits silent for minutes. This reads `Justfile` and refuses each
 * listed long recipe that neither reports itself nor delegates to something
 * that does: a dependency in its header, a `just <recipe>` it runs, or a
 * script under `scripts/` or `tugrust/scripts/` it calls.
 *
 * Exemptions are named here with a one-line reason each, because a bare
 * exemption is how the coverage decays again. A listed recipe the Justfile
 * no longer has is a failure too, so the list cannot rot in silence.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** The long recipes: each must report with a unit, or be exempt below. */
export const LONG_RECIPES = [
  "build",
  "build-app",
  "app-debug",
  "app-release",
  "wasm",
  "release",
  "dmg",
  "notarize",
  "golden",
  "tugmark-fuzz",
  "test-swift",
  "test-standalone",
];

/** Listed recipes that report nothing, each with the reason it may. */
export const EXEMPT: Record<string, string> = {
  release:
    "an interactive wizard: its wall time is the user answering its questions, and the long work it runs (`just lint`, `just bless`) is those recipes' to report",
};

/** A line that reports with a unit, in a recipe body or a script it runs. */
const REPORTS = [
  /\bprogress\b[^\n]*--unit\b/,
  /\bprogress\s+phase\b/,
  /\breport-phase\.sh\b/,
  /\btugtool(?:["'\s}][^\n]*)?\s+test\s+run\b/,
  /\bTUGTOOL[A-Z_]*"?\s+test\s+run\b/,
];

/** A script the recipe runs, by its path from the repository root. */
const SCRIPT_REF = /(?:^|[\s"'=(])((?:tugrust\/)?scripts\/[\w./-]+\.(?:sh|py|ts))\b/g;

export interface Recipe {
  name: string;
  deps: string[];
  body: string;
}

/** Every recipe in a Justfile: header, dependencies and body lines. */
export function parseRecipes(text: string): Map<string, Recipe> {
  const recipes = new Map<string, Recipe>();
  let current: Recipe | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (current && (line === "" || /^\s/.test(line))) {
      current.body += line + "\n";
      continue;
    }
    current = null;
    // `name params…: deps…` at column 0, a parameter possibly defaulted
    // (`seed=""`); `name := value` is an assignment, and its `:` is never
    // the recipe colon.
    const header = /^(@?[A-Za-z_][\w-]*)(.*?):(?!=)\s*(.*)$/.exec(line);
    if (!header) continue;
    const name = header[1].replace(/^@/, "");
    const deps = header[3]
      .replace(/\(([^)]*)\)/g, "")
      .split(/\s+/)
      .map((d) => d.replace(/^\(|\)$/g, ""))
      .filter((d) => d && d !== "&&");
    current = { name, deps, body: "" };
    recipes.set(name, current);
  }
  return recipes;
}

export interface LintOptions {
  listed?: string[];
  exempt?: Record<string, string>;
  /** Reads a script the recipe runs, by repository-relative path; `null` when there is none. */
  readScript?: (path: string) => string | null;
}

function reportsIn(text: string): boolean {
  return REPORTS.some((re) => re.test(text));
}

/** Whether `name` reports with a unit, itself or through what it runs. */
export function recipeReports(
  recipes: Map<string, Recipe>,
  name: string,
  readScript: (path: string) => string | null,
  seen = new Set<string>(),
): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  const recipe = recipes.get(name);
  if (!recipe) return false;
  if (reportsIn(recipe.body)) return true;
  for (const dep of recipe.deps) {
    if (recipeReports(recipes, dep, readScript, seen)) return true;
  }
  for (const m of recipe.body.matchAll(/(?:^|[\s;&|(])just\s+([A-Za-z_][\w-]*)/gm)) {
    if (recipeReports(recipes, m[1], readScript, seen)) return true;
  }
  for (const m of recipe.body.matchAll(SCRIPT_REF)) {
    const script = readScript(m[1]);
    if (script !== null && reportsIn(script)) return true;
  }
  return false;
}

/** The failures: one line per listed recipe that reports nothing. */
export function lintRecipes(justfile: string, options: LintOptions = {}): string[] {
  const listed = options.listed ?? LONG_RECIPES;
  const exempt = options.exempt ?? EXEMPT;
  const readScript =
    options.readScript ??
    ((path: string) => {
      try {
        return readFileSync(join(ROOT, path), "utf8");
      } catch {
        return null;
      }
    });
  const recipes = parseRecipes(justfile);
  const failures: string[] = [];
  for (const name of listed) {
    if (!recipes.has(name)) {
      failures.push(`\`${name}\` is listed as a long recipe but the Justfile has no such recipe — drop it from the list, or restore it`);
      continue;
    }
    if (name in exempt) continue;
    if (!recipeReports(recipes, name, readScript)) {
      failures.push(
        `\`${name}\` runs long and reports no unit — call \`tugtool progress phase\` (via tugrust/scripts/report-phase.sh), \`tugtool progress --unit\` or \`tugtool test run\`, delegate to a recipe or script that does, or exempt it here with a reason`,
      );
    }
  }
  for (const name of Object.keys(exempt)) {
    if (!listed.includes(name)) {
      failures.push(`\`${name}\` is exempt but not listed — an exemption with nothing to exempt`);
    }
  }
  return failures;
}

if (import.meta.main) {
  const path = process.argv[2] ?? join(ROOT, "Justfile");
  const failures = lintRecipes(readFileSync(path, "utf8"));
  if (failures.length > 0) {
    console.error(`recipe-lint: ${failures.length} long recipe(s) report no unit\n`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  const exempted = Object.keys(EXEMPT).length;
  console.log(
    `recipe-lint: ${LONG_RECIPES.length - exempted} long recipes report with a unit, ${exempted} exempt with a reason`,
  );
}
