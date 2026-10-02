/**
 * useComponentStatePreservation — opt-in Component State Preservation
 * Protocol ([D13], [A9]) hook for stateful `tugways` components.
 *
 * The API has two halves, each with a single job:
 *
 *   - `useComponentStatePreservation({ componentStatePreservationKey,
 *     captureState })` — registers the component for **capture**. Per
 *     [A9a] the closure is stored in a ref synced on every render (so
 *     the framework always reads the latest render's closure, never a
 *     stale mount-time capture). The hook registers with the nearest
 *     `ComponentStatePreservationRegistry` inside a `useLayoutEffect`
 *     per [L03]: registration is in place before any event-driven
 *     consumer could call capture.
 *
 *   - `useSavedComponentState<T>(componentStatePreservationKey)` — reads
 *     the **saved** value for that key from the per-card `CardStateBag`
 *     synchronously in render. Consumed inside a `useState` initializer
 *     so the component mounts in its saved state on the very first
 *     paint. There is no post-mount "apply saved value" path: every
 *     consumer reads its saved value at render time, full stop.
 *
 *   - `useSavedRegionScroll(scrollKey)` — companion to the above for
 *     scroll positions saved on the [A9] region-scroll axis. Body kinds
 *     whose imperative renderer accepts an `initialScrollTop` (the
 *     TerminalBlock virtualized scrollport, the FileBlock CM6 mount)
 *     read this and write the saved scroll into the scroller at
 *     creation. The scroller's first observable `scrollTop` is the
 *     saved value — no jump from 0.
 *
 * Three context layers collaborate to deliver per-card saved state to
 * the right hook call:
 *
 *   - `CardComponentStatePreservationContext` carries the per-card
 *     registry reference, the accumulated scope prefix, the current
 *     scope depth (`treePath`), the saved-state accessors, and the
 *     subscribe channel that drives `useSyncExternalStore`. `CardHost`
 *     provides the root value; rendering a participating component
 *     outside any provider is supported (gallery demos, standalone
 *     tests) — `register`-side calls no-op with a single dev-warn, and
 *     the saved-state accessors return `undefined`.
 *
 *   - `<ComponentStatePreservationScope prefix>` is a context provider
 *     that prepends `prefix + "/"` to every nested
 *     `componentStatePreservationKey`, letting composite components
 *     embed other opt-in components without knowing their inner keys.
 *     Scopes nest additively; scope depth is carried in the context's
 *     `treePath` so the registry's parent-first iteration sees
 *     ancestors before descendants (per [D13] Q3 resolution).
 *
 *   - `useSyncExternalStore` is how saved-state reads enter React per
 *     [L02]. The accessor hooks subscribe to the deck manager's notify
 *     channel; future bag mutations that go through `notify()` will
 *     refresh the read. Today the typical consumption pattern (read
 *     inside a `useState` initializer) only consults the value once, so
 *     reactivity is mostly a free correctness property — but it stays
 *     correct if a future consumer reads outside an initializer.
 *
 * Opt-in: components that do not pass a
 * `componentStatePreservationKey` (or that are used outside a card)
 * carry no state preservation. Uniqueness of scoped keys at card scope
 * is enforced by the registry in dev (dev-only throw on duplicate).
 * Capture is synchronous and must not return a Promise; the framework
 * reads `captureRef.current()` during save and expects a serializable
 * value.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import type { ComponentStatePreservationRegistry } from "./component-state-preservation-registry";
import { isDevEnv } from "../../lib/dev-env";

/**
 * A region's saved scroll position, as stored in `bag.regionScroll[key]`.
 * `meta` carries optional anchor metadata used by the outer-transcript
 * anchor restore path; consumers that only need the raw scroll position
 * can ignore it.
 */
export interface SavedRegionScroll {
  x: number;
  y: number;
  meta?: unknown;
}

/**
 * Internal context value carried down the React tree from `CardHost`.
 *
 *   - `registry` is `null` outside any card — a rendered-outside-a-card
 *     component should degrade gracefully (dev-warn, no-op) rather than
 *     throw, so we carry a nullable value instead of an undefined context.
 *   - `prefix` is the accumulated `<ComponentStatePreservationScope>`
 *     chain, including the trailing `/` separator (empty at card root).
 *   - `treePath` records the scope depth as a sequence of sentinel
 *     indices — one segment per enclosing
 *     `<ComponentStatePreservationScope>`. The registry's parent-first
 *     iteration sorts on `treePath` lex order; a deeper path is always
 *     longer than any ancestor's, so ancestors iterate first.
 *   - `getSavedComponentState` / `getSavedRegionScroll` read the saved
 *     value from the per-card `CardStateBag` for a given fully-scoped
 *     key. The default-value implementations return `undefined` (used
 *     outside a card).
 *   - `subscribe` is the deck manager's notify channel; the accessor
 *     hooks pass it to `useSyncExternalStore` per [L02]. Outside a card
 *     it is a no-op subscribe that never fires.
 */
export interface CardComponentStatePreservationContextValue {
  registry: ComponentStatePreservationRegistry | null;
  prefix: string;
  treePath: readonly number[];
  getSavedComponentState: (scopedKey: string) => unknown;
  getSavedRegionScroll: (scrollKey: string) => SavedRegionScroll | undefined;
  subscribe: (callback: () => void) => () => void;
}

const NOOP_SUBSCRIBE: (callback: () => void) => () => void = () => () => {};

const DEFAULT_CONTEXT_VALUE: CardComponentStatePreservationContextValue = {
  registry: null,
  prefix: "",
  treePath: [],
  getSavedComponentState: () => undefined,
  getSavedRegionScroll: () => undefined,
  subscribe: NOOP_SUBSCRIBE,
};

/**
 * Context carrying the per-card registry reference, saved-state
 * accessors, and the notify channel down the tree. Root provider is
 * `CardHost`; nested `<ComponentStatePreservationScope>` providers
 * extend the prefix and `treePath`. The default value signals "not
 * inside a card"; the accessor hooks return `undefined` and the
 * registration hook no-ops gracefully.
 */
export const CardComponentStatePreservationContext =
  createContext<CardComponentStatePreservationContextValue>(DEFAULT_CONTEXT_VALUE);

/**
 * Read the currently-accumulated `<ComponentStatePreservationScope>`
 * prefix. Exposed for tests and for composite components that need to
 * know their own scoped namespace; most callers do not need this
 * directly.
 */
export function useComponentStatePreservationScopePrefix(): string {
  return useContext(CardComponentStatePreservationContext).prefix;
}

export interface ComponentStatePreservationScopeProps {
  /**
   * Prefix segment to prepend to every nested
   * `componentStatePreservationKey`. The terminating `/` separator is
   * added automatically. Must be non-empty; an empty prefix would
   * collapse into the parent scope and defeat the purpose of the
   * nesting boundary.
   */
  prefix: string;
  children?: ReactNode;
}

/**
 * Wrap a subtree so nested `useComponentStatePreservation` calls
 * auto-prefix their keys with `prefix + "/"`. Scopes nest additively. A
 * composite component can embed other opt-in components without knowing
 * their inner `componentStatePreservationKey`s.
 *
 * Dev-only: an empty `prefix` throws — empty would be indistinguishable
 * from the parent scope and would silently lose the uniqueness
 * boundary.
 */
export function ComponentStatePreservationScope({
  prefix,
  children,
}: ComponentStatePreservationScopeProps): React.ReactElement {
  const parent = useContext(CardComponentStatePreservationContext);

  if (isDevEnv() && prefix.length === 0) {
    throw new Error(
      "[A9] <ComponentStatePreservationScope> requires a non-empty `prefix`.",
    );
  }

  const value = useMemo<CardComponentStatePreservationContextValue>(
    () => ({
      registry: parent.registry,
      prefix: parent.prefix + prefix + "/",
      treePath: [...parent.treePath, 0],
      getSavedComponentState: parent.getSavedComponentState,
      getSavedRegionScroll: parent.getSavedRegionScroll,
      subscribe: parent.subscribe,
    }),
    [
      parent.registry,
      parent.prefix,
      parent.treePath,
      parent.getSavedComponentState,
      parent.getSavedRegionScroll,
      parent.subscribe,
      prefix,
    ],
  );

  return (
    <CardComponentStatePreservationContext.Provider value={value}>
      {children}
    </CardComponentStatePreservationContext.Provider>
  );
}

export interface UseComponentStatePreservationOptions<T> {
  /**
   * Stable identifier for this component instance's slot in
   * `bag.components`. Must be unique within the card's scope after
   * `<ComponentStatePreservationScope>` prefixing; duplicates throw in
   * dev.
   *
   * Accepts `undefined` so components can expose opt-in state
   * preservation behind an optional prop without contorting their
   * render tree to avoid the hook call (a conditional
   * `useComponentStatePreservation` would violate the Rules of Hooks).
   * The hook still fires every render; when
   * `componentStatePreservationKey` is missing it skips registration
   * and the outside-a-card dev-warn, so a non-opting caller pays no
   * cost and emits no noise.
   */
  componentStatePreservationKey: string | undefined;
  /**
   * Return the component's current serializable state. Must be
   * synchronous. Called by the framework at explicit capture moments
   * only; never per-keystroke.
   */
  captureState: () => T;
}

/**
 * Register a component for capture into `bag.components`.
 *
 * Pattern (paired with `useSavedComponentState` in a `useState`
 * initializer for the mount-in-saved-state half):
 *
 * ```tsx
 * function TugCheckbox({ componentStatePreservationKey }: Props) {
 *   const saved = useSavedComponentState<{checked: boolean}>(
 *     componentStatePreservationKey,
 *   );
 *   const [checked, setChecked] = useState(() => saved?.checked ?? false);
 *   useComponentStatePreservation({
 *     componentStatePreservationKey,
 *     captureState: () => ({ checked }),
 *   });
 *   // ...
 * }
 * ```
 *
 * Hook behavior outside a card (no
 * `CardComponentStatePreservationContext` provider): no-op with a
 * single dev-warn per call site. Gallery demos and standalone component
 * tests continue to render without requiring a card wrapper.
 */
export function useComponentStatePreservation<T>({
  componentStatePreservationKey,
  captureState,
}: UseComponentStatePreservationOptions<T>): void {
  const { registry, prefix, treePath } = useContext(
    CardComponentStatePreservationContext,
  );

  // Hold the latest render's closure in a ref, then re-sync on every
  // render. The framework reads `.current` at capture time, so the
  // closure always sees the latest React state. A ref (not state) keeps
  // this out of React's update graph — [L02]-adjacent (external-state-
  // aware but not a store).
  const captureRef = useRef<(() => unknown) | null>(null);
  captureRef.current = captureState as () => unknown;

  // Freeze the treePath at register-time so registry iteration order is
  // stable across re-renders. The scope-depth-driven path never changes
  // for a given mount.
  const treePathRef = useRef<readonly number[] | null>(null);
  if (treePathRef.current === null) {
    treePathRef.current = treePath;
  }

  // Opt-in gate: when the caller passes
  // `componentStatePreservationKey === undefined` the hook stays a
  // no-op. This lets components expose a `componentStatePreservationKey?`
  // prop without forking their render tree. `scopedKey` is kept stable
  // as an empty string when disabled so the effect's dep array is
  // stable (the effect body early-returns before it's consulted).
  const isEnabled =
    typeof componentStatePreservationKey === "string" &&
    componentStatePreservationKey.length > 0;
  const scopedKey = isEnabled ? prefix + componentStatePreservationKey : "";

  // One-shot dev-warn when the hook is used outside a card. A per-mount
  // ref guards the warning so repeated renders don't spam the console.
  const warnedRef = useRef(false);

  useLayoutEffect(() => {
    if (!isEnabled) return;
    if (!registry) {
      if (isDevEnv() && !warnedRef.current) {
        warnedRef.current = true;
        console.warn(
          `[A9] useComponentStatePreservation("${scopedKey}") rendered outside a ` +
            `CardComponentStatePreservationContext; state will not be preserved. This is ` +
            `expected in gallery demos and standalone tests.`,
        );
      }
      return;
    }

    registry.register(
      scopedKey,
      captureRef as RefObject<() => unknown>,
      treePathRef.current ?? [],
    );
    return () => {
      registry.unregister(scopedKey);
    };
    // treePathRef is immutable for the mount; captureRef is re-synced
    // above and read by the framework via `.current`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEnabled, registry, scopedKey]);
}

/**
 * Read the saved component state for `componentStatePreservationKey`
 * from the enclosing card's `CardStateBag`. Returns `undefined` when
 * the card has no saved value for this key, when the key is
 * `undefined`, or when the component renders outside a card.
 *
 * Consume inside a `useState` initializer so the component mounts in
 * its saved state on first paint:
 *
 * ```ts
 * const saved = useSavedComponentState<{collapsed: boolean}>(key);
 * const [collapsed, setCollapsed] = useState(() => saved?.collapsed ?? false);
 * ```
 *
 * Reading outside an initializer is supported (the hook subscribes to
 * the deck manager's notify channel via `useSyncExternalStore`, so
 * future bag updates re-fire the read) but rarely needed: a post-mount
 * apply path causes the wild-scrolling failure that mount-in-saved-state
 * eliminates. If you find yourself reading the saved value at a moment
 * other than mount, you are almost certainly doing the wrong thing —
 * the value React holds is the source of truth after mount.
 */
export function useSavedComponentState<T>(
  componentStatePreservationKey: string | undefined,
): T | undefined {
  const { prefix, getSavedComponentState, subscribe } = useContext(
    CardComponentStatePreservationContext,
  );
  const isEnabled =
    typeof componentStatePreservationKey === "string" &&
    componentStatePreservationKey.length > 0;
  const scopedKey = isEnabled ? prefix + componentStatePreservationKey : "";

  const getSnapshot = useCallback((): T | undefined => {
    if (!isEnabled) return undefined;
    return getSavedComponentState(scopedKey) as T | undefined;
  }, [isEnabled, scopedKey, getSavedComponentState]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Read the saved scroll position for `scrollKey` from the enclosing
 * card's `bag.regionScroll`. Returns `undefined` when no value is
 * saved for that key, when `scrollKey` is `undefined`, or when the
 * component renders outside a card.
 *
 * Imperative renderers that own an inner scrollport (TerminalBlock's
 * virtualized scroller, FileBlock's CM6 view) consume this and write
 * the saved `y` into the scroller at creation time. The MutationObserver-
 * driven region-scroll apply path in `card-host.tsx` becomes a no-op
 * for those scrollers on cold boot (the first observable `scrollTop`
 * already matches the bag); it stays in place as the fallback for
 * mid-card-lifetime scroller rebuilds, which are gated on element
 * identity in CardHost. See `state-preservation.md` for the contract.
 */
export function useSavedRegionScroll(
  scrollKey: string | undefined,
): SavedRegionScroll | undefined {
  const { getSavedRegionScroll, subscribe } = useContext(
    CardComponentStatePreservationContext,
  );
  const isEnabled = typeof scrollKey === "string" && scrollKey.length > 0;

  const getSnapshot = useCallback((): SavedRegionScroll | undefined => {
    if (!isEnabled) return undefined;
    return getSavedRegionScroll(scrollKey as string);
  }, [isEnabled, scrollKey, getSavedRegionScroll]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
