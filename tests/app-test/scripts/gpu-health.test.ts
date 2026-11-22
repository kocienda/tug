/**
 * The GPU health check: which log lines are hangs, what an instance's reading looks like,
 * and what the evidence adds up to.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GPU_HANG_SIGNATURE, gpuHangLines, judge, logShowArgs, stallReadings, utcStamp, verdictLine } from "./gpu-health";

const HANG = (proc: string, pid: number) =>
    `2026-11-22 06:28:42.101 E  ${proc}[${pid}:1a2b] [com.apple.WebKit:Process] ${GPU_HANG_SIGNATURE}: GPUProcess with PID ${pid + 2} became unresponsive, terminating it`;

describe("gpuHangLines", () => {
    test("every app's hang counts, Safari's as well as Tug's", () => {
        const text = ["Timestamp               Ty Process[PID:TID]", HANG("Tug", 1773), HANG("Safari", 812)].join("\n");
        expect(gpuHangLines(text)).toHaveLength(2);
    });

    test("log naming the signature in its own arguments is not a hang", () => {
        const self = `2026-11-22 07:23:27.764 Df log[49716:ce53b] [com.apple.log:] log run noninteractively, parent: 49715 (zsh), args: '/usr/bin/log' 'show' '--predicate' 'eventMessage CONTAINS "${GPU_HANG_SIGNATURE}"'`;
        expect(gpuHangLines(self)).toEqual([]);
    });
});

describe("stallReadings", () => {
    test("each instance's trigger is read, and a missing directory is none", () => {
        const dir = mkdtempSync(join(tmpdir(), "gpu-health-"));
        const reading = join(dir, "apptest-wt-f1-abc-2026-11-22T06-28-50Z");
        mkdirSync(reading);
        writeFileSync(
            join(reading, "trigger.json"),
            JSON.stringify({ kind: "page-load", instance: "apptest-wt-f1-abc", trigger: "budget-elapsed", elapsed_ms: 8004 }),
        );
        mkdirSync(join(dir, "not-a-reading"));
        expect(stallReadings(dir)).toEqual([
            { dir: reading, instance: "apptest-wt-f1-abc", trigger: "budget-elapsed", elapsedMs: 8004 },
        ]);
        expect(stallReadings(join(dir, "absent"))).toEqual([]);
    });

    test("a trigger caught mid-write still counts", () => {
        const dir = mkdtempSync(join(tmpdir(), "gpu-health-"));
        mkdirSync(join(dir, "r"));
        writeFileSync(join(dir, "r", "trigger.json"), "{\"kind\":");
        expect(stallReadings(dir)).toHaveLength(1);
    });
});

describe("judge", () => {
    const reading = { dir: "/s/r", instance: "apptest-x", trigger: "terminated-during-load", elapsedMs: 3000 };

    test("nothing is healthy", () => {
        expect(judge([], [])).toEqual({ verdict: "ok" });
    });

    test("one hang is only a suspicion", () => {
        expect(judge([HANG("Tug", 1)], []).verdict).toBe("suspect");
    });

    test("two hangs are a wedge", () => {
        const v = judge([HANG("Tug", 1), HANG("Safari", 2)], []);
        expect(v.verdict).toBe("wedged");
    });

    test("one reading from an instance is a wedge, and the reason names it", () => {
        const v = judge([], [reading]);
        expect(v.verdict).toBe("wedged");
        expect(v.verdict !== "ok" && v.why).toContain("apptest-x");
        expect(v.verdict !== "ok" && v.why).toContain("terminated-during-load, 3.0s");
    });

    test("the line the recipe reads holds one tab and no newline", () => {
        expect(verdictLine({ verdict: "ok" })).toBe("ok");
        const line = verdictLine({ verdict: "wedged", why: "a\tb\nc" });
        expect(line).toBe("wedged\ta b c");
    });
});

describe("logShowArgs", () => {
    test("the predicate leaves log's own lines out", () => {
        const args = logShowArgs({ last: "10m" });
        expect(args.slice(0, 3)).toEqual(["show", "--last", "10m"]);
        expect(args.at(-1)).toContain('process != "log"');
    });

    test("a run's window starts at its start, as one instant whatever the reader's zone", () => {
        const args = logShowArgs({ since: 1_792_908_659 });
        expect(args[1]).toBe("--start");
        expect(args[2]).toBe("2026-10-25 06:10:59+0000");
        expect(utcStamp(new Date(0))).toBe("1970-01-01 00:00:00+0000");
    });
});
