/**
 * use-card-property-store.ts — host-side hook that owns the slot a card's
 * PropertyStore registers into.
 *
 * `CardHost` provides `CardPropertyContext` so card content can call
 * `usePropertyStore(...)` (`./use-property-store.ts`) to create and install a
 * `PropertyStore`. This hook owns the harness side of that handshake: a
 * stable ref that the registrar writes into, and a `useCallback`-stable
 * `register` function the harness hands to `CardPropertyContext`.
 *
 * Separating the ref + register pair from `CardHost`'s body lets the host
 * consume `ref.current` from its `SET_PROPERTY` responder handler without
 * inlining the registration plumbing.
 *
 * @module components/tugways/hooks/use-card-property-store
 */

import { useCallback, useRef } from "react";
import type { PropertyStore } from "@/lib/property-store";

export interface UseCardPropertyStoreResult {
  /** Stable registrar to pass to `CardPropertyContext`. */
  register: (ps: PropertyStore) => void;
  /** Ref populated by `register`; read `ref.current` at event time. */
  ref: React.RefObject<PropertyStore | null>;
}

export function useCardPropertyStore(): UseCardPropertyStoreResult {
  const ref = useRef<PropertyStore | null>(null);
  const register = useCallback((ps: PropertyStore) => {
    ref.current = ps;
  }, []);
  return { register, ref };
}
