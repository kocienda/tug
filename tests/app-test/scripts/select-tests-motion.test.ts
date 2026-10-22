/**
 * select-tests-motion.test.ts — the `@motion` declaration and the queues it sorts a run into.
 *
 * These run the real `select-tests.ts` as a subprocess. The cases that need a broken
 * declaration run it against a copy of the corpus with one file's docblock rewritten, so
 * what is under test is the actual script reading actual test files.
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

/** A motion file, tagged by reading what it samples. */
const MOTION = "at0624-reveal-travel-on-curve.test.ts";
/** A file in the settle number range that samples nothing, and carries no tag. */
const IN_RANGE_PLAIN = "at0709-insert-file-image.test.ts";
/** A screen-taker. */
const FOREGROUND = "body-grounding/row-12-composer-session-panel.test.ts";
const PLAIN = "at0216-shell-exchange.test.ts";

function run(script: string, args: string[]): { code: number; out: string; err: string } {
    const proc = Bun.spawnSync(["bun", script, ...args], { cwd: dirname(dirname(script)) });
    return {
        code: proc.exitCode,
        out: new TextDecoder().decode(proc.stdout),
        err: new TextDecoder().decode(proc.stderr),
    };
}

function queues(script: string, files: string[]): [string, string][] {
    const r = run(script, ["--queues", ...files]);
    expect(r.code).toBe(0);
    return r.out
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => l.split("\t") as [string, string]);
}

describe("--queues against the real corpus", () => {
    test("each file is named with its queue, in the order given", () => {
        expect(queues(SCRIPT, [PLAIN, FOREGROUND, IN_RANGE_PLAIN, MOTION])).toEqual([
            ["batch", PLAIN],
            ["foreground", FOREGROUND],
            ["batch", IN_RANGE_PLAIN],
            ["motion", MOTION],
        ]);
    });

    test("accepts the repo-root-relative form and names the file the way the runner does", () => {
        expect(queues(SCRIPT, [`tests/app-test/${MOTION}`])).toEqual([["motion", MOTION]]);
    });

    test("a name the corpus does not know runs in the batch, as it always did", () => {
        expect(queues(SCRIPT, ["zz-not-a-file.test.ts"])).toEqual([["batch", "zz-not-a-file.test.ts"]]);
    });
});

describe("against a corpus copy with a declaration rewritten", () => {
    let dir: string;
    let script: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "select-tests-motion-"));
        copyAppTestTree(APP_TEST_DIR, join(dir, "app-test"));
        script = join(dir, "app-test", "scripts", "select-tests.ts");
    });

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    /** Rewrite one corpus file for the length of `body`, then put it back. */
    function rewritten<T>(file: string, edit: (s: string) => string, body: () => T): T {
        const path = join(dir, "app-test", file);
        const original = readFileSync(path, "utf8");
        writeFileSync(path, edit(original));
        try {
            return body();
        } finally {
            writeFileSync(path, original);
        }
    }

    test("a file both motion and foreground is a screen-taker — that queue is already serial", () => {
        const got = rewritten(
            MOTION,
            (s) => s.replace(/^ \* @motion\n/m, " * @motion\n * @foreground\n"),
            () => queues(script, [MOTION]),
        );
        expect(got).toEqual([["foreground", MOTION]]);
    });

    test("an untagged motion file runs in the batch — the tag is the only reading", () => {
        const got = rewritten(
            MOTION,
            (s) => s.replace(/^ \* @motion\n/m, ""),
            () => queues(script, [MOTION]),
        );
        expect(got).toEqual([["batch", MOTION]]);
    });
});
