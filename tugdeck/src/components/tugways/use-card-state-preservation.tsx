/**
 * CardStatePreservationContext and useCardStatePreservation hook.
 *
 * Provides the opt-in card content state preservation mechanism for
 * card content.
 *
 * Card content components call
 * `useCardStatePreservation({ onSave, onRestore })` to register
 * save/restore callbacks with their enclosing CardHost, which calls
 * `onSave` on tab deactivation and `onRestore` on tab activation, using
 * the DeckManager tab state cache as the durable backing store.
 *
 * **Authoritative references:** [D01] onContentReady callback, [D02]
 * card state preservation hook, [D03] restorePendingRef, Rule 11,
 * Rule 12.
 */

import React, { createContext, useContext, useLayoutEffect, useRef } from "react";

import { DeckManagerContext } from "../../deck-manager-context";
import type { SaveCallbackSource } from "../../deck-trace";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options accepted by useCardStatePreservation.
 *
 * Generic over T so card content components get type-safe onRestore.
 * Internally stored as CardStatePreservationCallbacks (erased to unknown)
 * so CardHost can treat the content payload as opaque JSON.
 *
 * ([D02])
 */
/**
 * Options accepted by `onRestore`, threaded by CardHost at restore time.
 *
 * `isActive` names the deck-level first responder: the card that holds
 * the document's focus authority for the entire page. CardHost computes
 * this as `deck.getFirstResponderCardId() === cardId`. Pane-active cards in non-active
 * panes are NOT active by this definition; their persisted selections
 * route through the inactive-paint channel via
 * `engine.paintMirrorAsInactive(publish)`.
 *
 * [L23], [D10].
 */
export interface CardRestoreOptions {
  /** True iff this card is the deck-level first responder at the moment
   *  of restore. Drives `paintMirrorAsActive` vs `paintMirrorAsInactive`
   *  routing in the consumer. */
  isActive: boolean;
}

export interface UseCardStatePreservationOptions<T> {
  /**
   * Called by CardHost on tab deactivation and on every save trigger. Must
   * return JSON-serializable state.
   *
   * `source` names the triggering path. It matters for one case: on
   * `"termination"` the app is exiting and there is no next render, so a
   * card that holds user text outside its visible surface (queued sends, a
   * pulled-back submission) must fold it into what it returns here.
   */
  onSave: (source?: SaveCallbackSource) => T;
  /**
   * Called by CardHost on cold-mount restore (and on tab activation
   * for content-owning cards). The `opts.isActive` flag tells the
   * consumer whether this card is the deck-level first responder —
   * the consumer routes selection paint through
   * `paintMirrorAsActive` (active) or `paintMirrorAsInactive(publish)`
   * (inactive) accordingly. [L23].
   */
  onRestore: (state: T, opts: CardRestoreOptions) => void;
  /**
   * Called when this card transitions to being the focus destination —
   * i.e. `isFocusDestination` flips from `false` to `true`. Typical
   * implementation for content-owning cards:
   *
   * ```ts
   * onCardActivated: () => {
   *   engine.paintMirrorAsActive();
   * }
   * ```
   *
   * Registration happens in the hook's mount `useLayoutEffect`. The
   * callback is registered on the state preservation record and on the
   * deck store's `registerActivationCallback` channel; see
   * {@link CardStatePreservationCallbacks.onCardActivated}.
   *
   * Optional. FC (DOM-authority) cards don't need this — `CardHost`
   * re-applies `bag.focus` + `bag.domSelection` directly for them.
   */
  onCardActivated?: () => void;
  /**
   * Called when this card is about to lose focus-destination status —
   * i.e. activation is about to move to a sibling card. The consumer
   * uses this to hand its selection over to the inactive-paint channel
   * (via `engine.paintMirrorAsInactive(publish)`) before the new
   * active card claims focus + global Selection. Without this, the
   * deactivated card's selection is destroyed when the new card calls
   * `setSelectedRange` (which runs `removeAllRanges` on the global
   * Selection).
   *
   * [L23] enforcement.
   *
   * Optional. FC (DOM-authority) cards don't need this.
   */
  onCardWillDeactivate?: () => void;
}

// ---------------------------------------------------------------------------
// CardStatePreservationCallbacks
// ---------------------------------------------------------------------------

/**
 * Save/restore callback pair registered by card content components via
 * `useCardStatePreservation`. CardHost calls these on tab
 * deactivation/activation.
 *
 * - `onSave()` is called on deactivation. Returns opaque JSON-serializable state.
 * - `onRestore(state)` is called on activation with the previously saved state.
 * - `onContentReady` is written by CardHost into this object before calling
 *   `onRestore`. The hook's no-deps `useLayoutEffect` fires it after the child's
 *   DOM commits (Rule 11, Rule 12, [D78], [D79]).
 * - `restorePendingRef` is created by the hook and included here so CardHost can
 *   set it to `true` before calling `onRestore`, signaling that a restore is in
 *   flight. The hook's no-deps `useLayoutEffect` reads this flag. ([D03])
 *
 * ([D02], [D01], [D03])
 */
export interface CardStatePreservationCallbacks {
  onSave: (source?: SaveCallbackSource) => unknown;
  /**
   * Called by CardHost on cold-mount restore (and on tab activation
   * for content-owning cards). `opts.isActive` is the deck-level
   * first-responder snapshot — [L23].
   */
  onRestore: (state: unknown, opts: CardRestoreOptions) => void;
  /**
   * Written by CardHost before calling `onRestore`. Fired by the hook's
   * no-deps `useLayoutEffect` after the child's DOM commits. Optional because
   * existing card content that doesn't need ready signaling is unaffected.
   *
   * Rule 11, Rule 12, [D78], [D79], [D01]
   */
  onContentReady?: () => void;
  /**
   * Ref created by the hook, set to `true` by CardHost before calling
   * `onRestore`. Read by the hook's no-deps `useLayoutEffect`. Shared via this
   * callbacks object so no new context or side channel is needed. ([D03])
   */
  restorePendingRef?: React.RefObject<boolean>;
  /**
   * Called when this card becomes the focus destination.
   *
   * **Dispatch channel.** The deck store's `invokeActivationCallback` is
   * the live dispatch path. This record field remains for compatibility
   * and tests; production routing goes through
   * `store.registerActivationCallback` / `invokeActivationCallback`.
   *
   * Optional. FC (DOM-authority) cards leave it unset; `CardHost`
   * handles their reactivation by re-applying `bag.focus` +
   * `bag.domSelection` directly.
   */
  onCardActivated?: () => void;
  /**
   * Called when this card is about to lose focus-destination status,
   * before another card's activation hook claims the global Selection.
   * Mirror image of `onCardActivated`. Lets the consumer route its
   * selection into the inactive-paint channel
   * (`paintMirrorAsInactive(publish)`) so the about-to-be-active
   * card's `removeAllRanges()` doesn't destroy this card's selection.
   *
   * [L23] enforcement.
   *
   * Optional. FC (DOM-authority) cards leave it unset.
   */
  onCardWillDeactivate?: () => void;
}

// ---------------------------------------------------------------------------
// CardStatePreservationContext
// ---------------------------------------------------------------------------

/**
 * Value carried by {@link CardStatePreservationContext}. CardHost writes
 * this pair on mount so descendants can both register state preservation
 * callbacks and learn the id of the card they are rendering inside.
 * `cardId` is separate from the render-time `CardHost` props so content
 * components (e.g. `TugPromptInput`) can forward the id to non-React
 * singletons like `selectionGuard` without prop-drilling or reading the
 * deck tree.
 */
export interface CardStatePreservationContextValue {
  /** Stable identity of the enclosing card — survives cross-pane moves. */
  cardId: string;
  /** Register state preservation callbacks for this card. Called once per mount. */
  register: (callbacks: CardStatePreservationCallbacks) => void;
}

/**
 * Context provided by CardHost to its children.
 *
 * The value bundles the enclosing card's id and the stable registration
 * function. Card content components call `useCardStatePreservation()`
 * which reads this context and registers their save/restore callbacks
 * in `useLayoutEffect` (Rule 3 of Rules of Tugways). Components that
 * need the card id for out-of-tree wiring read it via {@link useCardId}.
 *
 * null when rendered outside CardHost (no-op in useCardStatePreservation).
 *
 * ([D02])
 */
export const CardStatePreservationContext = createContext<
  CardStatePreservationContextValue | null
>(null);

/**
 * Hook that returns the enclosing card's id, or `null` when rendered
 * outside `CardHost`. Card content components use this to wire
 * themselves into card-scoped singletons (e.g. `selectionGuard`).
 */
export function useCardId(): string | null {
  return useContext(CardStatePreservationContext)?.cardId ?? null;
}

// ---------------------------------------------------------------------------
// useCardStatePreservation hook
// ---------------------------------------------------------------------------

/**
 * Hook for card content components to opt in to state preservation.
 *
 * On tab deactivation, CardHost calls `onSave()` and stores the result in
 * the DeckManager tab state cache (and debounced to tugbank). On tab
 * activation, CardHost calls `onRestore(savedState)` with the previously
 * saved value. If no state was saved, `onRestore` is not called.
 *
 * **Rules of Tugways compliance:**
 * - Rule 3: Registers callbacks via `useLayoutEffect` so they are available
 *   before any events fire.
 * - Rule 5: Stores `onSave`/`onRestore` in refs so the registered wrappers
 *   never go stale, even when options change on re-renders.
 * - Rule 11: `onContentReady` fires deterministically after child DOM commits
 *   via the ref-flag no-deps `useLayoutEffect`. No `requestAnimationFrame`.
 * - Rule 12: The `restorePendingRef` flag is the cancellation mechanism for
 *   rapid tab switches. ([D78], [D79])
 *
 * Returns cleanup that unregisters (sets state preservation callbacks
 * to null) when the card content component unmounts.
 *
 * ([D02], [D01], [D02], [D03])
 */
export function useCardStatePreservation<T>(options: UseCardStatePreservationOptions<T>): void {
  // Read the registration function + cardId from context (null outside
  // CardHost). `cardId` is needed to route `onCardActivated` through
  // the deck store's activation-callback channel alongside the
  // callbacks-record registration.
  const statePreservationCtx = useContext(CardStatePreservationContext);
  const register = statePreservationCtx?.register ?? null;
  const cardId = statePreservationCtx?.cardId ?? null;

  // DeckManagerContext is optional from this hook's perspective —
  // the hook is used in unit tests that render a card content
  // component without a deck store. When present, we register the
  // activation callback on the store so `focus-transfer` can
  // dispatch through `store.invokeActivationCallback`. When absent,
  // the store-channel registration is skipped; the record-channel
  // registration still happens below.
  const store = useContext(DeckManagerContext);

  // Store the caller's options in refs so the registered wrappers never go
  // stale when options change on re-renders (Rule 5).
  const onSaveRef = useRef<((source?: SaveCallbackSource) => T) | undefined>(undefined);
  const onRestoreRef = useRef<
    ((state: T, opts: CardRestoreOptions) => void) | undefined
  >(undefined);
  const onCardActivatedRef = useRef<(() => void) | undefined>(undefined);
  const onCardWillDeactivateRef = useRef<(() => void) | undefined>(undefined);
  onSaveRef.current = options.onSave;
  onRestoreRef.current = options.onRestore;
  onCardActivatedRef.current = options.onCardActivated;
  onCardWillDeactivateRef.current = options.onCardWillDeactivate;

  // Ref-flag mechanism ([D02], [D03],):
  // CardHost sets restorePendingRef.current = true before calling onRestore.
  // The no-deps useLayoutEffect below checks this flag on every commit and
  // fires onContentReady when set. This is the deterministic alternative to
  // requestAnimationFrame (Rule 12, [D79]).
  const restorePendingRef = useRef<boolean>(false);

  // Holds the callbacks object so the no-deps effect can read onContentReady
  // from it without capturing a closure. May reference a stale callbacks object
  // after unmount cleanup (which re-registers a no-op pair without
  // restorePendingRef). This is safe: after unmount, no further effects fire on
  // this component, so the no-deps useLayoutEffect never reads the stale ref.
  const callbacksObjRef = useRef<CardStatePreservationCallbacks | null>(null);

  // Register stable wrappers that read from refs at call time.
  // useLayoutEffect runs before any events can fire (Rule 3).
  // Dependency array is [register] so registration runs once on mount and
  // cleanup runs on unmount -- updating onSave/onRestore does not re-register.
  useLayoutEffect(() => {
    if (!register) return;

    const callbacks: CardStatePreservationCallbacks = {
      onSave: (source) => onSaveRef.current?.(source) as unknown,
      onRestore: (state: unknown, opts: CardRestoreOptions) =>
        onRestoreRef.current?.(state as T, opts),
      // Forward through a stable ref-reading wrapper so the latest
      // caller-supplied implementation fires even when `options`
      // changes across re-renders (Rule 5). `undefined` when the
      // caller didn't provide it — the dispatcher in [A3] checks for
      // presence before invoking.
      onCardActivated: () => onCardActivatedRef.current?.(),
      onCardWillDeactivate: () => onCardWillDeactivateRef.current?.(),
      restorePendingRef,
    };

    register(callbacks);
    callbacksObjRef.current = callbacks;

    // Cleanup: unregister when the card content component unmounts by
    // registering a no-op pair. CardHost will call onSave on cleanup if it
    // runs deactivation, but the ref callbacks will still be valid until
    // unmount completes, so this is safe.
    return () => {
      register({
        onSave: () => undefined,
        onRestore: () => {},
      });
    };
  }, [register]);

  // Parallel registration on the deck store's activation-callback
  // channel. The stable ref-reading wrapper is the same one used for
  // the callbacks record; the store channel is what `focus-transfer`
  // invokes at activation time.
  //
  // Keyed on `[store, cardId]` so a move from one store to another
  // (tests that swap the provider) or a cardId change re-registers
  // cleanly. In practice `cardId` is stable across a card's lifetime
  // (that is the point of the identity), but keying on it keeps the
  // effect honest if the context value ever changes.
  //
  // Rule 3 — `useLayoutEffect` so the registration lands in the
  // same commit phase as any event that could drive an activation.
  // Rule 5 — the registered wrapper reads from `onCardActivatedRef`
  // at call time, so options changes don't require re-registration.
  useLayoutEffect(() => {
    if (!store || !cardId) return;
    const unregister = store.registerActivationCallback(cardId, () => {
      onCardActivatedRef.current?.();
    });
    return unregister;
  }, [store, cardId]);

  // Parallel registration on the deck store's deactivation-callback
  // channel. [L23]: lets the store dispatch
  // `onCardWillDeactivate` to this card before the new active card
  // claims focus + global Selection. Same ref-reading wrapper pattern
  // as activation; same Rule 3 / Rule 5 compliance.
  useLayoutEffect(() => {
    if (!store || !cardId) return;
    const unregister = store.registerDeactivationCallback(cardId, () => {
      onCardWillDeactivateRef.current?.();
    });
    return unregister;
  }, [store, cardId]);

  // No-deps useLayoutEffect: fires on every commit of this component.
  // When restorePendingRef is true (set by CardHost's Phase 1 effect before
  // calling onRestore), the child's setState has now committed to the DOM.
  // Fire onContentReady and reset the flag. ([D01], [D02],, Rule 11)
  useLayoutEffect(() => {
    if (!restorePendingRef.current) return;
    restorePendingRef.current = false;
    const onReady = callbacksObjRef.current?.onContentReady;
    if (onReady) onReady();
  });
}
