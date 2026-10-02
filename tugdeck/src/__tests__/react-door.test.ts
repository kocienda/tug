/**
 * React's subscriptions and `flushSync` come from `lib/gesture-scope.ts`.
 *
 * The gesture scope holds every store's React notify until after the next
 * painted frame, and it can only do that for the stores it sees. It sees a
 * store because the store's component took `useSyncExternalStore` from the
 * door rather than from React — so one import from `"react"` is a store the
 * hold silently misses, and one `flushSync` from `"react-dom"` is a flush
 * that commits without draining the held set. This is what keeps the next
 * one from being written. The door itself is the one module that imports
 * them from React.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..");

const DOOR = "lib/gesture-scope.ts";

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (
      (name.endsWith(".ts") || name.endsWith(".tsx")) &&
      !name.endsWith(".test.ts")
    ) {
      found.push(path);
    }
  }
  return found;
}

/** Every import clause from `module`, spanning lines. Anchored at a line start, so prose saying "import" is not one. */
function importClauses(source: string, module: string): string[] {
  const pattern = new RegExp(`^import\\s+([^;]*?)\\s+from\\s*["']${module}["']`, "gms");
  return [...source.matchAll(pattern)].map((m) => m[1]);
}

/** Why `source` goes around the door, or an empty list. */
export function reactDoorBreaches(source: string): string[] {
  const breaches: string[] = [];
  if (importClauses(source, "react").some((c) => /\buseSyncExternalStore\b/.test(c))) {
    breaches.push('imports useSyncExternalStore from "react"');
  }
  if (importClauses(source, "react-dom").some((c) => /\bflushSync\b/.test(c))) {
    breaches.push('imports flushSync from "react-dom"');
  }
  if (/\bReact\.useSyncExternalStore\b/.test(source)) breaches.push("calls React.useSyncExternalStore");
  if (/\bReact\.flushSync\b/.test(source)) breaches.push("calls React.flushSync");
  if (/\bReactDOM\.flushSync\b/.test(source)) breaches.push("calls ReactDOM.flushSync");
  return breaches;
}

describe("the react door", () => {
  test("no source but the door takes useSyncExternalStore or flushSync from React", () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => path.slice(SRC.length + 1) !== DOOR)
      .flatMap((path) =>
        reactDoorBreaches(readFileSync(path, "utf8")).map(
          (why) => `${path.slice(SRC.length + 1)}: ${why}`,
        ),
      );

    expect(offenders).toEqual([]);
  });

  test("the match spans a multi-line import clause", () => {
    const source = 'import {\n  useEffect,\n  useSyncExternalStore,\n} from "react";\n';
    expect(reactDoorBreaches(source)).toEqual(['imports useSyncExternalStore from "react"']);
  });

  test("prose that says import is not read as an import clause", () => {
    const source = '/**\n * we import nothing and read useSyncExternalStore\n */\nimport React, { useMemo } from "react";\n';
    expect(reactDoorBreaches(source)).toEqual([]);
  });

  test("the door's own import is not read as a breach", () => {
    expect(reactDoorBreaches('import { useSyncExternalStore } from "@/lib/gesture-scope";\n')).toEqual([]);
  });

  test("the sweep actually found source to read", () => {
    // A regex guard over an empty file list would pass forever.
    expect(sourceFiles(SRC).length).toBeGreaterThan(100);
  });
});
