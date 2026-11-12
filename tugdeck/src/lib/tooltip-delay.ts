/**
 * tooltip-delay — how long a tooltip waits before it answers a hover.
 *
 * Settings ▸ General ▸ Tooltip Delay stores one time, in milliseconds, and it
 * means what it says: a control's label and an OS tooltip (the `title`
 * tooltips WebKit hands AppKit) wait exactly that long.
 *
 * Two kinds of tip are tuned to answer sooner than a label, because the
 * reader resting on them is already asking the question: a Layout place (a
 * reader scanning a picture of their deck, card after card) and a chart mark.
 * Each keeps its own shorter delay as a ceiling — it waits the chosen time or
 * its own, whichever is less — so no tip is ever slower than the setting
 * says, and 0 s is 0 for every one of them.
 *
 * Four readers, one value:
 * - `TugTooltipProvider` (every `TugTooltip`, in the shell, each card body and
 *   the overlay) through {@link useTooltipDelay};
 * - a `TugTooltip` with a ceiling of its own, through {@link useTooltipDelayAtMost};
 * - the chart bubble, outside React, through {@link tooltipDelayNow};
 * - the OS tooltips, which the host owns: the shell's provider posts the
 *   value and the host applies it to AppKit's tooltip manager.
 *
 * @module lib/tooltip-delay
 */

import { useTugbankValue } from "./use-tugbank-value";
import { getTugbankClient } from "./tugbank-singleton";
import {
  DEFAULT_TOOLTIP_DELAY_MS,
  TOOLTIP_DELAY_DOMAIN,
  TOOLTIP_DELAY_KEY,
  parseTooltipDelay,
} from "@/settings-api";

/** The times Settings offers, in milliseconds, shortest first. */
export const TOOLTIP_DELAY_CHOICES_MS: readonly number[] = [0, 300, 600, 900, 1500];

/** How Settings writes a delay: `0 s`, `0.3 s`, `1.5 s`. */
export function formatTooltipDelay(ms: number): string {
  return `${Number((ms / 1000).toFixed(2))} s`;
}

/** React hook: the user's tooltip delay in ms ([L02], through `useTugbankValue`). */
export function useTooltipDelay(): number {
  return useTugbankValue(TOOLTIP_DELAY_DOMAIN, TOOLTIP_DELAY_KEY, parseTooltipDelay, DEFAULT_TOOLTIP_DELAY_MS);
}

/** React hook: the user's tooltip delay, never longer than `ceilingMs`. */
export function useTooltipDelayAtMost(ceilingMs: number): number {
  return Math.min(useTooltipDelay(), ceilingMs);
}

/**
 * The user's tooltip delay as the cache holds it right now, never longer than
 * `ceilingMs` — for a reader outside React that arms its own timer, read when
 * the timer is armed so a changed setting reaches the next hover.
 */
export function tooltipDelayNow(ceilingMs: number = Infinity): number {
  const entry = getTugbankClient()?.get(TOOLTIP_DELAY_DOMAIN, TOOLTIP_DELAY_KEY);
  return Math.min(parseTooltipDelay(entry), ceilingMs);
}
