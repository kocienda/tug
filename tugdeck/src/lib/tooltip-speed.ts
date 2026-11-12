/**
 * tooltip-speed — how long every tooltip waits before it answers a hover.
 *
 * Settings ▸ General ▸ Tooltip Speed stores a speed, not a delay. Each kind of
 * tip keeps the base delay it was tuned to — a control's label waits long
 * enough that a pointer crossing a toolbar raises nothing, a Layout place
 * answers sooner because a reader is scanning card by card, a chart mark
 * sooner still — and the speed scales that base. So the order between the
 * kinds survives every choice, and Instant is zero for all of them.
 *
 * Four readers, one table:
 * - `TugTooltipProvider` (every `TugTooltip`, in the shell, each card body and
 *   the overlay) through {@link useTooltipDelay};
 * - a `TugTooltip` that overrides its own delay, the same way;
 * - the chart bubble, outside React, through {@link tooltipDelayNow};
 * - the OS tooltips WebKit draws for a `title` attribute, which the host owns:
 *   the shell's provider posts {@link nativeTooltipDelayMs} and the host
 *   applies it to AppKit's tooltip manager.
 *
 * @module lib/tooltip-speed
 */

import { useTugbankValue } from "./use-tugbank-value";
import { getTugbankClient } from "./tugbank-singleton";
import {
  TOOLTIP_SPEED_DOMAIN,
  TOOLTIP_SPEED_KEY,
  parseTooltipSpeed,
  type TooltipSpeed,
} from "@/settings-api";

/** What each speed multiplies a tip's base delay by. */
export const TOOLTIP_SPEED_FACTOR: Readonly<Record<TooltipSpeed, number>> = {
  slow: 1.5,
  standard: 1,
  fast: 0.5,
  instant: 0,
};

/**
 * The base delay of an OS tooltip — AppKit's own `NSToolTipManager` default,
 * read off a running process. Standard leaves it exactly where AppKit puts it.
 */
export const NATIVE_TOOLTIP_BASE_MS = 1500;

/** `baseMs` at `speed`, in whole milliseconds. */
export function scaleTooltipDelay(baseMs: number, speed: TooltipSpeed): number {
  return Math.round(baseMs * TOOLTIP_SPEED_FACTOR[speed]);
}

/** The delay an OS tooltip should take at `speed`. */
export function nativeTooltipDelayMs(speed: TooltipSpeed): number {
  return scaleTooltipDelay(NATIVE_TOOLTIP_BASE_MS, speed);
}

/** React hook: the user's tooltip speed ([L02], through `useTugbankValue`). */
export function useTooltipSpeed(): TooltipSpeed {
  return useTugbankValue(TOOLTIP_SPEED_DOMAIN, TOOLTIP_SPEED_KEY, parseTooltipSpeed, "standard");
}

/** React hook: `baseMs` scaled by the user's tooltip speed. */
export function useTooltipDelay(baseMs: number): number {
  return scaleTooltipDelay(baseMs, useTooltipSpeed());
}

/**
 * `baseMs` scaled by the speed the cache holds right now, for a reader outside
 * React that arms its own timer — read when the timer is armed, so a changed
 * setting reaches the next hover.
 */
export function tooltipDelayNow(baseMs: number): number {
  const entry = getTugbankClient()?.get(TOOLTIP_SPEED_DOMAIN, TOOLTIP_SPEED_KEY);
  return scaleTooltipDelay(baseMs, parseTooltipSpeed(entry));
}
