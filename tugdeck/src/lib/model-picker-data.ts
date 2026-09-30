/**
 * Model-picker data — pure resolvers that turn a metadata snapshot + the
 * persisted catalog into the picker's option list, active value, and labels.
 *
 * Split out from the React picker so it is unit-testable without a DOM
 * (pure-logic `bun:test` only — no fake-DOM render tests).
 *
 * **There is NO hardcoded model list.** Claude's live capabilities (persisted
 * as the model catalog, [model-catalog.ts]) are the only source of model
 * data. When nothing has ever been reported — a fresh install where no
 * session has run — the picker offers exactly one honest row: the `default`
 * selector, with an explanation that the full list arrives after the first
 * request ({@link UNKNOWN_CATALOG_OPTION}). `default` is the one selector
 * that is always valid regardless of knowledge: it forces no particular
 * model, so the row is truthful with zero data behind it.
 *
 * **Selectors vs resolved ids.** The picker rows are *selectors* the
 * `model_change` frame carries (`default` / `sonnet` / `haiku` / …), matching
 * the Claude Code terminal's `/model` picker. The live `system_metadata.model`
 * is a *resolved* model id (e.g. `claude-opus-4-8[1m]`) — these never
 * string-match, so the active row is mapped back to its selector by matching
 * against the rows themselves ({@link modelIdToSelector}) — data-driven, so a
 * family claude adds (fable, opus, …) maps the moment it appears in the list,
 * with no hardcoded family set to go stale.
 *
 * @module lib/model-picker-data
 */

import type { CapabilityModel } from "./session-metadata-store";
import { findModelRow, modelRowTitle } from "./model-label";

/**
 * The single honest option offered when no model catalog exists yet (fresh
 * install, no session has ever reported capabilities). NOT a catalog and
 * never persisted — a UI placeholder whose description says exactly why the
 * list is short. The `default` selector forces no particular model, so this
 * row is valid with zero model knowledge.
 */
export const UNKNOWN_CATALOG_OPTION: CapabilityModel = {
  value: "default",
  displayName: "Default",
  description: "The full model list becomes available after the first request to Claude.",
};

export interface PickerModels {
  /** The options to render (live list, else the persisted catalog, else the
   *  single {@link UNKNOWN_CATALOG_OPTION} placeholder). */
  options: CapabilityModel[];
  /** The value of the row to mark active. */
  activeValue: string | null;
}

/**
 * Map a resolved model id (`claude-sonnet-4-6`, `claude-opus-4-8[1m]`, …),
 * an optimistic display label, or a bare selector back to the picker
 * selector it belongs to — matched against `rows` (the live capability list
 * or persisted catalog) via {@link findModelRow}, so the mapping is
 * data-driven and a new family claude ships maps the moment it appears.
 *
 * When the matched row describes the SAME model as the `default` row
 * (identical title, {@link modelRowTitle} — e.g. an explicit `Opus 5.5` row
 * alongside a Default row whose description leads with `Opus 5.5`), the
 * selector is `default`, mirroring the terminal, which checkmarks "Default"
 * for a session on the account default. The titles are compared rather than
 * the descriptions because from 2.1.285 the two rows carry different
 * taglines for the same model. Anything unmatched also falls to `default`.
 */
export function modelIdToSelector(
  modelId: string,
  rows: CapabilityModel[],
): string {
  const row = findModelRow(modelId, rows);
  if (row === null) return "default";
  if (row.value !== "default") {
    const def = rows.find((r) => r.value === "default");
    if (def !== undefined && modelRowTitle(def) === modelRowTitle(row)) {
      return "default";
    }
  }
  return row.value;
}

/**
 * Resolve the picker's option list and active row from a metadata snapshot.
 *
 * Options: the live `initialize` capability list when non-empty, else the
 * caller-supplied `fallback` (the persisted live catalog via
 * `readModelCatalog()` in production), else the single
 * {@link UNKNOWN_CATALOG_OPTION} placeholder — never a hardcoded list.
 *
 * Active row: the resolved id (or optimistic label / selector) is mapped to
 * its selector against the options themselves ({@link modelIdToSelector});
 * a row with that value is marked, else the first row (the account default
 * by convention).
 */
export function resolvePickerModels(
  models: CapabilityModel[],
  activeModel: string | null,
  fallback: CapabilityModel[] | null,
): PickerModels {
  const known = models.length > 0 ? models : fallback;
  const options =
    known !== null && known.length > 0 ? known : [UNKNOWN_CATALOG_OPTION];

  if (activeModel !== null) {
    const selector = modelIdToSelector(activeModel, options);
    const hit = options.find((m) => m.value === selector);
    if (hit) return { options, activeValue: hit.value };
  }

  // No model yet, or an unrecognized resolved id → the first option, which
  // is the account default by convention.
  return { options, activeValue: options[0].value };
}

/**
 * The picker's rows split in two: the ones it shows up front and the older
 * versions it folds away.
 */
export interface ModelOptionFold {
  /** Rows shown up front, in catalog order. */
  current: CapabilityModel[];
  /** Superseded versions, in catalog order — shown only on request. */
  older: CapabilityModel[];
}

/** `Opus 5.5` → `{ family: "opus", version: [5, 5] }`; `null` when unparsed. */
function titleVersion(
  row: CapabilityModel,
): { family: string; version: number[] } | null {
  const match = /^([a-z]+)\s+(\d+(?:\.\d+)*)\b/i.exec(modelRowTitle(row));
  if (match === null) return null;
  return {
    family: match[1].toLowerCase(),
    version: match[2].split(".").map(Number),
  };
}

/** Segment-wise version comparison: negative when `a` is older than `b`. */
function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Fold superseded versions out of the picker's front rank. From 2.1.285
 * claude offers every version of a family it still serves (Opus 5.5 beside
 * Opus 5, 4.8, 4.7, 4.6), and twelve rows of near-identical wording bury the
 * five choices people actually make.
 *
 * A row is **older** when another row of the same family, named by claude's
 * own title ({@link modelRowTitle}), carries a higher version — data-driven,
 * so no list of "current" models goes stale. The `default` row is always
 * current, and so is a row whose title does not parse as family + version.
 */
export function foldOlderModels(options: CapabilityModel[]): ModelOptionFold {
  const parsed = options.map((row) =>
    row.value === "default" ? null : titleVersion(row),
  );
  const newest = new Map<string, number[]>();
  for (const p of parsed) {
    if (p === null) continue;
    const best = newest.get(p.family);
    if (best === undefined || compareVersions(p.version, best) > 0) {
      newest.set(p.family, p.version);
    }
  }
  const current: CapabilityModel[] = [];
  const older: CapabilityModel[] = [];
  options.forEach((row, i) => {
    const p = parsed[i];
    const superseded =
      p !== null &&
      compareVersions(p.version, newest.get(p.family) ?? p.version) < 0;
    (superseded ? older : current).push(row);
  });
  return { current, older };
}
