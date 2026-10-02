/**
 * active-color-target.ts — the single "active color well" the standalone
 * TugColorPicker edits, mirroring AppKit's one-shared-NSColorPanel model.
 *
 * A TugColorWell announces itself (via the ACTIVATE_COLOR_WELL action handled by
 * its host responder) by writing here; the picker reads it through
 * useSyncExternalStore [L02] and dispatches edits back via
 * sendToTarget(targetId, …). This module is pure external state — no React, no
 * appearance — so both the well's host and the picker resolve to one truth.
 */

import { useSyncExternalStore } from "@/lib/gesture-scope";

import type { TugColorSpec } from "./tugcolor";

/** componentId of the standalone color-picker card the wells reveal/activate. */
export const COLOR_PICKER_COMPONENT_ID = "gallery-color-picker";

export interface ActiveColorTarget {
  /** Responder id that owns the color (the well's host) — the sendToTarget id. */
  targetId: string;
  /** Stable sender id of the well, so the host routes to the right color. */
  senderId: string;
  /** A human label for the picker's header (e.g. "Filled"). */
  label: string;
  /** The well's current value. */
  value: TugColorSpec;
}

let current: ActiveColorTarget | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function getActiveColorTarget(): ActiveColorTarget | null {
  return current;
}

export function setActiveColorTarget(target: ActiveColorTarget): void {
  current = target;
  emit();
}

/** Update just the value of the active target (after a picker edit). */
export function updateActiveColorValue(senderId: string, value: TugColorSpec): void {
  if (!current || current.senderId !== senderId) return;
  current = { ...current, value };
  emit();
}

/** Clear the active target — pass a senderId to clear only if it still owns it. */
export function clearActiveColorTarget(senderId?: string): void {
  if (senderId !== undefined && current?.senderId !== senderId) return;
  current = null;
  emit();
}

export function subscribeActiveColorTarget(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** React hook: the currently-active color target (or null). */
export function useActiveColorTarget(): ActiveColorTarget | null {
  return useSyncExternalStore(subscribeActiveColorTarget, getActiveColorTarget, getActiveColorTarget);
}
