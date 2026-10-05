/**
 * The wedge cap: its arithmetic, how it reads the ledger's answer, and the script that
 * enforces it. The kill path runs against a plain `sleep`, so it is proven without an
 * app that has stopped answering.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { capLines, capSecs, lastSecsFrom, WEDGE_FLOOR_SECS } from "./wedge-cap";

const RUN_CAPPED = join(import.meta.dir, "run-capped.sh");

describe("capSecs", () => {
    test("three times the last recorded time", () => {
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
});

describe("reading the history verb", () => {
    const history = JSON.stringify({
        files: [
            { file: "at0622.test.ts", answer: "red-streak", count: 2, lastSecs: 163 },
            { file: "at0001.test.ts", answer: "last-green", lastSecs: 7 },
            { file: "at0999.test.ts", answer: "no-history" },
        ],
    });

    test("takes lastSecs where the ledger has one", () => {
        const last = lastSecsFrom(history);
        expect(last.get("at0622.test.ts")).toBe(163);
        expect(last.get("at0001.test.ts")).toBe(7);
        expect(last.has("at0999.test.ts")).toBe(false);
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
});

describe("run-capped.sh", () => {
    const scratch = () => mkdtempSync(join(tmpdir(), "wedge-cap-"));

    test("a command under its cap passes its output and status through, unmarked", () => {
        const marker = join(scratch(), "wedged");
        const started = Date.now();
        const proc = Bun.spawnSync(["bash", RUN_CAPPED, "30", marker, "bash", "-c", "echo out; echo err >&2; exit 3"], {
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(proc.exitCode).toBe(3);
        expect(proc.stdout.toString()).toBe("out\n");
        expect(proc.stderr.toString()).toBe("err\n");
        expect(existsSync(marker)).toBe(false);
        // The watchdog's thirty-second sleep is not waited out.
        expect(Date.now() - started).toBeLessThan(5_000);
    });

    test("a command past its cap is killed and marked", () => {
        const marker = join(scratch(), "wedged");
        const started = Date.now();
        const proc = Bun.spawnSync(["bash", RUN_CAPPED, "1", marker, "sleep", "30"], {
            env: { ...process.env, TUG_APPTEST_WEDGE_GRACE: "1" },
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(proc.exitCode).toBe(124);
        expect(existsSync(marker)).toBe(true);
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    test("a command that ignores SIGTERM is killed after the grace", () => {
        const marker = join(scratch(), "wedged");
        const started = Date.now();
        const proc = Bun.spawnSync(
            ["bash", RUN_CAPPED, "1", marker, "bash", "-c", "trap '' TERM; sleep 30 & wait; sleep 30"],
            { env: { ...process.env, TUG_APPTEST_WEDGE_GRACE: "1" }, stdout: "pipe", stderr: "pipe" },
        );
        expect(proc.exitCode).toBe(124);
        expect(existsSync(marker)).toBe(true);
        expect(Date.now() - started).toBeLessThan(10_000);
    });

    test("a command that exits 124 on its own is not a wedge", () => {
        const marker = join(scratch(), "wedged");
        const proc = Bun.spawnSync(["bash", RUN_CAPPED, "30", marker, "bash", "-c", "exit 124"], {
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(proc.exitCode).toBe(124);
        expect(existsSync(marker)).toBe(false);
    });
});
