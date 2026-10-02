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
 *
 * The second shape is a store that never reaches the door at all: a
 * subscription whose callback calls a `useState` setter tells React from
 * inside the store's notify, in whatever task the store changed — a click's,
 * as often as not. The lint below reads those by their shape: a call to a
 * `subscribe…` / `observe…` / `on…` / `listen…` function whose callback calls
 * a setter the same file took from `useState`. A setter wrapped in
 * `afterGesture` is the door's answer for an event that is not a snapshot,
 * and is not one.
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

/** The index just past the `)` closing the call whose `(` ends at `open`. */
function closeParen(source: string, open: number): number {
  let depth = 1;
  let i = open;
  while (i < source.length && depth > 0) {
    const c = source[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    i += 1;
  }
  return i;
}

/** `body` with every `afterGesture(…)` call cut out. */
function withoutAfterGesture(body: string): string {
  const calls = [...body.matchAll(/\bafterGesture\(/g)].reverse();
  let out = body;
  for (const call of calls) {
    const start = call.index ?? 0;
    out = out.slice(0, start) + out.slice(closeParen(out, start + call[0].length));
  }
  return out;
}

const SETTER = /\[\s*\w+\s*,\s*(set[A-Z]\w*)\s*\]\s*=\s*(?:React\.)?useState\b/g;
const STORE_CALL = /(?<![\w])(?:[\w?]+\.)?(subscribe\w*|observe\w*|on[A-Z]\w*|addListener|listen\w*)\s*\(/g;
/** The call's arguments open with a function literal, perhaps after one leading argument. */
const CALLBACK_ARG = /^\s*(?:[\w.]+\s*,\s*)?(?:async\s*)?(?:\w+|\([^()]*\))\s*(?::\s*[\w<>|\s]+)?=>/;

/** Store subscriptions in `source` whose callback calls a `useState` setter. */
export function storeTellBreaches(source: string): string[] {
  const setters = new Set([...source.matchAll(SETTER)].map((m) => m[1]));
  if (setters.size === 0) return [];
  const breaches: string[] = [];
  for (const call of source.matchAll(STORE_CALL)) {
    const open = (call.index ?? 0) + call[0].length;
    if (!CALLBACK_ARG.test(source.slice(open, open + 120))) continue;
    const body = withoutAfterGesture(source.slice(open, closeParen(source, open)));
    for (const setter of setters) {
      if (new RegExp(`\\b${setter}\\(`).test(body)) {
        breaches.push(`${call[1]}'s callback calls ${setter} from useState`);
      }
    }
  }
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

describe("store tells reach the door", () => {
  test("no subscription's callback calls a useState setter", () => {
    const offenders = sourceFiles(SRC).flatMap((path) =>
      storeTellBreaches(readFileSync(path, "utf8")).map(
        (why) => `${path.slice(SRC.length + 1)}: ${why}`,
      ),
    );

    expect(offenders).toEqual([]);
  });

  test("a version bumped from a subscription is read as a breach", () => {
    const source = [
      "const [engineHooksVersion, setEngineHooksVersion] = useState(0);",
      "useLayoutEffect(() => {",
      "  return store.subscribeEngineHooksChange(cardId, () => {",
      "    setEngineHooksVersion((v) => v + 1);",
      "  });",
      "}, [cardId, store]);",
    ].join("\n");
    expect(storeTellBreaches(source)).toEqual([
      "subscribeEngineHooksChange's callback calls setEngineHooksVersion from useState",
    ]);
  });

  test("a connection callback that sets state is read as a breach", () => {
    const source = [
      "const [disconnectState, setDisconnectState] = useState<DisconnectState | null>(null);",
      "const unsubscribe = connection.onDisconnectState((state) => {",
      "  setDisconnectState(state);",
      "});",
    ].join("\n");
    expect(storeTellBreaches(source)).toEqual([
      "onDisconnectState's callback calls setDisconnectState from useState",
    ]);
  });

  test("a setter wrapped in afterGesture is not one", () => {
    const source = [
      "const [error, setError] = useState<string | null>(null);",
      "subscribeAppendFailures((notice) => {",
      "  afterGesture(() => setError(notice.text));",
      "});",
    ].join("\n");
    expect(storeTellBreaches(source)).toEqual([]);
  });

  test("a JSX handler and a non-callback call are not read as subscriptions", () => {
    const source = [
      "const [open, setOpen] = useState(false);",
      "return <button onClick={() => setOpen(true)} />;",
      "onOpenChange?.(next); setOpen(next);",
    ].join("\n");
    expect(storeTellBreaches(source)).toEqual([]);
  });
});
