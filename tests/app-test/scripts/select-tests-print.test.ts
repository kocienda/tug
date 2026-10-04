/**
 * select-tests-print.test.ts — `--print` writes the selection to stdout.
 *
 * These run the real `select-tests.ts` as a subprocess against the real corpus, so what is
 * under test is the actual script resolving actual `@covers` declarations.
 *
 * Counts are asserted as properties (non-empty, under or over the cap) rather than as
 * literals: the corpus shrinks as tests are retired, and a literal would break on every
 * retirement without telling anyone anything about `--print`.
 *
 * This is a pure-logic test (no app launch); it lives beside the script it covers and is
 * invisible to `testFiles()`, which only scans the corpus root and `harness-smoke/`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const APP_TEST_DIR = resolve(dirname(import.meta.dir));
const SCRIPT = join(APP_TEST_DIR, "scripts", "select-tests.ts");

/** The cap the script cuts at, mirrored from `select-tests.ts`. */
const MAX_SELECTED = 20;

/**
 * The script reads the results ledger, so it is pointed at a scratch one: a unit test
 * must never open — let alone upgrade — the machine-global ledger.
 */
const LEDGER_DIR = mkdtempSync(join(tmpdir(), "select-tests-print-"));
afterAll(() => rmSync(LEDGER_DIR, { recursive: true, force: true }));

/** A source path covered by a handful of tests — comfortably under the cap. */
const UNDER_BUDGET = "tugcode/src/types.ts";
/** A source path with a recorded fan-out well above the cap. */
const OVER_BUDGET = "tugdeck/src/components/tugways/focus-manager.ts";

function run(args: string[]): { code: number; out: string; err: string } {
    const proc = Bun.spawnSync(["bun", SCRIPT, ...args], {
        cwd: APP_TEST_DIR,
        env: { ...process.env, TUG_APPTEST_RESULTS_DB: join(LEDGER_DIR, "apptest_results.db") },
    });
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
        const r = run(["--print", "docs/no-such-plan.md"]);
        expect(r.code).toBe(0);
        expect(lines(r.out)).toEqual([]);
    });
});

describe("without --print the cap governs", () => {
    test("an over-cap selection exits 0 and writes exactly the cap, the rest below the line", () => {
        const r = run([OVER_BUDGET]);
        expect(r.code).toBe(0);
        expect(lines(r.out).length).toBe(MAX_SELECTED);
        expect(r.err).toContain("below the line");
        expect(r.err).not.toContain("REFUSED");
    });

    test("bare stdout is the head of --print stdout", () => {
        const bare = lines(run([OVER_BUDGET]).out);
        const printed = lines(run(["--print", OVER_BUDGET]).out);
        expect(printed.length).toBeGreaterThan(bare.length);
        expect(printed.slice(0, bare.length)).toEqual(bare);
    });

    test("an under-budget selection writes the same lines --print does", () => {
        const bare = lines(run([UNDER_BUDGET]).out);
        const printed = lines(run(["--print", UNDER_BUDGET]).out);
        expect(bare.length).toBeGreaterThan(0);
        expect(printed).toEqual(bare);
    });
});
