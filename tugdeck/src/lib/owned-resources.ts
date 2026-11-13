/**
 * owned-resources.ts — resources that live exactly as long as their owner.
 *
 * A store that builds and tears down an object (a card's services bag) may
 * be asked by a layer it cannot import to carry something of that layer's
 * for the same lifetime: the composer's `@` mention provider, which holds
 * listeners on the connection, is the case that wants it. This is that
 * carrying and nothing else. The owner's store calls {@link
 * OwnedResources.release} where it tears the owner down; the asker calls
 * {@link OwnedResources.get} wherever it reads the owner ([L27]).
 *
 * @module lib/owned-resources
 */

interface Held {
  value: unknown;
  release: () => void;
}

export interface OwnedResources<Owner extends object> {
  /**
   * The resource under `key` for `owner`: made by `make` on the first ask,
   * the same value on every ask after. Asked of an owner already released,
   * it is made and released at once, so a late reader holds nothing open.
   */
  get<T>(owner: Owner, key: symbol, make: () => { value: T; release: () => void }): T;
  /** Release everything held for `owner`; later asks release at once. */
  release(owner: Owner): void;
}

export function createOwnedResources<Owner extends object>(): OwnedResources<Owner> {
  const held = new WeakMap<Owner, Map<symbol, Held>>();
  const released = new WeakSet<Owner>();
  return {
    get<T>(owner: Owner, key: symbol, make: () => { value: T; release: () => void }): T {
      const found = held.get(owner)?.get(key);
      if (found !== undefined) return found.value as T;
      const made = make();
      if (released.has(owner)) {
        made.release();
        return made.value;
      }
      let byKey = held.get(owner);
      if (byKey === undefined) {
        byKey = new Map();
        held.set(owner, byKey);
      }
      byKey.set(key, made);
      return made.value;
    },
    release(owner: Owner): void {
      released.add(owner);
      const byKey = held.get(owner);
      if (byKey === undefined) return;
      held.delete(owner);
      for (const resource of byKey.values()) resource.release();
    },
  };
}
