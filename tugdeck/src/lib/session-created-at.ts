/**
 * session-created-at.ts — when a session was made, from the two places that
 * know.
 *
 * The date the description line falls back to, and the date the telemetry panel
 * reports. Two sources, in this order:
 *
 *  1. **The session ledger's `created_at`** — the authority. It is present at
 *     zero turns, which is exactly the state a fallback is reporting on. The
 *     row is the CALLER's, not a read of this hook's own: every surface that
 *     wants the date is already holding the row for the facts beside it, and a
 *     second `useSessionLedgerRow` here was a duplicate subscription and a
 *     duplicate `findRow` scan on every session row in the app. The caller
 *     supplies whichever row it trusts — a picker's payload in hand, or the
 *     by-id lookup for the card that holds a just-spawned session the workspace
 *     listing deliberately omits.
 *  2. **The card's replay-derived anchor** — `sessionCreatedAtMs` on the card's
 *     own session store, which covers the window before the ledger answers. It
 *     is derived from the first turn entry in the JSONL, so it says nothing
 *     about a session that has not taken a turn — which is exactly why rung 1
 *     has to see the detached row.
 *
 * Null until one of them answers. Shared rather than re-derived per surface,
 * because a masthead and a Cards card row dating the same session differently is the
 * failure one resolver exists to prevent ([D123]).
 *
 * Laws: [L02] the replay read enters through `useSyncExternalStore`; the
 *       ledger row arrives as a prop from the caller's own subscription.
 *
 * @module lib/session-created-at
 */

import { useSyncExternalStore } from "react";

import { cardServicesStore } from "@/lib/card-services-store";
import type { SessionRow } from "@/protocol";

/** Stable no-op subscribe for a card whose services aren't constructed yet. */
const NOOP_SUBSCRIBE = (): (() => void) => () => {};

/**
 * When the session was made, in ms, or null.
 *
 * @param cardId The card holding the session, when one does — the replay
 *   anchor's scope. A row for a session no card holds passes none.
 * @param row The session's ledger row, as the caller already read it.
 */
export function useSessionCreatedAtMs(
  cardId: string | undefined,
  row: SessionRow | null,
): number | null {
  // No card, no listener. The services lookup already answered `null` for an
  // absent `cardId`, but it answered it from inside a live subscription — so a
  // picker listing a workspace of closed sessions woke every one of its rows on
  // every card construction in the app to recompute the same `null`.
  const services = useSyncExternalStore(
    cardId === undefined ? NOOP_SUBSCRIBE : cardServicesStore.subscribe,
    () => (cardId === undefined ? null : cardServicesStore.getServices(cardId)),
  );
  const store = services?.codeSessionStore ?? null;
  const replayCreatedAtMs = useSyncExternalStore(
    store?.subscribe ?? NOOP_SUBSCRIBE,
    store !== null ? () => store.getSnapshot().sessionCreatedAtMs : () => null,
    () => null,
  );
  return row?.created_at ?? replayCreatedAtMs;
}
