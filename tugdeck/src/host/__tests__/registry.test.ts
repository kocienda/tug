/**
 * The host registry is the whole host vocabulary: nothing is declared
 * outside `src/host/declarations/`, everything declared there is listed in
 * `host/registry.ts`, names are unique per direction, and every codec admits
 * its samples and refuses its refused samples — page→host messages,
 * host→page members, the calls the host awaits and their replies alike.
 *
 * @covers tugdeck/src/host/declare.ts
 * @covers tugdeck/src/host/registry.ts
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { INVALID, type Codec } from "../../bus/codec";
import { jsonEqual } from "../../bus/equal";
import { PAGE_CALLS, TO_HOST, TO_PAGE } from "../registry";

/** Every declaration, by the name it is keyed on, with what the conformance checks read. */
interface Conformance {
  name: string;
  codec: Codec<unknown>;
  samples: readonly unknown[];
  refused: readonly unknown[];
}

const ALL: readonly Conformance[] = [
  ...TO_HOST.map((d) => ({ name: d.name, codec: d.codec, samples: d.samples, refused: d.refused })),
  ...TO_PAGE.map((d) => ({ name: d.member, codec: d.codec, samples: d.samples, refused: d.refused })),
  ...PAGE_CALLS.flatMap((d) => [
    { name: `${d.receiver}.${d.member}`, codec: d.codec, samples: d.samples, refused: d.refused },
    { name: `${d.receiver}.${d.member} reply`, codec: d.replyCodec, samples: d.replies, refused: d.refusedReplies },
  ]),
];

const SRC = join(import.meta.dir, "..", "..");
const DECLARATIONS = join(SRC, "host", "declarations");
const CALL = /(?<!function )\bdefine(ToHost|ToPage|PageCall)\s*(<(?:[^<>]|<[^<>]*>)*>)?\s*\(/g;
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

describe("the host registry", () => {
  test("no host declaration lives outside src/host/declarations/", () => {
    const strays = sourceFiles(SRC)
      .filter((path) => !path.startsWith(DECLARATIONS) && !path.includes(join("host", "__tests__")))
      .filter((path) => HAS_CALL.test(codeOf(path)))
      .map((path) => relative(SRC, path));
    expect(strays).toEqual([]);
  });

  test("everything declared in src/host/declarations/ is registered", async () => {
    const files = readdirSync(DECLARATIONS).filter((n) => n.endsWith(".ts"));
    let calls = 0;
    const exported = new Set<unknown>();
    const KINDS = new Set(["toHost", "toPage", "pageCall"]);
    for (const name of files) {
      calls += [...codeOf(join(DECLARATIONS, name)).matchAll(CALL)].length;
      const mod = (await import(join(DECLARATIONS, name))) as Record<string, unknown>;
      for (const value of Object.values(mod)) {
        const kind = (value as { kind?: unknown } | null)?.kind;
        if (typeof kind === "string" && KINDS.has(kind)) exported.add(value);
      }
    }
    const registered = [...TO_HOST, ...TO_PAGE, ...PAGE_CALLS];
    expect(registered.length).toBe(calls);
    expect(new Set<unknown>(registered)).toEqual(exported);
  });

  test("names are unique in each direction", () => {
    const hostNames = TO_HOST.map((d) => d.name);
    expect(new Set(hostNames).size).toBe(hostNames.length);
    const members = [...TO_PAGE.map((d) => d.member), ...PAGE_CALLS.filter((d) => d.receiver === "bridge").map((d) => d.member)];
    expect(new Set(members).size).toBe(members.length);
  });

  test("every bridge member's name starts with on", () => {
    const members = [...TO_PAGE.map((d) => d.member), ...PAGE_CALLS.filter((d) => d.receiver === "bridge").map((d) => d.member)];
    expect(members.filter((m) => !/^on[A-Z]/.test(m))).toEqual([]);
  });

  test("every declaration carries a sample", () => {
    expect(ALL.filter((d) => d.samples.length === 0).map((d) => d.name)).toEqual([]);
  });

  test("every codec admits each of its samples, to an equal value", () => {
    const failing: string[] = [];
    for (const d of ALL) {
      d.samples.forEach((sample, i) => {
        const decoded = d.codec.decode(sample);
        if (decoded === INVALID || !jsonEqual(decoded, sample)) failing.push(`${d.name}[${i}]`);
      });
      const own = d.codec.decode(d.codec.sample);
      if (own === INVALID) failing.push(`${d.name} codec sample`);
    }
    expect(failing).toEqual([]);
  });

  test("every codec refuses each of its refused samples", () => {
    const admitted: string[] = [];
    for (const d of ALL) {
      d.refused.forEach((value, i) => {
        if (d.codec.decode(value) !== INVALID) admitted.push(`${d.name} refused[${i}]`);
      });
    }
    expect(admitted).toEqual([]);
  });

  test("every declaration names what it refuses", () => {
    expect(ALL.filter((d) => d.refused.length === 0).map((d) => d.name)).toEqual([]);
  });
});
