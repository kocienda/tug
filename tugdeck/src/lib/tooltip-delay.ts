/**
 * tooltip-delay — how long a tooltip waits before it answers a hover, or
 * whether it answers at all.
 *
 * Settings ▸ General ▸ Tooltip Delay stores one time, in milliseconds, and it
 * means what it says: a control's label and an OS tooltip (the `title`
 * tooltips WebKit hands AppKit) wait exactly that long. Never
 * ({@link TOOLTIP_DELAY_NEVER}) turns them all off.
 *
 * Two kinds of tip are tuned to answer sooner than a label, because the
 * reader resting on them is already asking the question: a Layout place (a
 * reader scanning a picture of their deck, card after card) and a chart mark.
 * Each keeps its own shorter delay as a ceiling — it waits the chosen time or
 * its own, whichever is less — so no tip is ever slower than the setting
 * says. Never holds for them too.
 *
 * Four readers, one value:
 * - `TugTooltip`, which refuses every open under Never, and its provider
 *   (in the shell, each card body and the overlay), through {@link useTooltipDelay};
 * - a `TugTooltip` with a ceiling of its own, through {@link useTooltipDelayAtMost};
 * - the chart bubble, outside React, through {@link tooltipDelayNow};
 * - the OS tooltips, which the host owns: the shell's provider posts
 *   {@link nativeTooltipDelayMs} and the host applies it to AppKit's tooltip
 *   manager.
 *
 * @module lib/tooltip-delay
 */

import { useTugbankValue } from "./use-tugbank-value";
import { getTugbankClient } from "./tugbank-singleton";
import {
  DEFAULT_TOOLTIP_DELAY_MS,
  TOOLTIP_DELAY_DOMAIN,
  TOOLTIP_DELAY_KEY,
  TOOLTIP_DELAY_NEVER,
  parseTooltipDelay,
} from "@/settings-api";

export { TOOLTIP_DELAY_NEVER };

/** The choices Settings offers, in milliseconds, shortest first, then Never. */
export const TOOLTIP_DELAY_CHOICES_MS: readonly number[] = [0, 100, 200, 300, 500, 700, TOOLTIP_DELAY_NEVER];

/**
 * What an OS tooltip is told under Never. AppKit's tooltip manager has no
 * off switch — its only setting is the delay — so Never is a delay no pointer
 * will rest through: an hour.
 */
export const NATIVE_TOOLTIP_NEVER_MS = 3_600_000;

/** How Settings writes a choice: `0s`, `0.3s`, `Never`. */
export function formatTooltipDelay(ms: number): string {
  return ms === TOOLTIP_DELAY_NEVER ? "Never" : `${Number((ms / 1000).toFixed(2))}s`;
}

/** Whether `ms` is Never. */
export function tooltipsOff(ms: number): boolean {
  return ms === TOOLTIP_DELAY_NEVER;
}

/** The delay an OS tooltip should take for the setting `ms`. */
export function nativeTooltipDelayMs(ms: number): number {
  return tooltipsOff(ms) ? NATIVE_TOOLTIP_NEVER_MS : ms;
}

/** `ms` capped at `ceilingMs`, with Never left as Never. */
function atMost(ms: number, ceilingMs: number): number {
  return tooltipsOff(ms) ? TOOLTIP_DELAY_NEVER : Math.min(ms, ceilingMs);
}

/**
 * React hook: the user's tooltip delay in ms, or {@link TOOLTIP_DELAY_NEVER}
 * ([L02], through `useTugbankValue`).
 */
export function useTooltipDelay(): number {
  return useTugbankValue(TOOLTIP_DELAY_DOMAIN, TOOLTIP_DELAY_KEY, parseTooltipDelay, DEFAULT_TOOLTIP_DELAY_MS);
}

/** React hook: the user's tooltip delay, never longer than `ceilingMs`; Never stays Never. */
export function useTooltipDelayAtMost(ceilingMs: number): number {
  return atMost(useTooltipDelay(), ceilingMs);
}

/**
 * The user's tooltip delay as the cache holds it right now, never longer than
 * `ceilingMs`, or {@link TOOLTIP_DELAY_NEVER} — for a reader outside React
 * that arms its own timer, read when the timer is armed so a changed setting
 * reaches the next hover.
 */
export function tooltipDelayNow(ceilingMs: number = Infinity): number {
  const entry = getTugbankClient()?.get(TOOLTIP_DELAY_DOMAIN, TOOLTIP_DELAY_KEY);
  return atMost(parseTooltipDelay(entry), ceilingMs);
}
