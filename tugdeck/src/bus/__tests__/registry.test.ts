/**
 * The registry is the whole vocabulary: nothing is declared outside
 * `src/bus/declarations/`, everything declared there is listed in
 * `bus/registry.ts`, and every codec round-trips its sample.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { INVALID } from "../codec";
import { jsonEqual } from "../equal";
import { REQUESTS, ROUTED_ACTIONS, SHARED_STORES } from "../registry";

const SRC = join(import.meta.dir, "..", "..");
const DECLARATIONS = join(SRC, "bus", "declarations");
// A type argument may nest one generic inside another (`<Record<string, T>>`).
const CALL = /(?<!function )\bdefine(SharedStore|Action|Request)\s*(<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>)?\s*\(/g;
const HAS_CALL = new RegExp(CALL.source);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** The code lines of a file: no comment lines. */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

const registered = [...SHARED_STORES, ...ROUTED_ACTIONS, ...REQUESTS];

describe("the bus registry", () => {
  test("no declaration lives outside src/bus/declarations/", () => {
    const strays = sourceFiles(SRC)
      .filter((path) => !path.startsWith(DECLARATIONS) && !path.includes(`${join("bus", "__tests__")}`))
      .filter((path) => HAS_CALL.test(codeOf(path)))
      .map((path) => relative(SRC, path));
    expect(strays).toEqual([]);
  });

  test("everything declared in src/bus/declarations/ is registered", async () => {
    const files = readdirSync(DECLARATIONS).filter((n) => n.endsWith(".ts"));
    let calls = 0;
    const exported = new Set<unknown>();
    for (const name of files) {
      calls += [...codeOf(join(DECLARATIONS, name)).matchAll(CALL)].length;
      const mod = (await import(join(DECLARATIONS, name))) as Record<string, unknown>;
      for (const value of Object.values(mod)) {
        const kind = (value as { kind?: unknown } | null)?.kind;
        if (kind === "store" || kind === "action" || kind === "request") exported.add(value);
      }
    }
    expect(registered.length).toBe(calls);
    expect(new Set<unknown>(registered)).toEqual(exported);
  });

  test("keys are unique across stores, actions and requests", () => {
    const keys = registered.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("every codec decodes its own sample to an equal value", () => {
    const codecs = [
      ...SHARED_STORES.flatMap((s) => [
        [`${s.key} value`, s.declaration.codec],
        ...(s.declaration.proposals ? [[`${s.key} proposals`, s.declaration.proposals]] : []),
      ]),
      ...ROUTED_ACTIONS.map((a) => [`${a.key} payload`, a.declaration.codec]),
      ...REQUESTS.flatMap((r) => [
        [`${r.key} payload`, r.declaration.codec],
        [`${r.key} reply`, r.declaration.replyCodec],
      ]),
    ] as Array<[string, { decode(v: unknown): unknown; sample: unknown }]>;
    const failing = codecs
      .filter(([, c]) => {
        const decoded = c.decode(JSON.parse(JSON.stringify(c.sample)));
        return decoded === INVALID || !jsonEqual(decoded, c.sample);
      })
      .map(([name]) => name);
    expect(failing).toEqual([]);
  });

  test("every store's initial value is one its codec admits", () => {
    const failing = SHARED_STORES.filter((s) => s.declaration.codec.decode(s.declaration.initial) === INVALID).map((s) => s.key);
    expect(failing).toEqual([]);
  });
});
