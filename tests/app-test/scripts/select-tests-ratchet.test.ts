/**
 * select-tests-ratchet.test.ts — an accepted fan-out number may fall, never rise.
 *
 * Each case builds a throwaway git repo holding a copy of the corpus, commits it, edits
 * the working-tree `ACCEPTED_FANOUT`, and runs the real `select-tests.ts --check` there.
 * The comparison under test is a real `git show HEAD:` against a real commit — the rule
 * is about history, so a fixture without history would not exercise it.
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

/** The source roots `@covers` lines name. Symlinked so declarations resolve on disk. */
const SOURCE_ROOTS = ["tugdeck", "tugrust", "tugapp", "tugcode"];

/**
 * A throwaway repo holding a copy of the corpus, with the real source roots symlinked
 * beside it so every `@covers` path resolves. Only the corpus is copied — the roots are
 * links, so `git add` records four symlinks rather than the whole tree.
 */
function makeRepo(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    mkdirSync(join(dir, "tests"), { recursive: true });
    cpSync(REAL_APP_TEST_DIR, join(dir, "tests", "app-test"), { recursive: true });
    const realRepo = resolve(REAL_APP_TEST_DIR, "..", "..");
    for (const r of SOURCE_ROOTS) symlinkSync(join(realRepo, r), join(dir, r));
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    return dir;
}

/** An entry that exists in the real ACCEPTED_FANOUT, so the committed side has it too. */
const KNOWN_KEY = "tugdeck/src/components/chrome/deck-canvas.tsx";

/**
 * Its accepted number, read from the real script rather than written down here. A
 * literal would rot the moment the corpus moved the entry: the rewrites below would
 * silently match nothing, every case would check an unedited script, and the ratchet
 * would look green while testing nothing at all.
 */
const KNOWN_N = (() => {
    const src = readFileSync(join(REAL_APP_TEST_DIR, "scripts", "select-tests.ts"), "utf8");
    const at = src.indexOf(`"${KNOWN_KEY}": `);
    if (at === -1) throw new Error(`ACCEPTED_FANOUT has no entry for ${KNOWN_KEY}`);
    return Number.parseInt(src.slice(at + KNOWN_KEY.length + 4), 10);
})();

let root: string;
let script: string;

function git(...args: string[]): void {
    const p = Bun.spawnSync(["git", ...args], { cwd: root });
    if (p.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
    }
}

function check(): { code: number; err: string } {
    const p = Bun.spawnSync(["bun", script, "--check"], {
        cwd: join(root, "tests", "app-test"),
    });
    return { code: p.exitCode, err: new TextDecoder().decode(p.stderr) };
}

/** Rewrite the working-tree script's ACCEPTED_FANOUT block. */
function setFanout(edit: (src: string) => string): void {
    writeFileSync(script, edit(readFileSync(script, "utf8")));
}

function restoreScript(): void {
    git("checkout", "--", SCRIPT_REL);
}

/** Move KNOWN_KEY's accepted number to `n`, failing loudly if the entry isn't there. */
function setKnownFanout(n: number): void {
    setFanout((s) => {
        const from = `"${KNOWN_KEY}": ${KNOWN_N}`;
        if (!s.includes(from)) throw new Error(`script no longer holds ${from}`);
        return s.replace(from, `"${KNOWN_KEY}": ${n}`);
    });
}

beforeAll(() => {
    root = makeRepo("select-tests-ratchet-");
    script = join(root, SCRIPT_REL);

    git("config", "user.email", "t@t.test");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-q", "-m", "corpus");
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("the accepted-fan-out ratchet", () => {
    test("the committed corpus passes as-is", () => {
        expect(check().code).toBe(0);
    });

    test("raising an entry fails, and the message names the key and both numbers", () => {
        setKnownFanout(KNOWN_N + 1);
        const r = check();
        restoreScript();
        expect(r.code).toBe(1);
        expect(r.err).toContain(KNOWN_KEY);
        expect(r.err).toContain(`${KNOWN_N} raised to ${KNOWN_N + 1}`);
        expect(r.err).toContain("delete the entry and re-add it");
    });

    test("lowering an entry passes", () => {
        // Lowering below the real fan-out would trip the budget rule instead, so the
        // corpus copy loses the tests that make this path wide before the number moves.
        const covered = Bun.spawnSync(["bun", script, "--print", KNOWN_KEY], {
            cwd: join(root, "tests", "app-test"),
        });
        const files = new TextDecoder()
            .decode(covered.stdout)
            .split("\n")
            .filter((l) => l.length > 0);
        expect(files.length).toBeGreaterThan(1);
        for (const f of files.slice(0, 2)) rmSync(join(root, "tests", "app-test", f));

        setKnownFanout(KNOWN_N - 1);
        const r = check();
        restoreScript();
        git("checkout", "--", "tests/app-test");
        expect(r.code).toBe(0);
    });

    test("a wholly new key is not subject to the rule", () => {
        setFanout((s) =>
            s.replace(
                "const ACCEPTED_FANOUT: Record<string, number> = {",
                'const ACCEPTED_FANOUT: Record<string, number> = {\n    "tugdeck/src/brand-new-hub.ts": 99,',
            ),
        );
        const r = check();
        restoreScript();
        expect(r.code).toBe(0);
        expect(r.err).not.toContain("went UP");
    });

    test("an unreadable committed version warns and stands down", () => {
        // A repo with no HEAD at all: `git show HEAD:` cannot resolve, so the rule has
        // no history to compare against.
        const bare = makeRepo("select-tests-ratchet-bare-");
        try {
            const p = Bun.spawnSync(["bun", join(bare, SCRIPT_REL), "--check"], {
                cwd: join(bare, "tests", "app-test"),
            });
            const err = new TextDecoder().decode(p.stderr);
            expect(err).toContain("ratchets against history stand down this run");
            expect(p.exitCode).toBe(0);
        } finally {
            rmSync(bare, { recursive: true, force: true });
        }
    });
});
