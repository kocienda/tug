/**
 * rank.ts — order candidate app-tests by how relevant they are to a change.
 *
 * `@covers` decides which tests are candidates; this decides which of them run when there
 * are more than the cap allows. The order is a fixed tuple, compared element by element:
 *
 *   1. reach — changed symbols the test reaches, descending. The one signal about the
 *      change itself rather than about the test.
 *   2. negative — false first. Set only when a recorded map knew a changed symbol and
 *      did not reach it: absence of evidence ranks above evidence of absence.
 *   3. because — changed files the test declares, descending.
 *   4. recent red — the length of the test's current red streak, descending. A test
 *      already red is the likeliest to say something about a change near it.
 *   5. seconds — the last recorded duration, ascending, unknown last. Cost breaks a tie
 *      and nothing more; it is never a reason a test is relevant.
 *   6. filename — ascending, so an unchanged input always produces an unchanged order.
 */

export interface RankInput {
    file: string;
    /** The changed source files this test's `@covers` matched. */
    because: string[];
    /** Changed symbols the test reaches (plus one per module-scope change it covers). */
    reach: number;
    /** A recorded map ruled a changed symbol out. */
    negative: boolean;
    /** What the reach bracket says: which member matched, or why there is nothing to match. */
    reachNote: string;
    /** The current red streak's length; 0 when the newest outcome is green or unknown. */
    recentRed: number;
    /** The history word the reason line prints (`last green`, `red-streak (2)`, …). */
    history: string;
    /** The newest recorded duration in seconds, or null when unknown. */
    lastSecs: number | null;
}

export interface Ranked extends RankInput {
    /** 1-based position in the ranked order. */
    rank: number;
    reason: string;
}

function compare(a: RankInput, b: RankInput): number {
    return decide(a, b).order;
}

/** The tuple's axes, in order, as an excluded line names the one it lost on. */
export type Axis = "reach" | "negative map" | "changed files" | "red streak" | "seconds" | "name";

/** Which axis orders `a` against `b`, and which way. */
function decide(a: RankInput, b: RankInput): { axis: Axis; order: number } {
    if (a.reach !== b.reach) return { axis: "reach", order: b.reach - a.reach };
    if (a.negative !== b.negative) return { axis: "negative map", order: a.negative ? 1 : -1 };
    if (a.because.length !== b.because.length) {
        return { axis: "changed files", order: b.because.length - a.because.length };
    }
    if (a.recentRed !== b.recentRed) return { axis: "red streak", order: b.recentRed - a.recentRed };
    if (a.lastSecs !== b.lastSecs) {
        if (a.lastSecs === null) return { axis: "seconds", order: 1 };
        if (b.lastSecs === null) return { axis: "seconds", order: -1 };
        return { axis: "seconds", order: a.lastSecs - b.lastSecs };
    }
    return { axis: "name", order: a.file < b.file ? -1 : a.file > b.file ? 1 : 0 };
}

/** The axis an excluded test lost on: the first one that put it behind the last test that ran. */
export function lostOn(excluded: RankInput, lastIn: RankInput): Axis {
    return decide(excluded, lastIn).axis;
}

/** The reason a line prints: `reaches 1 [textual: …] · 1 changed file · last green · 9s`. */
export function reasonFor(r: RankInput): string {
    const files = `${r.because.length} changed file${r.because.length === 1 ? "" : "s"}`;
    const secs = r.lastSecs === null ? "?s" : `${r.lastSecs}s`;
    return `reaches ${r.reach} [${r.reachNote}] · ${files} · ${r.history} · ${secs}`;
}

/** The inputs in rank order, each with its position and reason. Does not mutate `inputs`. */
export function rank(inputs: RankInput[]): Ranked[] {
    return [...inputs]
        .sort(compare)
        .map((r, i) => ({ ...r, rank: i + 1, reason: reasonFor(r) }));
}

/**
 * One report line: `   1. at0001-x.test.ts   reaches …`, the file padded to `width`. A line
 * below the cut also names the axis it lost on.
 */
export function reportLine(r: Ranked, width: number, lost?: Axis): string {
    const tail = lost === undefined ? "" : ` · lost on ${lost}`;
    return `${String(r.rank).padStart(4)}. ${r.file.padEnd(width)}  ${r.reason}${tail}`;
}
