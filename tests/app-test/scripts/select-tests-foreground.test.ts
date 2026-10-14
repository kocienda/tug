/**
 * select-tests-foreground.test.ts — the `@foreground` declaration and its drift check.
 *
 * These run the real `select-tests.ts` as a subprocess. The drift cases run it against a
 * copy of the real corpus with one file's declaration deliberately broken, so what is
 * under test is the actual script reading actual test files — not a re-implementation of
 * its parser.
 *
 * This is a pure-logic test (no app launch); it lives beside the script it covers and is
 * invisible to `testFiles()`, which only scans the corpus root, `harness-smoke/` and `body-grounding/`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { copyAppTestTree } from "./copy-app-test-tree";

const APP_TEST_DIR = resolve(dirname(import.meta.dir));
const SCRIPT = join(APP_TEST_DIR, "scripts", "select-tests.ts");

/** A file that both declares `@foreground` and launches with `foreground: true`. */
const TAGGED = "at0145-permission-dialog-keyboard.test.ts";
/** A background file whose name shares the `at0209` prefix with a foreground one. */
const PREFIX_TWIN = "at0209-text-card-live-autosave.test.ts";

function run(script: string, args: string[]): { code: number; out: string; err: string } {
    const proc = Bun.spawnSync(["bun", script, ...args], { cwd: APP_TEST_DIR });
    return {
        code: proc.exitCode,
        out: new TextDecoder().decode(proc.stdout),
        err: new TextDecoder().decode(proc.stderr),
    };
}

function lines(s: string): string[] {
    return s.split("\n").filter((l) => l.length > 0);
}

describe("--foreground / --core against the real corpus", () => {
    test("--foreground returns only the tagged files", () => {
        const r = run(SCRIPT, ["--foreground", "at0001-tab-switch-fc.test.ts", TAGGED]);
        expect(r.code).toBe(0);
        expect(lines(r.out)).toEqual([TAGGED]);
    });

    test("--foreground matches whole names, not test-id prefixes", () => {
        // at0209-picker-field-click-single-focus IS foreground; this one is not.
        const r = run(SCRIPT, ["--foreground", PREFIX_TWIN]);
        expect(r.code).toBe(0);
        expect(lines(r.out)).toEqual([]);
    });

    test("--foreground accepts the repo-root-relative form tab-completion produces", () => {
        const r = run(SCRIPT, ["--foreground", `tests/app-test/${TAGGED}`]);
        expect(lines(r.out)).toEqual([TAGGED]);
    });

    test("--core lists files that all exist in the corpus", () => {
        const r = run(SCRIPT, ["--core"]);
        expect(r.code).toBe(0);
        const core = lines(r.out);
        expect(core.length).toBeGreaterThan(0);
        for (const f of core) {
            expect(readFileSync(join(APP_TEST_DIR, f), "utf8").length).toBeGreaterThan(0);
        }
    });

    test("the corpus itself has no drift", () => {
        expect(run(SCRIPT, ["--foreground-check"]).code).toBe(0);
    });
});

describe("--foreground-check detects drift in both directions", () => {
    let dir: string;
    let script: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "select-tests-drift-"));
        copyAppTestTree(APP_TEST_DIR, join(dir, "app-test"));
        script = join(dir, "app-test", "scripts", "select-tests.ts");
    });

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function copyPath(file: string): string {
        return join(dir, "app-test", file);
    }

    test("a launch option with no tag is reported", () => {
        const path = copyPath(TAGGED);
        const original = readFileSync(path, "utf8");
        writeFileSync(path, original.replace(/^ \* @foreground\n/m, ""));
        const r = run(script, ["--foreground-check"]);
        writeFileSync(path, original);

        expect(r.code).toBe(1);
        expect(r.err).toContain(TAGGED);
        expect(r.err).toContain("take the screen but carry no");
    });

    test("a tag with no screen-taking behavior is reported", () => {
        const path = copyPath(PREFIX_TWIN);
        const original = readFileSync(path, "utf8");
        writeFileSync(path, original.replace(/^ \* @covers/m, " * @foreground\n * @covers"));
        const r = run(script, ["--foreground-check"]);
        writeFileSync(path, original);

        expect(r.code).toBe(1);
        expect(r.err).toContain(PREFIX_TWIN);
        expect(r.err).toContain("declare @foreground but neither pass a");
    });

    test("an app-lifecycle verb is screen-taking behavior on its own", () => {
        // The verb reaches `NSApp.activate` / a Finder activation inside the app
        // whatever mode it launched in, so a file calling one takes the screen
        // even with no `foreground` launch option anywhere in it. Reading only
        // the launch option is what let this class through.
        const path = copyPath(PREFIX_TWIN);
        const original = readFileSync(path, "utf8");
        writeFileSync(path, `${original}\n// await app.simulateAppResign();\n`);
        const r = run(script, ["--foreground-check"]);
        writeFileSync(path, original);

        expect(r.code).toBe(1);
        expect(r.err).toContain(PREFIX_TWIN);
        // Both findings: undeclared, and a verb that cannot fire without the option.
        expect(r.err).toContain("take the screen but carry no");
        expect(r.err).toContain("call an app-lifecycle verb without");
    });
});
