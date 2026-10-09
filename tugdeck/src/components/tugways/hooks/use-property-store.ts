/**
 * use-property-store.ts -- usePropertyStore hook and CardPropertyContext.
 *
 * Provides a React hook for card content components to create and register a
 * PropertyStore with `CardHost`. Inspectors can then discover,
 * read, write, and observe properties without importing card internals.
 *
 * Usage:
 * ```tsx
 * function MyCardContent() {
 *   const store = usePropertyStore({
 *     schema: [
 *       { path: 'style.backgroundColor', type: 'color', label: 'Background' },
 *     ],
 *     initialValues: { 'style.backgroundColor': '#ffffff' },
 *   });
 *
 *   const bg = useSyncExternalStore(
 *     cb => store.observe('style.backgroundColor', cb),
 *     () => store.get('style.backgroundColor') as string,
 *   );
 *
 *   return <div style={{ backgroundColor: bg }}>Content</div>;
 * }
 * ```
 *
 * Design decisions:
 *   [D01] Context callback registration for PropertyStore
 *   [D05] Per-path observe for useSyncExternalStore
 *
 *,
 *
 */

import { createContext, useContext, useLayoutEffect, useRef } from "react";
import { PropertyStore } from "../property-store";
import type { PropertyDescriptor } from "../property-store";

// ---------------------------------------------------------------------------
// CardPropertyContext ()
// ---------------------------------------------------------------------------

/**
 * Registration callback type. `CardHost` provides this callback so that card
 * content can register its PropertyStore.
 *
 * (#s05-pane-property-context)
 */
export type PropertyStoreRegistrar = (store: PropertyStore) => void;

/**
 * React context that `CardHost` provides with a registration callback.
 *
 * Card content calls usePropertyStore(), which internally calls this callback
 * in useLayoutEffect to install the store. This mirrors the CardDataContext
 * pattern.
 *
 * Default value is null so usePropertyStore() works outside a host without
 * throwing -- the registration call is simply skipped.
 *
 * [D01] Context callback registration for PropertyStore
 * (#s05-pane-property-context)
 */
export const CardPropertyContext = createContext<PropertyStoreRegistrar | null>(null);

// ---------------------------------------------------------------------------
// usePropertyStore options ()
// ---------------------------------------------------------------------------

/**
 * Options for creating a PropertyStore via usePropertyStore.
 *
 * (#s04-use-property-store)
 */
export interface UsePropertyStoreOptions {
  /** Property descriptors defining the schema. */
  schema: PropertyDescriptor[];
  /** Initial values for each schema path. */
  initialValues: Record<string, unknown>;
  /**
   * Optional override for get(). When provided, get() calls onGet instead of
   * reading from the internal map. Used for bridging to external state.
   */
  onGet?: (path: string) => unknown;
  /**
   * Optional side-effect hook for set(). Called after internal write and
   * observer notification.
   */
  onSet?: (path: string, value: unknown, source: string) => void;
}

// ---------------------------------------------------------------------------
// usePropertyStore hook ()
// ---------------------------------------------------------------------------

/**
 * Create a PropertyStore and register it with the enclosing card host.
 *
 * The store is created once on first render via useRef -- it is stable across
 * re-renders. The store is registered with `CardHost` via CardPropertyContext
 * in useLayoutEffect (Rule #3) so it is available before events fire.
 *
 * Returns the stable PropertyStore instance. Card content uses the store
 * directly for useSyncExternalStore subscriptions:
 *
 * ```ts
 * useSyncExternalStore(
 *   cb => store.observe(path, cb),
 *   () => store.get(path),
 * )
 * ```
 *
 * [D01] Context callback registration for PropertyStore
 * (#s04-use-property-store)
 */
export function usePropertyStore(options: UsePropertyStoreOptions): PropertyStore {
  // Create the PropertyStore once on first render. The ref holds the stable
  // instance across re-renders. We initialize lazily using a sentinel ref.
  const storeRef = useRef<PropertyStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new PropertyStore({
      schema: options.schema,
      initialValues: options.initialValues,
      onGet: options.onGet,
      onSet: options.onSet,
    });
  }

  // Capture the registration callback from the host context. May be null
  // when rendered outside a card host.
  const registrar = useContext(CardPropertyContext);

  // Ref for the registrar so the useLayoutEffect closure stays fresh even if
  // the context value changes (Rule #5).
  const registrarRef = useRef(registrar);
  registrarRef.current = registrar;

  // Register the store with the host in useLayoutEffect (Rule #3) so the store
  // is available before any events fire. Re-runs if the store instance changes
  // (which only happens on mount since storeRef is stable).
  useLayoutEffect(() => {
    const store = storeRef.current!;
    registrarRef.current?.(store);
  }, []);

  return storeRef.current;
}

// Re-export PropertyStore and related types for convenience
export type { PropertyDescriptor } from "../property-store";
export { PropertyStore } from "../property-store";
export type { PropertySchema, PropertyChange, PropertyChangeListener } from "../property-store";

