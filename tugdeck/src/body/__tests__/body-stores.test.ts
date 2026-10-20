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
 * A store's first page comes back as a CONTROL answer, so attaching it is
 * half of it: the page that asked has to answer `list_overview_posts_ok` and
 * the other tail acknowledgements too, or it holds the live frames and never
 * the page before them.
 *
 * A card that draws its own chrome reads the pane's facts as `pane.chrome`,
 * and its page tells the host its first chrome frame is on screen only once
 * those facts have arrived: before them the frame draws a stand-in title and
 * nothing to press, which the host must not show.
 *
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/body/body-root.tsx
 * @covers tugdeck/src/body/body-chrome-frame.tsx
 * @covers tugdeck/src/action-dispatch.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { registerStoreTailActions } from "../../action-dispatch";
import { _resetActionRegistryForTest, getRegistryHandler } from "../../action-registry";

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

describe("the answers a body's stores wait on", () => {
  const TAILS = [
    "list_sessions_ok",
    "list_sessions_err",
    "list_sessions_progress",
    "list_session_state_changes_ok",
    "list_session_state_changes_err",
    "list_digest_lines_ok",
    "list_overview_posts_ok",
  ];

  test("one call registers every tail acknowledgement", () => {
    _resetActionRegistryForTest();
    registerStoreTailActions();
    expect(TAILS.filter((name) => getRegistryHandler(name) === undefined)).toEqual([]);
    _resetActionRegistryForTest();
  });

  test("the body's boot and the shell's both make it", () => {
    expect(readFileSync(join(SRC, "body", "body-main.ts"), "utf8")).toMatch(/\bregisterStoreTailActions\(\)/);
    expect(readFileSync(join(SRC, "action-dispatch.ts"), "utf8")).toMatch(/^ {2}registerStoreTailActions\(\);$/m);
  });
});

describe("the chrome a body draws", () => {
  const root = readFileSync(join(SRC, "body", "body-root.tsx"), "utf8");
  const frame = readFileSync(join(SRC, "body", "body-chrome-frame.tsx"), "utf8");

  test("a card reads pane.chrome through the store's own subscription", () => {
    expect(root).toMatch(/useSyncExternalStore\(\s*paneChrome\.subscribe,\s*paneChrome\.getSnapshot,?\s*\)/);
  });

  test("a body reads pane.chrome before its first chrome render is published", () => {
    // The post to the host waits on the shell's facts, never on the fallback.
    const gate = "if (!hasChrome || chromePaintPosted) return;";
    const post = "postToHost(paintedToHost, {})";
    expect(frame).toContain("const hasChrome = chrome !== null;");
    expect(frame).toContain(gate);
    expect(frame).toContain(post);
    expect(frame.indexOf(gate)).toBeLessThan(frame.indexOf(post));
  });
});
