/**
 * reaudit-row — the engine's re-audit row, parsed and read against the wire.
 *
 * The fixture is written to match the row tugcast's `format_reaudit_row`
 * writes, line for line, so a drift on either side fails here.
 */

import { describe, test, expect } from "bun:test";

import type { ArcRestampWire } from "../changeset-types";
import {
  arcCellReadingWord,
  INTERRUPTED_VERDICT,
  matchesReauditRow,
  parseReauditRow,
  reauditCellReading,
  reauditFooter,
  reauditView,
  reauditViewFromWire,
  type ReauditRow,
} from "../reaudit-row";

const SEATED = [
  "arc: demo",
  "run: 0f3c1e5a9b7d4e21a8c6f0b2d4e6a8c0",
  "base: main 9ac1e0f2aa1b2c3d4e5f60718293a4b5c6d7e8f9",
  "subject: Draw the lid",
  "joined: lid",
  "state: seated",
  "why: the fit did not verify: docs red",
  "started: 2027-01-15T08:00:00+00:00",
  "ended: 2027-01-15T08:00:31+00:00",
  "surface: rust\tpass\t1307\t1307\t30782\t\t",
  "surface: docs\tfail\t\t\t\tjust lint\texit 1",
  "",
].join("\n");

function row(over: Partial<ReauditRow> = {}): ReauditRow {
  const parsed = parseReauditRow(SEATED);
  if (parsed === null) throw new Error("the fixture parses");
  return { ...parsed, ...over };
}

describe("parseReauditRow", () => {
  test("reads every line of the row tugcast writes", () => {
    const parsed = parseReauditRow(SEATED);
    expect(parsed).not.toBeNull();
    expect(parsed?.arc).toBe("demo");
    expect(parsed?.runId).toBe("0f3c1e5a9b7d4e21a8c6f0b2d4e6a8c0");
    expect(parsed?.baseBranch).toBe("main");
    expect(parsed?.baseSha).toBe("9ac1e0f2aa1b2c3d4e5f60718293a4b5c6d7e8f9");
    expect(parsed?.subject).toBe("Draw the lid");
    expect(parsed?.joined).toBe("lid");
    expect(parsed?.state).toBe("seated");
    expect(parsed?.why).toBe("the fit did not verify: docs red");
    expect(parsed?.ended).toBe("2027-01-15T08:00:31+00:00");
    expect(parsed?.surfaces).toEqual([
      {
        name: "rust",
        status: "pass",
        passed: 1307,
        total: 1307,
        ms: 30782,
        startedAt: null,
        title: null,
        message: null,
      },
      {
        name: "docs",
        status: "fail",
        passed: null,
        total: null,
        ms: null,
        startedAt: null,
        title: "just lint",
        message: "exit 1",
      },
    ]);
  });

  test("a row missing a required line, or with a state it never writes, is not one", () => {
    expect(parseReauditRow(SEATED.replace("run: ", "rn: "))).toBeNull();
    expect(parseReauditRow(SEATED.replace("state: seated", "state: thinking"))).toBeNull();
    expect(parseReauditRow("hello")).toBeNull();
  });

  test("only `/arc-reaudit <arc>` is a re-audit row", () => {
    expect(matchesReauditRow("/arc-reaudit demo")).toBe(true);
    expect(matchesReauditRow("/arc-reaudit")).toBe(false);
    expect(matchesReauditRow("/arc-run demo")).toBe(false);
  });
});

describe("reauditView", () => {
  const live: ArcRestampWire = {
    run_id: "0f3c1e5a9b7d4e21a8c6f0b2d4e6a8c0",
    phase: "verifying",
    running_since: "2027-01-15T08:00:00Z",
    deadline: "2027-01-15T08:10:00Z",
    trigger: { sha: "9ac1e0f2aa", subject: "Draw the lid", arc: "lid" },
    surfaces: [
      { name: "rust", status: "pass", passed: 1307, total: 1307, ms: 30782 },
      { name: "deck", status: "running", started_at: "2027-01-15T08:00:31Z" },
    ],
  };

  test("is live while the wire's run is the row's", () => {
    const model = reauditView(row({ state: "running" }), live, "demo");
    expect(model.live).toBe(true);
    expect(model.state).toBe("running");
    expect(model.statusWord).toBe("Re-auditing");
    expect(model.headline).toBe("main moved to 9ac1e0f — lid joined");
    expect(model.phaseLine).toBe("verifying 2 surfaces");
    expect(model.surfaces.map((s) => s.name)).toEqual(["rust", "deck"]);
    expect(model.verdict).toBeNull();
    const now = Date.parse("2027-01-15T08:01:05Z");
    expect(reauditFooter(model, now)?.startsWith("elapsed 1:05 · ends by ")).toBe(true);
  });

  test("reads the wait's sentence while the wire waits", () => {
    const waiting: ArcRestampWire = {
      run_id: live.run_id,
      phase: "waiting",
      waiting: "waiting for the arc's worktree to be clean",
      waiting_since: "2027-01-15T08:00:00Z",
    };
    const model = reauditView(row({ state: "waiting" }), waiting, "demo");
    expect(model.state).toBe("waiting");
    expect(model.statusWord).toBe("Waiting");
    expect(model.phaseLine).toBe("waiting for the arc's worktree to be clean");
    expect(reauditFooter(model, Date.parse("2027-01-15T08:00:09Z"))).toBe("waiting 0:09");
  });

  test("is finishing when a running row's run is the one the wire says last ended", () => {
    const model = reauditView(
      row({ state: "running" }),
      { last_run_id: live.run_id, seated_why: "x" },
      "demo",
    );
    expect(model.state).toBe("finishing");
    expect(model.live).toBe(false);
    expect(model.phaseLine).toBe("finishing");
    expect(model.verdict).toBeNull();
  });

  test("is interrupted when a running row's run is known to nothing", () => {
    expect(reauditView(row({ state: "running" }), null, "demo").state).toBe("interrupted");
    // Another arc's live run says nothing about this row.
    const elsewhere = reauditView(row({ state: "waiting" }), live, "other");
    expect(elsewhere.state).toBe("interrupted");
    expect(elsewhere.verdict).toBe(INTERRUPTED_VERDICT);
  });

  test("a terminal row reads its own record, whatever the wire says", () => {
    const model = reauditView(row(), { last_run_id: "another" }, "demo");
    expect(model.state).toBe("seated");
    expect(model.live).toBe(false);
    expect(model.verdict).toBe("handed to the audit stage: the fit did not verify: docs red");
    expect(model.surfaces.length).toBe(2);
    const verified = reauditView(row({ state: "verified", why: null }), null, null);
    expect(verified.verdict).toBe("verified on main 9ac1e0f");
  });

  test("a plain commit's headline quotes its subject", () => {
    const model = reauditView(row({ joined: null, subject: "Fix a typo" }), null, null);
    expect(model.headline).toBe('main moved to 9ac1e0f — "Fix a typo"');
  });

  test("the wire alone gives the live model the block draws", () => {
    const fromWire = reauditViewFromWire(live, "demo", "main");
    const fromRow = reauditView(row({ state: "running" }), live, "demo");
    expect(fromWire).not.toBeNull();
    expect(fromWire?.live).toBe(true);
    expect(fromWire?.state).toBe(fromRow.state);
    expect(fromWire?.headline).toBe(fromRow.headline);
    expect(fromWire?.phaseLine).toBe(fromRow.phaseLine);
    expect(fromWire?.surfaces).toEqual(fromRow.surfaces);
    expect(reauditViewFromWire({ last_run_id: "r" }, "demo", "main")).toBeNull();
    expect(reauditViewFromWire(null, "demo", "main")).toBeNull();
  });
});

describe("reauditCellReading", () => {
  test("names a run, a wait, or nothing", () => {
    expect(reauditCellReading({ running_since: "2027-01-15T08:00:00Z", phase: "verifying" })).toEqual(
      { word: "Re-auditing", pose: "running" },
    );
    expect(reauditCellReading({ phase: "waiting", waiting: "w" })).toEqual({
      word: "Waiting",
      pose: "running",
    });
    expect(reauditCellReading({ seated_why: "x", last_run_id: "r" })).toBeNull();
    expect(reauditCellReading(null)).toBeNull();
  });
});

describe("arcCellReadingWord", () => {
  const running = { word: "Re-auditing", pose: "running" } as const;
  const base = {
    stopped: false,
    joinReady: false,
    joinWord: "Ready",
    reaudit: running,
    fraction: { current: 3, total: 9 },
    word: "Finished",
  };

  test("a stop keeps its own reading over a re-audit", () => {
    expect(arcCellReadingWord({ ...base, stopped: true, fraction: null, word: "Stopped" })).toBe(
      "Stopped",
    );
  });

  test("a standing join offer reads over a re-audit", () => {
    expect(arcCellReadingWord({ ...base, joinReady: true })).toBe("Ready");
  });

  test("a re-audit reads over the fraction and the lifecycle word", () => {
    expect(arcCellReadingWord(base)).toBe("Re-auditing");
    expect(arcCellReadingWord({ ...base, fraction: null })).toBe("Re-auditing");
    expect(arcCellReadingWord({ ...base, reaudit: null })).toBe("3/9");
    expect(arcCellReadingWord({ ...base, reaudit: null, fraction: null })).toBe("Finished");
  });
});
