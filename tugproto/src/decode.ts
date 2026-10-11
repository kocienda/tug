/**
 * tugproto/decode — structural decoding of JSON values off the wire.
 *
 * A {@link Decoder} checks an `unknown` against a shape and returns either the
 * value, typed, or a {@link DecodeError} naming where it went wrong: the frame
 * `tag`, the `path` into the value, what was `expected`, and what was `got`.
 * A frame whose fields have drifted is then a logged decode error at the
 * boundary rather than an exception inside whatever consumes it.
 *
 * Eight combinators cover the wire shapes: {@link str}, {@link num},
 * {@link bool}, {@link lit}, {@link opt}, {@link arr}, {@link obj} and
 * {@link union}. They check and never transform — {@link obj} returns the
 * object as received, undeclared fields included — so a value that decodes is
 * byte-for-byte the value that arrived. {@link decode} runs a decoder at the
 * root of a value and stamps the tag onto any failure.
 *
 * Dependency-free on purpose: the shapes are flat, and a small module the repo
 * owns beats a schema library that brings its own type system.
 *
 * Pure functions — no React, no DOM, no Node/Bun API.
 *
 * @module tugproto/decode
 */

/** Why a value did not decode. `tag` is empty until {@link decode} stamps it. */
export class DecodeError {
  constructor(
    /** The wire tag of the frame being decoded. */
    readonly tag: string,
    /** Where in the value the mismatch is, e.g. `$.task.status` or `$.items[2]`. */
    readonly path: string,
    /** What the decoder wanted there. */
    readonly expected: string,
    /** A short description of what was there instead. */
    readonly got: string,
  ) {}

  /** One line: `<tag> at <path>: expected <expected>, got <got>`. */
  toString(): string {
    return `${this.tag || "(untagged)"} at ${this.path}: expected ${this.expected}, got ${this.got}`;
  }
}

/** Checks `value` (found at `path`) and returns it typed, or a {@link DecodeError}. */
export type Decoder<T> = (value: unknown, path: string) => T | DecodeError;

/** A {@link Decoder} produced by {@link opt}; {@link obj} makes its key optional. */
export type OptionalDecoder<T> = Decoder<T | undefined> & { readonly optional: true };

/** The type a decoder yields. */
export type Decoded<D> = D extends Decoder<infer T> ? T : never;

/** True when `x` is a {@link DecodeError}. */
export function isDecodeError(x: unknown): x is DecodeError {
  return x instanceof DecodeError;
}

const GOT_MAX = 40;

/** A short, bounded description of a value for {@link DecodeError.got}. */
export function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return "object";
  if (typeof value === "string") {
    const shown = JSON.stringify(value.length > GOT_MAX ? `${value.slice(0, GOT_MAX)}…` : value);
    return `string ${shown}`;
  }
  return `${typeof value} ${String(value)}`;
}

function fail(path: string, expected: string, value: unknown): DecodeError {
  return new DecodeError("", path, expected, describe(value));
}

/**
 * How far a decoder got before failing: the count of array elements and object
 * fields that decoded ahead of the mismatch, summed down the path. Kept off
 * {@link DecodeError} so its fields stay the four a log line prints; only
 * {@link union} reads it, to report the alternative that matched longest.
 */
const progress = new WeakMap<DecodeError, number>();

function progressOf(e: DecodeError): number {
  return progress.get(e) ?? 0;
}

function advanced(e: DecodeError, by: number): DecodeError {
  progress.set(e, by + progressOf(e));
  return e;
}

/** A string. */
export const str: Decoder<string> = (value, path) =>
  typeof value === "string" ? value : fail(path, "string", value);

/** A finite number. */
export const num: Decoder<number> = (value, path) =>
  typeof value === "number" && Number.isFinite(value) ? value : fail(path, "number", value);

/** A boolean. */
export const bool: Decoder<boolean> = (value, path) =>
  typeof value === "boolean" ? value : fail(path, "boolean", value);

type Literal = string | number | boolean | null;

/** One of the given literal values, compared with `===`. `lit("a", "b")` is `"a" | "b"`. */
export function lit<const L extends readonly Literal[]>(...values: L): Decoder<L[number]> {
  const expected = values.map((v) => JSON.stringify(v)).join(" | ");
  return (value, path) =>
    values.some((v) => v === value) ? (value as L[number]) : fail(path, expected, value);
}

/** `inner`, or absent (`undefined`). Inside {@link obj} the key becomes optional. */
export function opt<T>(inner: Decoder<T>): OptionalDecoder<T> {
  const d: Decoder<T | undefined> = (value, path) =>
    value === undefined ? undefined : inner(value, path);
  return Object.assign(d, { optional: true as const });
}

/** An array whose every element decodes with `item`. */
export function arr<T>(item: Decoder<T>): Decoder<T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) return fail(path, "array", value);
    for (let i = 0; i < value.length; i++) {
      const r = item(value[i], `${path}[${i}]`);
      if (isDecodeError(r)) return advanced(r, i);
    }
    return value as T[];
  };
}

type Shape = Record<string, Decoder<unknown>>;
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends { readonly optional: true } ? K : never;
}[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
type Flatten<T> = { [K in keyof T]: T[K] } & {};

/** The object type {@link obj} yields for a shape. */
export type ObjOf<S extends Shape> = Flatten<
  { [K in RequiredKeys<S>]: Decoded<S[K]> } & { [K in OptionalKeys<S>]?: Decoded<S[K]> }
>;

/**
 * A non-null, non-array object whose declared fields each decode. Undeclared
 * fields are allowed and kept: the object is returned as received.
 */
export function obj<S extends Shape>(shape: S): Decoder<ObjOf<S>> {
  const keys = Object.keys(shape);
  return (value, path) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return fail(path, "object", value);
    }
    const record = value as Record<string, unknown>;
    for (let i = 0; i < keys.length; i++) {
      const r = shape[keys[i]](record[keys[i]], `${path}.${keys[i]}`);
      if (isDecodeError(r)) return advanced(r, i);
    }
    return value as ObjOf<S>;
  };
}

/**
 * The first alternative that decodes. When none does, the failure reported is
 * the one from the alternative that matched longest — for a tagged union of
 * objects, the member whose tag matched, at the field that actually disagreed —
 * and failures tied on the same path report their expectations joined with
 * ` | `.
 */
export function union<const Ds extends readonly Decoder<unknown>[]>(
  ...alternatives: Ds
): Decoder<Decoded<Ds[number]>> {
  return (value, path) => {
    const failures: DecodeError[] = [];
    for (const d of alternatives) {
      const r = d(value, path);
      if (!isDecodeError(r)) return r as Decoded<Ds[number]>;
      failures.push(r);
    }
    if (failures.length === 0) return fail(path, "never", value);
    const best = Math.max(...failures.map(progressOf));
    const furthest = failures.filter((f) => progressOf(f) === best);
    const tied = furthest.filter((f) => f.path === furthest[0].path);
    const expected = [...new Set(tied.map((f) => f.expected))].join(" | ");
    return advanced(new DecodeError("", tied[0].path, expected, tied[0].got), best);
  };
}

/** Run `decoder` on a whole frame, stamping `tag` onto a failure. Paths start at `$`. */
export function decode<T>(tag: string, decoder: Decoder<T>, value: unknown): T | DecodeError {
  const r = decoder(value, "$");
  return isDecodeError(r) ? new DecodeError(tag, r.path, r.expected, r.got) : r;
}
