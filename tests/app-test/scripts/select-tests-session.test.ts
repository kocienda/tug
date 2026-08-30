/**
 * select-tests-session.test.ts — selection derives from this session's changes.
 *
 * These run the real `select-tests.ts` as a subprocess inside a copied corpus, against a
 * `tugtool` stub placed exactly where the script resolves it (`tugrust/target/debug/tugtool`
 * relative to the copy's repo root). What is under test is the actual script doing actual
 * path resolution and actual `@covers` matching — not a re-implementation of either.
 *
 * Expected selections are computed by running the same script with explicit paths, which
 * bypasses the ledger entirely. That keeps the assertions true as the corpus changes: what
 * is pinned is "the ledger's paths select what those paths select", never a file count.
 *
 * This is a pure-logic test (no app launch); it lives beside the script it covers and is
 * invisible to `testFiles()`, which only scans the corpus root and `harness-smoke/`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
    chmodSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REAL_APP_TEST_DIR = resolve(dirname(import.meta.dir));

/** Four source paths with real, non-empty, mutually distinct `@covers` fan-out. */
const ATTRIBUTED = "tugdeck/src/lib/lens-store/store.ts";
const HINTED = "tugcode/src/types.ts";
const UNHINTED = "tugdeck/src/components/lens/lens-panel.tsx";
const FOREIGN = "tugdeck/src/components/chrome/deck-canvas.tsx";

let root: string;
let script: string;

/** The stub's argv log, its canned stdout, and its exit code — all under the copy's root. */
function stubFile(name: string): string {
    return join(root, name);
}

function armStub(stdout: string, exitCode: number): void {
    writeFileSync(stubFile("stub-stdout"), stdout);
    writeFileSync(stubFile("stub-exit"), String(exitCode));
    rmSync(stubFile("stub-calls"), { force: true });
}

function run(args: string[], session: string | null = "sess-under-test"): {
    code: number;
    out: string;
    err: string;
} {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (session === null) delete env.TUG_SESSION_ID;
    else env.TUG_SESSION_ID = session;
    const proc = Bun.spawnSync(["bun", script, ...args], {
        cwd: join(root, "tests", "app-test"),
        env,
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

/** A `tugtool changes --json` payload with the three buckets the selector reads. */
function payload(buckets: {
    files?: string[];
    unattributed?: { path: string; origin: string }[];
    foreign?: string[];
}): string {
    return JSON.stringify({
        schema_version: "1",
        command: "changes",
        status: "ok",
        data: {
            session: "sess-under-test",
            project: root,
            files: (buckets.files ?? []).map((path) => ({
                path,
                op: "write",
                origin: "exact",
                shared: false,
                git_status: " M",
            })),
            unattributed: (buckets.unattributed ?? []).map((u) => ({
                path: u.path,
                op: "modified",
                origin: u.origin,
                shared: false,
                git_status: " M",
            })),
            foreign: (buckets.foreign ?? []).map((path) => ({
                path,
                git_status: " M",
                sessions: ["someone-else"],
            })),
        },
        issues: [],
    });
}

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "select-tests-session-"));
    mkdirSync(join(root, "tests"), { recursive: true });
    cpSync(REAL_APP_TEST_DIR, join(root, "tests", "app-test"), { recursive: true });
    script = join(root, "tests", "app-test", "scripts", "select-tests.ts");

    // The copy is a git repo so the whole-tree fallback has something real to read.
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root });
    git("init", "-q");
    git("config", "user.email", "t@t.test");
    git("config", "user.name", "t");

    mkdirSync(join(root, "tugrust", "target", "debug"), { recursive: true });
    const stub = join(root, "tugrust", "target", "debug", "tugtool");
    writeFileSync(
        stub,
        [
            "#!/bin/sh",
            'R="$(cd "$(dirname "$0")/../../.." && pwd)"',
            'echo "$@" >> "$R/stub-calls"',
            'cat "$R/stub-stdout"',
            'exit "$(cat "$R/stub-exit")"',
            "",
        ].join("\n"),
    );
    chmodSync(stub, 0o755);
    armStub(payload({}), 0);

    // One dirty source file so the whole-tree fallback selects something.
    mkdirSync(join(root, dirname(ATTRIBUTED)), { recursive: true });
    writeFileSync(join(root, ATTRIBUTED), "export const x = 1;\n");
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("the ledger's buckets decide the selection", () => {
    test("attributed and hinted-unattributed select; unhinted and foreign do not", () => {
        armStub(
            payload({
                files: [ATTRIBUTED],
                unattributed: [
                    { path: HINTED, origin: "bash" },
                    { path: UNHINTED, origin: "none" },
                ],
                foreign: [FOREIGN],
            }),
            0,
        );
        const selected = new Set(lines(run(["--print"]).out));

        const included = lines(run(["--print", ATTRIBUTED, HINTED]).out);
        expect(included.length).toBeGreaterThan(0);
        for (const f of included) expect(selected.has(f)).toBe(true);

        // Anything the excluded two would have brought in on their own, and that the
        // included two do not also cover, must be absent.
        const excludedOnly = lines(run(["--print", UNHINTED, FOREIGN]).out).filter(
            (f) => !included.includes(f),
        );
        expect(excludedOnly.length).toBeGreaterThan(0);
        for (const f of excludedOnly) expect(selected.has(f)).toBe(false);
    });

    test("the attribution summary names all three counts", () => {
        armStub(
            payload({
                files: [ATTRIBUTED],
                unattributed: [
                    { path: HINTED, origin: "bash" },
                    { path: UNHINTED, origin: "none" },
                ],
                foreign: [FOREIGN],
            }),
            0,
        );
        expect(run(["--print"]).err).toContain(
            "sess-under-test: 1 attributed + 1 unattributed-hinted (1 foreign ignored)",
        );
    });

    test("an empty classification over a dirty tree is called out, not read as clean", () => {
        armStub(payload({}), 0);
        const r = run(["--print"]);
        expect(r.err).toContain("--project spelling mismatch");
        expect(r.err).toContain(root);
    });
});

describe("every fallback says which one it took and why", () => {
    test("no TUG_SESSION_ID falls back to the whole tree", () => {
        armStub(payload({ files: [ATTRIBUTED] }), 0);
        const r = run(["--print"], null);
        expect(r.err).toContain("no TUG_SESSION_ID — selecting from the whole working tree");
        expect(lines(r.out).length).toBeGreaterThan(0);
    });

    test("exit 2 falls back and names the unresolvable session", () => {
        armStub("", 2);
        const r = run(["--print"]);
        expect(r.err).toContain(
            "session sess-under-test not resolvable — selecting from the whole working tree",
        );
        expect(lines(r.out).length).toBeGreaterThan(0);
    });

    test("a non-zero non-2 exit falls back as unavailable", () => {
        armStub("", 1);
        const r = run(["--print"]);
        expect(r.err).toContain("tugtool unavailable");
        expect(r.err).toContain("selecting from the whole working tree");
        expect(lines(r.out).length).toBeGreaterThan(0);
    });

    test("unreadable JSON falls back as unavailable", () => {
        armStub("not json at all", 0);
        const r = run(["--print"]);
        expect(r.err).toContain("tugtool unavailable (unreadable JSON)");
        expect(lines(r.out).length).toBeGreaterThan(0);
    });

    test("no built binary falls back as unavailable", () => {
        const stub = join(root, "tugrust", "target", "debug", "tugtool");
        cpSync(stub, `${stub}.saved`);
        rmSync(stub);
        try {
            const r = run(["--print"]);
            expect(r.err).toContain("tugtool unavailable (no built binary under tugrust/target)");
            expect(lines(r.out).length).toBeGreaterThan(0);
        } finally {
            cpSync(`${stub}.saved`, stub);
            chmodSync(stub, 0o755);
            rmSync(`${stub}.saved`);
        }
    });
});

describe("explicit paths bypass the ledger", () => {
    test("the stub is never invoked when paths are named", () => {
        armStub(payload({ files: [FOREIGN] }), 0);
        const r = run(["--print", ATTRIBUTED]);
        expect(r.code).toBe(0);
        expect(existsSync(stubFile("stub-calls"))).toBe(false);
        expect(lines(r.out)).toEqual(lines(run(["--print", ATTRIBUTED]).out));
    });
});
