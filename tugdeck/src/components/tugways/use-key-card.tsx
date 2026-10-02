/**
 * useKeyCardId / useIsKeyCard -- React hooks over the derived key-card
 * value on the responder chain manager.
 *
 * "Key card" is the nearest ancestor of `kind: "card"` reached by
 * walking up `parentId` from the current first responder. It is
 * derived, not stored — see design doc Phase 1.
 *
 * Both hooks subscribe to the manager via `useSyncExternalStore` ([L02]).
 * `manager.subscribe` already fires on every chain change that could
 * affect the derived value (register, unregister, first-responder
 * change), so the snapshot stays correct without a separate observer
 * channel. The chain's `observeKeyResponder` API exists for non-React
 * consumers; React code should prefer these hooks.
 *
 * Both hooks are tolerant of being rendered outside a
 * `<ResponderChainProvider>` — they return null / false respectively,
 * matching the existing tolerant-hook convention (see
 * `useOptionalResponder`). This keeps pane chrome render code uniform
 * across in-provider and standalone test mounts.
 */

import { useCallback, useContext } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import { ResponderChainContext } from "./responder-chain";

const NOOP_SUBSCRIBE = (): (() => void) => () => {};

/**
 * Returns the id of the current key card (nearest `kind: "card"`
 * ancestor of the first responder), or null if no card is in scope.
 *
 * Re-renders the calling component when the derived value changes.
 * Other chain changes that do not move the key card do not cause a
 * re-render, because `useSyncExternalStore` compares snapshots by
 * `Object.is` and the snapshot here is just a string id (or null).
 */
export function useKeyCardId(): string | null {
  const manager = useContext(ResponderChainContext);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (manager === null) return NOOP_SUBSCRIBE();
      return manager.subscribe(onStoreChange);
    },
    [manager],
  );

  const getSnapshot = useCallback(
    () => (manager === null ? null : manager.getKeyCard()),
    [manager],
  );

  // Server snapshot: null. The chain has no SSR semantics — there is
  // no first responder until the client mounts and a pointerdown /
  // focusin promotes one — so the only honest server value is null.
  const getServerSnapshot = useCallback(() => null, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Returns true when `cardId` is the current key card. Convenience
 * wrapper over `useKeyCardId` for the most common consumer pattern: a
 * `TugCard` rendering its own active chrome based on whether it is the
 * one the user is working in.
 */
export function useIsKeyCard(cardId: string): boolean {
  return useKeyCardId() === cardId;
}
