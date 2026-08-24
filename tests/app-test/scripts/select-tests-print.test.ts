/**
 * select-tests-print.test.ts — `--print` writes the selection to stdout.
 *
 * These run the real `select-tests.ts` as a subprocess against the real corpus, so what is
 * under test is the actual script resolving actual `@covers` declarations.
 *
 * Counts are asserted as properties (non-empty, under or over the budget) rather than as
 * literals: the corpus shrinks as tests are retired, and a literal would break on every
 * retirement without telling anyone anything about `--print`.
 *
 * This is a pure-logic test (no app launch); it lives beside the script it covers and is
 * invisible to `testFiles()`, which only scans the corpus root and `harness-smoke/`.
 */

import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";

const APP_TEST_DIR = resolve(dirname(import.meta.dir));
const SCRIPT = join(APP_TEST_DIR, "scripts", "select-tests.ts");

/** The selection budget the script refuses above, mirrored from `select-tests.ts`. */
const MAX_SELECTED = 20;
/** The exit code the script refuses with. */
const EXIT_OVER_BUDGET = 3;

/** A source path covered by a handful of tests — comfortably under the budget. */
const UNDER_BUDGET = "tugcode/src/types.ts";
/** A source path with a recorded fan-out well above the budget. */
const OVER_BUDGET = "tugdeck/src/components/tugways/focus-manager.ts";

function run(args: string[]): { code: number; out: string; err: string } {
    const proc = Bun.spawnSync(["bun", SCRIPT, ...args], { cwd: APP_TEST_DIR });
    return {
        code: proc.exitCode,
        out: new TextDecoder().decode(proc.stdout),
        err: new TextDecoder().decode(proc.stderr),
    };
}

function lines(s: string): string[] {
    return s.split("\n").filter((l) => l.length > 0);
}

describe("--print writes the selection to stdout", () => {
    test("an under-budget selection reaches stdout, one file per line", () => {
        const r = run(["--print", UNDER_BUDGET]);
        expect(r.code).toBe(0);
        const out = lines(r.out);
        expect(out.length).toBeGreaterThan(0);
        expect(out.length).toBeLessThanOrEqual(MAX_SELECTED);
        for (const f of out) expect(f).toMatch(/\.test\.ts$/);
    });

    test("an over-budget selection still exits 0 and still prints", () => {
        const r = run(["--print", OVER_BUDGET]);
        expect(r.code).toBe(0);
        const out = lines(r.out);
        expect(out.length).toBeGreaterThan(MAX_SELECTED);
        for (const f of out) expect(f).toMatch(/\.test\.ts$/);
        expect(r.err).not.toContain("REFUSED");
    });

    test("a selection that matches nothing prints nothing and exits 0", () => {
        const r = run(["--print", "dash/no-such-plan.md"]);
        expect(r.code).toBe(0);
        expect(lines(r.out)).toEqual([]);
    });
});

describe("without --print the budget refusal still governs", () => {
    test("an over-budget selection exits 3 and writes nothing to stdout", () => {
        const r = run([OVER_BUDGET]);
        expect(r.code).toBe(EXIT_OVER_BUDGET);
        expect(lines(r.out)).toEqual([]);
        expect(r.err).toContain("REFUSED");
    });

    test("an under-budget selection writes the same lines --print does", () => {
        const bare = lines(run([UNDER_BUDGET]).out);
        const printed = lines(run(["--print", UNDER_BUDGET]).out);
        expect(bare.length).toBeGreaterThan(0);
        expect(printed).toEqual(bare);
    });
});
