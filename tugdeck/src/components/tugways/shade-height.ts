/**
 * shade-height — persistence for the TugSheet `shade` presentation's height
 * fraction.
 *
 * The shade's height is a fraction of its slot, persisted app-wide through
 * tugbank defaults under a caller-supplied `persistKey` (shades sharing a key
 * share a height). Pure module — no DOM, no React — so the round-trip is
 * testable as plain logic. [L02]: the persisted value enters React through
 * `useSyncExternalStore` over the tugbank cache (see `tug-sheet.tsx`).
 */

import { getTugbankClient } from "@/lib/tugbank-singleton";

/** Tugbank domain holding persisted shade height fractions, keyed by `persistKey`. */
export const SHADE_HEIGHT_DOMAIN = "dev.tugapp.dev.shade-height";

/** Default height fraction when no persisted value exists. */
export const DEFAULT_SHADE_FRAC = 0.58;

/** Hard floor/ceiling on the stored fraction (the px floor clamps via CSS). */
const MIN_FRAC = 0.1;
const MAX_FRAC = 1;

export function clampShadeFrac(frac: number): number {
  return Math.min(MAX_FRAC, Math.max(MIN_FRAC, frac));
}

/** Read the persisted fraction for `persistKey`, or null when unset/invalid. */
export function readPersistedShadeFrac(persistKey: string): number | null {
  const client = getTugbankClient();
  if (client === null) return null;
  const raw = client.getValue(SHADE_HEIGHT_DOMAIN, persistKey);
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return clampShadeFrac(raw);
}

/** Subscribe to tugbank changes for the shade-height domain. */
export function subscribeShadeHeightDomain(onChange: () => void): () => void {
  const client = getTugbankClient();
  if (client === null) return () => {};
  return client.onDomainChanged((domain) => {
    if (domain === SHADE_HEIGHT_DOMAIN) onChange();
  });
}

/** Persist `frac` for `persistKey`: optimistic local cache + fire-and-forget PUT. */
export function writePersistedShadeFrac(persistKey: string, frac: number): void {
  const client = getTugbankClient();
  if (client !== null) {
    client.setLocalValue(SHADE_HEIGHT_DOMAIN, persistKey, {
      kind: "json",
      value: frac,
    });
  }
  const url = `/api/defaults/${SHADE_HEIGHT_DOMAIN}/${encodeURIComponent(persistKey)}`;
  fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "json", value: frac }),
  }).catch((err) => {
    console.warn(`[tug-sheet] shade-height PUT failed for key ${persistKey}:`, err);
  });
}
