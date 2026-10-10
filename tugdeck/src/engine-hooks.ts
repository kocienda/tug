/**
 * The per-card registries a card's components reach the deck through: the
 * engine hooks (the Phase E.11 single-channel dispatcher seam) and the
 * Component State Preservation Protocol registries ([D13], [A9]).
 *
 * Both are keyed by card id and hold closures a mounted component handed in,
 * so both share one lifetime rule: an entry never outlives the card, and a
 * re-registration from the same card wins. The `DeckManager` owns one of each
 * and answers the `IDeckManagerStore` methods by delegating here; the
 * `CardStateOrchestrator` reads the preservation registries at capture time
 * through {@link ComponentStateRegistries.peek}.
 */

import type { EngineHooks } from "./deck-manager-store";
import { ComponentStatePreservationRegistry } from "./components/tugways/component-state-preservation-registry";

/**
 * Per-card engine hooks (`paintMirrorAsActive` / `paintMirrorAsInactive`),
 * last-registration-wins per card id, and the listeners told when a card's
 * hooks change.
 */
export class EngineHookRegistry {
  /**
   * Per-card engine hooks. Phase E.11 Step 2 adds the channel (additive, no
   * consumer yet); Step 3 wires `applyBagFocus` to invoke through these hooks
   * for the `engine` resolution kind.
   */
  private hooks: Map<string, EngineHooks> = new Map();

  /**
   * Per-card engine-hook-change listeners. `CardHost` subscribes
   * here in a `useLayoutEffect` so its cold-boot RESTORE effect
   * re-fires when an engine registers late (dev's editor mounts
   * after `feedsReady`). Last-registration-wins per (cardId,
   * listener) — the listener identity is what we key on internally,
   * via a Set per cardId.
   */
  private listeners: Map<string, Set<() => void>> = new Map();

  register(cardId: string, hooks: EngineHooks): () => void {
    this.hooks.set(cardId, hooks);
    // Notify CardHost (and any other subscriber) that the engine
    // hooks for this card just changed — drives Phase E.11 Step 4's
    // `deferred-engine` retry. Listeners fire even on
    // last-write-wins re-registration so a TugTextEditor remount
    // (HMR, cross-pane move) lights up the dispatcher's re-fire
    // path.
    const listeners = this.listeners.get(cardId);
    if (listeners !== undefined) {
      for (const listener of listeners) {
        try {
          listener();
        } catch (err) {
          console.error("[deck-manager] engine-hooks listener threw:", err);
        }
      }
    }
    return () => {
      // Only clear when we still own the slot.
      if (this.hooks.get(cardId) === hooks) {
        this.hooks.delete(cardId);
        // Notify on unregister too so subscribers can clear
        // engine-derived state cleanly. A successor registration
        // (e.g. cross-pane move) fires a second notify when its
        // own `register` runs.
        const cleanupListeners = this.listeners.get(cardId);
        if (cleanupListeners !== undefined) {
          for (const listener of cleanupListeners) {
            try {
              listener();
            } catch (err) {
              console.error(
                "[deck-manager] engine-hooks listener threw on unregister:",
                err,
              );
            }
          }
        }
      }
    };
  }

  paintMirrorAsActive(cardId: string): void {
    const hooks = this.hooks.get(cardId);
    if (hooks === undefined) return;
    try {
      hooks.paintMirrorAsActive();
    } catch (err) {
      console.error(
        "[deck-manager] engine paintMirrorAsActive threw:",
        err,
      );
    }
  }

  paintMirrorAsInactive(cardId: string): void {
    const hooks = this.hooks.get(cardId);
    if (hooks === undefined) return;
    try {
      hooks.paintMirrorAsInactive();
    } catch (err) {
      console.error(
        "[deck-manager] engine paintMirrorAsInactive threw:",
        err,
      );
    }
  }

  has(cardId: string): boolean {
    return this.hooks.has(cardId);
  }

  /**
   * Subscribe to engine-hook registration events for `cardId`. The
   * listener fires after `register` (or its cleanup) runs, including
   * last-write-wins re-registrations from the same `cardId`. Returns an
   * unsubscribe function.
   *
   * Used by `CardHost` to re-fire its cold-boot RESTORE effect when
   * a late-mounting engine registers; bridges the dispatcher's
   * `deferred-engine` retry path to the engine's mount lifecycle.
   */
  subscribeChange(cardId: string, listener: () => void): () => void {
    let listeners = this.listeners.get(cardId);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(cardId, listeners);
    }
    listeners.add(listener);
    return () => {
      const set = this.listeners.get(cardId);
      if (set !== undefined) {
        set.delete(listener);
        if (set.size === 0) this.listeners.delete(cardId);
      }
    };
  }
}

/**
 * Per-card Component State Preservation Protocol registries ([D13], [A9]).
 * Lazily created on the first {@link ComponentStateRegistries.get} from a
 * child component's `useComponentStatePreservation` hook; discarded when the
 * card is destroyed. A card that uses no opt-in components never gets an
 * entry here.
 */
export class ComponentStateRegistries {
  private registries: Map<string, ComponentStatePreservationRegistry> = new Map();

  /**
   * The registry for `cardId`, created on first call. Repeated create /
   * destroy cycles of the same card id yield fresh registries, because
   * {@link discard} drops the old one.
   */
  get(cardId: string): ComponentStatePreservationRegistry {
    let registry = this.registries.get(cardId);
    if (!registry) {
      registry = new ComponentStatePreservationRegistry();
      this.registries.set(cardId, registry);
    }
    return registry;
  }

  /**
   * The registry for `cardId` without creating one, so a non-participating
   * card incurs no allocation at capture time.
   */
  peek(cardId: string): ComponentStatePreservationRegistry | undefined {
    return this.registries.get(cardId);
  }

  /** Clear and drop `cardId`'s registry so its closures don't outlive it. */
  discard(cardId: string): void {
    const registry = this.registries.get(cardId);
    if (!registry) return;
    registry.clear();
    this.registries.delete(cardId);
  }
}
