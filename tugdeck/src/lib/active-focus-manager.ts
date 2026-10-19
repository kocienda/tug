/**
 * The active FocusManager, reachable from outside the React tree.
 *
 * Last-registration-wins module singleton so framework code outside the React
 * tree can reach the engine — the same arrangement as
 * `registerResponderChainManager`. Used by the single-channel focus
 * dispatcher (`applyBagFocus` in `focus-transfer.ts`) to set the key card on
 * activation and re-light the keyboard ring as part of a focus-axis restore,
 * and by the shell's body wiring (`body-shell.ts`) to read the key card and
 * land a walk arriving from another page. Set by `responder-chain-provider`
 * on mount. It never crosses pages: each page has its own engine and its own
 * handle.
 *
 * The engine is component-layer; the handle lives in `lib` so `lib` can hold
 * it, and `components/tugways/focus-manager.ts` re-exports it.
 *
 * @module lib/active-focus-manager
 */

import type { FocusManager } from "../components/tugways/focus-manager";

let activeFocusManager: FocusManager | null = null;
const focusManagerRegistrationListeners = new Set<() => void>();

/** Register the active FocusManager. Called by the provider on mount. */
export function registerFocusManager(manager: FocusManager | null): void {
  if (activeFocusManager === manager) return;
  activeFocusManager = manager;
  for (const listener of [...focusManagerRegistrationListeners]) listener();
}

/**
 * Hear the active FocusManager change — for a reader outside the React tree
 * that starts before the provider mounts (a body's publisher). Returns the
 * release.
 */
export function observeFocusManagerRegistration(listener: () => void): () => void {
  focusManagerRegistrationListeners.add(listener);
  return () => {
    focusManagerRegistrationListeners.delete(listener);
  };
}

/** The active FocusManager, or `null` outside a mounted provider. */
export function getFocusManager(): FocusManager | null {
  return activeFocusManager;
}

/**
 * Land the keyboard on the first or last stop of the key card's walk, as a
 * walk arriving from another page does: the same movement a Tab is, from
 * the end it came in by. Returns whether there was a stop to land on.
 */
export function enterKeyViewWalk(
  manager: FocusManager | null,
  edge: "first" | "last",
): boolean {
  if (manager === null) return false;
  if (!manager.kbfEngaged()) manager.setKbfManual(true);
  const id = manager.focusWalkEnd(edge);
  if (id === null) return false;
  manager.place(
    null,
    { kind: "focusable", id },
    { modality: "keyboard", arrival: "movement" },
  );
  return true;
}
