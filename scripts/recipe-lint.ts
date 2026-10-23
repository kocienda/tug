#!/usr/bin/env bun
/**
 * recipe-lint — a long `just` recipe reports with a unit, or it does not run
 * under `just lint`.
 *
 * The Bash block's report panel draws for a command that reports with a unit
 * (`tugtool report count --unit …`, `tugtool report phase`, `tugtool report
 * unit`, `tugtool test run`)
 * and nothing draws for one that does not, so a long recipe that forgets to
 * report sits silent for minutes. This reads `Justfile` and refuses each
 * listed long recipe that neither reports itself nor delegates to something
 * that does: a dependency in its header, a `just <recipe>` it runs, or a
 * script under `scripts/` or `tugrust/scripts/` it calls.
 *
 * Exemptions are named here with a one-line reason each, because a bare
 * exemption is how the coverage decays again. A listed recipe the Justfile
 * no longer has is a failure too, so the list cannot rot in silence.
 *
 * The hand list is joined by a derived one: every `just <recipe>` head the
 * gaps record (`tugtool report gaps --json`) shows with a median past the
 * threshold, so a recipe that grew slow is caught without anyone adding it.
 * The record is this machine's telemetry, so a machine with no `tugtool` or
 * no record derives nothing, and a derived head this Justfile has no recipe
 * for — another project's — is not this lint's to judge.
 */
import { existsSync, readFileSync } from "node:fs";
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
  "test-fast",
  "test-slow",
  "test-rust-slow",
  "test-ts-slow",
  "lint",
  "lint-audit",
  "lint-ts",
  "lint-rust",
  "ci",
  "ci-full",
];

/** Listed recipes that report nothing, each with the reason it may. */
export const EXEMPT: Record<string, string> = {
  release:
    "an interactive wizard: its wall time is the user answering its questions, and the long work it runs (`just lint`, `just bless`) is those recipes' to report",
};

/** A line that reports with a unit, in a recipe body or a script it runs. */
const REPORTS = [
  /\breport\s+count\b[^\n]*--unit\b/,
  /\breport\s+phase\b/,
  /\breport\s+unit\b/,
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

/** How long a call runs before its silence is a gap (`GAP_THRESHOLD_MS`). */
export const GAP_THRESHOLD_MS = 20_000;

/** One head of `tugtool report gaps --json`, as far as the lint reads it. */
export interface GapHead {
  head: string;
  medianMs: number;
}

/**
 * The recipes the gaps record says run long: each `just <recipe>` head in
 * its gaps whose median is past the threshold and whose recipe `recipes`
 * has. The stalled calls are hangs, not long recipes, and are not read.
 */
export function derivedRecipes(gaps: GapHead[], recipes: Map<string, Recipe>): string[] {
  const derived: string[] = [];
  for (const gap of gaps) {
    const m = /^just\s+([A-Za-z_][\w-]*)$/.exec(gap.head);
    // A tugtool from before the record kept medians reports none: no evidence.
    if (!m || typeof gap.medianMs !== "number" || gap.medianMs <= GAP_THRESHOLD_MS) continue;
    if (recipes.has(m[1]) && !derived.includes(m[1])) derived.push(m[1]);
  }
  return derived;
}

/** This machine's gaps, through the workspace's tugtool or PATH's; none when neither answers. */
export function readGaps(): GapHead[] {
  const local = join(ROOT, "tugrust", "target", "debug", "tugtool");
  const bin = existsSync(local) ? local : Bun.which("tugtool");
  if (!bin) return [];
  try {
    const out = Bun.spawnSync([bin, "--json", "report", "gaps"], { stderr: "ignore" });
    if (out.exitCode !== 0) return [];
    const gaps = JSON.parse(out.stdout.toString())?.data?.gaps;
    return Array.isArray(gaps) ? gaps : [];
  } catch {
    return [];
  }
}

export interface LintOptions {
  listed?: string[];
  /** Long recipes the gaps record names, checked beside the hand list. */
  derived?: string[];
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
  const derived = (options.derived ?? []).filter((name) => recipes.has(name) && !listed.includes(name));
  for (const name of [...listed, ...derived]) {
    if (!recipes.has(name)) {
      failures.push(`\`${name}\` is listed as a long recipe but the Justfile has no such recipe — drop it from the list, or restore it`);
      continue;
    }
    if (name in exempt) continue;
    if (!recipeReports(recipes, name, readScript)) {
      const why = derived.includes(name) ? " (the gaps record shows its median past the threshold)" : "";
      failures.push(
        `\`${name}\` runs long${why} and reports no unit — call \`tugtool report phase\` (via tugrust/scripts/report-phase.sh), \`tugtool report unit\`, \`tugtool report count --unit\` or \`tugtool test run\`, delegate to a recipe or script that does, or exempt it here with a reason`,
      );
    }
  }
  for (const name of Object.keys(exempt)) {
    if (!listed.includes(name) && !derived.includes(name)) {
      failures.push(`\`${name}\` is exempt but not listed — an exemption with nothing to exempt`);
    }
  }
  return failures;
}

if (import.meta.main) {
  const path = process.argv[2] ?? join(ROOT, "Justfile");
  const justfile = readFileSync(path, "utf8");
  const derived = derivedRecipes(readGaps(), parseRecipes(justfile));
  const failures = lintRecipes(justfile, { derived });
  if (failures.length > 0) {
    console.error(`recipe-lint: ${failures.length} long recipe(s) report no unit\n`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  const exempted = Object.keys(EXEMPT).length;
  console.log(
    `recipe-lint: ${LONG_RECIPES.length - exempted} long recipes report with a unit, ${exempted} exempt with a reason; ${derived.filter((n) => !LONG_RECIPES.includes(n)).length} more from the gaps record`,
  );
}
