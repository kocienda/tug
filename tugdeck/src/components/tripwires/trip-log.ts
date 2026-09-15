/**
 * trip-log — how a tripwire's fold reads its trip log: what folds into what,
 * what a folded run says, and how much of the log an open fold shows.
 *
 * Pure functions and constants, no React and no store, for the same reason
 * `tripwire-presentation` is: these are the log's *rules*, and a rule a
 * component decides in passing is one nothing can pin. A real log is the one
 * shape an app-test cannot reach — `tugtool tripwire trip` fires for real, and
 * opening the ledger with a foreign sqlite is forbidden — so the rules are
 * proved here, over rows, and the app-test proves the controls it can press.
 *
 * The rule itself: nine "didn't run — busy" lines say one thing nine times, and
 * so do nine "finished with nothing to report". A trip with a headline, a
 * failure, an outstanding question, or a session is never folded, because those
 * are the rows the log exists for ([B04]).
 *
 * @module components/tripwires/trip-log
 */

import type { TripRow } from "@/lib/tripwires-store";
import { tripState } from "./tripwire-presentation";

/** How many log rows a fold opens over before asking ([B04]). */
export const LOG_WINDOW = 5;

/** How many more each press of the older cue adds. */
export const LOG_PAGE = 25;

/** The two runs that fold. Everything else stands as its own row. */
export type RollupKind = "skipped" | "unreported";

export type LogEntry =
  | { readonly kind: "trip"; readonly row: TripRow }
  | { readonly kind: "rollup"; readonly roll: RollupKind; readonly rows: readonly TripRow[] };

/**
 * Which run this trip can join, or null when it joins none.
 *
 * A finished trip folds only when it left no **report** and no headline: a run
 * that found something and said so is the whole point of the log ([P04]), and
 * folding it into a count would hide the one row a reader came for.
 *
 * It folds only when it also left no **session** ([B04]). A trip that reported
 * nothing but whose session is still openable is a row the reader can reach
 * the work from, and a fold takes its dot with it. What is left to fold is the
 * probe-settled trip — one that never seated a session and found nothing —
 * which is the row this fold was written for.
 */
export function rollupKind(row: TripRow): RollupKind | null {
  const state = tripState(row);
  if (state === "skipped") return "skipped";
  if (
    state === "finished" &&
    row.headline === null &&
    row.report === null &&
    row.session_id === null
  ) {
    return "unreported";
  }
  return null;
}

/**
 * The log's rows, with consecutive runs of one kind folded into one entry.
 *
 * Consecutive, never gathered: the log is chronological and a roll-up that
 * collected every skipped trip in the file would put one row's time range
 * across the whole history. The two kinds never fold into each other.
 */
export function rollUp(trips: readonly TripRow[]): LogEntry[] {
  const out: LogEntry[] = [];
  for (const row of trips) {
    const last = out[out.length - 1];
    const roll = rollupKind(row);
    if (roll !== null) {
      if (last !== undefined && last.kind === "rollup" && last.roll === roll) {
        out[out.length - 1] = { kind: "rollup", roll, rows: [...last.rows, row] };
      } else {
        out.push({ kind: "rollup", roll, rows: [row] });
      }
    } else {
      out.push({ kind: "trip", row });
    }
  }
  // A run of one is just a trip: "Didn't run ×1" is a worse sentence than the
  // row it replaced, and it hides that row's own reason.
  return out.map((e) =>
    e.kind === "rollup" && e.rows.length === 1 ? { kind: "trip", row: e.rows[0] } : e,
  );
}

/**
 * What a folded run says: how many, and the one thing the rows still have to
 * tell apart — why, for the skipped, and how the probe went, for the ones that
 * reported nothing.
 */
export function rollupSentence(roll: RollupKind, rows: readonly TripRow[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key =
      roll === "skipped"
        ? (r.reason ?? "busy")
        : r.probe_exit === null
          ? "no probe"
          : `probe ${r.probe_exit}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const detail = [...counts.entries()].map(([k, n]) => `${k} ×${n}`).join(", ");
  return roll === "skipped"
    ? `Didn't run ×${rows.length} — ${detail}`
    : `Finished with nothing to report ×${rows.length} — ${detail}`;
}

/**
 * The older-trips cue's label, or null when the fold is already showing
 * everything.
 *
 * It names the page it will actually add and, past one page, how deep the rest
 * goes — so a reader can tell "one more press" from "this log is long". The
 * ledger keeps the most recent five hundred per tripwire, pruned as each trip
 * is written, which is what makes this cue bottom out at all ([B04]).
 */
export function olderCueLabel(entryCount: number, shown: number): string | null {
  const older = entryCount - Math.min(shown, entryCount);
  if (older <= 0) return null;
  return `Show ${Math.min(older, LOG_PAGE)} older${older > LOG_PAGE ? ` of ${older}` : ""}`;
}
