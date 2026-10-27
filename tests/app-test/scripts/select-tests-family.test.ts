/**
 * select-tests-family.test.ts — the pieces of a split count once.
 *
 * Each case copies the corpus into a scratch directory, adds fixture test files that name
 * one source path, and runs the real `select-tests.ts` there: `--check` for the fan-out
 * lint and the family lint, and a bare selection for the cut. Twenty-one pieces of one
 * split are one family to both; the same twenty-one with no family are a sweep.
 *
 * This is a pure-logic test (no app launch); it lives beside the script it covers and is
 * invisible to `testFiles()`, which only scans the corpus root, `harness-smoke/` and `body-grounding/`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { copyAppTestTree } from "./copy-app-test-tree";

const REAL_APP_TEST_DIR = resolve(dirname(import.meta.dir));
const SOURCE_ROOTS = ["tugdeck", "tugrust", "tugapp", "tugcode", "tuglaws", "tugplug", "tugproto"];

/** The cap the script cuts at, mirrored from `select-tests.ts`. */
const MAX_SELECTED = 20;

/** A source path few tests name, so the fixtures decide whether it fans out. */
const PATH = "tugcode/src/types.ts";

let root: string;
let corpus: string;
let fixtures: string[] = [];

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "select-tests-family-"));
    mkdirSync(join(root, "tests"), { recursive: true });
    corpus = join(root, "tests", "app-test");
    copyAppTestTree(REAL_APP_TEST_DIR, corpus);
    const realRepo = resolve(REAL_APP_TEST_DIR, "..", "..");
    for (const r of SOURCE_ROOTS) symlinkSync(join(realRepo, r), join(root, r));
});

afterEach(() => {
    for (const f of fixtures) rmSync(join(corpus, f), { force: true });
    fixtures = [];
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Write one fixture test naming PATH, with `family` declared when given. */
function piece(name: string, family?: string): void {
    const tag = family === undefined ? "" : ` * @family ${family}\n`;
    writeFileSync(
        join(corpus, name),
        `/**\n * ${name} — fixture.\n *\n * @covers ${PATH}\n${tag} */\n\nimport { test } from "bun:test";\n\ntest("x", () => {});\n`,
    );
    fixtures.push(name);
}

/** Twenty-one pieces: one past the cap when each counts as a test of its own. */
function pieces(family?: string, stem = "zz9001-split"): string[] {
    const names = Array.from({ length: MAX_SELECTED + 1 }, (_, i) => `${stem}-p${String(i).padStart(2, "0")}.test.ts`);
    for (const n of names) piece(n, family);
    return names;
}

function run(args: string[]): { code: number; out: string[]; err: string } {
    const p = Bun.spawnSync(["bun", join(corpus, "scripts", "select-tests.ts"), ...args], {
        cwd: corpus,
        env: { ...process.env, TUG_APPTEST_RESULTS_DB: join(root, "apptest_results.db") },
    });
    return {
        code: p.exitCode,
        out: new TextDecoder().decode(p.stdout).split("\n").filter((l) => l.length > 0),
        err: new TextDecoder().decode(p.stderr),
    };
}

describe("the fan-out lint counts families", () => {
    test("twenty-one pieces of one family are one", () => {
        pieces("zz9001-split");
        const r = run(["--check"]);
        // Other findings about the corpus copy are not this test's; only the fixtures' are.
        expect(r.err).not.toContain(PATH);
        expect(r.err).not.toContain("zz9001");
    });

    test("the same twenty-one with no family fan out past the budget", () => {
        pieces();
        const r = run(["--check"]);
        expect(r.code).toBe(1);
        expect(r.err).toContain(`${PATH}  →  `);
    });
});

describe("a family holds to its name", () => {
    test("a member whose name does not start with the family fails", () => {
        piece("zz9001-split-a.test.ts", "zz9001-split");
        piece("zz9002-other.test.ts", "zz9001-split");
        const r = run(["--check"]);
        expect(r.code).toBe(1);
        expect(r.err).toContain("zz9002-other.test.ts  →  @family zz9001-split, but its name");
    });

    test("a family of one fails", () => {
        piece("zz9001-split-a.test.ts", "zz9001-split");
        const r = run(["--check"]);
        expect(r.code).toBe(1);
        expect(r.err).toContain("a family of one is a file");
    });
});

describe("the cut counts families", () => {
    test("every piece of a family inside the cut runs, past the file count", () => {
        const names = pieces("zz9001-split");
        const r = run([PATH]);
        expect(r.code).toBe(0);
        expect(r.out.length).toBeGreaterThan(MAX_SELECTED);
        for (const n of names) expect(r.out).toContain(n);
        expect(r.err).not.toContain("below the line");
    });

    test("without a family the cut stops at the file count", () => {
        pieces();
        const r = run([PATH]);
        expect(r.code).toBe(0);
        expect(r.out.length).toBe(MAX_SELECTED);
        expect(r.err).toContain("below the line");
    });
});
