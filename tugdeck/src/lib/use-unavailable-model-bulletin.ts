/**
 * use-unavailable-model-bulletin.ts — card-level reconciliation of a saved
 * model selector against claude's live catalog, with a bulletin only when the
 * pick is genuinely gone.
 *
 * A card seeded with a *concrete* selector (per-card persisted, else the deck
 * default — never the `default` zero-state) is checked against the persisted
 * live catalog at mount, and one of three things happens:
 *
 *  - **Offered** — nothing to do.
 *  - **Respelled** — claude offers the same model under a different selector
 *    string (`claude-fable-5` → `claude-fable-5[1m]` when the 1M variant
 *    became the offered form). The saved value is quietly rewritten to the
 *    current spelling; the user keeps the model they chose and sees nothing.
 *    Matching lives in [model-selector.ts], which knows which respellings name
 *    the same model.
 *  - **Gone** — no catalog row could be that model. Only then is the pick
 *    reset to `default` and the pane-modal alert presented, pointing the user
 *    at Settings → Assistant.
 *
 * Both writes go back to the key the seed *came from* — the card's own
 * selector when it has one, otherwise the deck-wide default. Repairing the
 * source is what keeps the condition from recurring on every other card that
 * inherits the same stale default.
 *
 * The check runs against the **raw persisted** values, not the narrowed
 * parses: the whole point is to see the selector as stored. Membership is
 * tested against the *persisted* catalog only — when no live catalog has ever
 * been persisted (fresh install) the check is skipped, so a card can never be
 * reset on no evidence.
 *
 * Laws: [L07] the mount effect reads current state straight from the tugbank
 * cache, not a render closure; the alert rides the card's sheet host ([D15]).
 *
 * @module lib/use-unavailable-model-bulletin
 */

import { useEffect, useRef } from "react";

import type { ShowSheetOptions } from "@/components/tugways/tug-sheet";
import { presentAlertSheet } from "@/components/tugways/tug-alert-sheet";
import { dispatchCommand } from "@/command-dispatch";
import { requestSettingsReveal } from "@/lib/settings-reveal";
import { TUG_ACTIONS } from "@/lib/action-vocabulary";
import { getTugbankClient } from "@/lib/tugbank-singleton";
import type { TaggedValue } from "@/lib/tugbank-client";
import type { CapabilityModel } from "@/lib/session-metadata-store";
import {
  MODEL_CATALOG_DOMAIN,
  MODEL_CATALOG_KEY,
  parsePersistedCatalog,
} from "@/lib/model-catalog";
import { resolveCatalogSelector } from "@/lib/model-selector";
import {
  DEFAULT_MODEL_SELECTOR,
  MODEL_DEFAULT_DOMAIN,
  MODEL_DEFAULT_KEY,
  MODEL_DOMAIN,
} from "@/lib/model";
import { writePersistedModel } from "@/lib/use-model";
import { writePersistedDefaultModel } from "@/lib/default-model-store";

/**
 * The raw persisted selector string, with NO catalog resolution — unlike
 * `parsePersistedModel`, an unknown or respelled selector comes through
 * verbatim so it can be named in the bulletin and rewritten at its source.
 */
function rawPersistedSelector(entry: TaggedValue | undefined): string | null {
  if (entry?.kind === "string" && typeof entry.value === "string") {
    return entry.value;
  }
  return null;
}

/** What a card's seed selector warrants once checked against the catalog. */
export type SeedResolution =
  /** Offered as saved (or nothing to check) — leave everything alone. */
  | { kind: "keep" }
  /** The same model under a new selector string — rewrite, stay silent. */
  | { kind: "migrate"; selector: string }
  /** No row could be this model — reset to `default` and tell the user. */
  | { kind: "reset" };

/**
 * Resolve a seed selector against the catalog. `catalog === null` means no
 * live catalog was ever persisted — the check is skipped rather than
 * evaluated against nothing, as are an absent seed and the `default`
 * zero-state.
 */
export function resolveSeedSelector(
  seed: string | null,
  catalog: CapabilityModel[] | null,
): SeedResolution {
  if (catalog === null) return { kind: "keep" };
  if (seed === null || seed === DEFAULT_MODEL_SELECTOR) return { kind: "keep" };
  const row = resolveCatalogSelector(seed, catalog);
  if (row === null) return { kind: "reset" };
  return row.value === seed ? { kind: "keep" } : { kind: "migrate", selector: row.value };
}

export interface UseUnavailableModelBulletinOptions {
  /** The card whose seed model is checked (and repaired on a hit). */
  cardId: string;
  /** The card's shared sheet host (`useTugSheet().showSheet`). */
  showSheet: (options: ShowSheetOptions) => Promise<string | undefined>;
}

/**
 * Single-shot, at card mount: resolve the card's seed selector from the raw
 * persisted values (per-card wins over the deck default), migrate it forward
 * when claude has merely respelled it, and present the bulletin only when the
 * model is gone. Confirming opens the Settings card.
 */
export function useUnavailableModelBulletin({
  cardId,
  showSheet,
}: UseUnavailableModelBulletinOptions): void {
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;

    const client = getTugbankClient();
    if (client === null) return;
    const catalog = parsePersistedCatalog(
      client.get(MODEL_CATALOG_DOMAIN, MODEL_CATALOG_KEY),
    );

    // The seed and the key that holds it travel together: a repair belongs at
    // the source, so a stale deck default is fixed once instead of shadowed
    // per card.
    const cardSeed = rawPersistedSelector(client.get(MODEL_DOMAIN, cardId));
    const seed =
      cardSeed ??
      rawPersistedSelector(client.get(MODEL_DEFAULT_DOMAIN, MODEL_DEFAULT_KEY));
    const writeSeed = (selector: string): void => {
      if (cardSeed !== null) writePersistedModel(cardId, selector);
      else writePersistedDefaultModel(selector);
    };

    const resolution = resolveSeedSelector(seed, catalog);
    if (resolution.kind === "keep") return;
    if (resolution.kind === "migrate") {
      writeSeed(resolution.selector);
      return;
    }

    writeSeed(DEFAULT_MODEL_SELECTOR);
    void presentAlertSheet(showSheet, {
      title: "Saved Model Unavailable",
      message: `The saved model "${seed}" is no longer available — this session is using Default. Review your Assistant defaults.`,
      confirmLabel: "Review Defaults",
      cancelLabel: "Not Now",
    }).then((confirmed) => {
      if (confirmed) {
        // The Assistant defaults live in the Session Card section, which the
        // reader may have collapsed — so name it rather than trusting the
        // card to open on it. The reveal is transient: it does not rewrite
        // their saved arrangement.
        dispatchCommand(TUG_ACTIONS.SHOW_SETTINGS);
        requestSettingsReveal("sessionCard");
      }
    });
  }, [cardId, showSheet]);
}
