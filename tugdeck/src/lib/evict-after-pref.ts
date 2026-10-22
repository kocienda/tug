/**
 * evict-after-pref.ts — how long a body stays hidden before it gives up its
 * process.
 *
 * A dormant body has stopped working but still holds its page: a 500-turn
 * Session body sits at about 550 MB resident, dormant or not. After this long
 * hidden the host evicts it — the page writes its card's state, the view goes,
 * and the card comes back as an arrival when it is next shown, at a rebuild of
 * about half a second. Fifteen minutes by default: a workspace glanced away
 * from and back to never pays the rebuild, and one left for a quarter of an
 * hour stops holding its memory. Pressure evicts sooner; this is the quiet
 * machine's clock.
 *
 * App-wide, beside `dormantAfterMs` in the same domain: the two
 * delays are the window's treatment of a hidden page. The shell reads it and
 * tells the host (`bodyEvictAfter`), whose clock it is, since the host holds
 * the views; the Layout card is its door.
 *
 * Tugbank coordinates:
 *  - domain: `dev.tugapp.body-dormancy`
 *  - key:    `evictAfterMs`
 *  - value:  `{ kind: "i64", value: <ms> }` — any positive whole number of
 *    milliseconds; the Layout card offers {@link EVICT_AFTER_CHOICES}, and a
 *    harness writes a shorter one to read eviction without waiting.
 *
 * Laws: [L02] the tugbank cache enters React through `useTugbankValue`.
 *
 * @module lib/evict-after-pref
 */

import { useTugbankValue } from "@/lib/use-tugbank-value";
import type { TaggedValue } from "@/lib/tugbank-client";
import { DORMANT_AFTER_DOMAIN, parseBodyDelayMs, writeBodyDelayMs } from "@/lib/dormant-after-pref";

export const EVICT_AFTER_DOMAIN = DORMANT_AFTER_DOMAIN;
export const EVICT_AFTER_KEY = "evictAfterMs";

/** What a reader who has never chosen gets: fifteen minutes. */
export const DEFAULT_EVICT_AFTER_MS = 900_000;

/** The everyday choices the Layout card offers, in ms. */
export const EVICT_AFTER_CHOICES = [300_000, 900_000, 1_800_000, 3_600_000] as const;

/** The stored delay, or the default when nothing usable is stored. */
export function resolveEvictAfterMs(stored: number | null): number {
  return stored ?? DEFAULT_EVICT_AFTER_MS;
}

/** A delay as the Layout card's segments and tooltips read it: `5m`, `30m`, `1h`. */
export function evictAfterLabel(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** The delay a tugbank client holds now. */
export function readEvictAfterMs(get: (domain: string, key: string) => TaggedValue | undefined): number {
  return resolveEvictAfterMs(parseBodyDelayMs(get(EVICT_AFTER_DOMAIN, EVICT_AFTER_KEY)));
}

/** The reader's delay. [L02] */
export function useEvictAfterMs(): number {
  const stored = useTugbankValue<number | null>(EVICT_AFTER_DOMAIN, EVICT_AFTER_KEY, parseBodyDelayMs, null);
  return resolveEvictAfterMs(stored);
}

/**
 * Persist `ms` through the tugbank client's own write, as `dormantAfterMs` is
 * written; the shell's tugbank client hears the change and tells the host.
 */
export function writeEvictAfterMs(ms: number): void {
  writeBodyDelayMs(EVICT_AFTER_KEY, ms, "evict-after");
}
