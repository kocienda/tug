/**
 * A statement of arcs: the spec parsed by the core's rules, and what each row
 * of a drawn one reads against the cycle and the arc log.
 */

import { describe, expect, test } from "bun:test";

import fixture from "./fixtures/arc-statements.json";
import { arcCommandText, arcRowReading, parseArcStatement, type ArcRowReading, type StatedArc } from "@/lib/arc-statement";
import type { CitedArcAnswer } from "@/lib/arc-citation-store";
import type { CycleEntryWire, CycleWire } from "@/lib/changeset-types";
import { isCycleOfProject } from "@/components/tugways/cards/use-arc-statements";

interface FixtureCase {
  name: string;
  spec: string;
  arcs?: StatedArc[];
  error?: string;
  warnings?: number;
}

describe("parseArcStatement", () => {
  const cases = fixture as FixtureCase[];

  test("the shared fixture covers every rule", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  for (const c of cases) {
    test(c.name, () => {
      const parsed = parseArcStatement(c.spec);
      if (c.error !== undefined) {
        expect("error" in parsed).toBe(true);
        if ("error" in parsed) expect(parsed.error.split(": ")[0]).toBe(c.error);
        return;
      }
      if ("error" in parsed) throw new Error(`${c.name}: ${parsed.error}`);
      expect(parsed.arcs).toEqual(c.arcs ?? []);
      expect(parsed.warnings.length).toBe(c.warnings ?? 0);
    });
  }
});

describe("arcCommandText", () => {
  test("is the line the brief skill writes", () => {
    expect(arcCommandText({ name: "cast-files", brief: "briefs/cast.md" })).toBe("/arc cast-files @briefs/cast.md");
  });
});

function entry(n: number, name: string, state: CycleEntryWire["state"]): CycleEntryWire {
  return { n, brief: "briefs/a.md", name, waits: [], added: "2026-11-27T00:00:00Z", state };
}

function cycle(entries: CycleEntryWire[]): CycleWire {
  return {
    id: "bb8f39b5",
    name: "run",
    created: "2026-11-27T00:00:00Z",
    updated: "2026-11-27T00:00:00Z",
    project_dir: "/p",
    entries,
    landed: 0,
  };
}

const PENDING: CitedArcAnswer = { status: "pending" };
const MISSING: CitedArcAnswer = { status: "missing" };

describe("arcRowReading", () => {
  const arc = { name: "one" };

  for (const [state, word, command] of [
    ["ready", "Ready", true],
    ["waiting", "Waiting", true],
    ["running", "Running", false],
    ["joined", "Landed", false],
    ["dropped", "Dropped", false],
  ] as const) {
    test(`an entry ${state} reads ${word}`, () => {
      const reading = arcRowReading(arc, [cycle([entry(1, "one", state)])], PENDING);
      expect(reading).toEqual({ state, word, command });
    });
  }

  test("with no entry, a joined fate reads Landed", () => {
    expect(arcRowReading(arc, [], { status: "found", fate: "joined", joinSha: "abc1234" })).toEqual({
      state: "joined",
      word: "Landed",
      command: false,
    });
  });

  test("with no entry, a live fate reads Running", () => {
    expect(arcRowReading(arc, [], { status: "found", fate: "live" })).toEqual({
      state: "running",
      word: "Running",
      command: false,
    });
  });

  test("with no entry, a discarded fate reads Discarded", () => {
    expect(arcRowReading(arc, [], { status: "found", fate: "discarded" })).toEqual({
      state: "dropped",
      word: "Discarded",
      command: false,
    });
  });

  test("with no entry, a missing or pending answer reads Not queued", () => {
    const none: ArcRowReading = { state: "none", word: "Not queued", command: true };
    expect(arcRowReading(arc, [], MISSING)).toEqual(none);
    expect(arcRowReading(arc, [], PENDING)).toEqual(none);
  });

  test("an entry is preferred over the arc log's answer", () => {
    const reading = arcRowReading(arc, [cycle([entry(1, "one", "ready")])], { status: "found", fate: "joined" });
    expect(reading.word).toBe("Ready");
  });

  test("an unsettled entry is preferred over a settled one of the same name", () => {
    const cycles = [cycle([entry(1, "one", "waiting"), entry(2, "one", "dropped")])];
    expect(arcRowReading(arc, cycles, PENDING).word).toBe("Waiting");
  });

  test("among settled entries of one name the highest number is read", () => {
    const cycles = [cycle([entry(1, "one", "dropped"), entry(3, "one", "joined"), entry(2, "one", "dropped")])];
    expect(arcRowReading(arc, cycles, PENDING).word).toBe("Landed");
  });

  test("an entry named for another arc is not read", () => {
    expect(arcRowReading(arc, [cycle([entry(1, "two", "ready")])], MISSING).word).toBe("Not queued");
  });
});

describe("isCycleOfProject", () => {
  test("a card's checkout and an arc's worktree inside it share its cycles", () => {
    expect(isCycleOfProject("/u/src/tug", "/u/src/tug")).toBe(true);
    expect(isCycleOfProject("/u/src/tug", "/u/src/tug/")).toBe(true);
    expect(isCycleOfProject("/u/src/tug", "/u/src/tug/.tug/worktrees/work-statement")).toBe(true);
  });

  test("another checkout does not", () => {
    expect(isCycleOfProject("/u/src/tug", "/u/src/tugboat")).toBe(false);
    expect(isCycleOfProject("/u/src/tug", "/u/src")).toBe(false);
  });
});
