/**
 * A body page attaches every connection-scoped store the shell attaches.
 *
 * A card's content reads its stores the same way in the shell's document and
 * in a body's, so a store the shell's boot attaches and a body's does not is
 * a surface that works in the one and waits forever in the other — the
 * Changes shade on a project scan, Z2's ARC cell on an arc it never heard of.
 * The bar's arc-tracking row asks that the stores be enumerated, and this is
 * the enumeration: every `attach…Store(connection)` call in `main.tsx` has its
 * twin in `body-main.ts`. A store a body must not have is named in
 * `SHELL_ONLY` with the reason, which is the one way to make this pass
 * without attaching it.
 *
 * @covers tugdeck/src/body/body-main.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..");

/** Stores the shell attaches that a body deliberately does not, with why. */
const SHELL_ONLY: Record<string, string> = {};

/** The `attach…Store(connection)` calls in a source file, by name. */
function attachedStores(path: string): Set<string> {
  const source = readFileSync(path, "utf8");
  return new Set([...source.matchAll(/\b(attach\w*Store)\(\s*connection\s*\)/g)].map((m) => m[1]));
}

describe("the stores a body attaches", () => {
  const shell = attachedStores(join(SRC, "main.tsx"));
  const body = attachedStores(join(SRC, "body", "body-main.ts"));

  test("the shell's boot attaches stores to read", () => {
    expect(shell.size).toBeGreaterThan(0);
  });

  test("every store the shell attaches, the body attaches too", () => {
    const missing = [...shell].filter((name) => !body.has(name) && !(name in SHELL_ONLY));
    expect(missing).toEqual([]);
  });
});
