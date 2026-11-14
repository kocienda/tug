/**
 * select-tests-lab.test.ts — an `@lab` file never reaches a host run.
 *
 * Each case copies the corpus into a scratch directory, adds two fixture files that cover
 * one source path — one declaring `@lab`, one not — and runs the real `select-tests.ts`
 * there, once as the host runs it (no `TUG_LAB`) and once as `scripts/lab/guest-app-test`
 * does (`TUG_LAB=1`). The derived selection, the `--all` sweep list and the `--core` tier
 * are the three ways a host run names files without being told them, and each is checked.
 *
 * This is a pure-logic test (no app launch); it lives beside the script it covers and is
 * invisible to `testFiles()`, which only scans the corpus root, `harness-smoke/` and `body-grounding/`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { copyAppTestTree } from "./copy-app-test-tree";

const REAL_APP_TEST_DIR = resolve(dirname(import.meta.dir));
const SOURCE_ROOTS = ["tugdeck", "tugrust", "tugapp", "tugcode", "tuglaws", "tugplug", "tugproto"];

/** A source path few tests name, so the two fixtures are the whole story. */
const PATH = "tugcode/src/types.ts";
const LAB = "zz9101-lab-layout.test.ts";
const HOST = "zz9102-host-twin.test.ts";
/** A core-tier file, rewritten to declare `@lab` for the tier's own check. */
const CORE_FILE = "harness-smoke/smoke.test.ts";

let root: string;
let corpus: string;

function fixture(name: string, lab: boolean): void {
    const tag = lab ? " * @lab\n" : "";
    writeFileSync(
        join(corpus, name),
        `/**\n * ${name} — fixture.\n *\n * @covers ${PATH}\n${tag} */\n\nimport { test } from "bun:test";\n\ntest("x", () => {});\n`,
    );
}

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "select-tests-lab-"));
    mkdirSync(join(root, "tests"), { recursive: true });
    corpus = join(root, "tests", "app-test");
    copyAppTestTree(REAL_APP_TEST_DIR, corpus);
    const realRepo = resolve(REAL_APP_TEST_DIR, "..", "..");
    for (const r of SOURCE_ROOTS) symlinkSync(join(realRepo, r), join(root, r));
    fixture(LAB, true);
    fixture(HOST, false);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Run the selector as the host does (`lab` false) or as a lab guest does. */
function run(args: string[], lab: boolean): { code: number; out: string[]; err: string } {
    const env: Record<string, string | undefined> = {
        ...process.env,
        TUG_APPTEST_RESULTS_DB: join(root, "apptest_results.db"),
    };
    delete env.TUG_LAB;
    if (lab) env.TUG_LAB = "1";
    const p = Bun.spawnSync(["bun", join(corpus, "scripts", "select-tests.ts"), ...args], { cwd: corpus, env });
    return {
        code: p.exitCode,
        out: new TextDecoder().decode(p.stdout).split("\n").filter((l) => l.length > 0),
        err: new TextDecoder().decode(p.stderr),
    };
}

describe("a derived selection", () => {
    test("on the host, an @lab file with a matching @covers is dropped and named as set aside", () => {
        const r = run([PATH], false);
        expect(r.code).toBe(0);
        expect(r.out).toContain(HOST);
        expect(r.out).not.toContain(LAB);
        expect(r.err).toContain(`@lab file(s) cover the change and run only in a lab guest`);
        expect(r.err).toContain(LAB);
    });

    test("in a lab run, the same selection keeps it", () => {
        const r = run([PATH], true);
        expect(r.code).toBe(0);
        expect(r.out).toContain(HOST);
        expect(r.out).toContain(LAB);
    });

    test("the printed ranking drops it on the host too", () => {
        const r = run(["--print", PATH], false);
        expect(r.code).toBe(0);
        expect(r.out).toContain(HOST);
        expect(r.out).not.toContain(LAB);
    });
});

describe("the --all sweep list", () => {
    test("on the host it is every file but the @lab ones", () => {
        const r = run(["--all"], false);
        expect(r.code).toBe(0);
        expect(r.out).toContain(HOST);
        expect(r.out).not.toContain(LAB);
        expect(r.out).toContain(CORE_FILE);
    });

    test("in a lab run it is every file", () => {
        const r = run(["--all"], true);
        expect(r.code).toBe(0);
        expect(r.out).toContain(LAB);
        expect(r.out).toContain(HOST);
    });

    test("it lists the corpus in run order: smoke, then the root, then body-grounding", () => {
        const out = run(["--all"], false).out;
        const firstRoot = out.findIndex((f) => !f.includes("/"));
        const firstGrounding = out.findIndex((f) => f.startsWith("body-grounding/"));
        expect(out.slice(0, firstRoot).every((f) => f.startsWith("harness-smoke/"))).toBe(true);
        expect(firstGrounding).toBeGreaterThan(firstRoot);
        expect(out.slice(firstGrounding).every((f) => f.startsWith("body-grounding/"))).toBe(true);
    });
});

describe("the core tier", () => {
    test("names no @lab file as shipped", () => {
        const r = run(["--core"], false);
        expect(r.code).toBe(0);
        expect(r.out).toContain(CORE_FILE);
    });

    test("refuses a tier entry that declares @lab", () => {
        const path = join(corpus, CORE_FILE);
        const original = readFileSync(path, "utf8");
        writeFileSync(path, original.replace(/^( \* @covers .*\n)/m, "$1 * @lab\n"));
        try {
            const r = run(["--core"], false);
            expect(r.code).toBe(1);
            expect(r.err).toContain("@lab");
            expect(r.err).toContain(CORE_FILE);
        } finally {
            writeFileSync(path, original);
        }
    });
});
