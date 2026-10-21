/**
 * wedge-cap.ts — how long one app-test file may run before the recipe stops it.
 *
 * A file whose app stops answering does not fail: it waits, and every harness timeout is
 * per operation, so nothing fires. The 91-minute core-tier run of 2026-10-05 was three
 * 5–7 s files sitting at 17–19 minutes each, one after the other. The recipe now stops a
 * file at a flat per-file budget instead and records it `OVERTIME`, a red; what it still
 * reads from here is the basis column — the median — which the report panel's pending rows
 * carry for the time-left projection. The results ledger reads a `STALLED` row (the old
 * `WEDGED`) as neither a red nor a duration.
 *
 * The rule is three times the median of the file's recent recorded wall times — the
 * ledger's `recentSecs`, its newest five — floored at two minutes. The median is what
 * keeps one slow run from tripling the next cap; the multiple leaves room for a slow
 * machine and a loaded batch; the floor keeps a 5 s file from being killed by a cold build
 * or a busy neighbour. A ledger answer without `recentSecs` falls back to `lastSecs`. A file
 * with no recorded time gets the floor, or its own declared `TEST_TIMEOUT_MS` when that is
 * longer: a file that cannot finish inside the floor would otherwise be killed on every run
 * and, since a wedge records no time, never earn the history that would lift its cap.
 *
 * As a command it reads `tugtool apptest history --json` on stdin and prints one line per
 * named file — `<file>\t<cap secs>\t<basis secs or ->`, the basis being the median the cap
 * multiplied — for the recipe to look up. Empty or unreadable stdin is not an error: every
 * file gets the floor, because a cap is a backstop and a missing ledger must never stop a run.
 */

export const WEDGE_MULTIPLE = 3;
export const WEDGE_FLOOR_SECS = 120;

/**
 * The cap for a file whose recorded times give `basis` (see `basisSecs`), or none.
 * With no recorded time, the file's declared timeout (`declaredSecs`) raises the floor.
 */
export function capSecs(basis: number | null, declaredSecs: number | null = null): number {
    if (basis === null || !Number.isFinite(basis) || basis <= 0) {
        const declared = declaredSecs !== null && Number.isFinite(declaredSecs) ? declaredSecs : 0;
        return Math.max(WEDGE_FLOOR_SECS, Math.ceil(declared));
    }
    return Math.max(WEDGE_FLOOR_SECS, Math.ceil(basis * WEDGE_MULTIPLE));
}

/** The median of the positive, finite values; null when there are none. */
export function median(values: number[]): number | null {
    const xs = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
    if (xs.length === 0) return null;
    const mid = Math.floor(xs.length / 2);
    return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** What the cap multiplies: the median of the recent times, else the last time, else none. */
export function basisSecs(recent: number[] | undefined, last: number | undefined): number | null {
    return median(recent ?? []) ?? last ?? null;
}

/** A test file's declared `const TEST_TIMEOUT_MS = …;`, in seconds; null when it has none. */
export function declaredTimeoutSecs(source: string): number | null {
    const m = source.match(/const TEST_TIMEOUT_MS = ([\d_]+);/);
    if (!m) return null;
    const ms = Number(m[1].replaceAll("_", ""));
    return Number.isFinite(ms) && ms > 0 ? ms / 1000 : null;
}

/**
 * The history verb's per-file rows, or `null` when the document is not its answer.
 *
 * `tugtool apptest history` prints the `--json` envelope, its rows at `data.files`. An
 * older `tugtool` on PATH — the recipe falls back to the app's own when no debug build
 * exists — prints the bare `{ files }`, so that shape is read too. Another verb's envelope
 * is not a history answer even when its `data` carries a `files` array.
 */
export function historyRows(parsed: unknown): unknown[] | null {
    const doc = parsed as { command?: unknown; data?: { files?: unknown }; files?: unknown } | null;
    if (doc === null || typeof doc !== "object") return null;
    if (typeof doc.command === "string") {
        const rows = doc.data?.files;
        return doc.command === "apptest history" && Array.isArray(rows) ? rows : null;
    }
    return Array.isArray(doc.files) ? doc.files : null;
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
    const rows = historyRows(parsed);
    if (rows === null) return out;
    for (const row of rows as { file?: unknown; lastSecs?: unknown }[]) {
        if (typeof row?.file === "string" && typeof row.lastSecs === "number") {
            out.set(row.file, row.lastSecs);
        }
    }
    return out;
}

/** Each file's recent recorded seconds, newest first, from the history verb's JSON. */
export function recentSecsFrom(historyJson: string): Map<string, number[]> {
    const out = new Map<string, number[]>();
    let parsed: unknown;
    try {
        parsed = JSON.parse(historyJson);
    } catch {
        return out;
    }
    const rows = historyRows(parsed);
    if (rows === null) return out;
    for (const row of rows as { file?: unknown; recentSecs?: unknown }[]) {
        if (typeof row?.file === "string" && Array.isArray(row.recentSecs)) {
            out.set(
                row.file,
                row.recentSecs.filter((s): s is number => typeof s === "number"),
            );
        }
    }
    return out;
}

/** The lines the recipe reads, one per file, in the order given. */
export function capLines(
    historyJson: string,
    files: string[],
    declared: Map<string, number> = new Map(),
): string[] {
    const last = lastSecsFrom(historyJson);
    const recent = recentSecsFrom(historyJson);
    return files.map((f) => {
        const basis = basisSecs(recent.get(f), last.get(f));
        return `${f}\t${capSecs(basis, declared.get(f) ?? null)}\t${basis ?? "-"}`;
    });
}

if (import.meta.main) {
    const stdin = await Bun.stdin.text();
    const files = process.argv.slice(2);
    // The recipe runs this from the app-test directory, naming files relative to it.
    const declared = new Map<string, number>();
    for (const f of files) {
        const source = await Bun.file(f).text().catch(() => "");
        const secs = declaredTimeoutSecs(source);
        if (secs !== null) declared.set(f, secs);
    }
    for (const line of capLines(stdin, files, declared)) console.log(line);
}
