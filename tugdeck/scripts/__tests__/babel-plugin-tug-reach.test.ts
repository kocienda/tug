/**
 * babel-plugin-tug-reach.test.ts — the reach prologue, its emitted shape, and its one
 * naming rule.
 *
 * The transform cases run the real plugin through `@babel/core`'s `transformSync` over a
 * fixture module placed under a fake repo root. The cycle case goes further and evaluates
 * the output: two instrumented modules that import each other, one calling the other's
 * hoisted function before that module's body has run — the shape a `const` prologue would
 * break. The cross-check holds the plugin's names for the real `focus-manager.ts` against
 * the selector's resolver, because the two must agree for a recorded map to answer a diff.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { transformSync } from "@babel/core";
import { reachNames, tugReachPlugin } from "../babel-plugin-tug-reach";
import { symbolIndex } from "../../../tests/app-test/scripts/changed-symbols";

const TUGDECK = path.resolve(import.meta.dir, "..", "..");
const REPO = path.resolve(TUGDECK, "..");
const FAKE_ROOT = "/repo";

function transform(code: string, filename: string, repoRoot = FAKE_ROOT): string {
    const out = transformSync(code, {
        filename,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["typescript"] },
        plugins: [tugReachPlugin({ repoRoot })],
    });
    return out?.code ?? "";
}

const FIXTURE = `"use strict";
export function alpha(n: number): number {
    "use strict";
    return n + 1;
}
export function over(a: string): void;
export function over(a: number): void;
export function over(a: unknown): void { void a; }
export class Widget extends Base {
    constructor() {
        super();
    }
    handler = () => 7;
}
export const beta = (s: string) => s.length;
`;

describe("the emitted prologue", () => {
    const filename = `${FAKE_ROOT}/tugdeck/src/components/x/fixture.ts`;
    const out = transform(FIXTURE, filename);

    test("imports the registry by a module-relative path and registers names in order", () => {
        expect(out).toContain(`import { __tugReachRegister } from "../../lib/reach-registry.ts";`);
        expect(out).toContain(
            `var __trm = __tugReachRegister("tugdeck/src/components/x/fixture.ts", ` +
                `["alpha", "over", "Widget.constructor", "Widget.handler", "beta"]);`,
        );
    });

    test("one guarded store per named function-like, and none for an overload", () => {
        for (let i = 0; i < 5; i++) expect(out).toContain(`__trm !== undefined && (__trm[${i}] = 1);`);
        expect(out).not.toContain("__trm[5]");
    });

    test("a directive stays first, and an expression-bodied arrow becomes a block", () => {
        expect(out).toMatch(/function alpha\(n: number\): number \{\n\s*"use strict";\n\s*__trm !== undefined && \(__trm\[0\] = 1\);/);
        expect(out).toMatch(/beta = \(s: string\) => \{\n\s*__trm !== undefined && \(__trm\[4\] = 1\);\n\s*return s\.length;/);
        expect(out).toMatch(/handler = \(\) => \{\n\s*__trm !== undefined && \(__trm\[3\] = 1\);\n\s*return 7;/);
    });

    test("the store precedes super() in a derived constructor", () => {
        expect(out).toMatch(/constructor\(\) \{\n\s*__trm !== undefined && \(__trm\[2\] = 1\);\n\s*super\(\);/);
    });

    test("a file outside tugdeck/src, and the registry itself, are untouched", () => {
        const outside = transform(FIXTURE, `${FAKE_ROOT}/tugdeck/scripts/fixture.ts`);
        expect(outside).not.toContain("__tugReachRegister");
        const registry = transform(FIXTURE, `${FAKE_ROOT}/tugdeck/src/lib/reach-registry.ts`);
        expect(registry).not.toContain("__tugReachRegister");
    });
});

describe("an import cycle", () => {
    const root = mkdtempSync(path.join(tmpdir(), "tug-reach-cycle-"));
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    test("a hoisted function called before its module body runs does not throw", async () => {
        const src = path.join(root, "tugdeck", "src");
        mkdirSync(path.join(src, "lib"), { recursive: true });
        copyFileSync(path.join(TUGDECK, "src", "lib", "reach-registry.ts"), path.join(src, "lib", "reach-registry.ts"));
        // a imports b; b's body calls a's hoisted function while a's body has not run.
        const a = `import { fromB } from "./b.js";\nexport function early() { return 1; }\nexport function late() { return fromB; }\n`;
        const b = `import { early } from "./a.js";\nexport const fromB = early();\n`;
        writeFileSync(path.join(src, "a.js"), transform(a, path.join(src, "a.js"), root));
        writeFileSync(path.join(src, "b.js"), transform(b, path.join(src, "b.js"), root));
        expect(readFileSync(path.join(src, "a.js"), "utf8")).toContain("var __trm");

        const mod = await import(path.join(src, "a.js"));
        expect(mod.late()).toBe(1);
        const { dump } = await import(path.join(src, "lib", "reach-registry.ts"));
        // `early` ran before a's prologue: unrecorded, not fatal. `late` ran after it.
        expect(dump()["tugdeck/src/a.js"]).toEqual({ n: 2, hit: ["late"] });
    });
});

describe("one naming rule", () => {
    test("the plugin and the selector's resolver name the same functions in focus-manager.ts", () => {
        const rel = "tugdeck/src/components/tugways/focus-manager.ts";
        const text = readFileSync(path.join(REPO, rel), "utf8");
        const plugin = new Set(reachNames(text, rel));
        const resolver = new Set(symbolIndex(rel, text).spans.map((s) => s.name));
        expect(plugin.size).toBeGreaterThan(100);
        expect([...plugin].filter((n) => !resolver.has(n))).toEqual([]);
        expect([...resolver].filter((n) => !plugin.has(n))).toEqual([]);
    });
});
