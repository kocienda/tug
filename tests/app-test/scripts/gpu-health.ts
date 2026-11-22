/**
 * gpu-health.ts — whether the machine's shared WebKit GPU service can run an app-test batch.
 *
 * When macOS's GPU service wedges, every app that shows web content stalls with it, and
 * it stays wedged until a reboot. A runner that keeps launching instances onto it makes
 * things worse and records a batch of reds that say nothing about the code. So the recipe
 * asks here before the batch starts, and again as files finish, and stops launching at the
 * first sign.
 *
 * Two kinds of evidence count:
 *
 * - **A page-load stall reading from one of the run's own instances.** An app-test
 *   instance writes the reading it takes when its shell page overruns its budget, or its
 *   content process dies mid-load, into the directory the runner names in
 *   `TUG_APPTEST_STALL_DIR`, starting with a `trigger.json`. A healthy shell load takes
 *   about a third of a second, so one such reading is the halt.
 * - **The unified log's signature.** WebKit writes `GPUProcessProxy::didBecomeUnresponsive`
 *   from whichever app's GPU process hung, Safari's as readily as Tug's. One hang only
 *   raises suspicion, because WebKit recovers from one; two in the window are a wedge, the
 *   same count the app itself uses.
 *
 * `log` records its own arguments, so a `log show` whose predicate names the signature
 * matches itself; those lines are not hangs.
 *
 * As a command it prints one line — `ok`, `suspect\t<why>` or `wedged\t<why>` — and
 * always exits 0, because a check that cannot run must never stop a run:
 *
 *     bun gpu-health.ts --last 10m
 *     bun gpu-health.ts --since <epoch secs> --stall-dir <dir>
 *     bun gpu-health.ts --no-log --stall-dir <dir>
 *
 * `--no-log` reads the instances' readings alone, which costs nothing; the log costs about
 * a second for a run's window and several for ten minutes, so the recipe reads it before
 * the batch and after a file that did not pass, which is how a wedge first shows.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The unified-log text WebKit writes when a GPU process stops answering. */
export const GPU_HANG_SIGNATURE = "GPUProcessProxy::didBecomeUnresponsive";

/** How many hangs inside the window make a wedge. */
export const WEDGE_HANGS = 2;

export type GpuVerdict =
    | { verdict: "ok" }
    | { verdict: "suspect"; why: string }
    | { verdict: "wedged"; why: string };

/** One reading an instance left in the runner's stall directory. */
export interface StallReading {
    dir: string;
    instance: string | null;
    trigger: string | null;
    elapsedMs: number | null;
}

/** The hang lines in `log show --style compact` output, without `log`'s own. */
export function gpuHangLines(logText: string): string[] {
    return logText
        .split("\n")
        .filter((line) => line.includes(GPU_HANG_SIGNATURE))
        .filter((line) => !/^\S+ \S+ +\S+ +log\[/.test(line));
}

/** Every reading under `stallDir`, oldest first by name. A missing directory is none. */
export function stallReadings(stallDir: string): StallReading[] {
    if (!stallDir || !existsSync(stallDir)) return [];
    const found: StallReading[] = [];
    for (const name of readdirSync(stallDir).sort()) {
        const triggerPath = join(stallDir, name, "trigger.json");
        if (!existsSync(triggerPath)) continue;
        let parsed: Record<string, unknown> = {};
        try {
            parsed = JSON.parse(readFileSync(triggerPath, "utf8"));
        } catch {
            // A reading caught mid-write still says the instance stalled.
        }
        found.push({
            dir: join(stallDir, name),
            instance: typeof parsed.instance === "string" ? parsed.instance : null,
            trigger: typeof parsed.trigger === "string" ? parsed.trigger : null,
            elapsedMs: typeof parsed.elapsed_ms === "number" ? parsed.elapsed_ms : null,
        });
    }
    return found;
}

/** What the evidence adds up to, with the sentence a stopped run records. */
export function judge(hangs: string[], readings: StallReading[]): GpuVerdict {
    if (readings.length > 0) {
        const r = readings[0];
        const what = [r.trigger, r.elapsedMs !== null ? `${(r.elapsedMs / 1000).toFixed(1)}s` : null]
            .filter(Boolean)
            .join(", ");
        return {
            verdict: "wedged",
            why: `instance ${r.instance ?? "(unnamed)"} took a page-load stall reading${what ? ` (${what})` : ""}: ${r.dir}`,
        };
    }
    if (hangs.length >= WEDGE_HANGS) {
        return {
            verdict: "wedged",
            why: `the unified log shows ${hangs.length} WebKit GPU processes declared unresponsive (${GPU_HANG_SIGNATURE}); the Mac's graphics service is stuck, and a restart is the remedy`,
        };
    }
    if (hangs.length === 1) {
        return { verdict: "suspect", why: `one WebKit GPU process was declared unresponsive (${GPU_HANG_SIGNATURE})` };
    }
    return { verdict: "ok" };
}

/** The verdict as the one line the recipe reads. */
export function verdictLine(v: GpuVerdict): string {
    return v.verdict === "ok" ? "ok" : `${v.verdict}\t${v.why.replace(/[\t\n]/g, " ")}`;
}

/** The `log show` arguments for the window the command was asked about. */
export function logShowArgs(window: { last: string } | { since: number }): string[] {
    const range =
        "last" in window
            ? ["--last", window.last]
            : ["--start", utcStamp(new Date(window.since * 1000))];
    return [
        "show",
        ...range,
        "--style",
        "compact",
        "--predicate",
        `eventMessage CONTAINS "${GPU_HANG_SIGNATURE}" AND process != "log"`,
    ];
}

/**
 * A `log show` time with its offset spelled out. `log` reads a bare time as the machine's local
 * time, and the process asking may not share it (bun under the harness runs in UTC), so the
 * stamp carries `+0000` and means one instant wherever it is read.
 */
export function utcStamp(d: Date): string {
    return d.toISOString().slice(0, 19).replace("T", " ") + "+0000";
}

function argValue(argv: string[], flag: string): string | null {
    const at = argv.indexOf(flag);
    return at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
}

async function main(argv: string[]): Promise<void> {
    const last = argValue(argv, "--last");
    const since = Number(argValue(argv, "--since"));
    const stallDir = argValue(argv, "--stall-dir") ?? "";
    const window = last ? { last } : Number.isFinite(since) && since > 0 ? { since } : { last: "10m" };
    let logText = "";
    if (!argv.includes("--no-log")) {
        try {
            const proc = Bun.spawn(["/usr/bin/log", ...logShowArgs(window)], { stdout: "pipe", stderr: "ignore" });
            const timer = setTimeout(() => proc.kill(), 20_000);
            logText = await new Response(proc.stdout).text();
            clearTimeout(timer);
        } catch {
            // No log to read is no evidence, never a stop.
        }
    }
    console.log(verdictLine(judge(gpuHangLines(logText), stallReadings(stallDir))));
}

if (import.meta.main) {
    await main(process.argv.slice(2));
}
