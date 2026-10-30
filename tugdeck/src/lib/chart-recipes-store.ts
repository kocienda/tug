/**
 * The well-known chart recipes, each run live over a project, read from
 * tugcast for the surfaces that show them.
 *
 * The record is tugcast's (`GET /api/chart/list`, then
 * `GET /api/chart/<recipe>?project=<dir>` for each recipe), and a read is taken
 * when a surface comes to a project. A row keeps the outcome it holds until the
 * new answer lands, so a re-read never blanks a figure. Every read is bounded,
 * so a recipe with no answer becomes `failed` rather than leaving its section
 * waiting [L33]. Reads enter React through `useSyncExternalStore` [L02].
 */

import { useEffect } from "react";

import { useSyncExternalStore } from "@/lib/gesture-scope";

/** How long one read may take before it counts as failed. */
const READ_TIMEOUT_MS = 30_000;

/** One recipe as the list names it. */
export interface CatalogRecipe {
  name: string;
  question: string;
  /** One sentence on what the recipe's data tells the reader. */
  tells: string;
  /** The section the recipe sits in; sections read in the order the list names them. */
  group: string;
  form: string;
  /** A small spec to draw when the project has no data for the recipe. */
  sample: unknown;
}

/** Where one recipe's run has got to. */
export type RecipeOutcome =
  | { kind: "pending" }
  | { kind: "chart"; summary: string; spec: unknown }
  | { kind: "noData"; summary: string }
  | { kind: "failed"; message: string };

export interface RecipeRow extends CatalogRecipe {
  outcome: RecipeOutcome;
}

/**
 * `rows` is null until the list has answered. `listFailure` says why the latest
 * read of the list failed, and any rows read before it stand beside it.
 */
export interface ChartRecipesState {
  rows: readonly RecipeRow[] | null;
  listFailure: string | null;
}

const EMPTY: ChartRecipesState = Object.freeze({ rows: null, listFailure: null });
const stateByProject = new Map<string, ChartRecipesState>();
const listeners = new Set<() => void>();

/** The list's answer, narrowed: a row with a field of the wrong type is dropped. */
export function narrowCatalog(body: unknown): CatalogRecipe[] {
  if (typeof body !== "object" || body === null) return [];
  const raw = (body as { recipes?: unknown }).recipes;
  if (!Array.isArray(raw)) return [];
  const out: CatalogRecipe[] = [];
  for (const r of raw) {
    if (typeof r !== "object" || r === null) continue;
    const row = r as Record<string, unknown>;
    if (
      typeof row.name === "string" &&
      row.name.length > 0 &&
      typeof row.question === "string" &&
      typeof row.tells === "string" &&
      typeof row.group === "string" &&
      typeof row.form === "string" &&
      typeof row.sample === "object" &&
      row.sample !== null
    ) {
      out.push({
        name: row.name,
        question: row.question,
        tells: row.tells,
        group: row.group,
        form: row.form,
        sample: row.sample,
      });
    }
  }
  return out;
}

/** A recipe's answer, narrowed. A body that says neither good nor bad is a failure. */
export function narrowOutcome(body: unknown): RecipeOutcome {
  if (typeof body !== "object" || body === null) {
    return { kind: "failed", message: "the answer was not an object" };
  }
  const answer = body as Record<string, unknown>;
  if (answer.status === "error") {
    const message = typeof answer.message === "string" ? answer.message : "the read failed";
    return { kind: "failed", message };
  }
  if (answer.status !== "ok" || typeof answer.summary !== "string") {
    return { kind: "failed", message: "the answer was malformed" };
  }
  if (answer.spec === null) return { kind: "noData", summary: answer.summary };
  if (typeof answer.spec !== "object" || answer.spec === undefined) {
    return { kind: "failed", message: "the answer was malformed" };
  }
  return { kind: "chart", summary: answer.summary, spec: answer.spec };
}

/** One section of the recipes: a group, and its rows in catalog order. */
export interface RecipeSection {
  group: string;
  rows: RecipeRow[];
}

/** The rows gathered by group, sections in the order the catalog first names them. Pure. */
export function recipeSections(rows: readonly RecipeRow[]): RecipeSection[] {
  const sections = new Map<string, RecipeRow[]>();
  for (const row of rows) {
    const held = sections.get(row.group);
    if (held === undefined) sections.set(row.group, [row]);
    else held.push(row);
  }
  return [...sections].map(([group, members]) => ({ group, rows: members }));
}

/**
 * What a row shows. `spec` is the figure, null until a read has answered; `sampled`
 * says it is the recipe's sample rather than the project's numbers; `line` is the
 * text beside it.
 */
export interface RecipeFace {
  state: "pending" | "live" | "no-data" | "failed";
  spec: unknown;
  sampled: boolean;
  line: string | null;
}

/** A row's face: a chart draws live, and no data or a failed read draws the sample. Pure. */
export function recipeFace(row: RecipeRow): RecipeFace {
  const { outcome, sample } = row;
  switch (outcome.kind) {
    case "pending":
      return { state: "pending", spec: null, sampled: false, line: null };
    case "chart":
      return { state: "live", spec: outcome.spec, sampled: false, line: outcome.summary };
    case "noData":
      return { state: "no-data", spec: sample, sampled: true, line: outcome.summary };
    case "failed":
      return { state: "failed", spec: sample, sampled: true, line: `Could not read: ${outcome.message}` };
  }
}

function publish(projectDir: string, state: ChartRecipesState): void {
  stateByProject.set(projectDir, state);
  for (const cb of [...listeners]) cb();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  return response.json();
}

async function readOutcome(name: string, projectDir: string): Promise<RecipeOutcome> {
  try {
    return narrowOutcome(
      await readJson(`/api/chart/${encodeURIComponent(name)}?project=${encodeURIComponent(projectDir)}`),
    );
  } catch (error) {
    return { kind: "failed", message: messageOf(error) };
  }
}

/**
 * Read the list, then run each recipe over `projectDir`, publishing each answer
 * as it lands. A row already held keeps its outcome until then, a new one starts
 * `pending`, and a row the list no longer names leaves.
 */
export async function refreshRecipes(projectDir: string): Promise<void> {
  let catalog: CatalogRecipe[];
  const held = stateByProject.get(projectDir)?.rows ?? null;
  try {
    catalog = narrowCatalog(await readJson("/api/chart/list"));
  } catch (error) {
    publish(projectDir, { rows: held, listFailure: messageOf(error) });
    return;
  }
  if (catalog.length === 0) {
    publish(projectDir, { rows: held, listFailure: "the list named no recipes" });
    return;
  }
  publish(projectDir, {
    rows: catalog.map((recipe) => ({
      ...recipe,
      outcome: held?.find((row) => row.name === recipe.name)?.outcome ?? { kind: "pending" },
    })),
    listFailure: null,
  });
  await Promise.all(
    catalog.map(async ({ name }) => {
      const outcome = await readOutcome(name, projectDir);
      const current = stateByProject.get(projectDir);
      publish(projectDir, {
        rows: (current?.rows ?? []).map((row) => (row.name === name ? { ...row, outcome } : row)),
        listFailure: current?.listFailure ?? null,
      });
    }),
  );
}

/** What is known of the recipes over `projectDir`, with no read taken. */
export function chartRecipesFor(projectDir: string | null): ChartRecipesState {
  if (projectDir === null) return EMPTY;
  return stateByProject.get(projectDir) ?? EMPTY;
}

/** The recipes run over `projectDir`, read afresh whenever it changes. */
export function useChartRecipes(projectDir: string | null): ChartRecipesState {
  useEffect(() => {
    if (projectDir !== null) void refreshRecipes(projectDir);
  }, [projectDir]);
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => chartRecipesFor(projectDir),
    () => EMPTY,
  );
}
