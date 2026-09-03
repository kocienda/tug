/**
 * use-text-card-settings.ts — one Text card's editor settings: read
 * the resolved values, and write them back when the gear popup changes
 * one.
 *
 * Default-then-card-local:
 *
 *   - Per-card values persist at `dev.text-card/<cardId>` and always
 *     win once present.
 *   - The deck-wide defaults at `dev.tugapp.text-card/settings` apply
 *     to any card with nothing of its own.
 *   - There is NO mount-time write. A card resolves `persisted ??
 *     defaults ?? built-in` live, so an untouched card follows the deck
 *     defaults (even if the user edits them in Settings while it is
 *     open) and leaves no per-card tugbank entry to accumulate. The
 *     FIRST gear change snapshots the full current settings into the
 *     card's own slot, and from then on the card owns them — "settings
 *     apply when the file is opened; once tuned, the card owns them."
 *
 * This deliberately does NOT pin on mount (an earlier version did): that
 * both leaked a per-card blob for every card ever opened and could pin
 * hardcoded defaults if the deck-defaults frame had not yet cached at
 * mount. Resolving live avoids both.
 *
 * Pure tugbank state — no IPC, no session round-trip. Writing a setting
 * is an optimistic local-cache write plus a fire-and-forget PUT.
 *
 * Laws: [L02] both reads enter through `useTugbankValue`
 * (useSyncExternalStore); no localStorage — persistence is tugbank only.
 *
 * @module lib/use-text-card-settings
 */

import { useCallback, useMemo } from "react";

import { getTugbankClient } from "@/lib/tugbank-singleton";
import { useTugbankValue } from "@/lib/use-tugbank-value";
import { putTextCardCardSettings } from "@/settings-api";
import {
  TEXT_CARD_DOMAIN,
  TEXT_CARD_DEFAULTS_DOMAIN,
  TEXT_CARD_DEFAULTS_KEY,
  parseTextCardSettings,
  resolveTextCardSettings,
  type TextCardSettings,
} from "./text-card-settings";

/**
 * Persist a card's editor settings: optimistic local-cache write (so
 * `useTugbankValue` readers re-render instantly) plus an HTTP PUT.
 */
export function writePersistedTextCardSettings(
  cardId: string,
  settings: TextCardSettings,
): void {
  const client = getTugbankClient();
  if (client !== null) {
    client.setLocalValue(TEXT_CARD_DOMAIN, cardId, {
      kind: "json",
      value: settings,
    });
  }
  putTextCardCardSettings(cardId, settings);
}

export interface UseTextCardSettingsResult {
  /** The resolved, card-local editor settings. */
  settings: TextCardSettings;
  /** Merge a partial change and persist it card-local. */
  setSetting: (partial: Partial<TextCardSettings>) => void;
}

export function useTextCardSettings(
  cardId: string,
): UseTextCardSettingsResult {
  const persisted = useTugbankValue<TextCardSettings | null>(
    TEXT_CARD_DOMAIN,
    cardId,
    parseTextCardSettings,
    null,
  );

  const defaults = useTugbankValue(
    TEXT_CARD_DEFAULTS_DOMAIN,
    TEXT_CARD_DEFAULTS_KEY,
    parseTextCardSettings,
    null,
  );

  // Resolve live: the card's own persisted values win; otherwise the
  // deck-wide defaults (which update in place if the user edits them in
  // Settings while this untouched card is open); otherwise the built-in
  // defaults. No mount-time write — a card that is never customized
  // leaves no per-card tugbank entry to accumulate, and there is no race
  // against the defaults frame landing after mount.
  const settings = useMemo(
    () => resolveTextCardSettings(persisted, defaults),
    [persisted, defaults],
  );

  // The first gear change snapshots the FULL current settings into the
  // card's own slot (`{ ...settings, ...partial }`), so from then on the
  // card is card-local and no longer tracks deck-default changes — the
  // "settings apply when opened, then the card owns them" contract.
  const setSetting = useCallback(
    (partial: Partial<TextCardSettings>) => {
      writePersistedTextCardSettings(cardId, { ...settings, ...partial });
    },
    [cardId, settings],
  );

  return { settings, setSetting };
}
