/**
 * Grep-contract test — a suite may not `mock.module` a module that has its
 * own suite.
 *
 * `mock.module` is **process-wide** in bun, and `bun test` runs every suite in
 * one process. So a suite that replaces `@/lib/X` hands its stub to every other
 * suite that imports `@/lib/X` afterwards — including `X`'s own suite, whose
 * whole job is to exercise the real module. That is not hypothetical: it is how
 * five red tests reached `main`. `text-card-store.autosave.test.ts` mocked
 * `@/lib/file-watch-client`, and `file-watch-client.test.ts` then tested the
 * stub — green alone, red in the suite, and no checkpoint ran both in one
 * process.
 *
 * The rule this test enforces is the structural half of that fix: for every
 * `mock.module("<spec>")` resolving to a module under `tugdeck/src/`, no suite
 * anywhere under `src/` is named after that module — `<name>.test.ts` or
 * `<name>.test.tsx`, wherever it sits. A module with a suite named after it has
 * an owner, and the owner is entitled to the real thing.
 *
 * The victim is looked up by **basename across the whole tree**, not beside the
 * module, because a suite does not have to sit next to its subject: the module
 * `src/lib/connection-lifecycle.ts` is owned by `src/__tests__/connection-lifecycle.test.ts`,
 * two directories away, and a sibling-only lookup would have called that pair safe.
 *
 * It is deliberately narrow. Mocking a module that has *no* suite of its own is
 * still process-wide and still reaches every other importer, so the rule is a
 * floor rather than a licence — when the module offers an explicit seam
 * (`setConnection`, `registerConnectionLifecycle`, `setTugbankClient`,
 * `_setConnectionSourceForTest`), reach for the seam whether or not a suite
 * exists to be starved. What the grep can judge without interpretation is the
 * case with a named victim, and that is what it judges.
 *
 * The second contract covers the other half of the same hazard, on the one module
 * where it was live. `connection-singleton` has no suite of its own, so the first
 * rule has nothing to say about it — but eleven suites mock it, and five of them
 * stubbed `setConnection` to a no-op. A stubbed-away export stays stubbed for
 * every later importer in the process, so a suite that drove the singleton
 * through the real setter had its call silently swallowed depending on file
 * order. Two of those suites said so in their own headers and mocked defensively
 * because of it. So: a `mock.module` factory for `connection-singleton` must hand
 * back the real `setConnection`, and then nobody has to defect.
 *
 * ## The way out of a failure
 *
 * Three, in order of preference:
 *
 *   1. Use the module's own test seam, and reset it in `afterAll`.
 *   2. Add one, if the module has no seam and wants one.
 *   3. Only if neither is possible, add the file to `JUSTIFIED` below with a
 *      sentence saying why the leak cannot bite. An entry with no argument is
 *      the contract being waived rather than met.
 */

import { describe, it, expect } from "bun:test";
import { Glob } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const SRC_ROOT = resolve(import.meta.dir, "..");

/**
 * Suites permitted to `mock.module` a module that owns a suite, each with the
 * argument for why the process-wide stub cannot starve that suite.
 *
 * Empty, and meant to stay that way: every mock in the tree at the time this
 * contract landed moved to a real seam instead.
 */
const JUSTIFIED: ReadonlyMap<string, string> = new Map<string, string>();

/** Every `*.test.ts`/`*.test.tsx` under `tugdeck/src/`. */
function testFiles(): string[] {
  const glob = new Glob("**/*.test.{ts,tsx}");
  return [...glob.scanSync(SRC_ROOT)].map((p) => join(SRC_ROOT, p)).sort();
}

/**
 * Index every suite under `src/` by the module basename it is named after, so a
 * mocked specifier can be answered without caring where the suite lives.
 */
function suitesByModuleName(): ReadonlyMap<string, string[]> {
  const index = new Map<string, string[]>();
  for (const suite of testFiles()) {
    const name = basename(suite).replace(/\.test\.(ts|tsx)$/, "");
    const bucket = index.get(name);
    if (bucket === undefined) index.set(name, [suite]);
    else bucket.push(suite);
  }
  return index;
}

/**
 * Resolve a `mock.module` specifier to an absolute module path under
 * `SRC_ROOT`, or null when it names something outside the source tree (a
 * node_modules package, say) that this contract has no opinion about.
 *
 * `@/X` is tugdeck's alias for `src/X`; a relative specifier resolves against
 * the mocking file's own directory. Either may or may not carry an extension.
 */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  let abs: string;
  if (spec.startsWith("@/")) abs = join(SRC_ROOT, spec.slice(2));
  else if (spec.startsWith(".")) abs = resolve(dirname(fromFile), spec);
  else return null;
  const rel = relative(SRC_ROOT, abs);
  if (rel.startsWith("..")) return null;
  return abs.replace(/\.(ts|tsx)$/, "");
}

interface Violation {
  suite: string;
  line: number;
  spec: string;
  victim: string;
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  const suites = suitesByModuleName();
  // `mock.module("spec"` / `mock.module('spec'` — the call's first argument is
  // always a literal, since bun resolves it at call time against the same
  // module graph the imports use.
  const CALL = /mock\.module\(\s*["']([^"']+)["']/g;
  for (const suite of testFiles()) {
    const suiteRel = relative(SRC_ROOT, suite);
    if (suiteRel === "__tests__/mock-module-greps.test.ts") continue;
    const lines = readFileSync(suite, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      CALL.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CALL.exec(lines[i])) !== null) {
        const modulePath = resolveSpecifier(m[1], suite);
        if (modulePath === null) continue;
        const owners = suites.get(basename(modulePath));
        if (owners === undefined) continue;
        if (JUSTIFIED.has(suiteRel)) continue;
        for (const victim of owners) {
          violations.push({
            suite: suiteRel,
            line: i + 1,
            spec: m[1],
            victim: relative(SRC_ROOT, victim),
          });
        }
      }
    }
  }
  return violations;
}

describe("mock.module grep contract", () => {
  it("no suite mocks a module that has its own suite", () => {
    const violations = findViolations();
    if (violations.length > 0) {
      const detail = violations
        .map(
          (v) =>
            `  ${v.suite}:${v.line}  mock.module("${v.spec}")\n` +
            `      starves ${v.victim} — bun's module mocks are process-wide.`,
        )
        .join("\n");
      throw new Error(
        `A suite mocks a module that owns its own suite:\n${detail}\n\n` +
          `Use the module's test seam instead, or add the suite to JUSTIFIED in\n` +
          `src/__tests__/mock-module-greps.test.ts with the argument for why the\n` +
          `process-wide stub cannot reach the victim.`,
      );
    }
    expect(violations.length).toBe(0);
  });

  it("finds the mock.module calls it is scanning for", () => {
    // A regex that silently stops matching turns this contract into a test that
    // passes by seeing nothing. Pin that it still reads the tree: the suites
    // moved off module mocks kept their seam comments, and plenty of legitimate
    // `mock.module` calls on unsuited modules remain.
    const CALL = /mock\.module\(\s*["']([^"']+)["']/;
    let calls = 0;
    for (const suite of testFiles()) {
      if (relative(SRC_ROOT, suite) === "__tests__/mock-module-greps.test.ts") continue;
      for (const line of readFileSync(suite, "utf8").split("\n")) {
        if (CALL.test(line)) calls++;
      }
    }
    expect(calls).toBeGreaterThan(0);
  });

  it("every JUSTIFIED entry names a suite that exists and still mocks", () => {
    // An entry left behind after its suite moved off module mocks is a waiver
    // with nothing under it, and the next real violation in that file inherits
    // the pass.
    const stale: string[] = [];
    for (const suiteRel of JUSTIFIED.keys()) {
      const abs = join(SRC_ROOT, suiteRel);
      if (!existsSync(abs)) {
        stale.push(`${suiteRel} — no such file`);
        continue;
      }
      if (!/mock\.module\(/.test(readFileSync(abs, "utf8"))) {
        stale.push(`${suiteRel} — no longer calls mock.module`);
      }
    }
    expect(stale).toEqual([]);
  });
});

describe("connection-singleton mock contract", () => {
  it("every mock of connection-singleton hands back the real setConnection", () => {
    // `connection-singleton` has no suite of its own, so the victim rule above
    // cannot see it. What bites instead is the setter: `setConnection` is how a
    // suite stands the real singleton up, and a factory that replaces it with a
    // no-op disarms that seam for every file loaded afterwards.
    const offenders: string[] = [];
    for (const suite of testFiles()) {
      const suiteRel = relative(SRC_ROOT, suite);
      if (suiteRel === "__tests__/mock-module-greps.test.ts") continue;
      const source = readFileSync(suite, "utf8");
      if (!/mock\.module\(\s*["'][^"']*connection-singleton["']/.test(source)) continue;
      // The factory must either name the frozen real setter or spread the real
      // namespace. A literal `setConnection: () => {}` is the shape being
      // forbidden, and an omitted `setConnection` is worse — it leaves the
      // export `undefined` rather than inert.
      const handsBackReal =
        /setConnection:\s*realSetConnection\b/.test(source) ||
        /\.\.\.\s*\w*[Cc]onnectionSingleton\b/.test(source);
      if (!handsBackReal) offenders.push(suiteRel);
    }
    if (offenders.length > 0) {
      throw new Error(
        `These suites mock connection-singleton without handing back the real\n` +
          `setConnection, so any later suite's real setConnection call is swallowed:\n` +
          offenders.map((o) => `  ${o}`).join("\n") +
          `\n\nFreeze the real setter before the mock and pass it through:\n` +
          `  import { setConnection as _realSetConnection } from "@/lib/connection-singleton";\n` +
          `  const realSetConnection = _realSetConnection;\n`,
      );
    }
    expect(offenders).toEqual([]);
  });

  it("finds the connection-singleton mocks it is scanning for", () => {
    // Same guard as the victim scan: a scan that matches nothing must not read
    // as a pass. Eleven suites mocked the singleton when this contract landed,
    // and the floor is deliberately not eleven: moving a suite OFF the mock and
    // onto a real seam is the outcome this contract wants, and a count pinned
    // at its high-water mark would turn that improvement red.
    let mockers = 0;
    for (const suite of testFiles()) {
      if (relative(SRC_ROOT, suite) === "__tests__/mock-module-greps.test.ts") continue;
      const source = readFileSync(suite, "utf8");
      if (/mock\.module\(\s*["'][^"']*connection-singleton["']/.test(source)) mockers++;
    }
    expect(mockers).toBeGreaterThan(0);
  });
});
