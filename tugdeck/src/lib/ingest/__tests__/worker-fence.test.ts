/**
 * Nothing main-only runs in the ingest Worker.
 *
 * A main-thread singleton loaded into the Worker does not fail: it quietly
 * becomes a second, unread copy — a dev-log store nobody reads, a gesture
 * scope no motion closes — which is worse than a crash. So this walks the
 * static import graph the Worker would load, from its entry, and fails on any
 * module in the deny-list. Only value imports count: `import type` and
 * `export type` are erased and load nothing.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../../..");
const TUGPROTO = resolve(SRC, "../../tugproto/src");

/**
 * The roots the Worker graph is walked from: the Worker entry, and the session
 * engine, so the engine is Worker-safe from the step that creates it.
 */
const ROOTS = ["lib/workers/ingest-worker.ts", "lib/code-session-store/session-engine.ts"];

/** Modules that must never load in the Worker, as specifiers or `@/` prefixes. */
const DENY: readonly string[] = [
  "react",
  "react-dom",
  "@/lib/gesture-scope",
  "@/lib/annotator/path-resolution",
  "@/lib/network-path-store",
  "@/lib/digest-store",
  "@/lib/session-citation-store",
  "@/lib/property-store",
  "@/lib/connection-singleton",
  "@/connection",
  "@/lib/session-state-changes-local-events",
  "@/lib/run-progress-store",
  "@/lib/tug-dev-log-store/",
  "@/lib/session-lifecycle-log",
  "@/lib/tugbank-singleton",
  "@/deck-trace",
  "@/theme-tokens",
  "@/lib/markdown/",
];

/** A resolved module: a file under `src/` or tugproto, or a bare package name. */
type Resolved = { kind: "file"; path: string } | { kind: "package"; name: string };

function resolveFile(base: string): string | null {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && !candidate.endsWith("/")) {
      try {
        readFileSync(candidate);
        return candidate;
      } catch {
        // A directory; try the next candidate.
      }
    }
  }
  return null;
}

function resolveSpecifier(from: string, spec: string): Resolved | null {
  if (spec.startsWith("@/")) return wrap(resolveFile(join(SRC, spec.slice(2))));
  if (spec.startsWith("@tugproto/")) return wrap(resolveFile(join(TUGPROTO, spec.slice("@tugproto/".length))));
  if (spec.startsWith(".")) return wrap(resolveFile(resolve(dirname(from), spec)));
  return { kind: "package", name: spec };
}

function wrap(path: string | null): Resolved | null {
  return path === null ? null : { kind: "file", path };
}

/** The `@/…` spelling of a file under `src/`, for matching the deny-list. */
function aliasOf(path: string): string {
  const rel = relative(SRC, path).replace(/\.(tsx?|js)$/, "").replace(/\/index$/, "");
  return rel.startsWith("..") ? path : `@/${rel}`;
}

function denied(r: Resolved): string | null {
  const name = r.kind === "package" ? r.name : aliasOf(r.path);
  for (const d of DENY) {
    if (d.endsWith("/") ? name.startsWith(d) : name === d || name.startsWith(`${d}/`)) return d;
  }
  return null;
}

/** Value-import specifiers in a module's source. */
function valueImports(source: string): string[] {
  const specs: string[] = [];
  const re = /^(?:import|export)\s+(type\s+)?[\s\S]*?\bfrom\s+["']([^"']+)["'];?|^import\s+["']([^"']+)["'];?/gm;
  for (const m of source.matchAll(re)) {
    if (m[3] !== undefined) {
      specs.push(m[3]);
      continue;
    }
    if (m[1] !== undefined) continue;
    specs.push(m[2]!);
  }
  return specs;
}

/** Walk the graph from `root`; return each denied module with the chain that reached it. */
function walk(root: string): { module: string; via: string[] }[] {
  const start = resolveFile(join(SRC, root));
  if (start === null) throw new Error(`no root ${root}`);
  const seen = new Set<string>([start]);
  const queue: { path: string; via: string[] }[] = [{ path: start, via: [aliasOf(start)] }];
  const hits: { module: string; via: string[] }[] = [];
  while (queue.length > 0) {
    const { path, via } = queue.shift()!;
    for (const spec of valueImports(readFileSync(path, "utf8"))) {
      const r = resolveSpecifier(path, spec);
      if (r === null) throw new Error(`${aliasOf(path)}: cannot resolve '${spec}'`);
      const deny = denied(r);
      if (deny !== null) {
        hits.push({ module: spec, via });
        continue;
      }
      if (r.kind === "file" && !seen.has(r.path)) {
        seen.add(r.path);
        queue.push({ path: r.path, via: [...via, aliasOf(r.path)] });
      }
    }
  }
  return hits;
}

describe("the ingest Worker's import fence", () => {
  for (const root of ROOTS) {
    test(`${root} loads nothing main-only`, () => {
      expect(walk(root)).toEqual([]);
    });
  }

  test("the walk sees value imports and ignores type imports", () => {
    expect(
      valueImports(
        [
          'import type { A } from "@/connection";',
          'import { b, type C } from "@/lib/frame-period";',
          'export type { D } from "@/deck-trace";',
          'export { e } from "./pacer";',
          'import "@/side-effect";',
        ].join("\n"),
      ),
    ).toEqual(["@/lib/frame-period", "./pacer", "@/side-effect"]);
  });

  test("a denied module anywhere in the graph is caught", () => {
    expect(denied({ kind: "package", name: "react" })).toBe("react");
    expect(denied({ kind: "file", path: join(SRC, "lib/tug-dev-log-store/tug-dev-log-store.ts") })).toBe(
      "@/lib/tug-dev-log-store/",
    );
    expect(denied({ kind: "file", path: join(SRC, "connection.ts") })).toBe("@/connection");
    expect(denied({ kind: "file", path: join(SRC, "lib/connection-lifecycle.ts") })).toBeNull();
  });
});
