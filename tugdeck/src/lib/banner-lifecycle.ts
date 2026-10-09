/**
 * banner-lifecycle.ts — per-card banner-lifecycle event pipe.
 *
 * Four lifecycle events, fired by `TugPaneBanner` at well-defined
 * moments during the banner's presentation cycle:
 *
 *   1. willShow — `visible` flipped to true; the banner is mounting,
 *                 the enter animation has not started yet.
 *   2. didShow  — the enter animation has finished. The banner is
 *                 fully presented. Inert is set on `.tug-pane-body`
 *                 by this point (for non-`contained` banners).
 *   3. willHide — `visible` flipped to false; the exit animation
 *                 has not started yet.
 *   4. didHide  — the exit animation has finished, `mounted` has
 *                 returned to false, the inert attribute has been
 *                 cleared. The body is interactive again. This is
 *                 the moment a card-level focus claim should fire.
 *
 * Per-card scope. The banner-lifecycle is keyed by the cardId that
 * the banner is hosted in (read by `TugPaneBanner` from
 * `CardIdContext`); subscribers register against a `cardId` and only
 * see that card's events. A wildcard subscription (`cardId === null`)
 * sees every card's events.
 *
 * Mirrors `sheet-lifecycle.ts` for shape and `card-lifecycle.ts` for
 * provider pattern. See those modules' docstrings for the broader
 * architectural rationale.
 *
 * Cross-references:
 *   - [L11] events are notifications, not action dispatches.
 *   - [L23] focus + selection survive the banner show/hide cycle —
 *     `didHide` is the structural signal that the body is non-inert
 *     again, so a focus-claim handler subscribed here lands focus
 *     after the inert clears.
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

export type BannerLifecycleObserver = (cardId: string) => void;

interface Subscription {
  cardId: string | null;
  callback: BannerLifecycleObserver;
}

// ---------------------------------------------------------------------------
// BannerLifecycle
// ---------------------------------------------------------------------------

export class BannerLifecycle {
  private willShowSubs: Set<Subscription> = new Set();
  private didShowSubs: Set<Subscription> = new Set();
  private willHideSubs: Set<Subscription> = new Set();
  private didHideSubs: Set<Subscription> = new Set();

  // ---- Notify (called by TugPaneBanner) ----

  notifyBannerWillShow(cardId: string): void {
    if (LIFECYCLE_LOG) {
      console.log(`[BannerLifecycle] bannerWillShow id=${cardId}`);
    }
    this.fire(this.willShowSubs, cardId);
  }

  notifyBannerDidShow(cardId: string): void {
    if (LIFECYCLE_LOG) {
      console.log(`[BannerLifecycle] bannerDidShow id=${cardId}`);
    }
    this.fire(this.didShowSubs, cardId);
  }

  notifyBannerWillHide(cardId: string): void {
    if (LIFECYCLE_LOG) {
      console.log(`[BannerLifecycle] bannerWillHide id=${cardId}`);
    }
    this.fire(this.willHideSubs, cardId);
  }

  notifyBannerDidHide(cardId: string): void {
    if (LIFECYCLE_LOG) {
      console.log(`[BannerLifecycle] bannerDidHide id=${cardId}`);
    }
    this.fire(this.didHideSubs, cardId);
  }

  // ---- Observe (called by subscribers) ----

  observeBannerWillShow(
    cardId: string | null,
    callback: BannerLifecycleObserver,
  ): () => void {
    return this.subscribe(this.willShowSubs, cardId, callback);
  }

  observeBannerDidShow(
    cardId: string | null,
    callback: BannerLifecycleObserver,
  ): () => void {
    return this.subscribe(this.didShowSubs, cardId, callback);
  }

  observeBannerWillHide(
    cardId: string | null,
    callback: BannerLifecycleObserver,
  ): () => void {
    return this.subscribe(this.willHideSubs, cardId, callback);
  }

  observeBannerDidHide(
    cardId: string | null,
    callback: BannerLifecycleObserver,
  ): () => void {
    return this.subscribe(this.didHideSubs, cardId, callback);
  }

  // ---- Internal ----

  private subscribe(
    set: Set<Subscription>,
    cardId: string | null,
    callback: BannerLifecycleObserver,
  ): () => void {
    const sub: Subscription = { cardId, callback };
    set.add(sub);
    return () => {
      set.delete(sub);
    };
  }

  private fire(set: Set<Subscription>, cardId: string): void {
    const subs = Array.from(set);
    for (const sub of subs) {
      if (sub.cardId !== null && sub.cardId !== cardId) continue;
      try {
        sub.callback(cardId);
      } catch (err) {
        console.error(`[BannerLifecycle] observer for ${cardId} threw:`, err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

let bannerLifecycleRef: BannerLifecycle | null = null;

export function registerBannerLifecycle(
  lifecycle: BannerLifecycle | null,
): void {
  bannerLifecycleRef = lifecycle;
}

export function getBannerLifecycle(): BannerLifecycle | null {
  return bannerLifecycleRef;
}

// ---------------------------------------------------------------------------
// React integration
// ---------------------------------------------------------------------------

export const BannerLifecycleContext = createContext<BannerLifecycle | null>(null);

export function useBannerLifecycle(): BannerLifecycle | null {
  return useContext(BannerLifecycleContext);
}

// ---------------------------------------------------------------------------
// Delegate hook
// ---------------------------------------------------------------------------

export interface TugBannerDelegate {
  bannerWillShow?: (cardId: string) => void;
  bannerDidShow?: (cardId: string) => void;
  bannerWillHide?: (cardId: string) => void;
  bannerDidHide?: (cardId: string) => void;
}

export function useBannerDelegate(
  cardId: string | null,
  delegate: TugBannerDelegate,
): void {
  const lifecycle = useBannerLifecycle();
  const delegateRef = useRef(delegate);
  useLayoutEffect(() => {
    delegateRef.current = delegate;
  }, [delegate]);

  useLayoutEffect(() => {
    if (lifecycle === null) return;
    const unsubs: Array<() => void> = [
      lifecycle.observeBannerWillShow(cardId, (id) => {
        delegateRef.current.bannerWillShow?.(id);
      }),
      lifecycle.observeBannerDidShow(cardId, (id) => {
        delegateRef.current.bannerDidShow?.(id);
      }),
      lifecycle.observeBannerWillHide(cardId, (id) => {
        delegateRef.current.bannerWillHide?.(id);
      }),
      lifecycle.observeBannerDidHide(cardId, (id) => {
        delegateRef.current.bannerDidHide?.(id);
      }),
    ];
    return () => {
      for (const u of unsubs) u();
    };
  }, [cardId, lifecycle]);
}
