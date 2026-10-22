/**
 * dormant-after-pref.ts — how long a body stays hidden before it goes dormant.
 *
 * A body the host has hidden (a parked workspace's card, a folded pane) keeps
 * its page, but after this long it stops working on behalf of nobody: it
 * empties its session subscription, so tugcast sends it nothing and its
 * ingest worker, hearing nothing, idles with its model kept — nothing parks
 * the worker; it starves — and the page catches up when it is shown again. A
 * minute by default: long enough that a fold and an unfold,
 * or a glance at another workspace, never pay a catch-up; short enough that a
 * workspace left parked stops costing.
 *
 * App-wide rather than per project: a body's dormancy is the window's
 * treatment of a hidden page, whichever project its card is about, so the
 * preference lives in tugbank beside the deck's other preferences and the
 * Layout card is its door.
 *
 * Tugbank coordinates:
 *  - domain: `dev.tugapp.body-dormancy`
 *  - key:    `dormantAfterMs`
 *  - value:  `{ kind: "i64", value: <ms> }` — any positive whole number of
 *    milliseconds; the Layout card offers {@link DORMANT_AFTER_CHOICES}, and a
 *    harness writes a shorter one to read dormancy without waiting a minute.
 *
 * Laws: [L02] the tugbank cache enters React through `useTugbankValue`.
 *
 * @module lib/dormant-after-pref
 */

import { getTugbankClient } from "@/lib/tugbank-singleton";
import { useTugbankValue } from "@/lib/use-tugbank-value";
import type { TaggedValue } from "@/lib/tugbank-client";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";

export const DORMANT_AFTER_DOMAIN = "dev.tugapp.body-dormancy";
export const DORMANT_AFTER_KEY = "dormantAfterMs";

/** What a reader who has never chosen gets: a minute. */
export const DEFAULT_DORMANT_AFTER_MS = 60_000;

/** The everyday choices the Layout card offers, in ms. */
export const DORMANT_AFTER_CHOICES = [30_000, 60_000, 300_000, 900_000] as const;

/**
 * A stored delay of this domain — `dormantAfterMs` or `evictAfterMs` — or
 * `null` when nothing is stored or what is stored is not a positive whole
 * number of milliseconds. The one parser both delays read through.
 */
export function parseBodyDelayMs(entry: TaggedValue | undefined): number | null {
  if (entry === undefined) return null;
  const value = entry.value;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** The stored delay, or the default when nothing usable is stored. */
export function resolveDormantAfterMs(stored: number | null): number {
  return stored ?? DEFAULT_DORMANT_AFTER_MS;
}

/** A delay as the Layout card's segments and tooltips read it: `30s`, `1m`, `15m`. */
export function dormantAfterLabel(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** The reader's delay. [L02] */
export function useDormantAfterMs(): number {
  const stored = useTugbankValue<number | null>(DORMANT_AFTER_DOMAIN, DORMANT_AFTER_KEY, parseBodyDelayMs, null);
  return resolveDormantAfterMs(stored);
}

/**
 * Persist `ms` through the tugbank client's own write ({@link TugbankClient.put}):
 * the local cache first so the row answers the press in the same frame, then
 * the PUT; every page's tugbank client hears the change, which is how each
 * body's clock learns it.
 */
export function writeDormantAfterMs(ms: number): void {
  writeBodyDelayMs(DORMANT_AFTER_KEY, ms, "dormant-after");
}

/** Persist one of the domain's delays, `key`, as `ms`; a page with no tugbank client logs and writes nothing. */
export function writeBodyDelayMs(key: string, ms: number, logTag: string): void {
  const client = getTugbankClient();
  if (client === null) {
    tugDevLogStore.warn(logTag, `no tugbank client to write ${key}`);
    return;
  }
  client.put(DORMANT_AFTER_DOMAIN, key, { kind: "i64", value: ms }, logTag);
}
