/**
 * subscribable.ts — the one subscribe-and-notify every store shares.
 *
 * A store hands React a `subscribe` and a `getSnapshot` through
 * `useSyncExternalStore` ([L02]). The snapshot is the store's own contract —
 * what it caches, when it rebuilds, what counts as a change — and it stays
 * with the store. What every store used to write out by hand is the other
 * half: a listener set, a `subscribe` that returns the unsubscribe, and a
 * loop that calls them. That half is this module, and it owns nothing else:
 * no snapshot, no caching, no equality. A base that owned snapshots would be
 * a framework.
 *
 * A class store extends {@link Subscribable}; a module-level set is a
 * {@link createSubscribable}. `subscribe` is an arrow property, so it can be
 * handed to `useSyncExternalStore` unbound. `notify` is a prototype method,
 * so a store that drops a cache before telling its listeners overrides it
 * and calls `super.notify()`.
 *
 * `notify` walks a copy of the set. A listener subscribed during a notify
 * hears the next one, not this one, and a listener unsubscribed by another
 * listener mid-notify is still called this once — which a
 * `useSyncExternalStore` listener tolerates by design, since all it does is
 * re-read the snapshot.
 */

/** A set of change listeners with the subscribe/notify contract React reads. */
export class Subscribable {
  private readonly listeners = new Set<() => void>();

  /**
   * Add `listener`; the returned function removes it. Removing twice is a
   * no-op, so a cleanup that runs more than once is harmless.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Call every listener subscribed when the notify began. */
  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * {@link notify}, with each listener's throw handed to `onError` rather
   * than stopping the rest — for a store whose listeners must all hear a
   * change even when one of them fails. `onError` also gets the listener that
   * threw and its position in this notify, so a store can say which one.
   */
  notifyCatching(
    onError: (error: unknown, listener: () => void, index: number) => void,
  ): void {
    const listeners = [...this.listeners];
    for (let i = 0; i < listeners.length; i++) {
      try {
        listeners[i]();
      } catch (error) {
        onError(error, listeners[i], i);
      }
    }
  }

  /** How many listeners are subscribed — for stores that start work on the first. */
  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Drop every listener — a store's teardown. */
  clearListeners(): void {
    this.listeners.clear();
  }
}

/** A standalone {@link Subscribable}, for a module-level listener set. */
export function createSubscribable(): Subscribable {
  return new Subscribable();
}
