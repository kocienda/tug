/**
 * The diagram forms a figure of code can take, each with a sample figure,
 * read from tugcast for the surfaces that list them.
 *
 * The record is tugcast's (`GET /api/chart/forms?kind=diagram`), the list
 * `tugtool chart forms --kind diagram --json` prints. It ships in the binary
 * and is the same for every project, so there is one read and no per-project
 * state: a surface that comes to the list reads it unless it is already held
 * or on its way. The read is bounded, so a list with no answer becomes a
 * `failure` rather than leaving a surface waiting [L33], and a surface that
 * arrives after a failure reads again. Reads enter React through
 * `useSyncExternalStore` [L02].
 */

import { useEffect } from "react";

import { useSyncExternalStore } from "@/lib/gesture-scope";

/** How long the read may take before it counts as failed. */
const READ_TIMEOUT_MS = 30_000;

const FORMS_URL = "/api/chart/forms?kind=diagram";

/** One diagram form as the list names it. */
export interface DiagramForm {
  name: string;
  /** Completes "the reader can…". */
  shows: string;
  /** The everyday words that ask for the form. */
  said: readonly string[];
  /** A whole request that draws one, as an example. */
  ask: string;
  /** A small `tugdiagram` spec in the form. */
  sample: unknown;
}

/**
 * `forms` is null until the list has answered. `failure` says why the latest
 * read failed, and forms read before it stand beside it.
 */
export interface DiagramFormsState {
  forms: readonly DiagramForm[] | null;
  failure: string | null;
}

const EMPTY: DiagramFormsState = Object.freeze({ forms: null, failure: null });
let state: DiagramFormsState = EMPTY;
let reading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/**
 * The list's answer, narrowed to the diagram forms: a row of another kind, or
 * one with a field of the wrong type or no sample, is dropped.
 */
export function narrowDiagramForms(body: unknown): DiagramForm[] {
  if (typeof body !== "object" || body === null) return [];
  const raw = (body as { forms?: unknown }).forms;
  if (!Array.isArray(raw)) return [];
  const out: DiagramForm[] = [];
  for (const r of raw) {
    if (typeof r !== "object" || r === null) continue;
    const row = r as Record<string, unknown>;
    if (
      row.kind === "diagram" &&
      typeof row.name === "string" &&
      row.name.length > 0 &&
      typeof row.shows === "string" &&
      Array.isArray(row.said) &&
      row.said.every((word) => typeof word === "string") &&
      typeof row.ask === "string" &&
      typeof row.sample === "object" &&
      row.sample !== null
    ) {
      out.push({
        name: row.name,
        shows: row.shows,
        said: row.said as string[],
        ask: row.ask,
        sample: row.sample,
      });
    }
  }
  return out;
}

function publish(next: DiagramFormsState): void {
  state = next;
  for (const cb of [...listeners]) cb();
}

async function read(): Promise<void> {
  let forms: DiagramForm[];
  try {
    const response = await fetch(FORMS_URL, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    forms = narrowDiagramForms(await response.json());
  } catch (error) {
    publish({ forms: state.forms, failure: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (forms.length === 0) {
    publish({ forms: state.forms, failure: "the list named no diagram forms" });
    return;
  }
  publish({ forms, failure: null });
}

/**
 * Read the list unless it is already held without a failure. A read already
 * on its way is joined, so several surfaces arriving together take one read.
 */
export function loadDiagramForms(): Promise<void> {
  if (reading !== null) return reading;
  if (state.forms !== null && state.failure === null) return Promise.resolve();
  reading = read().finally(() => {
    reading = null;
  });
  return reading;
}

/** What is known of the diagram forms, with no read taken. */
export function diagramForms(): DiagramFormsState {
  return state;
}

/** Forget what was read. For tests, which share the module's one state. */
export function resetDiagramFormsForTest(): void {
  state = EMPTY;
  reading = null;
}

/** The diagram forms, read when a surface first comes to them. */
export function useDiagramForms(): DiagramFormsState {
  useEffect(() => {
    void loadDiagramForms();
  }, []);
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    diagramForms,
    () => EMPTY,
  );
}
