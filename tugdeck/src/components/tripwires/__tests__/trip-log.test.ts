/**
 * How the Tripwires fold reads a trip log.
 *
 * What these pin is the rule a long log lives or dies by: a tripwire that fires
 * on every landing writes mostly the same row over and over, and a fold that
 * printed each of them would bury the handful a reader came for. So consecutive
 * runs of the two boring kinds fold into one line that still says how many and
 * why, everything else stands, and the fold opens over five entries with the
 * rest a page away.
 *
 * These are rows rather than a rendered card on purpose. A real log is the one
 * shape an app-test cannot reach — `tugtool tripwire trip` fires for real, and
 * opening the ledger with a foreign sqlite is forbidden — so at0492 proves the
 * controls it can press and the rules are proved here.
 */

import { describe, expect, test } from "bun:test";

import {
  LOG_PAGE,
  LOG_WINDOW,
  olderCueLabel,
  rollUp,
  rollupKind,
  rollupSentence,
} from "../trip-log";
import type { TripRow } from "@/lib/tripwires-store";

let nextId = 1;

function trip(over: Partial<TripRow> & { status: string }): TripRow {
  return {
    id: nextId++,
    tripwire_id: 1,
    event_key: `fact:inst:${nextId}`,
    at_ms: 1_700_000_000_000 - nextId * 60_000,
    instance: "inst",
    reason: null,
    event_payload: null,
    probe_exit: null,
    probe_tail: null,
    session_id: null,
    arc: null,
    headline: null,
    refs: null,
    settled_at_ms: null,
    author_ask: null,
    repo_root: "/Users/me/src/tug",
    head_sha: "abc1234",
    ...over,
  };
}

const skipped = (reason: string): TripRow =>
  trip({ status: "skipped", reason });
const quiet = (exit: number | null = 0): TripRow =>
  trip({ status: "quiet", probe_exit: exit });

describe("which trips fold", () => {
  test("a trip that never ran folds, and so does one that finished silently", () => {
    expect(rollupKind(skipped("busy"))).toBe("skipped");
    expect(rollupKind(quiet())).toBe("quiet");
  });

  test("a finish that found something never folds — it is the row the log is for", () => {
    const found = trip({ status: "quiet", probe_exit: 1, headline: "One unused import." });
    expect(rollupKind(found)).toBeNull();
  });

  test("a quiet trip whose session is still openable never folds", () => {
    // [B04]: the fold would take the dot the reader opens the work through,
    // so what folds is the probe-settled trip that never seated a session.
    expect(rollupKind(trip({ status: "quiet", session_id: "sess-3" }))).toBeNull();
  });

  test("a failure, a question and a run in flight each stand as their own row", () => {
    expect(rollupKind(trip({ status: "failed" }))).toBeNull();
    expect(rollupKind(trip({ status: "awaiting", headline: "Look at this." }))).toBeNull();
    expect(rollupKind(trip({ status: "running", session_id: "s1" }))).toBeNull();
    expect(rollupKind(trip({ status: "adopted", session_id: "s1" }))).toBeNull();
    expect(rollupKind(trip({ status: "quarantined" }))).toBeNull();
  });
});

describe("the roll-up", () => {
  test("a run of one is left as the trip it is, with its own reason intact", () => {
    const rows = [skipped("busy"), trip({ status: "failed" })];
    const entries = rollUp(rows);
    expect(entries.map((e) => e.kind)).toEqual(["trip", "trip"]);
  });

  test("consecutive trips of one kind become one entry", () => {
    const rows = [skipped("busy"), skipped("busy"), skipped("no-match")];
    const entries = rollUp(rows);
    expect(entries.length).toBe(1);
    expect(entries[0].kind).toBe("rollup");
    if (entries[0].kind !== "rollup") throw new Error("unreachable");
    expect(entries[0].roll).toBe("skipped");
    expect(entries[0].rows.length).toBe(3);
  });

  test("the two kinds never fold into each other", () => {
    // Nine "didn't run" and nine "nothing to report" are two different facts;
    // one row saying eighteen would be the log telling neither.
    const entries = rollUp([skipped("busy"), skipped("busy"), quiet(), quiet()]);
    expect(entries.length).toBe(2);
    expect(entries.map((e) => (e.kind === "rollup" ? e.roll : e.kind))).toEqual([
      "skipped",
      "quiet",
    ]);
  });

  test("a row worth reading breaks the run it lands in", () => {
    // Chronological, never gathered: a roll-up that collected every skipped
    // trip in the file would put one row's time span across the whole history.
    const found = trip({ status: "quiet", headline: "Found it." });
    const entries = rollUp([skipped("busy"), skipped("busy"), found, skipped("busy"), skipped("busy")]);
    expect(entries.map((e) => e.kind)).toEqual(["rollup", "trip", "rollup"]);
  });
});

describe("what a folded run says", () => {
  test("the skipped say how many and why, counted per reason", () => {
    const rows = [skipped("busy"), skipped("busy"), skipped("no-match")];
    expect(rollupSentence("skipped", rows)).toBe("Didn't run ×3 — busy ×2, no-match ×1");
  });

  test("a skip with no recorded reason reads as busy, not as a blank", () => {
    expect(rollupSentence("skipped", [trip({ status: "skipped" })])).toBe(
      "Didn't run ×1 — busy ×1",
    );
  });

  test("the quiet say how the probe went, which is the only thing left to tell them apart", () => {
    expect(rollupSentence("quiet", [quiet(0), quiet(0), quiet(null)])).toBe(
      "Finished with nothing to report ×3 — probe 0 ×2, no probe ×1",
    );
  });
});

describe("the older-trips cue", () => {
  test("a log the fold already shows whole offers nothing", () => {
    expect(olderCueLabel(LOG_WINDOW, LOG_WINDOW)).toBeNull();
    expect(olderCueLabel(2, LOG_WINDOW)).toBeNull();
  });

  test("a short remainder names exactly what one press adds", () => {
    expect(olderCueLabel(LOG_WINDOW + 3, LOG_WINDOW)).toBe("Show 3 older");
  });

  test("a long remainder also says how deep the rest goes", () => {
    const entries = LOG_WINDOW + LOG_PAGE + 18;
    expect(olderCueLabel(entries, LOG_WINDOW)).toBe(
      `Show ${LOG_PAGE} older of ${LOG_PAGE + 18}`,
    );
  });

  test("pressing it walks the log down to nothing left", () => {
    // The ledger keeps five hundred per tripwire, pruned at claim time, which
    // is what makes this terminate at all rather than page forever ([B04]).
    const entries = LOG_WINDOW + LOG_PAGE * 2 + 1;
    let shown = LOG_WINDOW;
    let presses = 0;
    while (olderCueLabel(entries, shown) !== null) {
      shown += LOG_PAGE;
      presses += 1;
      expect(presses).toBeLessThan(10);
    }
    expect(presses).toBe(3);
  });
});
