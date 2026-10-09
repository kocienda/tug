/**
 * rate-limit.ts — pure helpers for the app-level rate-limit banner ([#step-3.5]).
 *
 * The banner reads the account-global subscription quota (a {@link RateLimitInfo}
 * sourced from claude's per-turn `rate_limit_event`) and surfaces a single,
 * transient caution banner only when claude actually signals trouble. This
 * module holds the trigger decision and the reset-countdown formatter as pure
 * functions so the policy is unit-testable on its own, with no store / DOM /
 * React. It mirrors `model-label.ts`.
 *
 * **The status enum is confirmed**, read from the Claude Code CLI's own zod
 * schema (`v2.1.158`):
 *
 *   - `status: "allowed" | "allowed_warning" | "rejected"` — `allowed` = fine,
 *     `allowed_warning` = approaching, `rejected` = hard-limited (requests are
 *     refused; the terminal pops a blocking upgrade / extra-usage menu).
 *   - `overageStatus` mirrors the same enum. The benign default every captured
 *     payload carries is `overageStatus: "rejected"` (`overageDisabledReason:
 *     "org_level_disabled"`) — overage is simply off, NOT an alert. The CLI
 *     warns on overage only when `isUsingOverage && overageStatus ===
 *     "allowed_warning"` ("You're close to your usage limit").
 *
 * So `overageStatus` alone never escalates — keying off it is exactly the bug
 * that made the earlier Z4B chip paint red on a healthy session.
 *
 * Units: `resetsAt` is Unix epoch **seconds** (the wire shape); `now` is
 * milliseconds (`Date.now()`).
 *
 * Pure-functional: no DOM, no React, no module-mutable state.
 *
 * @module lib/rate-limit
 */

import type { RateLimitInfo } from "../protocol";

/** Confirmed `status` / `overageStatus` enum values (CLI v2.1.158 schema). */
const STATUS_WARNING = "allowed_warning";
const STATUS_REJECTED = "rejected";

/**
 * Banner state derived from the quota. `ok` shows no banner; `approaching`
 * shows a calm caution banner; `limited` shows a danger banner (requests are
 * being refused).
 */
export type RateLimitBannerState = "ok" | "approaching" | "limited";

/**
 * Derive the banner state from the account-global quota ([#step-3.5]):
 *  - `limited`     — `status === "rejected"` (hard limit, requests refused).
 *  - `approaching` — `status === "allowed_warning"`, or the overage-close case
 *                    (`isUsingOverage && overageStatus === "allowed_warning"`).
 *  - `ok`          — everything else, including the benign default
 *                    (`status: "allowed"`, `overageStatus: "rejected"`).
 *
 * `null` (no quota frame yet) is `ok`. `overageStatus` on its own never
 * escalates — only `isUsingOverage && overageStatus === "allowed_warning"`.
 */
export function rateLimitBannerState(
  info: RateLimitInfo | null,
): RateLimitBannerState {
  if (info === null) return "ok";
  if (info.status === STATUS_REJECTED) return "limited";
  if (info.status === STATUS_WARNING) return "approaching";
  if (info.isUsingOverage && info.overageStatus === STATUS_WARNING) {
    return "approaching";
  }
  return "ok";
}

/**
 * Format the time until the window resets as compact countdown text:
 *  - `> 1h`   → `"5h 23m"`
 *  - `< 1h`   → `"23m"`
 *  - `< 1m`   → `"<1m"`
 *  - elapsed  → `"now"`
 *
 * Pure: returns the exact string the banner message embeds. The banner
 * computes it at render from the live `resetsAt`; it does not tick on a timer
 * (one low-frequency app-level surface, refreshed whenever a fresh
 * `rate_limit_event` lands).
 */
export function formatResetCountdown(resetsAtSec: number, nowMs: number): string {
  const deltaSec = resetsAtSec - Math.floor(nowMs / 1000);
  if (deltaSec <= 0) return "now";
  const totalMin = Math.floor(deltaSec / 60);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m`;
  return "<1m";
}

// ---------------------------------------------------------------------------
// Usage bulletins — the non-blocking replacement for the old banner.
// ---------------------------------------------------------------------------

/**
 * The % barriers that each fire ONE bulletin per reset window. The UI
 * must never block on quota — the server enforces the real limit; the
 * deck's whole job is a calm heads-up at each barrier.
 */
export const USAGE_BULLETIN_THRESHOLDS = [80, 85, 90, 95, 100] as const;

/** One bulletin the policy wants fired. */
export interface UsageBulletinFire {
  /** `caution` below 100; `danger` at 100 / hard-rejected. */
  tone: "caution" | "danger";
  message: string;
}

/**
 * The policy's memory: which barriers already fired in the current
 * reset window. The window is keyed by `(rateLimitType, resetsAt)` —
 * when either changes, a new window opened and every barrier re-arms.
 */
export interface UsageBulletinState {
  windowKey: string;
  fired: number[];
}

export const USAGE_BULLETIN_IDLE: UsageBulletinState = Object.freeze({
  windowKey: "",
  fired: [],
});

/**
 * Decide whether a fresh quota frame fires a bulletin. Pure: feeds the
 * previous state and the frame, returns the next state plus at most
 * one fire — the HIGHEST newly-crossed barrier (a reconnect at 93%
 * fires 90 once, not 80/85/90 separately).
 *
 * `utilization` is the CLI's 0–1 fraction; when absent (older CLIs)
 * the status enum falls back: `allowed_warning` arms the 90 barrier,
 * `rejected` the 100 barrier.
 */
export function nextUsageBulletin(
  state: UsageBulletinState,
  info: RateLimitInfo,
  nowMs: number,
): { state: UsageBulletinState; fire: UsageBulletinFire | null } {
  const windowKey = `${info.rateLimitType}:${info.resetsAt}`;
  const fired = state.windowKey === windowKey ? state.fired : [];

  const pct =
    typeof info.utilization === "number"
      ? Math.round(info.utilization * 100)
      : info.status === STATUS_REJECTED
        ? 100
        : info.status === STATUS_WARNING
          ? 90
          : 0;

  let highestNew: number | null = null;
  const nextFired = [...fired];
  for (const threshold of USAGE_BULLETIN_THRESHOLDS) {
    if (pct < threshold || fired.includes(threshold)) continue;
    nextFired.push(threshold);
    highestNew = threshold;
  }
  if (highestNew === null) {
    return { state: { windowKey, fired: nextFired }, fire: null };
  }
  const resets = formatResetCountdown(info.resetsAt, nowMs);
  const limited = highestNew >= 100 || info.status === STATUS_REJECTED;
  return {
    state: { windowKey, fired: nextFired },
    fire: {
      tone: limited ? "danger" : "caution",
      message: limited
        ? `Usage limit reached — resets in ${resets}`
        : `Usage at ${pct}% — resets in ${resets}`,
    },
  };
}
