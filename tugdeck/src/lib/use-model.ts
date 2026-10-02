/**
 * use-model.ts — the session-card's model set path plus its per-card persistence
 * and mount-restore, factored out of the model picker (mirroring
 * [use-permission-mode.ts] / [use-effort.ts]).
 *
 * The chip ([ai-chip.tsx]) only *displays* the model; the behavior — sending
 * the IPC, persisting per card, and restoring on relaunch — lives here so the
 * picker and a future `/model` command both funnel through one `setModel`.
 *
 * Mutations round-trip per [D03]: `setModel` sends a `model_change` frame (via
 * `CodeSessionStore.setModel`) and the chip reflects the resolved model from the
 * post-mutation `system_metadata` (owned by `SessionMetadataStore`); the
 * optimistic `applyModel` bridges the gap since claude answers with a
 * `control_response`, not a fresh `system_metadata`.
 *
 * **Seed readiness differs from permission mode.** Model is NOT carried on the
 * `spawn_session` frame (unlike permission mode's `--permission-mode`), so the
 * session always spawns on the account default and the seed must drive both a
 * NEW card (capabilities landed, still on the account default) AND a RESUMED
 * card (its `system_metadata` model has replayed). The restore therefore gates
 * on "the session's current model is knowable" — either the live capability
 * `models[]` (a new session is up, running the account `default` selector) or a
 * resolved `model` id (a resume replayed) — then re-applies the seed only when
 * it differs from the session's current selector, so an unchanged model never
 * triggers a needless `model_change`.
 *
 * Persistence mirrors `use-permission-mode.ts`: an optimistic `setLocalValue`
 * so `useTugbankValue` readers reflect instantly, plus a PUT to
 * `/api/defaults/dev.model/<cardId>` ([D07], `feedback_no_localstorage`).
 *
 * Laws: [L02] store subscription, [L07] handler reads current state through
 *       the store (no stale render closure)
 */

import { useCallback, useEffect, useRef } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import type { CodeSessionStore } from "@/lib/code-session-store";
import type {
  CapabilityModel,
  SessionMetadataStore,
} from "@/lib/session-metadata-store";
import { getTugbankClient } from "@/lib/tugbank-singleton";
import { useTugbankValue } from "@/lib/use-tugbank-value";
import { modelIdToSelector } from "@/lib/model-picker-data";
import { knownModelRows } from "@/lib/model-label";
import { readModelCatalog } from "@/lib/model-catalog";
import { resolveCatalogSelector } from "@/lib/model-selector";
import {
  MODEL_DEFAULT_DOMAIN,
  MODEL_DEFAULT_KEY,
  MODEL_DOMAIN,
  parsePersistedModel,
  resolveSeedModel,
} from "@/lib/model";

/**
 * Persist a card's model selector: optimistic local-cache write (so
 * `useTugbankValue` readers re-render instantly) plus an HTTP PUT to the
 * defaults endpoint. PUT failure logs and otherwise vanishes — the cache holds
 * for the session and a fresh load falls back to the default.
 */
export function writePersistedModel(cardId: string, selector: string): void {
  const client = getTugbankClient();
  if (client !== null) {
    client.setLocalValue(MODEL_DOMAIN, cardId, {
      kind: "string",
      value: selector,
    });
  }
  const url = `/api/defaults/${MODEL_DOMAIN}/${encodeURIComponent(cardId)}`;
  fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "string", value: selector }),
  }).catch((err) => {
    console.warn(`[model] PUT failed for card ${cardId}:`, err);
  });
}

/**
 * The session's current selector, derived the one way: the resolved model id
 * mapped back to its selector against the known rows (live capability list,
 * else the persisted catalog), or `default` — the account default a fresh
 * session spawns on — when no model id has landed yet.
 *
 * The mount-restore and the borrow both compare against this, so the
 * derivation exists once instead of twice.
 */
export function currentModelSelector(snapshot: {
  models: CapabilityModel[];
  model: string | null;
}): string {
  const { models, model } = snapshot;
  return model !== null
    ? modelIdToSelector(model, knownModelRows(models, readModelCatalog()))
    : "default";
}

/**
 * Whether two selector spellings name the same model — decided on the
 * **catalog row**, not on the strings and not on the resolved model id.
 *
 * Selector spellings and models are not one-to-one. A Max account on `default`
 * may already be running Opus; comparing the strings `default` and `opus`
 * would report a difference that does not exist and flicker the chip through
 * two pointless control requests. Each spelling is resolved to the row it
 * names, then collapsed through the same rule the picker uses — a row whose
 * description matches `default`'s IS `default` — which is precisely the
 * mechanism that detects "this account's default already is Opus".
 *
 * A spelling the catalog cannot resolve is not the same as anything: it names
 * no model, so it can make no claim about matching one.
 */
export function resolvesToSameModel(
  a: string,
  b: string,
  rows: CapabilityModel[],
): boolean {
  const rowA = resolveCatalogSelector(a, rows);
  const rowB = resolveCatalogSelector(b, rows);
  if (rowA === null || rowB === null) return false;
  return modelIdToSelector(rowA.value, rows) === modelIdToSelector(rowB.value, rows);
}

/** What the mount-restore should do with what it currently knows. */
export type MountRestoreDecision =
  /** Not enough is known yet, or there is nothing to correct. */
  | { kind: "wait" }
  /** The session already matches the seed — mark the restore done. */
  | { kind: "arm" }
  /** Align the session to `selector`. */
  | { kind: "restore"; selector: string };

/**
 * The mount-restore's whole decision, as a pure function of what it knows.
 *
 * It lives out here rather than inside the effect because its interaction with
 * {@link borrowModel} is load-bearing and has to be pinned by a test: a borrow
 * moves `model`, which re-runs the effect, and the `modelIsBorrowed` branch is
 * the only thing standing between that and a mid-review revert-plus-persist.
 * A decision expressed as data can be asserted without rendering anything.
 */
export function evaluateMountRestore(input: {
  /** Whether a manual set or a completed restore already armed this mount. */
  alreadySent: boolean;
  /** The seed: the per-card selector if any, else the deck-wide default. */
  seedModel: string | null;
  /** The live capability list. */
  models: CapabilityModel[];
  /** The resolved model id, when one has landed. */
  model: string | null;
}): MountRestoreDecision {
  const { alreadySent, seedModel, models, model } = input;
  if (alreadySent) return { kind: "wait" };
  if (seedModel === null) return { kind: "wait" };
  // Readiness: nothing known yet (no capabilities AND no resolved model) →
  // can't tell the current model, don't race the spawn.
  if (models.length === 0 && model === null) return { kind: "wait" };
  return seedModel !== currentModelSelector({ models, model })
    ? { kind: "restore", selector: seedModel }
    : { kind: "arm" };
}

export interface UseModelOptions {
  /** The card whose model is set / persisted / restored. */
  cardId: string;
  /** Store that sends the `model_change` frame. */
  codeSessionStore: CodeSessionStore;
  /** Store supplying the live model + capability list the restore aligns to. */
  sessionMetadataStore: SessionMetadataStore;
}

export interface UseModelResult {
  /** Set the model to an explicit selector (the picker / `/model` path). */
  setModel: (selector: string) => void;
}

export function useModel({
  cardId,
  codeSessionStore,
  sessionMetadataStore,
}: UseModelOptions): UseModelResult {
  const snapshot = useSyncExternalStore(
    sessionMetadataStore.subscribe,
    sessionMetadataStore.getSnapshot,
  );

  const persistedModel = useTugbankValue<string | null>(
    MODEL_DOMAIN,
    cardId,
    parsePersistedModel,
    null,
  );

  // The deck-wide default a card with nothing persisted of its own adopts on
  // mount (set from the Settings card). Per-card persistence always wins, so
  // this only seeds genuinely fresh cards. Mirrors `use-permission-mode.ts`.
  const defaultModel = useTugbankValue<string | null>(
    MODEL_DEFAULT_DOMAIN,
    MODEL_DEFAULT_KEY,
    parsePersistedModel,
    null,
  );

  // Pre-armed by a manual `setModel` so the mount-restore effect below never
  // overrides a change the user just made.
  const sentRef = useRef(false);

  // Set the model to an explicit selector: reflect it optimistically on the
  // chip (claude answers with a control_response, not a fresh system_metadata),
  // persist it per card, and send the `model_change` frame. The single path the
  // picker and the mount-restore both funnel through. The optimistic value is
  // the SELECTOR itself — the chip resolves any model string (id, selector,
  // or label) through the one `resolveModelLabel` path, so the selector
  // renders as the catalog row's "name with version" title; the authoritative
  // `system_metadata` sharpens it to the exact model id after the next turn.
  const setModel = useCallback(
    (selector: string, opts?: { fromRestore?: boolean }) => {
      // Decline a user-initiated change while a turn is in flight so the
      // model never races the running turn — the session lifecycle publishes
      // `canSubmit` and this control acts only when it is set. The
      // mount-restore seed passes `fromRestore` to bypass the gate.
      if (!opts?.fromRestore && !codeSessionStore.getSnapshot().canSubmit) {
        return;
      }
      sentRef.current = true;
      sessionMetadataStore.applyModel(selector);
      writePersistedModel(cardId, selector);
      codeSessionStore.setModel(selector);
    },
    [cardId, codeSessionStore, sessionMetadataStore],
  );

  // Mount-restore + fresh-seed ([D07]). Once the session's current model is
  // knowable — the live capability list is up (a new session, on the account
  // `default` selector) OR a resolved model id has replayed (a resume) — align
  // it to the seed (per-card selector if any, else the deck-wide default) when
  // the seed differs from the session's current selector. Fires at most once per
  // mount (`sentRef`); a manual change pre-arms it.
  const seedModel = resolveSeedModel(persistedModel, defaultModel);
  const { models, model } = snapshot;
  useEffect(() => {
    const decision = evaluateMountRestore({
      alreadySent: sentRef.current,
      seedModel,
      models,
      model,
    });
    if (decision.kind === "wait") return;
    if (decision.kind === "arm") {
      sentRef.current = true;
      return;
    }
    setModel(decision.selector, { fromRestore: true });
  }, [cardId, seedModel, models, model, setModel]);

  return { setModel };
}
