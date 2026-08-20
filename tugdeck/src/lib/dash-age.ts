/**
 * dash-age.ts — how long ago a dash was last touched, as a chip's worth of text.
 *
 * Coarse on purpose. The value changes at most hourly at these units, so there
 * is no ticker, no interval, and no store: the caller passes `Date.now()` at
 * render, and the aggregate's own recompute is what refreshes it. A per-second
 * wake in a rail component that is usually not even mounted would buy nothing.
 *
 * Taking `nowMs` as a parameter is also what makes the unit test a table with
 * no clock to mock.
 *
 * @module lib/dash-age
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * `iso` rendered as an age against `nowMs` — `now`, `<n>m`, `<n>h`, or `<n>d`.
 *
 * Returns `null` when there is nothing honest to say: no timestamp, one that
 * does not parse, or one in the future. A future instant means a clock skew
 * somewhere, and the right answer to that is to show nothing rather than a
 * confident `now`.
 */
export function formatDashAge(iso: string | null, nowMs: number): string | null {
  if (iso === null) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;

  const elapsed = nowMs - then;
  if (elapsed < 0) return null;
  if (elapsed < MINUTE_MS) return "now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  return `${Math.floor(elapsed / DAY_MS)}d`;
}
