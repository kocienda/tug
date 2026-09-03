/**
 * Per-card persistence helpers for `<DiffBlock>`'s view-mode
 * preference (inline ↔ side-by-side).
 *
 * Reads go through `useSyncExternalStore` per [L02] — the tugbank
 * cache is the source of truth, the React component subscribes for
 * updates, and the toggle handler writes optimistically through
 * `setLocalValue` so the UI reflects the change without waiting for
 * the server's DEFAULTS round-trip. The PUT to `/api/defaults/...`
 * runs fire-and-forget after the local cache update.
 *
 * Tugbank coordinates:
 *  - domain: `dev.tugapp.dev.diff-view` (matches the
 *    `dev.tugapp.<area>` naming used by sibling preferences in
 *    `settings-api.ts`).
 *  - key:    `<cardId>` (per-card; same scoping convention as
 *    `dev.tugapp.deck.cardstate/<cardId>`).
 *  - value:  `{ kind: "string", value: "inline" | "side-by-side" }`.
 *
 * @module lib/diff/diff-view-pref
 */

import React from "react";

import { getTugbankClient } from "@/lib/tugbank-singleton";

export type DiffViewMode = "inline" | "side-by-side";

/** Tugbank domain that holds per-card diff-view preferences. */
export const DIFF_VIEW_DOMAIN = "dev.tugapp.dev.diff-view";

/**
 * Subscribe to tugbank changes for the diff-view domain. The callback
 * fires whenever any key in the domain updates (including via
 * `setLocalValue`'s optimistic-write path). Returns an unsubscribe
 * function.
 *
 * Returns a no-op unsubscriber when the tugbank singleton hasn't been
 * wired (test environments without a fake client).
 */
function subscribeDiffViewDomain(onChange: () => void): () => void {
  const client = getTugbankClient();
  if (client === null) return () => {};
  return client.onDomainChanged((domain) => {
    if (domain === DIFF_VIEW_DOMAIN) onChange();
  });
}

/**
 * Read the saved diff-view mode for `cardId` from the tugbank cache,
 * or `null` if no preference is set / the singleton isn't wired /
 * the stored value isn't a recognized `DiffViewMode`.
 *
 * Synchronous: the tugbank cache is populated before the first React
 * render, so this is safe to call from a `useSyncExternalStore`
 * snapshot.
 */
function getDiffViewMode(cardId: string): DiffViewMode | null {
  const client = getTugbankClient();
  if (client === null) return null;
  const raw = client.getValue(DIFF_VIEW_DOMAIN, cardId);
  if (raw === "inline" || raw === "side-by-side") return raw;
  return null;
}

/**
 * `useSyncExternalStore`-based hook that returns the current
 * persisted diff-view mode for `cardId`. Re-renders the consumer
 * when tugbank's snapshot changes — including the optimistic
 * `setLocalValue` write fired by [`writeDiffViewMode`](./diff-view-pref.ts#L_W).
 *
 * Returns `null` when no preference is set; consumers compose with
 * a controllable prop and a default in their own state derivation.
 *
 * Per [L02]: this is the only sanctioned path for the tugbank value
 * to enter React state for `DiffBlock`. No `useState` initializer
 * sneaking in synchronous reads.
 */
export function useDiffViewMode(cardId: string | undefined): DiffViewMode | null {
  // `getSnapshot` must close over the current `cardId` so it tracks
  // re-renders if the consumer ever changes the cardId on the fly.
  // For our canonical Session-card consumer the cardId is stable for
  // the component's lifetime, but the hook supports the general
  // case.
  const getSnapshot = React.useCallback((): DiffViewMode | null => {
    if (cardId === undefined) return null;
    return getDiffViewMode(cardId);
  }, [cardId]);

  return React.useSyncExternalStore(subscribeDiffViewDomain, getSnapshot);
}

/**
 * Persist `mode` for `cardId`. Optimistically updates the local
 * tugbank cache (so subscribers re-render instantly) *and* PUTs to
 * the server (fire-and-forget). The server-side DEFAULTS frame may
 * later mirror the change, which is a no-op since the local cache
 * already has it.
 *
 * Failures of the HTTP PUT log a warning and otherwise vanish; the
 * UI still reflects the optimistic value, and the next session
 * simply falls back to the default if the PUT actually failed.
 */
export function writeDiffViewMode(cardId: string, mode: DiffViewMode): void {
  const client = getTugbankClient();
  if (client !== null) {
    client.setLocalValue(DIFF_VIEW_DOMAIN, cardId, {
      kind: "string",
      value: mode,
    });
  }

  const url = `/api/defaults/${DIFF_VIEW_DOMAIN}/${encodeURIComponent(cardId)}`;
  fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "string", value: mode }),
  }).catch((err) => {
    console.warn(
      `[diff-view-pref] PUT failed for card ${cardId}:`,
      err,
    );
  });
}
