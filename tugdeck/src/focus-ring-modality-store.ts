/**
 * focus-ring-modality-store.ts -- the app-wide focus-ring modality.
 *
 * Two policies, orthogonal to the keyboard-access mode:
 *   - `keyboard` (the default): the focus ring moves with keyboard navigation
 *     only (Tab / Shift-Tab / surface entry).
 *   - `pointer`: the ring *also* follows pointer-driven key-view changes -- a
 *     click that lands on a registered focusable paints the ring -- so the ring
 *     is consistent whether you Tab to a control or click it.
 *
 * Unlike the keyboard-access mode, this is read by *non-rendering* code only
 * (the FocusManager's ring projection) -- no CSS consumes it, so the store does
 * NOT stamp a DOM attribute. It enters React through `useSyncExternalStore`
 * only ([L02]) for the dev-panel Settings toggle's displayed state; the actual
 * ring repaint is driven through the manager, which mutates the
 * `data-key-view-kbd` appearance attribute directly ([L06]/[L22]).
 *
 * Persistence rides tugbank defaults (`dev.tugapp.app` / `focusRingModality`),
 * the same feed as the theme and keyboard-access mode; there is no
 * `localStorage`. Boot seeds the store from the DEFAULTS snapshot via
 * `initialize`; a live remote write arrives through the DEFAULTS push and is
 * applied with `setMode(..., { persist: false })` to avoid an echo loop. The
 * FocusManager is kept in sync by the responder-chain provider, which
 * subscribes here and pushes the policy into the manager.
 */

import { useSyncExternalStore } from "react";
import { putFocusRingModality } from "./settings-api";

/**
 * Ring modality policy. `keyboard` = ring on keyboard navigation only;
 * `pointer` = ring also follows clicks that land on a focusable.
 */
export type FocusRingModality = "keyboard" | "pointer";

/** The default policy until the DEFAULTS feed resolves. */
export const DEFAULT_FOCUS_RING_MODALITY: FocusRingModality = "keyboard";

/**
 * Coerce an arbitrary persisted/remote value to a valid policy. Anything other
 * than the literal `"pointer"` is treated as `keyboard`, so a malformed or
 * stale default can never wedge the app into a half-applied policy.
 */
export function normalizeFocusRingModality(raw: string | null | undefined): FocusRingModality {
  return raw === "pointer" ? "pointer" : "keyboard";
}

class FocusRingModalityStore {
  private mode: FocusRingModality = DEFAULT_FOCUS_RING_MODALITY;
  private subscribers: Set<() => void> = new Set();
  private initialized = false;

  /**
   * Seed the store from the boot-time DEFAULTS snapshot. Does not persist (the
   * value came from tugbank). Idempotent.
   */
  initialize(mode: FocusRingModality): void {
    this.mode = mode;
    this.initialized = true;
  }

  /** The current policy. */
  getMode(): FocusRingModality {
    return this.mode;
  }

  /** `useSyncExternalStore` snapshot. */
  getSnapshot = (): FocusRingModality => this.mode;

  /** Whether the ring should follow pointer-driven key-view changes. */
  ringFollowsPointer(): boolean {
    return this.mode === "pointer";
  }

  /**
   * Set the policy. Notifies subscribers (so the engine and the dev-panel
   * toggle update) and -- unless `persist` is `false` -- writes it back to
   * tugbank. Pass `persist: false` for values that originated from tugbank
   * (boot / remote DEFAULTS push) to avoid an echo loop.
   */
  setMode(mode: FocusRingModality, opts?: { persist?: boolean }): void {
    if (mode === this.mode && this.initialized) return;
    this.mode = mode;
    this.initialized = true;
    if (opts?.persist !== false) {
      putFocusRingModality(mode);
    }
    this.notify();
  }

  /** Flip between the two policies. Convenience for the in-app toggle. */
  toggle(): void {
    this.setMode(this.mode === "keyboard" ? "pointer" : "keyboard");
  }

  subscribe = (callback: () => void): (() => void) => {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  };

  private notify(): void {
    for (const cb of this.subscribers) {
      cb();
    }
  }
}

/** App-wide singleton. */
export const focusRingModalityStore = new FocusRingModalityStore();

/**
 * React hook returning the current ring modality, re-rendering on change.
 * The server snapshot is the default policy (matches first-paint behavior).
 */
export function useFocusRingModality(): FocusRingModality {
  return useSyncExternalStore(
    focusRingModalityStore.subscribe,
    focusRingModalityStore.getSnapshot,
    () => DEFAULT_FOCUS_RING_MODALITY,
  );
}
