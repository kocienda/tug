/**
 * select-tests-ceiling.test.ts — the corpus may not grow past `MAX_CORPUS`.
 *
 * Runs the real `select-tests.ts --check` against a copy of the real corpus, padded with
 * enough annotated files to cross the ceiling. The padding files carry real `@covers`
 * lines pointing at real paths, so what fails is the ceiling and not the dangling-path
 * rule sitting next to it.
 *
 * This is a pure-logic test (no app launch); it lives beside the script it covers and is
 * invisible to `testFiles()`, which only scans the corpus root and `harness-smoke/`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REAL_APP_TEST_DIR = resolve(dirname(import.meta.dir));
const SCRIPT_REL = "tests/app-test/scripts/select-tests.ts";
const SOURCE_ROOTS = ["tugdeck", "tugrust", "tugapp", "tugcode"];

/** A real path, so the padding files' `@covers` lines resolve on disk. */
const REAL_COVERED_PATH = "tugdeck/src/lib/lens-store/";

let root: string;
let corpus: string;
let script: string;
let ceiling: number;

function check(): { code: number; err: string } {
    const p = Bun.spawnSync(["bun", script, "--check"], { cwd: corpus });
    return { code: p.exitCode, err: new TextDecoder().decode(p.stderr) };
}

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "select-tests-ceiling-"));
    mkdirSync(join(root, "tests"), { recursive: true });
    cpSync(REAL_APP_TEST_DIR, join(root, "tests", "app-test"), { recursive: true });
    const realRepo = resolve(REAL_APP_TEST_DIR, "..", "..");
    for (const r of SOURCE_ROOTS) symlinkSync(join(realRepo, r), join(root, r));
    corpus = join(root, "tests", "app-test");
    script = join(root, SCRIPT_REL);

    const src = readFileSync(script, "utf8");
    const m = src.match(/const MAX_CORPUS = (\d+);/);
    if (m === null) throw new Error("MAX_CORPUS not found in select-tests.ts");
    ceiling = Number(m[1]);
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("the corpus ceiling", () => {
    test("the real corpus passes, and the pass line names the ceiling", () => {
        const r = check();
        expect(r.code).toBe(0);
        expect(r.err).toContain(`/${ceiling} test files`);
    });

    test("padding past the ceiling fails, naming the count and the ceiling", () => {
        // How many files short of the ceiling the real corpus is, read off the pass line
        // rather than recounted, so the padding is sized by the same number --check uses.
        const current = Number(check().err.match(/\[select-tests\] (\d+)\//)?.[1]);
        expect(current).toBeGreaterThan(0);
        const needed = ceiling - current + 1;

        const pad: string[] = [];
        try {
            for (let i = 0; i < needed; i++) {
                const name = `at9${String(i).padStart(3, "0")}-ceiling-pad.test.ts`;
                const p = join(corpus, name);
                writeFileSync(
                    p,
                    `/**\n * ${name} — padding.\n *\n * @covers ${REAL_COVERED_PATH}\n */\n`,
                );
                pad.push(p);
            }
            const r = check();
            expect(r.code).toBe(1);
            expect(r.err).toContain(`past the ${ceiling}-file`);
            expect(r.err).toContain("A new test displaces an old one");
        } finally {
            for (const p of pad) rmSync(p, { force: true });
        }
    });

    test("removing the padding restores a passing check", () => {
        expect(check().code).toBe(0);
    });
});
