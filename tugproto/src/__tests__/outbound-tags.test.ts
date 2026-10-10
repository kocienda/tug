/**
 * `OUTBOUND_TAGS` against the `OutboundMessage` union it lists.
 *
 * The compile-time check in `outbound.ts` already rejects a disagreement, but
 * only where something type-checks this file. This test reads the union's
 * declarations as text — each member interface's `type` literal, following a
 * member that is itself a union alias — so `bun test` here fails on the same
 * drift with both sets in its message.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OUTBOUND_TAGS } from "../outbound";

const SOURCE = readFileSync(join(import.meta.dir, "..", "outbound.ts"), "utf8");

/** The member names of `export type <name> = | A | B …;`, or null if not an alias union. */
function unionMembers(name: string): string[] | null {
  const decl = SOURCE.match(new RegExp(`export type ${name} =([\\s\\S]*?);\\n`));
  if (decl === null) return null;
  return [...decl[1].matchAll(/\|\s*([A-Z][A-Za-z0-9]*)/g)].map((m) => m[1]);
}

/** The `type` literal(s) a declaration carries, following union aliases. */
function tagsOf(name: string): string[] {
  const members = unionMembers(name);
  if (members !== null) return members.flatMap(tagsOf);
  const body = SOURCE.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (body === null) throw new Error(`no declaration for ${name}`);
  const tag = body[1].match(/^ {2}type: "([a-z_]+)";$/m);
  if (tag === null) throw new Error(`${name} declares no \`type\` literal`);
  return [tag[1]];
}

describe("outbound tags", () => {
  test("OUTBOUND_TAGS is exactly the OutboundMessage union's tag set", () => {
    const members = unionMembers("OutboundMessage");
    expect(members).not.toBeNull();
    const declared = [...new Set(members!.flatMap(tagsOf))].sort();
    expect([...OUTBOUND_TAGS].sort()).toEqual(declared);
  });

  test("OUTBOUND_TAGS names each tag once", () => {
    expect(new Set(OUTBOUND_TAGS).size).toBe(OUTBOUND_TAGS.length);
  });
});
