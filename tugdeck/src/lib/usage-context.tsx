/**
 * UsageContext — carries the app-level {@link UsageStore} down to the cards.
 *
 * The `/usage` panel is account-global (one `claude -p "/usage"` for the whole
 * machine), so a single `UsageStore` is constructed once at deck-manager boot
 * and shared by every card's `/usage` sheet through this context — the same
 * shape as {@link RateLimitContext}, and for the same reason (not a per-card
 * store, and not worth bloating `CardDeck`).
 *
 * The value is nullable so a card rendered outside the provider (some unit
 * tests) gets `null` and the sheet degrades to its empty state.
 *
 * @module lib/usage-context
 */

import { createContext, useContext } from "react";
import type { UsageStore } from "./usage-store";

/** React context carrying the account-global {@link UsageStore}. */
export const UsageContext = createContext<UsageStore | null>(null);

/** Read the app-level {@link UsageStore}, or `null` outside a provider. */
export function useUsageStore(): UsageStore | null {
  return useContext(UsageContext);
}
