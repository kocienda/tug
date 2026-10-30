/**
 * The well-known chart recipes, each run live over a project, read from
 * tugcast for the gallery's Chart Recipes card.
 *
 * The record is tugcast's (`GET /api/chart/list`, then
 * `GET /api/chart/<recipe>?project=<dir>` for each recipe), and a read is taken
 * when the card comes to a project. Every read is bounded, so a recipe with no
 * answer becomes `failed` rather than leaving its section waiting [L33]. Reads
 * enter React through `useSyncExternalStore` [L02].
 */

import { useEffect } from "react";

import { useSyncExternalStore } from "@/lib/gesture-scope";

/** How long one read may take before it counts as failed. */
const READ_TIMEOUT_MS = 30_000;

/** One recipe as the list names it. */
export interface CatalogRecipe {
  name: string;
  question: string;
  form: string;
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

/** `rows` is null until the list has answered; `listFailure` says why it never will. */
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
      typeof row.form === "string"
    ) {
      out.push({ name: row.name, question: row.question, form: row.form });
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

/** Read the list, then run each recipe over `projectDir`, publishing each answer as it lands. */
export async function refreshRecipes(projectDir: string): Promise<void> {
  let catalog: CatalogRecipe[];
  try {
    catalog = narrowCatalog(await readJson("/api/chart/list"));
  } catch (error) {
    publish(projectDir, { rows: null, listFailure: messageOf(error) });
    return;
  }
  if (catalog.length === 0) {
    publish(projectDir, { rows: null, listFailure: "the list named no recipes" });
    return;
  }
  publish(projectDir, {
    rows: catalog.map((recipe) => ({ ...recipe, outcome: { kind: "pending" } })),
    listFailure: null,
  });
  await Promise.all(
    catalog.map(async ({ name }) => {
      const outcome = await readOutcome(name, projectDir);
      const rows = stateByProject.get(projectDir)?.rows ?? [];
      publish(projectDir, {
        rows: rows.map((row) => (row.name === name ? { ...row, outcome } : row)),
        listFailure: null,
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
