/**
 * Nothing main-only runs in the ingest Worker.
 *
 * A main-thread singleton loaded into the Worker does not fail: it quietly
 * becomes a second, unread copy — a dev-log store nobody reads, a gesture
 * scope no motion closes — which is worse than a crash. So this walks the
 * import graph the Worker would load, from its entry, and fails on any module
 * not on the allow-list: a module joins the Worker by being named here, never
 * by being imported. The walk reads one statement at a time, so a clause
 * never spans into the next statement, and it sees a dynamic `import()` as
 * well as a static one. Only value imports count: `import type` and
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

/**
 * The modules the Worker may load, as `@/` aliases, plus `@tugproto/`, the
 * protocol package, whose every module is Worker-safe. Each is pure logic or
 * logs through `dev-log-port`; nothing here owns a main-thread singleton.
 * Adding one is a decision about what runs off the page.
 */
const ALLOW: readonly string[] = [
  "@/lib/workers/ingest-worker",
  "@/lib/ingest/frame-peeler",
  "@/lib/ingest/ingest-host",
  "@/lib/ingest/pacer",
  "@/lib/ingest/rendered-merge",
  "@/lib/ingest/session-patch",
  "@/lib/ingest/text-hash",
  "@/lib/ingest/wire-socket",
  "@/lib/code-session-store/compaction",
  "@/lib/code-session-store/denials",
  "@/lib/code-session-store/end-state",
  "@/lib/code-session-store/lifecycle-state",
  "@/lib/code-session-store/reducer",
  "@/lib/code-session-store/render-tracker",
  "@/lib/code-session-store/select-goal",
  "@/lib/code-session-store/select-jobs",
  "@/lib/code-session-store/select-scheduled-work",
  "@/lib/code-session-store/session-engine",
  "@/lib/code-session-store/stages",
  "@/lib/code-session-store/telemetry",
  "@/lib/code-session-store/types",
  "@/lib/annotator/command-grammar",
  "@/lib/annotator/detect-commit-sha",
  "@/lib/annotator/detect-path-reference",
  "@/lib/annotator/written-paths",
  "@/lib/api-retry",
  "@/lib/arc-note-command",
  "@/lib/atom-bytes-store",
  "@/lib/atom-mention-marker",
  "@/lib/command-atom",
  "@/lib/commit-format",
  "@/lib/compaction-request",
  "@/lib/dev-log-port",
  "@/lib/frame-period",
  "@/lib/image-downsample",
  "@/lib/landings-block",
  "@/lib/session-atom-shape",
  "@/lib/session-ref-block",
  "@/lib/subscribable",
  "@/lib/synthesize-user-message",
  "@/lib/tug-atom-char",
  "@/protocol",
  "@tugproto/",
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

/** The `@/…` spelling of a file under `src/`, or `@tugproto/…` for the protocol package. */
function aliasOf(path: string): string {
  const proto = relative(TUGPROTO, path);
  if (!proto.startsWith("..")) return `@tugproto/${proto.replace(/\.(tsx?|js)$/, "")}`;
  const rel = relative(SRC, path).replace(/\.(tsx?|js)$/, "").replace(/\/index$/, "");
  return rel.startsWith("..") ? path : `@/${rel}`;
}

/** Whether the Worker may load `r`: its alias is on the allow-list, or under an allowed root. */
function allowed(r: Resolved): boolean {
  const name = r.kind === "package" ? r.name : aliasOf(r.path);
  return ALLOW.some((a) => (a.endsWith("/") ? name.startsWith(a) : name === a));
}

/**
 * Value-import specifiers in a module's source: static imports and
 * re-exports, one statement at a time (a clause never crosses a `;`), bare
 * side-effect imports, and dynamic `import()` with a literal specifier.
 */
function valueImports(source: string): string[] {
  const specs: string[] = [];
  const re =
    /^\s*(?:import|export)\s+(type\s+)?[^;]*?\bfrom\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gm;
  for (const m of source.matchAll(re)) {
    if (m[4] !== undefined) {
      specs.push(m[4]);
      continue;
    }
    if (m[3] !== undefined) {
      specs.push(m[3]);
      continue;
    }
    if (m[1] !== undefined) continue;
    specs.push(m[2]!);
  }
  return specs;
}

/** Walk the graph from `root`; return each module off the allow-list with the chain that reached it. */
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
      if (!allowed(r)) {
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
          "export function f() {",
          '  return "from";',
          "}",
          'const g = await import("@/lib/gesture-scope");',
          'export const h = () => import ( "./lazy" );',
        ].join("\n"),
      ),
    ).toEqual(["@/lib/frame-period", "./pacer", "@/side-effect", "@/lib/gesture-scope", "./lazy"]);
  });

  test("anything off the allow-list is caught, a neighbour of an allowed module included", () => {
    expect(allowed({ kind: "package", name: "react" })).toBe(false);
    expect(allowed({ kind: "file", path: join(SRC, "lib/tug-dev-log-store/tug-dev-log-store.ts") })).toBe(false);
    expect(allowed({ kind: "file", path: join(SRC, "connection.ts") })).toBe(false);
    expect(allowed({ kind: "file", path: join(SRC, "lib/annotator/path-resolution.ts") })).toBe(false);
    expect(allowed({ kind: "file", path: join(SRC, "lib/code-session-store/use-session-phase.ts") })).toBe(false);
    expect(allowed({ kind: "file", path: join(SRC, "lib/ingest/ingest-host.ts") })).toBe(true);
    expect(allowed({ kind: "file", path: join(TUGPROTO, "ingest.ts") })).toBe(true);
  });
});
