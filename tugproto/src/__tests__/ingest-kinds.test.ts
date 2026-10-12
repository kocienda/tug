/**
 * `INGEST_PATCH_KINDS` and `INGEST_CONTROL_KINDS` against the unions they list.
 *
 * The compile-time checks in `ingest.ts` already reject a disagreement, but
 * only where something type-checks that file. This test reads the unions'
 * declarations as text — each member interface's `kind` literal, following a
 * member that is itself a union alias, and ignoring a member's type
 * arguments — so `bun test` here fails on the same drift with both sets in
 * its message. The shape is `outbound-tags.test.ts`'s; the member pattern is
 * not, because these members carry `kind:` and hyphenated literals.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INGEST_CONTROL_KINDS, INGEST_PATCH_KINDS } from "../ingest";

const SOURCE = readFileSync(join(import.meta.dir, "..", "ingest.ts"), "utf8");

/** The member names of `export type <name><…> = | A | B<…> …;`, or null if not an alias union. */
function unionMembers(name: string): string[] | null {
  const decl = SOURCE.match(new RegExp(`export type ${name}(?:<[^>]*>)? =([\\s\\S]*?);\\n`));
  if (decl === null) return null;
  return [...decl[1].matchAll(/\|\s*([A-Z][A-Za-z0-9]*)/g)].map((m) => m[1]);
}

/** The `kind` literal(s) a declaration carries, following union aliases. */
function kindsOf(name: string): string[] {
  const members = unionMembers(name);
  if (members !== null) return members.flatMap(kindsOf);
  const body = SOURCE.match(new RegExp(`export interface ${name}(?:<[^{]*>)? \\{([\\s\\S]*?)\\n\\}`));
  if (body === null) throw new Error(`no declaration for ${name}`);
  const kind = body[1].match(/^ {2}kind: "([a-z][a-z-]*)";$/m);
  if (kind === null) throw new Error(`${name} declares no \`kind\` literal`);
  return [kind[1]];
}

/** The literals of `export const <name> = [ … ]`, one per line. */
function listed(name: string): string[] {
  const decl = SOURCE.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\n\\]`));
  if (decl === null) throw new Error(`no list ${name}`);
  return [...decl[1].matchAll(/^ {2}"([a-z][a-z-]*)",$/gm)].map((m) => m[1]);
}

for (const [union, list, value] of [
  ["IngestPatch", "INGEST_PATCH_KINDS", INGEST_PATCH_KINDS],
  ["IngestControl", "INGEST_CONTROL_KINDS", INGEST_CONTROL_KINDS],
] as const) {
  describe(`${list}`, () => {
    test(`is exactly the ${union} union's kind set`, () => {
      const members = unionMembers(union);
      expect(members).not.toBeNull();
      const declared = [...new Set(members!.flatMap(kindsOf))].sort();
      expect([...value].sort()).toEqual(declared);
    });

    test("names each kind once, one literal per line", () => {
      expect(new Set(value).size).toBe(value.length);
      expect(listed(list)).toEqual([...value]);
    });
  });
}
