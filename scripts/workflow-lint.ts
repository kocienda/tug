#!/usr/bin/env bun
/**
 * workflow-lint — the CI workflows call recipes that exist, under the budget
 * and the bun the checkout pins. A workflow is read by nobody until it runs
 * on a push, so a recipe renamed in the Justfile, a job that lost its
 * `timeout-minutes`, or a `setup-bun` step that drifted back to a floating
 * version is a red that arrives an hour after the change that caused it.
 * This is that reading, as a lint over the files in `.github/workflows/`:
 *
 * - every file parses as YAML;
 * - every `run:` line of the form `just <recipe>` names a recipe
 *   `just --summary` lists;
 * - every step in `ci.yml` that runs a `just` recipe carries
 *   `timeout-minutes: 5` — the budget on the verdict, a red to investigate
 *   rather than a number to raise — and every job there carries a
 *   `timeout-minutes` of its own, the cap on a cold build step;
 * - every `oven-sh/setup-bun` step carries `bun-version-file: .bun-version`
 *   and none carries `bun-version:`.
 *
 * Decision: briefs/test-lanes-reform-brief.md, [B06] and [B07].
 *
 *   bun scripts/workflow-lint.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");

/** The budget, in minutes, on every `just` step of `ci.yml`. */
export const VERDICT_BUDGET_MINUTES = 5;
export const BUN_VERSION_FILE = ".bun-version";

export interface WorkflowFile {
  /** Repository-relative or bare; only its basename is read. */
  path: string;
  text: string;
}

interface Step {
  name?: unknown;
  uses?: unknown;
  run?: unknown;
  "timeout-minutes"?: unknown;
  with?: Record<string, unknown>;
}

interface Job {
  "timeout-minutes"?: unknown;
  steps?: unknown;
}

/** The recipes `just <recipe>` lines invoke, in document order, with their line numbers. */
function justCalls(text: string): { recipe: string; line: number }[] {
  const calls: { recipe: string; line: number }[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:-\s+)?(?:run:\s+)?just\s+([A-Za-z_][\w-]*)\b/.exec(lines[i]);
    if (m) calls.push({ recipe: m[1], line: i + 1 });
  }
  return calls;
}

/** The failures across `files`, one line each, given the recipes the Justfile has. */
export function lintWorkflows(files: WorkflowFile[], recipes: Iterable<string>): string[] {
  const known = new Set(recipes);
  const failures: string[] = [];
  for (const file of files) {
    const name = basename(file.path);
    let doc: unknown;
    try {
      doc = Bun.YAML.parse(file.text);
    } catch (error) {
      failures.push(`${name}: does not parse as YAML: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (typeof doc !== "object" || doc === null) {
      failures.push(`${name}: does not parse as a YAML document`);
      continue;
    }

    for (const call of justCalls(file.text)) {
      if (!known.has(call.recipe)) {
        failures.push(`${name}:${call.line}: \`just ${call.recipe}\` names no recipe in \`just --summary\``);
      }
    }

    const jobs = (doc as { jobs?: unknown }).jobs;
    if (typeof jobs !== "object" || jobs === null) continue;
    for (const [jobName, jobValue] of Object.entries(jobs as Record<string, unknown>)) {
      if (typeof jobValue !== "object" || jobValue === null) continue;
      const job = jobValue as Job;
      if (name === "ci.yml" && typeof job["timeout-minutes"] !== "number") {
        failures.push(
          `${name}: job \`${jobName}\` must carry a \`timeout-minutes\` — the cap on its cold build step`,
        );
      }
      if (!Array.isArray(job.steps)) continue;
      for (const [index, stepValue] of job.steps.entries()) {
        if (typeof stepValue !== "object" || stepValue === null) continue;
        const step = stepValue as Step;
        if (
          name === "ci.yml" &&
          typeof step.run === "string" &&
          justCalls(step.run).length > 0 &&
          step["timeout-minutes"] !== VERDICT_BUDGET_MINUTES
        ) {
          failures.push(
            `${name}: job \`${jobName}\` step ${index + 1} (${typeof step.name === "string" ? step.name : step.run.trim()}) must carry \`timeout-minutes: ${VERDICT_BUDGET_MINUTES}\` — the budget on the verdict; a step over it is a red to investigate, not a number to raise`,
          );
        }
        if (typeof step.uses !== "string" || !step.uses.startsWith("oven-sh/setup-bun")) continue;
        const at = `${name}: job \`${jobName}\` step ${index + 1} (${step.uses})`;
        const with_ = step.with ?? {};
        if ("bun-version" in with_) {
          failures.push(`${at}: carries \`bun-version:\` — the pin is \`${BUN_VERSION_FILE}\`, read with \`bun-version-file\``);
        }
        if (with_["bun-version-file"] !== BUN_VERSION_FILE) {
          failures.push(`${at}: must carry \`bun-version-file: ${BUN_VERSION_FILE}\``);
        }
      }
    }
  }
  return failures;
}

/** Every file under `.github/workflows/`. */
export function readWorkflows(dir = WORKFLOWS): WorkflowFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((f) => ({ path: join(dir, f), text: readFileSync(join(dir, f), "utf8") }));
}

/** The recipe names `just --summary` prints for this checkout's Justfile. */
export function readRecipes(root = ROOT): string[] {
  const out = Bun.spawnSync(["just", "--summary"], { cwd: root, stderr: "pipe" });
  if (out.exitCode !== 0) {
    throw new Error(`just --summary failed: ${out.stderr.toString().trim()}`);
  }
  return out.stdout.toString().trim().split(/\s+/).filter(Boolean);
}

if (import.meta.main) {
  const files = readWorkflows();
  const recipes = readRecipes();
  const failures = lintWorkflows(files, recipes);
  if (failures.length > 0) {
    console.error(`workflow-lint: ${failures.length} finding(s) across ${files.length} workflow file(s)\n`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  const called = new Set(files.flatMap((f) => justCalls(f.text).map((c) => c.recipe)));
  console.log(
    `workflow-lint: ${files.length} workflow files parse, call ${called.size} recipes the Justfile has (${[...called].sort().join(", ")}), budget and bun pin in place`,
  );
}
