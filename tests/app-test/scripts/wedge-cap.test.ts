/**
 * The wedge cap: its arithmetic, how it reads the ledger's answer, and the script that
 * enforces it. The kill path runs against a plain `sleep`, so it is proven without an
 * app that has stopped answering.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    basisSecs,
    capLines,
    capSecs,
    declaredTimeoutSecs,
    historyRows,
    lastSecsFrom,
    median,
    recentSecsFrom,
    WEDGE_FLOOR_SECS,
} from "./wedge-cap";

const RUN_CAPPED = join(import.meta.dir, "run-capped.sh");

describe("capSecs", () => {
    test("three times the basis it is given", () => {
        expect(capSecs(160)).toBe(480);
        expect(capSecs(41)).toBe(123);
    });

    test("never under the two-minute floor", () => {
        expect(WEDGE_FLOOR_SECS).toBe(120);
        expect(capSecs(6)).toBe(120);
        expect(capSecs(40)).toBe(120);
    });

    test("an unknown or nonsensical time gets the floor", () => {
        expect(capSecs(null)).toBe(120);
        expect(capSecs(0)).toBe(120);
        expect(capSecs(-3)).toBe(120);
        expect(capSecs(Number.NaN)).toBe(120);
    });

    // A file that cannot finish inside the floor would be killed on every run, and a wedge
    // records no time, so it would never earn the history that lifts its cap.
    test("with no recorded time, a declared timeout longer than the floor is the cap", () => {
        expect(capSecs(null, 300)).toBe(300);
        expect(capSecs(null, 60)).toBe(120);
        expect(capSecs(160, 300)).toBe(480);
    });
});

describe("the basis is the median of the recent times", () => {
    test("the middle value, or the mean of the middle two", () => {
        expect(median([9, 400, 8, 10, 7])).toBe(9);
        expect(median([12, 10, 20, 11])).toBe(11.5);
        expect(median([42])).toBe(42);
    });

    test("nothing usable is no median", () => {
        expect(median([])).toBeNull();
        expect(median([0, -1, Number.NaN])).toBeNull();
        expect(median([0, 30])).toBe(30);
    });

    test("recent times win over the last one, which is the fallback", () => {
        expect(basisSecs([10, 400, 11], 10)).toBe(11);
        expect(basisSecs(undefined, 40)).toBe(40);
        expect(basisSecs([], 40)).toBe(40);
        expect(basisSecs(undefined, undefined)).toBeNull();
    });
});

describe("declaredTimeoutSecs", () => {
    test("reads the file's declared TEST_TIMEOUT_MS in seconds", () => {
        expect(declaredTimeoutSecs("const TEST_TIMEOUT_MS = 300_000;\n")).toBe(300);
        expect(declaredTimeoutSecs("const TEST_TIMEOUT_MS = 90000;")).toBe(90);
        expect(declaredTimeoutSecs("test('x', () => {});")).toBeNull();
    });

    test("capLines raises an unrecorded file's cap to what it declares", () => {
        const declared = new Map([["slow.test.ts", 300]]);
        expect(capLines("", ["slow.test.ts", "quick.test.ts"], declared)).toEqual([
            "slow.test.ts\t300\t-",
            "quick.test.ts\t120\t-",
        ]);
    });
});

describe("reading the history verb", () => {
    const history = JSON.stringify({
        files: [
            { file: "at0622.test.ts", answer: "red-streak", count: 2, lastSecs: 163 },
            { file: "at0001.test.ts", answer: "last-green", lastSecs: 7 },
            { file: "at0999.test.ts", answer: "no-history" },
        ],
    });

    // An answer from a ledger that carries no recentSecs: the cap falls back to lastSecs.
    test("takes lastSecs where the ledger has one", () => {
        const last = lastSecsFrom(history);
        expect(last.get("at0622.test.ts")).toBe(163);
        expect(last.get("at0001.test.ts")).toBe(7);
        expect(last.has("at0999.test.ts")).toBe(false);
    });

    // The verb prints the --json envelope; an older tugtool on PATH prints the bare object.
    test("reads the envelope's rows and the bare rows alike", () => {
        const rows = JSON.parse(history).files;
        const envelope = { schema_version: "1", command: "apptest history", status: "ok", data: { files: rows }, issues: [] };
        expect(historyRows(envelope)).toEqual(rows);
        expect(historyRows(JSON.parse(history))).toEqual(rows);
        expect(lastSecsFrom(JSON.stringify(envelope)).get("at0622.test.ts")).toBe(163);
    });

    test("another verb's envelope is not a history answer", () => {
        const changes = { schema_version: "1", command: "changes", status: "ok", data: { files: [{ path: "a.ts" }] }, issues: [] };
        expect(historyRows(changes)).toBeNull();
        expect(historyRows({ schema_version: "1", command: "apptest history", status: "error", data: null, issues: [] })).toBeNull();
        expect(historyRows(null)).toBeNull();
    });

    test("prints one line per named file, in order, unknowns at the floor", () => {
        expect(capLines(history, ["at0999.test.ts", "at0622.test.ts", "at0001.test.ts", "new.test.ts"])).toEqual([
            "at0999.test.ts\t120\t-",
            "at0622.test.ts\t489\t163",
            "at0001.test.ts\t120\t7",
            "new.test.ts\t120\t-",
        ]);
    });

    test("an empty or unreadable ledger answer floors every file", () => {
        expect(capLines("", ["a.test.ts"])).toEqual(["a.test.ts\t120\t-"]);
        expect(capLines("not json", ["a.test.ts"])).toEqual(["a.test.ts\t120\t-"]);
        expect(capLines('{"files":7}', ["a.test.ts"])).toEqual(["a.test.ts\t120\t-"]);
    });

    test("the command reads stdin and prints the same lines", () => {
        const proc = Bun.spawnSync(["bun", join(import.meta.dir, "wedge-cap.ts"), "at0622.test.ts", "b.test.ts"], {
            stdin: new TextEncoder().encode(history),
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(proc.exitCode).toBe(0);
        expect(proc.stdout.toString()).toBe("at0622.test.ts\t489\t163\nb.test.ts\t120\t-\n");
    });

    test("one slow run does not move the cap: it takes the median of recentSecs", () => {
        const recent = JSON.stringify({
            files: [
                // The newest run was the slow one; lastSecs alone would cap it at 1200 s.
                { file: "slow-once.test.ts", answer: "last-green", lastSecs: 400, recentSecs: [400, 100, 90, 110, 95] },
                { file: "quick.test.ts", answer: "last-green", lastSecs: 300, recentSecs: [300, 8, 7] },
                { file: "two.test.ts", answer: "red-streak", count: 1, lastSecs: 60, recentSecs: [60, 50] },
            ],
        });
        expect(recentSecsFrom(recent).get("slow-once.test.ts")).toEqual([400, 100, 90, 110, 95]);
        expect(capLines(recent, ["slow-once.test.ts", "quick.test.ts", "two.test.ts"])).toEqual([
            "slow-once.test.ts\t300\t100",
            "quick.test.ts\t120\t8",
            "two.test.ts\t165\t55",
        ]);
    });
});

describe("run-capped.sh", () => {
    const scratch = () => mkdtempSync(join(tmpdir(), "wedge-cap-"));
    // Every run of the script gets an explicit environment with a temp HOME, so
    // the shells it starts can reach nothing of the developer's.
    const shellEnv = (extra: Record<string, string> = {}) => ({
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: scratch(),
        ...extra,
    });

    test("a command under its cap passes its output and status through, unmarked", () => {
        const marker = join(scratch(), "wedged");
        const proc = Bun.spawnSync(["bash", RUN_CAPPED, "30", marker, "bash", "-c", "echo out; echo err >&2; exit 3"], {
            env: shellEnv(),
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(proc.exitCode).toBe(3);
        expect(proc.stdout.toString()).toBe("out\n");
        expect(proc.stderr.toString()).toBe("err\n");
        expect(existsSync(marker)).toBe(false);
    });

    test("a command past its cap is killed and marked", () => {
        const marker = join(scratch(), "wedged");
        const proc = Bun.spawnSync(["bash", RUN_CAPPED, "1", marker, "sleep", "30"], {
            env: shellEnv({ TUG_APPTEST_WEDGE_GRACE: "1" }),
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(proc.exitCode).toBe(124);
        expect(existsSync(marker)).toBe(true);
    });

    test("a command that ignores SIGTERM is killed after the grace", () => {
        const marker = join(scratch(), "wedged");
        const proc = Bun.spawnSync(
            ["bash", RUN_CAPPED, "1", marker, "bash", "-c", "trap '' TERM; sleep 30 & wait; sleep 30"],
            { env: shellEnv({ TUG_APPTEST_WEDGE_GRACE: "1" }), stdout: "pipe", stderr: "pipe" },
        );
        expect(proc.exitCode).toBe(124);
        expect(existsSync(marker)).toBe(true);
    });

    test("a command that exits 124 on its own is not a wedge", () => {
        const marker = join(scratch(), "wedged");
        const proc = Bun.spawnSync(["bash", RUN_CAPPED, "30", marker, "bash", "-c", "exit 124"], {
            env: shellEnv(),
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(proc.exitCode).toBe(124);
        expect(existsSync(marker)).toBe(false);
    });

    test("past its cap the whole process group dies, grandchildren included", async () => {
        const dir = scratch();
        const marker = join(dir, "wedged");
        const pidFile = join(dir, "grandchild.pid");
        // The command's child is a subshell, and the subshell's child is a sleep — two
        // generations below the script, which a kill of the command and its children misses.
        const proc = Bun.spawnSync(
            ["bash", RUN_CAPPED, "1", marker, "bash", "-c", '( sleep 30 & echo $! > "$0"; wait ); wait', pidFile],
            { env: shellEnv({ TUG_APPTEST_WEDGE_GRACE: "1" }), stdout: "pipe", stderr: "pipe" },
        );
        expect(proc.exitCode).toBe(124);
        const grandchild = Number(readFileSync(pidFile, "utf8").trim());
        expect(grandchild).toBeGreaterThan(0);
        const alive = () => {
            try {
                process.kill(grandchild, 0);
                return true;
            } catch {
                return false;
            }
        };
        // A signalled process is gone within moments; allow for its reaping, never for it to live.
        const deadline = Date.now() + 2_000;
        while (alive() && Date.now() < deadline) await Bun.sleep(50);
        const survived = alive();
        if (survived) process.kill(grandchild, "SIGKILL");
        expect(survived).toBe(false);
    });

    // The command leads a group of its own, outside the terminal's foreground group, so a
    // ^C, a TERM, or a closed terminal reaches only the script — which must pass it on.
    for (const [signal, status] of [
        ["SIGINT", 130],
        ["SIGTERM", 130],
        ["SIGHUP", 129],
    ] as const) {
        test(`a ${signal} to the script takes the command's whole group with it`, async () => {
            const dir = scratch();
            const pidFile = join(dir, "grandchild.pid");
            const proc = Bun.spawn(
                ["bash", RUN_CAPPED, "30", join(dir, "wedged"), "bash", "-c", '( sleep 30 & echo $! > "$0"; wait ); wait', pidFile],
                { env: shellEnv(), stdout: "pipe", stderr: "pipe" },
            );
            const started = Date.now();
            // The redirect creates the file before `echo` fills it, so wait
            // for the pid itself, not the file.
            const pidOf = () => (existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0);
            while (pidOf() === 0 && Date.now() - started < 5_000) await Bun.sleep(20);
            const grandchild = pidOf();
            expect(grandchild).toBeGreaterThan(0);
            proc.kill(signal);
            expect(await proc.exited).toBe(status);
            const alive = () => {
                try {
                    process.kill(grandchild, 0);
                    return true;
                } catch {
                    return false;
                }
            };
            const deadline = Date.now() + 2_000;
            while (alive() && Date.now() < deadline) await Bun.sleep(50);
            const survived = alive();
            if (survived) process.kill(grandchild, "SIGKILL");
            expect(survived).toBe(false);
        });
    }
});
