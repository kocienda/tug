/**
 * sheet-lifecycle.ts — per-card sheet-lifecycle event pipe.
 *
 * Five lifecycle events, fired by `TugSheet` at well-defined moments
 * during a sheet's presentation cycle:
 *
 *   1. willShow — the sheet's `TugSheetContent` has just mounted; the
 *                 enter animation has not started yet. Subscribers may
 *                 stash whatever pre-show state they need (focus
 *                 location, scroll position, etc.) before the modal
 *                 takes over.
 *   2. didShow  — the enter animation has finished. The sheet is
 *                 fully presented. Inert is set on `.tug-pane-body`
 *                 by this point, focus has been moved into the sheet.
 *   3. willHide — the close action has been taken; the exit animation
 *                 has not started yet. Subscribers may capture state
 *                 they need before the modal's teardown.
 *   4. didHide  — the exit animation has finished, the sheet's
 *                 portaled DOM has been removed, the inert attribute
 *                 has been cleared, and Radix's focus restoration
 *                 has run. The body is genuinely interactive again.
 *                 This is the moment a card-level focus claim should
 *                 fire — there is no race against Radix's teardown.
 *   5. didReturnResult — fires immediately after `didHide`, carrying
 *                 the close-result returned by `close(result)` (or
 *                 `undefined` for Escape / Cmd+. dismissals).
 *                 Replaces the legacy `onClosed(result)` closure-
 *                 callback shape with a per-card observable event.
 *                 Only fires when the sheet's consumer supplies a
 *                 `getResult` reader (hook-driven sheets via
 *                 `useTugSheet` always do; direct
 *                 `<TugSheetContent>` users that don't track a
 *                 result skip this event).
 *
 * Per-card scope. Sheets exist in the context of a card (the picker
 * is the session-card's; the gallery sheet is the gallery card's);
 * subscribers register against a `cardId` and only see that card's
 * events. A wildcard subscription (`cardId === null`) sees every
 * card's events — useful for global telemetry, not for focus work.
 *
 * The singleton-class shape mirrors `card-lifecycle.ts`. Same
 * provider pattern, same observe/delegate distinction, same
 * synchronous-fire semantics.
 *
 * Cross-references:
 *   - [L11] controls emit actions; responders own state — sheet
 *     events are notifications, not action dispatches; they do not
 *     mutate state, just announce structural transitions.
 *   - [L23] preserve user-visible state across operations — sheet
 *     close shouldn't lose focus that the chain has claimed; the
 *     `didHide` event is the structural signal a focus-claim
 *     handler subscribes to so the claim runs at the right moment.
 *   - [L24] structure-zone events drive structure-zone effects.
 */

import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
} from "react";

const LIFECYCLE_LOG: boolean = Boolean(import.meta.env?.DEV);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SheetLifecycleObserver = (cardId: string) => void;

/**
 * Result-bearing observer shape for `sheetDidReturnResult`. Receives
 * the cardId AND the close-result (or `undefined` for Escape /
 * Cmd+. dismissals).
 */
export type SheetLifecycleResultObserver = (
  cardId: string,
  result: string | undefined,
) => void;

interface Subscription {
  cardId: string | null;
  callback: SheetLifecycleObserver;
}

interface ResultSubscription {
  cardId: string | null;
  callback: SheetLifecycleResultObserver;
}

// ---------------------------------------------------------------------------
// SheetLifecycle
// ---------------------------------------------------------------------------

export class SheetLifecycle {
  private willShowSubs: Set<Subscription> = new Set();
  private didShowSubs: Set<Subscription> = new Set();
  private willHideSubs: Set<Subscription> = new Set();
  private didHideSubs: Set<Subscription> = new Set();
  private didReturnResultSubs: Set<ResultSubscription> = new Set();

  // ---- Notify (called by TugSheet) ----

  notifySheetWillShow(cardId: string): void {
    if (LIFECYCLE_LOG) {
      console.log(`[SheetLifecycle] sheetWillShow id=${cardId}`);
    }
    this.fire(this.willShowSubs, cardId);
  }

  notifySheetDidShow(cardId: string): void {
    if (LIFECYCLE_LOG) {
      console.log(`[SheetLifecycle] sheetDidShow id=${cardId}`);
    }
    this.fire(this.didShowSubs, cardId);
  }

  notifySheetWillHide(cardId: string): void {
    if (LIFECYCLE_LOG) {
      console.log(`[SheetLifecycle] sheetWillHide id=${cardId}`);
    }
    this.fire(this.willHideSubs, cardId);
  }

  notifySheetDidHide(cardId: string): void {
    if (LIFECYCLE_LOG) {
      console.log(`[SheetLifecycle] sheetDidHide id=${cardId}`);
    }
    this.fire(this.didHideSubs, cardId);
  }

  notifySheetDidReturnResult(
    cardId: string,
    result: string | undefined,
  ): void {
    if (LIFECYCLE_LOG) {
      console.log(
        `[SheetLifecycle] sheetDidReturnResult id=${cardId} result=${result ?? "undefined"}`,
      );
    }
    this.fireResult(this.didReturnResultSubs, cardId, result);
  }

  // ---- Observe (called by subscribers) ----

  observeSheetWillShow(
    cardId: string | null,
    callback: SheetLifecycleObserver,
  ): () => void {
    return this.subscribe(this.willShowSubs, cardId, callback);
  }

  observeSheetDidShow(
    cardId: string | null,
    callback: SheetLifecycleObserver,
  ): () => void {
    return this.subscribe(this.didShowSubs, cardId, callback);
  }

  observeSheetWillHide(
    cardId: string | null,
    callback: SheetLifecycleObserver,
  ): () => void {
    return this.subscribe(this.willHideSubs, cardId, callback);
  }

  observeSheetDidHide(
    cardId: string | null,
    callback: SheetLifecycleObserver,
  ): () => void {
    return this.subscribe(this.didHideSubs, cardId, callback);
  }

  observeSheetDidReturnResult(
    cardId: string | null,
    callback: SheetLifecycleResultObserver,
  ): () => void {
    const sub: ResultSubscription = { cardId, callback };
    this.didReturnResultSubs.add(sub);
    return () => {
      this.didReturnResultSubs.delete(sub);
    };
  }

  // ---- Internal ----

  private subscribe(
    set: Set<Subscription>,
    cardId: string | null,
    callback: SheetLifecycleObserver,
  ): () => void {
    const sub: Subscription = { cardId, callback };
    set.add(sub);
    return () => {
      set.delete(sub);
    };
  }

  private fire(set: Set<Subscription>, cardId: string): void {
    // Snapshot to a local array so an observer that unsubscribes itself
    // during notification doesn't mutate the set mid-iteration.
    const subs = Array.from(set);
    for (const sub of subs) {
      if (sub.cardId !== null && sub.cardId !== cardId) continue;
      try {
        sub.callback(cardId);
      } catch (err) {
        console.error(`[SheetLifecycle] observer for ${cardId} threw:`, err);
      }
    }
  }

  private fireResult(
    set: Set<ResultSubscription>,
    cardId: string,
    result: string | undefined,
  ): void {
    const subs = Array.from(set);
    for (const sub of subs) {
      if (sub.cardId !== null && sub.cardId !== cardId) continue;
      try {
        sub.callback(cardId, result);
      } catch (err) {
        console.error(
          `[SheetLifecycle] result observer for ${cardId} threw:`,
          err,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

let sheetLifecycleRef: SheetLifecycle | null = null;

export function registerSheetLifecycle(
  lifecycle: SheetLifecycle | null,
): void {
  sheetLifecycleRef = lifecycle;
}

export function getSheetLifecycle(): SheetLifecycle | null {
  return sheetLifecycleRef;
}

// ---------------------------------------------------------------------------
// React integration
// ---------------------------------------------------------------------------

export const SheetLifecycleContext = createContext<SheetLifecycle | null>(null);

export function useSheetLifecycle(): SheetLifecycle | null {
  return useContext(SheetLifecycleContext);
}

// ---------------------------------------------------------------------------
// Delegate hook
// ---------------------------------------------------------------------------

/**
 * Per-card delegate: subscribe to all four sheet-lifecycle events
 * scoped to `cardId`. The delegate object is held in a ref so an
 * inline object passed every render does not re-subscribe; only
 * `cardId` and `lifecycle` identity changes resubscribe.
 *
 * Pass `cardId: null` to subscribe to every card's sheet events
 * (rare — almost always the consumer wants their own card's events).
 */
export interface TugSheetDelegate {
  sheetWillShow?: (cardId: string) => void;
  sheetDidShow?: (cardId: string) => void;
  sheetWillHide?: (cardId: string) => void;
  sheetDidHide?: (cardId: string) => void;
  sheetDidReturnResult?: (cardId: string, result: string | undefined) => void;
}

export function useSheetDelegate(
  cardId: string | null,
  delegate: TugSheetDelegate,
): void {
  const lifecycle = useSheetLifecycle();
  const delegateRef = useRef(delegate);
  useLayoutEffect(() => {
    delegateRef.current = delegate;
  }, [delegate]);

  useLayoutEffect(() => {
    if (lifecycle === null) return;
    const unsubs: Array<() => void> = [
      lifecycle.observeSheetWillShow(cardId, (id) => {
        delegateRef.current.sheetWillShow?.(id);
      }),
      lifecycle.observeSheetDidShow(cardId, (id) => {
        delegateRef.current.sheetDidShow?.(id);
      }),
      lifecycle.observeSheetWillHide(cardId, (id) => {
        delegateRef.current.sheetWillHide?.(id);
      }),
      lifecycle.observeSheetDidHide(cardId, (id) => {
        delegateRef.current.sheetDidHide?.(id);
      }),
      lifecycle.observeSheetDidReturnResult(cardId, (id, result) => {
        delegateRef.current.sheetDidReturnResult?.(id, result);
      }),
    ];
    return () => {
      for (const u of unsubs) u();
    };
  }, [cardId, lifecycle]);
}
