/**
 * Codecs: how a receiving page validates a payload it took off the bus.
 *
 * tugcast reads none of a payload, so the declaration that names a store,
 * action or request carries the codec that admits its payload. A payload the
 * codec refuses is logged and dropped at the receiver — refused where it can
 * be seen. Every codec carries a `sample`, which the registry's conformance
 * test round-trips.
 *
 * A refusal is {@link INVALID}, not `null`, because `null` is a value many
 * payloads legitimately carry (`card.surface`, `card.crossing`).
 *
 * @module bus/codec
 */

export const INVALID: unique symbol = Symbol("bus.invalid");
export type Invalid = typeof INVALID;

export interface Codec<T> {
  /** The value, or {@link INVALID} when `value` is not a `T`. */
  decode(value: unknown): T | Invalid;
  /** A value of the type, for the round-trip test. */
  sample: T;
}

type Shape = Record<string, Codec<unknown>>;
type Decoded<S extends Shape> = { [K in keyof S]: S[K] extends Codec<infer T> ? T : never };

function codec<T>(decode: (value: unknown) => T | Invalid, sample: T): Codec<T> {
  return { decode, sample };
}

export const str: Codec<string> = codec((v) => (typeof v === "string" ? v : INVALID), "");

export const num: Codec<number> = codec((v) => (typeof v === "number" && Number.isFinite(v) ? v : INVALID), 0);

export const bool: Codec<boolean> = codec((v) => (typeof v === "boolean" ? v : INVALID), false);

/** One of a fixed set of strings, numbers or booleans. */
export function literal<const L extends readonly [string | number | boolean, ...(string | number | boolean)[]]>(
  ...values: L
): Codec<L[number]> {
  return codec((v) => ((values as readonly unknown[]).includes(v) ? (v as L[number]) : INVALID), values[0]);
}

export function nullable<T>(inner: Codec<T>): Codec<T | null> {
  return codec((v) => (v === null ? null : inner.decode(v)), inner.sample);
}

/** A value that may be absent (`undefined`): for an `obj` field the payload may omit. */
export function optional<T>(inner: Codec<T>): Codec<T | undefined> {
  return codec((v) => (v === undefined ? undefined : inner.decode(v)), inner.sample);
}

export function arr<T>(inner: Codec<T>): Codec<T[]> {
  return codec((v) => {
    if (!Array.isArray(v)) return INVALID;
    const out: T[] = [];
    for (const item of v) {
      const d = inner.decode(item);
      if (d === INVALID) return INVALID;
      out.push(d);
    }
    return out;
  }, [inner.sample]);
}

/** A string-keyed record of one value type. */
export function rec<T>(inner: Codec<T>): Codec<Record<string, T>> {
  return codec((v) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return INVALID;
    const out: Record<string, T> = {};
    for (const [k, item] of Object.entries(v)) {
      const d = inner.decode(item);
      if (d === INVALID) return INVALID;
      out[k] = d;
    }
    return out;
  }, { key: inner.sample });
}

/** An object with exactly these fields' codecs; fields not named are dropped. */
export function obj<S extends Shape>(shape: S): Codec<Decoded<S>> {
  const sample = Object.fromEntries(Object.entries(shape).map(([k, c]) => [k, c.sample])) as Decoded<S>;
  return codec((v) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return INVALID;
    const source = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, c] of Object.entries(shape)) {
      const d = c.decode(source[k]);
      if (d === INVALID) return INVALID;
      if (d !== undefined) out[k] = d;
    }
    return out as Decoded<S>;
  }, sample);
}

/** What a codec admits, distributed over a union of codecs. */
type Admitted<C> = C extends Codec<infer T> ? T : never;

/**
 * The first of `variants` that admits the value: a payload that varies by
 * kind, each variant an `obj` whose tag field (a `literal`) says which.
 */
export function oneOf<V extends readonly [Codec<unknown>, ...Codec<unknown>[]]>(...variants: V): Codec<Admitted<V[number]>> {
  return codec((v) => {
    for (const variant of variants) {
      const d = variant.decode(v);
      if (d !== INVALID) return d as Admitted<V[number]>;
    }
    return INVALID;
  }, variants[0].sample as Admitted<V[number]>);
}

/** A type the deck already guards elsewhere: admitted by `guard`, carried as is. */
export function opaque<T>(guard: (value: unknown) => value is T, sample: T): Codec<T> {
  return codec((v) => (guard(v) ? v : INVALID), sample);
}

/** A payload with nothing in it: `{}`, or absent. */
export const empty: Codec<Record<string, never>> = codec(
  (v) => (v === undefined || (typeof v === "object" && v !== null && !Array.isArray(v)) ? {} : INVALID),
  {},
);
