/**
 * keyboard-access-store.ts -- the app-wide keyboard-access mode.
 *
 * `standard` (the default) honors the focus walk's `skip` policy; `accessibility`
 * ignores it so every interactive affordance is Tab-reachable, and asserts the
 * fuller ARIA contract. The mode is **structure-zone** state ([L24]): it is read
 * by non-rendering code (the FocusManager Tab walk) as well as by CSS, so it
 * enters React through `useSyncExternalStore` only ([L02]) and projects onto the
 * DOM as `data-keyboard-access` on the document root for CSS ([L06]/[L24]) --
 * applied on first paint like the theme, never a flash of the wrong mode.
 *
 * Persistence rides tugbank defaults (`dev.tugapp.app` / `keyboardAccess`), the
 * same feed as the theme; there is no `localStorage`. Boot seeds the store from
 * the DEFAULTS snapshot via `initialize`; a live remote write arrives through
 * the DEFAULTS push and is applied with `setMode(..., { persist: false })` to
 * avoid an echo loop. The FocusManager is kept in sync by the responder-chain
 * provider, which subscribes here and pushes the mode into the manager.
 */

import { useSyncExternalStore } from "react";
import { putKeyboardAccess } from "./settings-api";
import type { KeyboardAccessMode } from "./components/tugways/focus-manager";

export type { KeyboardAccessMode } from "./components/tugways/focus-manager";

/** The default mode until the DEFAULTS feed resolves ([P08]). */
export const DEFAULT_KEYBOARD_ACCESS_MODE: KeyboardAccessMode = "standard";

const KEYBOARD_ACCESS_ATTRIBUTE = "data-keyboard-access";

/**
 * Coerce an arbitrary persisted/remote value to a valid mode. Anything other
 * than the literal `"accessibility"` is treated as `standard`, so a malformed
 * or stale default can never wedge the app into a half-applied mode.
 */
export function normalizeKeyboardAccessMode(raw: string | null | undefined): KeyboardAccessMode {
  return raw === "accessibility" ? "accessibility" : "standard";
}

class KeyboardAccessStore {
  private mode: KeyboardAccessMode = DEFAULT_KEYBOARD_ACCESS_MODE;
  private subscribers: Set<() => void> = new Set();
  private initialized = false;

  /**
   * Seed the store from the boot-time DEFAULTS snapshot and apply the DOM
   * attribute before first paint. Does not persist (the value came from
   * tugbank). Idempotent: a second call only re-applies the attribute.
   */
  initialize(mode: KeyboardAccessMode): void {
    this.mode = mode;
    this.initialized = true;
    this.applyAttribute();
  }

  /** The current mode. */
  getMode(): KeyboardAccessMode {
    return this.mode;
  }

  /** `useSyncExternalStore` snapshot. */
  getSnapshot = (): KeyboardAccessMode => this.mode;

  /**
   * Set the mode. Applies the DOM attribute, notifies subscribers, and -- unless
   * `persist` is `false` -- writes it back to tugbank. Pass `persist: false` for
   * values that originated from tugbank (boot / remote DEFAULTS push) to avoid an
   * echo loop, exactly as the theme path guards its setter.
   */
  setMode(mode: KeyboardAccessMode, opts?: { persist?: boolean }): void {
    if (mode === this.mode && this.initialized) {
      // Still apply on the very first call so the attribute is present even
      // when the seeded value equals the default.
      this.applyAttribute();
      return;
    }
    this.mode = mode;
    this.initialized = true;
    this.applyAttribute();
    if (opts?.persist !== false) {
      putKeyboardAccess(mode);
    }
    this.notify();
  }

  /** Flip between the two modes. Convenience for the in-app toggle / host menu. */
  toggle(): void {
    this.setMode(this.mode === "standard" ? "accessibility" : "standard");
  }

  subscribe = (callback: () => void): (() => void) => {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  };

  private applyAttribute(): void {
    if (typeof document === "undefined") return;
    document.documentElement.setAttribute(KEYBOARD_ACCESS_ATTRIBUTE, this.mode);
  }

  private notify(): void {
    for (const cb of this.subscribers) {
      cb();
    }
  }
}

/** App-wide singleton. */
export const keyboardAccessStore = new KeyboardAccessStore();

/**
 * React hook returning the current keyboard-access mode, re-rendering on change.
 * The server snapshot is the default mode (matches first-paint behavior).
 */
export function useKeyboardAccessMode(): KeyboardAccessMode {
  return useSyncExternalStore(
    keyboardAccessStore.subscribe,
    keyboardAccessStore.getSnapshot,
    () => DEFAULT_KEYBOARD_ACCESS_MODE,
  );
}
