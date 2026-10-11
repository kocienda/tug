/**
 * Pure-logic formatters and constants for the session card's telemetry
 * surface.
 *
 * The telemetry renderers re-export every symbol here, and component callers
 * import them from there. They live in `lib` so a module that wants only a
 * formatter — the block header's elapsed slot — does not import the renderers
 * file, whose chrome imports (`tug-pane`, `space-layer`) close a cycle back
 * through the block renderers.
 *
 * @module lib/session-telemetry-format
 */

/** Format a token count as `12.3k` or `1.05M`. Tiny counts render exact. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Same magnitudes as `formatTokens` but with **uppercase** suffixes —
 * `K` (kilo), `M` (mega), `G` (giga). Instrument-shorthand convention
 * adopted for the Z2 status row in #step-20-4.
 *
 * Signed: a negative count renders with a leading U+2212 minus sign
 * (`-208.3K`). The per-turn token figure is a signed window delta — a
 * `/compact` turn shrinks the window — and the cell shows that
 * honestly rather than clamping a real shrink to `0`.
 */
export function formatTokensCaps(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n < 0) return `−${formatTokensCaps(-n)}`;
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}G`;
}

/**
 * A **ceiling** in the same uppercase shorthand — `200K`, `1M`, `128K`.
 *
 * Deliberately not {@link formatTokensCaps}. That one formats a *measurement*,
 * where a tenth is information: `11.5K` of context used is a different reading
 * from `11.4K`. A context window is a *round number the model was shipped with*,
 * so its decimals are always zeros — `200.0K`, `1.00M` — and they cost four
 * characters of a status row that has none to spare while communicating nothing.
 * Any real fraction is kept (a `1.5M` cap would render as `1.5M`); it is only
 * the trailing zeros that go.
 */
export function formatTokenCap(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  const trim = (value: number): string =>
    value.toFixed(1).replace(/\.0$/, "");
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${trim(n / 1_000)}K`;
  if (n < 1_000_000_000) return `${trim(n / 1_000_000)}M`;
  return `${trim(n / 1_000_000_000)}G`;
}

/** Format milliseconds as `1.2s` / `34s` / `2m 03s` / `1h 04m`. */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1_000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1_000);
  if (totalSec < 60) {
    const tenths = Math.floor((ms % 1_000) / 100);
    return totalSec < 10 ? `${totalSec}.${tenths}s` : `${totalSec}s`;
  }
  if (totalSec < 3_600) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m ${s.toString().padStart(2, "0")}s`;
  }
  const h = Math.floor(totalSec / 3_600);
  const m = Math.floor((totalSec % 3_600) / 60);
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

/**
 * Always-hours time format — `Hh Mm SSs` shape at every magnitude.
 * `0h 0m 12s` even when below an hour; `4h 30m 00s` for a marathon
 * session. Always includes the seconds component. Used by the time
 * popover's per-turn rows, where the uniform `Hh Mm SSs` shape keeps
 * the stacked figures column-aligned.
 */
export function formatTimeAlwaysHours(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0h 0m 00s";
  const totalSec = Math.max(0, Math.floor(ms / 1_000));
  const h = Math.floor(totalSec / 3_600);
  const m = Math.floor((totalSec % 3_600) / 60);
  const s = totalSec % 60;
  return `${h}h ${m}m ${s.toString().padStart(2, "0")}s`;
}

/**
 * Conditional-hours time format — `Mm SSs` for any span under an
 * hour, `Hh MMm SSs` once a single span crosses the hour mark. The
 * status row's TIME cell uses this so the common case (turns lasting
 * seconds or a few minutes) reads without a vestigial leading `0h`;
 * an hour-plus turn still surfaces its hours component. Always
 * includes a zero-padded seconds component; once past an hour the
 * minutes component is zero-padded too, so the hour-plus display holds
 * a stable width as the minutes tick.
 */
export function formatTimeMinutesSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0m 00s";
  const totalSec = Math.max(0, Math.floor(ms / 1_000));
  const s = (totalSec % 60).toString().padStart(2, "0");
  const m = Math.floor((totalSec % 3_600) / 60);
  if (totalSec < 3_600) return `${m}m ${s}s`;
  const h = Math.floor(totalSec / 3_600);
  return `${h}h ${m.toString().padStart(2, "0")}m ${s}s`;
}

/** Format a USD cost as `$0.0123` (4 decimals when small, 2 when ≥ $1). */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return "$0";
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * An unbidden arrival a folded card answers in its Z2 row ([B03]) — one of the
 * two inline dialogs the transcript carries, which a folded card is not
 * showing.
 */
export type FoldArrival = "question" | "permission";

/** What an arrival's notice reads. Pure; exported so a test can pin it. */
export function foldArrivalTitle(arrival: FoldArrival): string {
  return arrival === "question"
    ? "A question is waiting"
    : "Permission is waiting";
}

/**
 * The focus group the folded row's Cancel registers in, and the `group:order`
 * key that addresses it. A constant rather than a `useId` because the session
 * card's fold reclaim has to name it: while a run is in flight on a folded
 * card, Return means Cancel ([B02]), and the card lands its Return-home here
 * instead of on the fold control. Focus keys are scoped to the card's own
 * focus context, so one name serves every card.
 */
export const COMPACTION_CANCEL_FOCUS_GROUP = "session-compaction-cancel";
export const COMPACTION_CANCEL_FOCUS_KEY = `${COMPACTION_CANCEL_FOCUS_GROUP}:0`;
