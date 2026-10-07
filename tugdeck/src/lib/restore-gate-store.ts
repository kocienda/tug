/**
 * restore-gate-store — is any session card cold-restoring right now?
 *
 * Every card in the deck shares one main thread in one `WKWebView`. A
 * cold restore's reveal — mounting, laying out, and measuring a whole
 * reconstructed transcript — is a single uninterruptible task on that
 * thread, measured in seconds on a real session. While it runs, nothing
 * in the app answers: not the card restoring, not its neighbours, not
 * the composer you are typing into. The chrome keeps painting its last
 * frame, so the app *looks* live throughout.
 *
 * This store is the reading behind `TugRestoreGate`, the app-modal that
 * says the app is busy for exactly as long as it is.
 *
 * Tuglaws: [L02] — external state with `subscribe`/`getSnapshot`, read
 * through `useSyncExternalStore`; the snapshot is reference-stable
 * across unchanged reads. [L10] — one responsibility (derive the gate);
 * it renders nothing and knows nothing about modality.
 *
 * @module lib/restore-gate-store
 */

import { useSyncExternalStore } from "react";

import { cardServicesStore } from "./card-services-store";
import type { CodeSessionStore } from "./code-session-store";
import { deriveColdRestoreActive } from "@/components/tugways/cards/session-card-restore-gate";

/** What the gate knows, and what its surface renders. */
export interface RestoreGateSnapshot {
  /** Raise the app-modal. */
  open: boolean;
  /** Cards cold-restoring right now — the modal's subject count. */
  cards: number;
  /** Turns committed so far across those cards. */
  turnsLoaded: number;
  /** Turns their restore windows asked for, summed. */
  turnsTarget: number;
}

const CLOSED: RestoreGateSnapshot = {
  open: false,
  cards: 0,
  turnsLoaded: 0,
  turnsTarget: 0,
};

type Listener = () => void;

class RestoreGateStore {
  private _listeners = new Set<Listener>();
  private _snapshot: RestoreGateSnapshot = CLOSED;
  private _initialized = false;
  /** Per-store unsubscribes for the session stores observed right now. */
  private _storeUnsubs = new Map<CodeSessionStore, () => void>();

  subscribe = (listener: Listener): (() => void) => {
    this._ensureInitialized();
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  getSnapshot = (): RestoreGateSnapshot => {
    this._ensureInitialized();
    return this._snapshot;
  };

  /**
   * Observe the services store and, through it, every live card's
   * session store. Lazy so importing this module costs nothing until
   * something reads the gate.
   */
  private _ensureInitialized(): void {
    if (this._initialized) return;
    this._initialized = true;
    cardServicesStore.subscribe(() => this._resync());
    this._resync();
  }

  /**
   * Re-aim the per-store subscriptions at the current live set, then
   * recompute. Subscribing to the services store alone is not enough —
   * that fires when the live SET changes, not when a member's phase
   * does. A store dropped from the set is unsubscribed: a closed card
   * must not keep this store alive through its listener list.
   */
  private _resync(): void {
    const live = new Set<CodeSessionStore>();
    cardServicesStore.forEachCodeSessionStore((store) => {
      live.add(store);
      if (!this._storeUnsubs.has(store)) {
        this._storeUnsubs.set(store, store.subscribe(() => this._recompute()));
      }
    });
    for (const [store, unsub] of this._storeUnsubs) {
      if (live.has(store)) continue;
      unsub();
      this._storeUnsubs.delete(store);
    }
    this._recompute();
  }

  /**
   * Fold the live set into a snapshot. The predicate is the same
   * `deriveColdRestoreActive` the per-card placeholder reads, so the
   * app-modal and the card gate can never disagree about what
   * "restoring" means.
   */
  private _recompute(): void {
    let cards = 0;
    let turnsLoaded = 0;
    let turnsTarget = 0;
    cardServicesStore.forEachCodeSessionStore((store) => {
      const s = store.getSnapshot();
      if (!deriveColdRestoreActive(s)) return;
      cards += 1;
      turnsLoaded += s.transcript.length;
      turnsTarget += s.restoreWindowTurns;
    });
    this._publish(
      cards === 0 ? CLOSED : { open: true, cards, turnsLoaded, turnsTarget },
    );
  }

  /**
   * Publish when something changed. Reference-stable output is the
   * `useSyncExternalStore` contract — an unchanged read must return the
   * identical object or React re-renders forever.
   */
  private _publish(next: RestoreGateSnapshot): void {
    const prev = this._snapshot;
    if (
      prev.open === next.open &&
      prev.cards === next.cards &&
      prev.turnsLoaded === next.turnsLoaded &&
      prev.turnsTarget === next.turnsTarget
    ) {
      return;
    }
    this._snapshot = next;
    for (const listener of this._listeners) listener();
  }
}

export const restoreGateStore = new RestoreGateStore();

/** Read the gate in React ([L02]). */
export function useRestoreGate(): RestoreGateSnapshot {
  return useSyncExternalStore(
    restoreGateStore.subscribe,
    restoreGateStore.getSnapshot,
  );
}
