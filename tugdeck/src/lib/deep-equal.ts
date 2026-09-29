/**
 * deep-equal — structural equality over plain data.
 *
 * For the values a store-derived selector hands React: arrays, plain objects,
 * `Map`s and `Set`s of primitives and of each other. A derived value that is
 * rebuilt on every commit is a new reference on every commit, and a
 * `useSyncExternalStore` snapshot that changes reference re-renders whatever
 * reads it; comparing the rebuilt value to the last one and keeping the old
 * reference when nothing inside it moved is what lets a subscriber render only
 * when the fact it draws has changed ([L02]).
 *
 * Plain data only, on purpose: an object with a prototype other than
 * `Object.prototype` — a class instance, a DOM node — is compared by
 * reference, because its identity may be the fact.
 *
 * @module lib/deep-equal
 */

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) {
      return false;
    }
    for (const [key, value] of a) {
      if (!b.has(key) || !deepEqual(value, b.get(key))) return false;
    }
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) {
      return false;
    }
    for (const value of a) {
      if (!b.has(value)) return false;
    }
    return true;
  }
  const protoA = Object.getPrototypeOf(a);
  const protoB = Object.getPrototypeOf(b);
  if (protoA !== protoB) return false;
  if (protoA !== Object.prototype && protoA !== null) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  const recordB = b as Record<string, unknown>;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(recordB, key)) return false;
    if (!deepEqual((a as Record<string, unknown>)[key], recordB[key])) {
      return false;
    }
  }
  return true;
}
