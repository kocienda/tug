/**
 * wedge-cap.ts — how long one app-test file may run before the recipe stops it.
 *
 * A file whose app stops answering does not fail: it waits, and every harness timeout is
 * per operation, so nothing fires. The 91-minute core-tier run of 2026-10-05 was three
 * 5–7 s files sitting at 17–19 minutes each, one after the other. The cap is what ends
 * that: a file past it is killed and recorded as `WEDGED`, which the results ledger never
 * reads as a red and never reads a duration from.
 *
 * The rule is three times the file's last recorded wall time, floored at two minutes. The
 * multiple leaves room for a slow machine and a loaded batch; the floor keeps a 5 s file
 * from being killed by a cold build or a busy neighbour. A file with no recorded time gets
 * the floor.
 *
 * As a command it reads `tugtool apptest history --json` on stdin and prints one line per
 * named file — `<file>\t<cap secs>\t<last secs or ->` — for the recipe to look up. Empty or
 * unreadable stdin is not an error: every file gets the floor, because a cap is a backstop
 * and a missing ledger must never stop a run.
 */

export const WEDGE_MULTIPLE = 3;
export const WEDGE_FLOOR_SECS = 120;

/** The cap for a file whose newest recorded outcome took `lastSecs`, or none. */
export function capSecs(lastSecs: number | null): number {
    if (lastSecs === null || !Number.isFinite(lastSecs) || lastSecs <= 0) return WEDGE_FLOOR_SECS;
    return Math.max(WEDGE_FLOOR_SECS, Math.ceil(lastSecs * WEDGE_MULTIPLE));
}

/** Each file's last recorded seconds, from the history verb's JSON; absent when unknown. */
export function lastSecsFrom(historyJson: string): Map<string, number> {
    const out = new Map<string, number>();
    let parsed: unknown;
    try {
        parsed = JSON.parse(historyJson);
    } catch {
        return out;
    }
    const rows = (parsed as { files?: unknown })?.files;
    if (!Array.isArray(rows)) return out;
    for (const row of rows as { file?: unknown; lastSecs?: unknown }[]) {
        if (typeof row?.file === "string" && typeof row.lastSecs === "number") {
            out.set(row.file, row.lastSecs);
        }
    }
    return out;
}

/** The lines the recipe reads, one per file, in the order given. */
export function capLines(historyJson: string, files: string[]): string[] {
    const last = lastSecsFrom(historyJson);
    return files.map((f) => {
        const secs = last.get(f) ?? null;
        return `${f}\t${capSecs(secs)}\t${secs ?? "-"}`;
    });
}

if (import.meta.main) {
    const stdin = await Bun.stdin.text();
    for (const line of capLines(stdin, process.argv.slice(2))) console.log(line);
}
