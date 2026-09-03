/**
 * ai-config.ts — pure helpers for the composite AI configuration surface: the
 * `AI` chip, the mixer sheet, and the host menu's `AI: …` title.
 *
 * No React, no DOM, no I/O. Model, reasoning effort, and permission mode are
 * three settings the user thinks of as one — "how the AI runs" — and this
 * module holds the three pieces of logic that thought needs and that the
 * per-setting modules ([model-label.ts], [effort.ts], [permission-mode.ts])
 * cannot own alone:
 *
 *  - {@link formatAiConfigSummary} — the ONE composite string. The chip value
 *    line, the sheet's caption, and the menu item's title all render this
 *    function's output, so the three surfaces cannot word it differently.
 *  - {@link computeAiConfigCommit} — the sheet is a transaction: nothing goes
 *    on the wire until OK, and OK sends the minimal ORDERED sequence of
 *    actions. The ordering is load-bearing (a model change must be recorded
 *    before the respawn an effort change triggers), which is why the result is
 *    an array and not a record — as an array the ordering is a property of a
 *    pure function rather than of whatever executes it.
 *  - {@link clampEffortToSupport} — effort is model-gated, so picking a model
 *    in the sheet can strand the pending effort on a level that model does not
 *    offer.
 *  - {@link resolveAiConfigSources} — the ONE reading of a metadata snapshot
 *    into "which options, and what is currently set". Every surface that edits
 *    these three settings resolves them here, so none of them can resolve them
 *    slightly differently.
 *
 * Plus the sticky-row constants: the sheet remembers which row the user last
 * changed and opens focused there.
 *
 * @module lib/ai-config
 */

import type { TaggedValue } from "@/lib/tugbank-client";
import type { PermissionMode } from "@tugproto/inbound";
import type {
  CapabilityModel,
  SessionMetadataSnapshot,
} from "@/lib/session-metadata-store";
import {
  DEFAULT_EFFORT_LEVEL,
  EFFORT_LEVELS,
  resolveEffortSupport,
} from "@/lib/effort";
import { resolvePickerModels } from "@/lib/model-picker-data";
import { resolvePermissionMode } from "@/lib/permission-mode";

/** The three rows of the mixer sheet, in display order. */
export const AI_CONFIG_ROWS = ["model", "effort", "mode"] as const;

/** One row of the mixer sheet. */
export type AiConfigRow = (typeof AI_CONFIG_ROWS)[number];

/**
 * tugbank domain/key for the sheet's sticky row — the row the user last
 * actually changed, deck-level (not per-card): the habit is the user's, not
 * the card's. Deliberately NOT `localStorage`; persistent state goes through
 * tugbank `/api/defaults`.
 */
export const AI_CONFIG_DOMAIN = "dev.tugtool.ai-config";
export const AI_CONFIG_LAST_ROW_KEY = "lastRow";

/** The row the sheet focuses when nothing is remembered and no deep link asks. */
export const AI_CONFIG_DEFAULT_ROW: AiConfigRow = "model";

/**
 * Parse the sticky row out of its tugbank tagged value. The persisted string
 * is untrusted — a value from a future or corrupt build narrows to `null` and
 * the caller falls back to {@link AI_CONFIG_DEFAULT_ROW}.
 */
export function parseAiConfigRow(entry: TaggedValue | undefined): AiConfigRow | null {
  if (entry?.kind !== "string" || typeof entry.value !== "string") return null;
  return AI_CONFIG_ROWS.includes(entry.value as AiConfigRow)
    ? (entry.value as AiConfigRow)
    : null;
}

/** The label pieces the composite summary is built from. */
export interface AiConfigSummaryParts {
  /** {@link resolveModelLabel}'s output — `null` when nothing is known. */
  modelLabel: string | null;
  /** The effort label, or `null` when the model supports no effort. */
  effortLabel: string | null;
  /** The mode label; `resolvePermissionMode` always resolves one. */
  modeLabel: string;
}

/** What the model token reads as when no model is known — honest, not blank. */
export const AI_CONFIG_UNKNOWN_MODEL = "?";

/** The separator between summary tokens, matching the chip idiom elsewhere. */
const SUMMARY_SEPARATOR = " · ";

/**
 * The composite `model · effort · mode` string — `Fable 5 · High · Auto`.
 *
 * An unknown model reads as `?` rather than being dropped (the model is the
 * headline; a summary that started with the effort would misread). An
 * unsupported effort is OMITTED entirely rather than showing a `-`
 * placeholder: in a two-token line an arc reads as a value, and "this model
 * has no effort" is better said by silence than by punctuation —
 * `Haiku 4.5 · Auto`.
 */
export function formatAiConfigSummary(parts: AiConfigSummaryParts): string {
  const tokens = [
    parts.modelLabel ?? AI_CONFIG_UNKNOWN_MODEL,
    parts.effortLabel,
    parts.modeLabel,
  ];
  return tokens.filter((t): t is string => t !== null && t.length > 0).join(SUMMARY_SEPARATOR);
}

/**
 * The sheet's open-time reading of the session — what "unchanged" means for
 * the commit diff.
 */
export interface AiConfigBaseline {
  /** The picker selector the active model maps to, or `null` when unknown. */
  modelSelector: string | null;
  /** The EFFECTIVE level (the model's default counts), `null` = unsupported. */
  effortLevel: string | null;
  mode: string;
}

/** The sheet's pending selection, same shape as the baseline. */
export type AiConfigPending = AiConfigBaseline;

/** One wire-bound action the OK press commits. */
export type AiConfigAction =
  | { kind: "mode"; value: PermissionMode }
  | { kind: "model"; value: string }
  | { kind: "effort"; value: string };

/**
 * The minimal ordered action sequence an OK press should apply.
 *
 * An action appears iff the pending value differs from the baseline AND is
 * non-null (a `null` pending effort means the model offers none — there is
 * nothing to send). Unchanged attributes contribute nothing, so re-confirming
 * the current configuration costs no frames, and Cancel never calls this at
 * all.
 *
 * The order is fixed **mode → model → effort**, and the executor applies the
 * array in order. Model before effort is the load-bearing part: applying an
 * effort change respawns the claude process, and the respawn re-applies the
 * model tugcode recorded when it saw the model change — so the model action
 * must reach tugcode first or the pair half-applies.
 */
export function computeAiConfigCommit(
  baseline: AiConfigBaseline,
  pending: AiConfigPending,
): AiConfigAction[] {
  const actions: AiConfigAction[] = [];
  if (pending.mode !== baseline.mode) {
    actions.push({ kind: "mode", value: pending.mode as PermissionMode });
  }
  if (pending.modelSelector !== null && pending.modelSelector !== baseline.modelSelector) {
    actions.push({ kind: "model", value: pending.modelSelector });
  }
  if (pending.effortLevel !== null && pending.effortLevel !== baseline.effortLevel) {
    actions.push({ kind: "effort", value: pending.effortLevel });
  }
  return actions;
}

/**
 * Everything the channel stack needs to render, derived from one metadata
 * snapshot — see {@link resolveAiConfigSources}.
 */
export interface AiConfigSources {
  /** The model rows to offer. */
  options: CapabilityModel[];
  /** The live capability list, for recomputing effort support per model. */
  models: CapabilityModel[];
  /** The persisted catalog behind the live list. */
  catalog: CapabilityModel[] | null;
  /** What the three channels currently read. */
  value: AiConfigBaseline;
}

/**
 * The ONE reading of "how is the AI configured" — options plus the resolved
 * triple — for whatever store is behind it.
 *
 * Both surfaces that edit these three settings call this and nothing else: the
 * session card's mixer sheet, which reads it once at open time to fix its
 * baseline, and the Settings card's AI Model box, which reads it every render
 * off the deck defaults. The resolution is not a thing either of them may do
 * for itself — a second copy of "which row is active, what effort is in
 * effect, which mode applies" is a second copy that drifts.
 *
 * `persistedMode` is the per-card fallback consulted before the first
 * `system_metadata` round-trip ([D07]); pass `null` in the defaults context,
 * where the store's own mode stands alone.
 */
export function resolveAiConfigSources(
  snapshot: SessionMetadataSnapshot,
  catalog: CapabilityModel[] | null,
  persistedMode: string | null,
): AiConfigSources {
  const { options, activeValue } = resolvePickerModels(
    snapshot.models,
    snapshot.model,
    catalog,
  );
  const support = resolveEffortSupport(snapshot.models, snapshot.model, catalog);
  return {
    options,
    models: snapshot.models,
    catalog,
    value: {
      modelSelector: activeValue,
      // The EFFECTIVE level, matching what the chip shows — so re-confirming
      // the model's default never costs a respawn.
      effortLevel: support.supported
        ? (snapshot.effort ?? DEFAULT_EFFORT_LEVEL)
        : null,
      mode: resolvePermissionMode(snapshot.permissionMode, persistedMode),
    },
  };
}

/**
 * The pending effort after the pending model changed under it.
 *
 * Effort is per-model: opus offers all five levels, sonnet four (no `xhigh`),
 * haiku none. Selecting a narrower model while `xhigh` is pending has to land
 * the pending effort somewhere, and dropping DOWN is the conservative move —
 * silently promoting a user to a bigger thinking budget than they asked for
 * spends their tokens. So: the nearest supported level at or below the pending
 * one in canonical {@link EFFORT_LEVELS} order; failing that (the pending
 * level is below everything supported) the lowest supported level; and `null`
 * when the model supports nothing at all, which is what disables the row.
 *
 * A pending level already supported passes through untouched, so re-picking
 * the same model is inert.
 */
export function clampEffortToSupport(
  pending: string | null,
  supported: readonly string[],
): string | null {
  const ordered = EFFORT_LEVELS.filter((level) => supported.includes(level));
  if (ordered.length === 0) return null;
  if (pending === null) return null;
  if (ordered.includes(pending as (typeof EFFORT_LEVELS)[number])) return pending;

  // An unrecognized pending level has no place in the ordering — treat it the
  // way an over-budget level is treated and fall to the lowest supported.
  const pendingIndex = EFFORT_LEVELS.indexOf(pending as (typeof EFFORT_LEVELS)[number]);
  if (pendingIndex === -1) return ordered[0];

  for (let i = pendingIndex; i >= 0; i -= 1) {
    const candidate = EFFORT_LEVELS[i];
    if (ordered.includes(candidate)) return candidate;
  }
  return ordered[0];
}
