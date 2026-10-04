/**
 * select-tests-rank.test.ts — over a real diff, the selector ranks, cuts, and says why.
 *
 * Each case runs the real `select-tests.ts` in a throwaway repo holding a copy of the
 * corpus, with the source roots linked beside it — except `focus-manager.ts` and
 * `test-surface.ts`, which are copied, committed, and then edited, so the diff the script
 * reads is a real `git diff` against a real commit and the real tree is never touched.
 *
 * Ranks are asserted as properties — every namer above every non-namer, exactly the cap
 * on stdout — never as a literal order, because the corpus moves.
 *
 * The map-backed cases seed a scratch results ledger through the real
 * `tugtool apptest reach record` (the fixture's `tugrust` is a link to the real one, so the
 * script finds the same built binary), each case with a ledger of its own.
 *
 * This is a pure-logic test (no app launch); it lives beside the script it covers and is
 * invisible to `testFiles()`, which only scans the corpus root and `harness-smoke/`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
    copyFileSync,
    cpSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REAL_APP_TEST_DIR = resolve(dirname(import.meta.dir));
const REAL_REPO = resolve(REAL_APP_TEST_DIR, "..", "..");
const SOURCE_ROOTS = ["tugdeck", "tugrust", "tugapp", "tugcode", "tuglaws"];
const FOCUS = "tugdeck/src/components/tugways/focus-manager.ts";
const COPIED = [FOCUS, "tugdeck/src/test-surface.ts"];
const MAX_SELECTED = 20;

let root: string;
let script: string;
let ledger: string;

/**
 * Link `real` into `dst` entry by entry, copying the files in `keep` (paths relative to
 * `real`) and descending only into the directories that lead to one.
 */
function mirror(real: string, dst: string, keep: string[]): void {
    mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(real)) {
        if (keep.includes(entry)) {
            copyFileSync(join(real, entry), join(dst, entry));
            continue;
        }
        const below = keep.filter((k) => k.startsWith(`${entry}/`)).map((k) => k.slice(entry.length + 1));
        if (below.length > 0) mirror(join(real, entry), join(dst, entry), below);
        else symlinkSync(join(real, entry), join(dst, entry));
    }
}

function git(...args: string[]): void {
    const p = Bun.spawnSync(["git", ...args], { cwd: root });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

function run(args: string[]): { code: number; out: string[]; err: string } {
    const p = Bun.spawnSync(["bun", script, ...args], {
        cwd: join(root, "tests", "app-test"),
        env: { ...process.env, TUG_APPTEST_RESULTS_DB: ledger },
    });
    return {
        code: p.exitCode,
        out: p.stdout.toString().split("\n").filter((l) => l.length > 0),
        err: p.stderr.toString(),
    };
}

/** Insert `line` after the one line of the working-tree `FOCUS` that equals `anchor`. */
function editAfter(anchor: string, line: string): void {
    const path = join(root, FOCUS);
    const lines = readFileSync(path, "utf8").split("\n");
    const at = lines.indexOf(anchor);
    if (at === -1 || lines.lastIndexOf(anchor) !== at) throw new Error(`anchor not unique: ${anchor}`);
    lines.splice(at + 1, 0, line);
    writeFileSync(path, lines.join("\n"));
}

interface RankLine {
    rank: number;
    file: string;
    reach: number;
    note: string;
    /** Below the cut, the axis the line says it lost on. */
    lost: string | undefined;
    raw: string;
}

const RANK_LINE =
    /^ *(\d+)\. (\S+\.test\.ts) +reaches (\d+) \[([^\]]+)\] · \d+ changed files? · (last green|no history|ledger unavailable|red-streak \(\d+\)) · (\d+|\?)s( · lost on (reach|negative map|changed files|red streak|seconds|name))?$/;

const TUGTOOL = join(REAL_REPO, "tugrust", "target", "debug", "tugtool");
const SYMBOL = "FocusContext.mayRestoreFirstResponder";

/** The nine candidates that name no surface the change guards. */
const F02 = [
    "at0109-focus-ring.test.ts",
    "at0121-list-view-container-focus.test.ts",
    "at0126-keyboard-ring-cold-boot.test.ts",
    "at0127-list-view-cursor.test.ts",
    "at0246-focus-boot-invariant.test.ts",
    "at0250-focus-steal-trap.test.ts",
    "at0252-accessibility-focus-follows.test.ts",
    "at0267-drag-activation-focus.test.ts",
    "at0398-chord-ring.test.ts",
];

interface Seed {
    file: string;
    headSha: string;
    /** Whether the map's `focus-manager.ts` entry hits the changed symbol. */
    hits: boolean;
    /** A whole map, in place of the one-module map `hits` describes. */
    map?: Record<string, { n: number; hit: string[] }>;
}

/** Record one map per seed in the current `ledger`, through the real verb. */
function seed(seeds: Seed[]): void {
    for (const s of seeds) {
        const payload = {
            runRoot: root,
            headSha: s.headSha,
            recordedAt: 1_790_000_000,
            files: [{ file: s.file, map: s.map ?? { [FOCUS]: { n: 196, hit: s.hits ? [SYMBOL] : ["FocusContext.advance"] } } }],
        };
        const p = Bun.spawnSync([TUGTOOL, "apptest", "reach", "record"], {
            stdin: new TextEncoder().encode(JSON.stringify(payload)),
            env: { ...process.env, TUG_APPTEST_RESULTS_DB: ledger },
        });
        if (p.exitCode !== 0) throw new Error(`reach record: ${p.stderr.toString()}`);
    }
}

function head(): string {
    return Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: root }).stdout.toString().trim();
}

function rankLines(err: string): RankLine[] {
    return err
        .split("\n")
        .filter((l) => /^ *\d+\. /.test(l))
        .map((raw) => {
            const m = RANK_LINE.exec(raw);
            if (m === null) throw new Error(`rank line does not match the report shape: ${raw}`);
            return { rank: Number(m[1]), file: m[2], reach: Number(m[3]), note: m[4], lost: m[8], raw };
        });
}

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "select-tests-rank-"));
    ledger = join(root, "apptest_results.db");
    mkdirSync(join(root, "tests"), { recursive: true });
    cpSync(REAL_APP_TEST_DIR, join(root, "tests", "app-test"), { recursive: true });
    for (const r of SOURCE_ROOTS) {
        const keep = COPIED.filter((c) => c.startsWith(`${r}/`)).map((c) => c.slice(r.length + 1));
        if (keep.length > 0) mirror(join(REAL_REPO, r), join(root, r), keep);
        else symlinkSync(join(REAL_REPO, r), join(root, r));
    }
    script = join(root, "tests", "app-test", "scripts", "select-tests.ts");
    git("init", "-q");
    git("config", "user.email", "t@t.test");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
    git("add", "-A");
    git("commit", "-q", "-m", "corpus");
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("a change inside a function no candidate names", () => {
    beforeAll(() => {
        git("checkout", "--", FOCUS);
        editAfter("  private mayRestoreFirstResponder(): boolean {", "    void 0;");
    });

    test("the report names the symbol and its callers, and every line reads no mention", () => {
        const r = run(["--print", FOCUS]);
        expect(r.code).toBe(0);
        expect(r.err).toContain(
            `${FOCUS} → FocusContext.mayRestoreFirstResponder (+ callers FocusContext.popFocusMode, FocusContext.relinquishFocusMode)`,
        );
        const ranked = rankLines(r.err);
        expect(ranked.length).toBe(r.out.length);
        expect(ranked.length).toBeGreaterThan(MAX_SELECTED);
        for (const l of ranked) expect(l.note).toBe("textual: no mention");
        expect(ranked.map((l) => l.rank)).toEqual(ranked.map((_, i) => i + 1));
        expect(r.err).toContain(`---- cap: ${MAX_SELECTED} — below the line, in rank order ----`);
        // Above the line nothing lost; below it, every line says on which axis.
        for (const l of ranked) expect(l.lost === undefined).toBe(l.rank <= MAX_SELECTED);
    });

    test("bare mode cuts at the cap, exits 0, and is the head of the ranking", () => {
        const bare = run([FOCUS]);
        const printed = run(["--print", FOCUS]);
        expect(bare.code).toBe(0);
        expect(bare.out.length).toBe(MAX_SELECTED);
        expect(printed.out.slice(0, MAX_SELECTED)).toEqual(bare.out);
        expect(rankLines(printed.err).map((l) => l.file)).toEqual(printed.out);
    });
});

describe("a change inside a function some candidates name", () => {
    beforeAll(() => {
        git("checkout", "--", FOCUS);
        editAfter("  adoptKeyCard(cardId: string, opts?: { modality?: FocusModality }): boolean {", "    void 0;");
    });

    test("every candidate that reaches it ranks above every one that does not", () => {
        const r = run(["--print", FOCUS]);
        expect(r.code).toBe(0);
        expect(r.err).toContain(`${FOCUS} → FocusManager.adoptKeyCard`);
        const ranked = rankLines(r.err);
        const namers = ranked.filter((l) => l.reach > 0);
        const others = ranked.filter((l) => l.reach === 0);
        expect(namers.length).toBeGreaterThan(0);
        expect(others.length).toBeGreaterThan(0);
        expect(Math.max(...namers.map((l) => l.rank))).toBeLessThan(Math.min(...others.map((l) => l.rank)));

        // The tests that spell the method itself say so.
        const direct = ranked.filter((l) =>
            /(?<![A-Za-z0-9_$])adoptKeyCard(?![A-Za-z0-9_$])/.test(
                readFileSync(join(REAL_APP_TEST_DIR, l.file), "utf8"),
            ),
        );
        expect(direct.length).toBeGreaterThan(0);
        for (const l of direct) expect(l.note).toBe("textual: adoptKeyCard, symbol");
        for (const l of others) expect(l.note).toBe("textual: no mention");
    });
});

describe("with recorded reach maps", () => {
    let candidates: string[];

    beforeAll(() => {
        git("checkout", "--", FOCUS);
        editAfter("  private mayRestoreFirstResponder(): boolean {", "    void 0;");
        ledger = join(root, "maps-a.db");
        candidates = run(["--print", FOCUS]).out;
    });

    test("a hit is measured and first, a miss at a known tree is negative and last, an unknown tree is textual", () => {
        const others = candidates.filter((f) => !F02.includes(f));
        // The candidate filename order would put last among the map-less.
        const hitter = others[others.length - 1];
        const misser = others[0];
        const stranger = others[1];
        seed([
            { file: hitter, headSha: head(), hits: true },
            { file: misser, headSha: head(), hits: false },
            { file: stranger, headSha: "0000000", hits: false },
        ]);
        const ranked = rankLines(run(["--print", FOCUS]).err);
        const line = (f: string) => ranked.find((l) => l.file === f)!;

        expect(ranked[0].file).toBe(hitter);
        expect(line(hitter).reach).toBe(1);
        expect(line(hitter).note).toBe("measured: mayRestoreFirstResponder");

        expect(line(misser).note).toBe("negative");
        expect(line(misser).rank).toBe(ranked.length);

        expect(line(stranger).note).toBe("textual: no mention");
        for (const l of ranked) {
            if (l.file !== hitter && l.file !== misser) expect(l.note).toBe("textual: no mention");
        }
    });

    test("measured maps put every candidate that names no guarded surface below the line", () => {
        ledger = join(root, "maps-b.db");
        const others = candidates.filter((f) => !F02.includes(f));
        expect(candidates.filter((f) => F02.includes(f)).length).toBe(F02.length);
        expect(others.length).toBeGreaterThanOrEqual(MAX_SELECTED);
        seed([
            ...others.slice(0, MAX_SELECTED).map((file) => ({ file, headSha: head(), hits: true })),
            ...F02.map((file) => ({ file, headSha: head(), hits: false })),
        ]);
        const r = run([FOCUS]);
        expect(r.out.length).toBe(MAX_SELECTED);
        for (const f of F02) expect(r.out).not.toContain(f);
        const ranked = rankLines(r.err);
        for (const f of F02) {
            const l = ranked.find((x) => x.file === f)!;
            expect(l.rank).toBeGreaterThan(MAX_SELECTED);
            expect(l.note).toBe("negative");
        }
    });
});

describe("the reach report", () => {
    beforeAll(() => {
        git("checkout", "--", FOCUS);
        ledger = join(root, "maps-c.db");
        seed([
            { file: "at0109-focus-ring.test.ts", headSha: head(), hits: false },
            {
                file: "at0121-list-view-container-focus.test.ts",
                headSha: head(),
                hits: true,
                map: { [FOCUS]: { n: 10, hit: Array.from({ length: 9 }, (_, i) => `FocusContext.f${i}`) } },
            },
        ]);
    });

    test("prints hit/n per covered module, no map for an unseeded test, and names the wide claimer", () => {
        const r = run([
            "--reach",
            "at0109-focus-ring.test.ts",
            "at0121-list-view-container-focus.test.ts",
            "at0126-keyboard-ring-cold-boot.test.ts",
        ]);
        expect(r.code).toBe(0);
        expect(r.out).toContain("at0109-focus-ring.test.ts  covered 1/196 (1%)");
        expect(r.out).toContain(`  ${FOCUS}  1/196 (1%)`);
        expect(r.out).toContain("at0121-list-view-container-focus.test.ts  covered 9/10 (90%)");
        expect(r.out).toContain("at0126-keyboard-ring-cold-boot.test.ts  no map");
        expect(r.out[r.out.length - 1]).toBe("claim nearly everything they cover: at0121-list-view-container-focus.test.ts");
    });
});

describe("a covered file with no hunks", () => {
    beforeAll(() => {
        git("checkout", "--", FOCUS);
    });

    test("says no hunks and still ranks and cuts on the remaining axes", () => {
        const r = run([FOCUS]);
        expect(r.code).toBe(0);
        expect(r.err).toContain(`${FOCUS} → no hunks`);
        expect(r.out.length).toBe(MAX_SELECTED);
        for (const l of rankLines(r.err)) {
            expect(l.reach).toBe(0);
            expect(l.note).toBe("no hunks");
        }
    });
});
